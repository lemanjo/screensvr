# Security policy

## Supported versions

Security fixes target the latest stable release. Upgrade older versions before
reporting issues, and check the release notes for migration requirements.

## Reporting a vulnerability

Please use [GitHub's private vulnerability reporting](https://github.com/lemanjo/screensvr/security/advisories/new)
instead of opening a public issue containing exploit details or credentials.
This is a solo-maintained project; there is no guaranteed response time.

Never include administrator passwords, session cookies, photo capability URLs,
database backups, or other live credentials in a report. If a secret has been exposed, revoke or
rotate it immediately; deleting a file or rewriting Git history is not enough.

## Deployment boundaries

- Complete first-run administrator setup on a trusted network.
- Use HTTPS and secure cookies when credentials cross an untrusted network.
- Display addresses and read-only display APIs are public to anyone who can
  reach the server. Use a LAN, VPN, or reverse-proxy access controls as needed.
- Selected integration readings inherit that public display visibility, even
  when a face hides an input. Bind only data you intend to share.
- Selected photo collections have the same display visibility, including images
  not currently on screen. Mount only intended photo directories, read-only.
  The server confines reads to the configured root and selected collection,
  excludes symlinks, validates image formats, and strips original metadata.
  Temporary photo URLs are bearer capabilities; avoid logging them in reverse
  proxies. App-level photo request logging is disabled, and image responses must
  not be cached by proxies.
- Home Assistant credentials stay server-side, encrypted with a key in the
  persistent volume. Full-volume backups still contain recoverable credentials.
  Prefer HTTPS and a dedicated least-privilege HA account; a read-only connector
  does not make its upstream token read-only.
- Face packages contain trusted executable JavaScript. Their sandbox is defense
  in depth, not a guarantee that malicious packages are safe.
- Do not use development servers or the Docker-socket-enabled development
  container as a production deployment.

See [deployment guidance](docs/deployment.md) and
[repository/release security](docs/releasing.md).
