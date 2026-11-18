# Deployment and operation

screensvr runs as one service on your home server. Its management page, display
links, and face assets share port **3000**. Use one process per data directory.

- [Install the recommended container](#published-container)
- [Build from source or run Node.js](#other-installation-options)
- [Configure HTTPS](#reverse-proxies)
- [Upgrade](#upgrading) · [Back up and restore](#backups)

## Published container

Follow the [README quick start](../README.md#quick-start) for a complete Compose
file and first-display setup. The example targets
`ghcr.io/lemanjo/screensvr:v1.0.0`; it can be pulled after that release's publishing
workflow succeeds. Check [releases](https://github.com/lemanjo/screensvr/releases)
for available versions.

Published images support **linux/amd64**. Build locally for ARM; published
multi-architecture images are not currently provided.

The container runs as the unprivileged `node` user, normally UID 1000.
The named `screensvr-data` volume mounted at `/data` stores settings,
authentication, installed faces, and encrypted integration credentials. It does
not need a Docker socket. Only the development container uses the host engine.

Keep using the same Compose directory/project name so Compose finds the same
named volume. Do not run `docker compose down -v` unless you intend to remove
your persistent data.

### Verify a release image

For a fixed deployment, pin the image digest shown in the release workflow's
run summary instead of a mutable tag:

```text
ghcr.io/lemanjo/screensvr@sha256:REPLACE_WITH_ACTUAL_DIGEST
```

Verify its provenance with the GitHub CLI:

```sh
gh attestation verify \
  oci://ghcr.io/lemanjo/screensvr@sha256:REPLACE_WITH_ACTUAL_DIGEST \
  --repo lemanjo/screensvr
```

The workflow also publishes an attested CycloneDX software bill of materials
(SBOM). Attestations identify the source and workflow; they do not guarantee
that software is vulnerability-free. See [Releasing](releasing.md) for the
publishing process.

## Other installation options

### Build the container from source

Requires Git and Docker with Docker Compose:

```sh
git clone https://github.com/lemanjo/screensvr.git
cd screensvr
docker compose up --build -d
```

The repository's `compose.yaml` builds the checked-out source and uses the same
port and persistent storage layout as the published image. For a release
deployment, check out the desired release tag before building.

### Run with Node.js

Requires Git and **Node.js 24 LTS**; Docker is not needed:

```sh
git clone https://github.com/lemanjo/screensvr.git
cd screensvr
npm ci
npm run build
npm start
```

Open `http://YOUR_SERVER_IP:3000`. Data is stored in `./data` by default.
Keep optional npm dependencies enabled: photo processing uses platform-specific
`sharp` binaries. Use a service manager if you need automatic startup/restarts.
The development server is not a production deployment.

## First-run setup

Complete setup immediately on a trusted network: the first person to set the
administrator password claims the server. Add a display, then open its permanent
link on the tablet. See the [quick start](../README.md#quick-start) and
[user guide](user-guide.md) for Fully Kiosk, scenes, and schedules.

Configure fullscreen, screen-on behavior, brightness, and idle activation on the
device or in its kiosk browser. Browser wake locks are best-effort and may be
unavailable on plain HTTP.

## Environment variables

| Variable                   | Default                                       | Purpose                                                                          |
| -------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------- |
| `HOST`                     | `0.0.0.0`                                     | HTTP bind address.                                                               |
| `PORT`                     | `3000`                                        | HTTP port.                                                                       |
| `SCREENSVR_DATA_DIR`       | `./data` (`/data` in Docker)                  | Persistent storage.                                                              |
| `SCREENSVR_PHOTOS_DIR`     | `/photos`                                     | Optional photo root; mount local/NAS photos read-only here.                      |
| `SCREENSVR_ORIGIN`         | Request origin derived from protocol and Host | Exact public origin used for mutation checks.                                    |
| `SCREENSVR_SECURE_COOKIES` | `false`                                       | Set to `true` when serving over HTTPS.                                           |
| `SCREENSVR_TRUST_PROXY`    | `false`                                       | Trust forwarded headers; only use behind an exclusively reachable trusted proxy. |

For Docker, declare variables under the service's `environment` in Compose.
For Node.js, export them or use Node's `--env-file` option. The application does
not load `.env` automatically; [`.env.example`](../.env.example) is a template.

## Reverse proxies

Use a dedicated origin, such as `https://screensvr.example.com`, **not a subpath**
such as `/screensvr/`. Use HTTPS when credentials or display data cross an
untrusted network.

For HTTPS, add these settings to the Compose service:

```yaml
environment:
  SCREENSVR_ORIGIN: https://screensvr.example.com
  SCREENSVR_SECURE_COOKIES: "true"
```

Set the exact public origin without a trailing slash. Set
`SCREENSVR_TRUST_PROXY: "true"` only if direct access to screensvr is restricted
to your trusted proxy and you need forwarded headers.

Configure the proxy to:

- Forward the original Host.
- Allow face uploads of at least 10 MiB plus multipart overhead.
- Disable response buffering for `/api/display/*/events`. The server also sends
  `X-Accel-Buffering: no`.
- Give streaming requests a timeout longer than the 15-second heartbeat.
- Keep API/SSE responses and photo responses out of proxy caches.
- Avoid logging temporary `/api/photos/*` capability URLs.

Do not enable broad API CORS, share the origin with unrelated apps, or grant
untrusted users filesystem access. A login-protected management page does not
make display links private: use a trusted LAN, VPN, or proxy access controls
for sensitive display content.

## Display addresses and access

Display links are permanent, name-based URLs such as `/display/living-room`.
They require no login, pairing secret, or cookie. **Display link** retrieves the
same address after renames and restarts. Duplicate names receive numbered suffixes.
Deleting a display removes its address and disconnects its screens.

Anyone who can reach the server can read display content and its state/event
APIs. This includes selected inputs that a face hides and the entire selected
photo collection. Management requires the administrator session; those cookies
expire after seven days.

Existing installations retain settings during supported database upgrades.
Legacy UUID display links redirect to their permanent addresses; old pairing
fragments and display cookies are not needed.

## Upgrading

1. Read the target release notes.
2. [Back up the complete data directory](#backups) before changing versions.
3. For a published image, change the image tag or digest in your Compose file.
4. Pull and recreate the service:

   ```sh
   docker compose pull screensvr
   docker compose up -d screensvr
   docker compose logs --tail=50 screensvr
   ```

5. Check `/api/health`, sign in, and confirm that displays and integrations work.

For a source-built container, update to the intended release and use
`docker compose up --build -d` instead of pulling an image. For Node.js, stop the
service, update the source, run `npm ci` and `npm run build`, then restart with the
same persistent data directory.

Database migrations run automatically. Do not run multiple versions against the
same directory or downgrade an upgraded database. Rollback means restoring the
**complete pre-upgrade backup** and running its matching application version.
Newer database schemas are rejected rather than silently downgraded.

## Backups

Back up the **whole data directory**, not just `screensvr.sqlite`. Stop
screensvr first so the database and installed package files stay consistent.

For the Compose service:

```sh
docker compose stop screensvr
backup="./backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup"
docker compose cp screensvr:/data "$backup/"
docker compose start screensvr
```

Confirm that the copy succeeded and contains the data before relying on it.
Use a fresh destination for each backup. This example puts the copied directory
at `$backup/data`.

Backups contain password hashes, sessions, settings, packages, encrypted
integration credentials, and the `integration-key` needed to decrypt them.
**Treat backups as sensitive.** Restore the matching key with the database;
a missing or mismatched key disables integration access.

Original photo folders, Immich libraries, and upstream calendars are not included.
Back those up separately.

### Restore

1. Stop screensvr.
2. Restore the complete backed-up data directory into its configured storage.
3. Ensure the runtime user can read and write it, normally UID 1000 in Docker.
4. Start the matching application version and check displays and integrations.

Test restoration before relying on a backup.

## Administrator password recovery

If you lose the password, stop screensvr and make a verified backup first.
Use the SQLite CLI to open the actual data directory's `screensvr.sqlite`,
then run:

```sql
BEGIN;
DELETE FROM sessions;
DELETE FROM meta WHERE key = 'password';
COMMIT;
```

Restart on a trusted/private network and immediately complete first-run setup.
This preserves displays, scenes, installed faces, and permanent URLs.
Never edit a running database or one being upgraded.

## Monitoring and failure recovery

- `/api/health` reports process readiness, not tablet power or integration health.
  Display status and last-seen times indicate browser connections.
- Loaded faces can keep running during a server/network outage. Reloading,
  offline startup, and offline scene transitions are not supported.
- A broken face shows a retry overlay. Retry it or switch to a bundled face.
- One installed version per face ID is supported. See
  [replacing a face](user-guide.md#manage-the-face-library).
- Integrations must be reachable from the server/container, not just the
  administrator's browser. `localhost` inside Docker means the container.
- A crash during face installation can leave `.staging-*` or an unreferenced
  reserved directory under `/data/faces`. They are not served. Stop screensvr
  and verify database references before removing only known orphan directories.
  Never remove a referenced face directory.

See [everyday troubleshooting](user-guide.md#everyday-troubleshooting) and
[integration setup and recovery](integrations.md). Registry downloads, automatic
face updates, multi-user roles, and native kiosk control are not supported.
