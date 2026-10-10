#!/usr/bin/env bash
#
# Matterbridge installer for Linux, with the plugin named below.
#
#   curl -fsSL https://raw.githubusercontent.com/tammeryousef1006/matterbridge-ttlock/main/install.sh | sudo bash
#   wget -qO- https://raw.githubusercontent.com/tammeryousef1006/matterbridge-ttlock/main/install.sh | sudo bash
#
# Installs or updates Node.js (LTS, from the NodeSource repository so normal system updates keep it current),
# installs Matterbridge for a dedicated "matterbridge" user with its own folders, sets it up as a service that
# starts at boot, and installs the plugin. Running it again updates everything.
#
# If Matterbridge is already installed in some other way, it is left alone and only the plugin is handled.
# The eWeLink, TTLock and Tapo installers share the same Matterbridge: running another one adds its plugin.
#
# Settings (environment variables, all optional):
#   MATTERBRIDGE_USER   user that runs Matterbridge (default: matterbridge)
#   NODE_MAJOR          Node.js major version to install when Node.js is missing or too old (default: 22)

set -euo pipefail

# ----- The plugin (the only part that differs between the eWeLink, TTLock and Tapo installers) -----
PLUGIN="matterbridge-ttlock"
PLUGIN_TITLE="TTLock"
# Extra TCP ports the plugin serves, opened in the firewall
PLUGIN_PORTS=()
# What to do once Matterbridge runs; %s is this device's IP address
NEXT_STEP='Open http://%s:8283, go to Plugins → matterbridge-ttlock → settings, and enter your TTLock app client ID, client secret, username and password.'
# ------------------------------------------------------------------------------------------------------
MB_USER="${MATTERBRIDGE_USER:-matterbridge}"
NODE_MAJOR="${NODE_MAJOR:-22}"
MIN_NODE_MAJOR=20
FRONTEND_PORT=8283

# ----------------------------------------------------------------------------------------------------
# Output helpers
# ----------------------------------------------------------------------------------------------------

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

# ----------------------------------------------------------------------------------------------------
# Checks
# ----------------------------------------------------------------------------------------------------

[ "$(id -u)" -eq 0 ] || fail "please run as root, e.g. with: curl -fsSL <url> | sudo bash"
[ "$(uname -s)" = "Linux" ] || fail "this installer is for Linux."

if command -v apt-get >/dev/null 2>&1; then PM=apt
elif command -v dnf >/dev/null 2>&1; then PM=dnf
elif command -v yum >/dev/null 2>&1; then PM=yum
elif command -v zypper >/dev/null 2>&1; then PM=zypper
elif command -v pacman >/dev/null 2>&1; then PM=pacman
elif command -v apk >/dev/null 2>&1; then PM=apk
else fail "unsupported Linux: no apt, dnf, yum, zypper, pacman or apk found."; fi

DISTRO="$( (. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-Linux}") || echo Linux)"
echo "${BOLD}Matterbridge + ${PLUGIN_TITLE} installer${RESET} on ${DISTRO} (${PM})"

pkg_install() {
  case "$PM" in
    apt) DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null ;;
    dnf) dnf install -y -q "$@" >/dev/null ;;
    yum) yum install -y -q "$@" >/dev/null ;;
    zypper) zypper --non-interactive --quiet install "$@" >/dev/null ;;
    pacman) pacman -Sy --noconfirm --needed "$@" >/dev/null ;;
    apk) apk add --quiet "$@" ;;
  esac
}

# ----------------------------------------------------------------------------------------------------
# 1. Tools the installer needs
# ----------------------------------------------------------------------------------------------------

