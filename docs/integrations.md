# Integrations

Integrations connect services to screensvr **on the server**. A face declares
the kinds of data it can display; you choose a source separately for each display.
The face controls where the reading or photo appears and how it looks.

## Immich

Use photos from an album owned by or shared with an
[Immich](https://immich.app/) account. Supports **Immich 3.4.1 and later 3.x
releases**; 2.x and other major versions are not supported. The connector uses
the public album and cursor-based metadata-search APIs, not internal timeline APIs.

### Connect and select an album

1. In Immich user settings, create an API key with **`album.read`**,
   **`asset.read`**, and **`asset.view`** permissions. Do not grant writes or
   original-download access. Prefer a dedicated account shared only into the
   albums you intend to display.
2. In screensvr, open **Integrations → Add integration → Immich**.
3. Enter a connection name, the Immich instance URL (for example,
   `http://immich.local:2283`), and the API key. A trailing `/api` is also accepted.
4. Choose **Test connection**, then **Save integration**.
5. Choose **Photo Hours** or another photo-capable face in a display's settings.
   Under **Data sources → Photos**, choose the connection and an album.
6. Check the preview, then **Save changes**. Previewing never changes the live display.

The URL must be reachable from the screensvr server/container. `localhost`
inside Docker means that container, not your Immich host. Prefer HTTPS; HTTP
exposes the API key and photos to network observers. TLS certificates are
verified and redirects are rejected. LAN/loopback addresses are supported;
link-local, metadata-service, unspecified, and multicast addresses are blocked.

Album discovery does not browse the entire photo library. Each photo input
chooses one album; multiple-album merging, favorites, the full library, public
shared-link authentication, and videos are not supported.

### Images, refresh, and privacy

- The server requests **generated previews**, not original files. HEIC/RAW
  originals can work if Immich has generated a JPEG, PNG, or WebP preview.
  Missing, unsupported, or redirecting previews are unavailable. Photos are
  orientation-corrected, resized without upscaling, and served as metadata-free
  JPEG. Preview resolution is limited by Immich's generated preview settings.
  Live photos use their still image; animation/video playback is not supported.
- Videos, trashed, offline, hidden, and locked assets are excluded. Archived
  images explicitly included in the selected album can be displayed.
- Only selected albums are indexed. Membership and image revisions refresh
  approximately every 30 seconds, without changing display settings. Empty,
  removed, or inaccessible albums become unavailable; other albums keep working.
- Indexing is capped at **10,000 photo references across the connection's cached
  album selections**, 16 MiB of metadata/20 pages per album, and bounded HTTP
  concurrency/timeouts. Over-limit selections report an error instead of being
  silently truncated. Choose fewer/smaller albums; unused preview indexes expire
  after ten minutes. Resized images use the same 32 MiB/128-entry memory cache as
  mounted photos; previews over 50 MiB or 40 megapixels are not served.
- Every image request rechecks upstream asset access and selected-album
  membership, including resized-cache hits. Unbinding, disabling, or editing a
  connection revokes existing scoped URLs. Credential rejection or missing key
  permissions stops automatic retries; replace the key or test the saved
  connection to retry.
- Network failures reconnect automatically. Photo Hours keeps its last loaded
  image while new loads are unavailable; its clock keeps running. This is not
  an offline photo library or guaranteed offline cold start.
- **The entire selected album is display content:** anyone who can reach the
  display URL can access its selected images, not just the current photograph.
  Preview URLs also temporarily grant access to the previewed album. Use a
  trusted LAN, VPN, or reverse-proxy access control; never share preview links.
- The API key is encrypted server-side and never returned to the browser.
  Leaving the key blank when editing keeps the saved key. Immich addresses,
  album/asset IDs, original paths, EXIF data, and credentials never enter face
  data. Selecting an album limits what screensvr publishes, **not the key's
  upstream access**; revoke an exposed key in Immich.

Back up the whole screensvr data directory to retain encrypted connections and
their encryption key. Back up your Immich library separately.

## Mounted photo folders

Connect a local directory or a NAS share already mounted on the server.
screensvr does not mount SMB/NFS shares or manage NAS credentials.

### Mount and connect

Add a read-only bind mount to the screensvr service in your Compose file:

```yaml
volumes:
  - screensvr-data:/data
  - /mnt/nas/photos/screensvr:/photos:ro
```

For example, `/photos/family/` and `/photos/artwork/` become selectable folders.
The container's unprivileged `node` user (UID 1000) needs read access to files and
search access to directories. For Node.js deployments, set
`SCREENSVR_PHOTOS_DIR=/your/photo/directory`; the default is `/photos`.

1. Open **Integrations → Add integration**.
2. Choose **Mounted photo folders** and give the connection a name.
3. Optionally enter a relative folder such as `family` or `family/holidays`.
   Leave it blank to use the whole configured photo directory. Do not enter a
   host path, NAS address, or `/photos` here.
4. Choose **Test connection**, then **Save integration**.
5. Choose **Photo Hours** in a display's settings.
6. Under **Data sources → Photos**, choose the connection and a folder or file.
   Preview your selection, then **Save changes**.

A folder includes its subfolders. Selecting an individual file keeps that image
on screen instead of rotating through its neighbors. Photo Hours supports
sequential or shuffled playback, an adjustable interval, fill/fit, and an
optional clock. Other photo-capable faces choose their own layout.

JPEG, PNG, and WebP are supported. Images are orientation-corrected, resized for
the display, and served as JPEG without original EXIF metadata. HEIC, RAW, SVG,
video, and animated playback are not supported. Transparent images are flattened.
Hidden entries and symbolic links inside the photo root are excluded.

### Refresh, limits, and privacy

- Collections are rescanned approximately every 30 seconds while connected.
  Changes to the selected folder/file update displays without changing their
  settings. Folder scans include at most 10,000 entries and 16 nested levels;
  choose a smaller folder if the scan limit is reached.
- Files larger than 50 MiB and images above 40 megapixels are not served.
  Corrupt/unsupported images produce an unavailable-image response.
- Images are resized into bounded variants, up to 2560 pixels per dimension
  without upscaling. The server keeps a shared in-memory cache capped at 32 MiB
  and 128 variants; it does not copy the library into the data volume.
- Missing mounts or permission errors reconnect automatically. Photo Hours
  keeps its last loaded image during temporary failures; clocks keep running.
  This is not an offline photo library or a guaranteed offline cold start.
- Folder/file discovery requires administrator access. Image URLs are
  short-lived capabilities limited to the selected collection and display or
  administrator preview. They are rechecked on every request, including cache
  hits. Unbinding, changing integration settings, disabling the connection,
  or deleting the display revokes existing saved-display URLs.
- **Selected photos are display content:** anyone who can reach a display URL
  can access its selected photo collection, not just the currently visible
  image. Preview links also grant temporary access to the previewed selection;
  do not share them. Use a trusted network or reverse-proxy access controls.

Only files inside the selected root are read, and the integration never writes
to the source directory. Back up your original photos separately; they are not
included in the screensvr data-volume backup.

## Home Assistant

The read-only connector uses the filtered `subscribe_entities` WebSocket API
available in Home Assistant **2024.1 and newer**. It supports:

- Numeric `sensor` states.
- Temperature sensors with the temperature device class and °C, °F, or K units.
- Humidity sensors with the humidity device class and % units.
- `binary_sensor` on/off states as booleans.
- Short text `sensor` states, up to 200 characters.

There are no service calls, writes, templates, attribute paths, or history.
Units come from Home Assistant; screensvr does not convert them.

### Connect

1. In Home Assistant, open your profile's **Security** section and create a
   long-lived access token. Prefer a dedicated, least-privilege account.
2. In screensvr, open **Integrations → Add integration**.
3. Give the connection a name and enter the Home Assistant base URL, for example
   `http://homeassistant.local:8123`, and token.
4. Choose **Test connection**, then **Save integration**.

The URL must be reachable from the screensvr server/container, not just your
browser. `localhost` inside Docker means that container. Use a LAN hostname/IP or
container-network address where appropriate.

Prefer HTTPS. HTTP exposes the token to anyone able to observe that connection.
Certificates are verified; redirects and embedded URL credentials are rejected.
Private/loopback network addresses are supported, but link-local, metadata-service,
unspecified, and multicast destinations are not.

### Choose a sensor

1. Open a display's settings and choose **Stillroom**, **Slow Hours**, or an installed face
   supporting data inputs.
2. Under **Data sources → Room temperature**, select your named integration.
3. Choose a compatible sensor; search by its friendly name or entity ID.
4. Check the preview and choose **Save changes**.

Trying a source only changes the editor preview. Saving updates the real display.
Another display can use the same face with a different sensor.

Slow Hours hides the temperature when unbound, unavailable, or stale. Other
faces may show a placeholder or a stale indicator instead.
Stillroom shows a quiet placeholder when missing and explicitly labels retained
stale readings; it never invents a temperature before you connect a sensor.

**Privacy:** display URLs and their state/stream APIs require no login. Anyone
able to reach the server can read the selected values, including inputs the
face currently hides. Use a trusted LAN, VPN, or reverse-proxy access control.

### Manage and recover

- Edit a connection to replace its token. A blank token field keeps the saved one;
  saved tokens are never sent back to the management browser.
- Disabling stops its data but does not stop faces or remove their bindings.
- Before deleting, unbind or reassign its sources on all listed displays.
- Changing a display's face clears the previous face's bindings. The new face
  receives nothing until you explicitly choose its sources.
- Invalid credentials stop automatic retries. Replace the token or test the
  saved connection to retry.
- Network interruptions reconnect automatically. Retained readings become stale;
  a fresh selected-entity snapshot is required before they become ready again.
- Home Assistant `unknown`/`unavailable` or a removed source produces unavailable
  data, not a zero or the literal word “unknown”.
- A steady sensor remains fresh while its stream is healthy. A value does not
  become stale just because the sensor has not changed.
- A disconnected tablet locally expires readings after their freshness lease
  (normally 90 seconds), including after waking from sleep.

The connector only sends read commands, but **the Home Assistant token itself
may authorize more**. Entity selection limits what screensvr subscribes to and
publishes; it does not reduce the token's upstream permissions. Revoke the token
in Home Assistant if it is exposed.

## Credentials and backups

Tokens are encrypted in `screensvr.sqlite` using authenticated encryption.
`integration-key`, stored beside the database with restricted permissions, is
needed to decrypt them. Back up and restore the **entire data directory**.

This protects a database-only disclosure, not a compromised process or someone
with the whole data volume. Backups remain sensitive.

If the key is missing, invalid, or mismatched, the integration reports an error;
ordinary clock faces keep running. Restore the matching key and restart.
screensvr will not silently generate a replacement key while saved integrations
exist. If recovery is impossible, unbind/delete all saved integrations, stop
screensvr, preserve the broken data for investigation, remove only the known
unusable `integration-key` if present, then restart and configure new connections.

## Limits and development

Up to 10 connections, 256 selected sources per connection, and 16 inputs per face
are supported. Discovery is bounded to 10,000 entities/16 MiB. Tests, discovery,
and previews are rate-limited and have timeouts; high-rate readings are coalesced.
Readings live in memory, not a history database.

Face authors should use provider-independent inputs and the
[SDK data contract](faces.md#manifest-v2-data-inputs). See the framework-free
[Room Climate example](../examples/room-climate/).

Browser/API tests use local fake Home Assistant and Immich servers. Real
Home Assistant, Immich 3.4.1, and Fully Kiosk/Android device checks are still
required before a production rollout.
