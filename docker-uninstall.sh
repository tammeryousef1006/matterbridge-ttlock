#!/usr/bin/env bash
#
# Removes the plugin named below from the Matterbridge container that docker-install.sh set up. If other
# plugins are still registered, you choose what happens to them (default: keep them, Matterbridge keeps
# running). Removing Matterbridge completely removes the container and image, and optionally its data.
# Docker itself is never removed if it was installed before docker-install.sh ran. If the installer
# installed Docker, you are asked whether to remove it as well (default: keep).
#
#   curl -fsSL https://raw.githubusercontent.com/tammeryousef1006/matterbridge-ttlock/main/docker-uninstall.sh | sudo bash
#   wget -qO- https://raw.githubusercontent.com/tammeryousef1006/matterbridge-ttlock/main/docker-uninstall.sh | sudo bash
#
# Settings (environment variables, all optional; without them the uninstaller asks):
#   MATTERBRIDGE_DIR    data folder (default: /opt/matterbridge)
#   REMOVE_OTHERS       what to do with other plugins: "keep", "all" (remove Matterbridge completely)
#                       or plugin names separated by spaces
#   REMOVE_DATA         when removing Matterbridge: 1 = delete the data, 0 = keep it
#   REMOVE_DOCKER       1 = remove Docker if this installer installed it, 0 = keep it

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
MARKER="$DATA_DIR/.docker-installed-by-script"
REMOVE_OTHERS="${REMOVE_OTHERS:-ask}"
REMOVE_DATA="${REMOVE_DATA:-ask}"
REMOVE_DOCKER="${REMOVE_DOCKER:-ask}"

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
command -v docker >/dev/null 2>&1 || fail "Docker is not installed, so there is no Matterbridge container to remove."


