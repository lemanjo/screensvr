# Room Climate

A plain HTML/CSS/JavaScript face demonstrating temperature, humidity, boolean,
and text inputs. It uses the current manifest model without a framework or build
step. Each input is optional and provider-independent.

From the repository root, package only the runtime files:

```sh
zip -j room-climate.zip examples/room-climate/{manifest.json,index.html,face.js,style.css}
```

Choose **Face library → Install a face**, upload `room-climate.zip`, and select
**Room Climate** in a display or scene. Add a Home Assistant connection under
**Integrations**, then choose compatible sensors under **Data sources**. Preview
your selections and save.

The face receives normalized readings through `window.screensvr.onUpdate`, not
entity IDs or provider credentials. Missing and stale readings are handled in
the face rather than converted to zero.

See [integration setup](../../docs/integrations.md#home-assistant) and the
[face developer guide](../../docs/faces.md). For a settings-only face, try
[Paper](../paper/). Never put credentials in a package.
