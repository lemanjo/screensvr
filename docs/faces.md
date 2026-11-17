# Building a face

A face is a local web application. It does not depend on React or screensvr's
management internals. The [Paper example](../examples/paper/) is plain HTML,
CSS, and JavaScript.

## Package layout

```text
manifest.json
index.html
face.js
style.css
assets/       # optional local assets
```

ZIP the **contents**, not an enclosing folder. After building screensvr:

```sh
zip -j dist/paper.zip examples/paper/*
```

Install `dist/paper.zip` through **Face library → Install a face**, then assign it
in a display's settings. There are no server-side scripts or npm install hooks.

## Manifest v1

```json
{
  "schemaVersion": 1,
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
  ]
}
```

- `schemaVersion` must be `1`; `entry` must be `index.html`.
- IDs are 2–64 lowercase letters, numbers, and hyphens, starting with a letter.
  `builtin-` is reserved.
- Versions are numeric `major.minor.patch` without prerelease/build suffixes.
- Names are 1–80 characters, descriptions at most 500, authors at most 80.
- Up to 32 unique settings are supported. Keys start with a letter, contain only
  letters, numbers, or underscores, and have at most 40 characters.
- Color values use `#rrggbb`; text values have at most 200 characters.
- Number controls require finite `min`, `max`, and an in-range default. `step`
  is an optional UI hint, not an enforced numeric grid.
- Select controls require 1–30 uniquely valued options and a default among them.
- Unknown manifest fields and unknown configuration keys are rejected.
- Settings are filled with defaults and validated on the server before saving.

The source of truth is [`src/shared/contracts.ts`](../src/shared/contracts.ts).

## Manifest v2: data inputs

Existing v1 faces need no changes. To receive integration data, use
`"schemaVersion": 2` and add an `inputs` array alongside the normal metadata and
settings:

```json
{
  "inputs": [
    {
      "key": "roomTemperature",
      "label": "Room temperature",
      "description": "An optional reading in the upper-right corner.",
      "type": "number",
      "quantity": "temperature"
    }
  ]
}
```

This is a manifest field fragment, not a complete manifest. Types are `number`,
`boolean`, and `text`. Numeric inputs may constrain `quantity` to `temperature`
or `humidity`; omit it for a generic numeric value with a source-provided unit.
At most 16 unique, safe input keys are allowed, using the setting-key format.
Descriptions have at most 200 characters. Unsupported fields are rejected.

Inputs are optional and distinct from settings. The administrator binds sources
per display. Never embed an entity ID, integration URL, token, attribute path,
or integration-specific API into your face.

Design the layout and fallback behavior yourself. The host does not add widgets.
See [Room Climate](../examples/room-climate/) for a complete v2 package.

## SDK

Load the host-provided SDK **before** your own script:

```html
<script src="/face-sdk.js"></script>
<script src="face.js"></script>
```

Then subscribe:

```js
const unsubscribe = window.screensvr.onUpdate(({ config, context }) => {
  document.getElementById("caption").textContent = config.caption;
  document.documentElement.style.setProperty("--accent", config.accent);
  // context: { name, timezone, locale, width, height }
});
```

The callback runs with initial configuration and whenever settings, device
context, or frame size change. Subscribing after initialization immediately
receives the latest values. The return value unsubscribes the callback.

For a v2 face, use the `data` map:

```js
window.screensvr.onUpdate(({ data, context }) => {
  const temperature = data.roomTemperature;
  const element = document.getElementById("temperature");
  element.hidden = temperature.status !== "ready";
  element.textContent =
    temperature.status === "ready"
      ? `${new Intl.NumberFormat(context.locale, { maximumFractionDigits: 1 }).format(temperature.value)} ${temperature.unit}`
      : "";
});
```

Every declared input has an entry, containing `type`, optional `quantity`,
`status`, `value`, `unit`, `updatedAt`, `observedAt`, and `expiresAt`.

| Status        | Meaning                                        | Value                            |
| ------------- | ---------------------------------------------- | -------------------------------- |
| `unbound`     | No selected source                             | `null`                           |
| `loading`     | Waiting for an initial reading                 | `null`                           |
| `ready`       | Valid, confirmed reading                       | Number, boolean, or short string |
| `unavailable` | Missing/invalid source or disabled integration | `null`                           |
| `stale`       | Last valid reading can no longer be confirmed  | Last valid typed value           |

Timestamps are Unix milliseconds, or `null` when unknown. `updatedAt` describes
the source's last update; `observedAt` is screensvr's latest confirmation.
The SDK locally expires readings at `expiresAt` even when the display cannot
reach the server. Treat stale values explicitly; do not present them as fresh.
Temperature units are °C, °F, or K; humidity is %. Other numeric units are
source-provided. No unit conversion is performed.

Callbacks also run on data/freshness changes. Updates are deeply frozen; do not
mutate them. v1 consumers still receive their existing config/context, with an
empty SDK `data` map. Data is selected and normalized server-side: no raw entity
IDs, attributes, credentials, or integration errors are provided.

Render text with `textContent`, not `innerHTML`. Format clocks with
`Intl.DateTimeFormat` and `context.timezone`; do not assume the tablet's timezone
matches the device setting. The browser's own clock supplies time.

The transport is a MessageChannel transferred by the shell on iframe load.
The SDK accepts the connection only from `parent`, replies `ready`, and receives
`update` messages. Successful callbacks reply `applied`; thrown errors report
`error`. Prefer the SDK over coupling directly to this transport.
The host advertises protocols 1/2 and the SDK acknowledges its selected version.
Legacy SDKs without a version acknowledgment use protocol 1; manifest-v2 faces
require protocol 2.

## Frameworks and browser restrictions

Bundled React, Vue, Canvas, SVG, and ordinary ES modules can work without a
framework-specific adapter. Build **production assets with relative paths**
(for Vite, set `base: "./"`). Bundle dependencies into the ZIP; do not use CDNs.
ES module imports and local fonts use anonymous CORS on the face asset endpoint.

The opaque-origin sandbox deliberately has no cookies, localStorage, management
API access, fetch/WebSocket connections, nested frames, workers, form submission,
or top-level navigation permissions. Eval-based development bundles will fail.
Use ordinary script imports for assets, not runtime fetch calls. Avoid features
that require a secure origin or unsupported WebView APIs.

Packages are limited to **10 MiB compressed**, **10 MiB per file**, **50 MiB
expanded**, and **250 ZIP entries**. Only regular files/directories and stored or
deflated ZIP entries are supported. `manifest.json` is limited to 64 KiB.

## Design and testing

- Support portrait, landscape, and small preview frames.
- Honor `prefers-reduced-motion`; avoid unnecessary animation and high frame rates.
- Test sleep/resume, timezone boundaries, and long-running clocks.
- Keep assets local so a disconnected display can keep rendering its loaded face.
- Test on the actual target tablet/WebView; desktop browsers are not sufficient.

Install only trusted packages. Sandboxing reduces access but does not make
arbitrary hostile JavaScript safe. Automatic updates, broader capability grants,
and configuration migrations are deferred. Integration selection is explicit;
changing faces clears bindings rather than granting a new face old data.
