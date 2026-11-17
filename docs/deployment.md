# Deployment and operation

## Single container

To build from the checked-out source:

```sh
docker compose up --build -d
```

### Published release images

Once a release has successfully published, the public image is available at
`ghcr.io/lemanjo/screensvr:v0.1.0` (replace the version as appropriate). Published
images initially support **linux/amd64**.

To use an image without building locally, create a separate Compose file such
as `compose.release.yaml` with:

```yaml
services:
  screensvr:
    image: ghcr.io/lemanjo/screensvr:v0.1.0
    ports:
      - "3000:3000"
    volumes:
      - screensvr-data:/data
    restart: unless-stopped
    init: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL

volumes:
  screensvr-data:
```

Start it with `docker compose -f compose.release.yaml up -d`. Use the same
Compose project name/directory when switching from the source-built service so
the existing named data volume is preserved.

For exact deployments, replace the tag with the digest from the release
workflow's run summary, for example
`ghcr.io/lemanjo/screensvr@sha256:…`. Before deploying, verify its provenance:

```sh
gh attestation verify \
  oci://ghcr.io/lemanjo/screensvr@sha256:REPLACE_WITH_ACTUAL_DIGEST \
  --repo lemanjo/screensvr
```

The workflow also publishes an attested CycloneDX SBOM. Attestations identify the
source and workflow; they do not guarantee the software is vulnerability-free.
See [release security](releasing.md) for the publishing process and first-package
visibility setup.

### First-run setup

Visit `http://<server>:3000` and complete administrator setup immediately on a
trusted network. Add a display and open its permanent address in Fully Kiosk Browser
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
| `SCREENSVR_PHOTOS_DIR`     | `/photos`                                     | Optional mounted-photo root; mount NAS/local photos read-only here          |
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

## Display addresses and credentials

Administrator cookies expire after seven days. Displays use permanent,
name-based URLs such as `/display/olohuone`, without secrets, pairing, or cookies.
Use **Display link** to retrieve the same address again; it stays unchanged after
renames and restarts. Duplicate names receive numbered suffixes.

Display content and read-only state/SSE APIs can be viewed by anyone who can
reach the server. Use a trusted LAN, VPN, or reverse-proxy access controls when
displayed information should not be public. Administrator APIs still require
authentication. Deleting a display removes its address and disconnects its
screens.

Upgrades automatically assign name-based addresses to existing displays without
losing their settings. Old UUID-based display links redirect to the permanent
address; old pairing fragments and display cookies are no longer needed.

If you lose the administrator password, stop the server, back up the data, then
use the SQLite CLI against the backup-verified database:

```sql
BEGIN;
DELETE FROM sessions;
DELETE FROM meta WHERE key = 'password';
COMMIT;
```

Restart on a trusted/private network and immediately complete first-run setup
again. This leaves device settings, packages, and permanent addresses intact.
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
sessions, display settings, encrypted integration credentials, and their
`integration-key`; restrict access to them. Restore the matching key with the
database. A missing/mismatched key disables integration access rather than
silently replacing credentials.

The scenes update migrates SQLite to schema version 4, moving existing display
settings and data bindings into a Default scene with scheduling disabled.
Older binaries cannot
open that database. Back up before upgrading; rollback requires restoring the
pre-upgrade data directory, not just starting an older container.

To restore, stop screensvr, restore the complete directory into its data volume,
ensure the runtime user can read/write it (normally UID 1000), and start the
matching application version. Test restoration before relying on a backup.

## Limits and failure recovery

- Existing loaded faces keep running while the server/network is unavailable.
  Reloading or starting a new display still requires the server.
- A failed face renders a retry overlay. Switch to a bundled face in management
  if a package is broken.
- Packages are trusted executable code. Do not expose installation to strangers.
- One version per face ID is supported. Reassign or delete every scene using the
  old face, including inactive scenes, then remove the package and install its replacement.
- A crash during installation can leave `.staging-*` or an unreferenced reserved
  directory below `/data/faces`. They are not served. After stopping the server
  and checking the database, an operator may remove only those known orphan
  directories. Do not delete referenced face directories.
- Home Assistant sensor readings are supported through server-side
  [integrations](integrations.md). Its URL must be reachable from the container.
  Weekly time-based scheduling is supported per display. Registry downloads,
  multi-user permissions, and offline startup are not implemented.

The `/api/health` endpoint reports process readiness. SSE connections and
last-seen timestamps provide display status in management; they do not imply
physical screen power or kiosk health.
