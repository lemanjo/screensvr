# Room Climate

A plain HTML/CSS/JavaScript manifest-v2 face demonstrating numeric, temperature,
humidity, boolean, and text data. Inputs are optional and provider-independent.

Package only the runtime files:

```sh
zip -j room-climate.zip examples/room-climate/{manifest.json,index.html,face.js,style.css}
```

Install through **Face library**, assign it to a display, and select sensors in
**Data sources**. See [integration setup](../../docs/integrations.md) and the
[face developer guide](../../docs/faces.md). No credentials belong in a package.
