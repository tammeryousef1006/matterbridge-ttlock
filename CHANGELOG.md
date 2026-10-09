# Changelog

## 1.4.0-beta.2 (2026-10-09)
- Faster Bluetooth lock/unlock: the command is reported done as soon as the lock confirms (the Bluetooth disconnect finishes afterwards), and the ESP32's GATT service cache is used when the proxy supports it (with automatic rediscovery if the cache is stale)
- Battery: values are only written when they change, and the lock's Bluetooth reading is preferred over the cloud's when the ESP32 can see the lock (no more 88% / 80% flip-flopping or repeated log lines)
- Debug log shows how long each phase of a Bluetooth command took

## 1.4.0-beta.1 (2026-10-09)
- **Webhook (optional):** receives the TTLock cloud callback, so fingerprint, card, passcode and key use show up in real time with who and how. Sends Matter lock operation events. The plugin generates the secret webhook URL and shows it in the settings and the log.
- **Local control (optional):** lock/unlock over Bluetooth through an ESPHome Bluetooth proxy (ESP32), with `auto` (Bluetooth first, cloud fallback), `local` and `cloud` connection modes
- Instant lock state and battery from the lock's Bluetooth broadcasts, including fingerprint/keypad unlocks and auto-lock
- Bluetooth keys from the TTLock account (with email verification), the TTLock API `lockData` (experimental), or pasted JSON (e.g. from the Home Assistant TTLock BLE integration)
- Optional reading of the lock's own history (who/how)
- Works offline in local mode with the last known lock list
- Publishing: pre-release versions go to the npm `beta` tag

## 1.2.1 (2026-10-06)
- Buy Me a Coffee sponsor link in Matterbridge, on GitHub and in the README

## 1.2.0 (2026-10-06)
- Compatible with Matterbridge 3.x: uses the current `matterbridge`, `matterbridge/matter/clusters` and `matterbridge/logger` exports (the old `doorLockDevice`/`DoorLock` imports no longer exist)
- Access token is renewed automatically (refresh token, expiry tracking and re-login when TTLock rejects the token)
- All locks are discovered (lock list pagination instead of only the first 20)
- Battery level is reported through the Matter Power Source cluster, with low/critical warnings
- Lock state is polled from TTLock (`refreshInterval`, default 300 seconds), so changes made with the app, keypad or key show up in Matter
- Failed lock/unlock requests now fail the Matter command instead of silently succeeding
- Locks without a gateway are reported in the log
- Secrets are no longer printed in the debug log, and are masked in the config UI
- New `whiteList`/`blackList` options to choose which locks are exposed
- Request timeout for TTLock API calls
- Unit tests for the TTLock API client

## 1.0.2 (2025-05-14)
- Removed `matterbridge` from `devDependencies` to resolve plugin loading issues
- Fixed compatibility with Luligu's Matterbridge fork

## 1.0.1 (2025-05-14)
- Removed `matterbridge` from `peerDependencies` and added to `devDependencies`
- Fixed plugin loading issues

## 1.0.0 (2025-05-13)
- Initial release of renamed plugin (from matterbridge-ttlock-plugin to matterbridge-ttlock)
- Simplified plugin to focus only on lock/unlock functionality
- Removed battery percentage reporting
- Updated author and description

## Previous Versions (matterbridge-ttlock-plugin)
- Various development versions with battery reporting functionality

