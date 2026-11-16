# screensvr — v0.1 architecture

screensvr is one Node.js 24 process serving a React management application, a
display shell, REST APIs, SSE streams, and local face assets. SQLite and the face
directory share one persistent data volume. No cloud service is required.

## Implementation

| Location                  | Responsibility                                                |
| ------------------------- | ------------------------------------------------------------- |
| `src/server/app.ts`       | Fastify routes, access control, HTTP security, static hosting |
| `src/server/db.ts`        | SQLite schema and queries                                     |
| `src/server/faces.ts`     | Bundled faces and bounded ZIP installation                    |
| `src/server/auth.ts`      | Password hashing and administrator sessions                   |
| `src/server/events.ts`    | Display connections, heartbeats, notifications                |
| `src/shared/contracts.ts` | Versioned manifests and configuration validation              |
| `web/src/App.tsx`         | Administrator setup, display management, face library         |
| `web/src/Display.tsx`     | Pairing, reconnects, fullscreen, wake-lock requests           |
| `web/src/FaceFrame.tsx`   | Shared preview/display renderer and message bridge            |
| `public/face-sdk.js`      | Framework-independent browser SDK                             |
| `faces/`                  | Two immutable bundled faces                                   |

Vite builds the frontend; TypeScript compiles the server. Management is loaded
separately from the display client so displays do not download the management UI
and manifest-validation code.

## Data model

- **Faces:** one installed version per unique face ID, a validated manifest, and
  a bundled/installed flag.
- **Devices:** UUID, friendly name, face assignment, validated settings, IANA
  timezone, configuration revision, pairing-token hash, and last-seen timestamp.
- **Administrator:** one salted scrypt password hash.
- **Sessions:** hashed random session tokens, CSRF tokens, and expiry.

Foreign keys prevent deleting assigned faces. Updates use an expected revision
to reject stale edits. SQLite uses WAL mode, foreign keys, and versioned
transactional schema initialization (`PRAGMA user_version`).

The data directory contains `screensvr.sqlite` (plus SQLite WAL files) and
`faces/<id>/<version>/content/`. Bundled assets ship with the application.

## Authentication and pairing

The first-run setup creates the sole administrator. Administrator sessions use
HttpOnly, SameSite=Strict cookies and expire after seven days. Mutations require
a session CSRF token, and browser-origin checks reject cross-origin mutations.
Setup, login, and pairing are rate-limited. HTTPS and secure cookies are
recommended beyond a trusted LAN.

Management generates a link like:

```text
http://screensvr.local:3000/display/<uuid>#<secret>
```

The browser exchanges the fragment secret for an HttpOnly cookie scoped to that
device's API path, then removes the fragment. Fragments are not sent in HTTP
requests or referrers. Only a hash of the pairing secret is stored in SQLite.
The cookie grants read-only device access, not administrator access. Generating
a new link revokes previous links/cookies and disconnects existing streams.

Friendly display names are labels, not identifiers or credentials.

## Synchronization and recovery

Each device connects to its own SSE endpoint using the scoped cookie. Every
connection receives a complete current snapshot; subsequent committed changes
publish a new snapshot. Intermediate events do not need replaying.

The shell keeps the current face running during disconnection. EventSource
reconnects automatically and receives the latest state, including changes made
while the device was asleep. Visibility changes also trigger resynchronization.
Heartbeats keep proxy connections active and update last-seen timestamps.
Connections are bounded to ten per device and one hundred per server.

There is no service worker or guaranteed offline cold start in v0.1.

## Face boundary

Faces render in `sandbox="allow-scripts"` iframes, without `allow-same-origin`.
An HTTP sandbox CSP also protects face documents opened directly. Face CSP
blocks fetch/WebSocket access, nested frames, forms, workers, and external
origins. Public face assets allow anonymous CORS for ES modules and fonts from
the sandbox's opaque origin; API responses do not.

The shell transfers a MessagePort to the iframe. The SDK passes only validated
settings and non-secret display context. No session token, pairing credential,
Home Assistant secret, or internal React API crosses this boundary.

Preview and display use the same renderer and protocol.

**Only trusted packages are supported.** Browser sandboxing cannot prevent every
resource-exhaustion attack, browser vulnerability, or misleading visual design.

## ZIP installation

Packages must put `manifest.json` and `index.html` at the ZIP root. Installation
validates schema/protocol compatibility, settings defaults, file paths and types,
checksums, entry counts, upload size, and expanded sizes. Symlinks, encrypted
entries, duplicate paths, traversal, and unsupported compression are rejected.

Extraction happens in a unique staging directory. A reserved destination and
rename prevent partial content from becoming available through the asset API;
the database record is created only after extraction succeeds. Failed staging
content is cleaned up. A process crash may leave an unreferenced staging or
reserved directory; these are never served, and are not automatically deleted.

Installed versions are immutable. In v0.1, switch displays away, remove the old
face, then install its replacement. Bundled faces cannot be removed.

## Deliberately deferred

Home Assistant, scheduling, registries, automatic updates and settings
migrations, multi-user roles, native kiosk control, and offline startup are not
implemented. Future integrations should remain server-side and expose only
authorized data through a versioned face protocol.