step "Checking required tools"
if [ "$PM" = apt ]; then progress "Updating package lists" apt-get update -qq || fail "apt-get update failed."; fi
NEEDED=()
command -v curl >/dev/null 2>&1 || NEEDED+=(curl)
[ -e /etc/ssl/certs/ca-certificates.crt ] || [ -d /etc/pki/tls/certs ] || NEEDED+=(ca-certificates)
if [ "$PM" = apk ]; then command -v bash >/dev/null 2>&1 || NEEDED+=(bash); fi
if [ ${#NEEDED[@]} -gt 0 ]; then pkg_install "${NEEDED[@]}"; ok "Installed ${NEEDED[*]}"; else ok "All present"; fi

# ----------------------------------------------------------------------------------------------------
# 2. Node.js
# ----------------------------------------------------------------------------------------------------

node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0; }

# NodeSource repository (stays current with normal system updates); falls back to the distribution's package
nodesource() {
  local setup
  setup="$(mktemp)"
  if curl -fsSL "https://${1}.nodesource.com/setup_${NODE_MAJOR}.x" -o "$setup" && progress "Adding the NodeSource repository" bash "$setup"; then
    rm -f "$setup"
    progress "Installing Node.js ${NODE_MAJOR}" pkg_install nodejs || fail "Node.js could not be installed."
  else
    rm -f "$setup"
    warn "Could not set up the NodeSource repository, trying the Node.js package of ${DISTRO}"
    progress "Installing Node.js" pkg_install nodejs npm || progress "Installing Node.js" pkg_install nodejs || true
  fi
}

step "Checking Node.js"
CURRENT_NODE="$(command -v node >/dev/null 2>&1 && node_major || echo 0)"
if [ "$CURRENT_NODE" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null; then
  ok "Node.js $(node -v) is installed, keeping it"
  # Keep NodeSource installs current within their major version
  if [ "$PM" = apt ] && [ -f /etc/apt/sources.list.d/nodesource.list ]; then
    pkg_install nodejs && ok "Updated to Node.js $(node -v)"
  fi
else
  if [ "$CURRENT_NODE" -gt 0 ] 2>/dev/null; then warn "Node.js $(node -v) is too old, installing Node.js ${NODE_MAJOR}"; fi
  case "$PM" in
    apt) nodesource deb ;;
    dnf | yum) nodesource rpm ;;
    zypper) pkg_install "nodejs${NODE_MAJOR}" "npm${NODE_MAJOR}" || pkg_install nodejs npm ;;
    pacman) pkg_install nodejs npm ;;
    apk) pkg_install nodejs npm ;;
  esac
  hash -r
  command -v node >/dev/null 2>&1 || fail "Node.js could not be installed. Install Node.js ${MIN_NODE_MAJOR} or newer (https://nodejs.org) and run this installer again."
  [ "$(node_major)" -ge "$MIN_NODE_MAJOR" ] || fail "Node.js $(node -v) was installed, but Matterbridge needs ${MIN_NODE_MAJOR} or newer. Install a newer Node.js (https://nodejs.org) and run this installer again."
  ok "Installed Node.js $(node -v)"
fi
command -v npm >/dev/null 2>&1 || pkg_install npm || fail "npm could not be installed."

# ----------------------------------------------------------------------------------------------------
# 3. Existing Matterbridge installed some other way: only handle the plugin
# ----------------------------------------------------------------------------------------------------

MB_HOME="$(getent passwd "$MB_USER" 2>/dev/null | cut -d: -f6 || true)"
OURS=false
if [ -n "$MB_HOME" ] && [ -f "$MB_HOME/.npm-global/bin/matterbridge" ]; then OURS=true; fi

if [ "$OURS" = false ] && { command -v matterbridge >/dev/null 2>&1 || [ -f /etc/systemd/system/matterbridge.service ]; }; then
  step "Matterbridge is already installed on this system"
  warn "It was not installed by this script, so it is left as it is."
  if npm ls -g --depth=0 matterbridge >/dev/null 2>&1; then
    npm install -g --omit=dev "${PLUGIN}@latest" >/dev/null 2>&1 && ok "Installed/updated ${PLUGIN} $(npm ls -g --depth=0 "$PLUGIN" 2>/dev/null | grep -o "${PLUGIN}@[^ ]*" || true)"
    warn "Add it in the Matterbridge frontend (Plugins) if it is not listed yet, then restart Matterbridge."
  else
    warn "Install the plugin from the Matterbridge frontend: Plugins → Install plugins → ${PLUGIN}"
  fi
  exit 0
