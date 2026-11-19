# Building a face

A **face** is a small web application that controls what a display looks like.
Use plain HTML, CSS, and JavaScript, or bundle a framework of your choice. The
host provides settings, display context, and explicitly selected data through
`window.screensvr`; your face controls the layout and presentation.

This guide describes one current manifest model for screensvr 1.0. Start with
the [Paper example](../examples/paper/) for settings and a clock, or
[Room Climate](../examples/room-climate/) for data inputs.

## Build and install your first face

A package has these files at its root:

```text
manifest.json
index.html
face.js
style.css
assets/       # optional local images, fonts, and other assets
```

To try Paper, run this from the repository root; no build step is needed:

```sh
zip -j paper.zip examples/paper/{manifest.json,index.html,face.js,style.css}
```

Choose **Face library → Install face**, upload `paper.zip`, and select Paper
in a display or scene. Adjust its settings, preview, and save.

When packaging your own face, ZIP the **contents**, not an enclosing directory.
Preserve asset subdirectories: `zip -j` is suitable for the flat example above,
not a package with nested assets. Do not include `node_modules`, source maps
containing secrets, credentials, or development-server files. Packages have no
server-side scripts or npm install hooks.

## Manifest

Every face uses the same `manifest.json` structure. The current `schemaVersion`
is **`5`**; this is a format identifier, not the screensvr application version.
Include `settings` and `inputs` arrays, using `[]` when they are not needed.

Here is a complete manifest with all setting types and one optional data input:

```json
{
  "schemaVersion": 5,
  "id": "my-quiet-clock",
  "version": "1.0.0",
  "name": "My Quiet Clock",
  "description": "A clock with room to breathe.",
  "author": "You",
  "entry": "index.html",
  "settings": [
    {
      "key": "accent",
      "label": "Accent",
      "type": "color",
      "default": "#75916b"
    },
    {
      "key": "caption",
      "label": "Caption",
      "type": "text",
      "default": "Stay a while."
    },
    {
      "key": "showDate",
      "label": "Show date",
      "type": "boolean",
      "default": true
    },
    {
      "key": "scale",
      "label": "Text scale",
      "type": "number",
      "default": 1,
      "min": 0.5,
      "max": 2,
      "step": 0.1
    },
    {
      "key": "format",
      "label": "Time format",
      "type": "select",
      "default": "24",
      "options": [
        { "label": "24 hour", "value": "24" },
        { "label": "12 hour", "value": "12" }
      ]
    }
  ],
  "inputs": [
    {
      "key": "roomTemperature",
      "label": "Room temperature",
      "description": "An optional reading below the clock.",
      "type": "number",
      "quantity": "temperature"
    }
  ]
}
```

### Fields and validation

| Field           | Requirements                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| `schemaVersion` | Set to `5`.                                                                                          |
| `id`            | 2–64 lowercase letters, numbers, or hyphens; start with a letter. The `builtin-` prefix is reserved. |
| `version`       | Your face's numeric `major.minor.patch`, without prerelease/build suffixes; at most 40 characters.   |
| `name`          | 1–80 characters.                                                                                     |
| `description`   | At most 500 characters; may be empty.                                                                |
| `author`        | Optional; at most 80 characters.                                                                     |
| `entry`         | Must be `index.html`.                                                                                |
| `settings`      | Up to 32 controls with unique, safe keys.                                                            |
| `inputs`        | Up to 16 data inputs with unique, safe keys.                                                         |

Keys start with a letter, contain only letters, numbers, or underscores, and
have at most 40 characters. `__proto__`, `constructor`, and `prototype` are not
allowed. Labels are 1–80 characters. Unknown manifest fields and unknown
configuration keys are rejected.

See [`src/shared/contracts.ts`](../src/shared/contracts.ts) and
[`src/shared/face-data.ts`](../src/shared/face-data.ts) for executable validation.

## Settings

Settings are editable controls shown by the host. Each has a `key`, `label`,
`type`, and `default`. screensvr fills missing values from defaults and
validates them before saving.

| Type      | Value and additional fields                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------- |
| `color`   | A six-digit `#rrggbb` string.                                                                                       |
| `text`    | A string of at most 200 characters.                                                                                 |
| `boolean` | `true` or `false`.                                                                                                  |
| `number`  | Finite `min`, `max`, and an in-range default. Optional positive `step` is a UI hint, not an enforced grid.          |
| `select`  | 1–30 `options`, each with a `label` and unique string `value` of 1–80 characters. The default must match an option. |

Read settings from the SDK's `config` object. A setting controls presentation;
it does not grant access to an integration or make published data private.

## Data inputs

