# Deployment and operation

## Single container

```sh
docker compose up --build -d
```

Visit `http://<server>:3000` and complete administrator setup immediately on a
trusted network. Add a display and open its private link in Fully Kiosk Browser
or another modern browser. Kiosk fullscreen and screen-on policies may need
configuration on the device. Browser wake locks are best-effort and often
unavailable on plain HTTP.

The runtime container runs as the unprivileged `node` user. The named volume at
`/data` stores the database and face packages. It does not need a Docker socket.
Only the development container uses the host engine.

Do not remove the data volume when upgrading. Only one screensvr process should
manage a data directory at a time. Databases from a newer schema version are
rejected rather than silently downgraded.

## Environment variables

| Variable                   | Default                                       | Purpose                                                                     |
| -------------------------- | --------------------------------------------- | --------------------------------------------------------------------------- |
| `HOST`                     | `0.0.0.0`                                     | HTTP bind address                                                           |
| `PORT`                     | `3000`                                        | HTTP port                                                                   |
| `SCREENSVR_DATA_DIR`       | `./data` (`/data` in Docker)                  | Persistent storage                                                          |
| `SCREENSVR_ORIGIN`         | Request origin derived from protocol and Host | Explicit public origin for mutation checks                                  |
| `SCREENSVR_SECURE_COOKIES` | `false`                                       | Set `true` when served over HTTPS                                           |
| `SCREENSVR_TRUST_PROXY`    | `false`                                       | Trust forwarded headers; only behind an exclusively reachable trusted proxy |

For local Node usage, an environment example is provided in `.env.example`.
The application does not implicitly read `.env`; export variables or use Node's
`--env-file` option. For Docker, declare variables under `environment` in Compose.

## Reverse proxies

Use HTTPS when credentials or display data cross an untrusted network. For an
HTTPS deployment, set the exact public origin (without a trailing slash) and
enable secure cookies:

```yaml
environment:
  SCREENSVR_ORIGIN: https://screensvr.example.com
  SCREENSVR_SECURE_COOKIES: "true"
```

Forward the original Host, allow uploads of at least 10 MiB plus multipart
overhead, and disable response buffering for `/api/display/*/events`. The server
sends `X-Accel-Buffering: no`; also give streaming requests a timeout longer than
the 15-second heartbeat. Keep API responses and SSE out of proxy caches.

Use a dedicated origin, not a subpath such as `/screensvr/`. Do not enable broad
CORS on the API. Do not share the origin with unrelated applications or grant
untrusted users filesystem access.

## Pairing and credentials

Administrator cookies expire after seven days. Display pairing cookies last
one year, unless revoked earlier. Reopen a fresh display link when a cookie
expires or is lost.

The secret is in the URL fragment, not a query parameter. The client removes it
after pairing. Still treat the whole link as a credential: browser history,
clipboard managers, screenshots, or anyone you share it with may retain it.
**New display link** revokes earlier links and connected clients immediately.

If you lose the administrator password, stop the server, back up the data, then
use the SQLite CLI against the backup-verified database:

```sql
BEGIN;
DELETE FROM sessions;
DELETE FROM meta WHERE key = 'password';
COMMIT;
```

Restart on a trusted/private network and immediately complete first-run setup
again. This leaves device settings, packages, and display credentials intact.
Never edit the database while an upgrade is running.

## Backups

Back up the **whole data directory**, not only the main SQLite file. Stop
screensvr first so the database and package files remain consistent.

For the included Compose service, one approach is:

```sh
docker compose stop screensvr
mkdir -p backups
docker compose cp screensvr:/data ./backups/screensvr
docker compose start screensvr
```

Choose a fresh destination for each backup. Backups include password hashes,
sessions, and pairing-token hashes; restrict access to them.

To restore, stop screensvr, restore the complete directory into its data volume,
ensure the runtime user can read/write it (normally UID 1000), and start the
matching application version. Test restoration before relying on a backup.

## Limits and failure recovery

- Existing loaded faces keep running while the server/network is unavailable.
  Reloading or starting a new display still requires the server.
- A failed face renders a retry overlay. Switch to a bundled face in management
  if a package is broken.
- Packages are trusted executable code. Do not expose installation to strangers.
- One version per face ID is supported. Switch displays away, remove the old
  package, then install the replacement.
- A crash during installation can leave `.staging-*` or an unreferenced reserved
  directory below `/data/faces`. They are not served. After stopping the server
  and checking the database, an operator may remove only those known orphan
  directories. Do not delete referenced face directories.
- Home Assistant, scheduling, registry downloads, multi-user permissions, and
  offline startup are not part of v0.1.

The `/api/health` endpoint reports process readiness. SSE connections and
last-seen timestamps provide display status in management; they do not imply
physical screen power or kiosk health.
