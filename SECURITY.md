# Security policy

## Supported versions

Security fixes target the latest stable release. Upgrade older installations
before reporting issues, and read release notes for migration requirements.

## Report a vulnerability privately

Use [GitHub's private vulnerability reporting](https://github.com/lemanjo/screensvr/security/advisories/new),
not a public issue containing exploit details or sensitive data.
This is a solo-maintained project with no guaranteed response time.

Never include live passwords, integration tokens/API keys, session cookies,
calendar subscription URLs, temporary photo URLs, or database backups.
If a credential has been exposed, revoke or rotate it immediately. Deleting a
file or rewriting Git history does not revoke a secret.

## Deploy safely

- Complete first-run administrator setup on a trusted network.
- Use HTTPS and secure cookies when credentials cross an untrusted network.
- Keep development servers, debugger ports, and the Docker-socket-enabled
  Dev Container private. Do not use them as a production deployment.
- Use a trusted LAN, VPN, or reverse-proxy access controls for sensitive display
  content. A management password does not restrict public display access.

See [Deployment](docs/deployment.md) for configuration and backup instructions.

## Understand what a display publishes

Display addresses and read-only display APIs are accessible to anyone who can
reach the server. Selected integration data has that same visibility **even if
the face hides it**.

### Photos

The whole selected photo collection is display content, not just the current
image. Mount only intended directories, read-only. The server confines reads
to the configured root/selected collection, excludes symlinks, validates image
formats, and strips original metadata.

Temporary photo URLs are bearer capabilities. Do not share them or log them
at reverse proxies, and do not cache photo responses at proxies. App-level
photo request logging is disabled.

Immich keys should grant only `album.read`, `asset.read`, and `asset.view`,
ideally for an account shared only into intended albums. Image requests recheck
upstream asset access and album membership even on cache hits. Hidden/locked,
trashed, offline, and video assets are excluded; original downloads and
redirects are not used.

Revoking access cannot erase images already downloaded or retained on a display.

### Calendars

Appointment timing is public display data. Titles are default-off and require
an explicit per-calendar opt-in. Redaction happens on the server, before public
state/event responses and face data—not merely in the face's presentation.

Descriptions, locations, attendees, meeting links, and source IDs are never
published. iCalendar private/confidential classifications keep titles redacted.
Home Assistant's event API does not expose those flags: keep sensitive calendars
busy-only. Revocation cannot erase data already received by viewers or
disconnected displays.

## Credentials and backups

Home Assistant tokens, Immich API keys, and entire iCalendar subscription URLs
stay on the server, encrypted with the key in the persistent data directory.
Full-volume backups contain recoverable credentials and must be protected.
Back up the complete directory, including its matching `integration-key`.

Prefer HTTPS and dedicated least-privilege accounts. A read-only connector does
not make its upstream token read-only or reduce its provider permissions.
Treat the entire iCalendar subscription URL, including its path and query, as a
credential; rotate exposed URLs at the provider.

For provider-specific details, see [Integrations](docs/integrations.md).

## Trust face packages

Face ZIPs contain executable JavaScript. Only install packages from trusted
sources. Their browser sandbox is defense in depth, not a guarantee against
malicious code, resource exhaustion, browser vulnerabilities, or misleading
visual content.

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

See [repository and release checks](docs/releasing.md) for maintenance procedures.
