# Changelog

## 1.4.0-beta.7 (2026-10-09)
- Who/how without a webhook: when the ESP32 sees the lock opened or locked by someone at the door, the plugin fetches the matching record from the TTLock cloud (uploaded by the gateway) a few seconds later, logs "unlocked by fingerprint (Tamer)" and sends the Matter event with the user. If no record turns up within a minute (e.g. auto-lock), the operation is still reported without details.
- The same operation from the lock history and the cloud is only reported once
- "Read who/how from the lock history" is now described as for locks without a gateway

## 1.4.0-beta.6 (2026-10-09)
- **Lock users (optional, read-only):** the fingerprints, cards and passcodes from the TTLock app appear as Matter lock users (grouped by name, expired ones disabled, refreshed every 15 minutes). Lock events name the person ("unlocked by fingerprint (Tamer)") and carry the Matter user and credential. Adding or removing users/codes from a controller is refused.
- README: ESP32 scan settings to listen continuously, so short fingerprint/keypad broadcasts are not missed

## 1.4.0-beta.5 (2026-10-09)
- `auto` mode: Bluetooth gets a 4-second head start; if the lock hasn't answered by then (asleep, or busy syncing with the gateway), the cloud command starts in parallel and whichever finishes first wins. When the cloud wins, the Bluetooth attempt is cancelled before it sends anything. A stuck Bluetooth connection now costs about 6 seconds instead of 13.
- Lock/unlock commands take priority over a background history read, and the history isn't read in the 30 seconds after the plugin's own command
- While the ESP32 hears the lock, its broadcasts decide the lock state; webhook and history records only add the "who/how" event, so a late record can no longer flip the state
- History records of the plugin's own commands are ignored

## 1.4.0-beta.4 (2026-10-09)
- Webhook: records of the plugin's own commands (the cloud reports them as "app" a few seconds later) are ignored, and a record older than the current state (for example a fingerprint unlock after which the lock already auto-locked) still sends the Matter event but no longer rolls the lock state back
- Diagnostics at info level for the beta: each change in the lock's Bluetooth broadcast (with the raw data), each webhook record, and the timing of every Bluetooth command

## 1.4.0-beta.3 (2026-10-09)
- Reverted the ESP32 service cache from beta.2: on real hardware it left Bluetooth connections hanging, so commands timed out and the lock stopped broadcasting its state
- Faster fallback in `auto` mode: a failed Bluetooth attempt no longer waits for the disconnect confirmation, so the cloud takes over after about 10 seconds
- Logs when a lock stops broadcasting over Bluetooth (for example because something is still connected to it) and when it comes back

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

