# Integrations

Connect photos, sensors, weather, and calendars to your faces. Connections run
**on the screensvr server**: faces receive only the selected, normalized data,
never your credentials. The face decides how that data looks.

## Choose a connection

| Connection                                      | Use it for                                         | Requirements                                                      |
| ----------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| [Home Assistant](#home-assistant)               | Sensors, current weather, forecasts, calendars     | Home Assistant 2024.1 or newer and a long-lived access token.     |
| [Immich](#immich)                               | A photo album owned by or shared with your account | Immich 3.4.1 or later in 3.x and a read-only API key.             |
| [Mounted photo folders](#mounted-photo-folders) | A local/NAS slideshow or individual photo          | A directory already mounted on the server, readable by screensvr. |
| [iCalendar feeds](#calendars)                   | The next appointment from a calendar subscription  | A direct read-only `.ics` subscription URL.                       |

The usual workflow is:

1. Open **Integrations → Add integration** and choose the connection type.
2. Enter its settings, choose **Test connection**, then **Save integration**.
3. Open a display or scene with a compatible face.
4. Choose the source under **Data sources**, preview it, and save.

**Check what you publish.** Anyone who can reach a display link can read its
selected data. Photos expose the whole selected collection; calendar titles
require a separate opt-in. Read [Privacy and credentials](#privacy-and-credentials)
before connecting sensitive sources.

## Scenes and saved selections

Each scene keeps its own data-source selections. Switching scenes restores
those selections without clearing or copying another scene's bindings. Trying a
source changes only the editor preview; saving an inactive scene does not
activate it.

Only active scenes create live subscriptions. Previews use bounded one-shot
reads. Inactive scenes do not poll, but their saved selections still:

- Prevent deletion of referenced integrations.
- Count toward the 256-selected-source limit per connection.
- Need to be unbound if you want to remove that connection.

Inactive scene configuration is administrator-only. Photo URLs are revoked when
their scene stops being active. Changing a scene's face clears that scene's
bindings; switching saved scenes does not.

## Home Assistant

Use Home Assistant **2024.1 or newer**. The connector reads:

- Numeric `sensor` states, including temperature and humidity.
- `binary_sensor` on/off states as booleans.
- Short text `sensor` states, up to 200 characters.
- `weather` entities with current conditions and supported daily/hourly forecasts.
- `calendar` entities through read-only event-range queries.

There are no writes, service calls, templates, arbitrary attribute paths, or
history reads. Units come from Home Assistant; screensvr does not convert them.

### Connect

1. In Home Assistant, open your profile's **Security** section and create a
   long-lived access token. Prefer a dedicated, least-privilege account.
2. In screensvr, choose **Integrations → Add integration → Home Assistant**.
3. Enter a connection name, the base URL, such as
   `http://homeassistant.local:8123`, and the token.
4. Choose **Test connection**, then **Save integration**.

The URL must be reachable from the screensvr server/container. `localhost`
inside Docker means the container, not your Home Assistant host.
See [network requirements](#network-requirements).

### Choose a sensor

1. Choose **Slow Hours**, **Stillroom**, or another face with compatible inputs
   for a display or scene.
2. Under **Data sources → Room temperature**, choose your integration.
3. Search for a compatible sensor by friendly name or entity ID.
4. Check the preview and save.

Temperature sensors need the temperature device class and °C, °F, or K units.
Humidity sensors need the humidity device class and % units. Generic numeric
inputs accept compatible numeric states with their source-provided units.
Another scene or display can use the same face with a different sensor.

Slow Hours hides unbound, unavailable, or stale temperature data. Stillroom
shows a quiet placeholder when missing and labels retained stale readings.
Neither invents a temperature before you select a source.

### Weather

1. Choose **Weather Hours** for a display or scene.
2. Under **Data sources → Current weather**, choose your Home Assistant
   integration and a weather entity, such as `weather.home`.
3. Optionally select **Daily forecast** and/or **Hourly forecast**. Each is an
   independent source; the lists show only entities with that capability.
   Usually all three inputs use the same entity.
4. Set **Forecast view** to **Next three days**, **Next six hours**, or **Hidden**,
   preview, and save.

Missing forecasts do not hide valid current weather. Weather Hours shows up to
three daily or six hourly entries, without synthesizing daily highs/lows from
hourly readings. Twice-daily forecasts are not supported.

Fresh current conditions drive subtle rain, snow, clouds, fog, wind, and
clear-sky treatments—not forecast entries. Thunderstorms do not flash. Unknown,
missing, or stale conditions use a neutral background. Disable **Weather
animation** for a static presentation; reduced-motion preferences are respected.

Forecasts use the display timezone. Daily entries include today; repeated
daylight-saving hours have distinguishable hourly labels. Old entries disappear
on local clock/day rollover even without a new server update.

### Freshness and recovery

- Sensor/current-weather readings have a normal 90-second connectivity lease.
  A steady sensor remains fresh while its stream is healthy; it does not need
  to change value.
- A disconnected tablet locally expires readings, including after sleep.
  Retained values become stale; `unknown`, `unavailable`, or removed sources
  become unavailable instead of zero.
- Forecasts are re-confirmed every 15 minutes and have a one-hour maximum
  response age. Connection pings cannot extend that age. Empty/unavailable
  forecasts clear retained values; transient failures can retain stale data.
- Home Assistant does not supply a forecast issuance timestamp. Confirmation
  means Home Assistant returned the forecast, not that screensvr verified its
  upstream weather provider.
- Current weather and each forecast period have independent availability.
  Forecast failures do not disconnect working sensors.
- Network interruptions reconnect automatically and require a fresh selected
  snapshot before readings become ready again.

The connector uses filtered `subscribe_entities` WebSocket subscriptions.
Forecasts use `weather/subscribe_forecast`, not the `weather.get_forecasts`
service/action or deprecated entity forecast attributes. Subscriptions are
shared across active scenes and overlapping previews. Removing the last
consumer stops refreshes and drops the cached data. Weather previews refresh
every 30 seconds; ordinary sensor previews use five seconds.

For calendar selection and its separate refresh behavior, see [Calendars](#calendars).

## Immich

Use an album owned by or shared with an [Immich](https://immich.app/) account.
Supports **Immich 3.4.1 and later 3.x releases**. Other major versions, including
2.x, are not supported.

### Connect and select an album

1. In Immich user settings, create an API key with **`album.read`**,
   **`asset.read`**, and **`asset.view`**. Do not grant writes or original-download
   access. Prefer a dedicated account shared only into intended albums.
2. In screensvr, choose **Integrations → Add integration → Immich**.
3. Enter a name, instance URL, such as `http://immich.local:2283`, and the API key.
   A trailing `/api` is accepted.
4. Choose **Test connection**, then **Save integration**.
5. Choose **Photo Hours** or another photo-capable face. Under **Data sources →
   Photos**, choose the integration and an album.
6. Preview and save.

The URL must be reachable from the server/container. Album discovery does not
browse the entire photo library. Each photo input selects one album; merging
albums, favorites, full-library selection, public shared-link authentication,
and videos are not supported.

### Images and privacy

- screensvr uses **generated previews**, not original downloads. HEIC/RAW photos
  can work if Immich generated a JPEG, PNG, or WebP preview. Missing, unsupported,
  or redirecting previews are unavailable.
- Images are orientation-corrected, resized without upscaling, and served as
  metadata-free JPEG. Resolution depends on Immich's generated preview settings.
  Live photos use the still image; animation/video playback is not supported.
- Videos, trashed, offline, hidden, and locked assets are excluded. Archived
  images explicitly included in the album can be shown.
- **The entire selected album is display content**, not just the current photo.
  Temporary preview URLs also grant access to the previewed album. Do not share them.
- Upstream asset access and album membership are checked on every image request,
  even on resized-cache hits. Unbinding, disabling, editing the connection, or
  changing active scenes revokes the relevant saved-display URLs.
- The face receives no Immich addresses, album/asset IDs, original paths, EXIF
  data, or API keys. Album selection limits what screensvr publishes, not what
  the API key itself can access.

### Refresh and limits

Selected albums refresh approximately every 30 seconds. Empty, removed, or
inaccessible albums become unavailable without stopping other albums. Network
failures retry automatically. Credential rejection or missing permissions stops
retries; replace the key or test the saved connection to retry.

Indexing is limited to 10,000 photo references across cached album selections
per connection, and 16 MiB of metadata/20 pages per album. Over-limit selections
report an error rather than silently truncating. Choose smaller/fewer albums;
unused preview indexes expire after ten minutes.

Images share the mounted-photo cache and size limits below. Photo Hours can keep
its last loaded image during failures, but this is not an offline library or
guaranteed offline startup. Back up your Immich library separately.

## Mounted photo folders

Use a local directory or a NAS share **already mounted on the server**.
screensvr does not mount SMB/NFS shares or manage NAS credentials.

### Mount and connect

Add a read-only bind mount to the screensvr service in your Compose file:

```yaml
volumes:
  - screensvr-data:/data
  - /mnt/nas/photos/screensvr:/photos:ro
```

Recreate the service after adding the mount with `docker compose up -d`.
The unprivileged `node` user, normally UID 1000, needs read access to files and
search access to directories. For Node.js, set
`SCREENSVR_PHOTOS_DIR=/your/photo/directory`; the default is `/photos`.

1. Choose **Integrations → Add integration → Mounted photo folders**.
2. Give it a name and optionally enter a relative folder, such as `family` or
   `family/holidays`. Leave it blank to use the configured root. Do not enter
   a host path, NAS address, or `/photos` here.
3. Choose **Test connection**, then **Save integration**.
4. Choose **Photo Hours** for a display or scene.
5. Under **Data sources → Photos**, choose the integration and a folder or file.
6. Preview and save.

A folder includes its subfolders. Choosing one file keeps that image on screen.
Photo Hours offers sequential/shuffled playback, an adjustable interval, fill/fit,
and an optional clock.

### Formats, refresh, and limits

- JPEG, PNG, and WebP are supported. Images are orientation-corrected and served
  as resized JPEG without original EXIF metadata. Transparency is flattened.
  HEIC, RAW, SVG, video, and animated playback are not supported.
- Hidden entries and symlinks inside the photo root are excluded. Only selected
  files below that root are read; source files are never modified.
- Selected collections rescan approximately every 30 seconds. Folder scans allow
  up to 10,000 entries and 16 nested levels; choose a smaller folder if exceeded.
- Files over 50 MiB, images above 40 megapixels, and corrupt/unsupported images
  are not served. Variants are capped at 2560 pixels per dimension without upscaling.
- The shared in-memory resized cache is limited to 32 MiB and 128 variants.
  The source library is not copied into the data volume.
- Missing mounts or permission errors retry automatically. A loaded photo can
  remain visible during failures, but offline startup is not guaranteed.

Photo URLs are temporary capabilities scoped to the selected collection and a
saved display or administrator preview. Access is rechecked on every request.
Unbinding, editing/disabling the integration, deleting a display, or changing
active scenes revokes the relevant saved-display URLs.

**The whole selected collection is public display content.** Mount only intended
directories, read-only, and protect display access at the network/proxy level.
Back up original photos separately from screensvr.

## Calendars

**Calendar Hours** shows one appointment, not an agenda. Its **Next appointment**
input can merge up to eight selected calendars, mixing iCalendar feeds and Home
Assistant calendars. Each scene saves its own selections and title-sharing choices.

### iCalendar subscription feeds

1. Get a direct read-only `.ics` subscription URL from your calendar service.
   A calendar web page or share page is not a subscription feed.
2. Choose **Integrations → Add integration → iCalendar feed**.
3. Enter a name, **Subscription URL**, and **Calendar timezone**, such as
   `Europe/Helsinki`. This timezone resolves floating event times; explicit
   event timezones take precedence.
4. Choose **Test connection**, then **Save integration**.
5. Choose **Calendar Hours** for a display or scene. Under **Data sources → Next
   appointment → Add calendar**, choose the integration and its calendar.
6. Add other calendars if wanted, preview, and save.

Each integration is one feed. **Its entire subscription URL is a credential**,
including the path and query. It is encrypted and hidden after saving; leaving
it blank while editing retains it. Never paste live URLs into screenshots,
issues, or logs. Rotate an exposed URL at your calendar provider.

Direct HTTP(S) feeds are supported; `webcal://` becomes HTTPS. Redirects, embedded
URL passwords, compressed responses, and external attachments/timezone downloads
are not followed or loaded. Obtain the final direct feed URL when a provider
redirects. CalDAV, OAuth, custom authentication headers, and uploaded calendar
files are not supported.

### Home Assistant calendars

Reuse a Home Assistant connection; no second token is needed. Under **Add
calendar**, choose that integration and a `calendar.*` entity.

Discovery uses `GET /api/calendars`; selected events use
`GET /api/calendars/<entity_id>?start=…&end=…`. These are read-only endpoints
available in Home Assistant 2024.1 and newer. The upstream calendar integration
must support event-range reads. Home Assistant expands its own recurring events;
screensvr does not rely on single-event state attributes.

Only selected calendars receive event requests. Calendar endpoint failures do
not stop working sensors or weather.

### Privacy and event selection

- **Busy-only is the default.** Timing is published, but no title.
  **Publish event titles** is an explicit per-calendar opt-in.
- Descriptions, locations, attendees, meeting links, upstream identifiers,
  calendar names, and subscription URLs never enter display data.
- iCalendar `PRIVATE`/`CONFIDENTIAL` classifications keep titles redacted even
  with title sharing enabled. **Home Assistant's event API does not expose those
  flags:** keep sensitive calendars busy-only.
- Redaction happens server-side, before public state/event responses. Hiding
  content with a face setting is not an access control.
- The earliest relevant display-local day wins. Ongoing timed appointments take
  priority on that day, then future timed appointments, then all-day events.
  Ongoing events remain until their exclusive end. Overlaps do not rotate.
- All-day events keep their calendar dates and exclusive end dates; multi-day
  events remain eligible on each included day. Timed events use the display timezone.
- The lookahead is 30 days. Only confirmed-empty selections show **No appointments
  in the next 30 days**. Partial failures retain results as stale, not as an
  assurance that the calendar is empty.

iCalendar recurrence supports RRULE, RDATE, EXDATE, moved instances, cancellations,
and DST-aware expansion. Transparent events are excluded. Unresolvable timezones,
`RANGE=THISANDFUTURE` overrides, and RDATE periods make a source unavailable rather
than being guessed.

### Refresh and recovery

Selected event windows refresh approximately every five minutes. iCalendar uses
ETag/Last-Modified conditional requests when available and re-expands cached feed
text for the moving window, even after a valid 304.

Successful reads/304 confirmations have a 15-minute maximum age, in addition to
the ordinary 90-second display lease. Heartbeats cannot renew that response age.
The server updates at event boundaries and local minute/midnight rollover.
Calendar Hours hides an ended event locally after sleep or disconnection, but
cannot show the next unpublished appointment until it reconnects.

Inactive scenes do not poll. Releasing the last consumer drops events/feed text
from memory. Changed bindings or connections cannot be repopulated by old
in-flight reads. HTTP 401 clears retained data and stops retries until credentials
are replaced or the saved connection is tested. Other failures retry automatically;
revoked or missing sources clear cached events.

Reads use four-way concurrency, ten-second HTTP timeouts, and a 5 MiB response
limit. iCalendar parsing uses terminable five-second workers with 64 MiB
old-generation heap limits. Feeds are limited to 20,000 components and 10,000
expanded occurrences/recurrence periods; the shared cache holds at most 50,000
events. Over-limit sources become unavailable/stale instead of truncating.
Published titles have at most 200 characters. Events and feed text stay in memory,
not a persisted agenda or offline calendar.

## Privacy and credentials

Display URLs and their read-only state/event APIs require no login. Anyone able
to reach the server can read selected values, including hidden inputs, selected
photo collections, and published appointments. Use a trusted LAN, VPN, or
reverse-proxy access controls. Revocation cannot erase content already received
by viewers or disconnected displays.

Credentials are encrypted in `screensvr.sqlite`. The restricted `integration-key`
beside it is needed for decryption. This protects against database-only disclosure,
not process compromise or access to the whole data volume. Back up and restore
the [complete data directory](deployment.md#backups); backups remain sensitive.

- Saved tokens/keys are never returned to the management browser. A blank
  credential field while editing keeps the saved value.
- Read-only connectors do not reduce an upstream token's permissions. Use
  least-privilege accounts and revoke exposed credentials at the provider.
- Disabling a connection stops its data without deleting bindings.
- Before deleting a connection, remove/reassign its sources in **every scene**,
  including inactive scenes.
- Rejected credentials stop automatic retries. Replace them or test the saved
  connection to retry.

If the integration key is missing, invalid, or mismatched, restore the matching
key and restart. Clocks can continue working. screensvr does not silently create
a replacement key while saved integrations exist. If recovery is impossible,
unbind/delete all saved integrations, stop screensvr, preserve the broken data,
remove only the known unusable `integration-key` if present, then restart and
configure new connections.

## Network requirements

Remote services must be reachable from the server/container, not only your
browser. Use LAN hostnames/IPs or container-network addresses as appropriate.
Prefer HTTPS: HTTP exposes credentials and content to network observers.

TLS certificates are verified; redirects and embedded URL credentials are
rejected. Private/loopback addresses are supported, while link-local,
metadata-service, unspecified, and multicast destinations are blocked.
Connection-time DNS checks apply to remote integrations.

## Limits and face development

Up to 10 connections, 256 selected sources per connection, and 16 inputs per
face are supported. Discovery is bounded to 10,000 entities/16 MiB. Tests,
discovery, and previews are rate-limited and have timeouts; high-rate readings
are coalesced. Readings are kept in memory, not a history database.

Current weather and each forecast period count as separate sources. Forecast
initial reads are limited to four concurrent operations per connection.
Normalized forecasts contain at most seven daily or 24 hourly entries.

Face authors should use [provider-independent inputs](faces.md#data-inputs) and
the [SDK data contract](faces.md#data-status-and-freshness). See
[Room Climate](../examples/room-climate/) for an example.
For fake-server tests and real-service/device verification, see
[Development](development.md#integration-and-device-testing).
