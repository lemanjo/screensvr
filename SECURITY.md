# Security policy

## Supported versions

Security fixes target the latest stable release. Upgrade older versions before
reporting issues, and check the release notes for migration requirements.

## Reporting a vulnerability

Please use [GitHub's private vulnerability reporting](https://github.com/lemanjo/screensvr/security/advisories/new)
instead of opening a public issue containing exploit details or credentials.
This is a solo-maintained project; there is no guaranteed response time.

Never include administrator passwords, session cookies, calendar subscription URLs, photo capability URLs,
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
- Immich API keys have the same server-side encryption and backup sensitivity.
  Grant only `album.read`, `asset.read`, and `asset.view`, ideally to a dedicated
  account shared only into intended albums. The whole selected album is public
  display content. Image requests recheck upstream access and album membership
  even on cache hits; hidden/locked and trashed assets are excluded. Original
  downloads and redirects are not used. Revocation cannot erase photos already
  downloaded by a viewer or retained on a display.
- Entire iCalendar subscription URLs are bearer credentials, encrypted server-side
  and hidden after saving. Do not log/share them, and rotate exposed URLs at the
  provider. Calendar timing is public display data; titles are default-off and
  require per-calendar opt-in. Redaction happens before public state/SSE and face
  data, not in the face. Descriptions, locations, attendees, links, and source IDs
  are never published. Home Assistant's calendar API does not expose private-event
  flags: use busy-only for sensitive calendars. Revocation cannot erase data
  already received by viewers or disconnected displays.
- Face packages contain trusted executable JavaScript. Their sandbox is defense
  in depth, not a guarantee that malicious packages are safe.
- Do not use development servers or the Docker-socket-enabled development
  container as a production deployment.

## Temporary development-tool advisory acceptance

Until **2026-12-17 00:00 UTC**, CI accepts
[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
only for **picomatch 4.0.7** in application development dependencies and isolated
Dev Container bootstrap tooling. No patched upstream release is available as of
2026-11-17. This is an explicitly approved, time-limited risk acceptance, not a
security fix.

The vulnerable repeated-extglob patterns are not needed from untrusted input in
our build/test workflow. Keep development servers, tooling, and checkout access
restricted; never feed untrusted glob patterns into these tools. Production
dependencies have **no exceptions**, and container scanning, secret scanning,
CodeQL, and unrelated high/critical dependency findings remain blocking.

`.github/scripts/audit-dependencies.ts` checks the exact advisory, package
version, development lockfile flags, dependency chains, and expiration. Audit
errors fail closed. Remove the acceptance and update both lockfiles when a fix
is published; do not silently extend its deadline.

See [deployment guidance](docs/deployment.md) and
[repository/release security](docs/releasing.md).
