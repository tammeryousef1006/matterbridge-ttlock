#!/usr/bin/env bash
#
# Removes the plugin named below from the Matterbridge that install.sh set up. If other plugins are still
# installed, you choose what happens to them (default: keep them, Matterbridge keeps running). Removing
# Matterbridge completely also removes its service and firewall rules, and optionally the "matterbridge"
# user with all data (Matter pairing, settings, plugin logins). Node.js is kept unless REMOVE_NODE=1.
#
#   curl -fsSL https://raw.githubusercontent.com/tammeryousef1006/matterbridge-ttlock/main/uninstall.sh | sudo bash
#   wget -qO- https://raw.githubusercontent.com/tammeryousef1006/matterbridge-ttlock/main/uninstall.sh | sudo bash
#
# Settings (environment variables, all optional; without them the uninstaller asks):
#   MATTERBRIDGE_USER   user created by the installer (default: matterbridge)
#   REMOVE_OTHERS       what to do with other plugins: "keep", "all" (remove Matterbridge completely)
#                       or plugin names separated by spaces
#   REMOVE_DATA         when removing Matterbridge: 1 = delete the user and all data, 0 = keep them
#   REMOVE_NODE         1 = also remove Node.js and the NodeSource repository (default: 0)

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
REMOVE_OTHERS="${REMOVE_OTHERS:-ask}"
REMOVE_DATA="${REMOVE_DATA:-ask}"
REMOVE_NODE="${REMOVE_NODE:-0}"

