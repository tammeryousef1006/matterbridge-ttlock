# Matterbridge TTLock Plugin

A Matterbridge plugin for controlling TTLock smart locks via the TTLock API. This plugin integrates TTLock devices with [Luligu's Matterbridge](https://github.com/Luligu/matterbridge), allowing you to control your TTLock devices through Matter.

## Features

- Discover and control TTLock devices through Matterbridge
- Lock and unlock TTLock devices
- Seamless integration with Matter-compatible smart home systems
- Support for both username/password and access token authentication

## Prerequisites

- [Matterbridge](https://github.com/Luligu/matterbridge) installed and running
- Node.js 18 or higher
- TTLock account with API access (client ID and client secret)

## Installation

```bash
# Install the plugin globally
npm install -g matterbridge-ttlock

# Or install a specific version from a local file
npm install -g /path/to/matterbridge-ttlock-1.0.8.tgz
```

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
| `ttlock_api_base_url` | String | No | Custom API base URL (defaults to `https://api.sciener.com`) |

\* Either username/password OR access_token must be provided

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

## Development

### Building from Source

```bash
# Clone the repository
git clone https://github.com/yourusername/matterbridge-ttlock.git
cd matterbridge-ttlock

# Install dependencies
npm install

# Build the plugin
npm run build

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
  <img src="bmc-button.svg" alt="Buy me a coffee" width="120">
</a>
# matterbridge-ttlock
