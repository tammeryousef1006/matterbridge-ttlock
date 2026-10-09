# Security policy

This plugin controls door locks, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, report them privately through
[GitHub security advisories](https://github.com/tammeryousef1006/matterbridge-ttlock/security/advisories/new).

Include what you found, how to reproduce it, and the plugin and Matterbridge versions. You should get a reply within a few days; a fix will be released as soon as possible and you'll be credited if you wish.

## Supported versions

Only the latest released version receives security fixes.

## Keeping your setup safe

- Never share your TTLock client secret, password, ESP32 encryption key, Bluetooth keys or webhook URL (it contains a secret token) in issues or logs.
- Expose the webhook to the internet only through a tunnel or HTTPS reverse proxy, and only the webhook port.
- Protect the Matterbridge frontend with a password if it is reachable by others; the plugin settings contain your credentials.
