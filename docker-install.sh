#!/usr/bin/env bash
#
# Matterbridge with Docker (official luligu/matterbridge image), with the plugin named below.
# The eWeLink, TTLock and Tapo installers share the same container: running another one adds its plugin.
#
#   curl -fsSL https://raw.githubusercontent.com/tammeryousef1006/matterbridge-ttlock/main/docker-install.sh | sudo bash
#   wget -qO- https://raw.githubusercontent.com/tammeryousef1006/matterbridge-ttlock/main/docker-install.sh | sudo bash
#
# If Docker is not installed it is installed first (Docker's official install script). The data (Matter
# pairing, settings, plugin logins) lives in /opt/matterbridge, so updates and reinstalls keep it.
# Running the script again updates Matterbridge and the plugin.
#
# Settings (environment variables, all optional):
#   MATTERBRIDGE_DIR    data folder (default: /opt/matterbridge)
#   MATTERBRIDGE_IMAGE  image (default: luligu/matterbridge:latest)

set -euo pipefail

# ----- The plugin (the only part that differs between the eWeLink, TTLock and Tapo installers) -----
PLUGIN="matterbridge-ttlock"
PLUGIN_TITLE="TTLock"
# Extra TCP ports the plugin serves, opened in the firewall
PLUGIN_PORTS=()
# What to do once Matterbridge runs; %s is this device's IP address
NEXT_STEP='Open http://%s:8283, go to Plugins → matterbridge-ttlock → settings, and enter your TTLock app client ID, client secret, username and password.'
# ------------------------------------------------------------------------------------------------------
NAME="matterbridge"
DATA_DIR="${MATTERBRIDGE_DIR:-/opt/matterbridge}"
IMAGE="${MATTERBRIDGE_IMAGE:-luligu/matterbridge:latest}"
LABEL="io.github.tammeryousef1006.matterbridge=installer"
MARKER="$DATA_DIR/.docker-installed-by-script"