# Questions read from the keyboard, which is not stdin when the script is piped from curl.
# Prints the answer; without a keyboard the answer is empty (= the default).
ask() {
  local answer=""
  if [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
    printf "%s" "$1" >/dev/tty
    read -r answer </dev/tty || answer=""
  fi
  echo "$answer"
}

VOLUMES=(-v "$DATA_DIR/Matterbridge:/root/Matterbridge" -v "$DATA_DIR/.matterbridge:/root/.matterbridge" -v "$DATA_DIR/.mattercert:/root/.mattercert")
HAVE_CONTAINER=false
if docker container inspect "$NAME" >/dev/null 2>&1; then
  if [ "$(docker container inspect -f '{{index .Config.Labels "io.github.tammeryousef1006.matterbridge"}}' "$NAME")" != "installer" ]; then
    fail "the container ${NAME} was not created by the installer, so it is left alone. Remove ${PLUGIN} in its Matterbridge frontend (Plugins)."
  fi
  HAVE_CONTAINER=true
  IMAGE="$(docker container inspect -f '{{.Config.Image}}' "$NAME")"
fi

# Runs Matterbridge commands in a one-off container on the same data. The image reinstalls the plugins
# registered in the data on every start, so removing a plugin means taking it off that list.
mb() {
  docker run --rm "${VOLUMES[@]}" --entrypoint sh "$IMAGE" -c "cd /root/Matterbridge && $1"
}

# Plugins still registered, one per line
registered_plugins() {
  mb "timeout 120 matterbridge -list" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | grep -oE 'plugin [^ :]+:' | sed 's/^plugin //; s/:$//' | grep -v '^matterbridge$' | sort -u || true
}

remove_plugins() {
  local cmd="" name
  for name in "$@"; do cmd="${cmd}timeout 120 matterbridge -remove ${name} >/dev/null 2>&1; "; done
  progress "Removing $*" mb "${cmd}true" && ok "Removed $*" || warn "Could not remove $*"
}

echo "${BOLD}Matterbridge + ${PLUGIN_TITLE} Docker uninstaller${RESET}"

if [ "$HAVE_CONTAINER" = true ]; then
  # --------------------------------------------------------------------------------------------------
  # 1. This uninstaller's plugin
  # --------------------------------------------------------------------------------------------------

  step "Removing ${PLUGIN}"
  progress "Stopping Matterbridge" docker stop -t 60 "$NAME" || true
  remove_plugins "$PLUGIN"

  # --------------------------------------------------------------------------------------------------
  # 2. The rest: keep it (default), remove some plugins, or remove Matterbridge completely
  # --------------------------------------------------------------------------------------------------

  if [ "$REMOVE_OTHERS" = ask ]; then
    OTHERS="$(registered_plugins | tr '\n' ' ' | sed 's/ $//')"
    echo
    if [ -n "$OTHERS" ]; then
      echo "Matterbridge still has these plugins: ${BOLD}${OTHERS}${RESET}"
      REMOVE_OTHERS="$(ask "Press Enter to keep them (Matterbridge keeps running), type plugin names to remove only those, or type all to remove Matterbridge completely: ")"
    else
      REMOVE_OTHERS="$(ask "No other plugins are installed. Type all to remove Matterbridge too, or press Enter to keep it: ")"
      [ "$REMOVE_OTHERS" = yes ] && REMOVE_OTHERS=all
    fi
    [ -n "$REMOVE_OTHERS" ] || REMOVE_OTHERS=keep
  fi

  if [ "$REMOVE_OTHERS" != all ]; then
    if [ "$REMOVE_OTHERS" != keep ]; then
      step "Removing the plugins you chose"
      # shellcheck disable=SC2086
      remove_plugins $REMOVE_OTHERS
    fi
    step "Keeping Matterbridge"
    docker start "$NAME" >/dev/null && ok "Matterbridge restarted"
    echo
    echo "${GREEN}${BOLD}Done.${RESET} ${PLUGIN} is removed; Matterbridge keeps running."
    echo "Devices of removed plugins disappear from your controller app (Apple Home, Google Home, SmartThings...)."
    exit 0
  fi

  # --------------------------------------------------------------------------------------------------
  # 3. Remove Matterbridge completely
  # --------------------------------------------------------------------------------------------------

  step "Removing Matterbridge"
  docker rm "$NAME" >/dev/null
  ok "Removed container ${NAME}"
  # Remove the image unless another container still uses it
  if [ -z "$(docker ps -a -q --filter "ancestor=$IMAGE")" ]; then
    progress "Removing the image" docker rmi "$IMAGE" && ok "Removed image ${IMAGE}" || true
  fi

  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --remove-port=8283/tcp --remove-port=8284/tcp --remove-port=5540/udp --remove-port=5540/tcp --remove-service=mdns >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
    ok "Closed firewall ports"
  elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    for rule in 8283/tcp 8284/tcp 5540/udp 5540/tcp 5353/udp; do ufw delete allow "$rule" >/dev/null 2>&1 || true; done
    ok "Closed firewall ports"
  fi
else
  echo "No Matterbridge container from the installer is running here."
fi

# ----------------------------------------------------------------------------------------------------
# 4. Data (also offered when the container was removed earlier and the data was kept)
# ----------------------------------------------------------------------------------------------------

DOCKER_OURS=false
[ -f "$MARKER" ] && DOCKER_OURS=true

if [ -d "$DATA_DIR" ]; then
  if [ "$REMOVE_DATA" = ask ]; then
    echo
    [ "$(ask "Also delete all Matterbridge data in ${DATA_DIR} (controller pairing, settings, plugin logins)? Type yes to delete, or press Enter to keep: ")" = yes ] && REMOVE_DATA=1 || REMOVE_DATA=0
  fi
  if [ "$REMOVE_DATA" = 1 ]; then
    rm -rf "$DATA_DIR"
    ok "Deleted ${DATA_DIR}"
  else
    step "Keeping data"
    ok "Pairing, settings and plugin logins stay in ${DATA_DIR}; running an installer again picks them up."
    # Keep the marker so a later run still knows who installed Docker
  fi
fi

# ----------------------------------------------------------------------------------------------------
# 5. Docker (only ever removed if the installer installed it)
# ----------------------------------------------------------------------------------------------------

step "Docker"
if [ "$DOCKER_OURS" = true ]; then
  if [ "$REMOVE_DOCKER" = ask ]; then
    [ "$(ask "Docker was installed by the installer. Remove Docker too? Other containers would stop working. Type yes to remove, or press Enter to keep: ")" = yes ] && REMOVE_DOCKER=1 || REMOVE_DOCKER=0
  fi
  if [ "$REMOVE_DOCKER" = 1 ]; then
    if command -v apt-get >/dev/null 2>&1; then progress "Removing Docker" env DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin docker-ce-rootless-extras || true
    elif command -v dnf >/dev/null 2>&1; then progress "Removing Docker" dnf remove -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin docker-ce-rootless-extras || true
    elif command -v apk >/dev/null 2>&1; then rc-service docker stop >/dev/null 2>&1 || true; progress "Removing Docker" apk del docker || true
    elif command -v pacman >/dev/null 2>&1; then systemctl disable --now docker >/dev/null 2>&1 || true; progress "Removing Docker" pacman -Rns --noconfirm docker || true
    fi
    rm -f "$MARKER"
    ok "Removed Docker"
  else
    ok "Kept Docker"
  fi
else
  ok "Docker was already installed before Matterbridge, so it is kept"
fi

echo
echo "${GREEN}${BOLD}Done.${RESET} Matterbridge is removed."
echo "Remove the bridge from your controller app (Apple Home, Google Home, SmartThings...) as well."