Inputs declare **what kind of data** a face can show, not where to fetch it.
The administrator chooses compatible sources separately for each scene.
An unconfigured input must not stop the face or its clock from working.

All inputs have a `key`, `label`, and `type`, with an optional `description`
of at most 200 characters.

| Type       | Additional declaration                             | SDK value when ready or stale                                  |
| ---------- | -------------------------------------------------- | -------------------------------------------------------------- |
| `number`   | Optional `quantity: "temperature"` or `"humidity"` | A number, with a separate `unit`.                              |
| `boolean`  | None                                               | `true` or `false`.                                             |
| `text`     | None                                               | A string of at most 200 characters.                            |
| `image`    | None                                               | A scoped photo collection handle; use the photo helpers below. |
| `weather`  | None                                               | Current temperature and normalized condition.                  |
| `forecast` | Required `period: "daily"` or `"hourly"`           | Ordered forecast entries.                                      |
| `calendar` | None                                               | One appointment, or a confirmed-empty result.                  |

Omit `quantity` for a generic numeric input with a source-provided unit. Do not
put entity IDs, provider URLs, tokens, filesystem paths, or integration-specific
API calls in a face. Data selection and normalization happen on the server;
the host does not add widgets to your layout.

## SDK

Load the host-provided SDK **before** your own script, after the relevant HTML
elements or with an appropriate deferred loading strategy:

```html
<script src="/face-sdk.js"></script>
<script src="face.js"></script>
```

Subscribe to settings, context, and data:

```js
const unsubscribe = window.screensvr.onUpdate(({ config, context, data }) => {
  document.getElementById("caption").textContent = config.caption;
  document.documentElement.style.setProperty("--accent", config.accent);

  const temperature = data.roomTemperature;
  const element = document.getElementById("temperature");
  element.hidden = temperature.status !== "ready";
  element.textContent =
    temperature.status === "ready"
      ? `${new Intl.NumberFormat(context.locale, {
          maximumFractionDigits: 1,
        }).format(temperature.value)} ${temperature.unit ?? ""}`.trim()
      : "";
});
```

This example uses the manifest above and hides readings that are not fresh.
Call `unsubscribe()` when the listener is no longer needed.

The callback runs on initialization and when settings, context, frame size,
data, or freshness change. A listener added after initialization immediately
receives the latest values. Updates are deeply frozen; do not mutate them.

### Display context and clocks

`context` contains `name`, `timezone`, `locale`, `width`, and `height`.
Dimensions describe the face's frame in CSS pixels. The locale comes from the
viewing browser, and the timezone comes from the display setting.

Use `Intl.DateTimeFormat` with `context.timezone`, not the tablet's default
timezone. The browser's clock supplies the current time. SDK updates are **not
clock ticks**: run your own timer and redraw after sleep/visibility changes.
Render text with `textContent`, not `innerHTML`.

### Data status and freshness

Every declared input has an entry in `data` with `type`, `status`, `value`,
`unit`, `updatedAt`, `observedAt`, and `expiresAt`. Numeric quantities and
forecast periods also appear as `quantity` and `period` when declared.

| Status        | Meaning                                              | Value                             |
| ------------- | ---------------------------------------------------- | --------------------------------- |
| `unbound`     | No source selected.                                  | `null`                            |
| `loading`     | Waiting for an initial reading.                      | `null`                            |
| `ready`       | Valid, confirmed data.                               | Typed scalar or structured value. |
| `unavailable` | Missing/invalid source or disabled integration.      | `null`                            |
| `stale`       | A previous valid reading can no longer be confirmed. | Last valid typed value.           |

Timestamps are Unix milliseconds, or `null` when unknown. `updatedAt` describes
the source's update time; `observedAt` is screensvr's confirmation time.
`expiresAt` bounds freshness. The SDK expires readings locally even when the
screen cannot reach the server or has just resumed from sleep.

Treat stale data explicitly: hide it or clearly mark it as old. Do not turn
missing values into zero, assume units, or treat a confirmed-empty calendar as
an error. Temperature units are °C, °F, or K; humidity is %. No unit conversion
is performed. Credentials, raw source IDs/attributes, and integration errors
are not supplied to faces.

Use the SDK rather than implementing the message transport yourself. It handles
the parent connection, protocol negotiation, updates, freshness, and applied/error
acknowledgments. A thrown update callback is reported to the host as a face error.

## Photos

Declare an input such as
`{ "key": "photos", "label": "Photos", "type": "image" }` in `inputs`.
The administrator can select an Immich album, a mounted folder, or one mounted
image. Attribution-capable inputs can also select curated online albums.
A single image is a collection with one item.

A ready/stale image datum contains `{ count, revision, url }`, not image bytes
or the library's file list. Its freshness lease confirms source availability,
not the age of the photograph. Use the SDK to select and rotate images:

