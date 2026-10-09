# Matterbridge TTLock Plugin

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-support-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/6sjde6vkzl)

A Matterbridge plugin for controlling TTLock smart locks via the TTLock API. This plugin integrates TTLock devices with [Luligu's Matterbridge](https://github.com/Luligu/matterbridge), allowing you to control your TTLock devices through Matter.

## Features

- Discovers all TTLock locks on your account and exposes them as Matter door locks
- Lock and unlock from any Matter controller (Apple Home, Google Home, Alexa, Home Assistant, SmartThings...)
- Battery level and low-battery warnings
- Lock state refreshed periodically, so changes made with the TTLock app, keypad or key are reflected in Matter
- Username/password authentication with automatic token renewal, or a static access token
- Choose which locks to expose with a whitelist/blacklist
- **Optional webhook:** the TTLock cloud reports fingerprint, card, passcode and key use in real time, including who and how
- **Optional local control:** lock/unlock over Bluetooth through an ESP32 (ESPHome Bluetooth proxy), with instant state updates and a cloud fallback

## Prerequisites

- [Matterbridge](https://github.com/Luligu/matterbridge) 3.0.0 or later
- Node.js 20 or later
- A TTLock Open Platform application (client ID and client secret) from https://euopen.ttlock.com
- A TTLock gateway (G2/G3/G4) paired with each lock. Remote lock/unlock and state updates go through the gateway.

## Installation

```bash
npm install -g matterbridge-ttlock
matterbridge -add matterbridge-ttlock
```

Or install it from the Matterbridge frontend by searching for `matterbridge-ttlock`.

## Configuration

Open the plugin config in the frontend.

### Configuration Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `ttlock_client_id` | String | Yes | Your TTLock API client ID |
| `ttlock_client_secret` | String | Yes | Your TTLock API client secret |
| `ttlock_username` | String | No* | Your TTLock account username |
| `ttlock_password` | String | No* | Your TTLock account password |
| `ttlock_access_token` | String | No* | Your TTLock API access token |
| `ttlock_api_base_url` | String | No | Custom API base URL (defaults to `https://api.sciener.com`; `https://euapi.ttlock.com` also works) |
| `refreshInterval` | Number | No | Seconds between lock state and battery refreshes (default `300`, minimum `30`, `0` disables) |
| `whiteList` | String[] | No | Only expose locks with these names or IDs |
| `blackList` | String[] | No | Never expose locks with these names or IDs |
| `debug` | Boolean | No | Enable debug logging |

\* Either username/password OR access_token must be provided. Username/password is recommended because the plugin can then renew the token on its own; a static access token stops working when it expires.

The **Webhook** and **Local control** sections are optional and off by default. Without them the plugin works exactly as before (cloud only), with no extra errors or warnings.

## Webhook (real-time records from the TTLock cloud)

Without the webhook, the plugin only learns about changes made at the door (fingerprint, card, passcode, key) by polling the cloud every `refreshInterval` seconds, and a quick unlock that auto-locks again is often missed. With the webhook, the TTLock cloud notifies the plugin within seconds, including how the lock was opened and by whom. The lock state is updated and a Matter *lock operation* event is sent (Home Assistant and some other controllers can show it or use it in automations).

1. Make the webhook port (default `8090`) reachable **from the internet**, for example with a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), ngrok or Tailscale Funnel pointing at `http://<matterbridge-ip>:8090`. A local address such as `http://192.168.1.10:8090` does **not** work: the TTLock servers have to reach it.
2. In the plugin settings, open **Webhook**: turn on **Enable webhook** and fill in **Public URL** with your internet address (for example `https://lock.example.com`).
3. Save and restart. The plugin shows the full URL (with a secret code) in **Your webhook URL** and in the log.
4. Paste that URL as the **callback URL** of your application on the [TTLock Open Platform](https://euopen.ttlock.com).

## Local control (Bluetooth through an ESP32)

With an ESP32 running an [ESPHome Bluetooth proxy](https://esphome.io/components/bluetooth_proxy.html) within Bluetooth range of the lock, the plugin can:

- see the lock state and battery **instantly** from the lock's Bluetooth broadcasts, including fingerprint/keypad unlocks and auto-lock, without draining the battery
- lock and unlock **directly over Bluetooth**, without the internet or a TTLock gateway
- optionally read **who/how** from the lock's own history (**Read who/how from the lock history**)

**Connection mode:**

| Mode | Lock/unlock |
|------|-------------|
| `auto` (default) | Bluetooth first; if that fails within a few seconds, through the cloud |
| `local` | Bluetooth only |
| `cloud` | Cloud only (the ESP32 is ignored) |

Local control is only active when **ESP32 address** is filled in.

### Setting up the ESP32

The ESP32 must be **dedicated to this plugin**. An ESPHome Bluetooth proxy serves Bluetooth to only one client at a time, so **remove the ESP32 from Home Assistant** (delete the ESPHome device there, or at least disable it) and stop any Home Assistant integration that uses it for the lock. Example ESPHome configuration:

```yaml
esp32:
  board: esp32dev
  framework:
    type: esp-idf

api:
  encryption:
    key: "<base64 key>"   # put the same key in the plugin settings

bluetooth_proxy:
  active: true            # required to connect to the lock

esp32_ble_tracker:
  scan_parameters:
    active: true
```

In the plugin settings, fill in **ESP32 address**, and **ESP32 API encryption key** if your ESPHome configuration has one.

### Bluetooth keys

Each lock needs its Bluetooth keys. The plugin tries these sources in order:

1. **Bluetooth keys (JSON)** pasted in the settings. If you used the Home Assistant *TTLock BLE* integration, you can copy the `keys` of its entry from Home Assistant's `.storage/core.config_entries`.
2. The `lockData` the TTLock API returns (experimental; the log says whether it worked for your lock).
3. **Get Bluetooth keys from the TTLock account** (on by default): the plugin logs in to the TTLock app service with the username/password above and downloads the keys, like the TTLock app does. The first time, TTLock may email a verification code: the log tells you, enter it in **Verification code**, save and restart. The keys are then remembered.

Locks without a key keep working through the cloud.

## Usage

After installation and configuration:

1. Restart Matterbridge
2. The plugin will automatically discover your TTLock devices
3. Your TTLock devices will appear as door locks in your Matter-compatible smart home system
4. You can now control your TTLock devices through Matter

## Troubleshooting

### Plugin Not Loading

If you encounter issues with the plugin not loading, check the Matterbridge logs for error messages. Common issues include:

- Incorrect configuration format
- Missing required configuration parameters
- Plugin installation issues

### Authentication Issues

If the plugin loads but cannot discover devices:

- Verify your TTLock API credentials
- Check your internet connection
- Ensure your TTLock account has API access enabled

### Local control

- *"The ESP32 proxy has not sent any Bluetooth advertisements"*: Home Assistant (or another client) is still using the ESP32. Remove it there.
- *"refused the connection ... encryption key"*: the **ESP32 API encryption key** doesn't match the ESPHome configuration.
- *"could not connect over Bluetooth"*: move the ESP32 closer to the lock, and check `bluetooth_proxy: active: true`.
- *"the lock refused to unlock"* or *"did not answer"*: the Bluetooth key is wrong or outdated (for example after the lock was reset). Remove the pasted keys or let the plugin download them again.

### Lock/unlock fails or the state never changes

- The lock must be connected to a TTLock gateway. The log warns about locks without one.
- Enable "Remote Unlock" for the lock in the TTLock app.
- A failed command is shown as an error in your Matter controller, and the reason is logged by the plugin.

## Development

### Releasing

Publishing to npm is automated by the `Publish to npm` GitHub Actions workflow. To use it, add an npm automation token as the `NPM_TOKEN` repository secret. Then bump `version` in `package.json` and either publish a GitHub release or run the workflow manually.

### Building from Source

```bash
# Clone the repository
git clone https://github.com/tammeryousef1006/matterbridge-ttlock.git
cd matterbridge-ttlock

# Install dependencies and link your global Matterbridge install
npm install
npm run dev:link

# Build and run the tests
npm test

# Create a package
npm pack
```

## Support

If this plugin is useful to you, you can support its development:

<a href="https://buymeacoffee.com/6sjde6vkzl"><img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy me a coffee"></a>

## Credits

The Bluetooth protocol support is ported from the MIT-licensed [`ttlock-ble`](https://github.com/roquerodrigo/ttlock-ble) library by Rodrigo Roque.

## License

ISC License - See [LICENSE](LICENSE) for details.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

<a href="https://www.buymeacoffee.com/6sjde6vkzl">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy me a coffee" width="160">
</a>
