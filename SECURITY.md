# Security policy

## Supported versions

Security fixes target the latest stable release. Upgrade older versions before
reporting issues, and check the release notes for migration requirements.

## Reporting a vulnerability

Please use [GitHub's private vulnerability reporting](https://github.com/lemanjo/screensvr/security/advisories/new)
instead of opening a public issue containing exploit details or credentials.
This is a solo-maintained project; there is no guaranteed response time.

Never include administrator passwords, session cookies, database backups, or
other live credentials in a report. If a secret has been exposed, revoke or
rotate it immediately; deleting a file or rewriting Git history is not enough.

## Deployment boundaries

- Complete first-run administrator setup on a trusted network.
- Use HTTPS and secure cookies when credentials cross an untrusted network.
- Display addresses and read-only display APIs are public to anyone who can
  reach the server. Use a LAN, VPN, or reverse-proxy access controls as needed.
- Face packages contain trusted executable JavaScript. Their sandbox is defense
  in depth, not a guarantee that malicious packages are safe.
- Do not use development servers or the Docker-socket-enabled development
  container as a production deployment.

See [deployment guidance](docs/deployment.md) and
[repository/release security](docs/releasing.md).