```js
const stop = window.screensvr.photos.watch(
  "photos",
  (photo) => {
    const image = document.getElementById("photo");
    image.hidden = !photo;
    if (photo) image.src = photo.url;
    else image.removeAttribute("src");
  },
  { interval: 30000, shuffle: true },
);
// Call stop() to unsubscribe and cancel playback.
```

`watch` emits an initial image or `null`, advances through collections, and
updates when the source, collection, or requested size changes. Unavailable or
unbound data emits `null`. Stale data retains the current image but pauses
rotation. Repeated host updates do not restart the rotation interval. Shuffle
avoids immediate repeats, and one-image sources do not rotate.

For explicit selection:

```js
window.screensvr.onUpdate(() => {
  const photo = window.screensvr.photos.get("photos", {
    index: 0,
    width: 640,
    height: 480,
  });
  // photo is { url, index, count, revision }, or null.
});
```

- Indices are zero-based and must be within the current collection.
- `width`/`height` must be positive finite numbers, capped at 2560. They default
  to frame dimensions, or 1920×1080 when unknown.
- The server groups requests into bounded sizes and preserves aspect ratio.
- `watch` also accepts `interval` in milliseconds (1000–86400000) and `shuffle`.

Use returned URLs in `<img>`, CSS backgrounds, or canvas. For canvas, set
`image.crossOrigin = "anonymous"` **before** assigning `src`. The endpoint allows
anonymous CORS, not administrator cookies. URLs are temporary; do not persist
or log them.

Faces control fit, crop, overlays, and transitions. Preload replacements and
handle image errors without hiding the clock. The bundled
[Photo Hours](../faces/builtin-photos/) demonstrates this more robust playback
pattern. No filesystem paths, provider credentials, or unselected library data
are exposed.

### Online image attribution

To accept **Online backgrounds**, an image input must explicitly promise to
render the supplied attribution:

```json
{ "key": "photos", "label": "Photos", "type": "image", "attribution": true }
```

This is an optional, backwards-compatible image-input capability, not a new
protocol version. Inputs without it remain compatible with local/Immich photos,
but cannot bind online albums.

For online albums, `photos.get` and `photos.watch` return an additional `credit`:

```js
{
  title: "Landscape",
  attribution: "A. Photographer",
  source: "Wikimedia Commons",
  sourceUrl: "https://commons.wikimedia.org/wiki/File:Landscape.jpg",
  license: "CC BY-SA 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/"
}
```

Display the title, attribution, source, and license with their source/license
links. Use `textContent`, never `innerHTML`. Do not truncate or offer an option
to hide required credits. Update credits **only after the corresponding image
loads**; retain the old image's credits during a failed or pending replacement.
Clear credits when clearing the image. Photo Hours demonstrates this behavior.
Links stay subject to the ordinary face sandbox; no extra network or popup
permissions are granted.

The collection descriptor contains a bounded `credits` array in index order
(at most 48 entries) for these public sources. It contains provenance, not raw
image URLs. Do not persist it or use it as an upstream image catalog. Preserve
the SDK URL's `v` revision parameter: scoped online image reads reject mismatched
metadata revisions so an index cannot silently display a different image under
the wrong credit.

## Weather and forecasts

Declare `weather` for current conditions and independent `forecast` inputs for
each desired period. These are entries in the same `inputs` array:

```json
[
  { "key": "weather", "label": "Current weather", "type": "weather" },
  {
    "key": "daily",
    "label": "Daily forecast",
    "type": "forecast",
    "period": "daily"
  },
  {
    "key": "hourly",
    "label": "Hourly forecast",
    "type": "forecast",
    "period": "hourly"
  }
]
```

Each is explicitly bound by the administrator. A missing forecast must not hide
valid current conditions. Read them from the ordinary SDK `data` map.

A ready/stale weather `value` looks like:

```json
{ "temperature": 12.5, "condition": "rain" }
```

Either field may be `null`, but at least one must be present. The datum's
top-level `unit` is °C, °F, or K when a temperature is present; it may be `null`
for condition-only data. Do not infer a condition from a temperature.

A ready/stale forecast `value` looks like:

```json
{
  "entries": [
    {
      "at": 1794960000000,
      "condition": "rain",
      "temperature": 15,
      "low": 7
    }
  ]
}
```

The datum also has top-level `period`. Entries have ordered, unique Unix
millisecond timestamps, with at most seven daily or 24 hourly entries.
`temperature` is the supplied daily high or hourly temperature; `low` is the
supplied daily low and is always `null` for hourly data. Temperature, low, and
condition may individually be `null`, but an entry must have a usable field.
An empty forecast is unavailable with a `null` value. No conversion or
aggregation is performed.