fi

# ----------------------------------------------------------------------------------------------------
# 4. Matterbridge user and folders
# ----------------------------------------------------------------------------------------------------

step "Setting up the ${MB_USER} user"
if ! id "$MB_USER" >/dev/null 2>&1; then
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --create-home --home-dir "/var/lib/${MB_USER}" --shell /usr/sbin/nologin "$MB_USER" 2>/dev/null \
      || useradd --system --create-home --home-dir "/var/lib/${MB_USER}" --shell /sbin/nologin "$MB_USER"
  else
    adduser -S -D -h "/var/lib/${MB_USER}" -s /sbin/nologin "$MB_USER"
  fi
  ok "Created user ${MB_USER}"
else
  ok "User ${MB_USER} exists"
fi
MB_HOME="$(getent passwd "$MB_USER" | cut -d: -f6)"
NPM_PREFIX="$MB_HOME/.npm-global"
# Matterbridge's data, storage and certificate folders, plus a private npm folder so the frontend can
# install and update plugins without root
mkdir -p "$MB_HOME/Matterbridge" "$MB_HOME/.matterbridge" "$MB_HOME/.mattercert" "$NPM_PREFIX"
chown -R "$MB_USER:" "$MB_HOME"
chmod 750 "$MB_HOME"
ok "Folders ready in ${MB_HOME}"

as_mb() {
  if command -v runuser >/dev/null 2>&1; then runuser -u "$MB_USER" -- env HOME="$MB_HOME" NPM_CONFIG_PREFIX="$NPM_PREFIX" PATH="$NPM_PREFIX/bin:$PATH" "$@"
  else su -s /bin/sh "$MB_USER" -c "HOME='$MB_HOME' NPM_CONFIG_PREFIX='$NPM_PREFIX' PATH='$NPM_PREFIX/bin:$PATH' $*"; fi
}

# ----------------------------------------------------------------------------------------------------
# 5. Matterbridge and the plugin
# ----------------------------------------------------------------------------------------------------

step "Installing Matterbridge and ${PLUGIN} (this can take a few minutes)"
progress "Installing Matterbridge and the plugin" as_mb npm install -g --omit=dev --no-fund --no-audit matterbridge@latest "${PLUGIN}@latest" || fail "Matterbridge could not be installed."
MB_VERSION="$(as_mb npm ls -g --depth=0 matterbridge 2>/dev/null | grep -o 'matterbridge@[0-9][^ ]*' || true)"
PLUGIN_VERSION="$(as_mb npm ls -g --depth=0 "$PLUGIN" 2>/dev/null | grep -o "${PLUGIN}@[0-9][^ ]*" || true)"
ok "Installed ${MB_VERSION:-matterbridge} and ${PLUGIN_VERSION:-$PLUGIN}"

# Register the plugin with Matterbridge (adding it twice is harmless)
if as_mb sh -c "cd '$MB_HOME/Matterbridge' && timeout 120 matterbridge -add ${PLUGIN}" >/dev/null 2>&1; then
  ok "Added ${PLUGIN} to Matterbridge"
else
  warn "Could not add ${PLUGIN} automatically; add it in the frontend under Plugins."
fi

# ----------------------------------------------------------------------------------------------------
# 6. Service
# ----------------------------------------------------------------------------------------------------

step "Setting up the Matterbridge service"
SERVICE_STARTED=false
if [ -d /run/systemd/system ]; then
  cat >/etc/systemd/system/matterbridge.service <<EOF
