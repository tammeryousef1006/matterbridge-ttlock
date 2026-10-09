# Contributing

Thanks for helping improve matterbridge-ttlock! Bug reports, ideas and pull requests are welcome.

## Reporting bugs and ideas

Use the [issue templates](https://github.com/tammeryousef1006/matterbridge-ttlock/issues/new/choose). For bugs, a Matterbridge log with **debug** turned on helps a lot; remove secrets first. Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Development setup

Requirements: Node.js 20+ and a global Matterbridge install.

```bash
git clone https://github.com/tammeryousef1006/matterbridge-ttlock.git
cd matterbridge-ttlock
npm install
npm run dev:link   # links your global Matterbridge (it is not a dependency)
npm test           # builds and runs all tests
```

`npm pack` creates a `.tgz` you can install in Matterbridge with `npm install -g ./matterbridge-ttlock-<version>.tgz` to try changes on real hardware.

## Project layout

- `src/platform.ts`: the Matterbridge platform (devices, commands, state, users, webhook wiring)
- `src/ttlockApi.ts`: TTLock Open API client
- `src/local.ts`, `src/ble/`: local control through an ESPHome Bluetooth proxy (protocol, keys, sessions)
- `src/webhook.ts`, `src/records.ts`, `src/users.ts`: cloud callback, record types, lock users mirror
- `test/`: tests, including a simulated lock and a fake ESPHome device

## Pull requests

- Keep changes focused, and add or update tests for behaviour you change.
- Make sure `npm test` passes; CI runs it on Node 20, 22 and 24.
- Add a line to `CHANGELOG.md` describing the change.
- New features that change behaviour for existing users should be optional and off by default.

## Releases

Maintainers bump `version` in `package.json`, update the changelog, merge to `main`, and publish a GitHub release; the publish workflow then releases to npm (pre-release versions go to the `beta` tag).
