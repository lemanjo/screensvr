# Paper

A minimal face built with plain HTML, CSS, and JavaScript. It demonstrates
editable settings and a timezone-aware clock without a framework or build step.
It needs no integrations; `inputs` is an empty array.

From the repository root, package only the runtime files:

```sh
zip -j paper.zip examples/paper/{manifest.json,index.html,face.js,style.css}
```

In screensvr, choose **Face library → Install a face**, upload `paper.zip`, then
select **Paper** in a display or scene. Adjust its settings and save.

See the [face developer guide](../../docs/faces.md) for the manifest and SDK
reference, or [Room Climate](../room-climate/) for optional data inputs.
