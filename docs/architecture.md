# screensvr architecture

screensvr is one Node.js 24 process serving a React management application, a
display shell, REST APIs, SSE streams, and local face assets. SQLite and the face
directory share one persistent data volume. No cloud service is required.

## Implementation

| Location                               | Responsibility                                                  |
| -------------------------------------- | --------------------------------------------------------------- |
| `src/server/app.ts`                    | Fastify routes, access control, HTTP security, static hosting   |
| `src/server/db.ts`                     | SQLite schema and queries                                       |
| `src/server/faces.ts`                  | Bundled faces and bounded ZIP installation                      |
| `src/server/auth.ts`                   | Password hashing and administrator sessions                     |
| `src/server/events.ts`                 | Display connections, heartbeats, notifications                  |
| `src/server/integrations/`             | Built-in server-side connectors, management routes, live caches |
| `src/server/integrations/calendars.ts` | Private calendar occurrence cache, merging, privacy projection  |
| `src/server/display-state.ts`          | Selected-data projection and ordered display snapshots          |
| `src/server/scenes.ts`                 | Revision-checked scene and weekly schedule management           |
| `src/server/scheduler.ts`              | Timezone-aware scene resolution and transition notifications    |
| `src/server/integration-key.ts`        | Authenticated encryption and persistent integration key         |
| `src/server/photos.ts`                 | Scoped photo capabilities and bounded resized-image cache       |
| `src/shared/contracts.ts`              | Versioned manifests and configuration validation                |
| `web/src/App.tsx`                      | Administrator setup, display management, face library           |
| `web/src/Display.tsx`                  | Permanent display addresses, reconnects, fullscreen, wake locks |
| `web/src/FaceFrame.tsx`                | Shared preview/display renderer and message bridge              |
| `public/face-sdk.js`                   | Framework-independent browser SDK                               |
| `faces/`                               | Eight immutable bundled faces                                   |

Vite builds the frontend; TypeScript compiles the server. Management is loaded
separately from the display client so displays do not download the management UI
and manifest-validation code.

## Data model

- **Faces:** one installed version per unique face ID, a validated manifest, and
  a bundled/installed flag.
- **Devices:** internal UUID, unique permanent URL slug, friendly name, IANA
  timezone, manual scene selection, schedule enablement, configuration revision,
  and last-seen timestamp.
- **Scenes:** per-device named face configurations with validated settings and
  explicit data bindings. Inactive scenes remain saved without being rendered.
- **Schedule entries:** weekday (ISO Monday=1 through Sunday=7), local minute,
  and scene. Duplicate weekday/start-time pairs are rejected. Composite foreign
  keys keep selections and schedule references within their owning display.
- **Administrator:** one salted scrypt password hash.
- **Sessions:** hashed random session tokens, CSRF tokens, and expiry.
- **Integrations:** named provider connections, encrypted credentials, enabled
  state, and optimistic configuration revisions.
- **Input bindings:** explicit per-scene input-to-source assignments, cascaded
  on scene/device deletion. Changing a scene's face resets only that scene's
  bindings; activating a different scene never clears them. Referenced
  integrations and faces cannot be deleted while any saved scene uses them.
- **Calendar selections:** schema v5 adds separate per-scene/input source rows,
  with ordering and default-off title publication flags. Existing scalar/photo/
  weather binding rows are unchanged. Calendar integration references participate
  in deletion protection and saved-source limits, including inactive scenes.

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

### Scheduled scenes

Schema v4 migrates every existing display's face, settings, and bindings into a
Default scene, retaining the configuration revision and permanent URL. Scheduling
starts disabled. Devices can save at most 32 scenes and 64 grouped schedule
entries (each selecting one or more weekdays).

The server resolves weekly local-time entries into actual instants using Temporal.
The latest occurrence selects the current scene; no end times or daily resets are
needed. Spring-forward skipped entries apply at the jump, ordered by their nominal
local starts; repeated-hour entries use their first occurrence only. Calendar-day
arithmetic avoids assuming every day is 24 hours long.

A next-transition timer with a 30-second maximum sleep handles clock changes.
Startup, state reads, schedule edits, and timezone changes also reconcile the
current selection. Missed transitions are not replayed. Scheduling does not write
configuration revisions, so automatic transitions do not invalidate open editors.
Scene/schedule mutations share the device's expected-revision guard and commit
transactionally, with a second check after asynchronous binding validation.

While scheduling is enabled, manual activation is rejected server-side. Disabling
it saves the current effective scene as the manual selection. There are no timed
overrides. Offline displays keep their current face until reconnection.