if [ -t 1 ]; then BOLD=$'\e[1m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; RESET=$'\e[0m'; else BOLD=""; GREEN=""; YELLOW=""; RED=""; RESET=""; fi
step() { echo "${BOLD}==> $*${RESET}"; }
ok() { echo "${GREEN}    $*${RESET}"; }
warn() { echo "${YELLOW}    $*${RESET}"; }
fail() { echo "${RED}Error: $*${RESET}" >&2; exit 1; }

# Run a slow command with a spinner and elapsed time, so it's clear the installer is working.
# The command's output goes to a log that is shown if it fails.
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT
progress() {
  local message="$1" pid start frames='|/-\' i=0 status=0
  shift
  : >"$LOG"
  "$@" >>"$LOG" 2>&1 &
  pid=$!
  start=$SECONDS
  if [ -t 1 ]; then
    while kill -0 "$pid" 2>/dev/null; do
      printf '\r    %s %s (%ds) ' "${frames:i++%4:1}" "$message" "$((SECONDS - start))"
      sleep 0.25
    done
    printf '\r\033[K'
  else
    echo "    ${message}..."
    while kill -0 "$pid" 2>/dev/null; do sleep 1; done
  fi
  wait "$pid" || status=$?
  if [ "$status" -ne 0 ]; then
    echo "${RED}    ${message} failed. Last output:${RESET}" >&2
    tail -n 15 "$LOG" | sed 's/^/      /' >&2
  fi
  return "$status"
}

[ "$(id -u)" -eq 0 ] || fail "please run as root, e.g. with: curl -fsSL <url> | sudo bash"
[ "$(uname -s)" = "Linux" ] || fail "this installer is for Linux (Matter needs Docker's host network, which only works on Linux)."
echo "${BOLD}Matterbridge + ${PLUGIN_TITLE} Docker installer${RESET}"

# ----------------------------------------------------------------------------------------------------
# 1. Docker
# ----------------------------------------------------------------------------------------------------

step "Checking Docker"
INSTALLED_DOCKER=false
if command -v docker >/dev/null 2>&1; then
  ok "Docker is already installed ($(docker --version 2>/dev/null | sed 's/,.*//')); it will be used as it is"
else
  warn "Docker is not installed. Installing it now with Docker's official installer..."
  if command -v apk >/dev/null 2>&1; then
    progress "Installing Docker" apk add docker || fail "Docker could not be installed."
    rc-update add docker default >/dev/null 2>&1 || true
  elif command -v pacman >/dev/null 2>&1; then
    progress "Installing Docker" pacman -Sy --noconfirm --needed docker || fail "Docker could not be installed."
  else
    command -v curl >/dev/null 2>&1 || { command -v apt-get >/dev/null 2>&1 && apt-get update -qq >/dev/null && apt-get install -y -qq curl >/dev/null; } || { command -v dnf >/dev/null 2>&1 && dnf install -y -q curl >/dev/null; } || fail "curl is needed to install Docker."
    progress "Installing Docker (this takes a few minutes)" sh -c "curl -fsSL https://get.docker.com | sh" || fail "Docker could not be installed. Install it from https://docs.docker.com/engine/install/ and run this script again."
  fi
  INSTALLED_DOCKER=true
  ok "Installed $(docker --version | sed 's/,.*//')"
fi
if ! docker info >/dev/null 2>&1; then
  if [ -d /run/systemd/system ]; then systemctl enable --now docker >/dev/null 2>&1 || true
  elif command -v rc-service >/dev/null 2>&1; then rc-service docker start >/dev/null 2>&1 || true; fi
  for _ in $(seq 1 15); do docker info >/dev/null 2>&1 && break; sleep 2; done
  docker info >/dev/null 2>&1 || fail "Docker is installed but not running. In a Proxmox LXC, enable 'nesting' (and 'keyctl' for unprivileged containers) in the container's Options → Features, restart it and run this script again."
fi
mkdir -p "$DATA_DIR"
if [ "$INSTALLED_DOCKER" = true ]; then touch "$MARKER"; fi

# ----------------------------------------------------------------------------------------------------
# 2. Existing container
# ----------------------------------------------------------------------------------------------------

if docker container inspect "$NAME" >/dev/null 2>&1; then
  if [ "$(docker container inspect -f '{{index .Config.Labels "io.github.tammeryousef1006.matterbridge"}}' "$NAME")" != "installer" ]; then
    step "A container named ${NAME} already exists"
    warn "It was not created by this installer, so it is left as it is."
    warn "Install the plugin from its Matterbridge frontend: Plugins → Install plugins → ${PLUGIN}"
    exit 0
  fi
  UPDATE=true
else
  UPDATE=false
fi

# ----------------------------------------------------------------------------------------------------
# 3. Image, folders and plugin
# ----------------------------------------------------------------------------------------------------

step "Downloading the Matterbridge image (${IMAGE})"
progress "Downloading the image" docker pull "$IMAGE" || fail "could not download ${IMAGE}."
ok "Downloaded"

mkdir -p "$DATA_DIR/Matterbridge" "$DATA_DIR/.matterbridge" "$DATA_DIR/.mattercert"
VOLUMES=(-v "$DATA_DIR/Matterbridge:/root/Matterbridge" -v "$DATA_DIR/.matterbridge:/root/.matterbridge" -v "$DATA_DIR/.mattercert:/root/.mattercert")

if [ "$UPDATE" = true ]; then
  step "Stopping the current container (data is kept)"
  docker stop -t 60 "$NAME" >/dev/null
  docker rm "$NAME" >/dev/null
  ok "Stopped"
fi

# Register the plugin before Matterbridge starts; the image reinstalls registered plugins on every start
step "Adding ${PLUGIN}"
if progress "Installing the plugin" docker run --rm "${VOLUMES[@]}" --entrypoint sh "$IMAGE" -c "npm install -g --omit=dev --no-fund --no-audit ${PLUGIN}@latest && matterbridge -add ${PLUGIN}"; then
  ok "Added ${PLUGIN}"
else
  warn "Could not add ${PLUGIN} automatically; add it in the frontend under Plugins."
fi

# ----------------------------------------------------------------------------------------------------
# 4. Start
# ----------------------------------------------------------------------------------------------------

step "Starting Matterbridge"
docker run -d --name "$NAME" --label "$LABEL" --network host --restart always --stop-timeout 60 "${VOLUMES[@]}" "$IMAGE" >/dev/null
ok "Container ${NAME} started (restarts automatically, also after a reboot)"

if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port=8283/tcp --add-port=5540/udp --add-port=5540/tcp --add-service=mdns >/dev/null
  for port in ${PLUGIN_PORTS[@]+"${PLUGIN_PORTS[@]}"}; do firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null; done
  firewall-cmd --reload >/dev/null
  ok "Opened firewall ports 8283${PLUGIN_PORTS[*]:+, ${PLUGIN_PORTS[*]}}, 5540 and mDNS"
elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  for rule in 8283/tcp 5540/udp 5540/tcp 5353/udp; do ufw allow "$rule" >/dev/null; done
  for port in ${PLUGIN_PORTS[@]+"${PLUGIN_PORTS[@]}"}; do ufw allow "${port}/tcp" >/dev/null; done
  ok "Opened firewall ports 8283${PLUGIN_PORTS[*]:+, ${PLUGIN_PORTS[*]}}, 5540 and mDNS"
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$IP" ] || IP="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1)"
[ -n "$IP" ] || IP="<this-device-ip>"

echo
echo "${GREEN}${BOLD}Done!${RESET} Matterbridge is starting; the first start installs the plugin and takes a minute or two. Then:"
echo "  1. Open ${BOLD}http://${IP}:8283${RESET} and pair Matterbridge with your controller (Apple Home, Google Home, SmartThings, Alexa...)."
echo "  2. $(printf "$NEXT_STEP" "$IP")"
echo "Data is kept in ${DATA_DIR}. Run this installer again at any time to update. See the log with: docker logs -f ${NAME}"
