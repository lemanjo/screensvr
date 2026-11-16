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

Install `dist/paper.zip` through **Face library → Install ZIP**, then assign it
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

Render text with `textContent`, not `innerHTML`. Format clocks with
`Intl.DateTimeFormat` and `context.timezone`; do not assume the tablet's timezone
matches the device setting. The browser's own clock supplies time.

The transport is a MessageChannel transferred by the shell on iframe load.
The SDK accepts the connection only from `parent`, replies `ready`, and receives
`update` messages. Successful callbacks reply `applied`; thrown errors report
`error`. Prefer the SDK over coupling directly to this transport.

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
arbitrary hostile JavaScript safe. Automatic updates, capability grants, data
integrations, and configuration migrations are deferred.
