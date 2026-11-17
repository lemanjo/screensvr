# screensvr architecture

screensvr is one Node.js 24 process serving a React management application, a
display shell, REST APIs, SSE streams, and local face assets. SQLite and the face
directory share one persistent data volume. No cloud service is required.

## Implementation

| Location                        | Responsibility                                                  |
| ------------------------------- | --------------------------------------------------------------- |
| `src/server/app.ts`             | Fastify routes, access control, HTTP security, static hosting   |
| `src/server/db.ts`              | SQLite schema and queries                                       |
| `src/server/faces.ts`           | Bundled faces and bounded ZIP installation                      |
| `src/server/auth.ts`            | Password hashing and administrator sessions                     |
| `src/server/events.ts`          | Display connections, heartbeats, notifications                  |
| `src/server/integrations/`      | Built-in server-side connectors, management routes, live caches |
| `src/server/display-state.ts`   | Selected-data projection and ordered display snapshots          |
| `src/server/integration-key.ts` | Authenticated encryption and persistent integration key         |
| `src/server/photos.ts`          | Scoped photo capabilities and bounded resized-image cache       |
| `src/shared/contracts.ts`       | Versioned manifests and configuration validation                |
| `web/src/App.tsx`               | Administrator setup, display management, face library           |
| `web/src/Display.tsx`           | Permanent display addresses, reconnects, fullscreen, wake locks |
| `web/src/FaceFrame.tsx`         | Shared preview/display renderer and message bridge              |
| `public/face-sdk.js`            | Framework-independent browser SDK                               |
| `faces/`                        | Six immutable bundled faces                                     |

Vite builds the frontend; TypeScript compiles the server. Management is loaded
separately from the display client so displays do not download the management UI
and manifest-validation code.

## Data model

- **Faces:** one installed version per unique face ID, a validated manifest, and
  a bundled/installed flag.
- **Devices:** internal UUID, unique permanent URL slug, friendly name, face
  assignment, validated settings, IANA timezone, configuration revision, and
  last-seen timestamp.
- **Administrator:** one salted scrypt password hash.
- **Sessions:** hashed random session tokens, CSRF tokens, and expiry.
- **Integrations:** named provider connections, encrypted credentials, enabled
  state, and optimistic configuration revisions.
- **Input bindings:** explicit per-device input-to-source assignments, cascaded
  on device deletion and cleared on face changes. Referenced integrations cannot
  be deleted until unbound.

Foreign keys prevent deleting assigned faces. Updates use an expected revision
to reject stale edits. SQLite uses WAL mode, foreign keys, and versioned
transactional schema initialization (`PRAGMA user_version`).

The data directory contains `screensvr.sqlite` (plus SQLite WAL files) and
`faces/<id>/<version>/content/`, plus the restricted `integration-key` used for
credentials. Bundled assets ship with the application. Sensor values are cached
in memory, not persisted as history.

## Authentication and display addresses

The first-run setup creates the sole administrator. Administrator sessions use
HttpOnly, SameSite=Strict cookies and expire after seven days. Mutations require
a session CSRF token, and browser-origin checks reject cross-origin mutations.
Setup and login are rate-limited. HTTPS and secure cookies are
recommended beyond a trusted LAN.

Management assigns a permanent address based on the display's initial name:

```text
http://screensvr.local:3000/display/olohuone
```

The slug is lowercase, with accents simplified and word separators converted to
hyphens. Names with no usable letters or digits use `display`. Collisions get
deterministic suffixes (`olohuone-2`, `olohuone-3`). The slug is persisted and is
not changed by renaming the display, reading its link, or restarting the server.
Existing databases are migrated transactionally, retaining settings and assigning
slugs from existing names. Old UUID URLs redirect to the permanent addresses;
obsolete pairing fragments are discarded by the client.

Displays and their state/SSE endpoints are read-only and require no login,
pairing secret, or display cookie. Anyone who can reach the server can view a
display. Management APIs remain session- and CSRF-protected. Deploy on a trusted
network or enforce additional network/reverse-proxy access controls.

## Synchronization and recovery

Each device connects to its own SSE endpoint using its permanent slug. Every
connection receives a complete current snapshot; subsequent configuration and
selected-data changes publish a new snapshot. Intermediate events do not need
replaying. A process epoch and monotonic sequence order snapshots without
incrementing the device's configuration revision for every reading. HTTP refresh
results cannot overwrite a newer stream event.

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
The scoped photo endpoint separately permits anonymous CORS for image/canvas use;
it never accepts paths or exposes management APIs.

The shell transfers a MessagePort to the iframe. The SDK passes only validated
settings, non-secret display context, and explicitly selected normalized input
values. No entity IDs, raw attributes, integration addresses, session token,
Home Assistant secret, or internal React API crosses this boundary.

Preview and display use the same renderer and protocol.
Manifest v1/protocol v1 remain supported. Manifest v2 declares optional typed
inputs and requires data-capable protocol v2. The SDK locally expires ready
readings and notifies faces of stale status during network loss/sleep.
Manifest v3/protocol v3 adds image inputs. The host projects a collection count,
revision, and opaque scoped URL instead of copying the file list into snapshots.
SDK helpers select/rotate images locally; the face retains control of presentation.

## Integration boundary

One connector per enabled connection authenticates server-side. Home Assistant
uses filtered entity subscriptions, deduplicated across saved display bindings.
Discovery is administrator-only; draft previews use bounded one-shot filtered
reads without saving or modifying live displays. Only built-in connectors run
on the server; face ZIPs do not contain server scripts.

Connector health renews a bounded freshness lease without requiring sensor
values to change. Disconnections retain stale readings, while unavailable or
removed entities clear values. Reconnection requires a fresh selected snapshot.
Generation guards ignore replaced connections/subscriptions, and high-rate
updates are coalesced per affected display.

Credentials are encrypted with a key in the same persistent volume. This limits
database-only disclosure, not full-volume compromise. API DTOs/logging exclude
secrets. Display readings remain publicly readable to anyone reaching the server.

Mounted-folder connections scan only below the configured photo root. They skip
hidden entries and symlinks, use bounded scans, and periodically refresh selected
collections. Image access is granted per saved display binding or explicit draft
preview, expires after ten minutes, and is revalidated on every request.
Server-side image decoding corrects orientation, strips metadata, and produces
bounded JPEG variants cached in at most 32 MiB/128 entries of memory. Originals
remain outside the data volume and are never modified.

Photo connectors share a provider-neutral image-handle contract. Immich 3.4.1+
(3.x) lists albums for administrator discovery and indexes only selected albums
using public cursor-based metadata search. Selected collections refresh every
30 seconds; hidden/locked, offline, trashed, and video assets are excluded.
Generated previews pass through the same scoped endpoint, decoding, and cache
as mounted photos. Every image request checks upstream access and album
membership before consulting cached resized bytes. HTTP uses connection-time DNS
validation, verified TLS, no redirects, bounded concurrency/body sizes, and
timeouts. Only encrypted API keys and configured connections are persisted;
upstream metadata/indexes and previews remain bounded in memory.

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

Scheduling, registries, automatic updates and settings migrations, multi-user
roles, native kiosk control, and offline startup are not implemented. Additional
integrations should remain server-side and expose only selected data through the
versioned face protocol. Smart-home writes and arbitrary source transformations
are deliberately out of scope.
