# Changelog

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

