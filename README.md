# Matterbridge TTLock Plugin

A Matterbridge plugin for controlling TTLock smart locks via the TTLock API. This plugin integrates TTLock devices with [Luligu's Matterbridge](https://github.com/Luligu/matterbridge), allowing you to control your TTLock devices through Matter.

## Features

- Discovers all TTLock locks on your account and exposes them as Matter door locks
- Lock and unlock from any Matter controller (Apple Home, Google Home, Alexa, Home Assistant, SmartThings...)
- Battery level and low-battery warnings
- Lock state refreshed periodically, so changes made with the TTLock app, keypad or key are reflected in Matter
- Username/password authentication with automatic token renewal, or a static access token
- Choose which locks to expose with a whitelist/blacklist

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

## License

ISC License - See [LICENSE](LICENSE) for details.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

<a href="https://www.buymeacoffee.com/6sjde6vkzl">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy me a coffee" width="160">
</a>
