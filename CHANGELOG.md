# Changelog

## 1.4.0 (2026-10-09)

### Local control (optional, Bluetooth through an ESP32)
- Lock and unlock over Bluetooth through an ESPHome Bluetooth proxy (ESP32), with `auto`, `local` and `cloud` connection modes
- `auto`: Bluetooth gets a 4-second head start, then the cloud is tried in parallel and the first to finish wins (the Bluetooth attempt is cancelled before it sends anything if the cloud wins)
- Instant lock state and battery from the lock's Bluetooth broadcasts, including fingerprint/keypad unlocks and auto-lock
- Bluetooth keys downloaded from the TTLock account (with email verification the first time), pasted as JSON (e.g. from the Home Assistant TTLock BLE integration), or from the API `lockData` (experimental)
- Works offline in `local` mode with the last known lock list
- Clear log messages when the ESP32 can't be reached, has the wrong encryption key, or a lock stops broadcasting

### Who and how
- When someone opens or locks the door, the plugin fetches the record your gateway uploads to the TTLock cloud and logs e.g. "unlocked by fingerprint (Tamer)", with a Matter lock operation event (method and user)
- **Webhook (optional):** the TTLock cloud can push records in real time; the plugin generates the secret callback URL and shows it in the settings
- Records of the plugin's own commands and records older than the current state are handled so they never flip the lock state

### Lock users (optional, read-only)
- The fingerprints, cards and passcodes from the TTLock app appear as Matter lock users (grouped by name, expired ones disabled), and events carry the user. Changes from controllers are refused; manage users in the TTLock app.

### Other
- Battery values only written when they change; the Bluetooth reading is preferred when the ESP32 sees the lock
- Publishing: pre-release versions go to the npm `beta` tag
- The Bluetooth protocol is ported from the MIT-licensed `ttlock-ble` library

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