if [ -t 1 ]; then BOLD=$'\e[1m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; RESET=$'\e[0m'; else BOLD=""; GREEN=""; YELLOW=""; RED=""; RESET=""; fi
step() { echo "${BOLD}==> $*${RESET}"; }
ok() { echo "${GREEN}    $*${RESET}"; }
warn() { echo "${YELLOW}    $*${RESET}"; }
fail() { echo "${RED}Error: $*${RESET}" >&2; exit 1; }

# Run a slow command with a spinner and elapsed time, so it's clear the script is working.
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

[ "$(id -u)" -eq 0 ] || fail "please run as root, e.g. with: curl -fsSL <url> | sudo bash"

MB_HOME="$(getent passwd "$MB_USER" 2>/dev/null | cut -d: -f6 || true)"
NPM_PREFIX="$MB_HOME/.npm-global"
if [ -z "$MB_HOME" ] || { [ ! -d "$NPM_PREFIX" ] && [ ! -d "$MB_HOME/.matterbridge" ]; }; then
  echo "No Matterbridge installation from the installer was found (user ${MB_USER})."
  echo "If Matterbridge was installed another way, remove ${PLUGIN} in the Matterbridge frontend (Plugins)."
  exit 0
fi

as_mb() {
  if command -v runuser >/dev/null 2>&1; then runuser -u "$MB_USER" -- env HOME="$MB_HOME" NPM_CONFIG_PREFIX="$NPM_PREFIX" PATH="$NPM_PREFIX/bin:$PATH" "$@"
  else su -s /bin/sh "$MB_USER" -c "HOME='$MB_HOME' NPM_CONFIG_PREFIX='$NPM_PREFIX' PATH='$NPM_PREFIX/bin:$PATH' $*"; fi
}

installed_plugins() {
  find "$NPM_PREFIX/lib/node_modules" -mindepth 1 -maxdepth 1 -name 'matterbridge-*' -printf '%f\n' 2>/dev/null | sort
}

stop_service() {
  if [ -f /etc/systemd/system/matterbridge.service ]; then progress "Stopping Matterbridge" systemctl stop matterbridge || true
  elif [ -f /etc/init.d/matterbridge ]; then progress "Stopping Matterbridge" rc-service matterbridge stop || true; fi
  pkill -u "$MB_USER" -f matterbridge 2>/dev/null || true
}

start_service() {
  if [ -f /etc/systemd/system/matterbridge.service ]; then systemctl start matterbridge && ok "Matterbridge restarted"
  elif [ -f /etc/init.d/matterbridge ]; then rc-service matterbridge start >/dev/null 2>&1 && ok "Matterbridge restarted"
  else warn "Start Matterbridge again yourself (no service was found)."; fi
}

remove_plugin() {
  as_mb sh -c "cd '$MB_HOME/Matterbridge' && timeout 120 matterbridge -remove $1" >/dev/null 2>&1 || true
  if progress "Removing $1" as_mb npm uninstall -g "$1"; then ok "Removed $1"; else warn "Could not remove $1"; fi
}

echo "${BOLD}Matterbridge + ${PLUGIN_TITLE} uninstaller${RESET}"

if [ -x "$NPM_PREFIX/bin/matterbridge" ]; then
  # --------------------------------------------------------------------------------------------------
  # 1. This uninstaller's plugin
  # --------------------------------------------------------------------------------------------------

  step "Removing ${PLUGIN}"
  stop_service
  if installed_plugins | grep -qx "$PLUGIN"; then remove_plugin "$PLUGIN"; else ok "${PLUGIN} is not installed"; fi

  # --------------------------------------------------------------------------------------------------
  # 2. The rest: keep it (default), remove some plugins, or remove Matterbridge completely
  # --------------------------------------------------------------------------------------------------

  OTHERS="$(installed_plugins | tr '\n' ' ' | sed 's/ $//')"
  if [ "$REMOVE_OTHERS" = ask ]; then
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
      for name in $REMOVE_OTHERS; do
        if installed_plugins | grep -qx "$name"; then remove_plugin "$name"; else warn "${name} is not installed, skipped"; fi
      done
    fi
    step "Keeping Matterbridge"
    start_service
    LEFT="$(installed_plugins | tr '\n' ' ' | sed 's/ $//')"
    echo
    echo "${GREEN}${BOLD}Done.${RESET} ${PLUGIN} is removed; Matterbridge keeps running${LEFT:+ with ${LEFT}}."
    echo "Devices of removed plugins disappear from your controller app (Apple Home, Google Home, SmartThings...)."
    exit 0
  fi

  # --------------------------------------------------------------------------------------------------
  # 3. Remove Matterbridge completely
  # --------------------------------------------------------------------------------------------------

  step "Removing Matterbridge"
  if [ -f /etc/systemd/system/matterbridge.service ]; then
    systemctl disable matterbridge >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/matterbridge.service
    systemctl daemon-reload 2>/dev/null || true
    ok "Removed the systemd service"
  elif [ -f /etc/init.d/matterbridge ]; then
    rc-update del matterbridge default >/dev/null 2>&1 || true
    rm -f /etc/init.d/matterbridge
    ok "Removed the OpenRC service"
  fi
  progress "Removing files" rm -rf "$NPM_PREFIX" "$MB_HOME/.npm"
  ok "Removed Matterbridge and all its plugins"

  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --remove-port=8283/tcp --remove-port=8284/tcp --remove-port=5540/udp --remove-port=5540/tcp --remove-service=mdns >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
    ok "Closed firewall ports"
  elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    for rule in 8283/tcp 8284/tcp 5540/udp 5540/tcp 5353/udp; do ufw delete allow "$rule" >/dev/null 2>&1 || true; done
    ok "Closed firewall ports"
  fi
fi

# ----------------------------------------------------------------------------------------------------
# 4. Data (also offered when Matterbridge was removed earlier and the data was kept)
# ----------------------------------------------------------------------------------------------------

if [ "$REMOVE_DATA" = ask ]; then
  echo
  [ "$(ask "Also delete all Matterbridge data (controller pairing, settings, plugin logins) and the ${MB_USER} user? Type yes to delete, or press Enter to keep: ")" = yes ] && REMOVE_DATA=1 || REMOVE_DATA=0
fi
if [ "$REMOVE_DATA" = 1 ]; then
  step "Deleting the ${MB_USER} user and all its data"
  if command -v userdel >/dev/null 2>&1; then userdel "$MB_USER" >/dev/null 2>&1 || true; else deluser "$MB_USER" >/dev/null 2>&1 || true; fi
  rm -rf "$MB_HOME"
  ok "Deleted ${MB_HOME}"
else
  step "Keeping data"
  ok "Pairing, settings and plugin logins stay in ${MB_HOME}; running an installer again picks them up."
fi

if [ "$REMOVE_NODE" = 1 ]; then
  step "Removing Node.js"
  if command -v apt-get >/dev/null 2>&1; then
    progress "Removing Node.js" env DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq nodejs || true
    rm -f /etc/apt/sources.list.d/nodesource.list /etc/apt/sources.list.d/nodesource.sources /etc/apt/keyrings/nodesource.gpg /usr/share/keyrings/nodesource.gpg
  elif command -v dnf >/dev/null 2>&1; then
    progress "Removing Node.js" dnf remove -y -q nodejs || true
    rm -f /etc/yum.repos.d/nodesource*.repo
  elif command -v yum >/dev/null 2>&1; then
    progress "Removing Node.js" yum remove -y -q nodejs || true
    rm -f /etc/yum.repos.d/nodesource*.repo
  elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive --quiet remove 'nodejs*' 'npm*' >/dev/null 2>&1 || true
  elif command -v pacman >/dev/null 2>&1; then pacman -Rns --noconfirm nodejs npm >/dev/null 2>&1 || true
  elif command -v apk >/dev/null 2>&1; then apk del --quiet nodejs npm >/dev/null 2>&1 || true
  fi
  ok "Removed Node.js"
fi

echo
echo "${GREEN}${BOLD}Done.${RESET} Matterbridge is removed."
echo "Remove the bridge from your controller app (Apple Home, Google Home, SmartThings...) as well."
