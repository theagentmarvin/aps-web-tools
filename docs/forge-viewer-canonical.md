# APS Forge Viewer v7 — Canonical Reference

**Last updated:** 2026-07-17

## Critical: Always use GuiViewer3D, NOT AggregatedView for model loading

`AggregatedView.load({ modelURN })` does NOT render 3D geometry. It is not a valid API for our use case.

## Correct Viewer Setup

```js
// 1. Create viewer
const viewer = new Autodesk.Viewing.Private.GuiViewer3D(container);

// 2. Start (MANDATORY)
viewer.start();
viewer.setLightPreset(0);

// 3. Encode URN
const encodedUrn = `urn:${btoa(rawUrn).replace(/=/g, '')}`;
// rawUrn includes the "urn:" prefix from APS, e.g. "urn:adsk.wipprod:fs.file:vf.xxx?version=1"
// Yes, encode the FULL string including "urn:" — this matches the reference repo

// 4. Load document
Autodesk.Viewing.Document.load(encodedUrn,
  (doc) => {
    const viewables = doc.getRoot().getDefaultGeometry();
    viewer.loadDocumentNode(doc, viewables, {
      keepCurrentModels: true,
      globalOffset: { x: 0, y: 0, z: 0 },
    });
  },
  (code, msg) => console.error(`Document.load failed [${code}]: ${msg}`)
);
```

## Key Gotchas

1. **Do NOT use `AggregatedView.load()`** — it silently fails (no geometry)
2. **Do NOT call `viewer.setTheme()`** — doesn't exist on AggregatedView wrapper (v7)
3. **`setLightPreset(0)` IS valid** — call it after `start()`
4. **URN encoding:** encode the FULL APS URN (including `urn:` prefix) with btoa, then prefix with `urn:` again
5. **Multi-model:** use `keepCurrentModels: true` in `loadDocumentNode` options
6. **Sequential loading:** load models one at a time, not in parallel

## Reference Sources

- Reference repo: `~/projects/theagentmarvin-autodeskPlatformsClash/` (SvelteKit, uses same GuiViewer3D pattern)
- Official APS blog: `aps.autodesk.com/blog/loading-multiple-models-forge-viewer-v7`
- ForgeViewer component: `src/lib/components/ForgeViewer.tsx`