Conditions use normalized codes:
`clear-day`, `clear-night`, `partly-cloudy`, `cloudy`, `rain`, `heavy-rain`, `snow`,
`sleet`, `hail`, `fog`, `wind`, `windy-cloudy`, `thunderstorm`, and
`thunderstorm-rain`. Unrecognized conditions become `null`. Choose your own labels,
icons, layout, and animation.

Forecast `updatedAt` is `null`: Home Assistant does not supply an issuance time.
`observedAt` records the last forecast response, not its generation time or the
forecasted instant. Connection heartbeats cannot renew response age indefinitely.

Format and select entries using `context.timezone`. Keep today's daily entry
even if its timestamp is earlier than the current hour, discard past dates on
rollover, and update time-dependent presentation locally. Account for DST rather
than assuming every day lasts 24 hours. Label retained stale values and do not
animate stale or unknown conditions as current weather.
See [Weather Hours](../faces/builtin-weather/) for a complete example.

## Calendars

Declare an input such as
`{ "key": "calendar", "label": "Next appointment", "type": "calendar" }`.
The administrator can select up to eight calendars for it. The server merges
them and publishes **one appointment**, not the underlying event lists.

A ready/stale `value` looks like:

```json
{
  "event": {
    "kind": "timed",
    "start": 1794920400000,
    "end": 1794924000000,
    "title": null
  },
  "complete": true
}
```

Timed `start`/`end` are Unix milliseconds, with an exclusive end. All-day events
instead use `{ kind: "all-day", startDate: "2026-11-17",
endDate: "2026-11-18", title: null }`. These are timezone-independent calendar
dates with an exclusive end, not UTC-midnight instants.

`title` is `null` in busy-only mode. Only an explicit per-calendar administrator
opt-in permits titles. Faces cannot request redacted details. Provider IDs,
calendar names, URLs, descriptions, locations, and attendees are never supplied.

- Confirmed empty is **ready** with `{ event: null, complete: true }`.
- Partial/failed reads use stale status and `complete: false` when a retained
  aggregate is available. Never claim “no appointments” for incomplete, stale,
  loading, or unavailable data.
- `unit` and `updatedAt` are `null`. `observedAt` is the oldest successful
  confirmation among confirmed selected calendars, not an event's modification time.

The server retains ongoing timed events until their end and prefers timed
appointments over all-day events on the earliest relevant display-local day.
Use `context.timezone` and `context.locale` for timed events. Hide ended events
locally after clock/visibility changes, even if the host cannot be reached.
Only one event is published, so a disconnected face cannot advance to the next
unpublished appointment. Keep the clock independent of calendar availability.
See [Calendar Hours](../faces/builtin-calendar/) for an example.

## Frameworks, sandbox, and package limits

React, Vue, Canvas, SVG, and ordinary ES modules work without a framework-specific
adapter when supported by the target browser. Build **production assets with
relative paths**; for Vite, use `base: "./"`. Bundle dependencies and assets in
the ZIP instead of using CDNs. Local module imports and fonts use anonymous CORS.

Faces run in an opaque-origin sandbox without cookies, localStorage, management
API access, fetch/WebSocket connections, nested frames, workers, form submission,
or top-level navigation. Load assets with ordinary script/import/image/font
mechanisms, not runtime fetch calls. Eval-based development bundles fail.
Avoid features requiring a secure origin or unsupported WebView APIs.

| Package limit                      | Maximum |
| ---------------------------------- | ------- |
| Compressed ZIP                     | 10 MiB  |
| Expanded contents                  | 50 MiB  |
| Individual file                    | 10 MiB  |
| ZIP entries, including directories | 250     |
| `manifest.json`                    | 64 KiB  |

Only regular files/directories with stored or deflated ZIP entries are accepted.
Traversal paths, symlinks, encrypted entries, and duplicate paths are rejected.
Installed packages are immutable, with one version per face ID; see
[replacing a face](user-guide.md#manage-the-face-library).

## Design and testing checklist

- Support portrait, landscape, and small preview frames.
- Honor `prefers-reduced-motion`; avoid high frame rates and unnecessary animation.
- Test with default settings, no bound inputs, missing data, and stale data.
- Test sleep/resume, timezone/DST boundaries, and clocks left running for days.
- Keep assets local so an already loaded face can continue rendering if disconnected.
  This does not guarantee offline startup.
- Test on the actual tablet/WebView, not only desktop browsers.

**Install only trusted packages.** Sandboxing reduces access but cannot make
arbitrary hostile JavaScript safe. Automatic updates, broader capability grants,
and settings migrations are not supported. Changing a scene's face clears its
bindings; switching saved scenes restores each scene's own selections.