[Unit]
Description=Matterbridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${MB_USER}
WorkingDirectory=${MB_HOME}/Matterbridge
Environment=HOME=${MB_HOME}
Environment=NPM_CONFIG_PREFIX=${NPM_PREFIX}
Environment=PATH=${NPM_PREFIX}/bin:/usr/local/bin:/usr/bin:/bin
Environment=NODE_OPTIONS=--max_old_space_size=1024
ExecStart=${NPM_PREFIX}/bin/matterbridge -service
Restart=always
RestartSec=10s
TimeoutStopSec=30s

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable matterbridge >/dev/null 2>&1
  systemctl restart matterbridge
  SERVICE_STARTED=true
  ok "Service matterbridge enabled and started (systemd)"
elif command -v rc-update >/dev/null 2>&1; then
  cat >/etc/init.d/matterbridge <<EOF
#!/sbin/openrc-run
description="Matterbridge"
command="${NPM_PREFIX}/bin/matterbridge"
command_args="-service"
command_user="${MB_USER}"
command_background=true
pidfile="/run/matterbridge.pid"
directory="${MB_HOME}/Matterbridge"
export HOME="${MB_HOME}" NPM_CONFIG_PREFIX="${NPM_PREFIX}" PATH="${NPM_PREFIX}/bin:/usr/local/bin:/usr/bin:/bin"
depend() { need net; }
EOF
  chmod +x /etc/init.d/matterbridge
  rc-update add matterbridge default >/dev/null 2>&1
  rc-service matterbridge restart >/dev/null 2>&1 || rc-service matterbridge start >/dev/null 2>&1 || true
  SERVICE_STARTED=true
  ok "Service matterbridge enabled and started (OpenRC)"
else
  warn "No systemd or OpenRC found, so Matterbridge will not start by itself."
  warn "Start it with: sudo -u ${MB_USER} env HOME=${MB_HOME} ${NPM_PREFIX}/bin/matterbridge -service"
fi

# ----------------------------------------------------------------------------------------------------
# 7. Firewall
# ----------------------------------------------------------------------------------------------------

if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  step "Opening firewall ports (firewalld)"
  firewall-cmd --permanent --add-port="${FRONTEND_PORT}/tcp" --add-port=5540/udp --add-port=5540/tcp --add-service=mdns >/dev/null
  for port in ${PLUGIN_PORTS[@]+"${PLUGIN_PORTS[@]}"}; do firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null; done
  firewall-cmd --reload >/dev/null
  ok "Opened ${FRONTEND_PORT}${PLUGIN_PORTS[*]:+, ${PLUGIN_PORTS[*]}}, 5540 (Matter) and mDNS"
elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  step "Opening firewall ports (ufw)"
  for rule in "${FRONTEND_PORT}/tcp" 5540/udp 5540/tcp 5353/udp; do ufw allow "$rule" >/dev/null; done
  for port in ${PLUGIN_PORTS[@]+"${PLUGIN_PORTS[@]}"}; do ufw allow "${port}/tcp" >/dev/null; done
  ok "Opened ${FRONTEND_PORT}${PLUGIN_PORTS[*]:+, ${PLUGIN_PORTS[*]}}, 5540 (Matter) and mDNS"
fi

# ----------------------------------------------------------------------------------------------------
# Done
# ----------------------------------------------------------------------------------------------------

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$IP" ] || IP="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1)"
[ -n "$IP" ] || IP="<this-device-ip>"

echo
echo "${GREEN}${BOLD}Done!${RESET}"
if [ "$SERVICE_STARTED" = true ]; then echo "Matterbridge is starting; give it a minute, then:"; fi
echo "  1. Open ${BOLD}http://${IP}:${FRONTEND_PORT}${RESET} and pair Matterbridge with your controller (Apple Home, Google Home, SmartThings, Alexa...)."
echo "  2. $(printf "$NEXT_STEP" "$IP")"
echo "Run this installer again at any time to update Node.js, Matterbridge and the plugin."