Each activation has a separate in-memory generation. Saved photo grants include
the selected scene and this generation, and revalidate them on every request and
after asynchronous image work. A transition revokes old grants even when the
configuration revision is unchanged, including A → B → A transitions.

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
Manifest v4/protocol v4 adds structured current-weather and daily/hourly forecast
inputs, independently selected and independently fresh. Earlier manifest schemas
remain unchanged. The host validates and projects nested weather fields rather
than forwarding arbitrary provider objects; the dependency-free display bundle
does not import server schemas or provider code.
Manifest v5/protocol v5 adds a structured calendar input containing one selected
appointment or a confirmed-empty result. Busy-only/title redaction is performed
before public snapshots, not by browser presentation.

## Integration boundary

One connector per enabled connection authenticates server-side. Home Assistant
uses filtered entity subscriptions, deduplicated across active scene bindings.
Inactive bindings still count toward saved-source limits and deletion protection,
but do not cause background subscriptions.
Discovery is administrator-only; draft previews use bounded one-shot filtered
reads without saving or modifying live displays. Only built-in connectors run
on the server; face ZIPs do not contain server scripts.

Connector health renews a bounded freshness lease without requiring sensor
values to change. Disconnections retain stale readings, while unavailable or
removed entities clear values. Reconnection requires a fresh selected snapshot.
Generation guards ignore replaced connections/subscriptions, and high-rate
updates are coalesced per affected display.

Weather states use the same filtered entity stream, retaining only selected
temperature/unit/capability metadata. Forecasts use separate read-only
`weather/subscribe_forecast` subscriptions, never service calls or deprecated
forecast attributes. Subscriptions are reference-counted across live bindings
and overlapping previews, with four concurrent initial forecast reads. Last
consumer removal cancels work, drops cached values, and stops refreshes.
Daily/hourly errors remain source-local and do not disconnect working sensors.

Forecasts are re-confirmed every 15 minutes. Each successful payload has a
one-hour maximum confirmation age in addition to the 90-second transport lease;
heartbeat renewal cannot bypass that ceiling or invent a newer observation
timestamp. Missing/empty forecasts clear values, transient read failures retain
stale values, and reconnection requires a new forecast response. Home Assistant
does not supply forecast issuance time, so it remains unknown. Normalized
forecasts retain at most seven daily or 24 hourly entries in memory.

Credentials are encrypted with a key in the same persistent volume. This limits
database-only disclosure, not full-volume compromise. API DTOs/logging exclude
secrets. Display readings remain publicly readable to anyone reaching the server.

Calendar sources use a separate provider-independent occurrence cache, never
public `FaceData` event arrays. Home Assistant calendars reuse the saved token
with GET-only discovery and bounded date-range REST reads, independently of its
sensor/weather stream. Each iCalendar integration stores its entire bearer URL
in encrypted credentials; the non-secret configuration stores its fallback
timezone, not a plaintext subscription address.

Only active calendar bindings and bounded previews acquire source consumers.
Four concurrent window reads refresh approximately every five minutes, sharing
results between consumers. Feed parsing/recurrence expansion runs in bounded,
terminable workers using a pinned `node-ical` parser; the downloader remains
under screensvr's DNS/TLS/redirect/size/timeout policy. Raw events and feed text
are memory-only. The last consumer releases them and cancels pending work.
Connection revisions and abort signals prevent replaced reads from being accepted.

Projection uses each display's timezone, keeps ongoing events until their end,
and prefers timed events on the earliest relevant local day. Only event timing
and explicitly opted-in titles cross the boundary. Private classifications
remain redacted when available; HA's event API does not supply them. Partial
failures cannot produce a confirmed-empty result. Confirmation age is capped
at 15 minutes independently of the 90-second display transport lease. Boundary
timers handle event starts/ends and minute rollover, with a 30-second maximum
sleep to detect wall-clock changes. The face independently hides ended events
while disconnected but cannot reveal the next unpublished event.

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

Installed versions are immutable. Reassign or delete every scene using an old
face before removing it and installing its replacement. Bundled faces cannot be removed.

## Deliberately deferred

Shared scenes, scheduled overrides, solar/event-based scheduling, registries,
automatic updates and settings migrations, multi-user
roles, native kiosk control, and offline startup are not implemented. Additional
integrations should remain server-side and expose only selected data through the
versioned face protocol. Smart-home writes and arbitrary source transformations
are deliberately out of scope.
