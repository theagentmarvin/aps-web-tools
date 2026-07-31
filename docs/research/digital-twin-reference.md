# APS Viewer SDK — Digital Twin Reference Implementations & Patterns for SalfaCorp

**Audience:** SalfaCorp construction digital twin (FV3 / APS Viewer Toolkit, Stage 3–5)
**Compiled:** 2026-07-30
**Status:** Research / reference catalog. Sources verified against GitHub, Autodesk APS blog, and Stack Overflow as of July 2026.

---

## 0. Executive Summary

This report catalogs reference implementations, extension patterns, and concrete techniques for building a construction-grade digital twin on top of the Autodesk Platform Services (APS) Viewer SDK. It is organized as:

1. A **repo catalog** (10 canonical GitHub repos, ranked by relevance)
2. A **pattern catalog** (theming, performance, model browser, IoT, dashboards, markups, issues)
3. **Concrete code snippets** extracted from the references (not just links)
4. A **roadmap** for SalfaCorp with explicit Stage 3 / 4 / 5 priorities
5. **SalfaCorp-specific context** (what they already have, what gaps to fill)

The single most important takeaway: **Autodesk now ships a Data Visualization extension that does exactly what a digital twin needs** (heatmaps, sprites, sensor overlays). The Petr Broz / `forge-dataviz-iot-reference-app` → `aps-iot-extensions-demo` lineage is the canonical starting point. It targets **Revit rooms** specifically, which aligns with SalfaCorp's residential / mining-construction BIM workflows.

---

## 1. Critical Foundational Reference: The Autodesk Data Visualization Extension

The Data Visualization (`Autodesk.DataVisualization`) extension is **the** APS-built feature for digital twin work. It is the only first-party extension that handles heatmaps, sprites, and sensor overlays for BIM models.

### 1.1 Live reference apps

| Repo | Status | URL |
|---|---|---|
| `autodesk-platform-services/aps-iot-extensions-demo` | **CURRENT** — Autodesk's active reference | https://github.com/autodesk-platform-services/aps-iot-extensions-demo |
| `Autodesk-Forge/forge-dataviz-iot-reference-app` | DEPRECATED — replaced by the above (README is explicit) | https://github.com/Autodesk-Forge/forge-dataviz-iot-reference-app |
| Live demo | https://aps-iot-extensions-demo.autodesk.io |

The newer repo (`aps-iot-extensions-demo`) is built on React + Yarn + Node.js, demonstrates the **IoT/Digital Twin pattern** with:
- Hard-coded mock sensors in `services/iot.mocked.js` (XYZ position + room dbId)
- `DataView` class to abstract data sources (swap mock for real DB)
- `autodesk-temp`/`autodesk-staging` env switching
- Sprites for sensor positions, surface shading for heatmaps

### 1.2 Core DataViz API (extracted from `forge-dataviz-iot-reference-app/client/pages/Heatmap.jsx`)

```jsx
// 1. Load the extension
const dataVizExt = viewer.getExtension("Autodesk.DataVisualization");
const DV = Autodesk.DataVisualization.Core;

// 2. Define sprite styles per sensor type
const SensorStyleDefinitions = {
  co2:         { url: `${assetUrlPrefix}/images/co2.svg`,         color: 0xffffff },
  temperature: { url: `${assetUrlPrefix}/images/thermometer.svg`, color: 0xffffff },
  default:     { url: `${assetUrlPrefix}/images/circle.svg`,      color: 0xffffff },
};

// 3. Map style definitions to ViewableStyle objects
const styleMap = {};
Object.entries(SensorStyleDefinitions).forEach(([type, def]) => {
  styleMap[type] = new DV.ViewableStyle(
    DV.ViewableType.SPRITE,
    new THREE.Color(def.color),
    def.url
  );
});

// 4. Create ViewableData and add each device
const viewableData = new DV.ViewableData();
viewableData.spriteSize = 16;
devices.forEach((device, i) => {
  const style = styleMap[device.type] ?? styleMap.default;
  viewableData.addViewable(new DV.SpriteViewable(device.position, style, i + 1));
});
await viewableData.finish();
dataVizExt.addViewables(viewableData);

// 5. Set up room/level mapping (Revit AEC model data only)
const doc = data.model.getDocumentNode().getDocument();
const aec = await doc.downloadAecModelData();
const levelsExt = await viewer.loadExtension("Autodesk.AEC.LevelsExtension", { doNotCreateUI: true });
const floor = levelsExt.floorSelector.floorData;
levelsExt.floorSelector.selectFloor(floor.index, true);

// 6. Generate surface shading data (maps devices → rooms)
const structureInfo = new DV.ModelStructureInfo(data.model);
const heatmapData = await structureInfo.generateSurfaceShadingData(devices);
await dataVizExt.setupSurfaceShading(data.model, heatmapData);

// 7. Register color stops (gradient) per sensor type
dataVizExt.registerSurfaceShadingColors("co2",         [0x00ff00, 0xff0000]);   // green→red
dataVizExt.registerSurfaceShadingColors("temperature", [0xff0000, 0x0000ff]);   // red→blue

// 8. Callback: get current sensor value (0..1 normalized)
function getSensorValue(device, sensorType) {
  return Math.random();  // swap for real IoT fetch
}

// 9. Render (heavy, do once)
dataVizExt.renderSurfaceShading(floor.name, "temperature", getSensorValue);
// 10. Update (light, do as often as you want — once per tick)
dataVizExt.updateSurfaceShading(getSensorValue);
```

**⚠️ Critical caveat found in Stack Overflow (`67301779`):** sensor type strings are **case-sensitive** across all three calls — `registerSurfaceShadingColors`, `renderSurfaceShading`, and the device `sensorType` field. "Temperature" vs "temperature" silently breaks the heatmap.

### 1.3 Working with non-Revit models (IFC, NWC)

The DataViz extension relies on `AECModelData` (Revit-specific). For IFC or NWC, the official workaround is in the Autodesk blog "Add Data Visualization Heatmaps for Rooms of non-Revit model part 1 (NWC)" — you **rebuild** the level-rooms map manually:

```js
async function buildRoomMap(viewer) {
  const model = viewer.model;
  const levelExt = await viewer.loadExtension("Autodesk.AEC.LevelsExtension");
  const floors = levelExt.floorSelector.floorData;

  // Find "Rooms" via category search (adjust for IFC!)
  const roomDbIds = await new Promise((res, rej) =>
    model.search("Rooms", res, rej, ["Category"])
  );

  const levelRoomsMap = new Autodesk.DataVisualization.Core.LevelRoomsMap();
  for (let i = roomDbIds.length - 1; i >= 0; i--) {
    const dbId = roomDbIds[i];
    const box = await getBoxAsync(dbId, model);
    const level = getLevel(box, floors);
    const tree = model.getInstanceTree();
    const name = tree.getNodeName(dbId);
    levelRoomsMap.addRoomToLevel(level.name, new DV.Room(dbId, name, box));
  }
  return levelRoomsMap;
}
```

This is **important for SalfaCorp** because much of their project portfolio (mining, industrial EPC) uses NWC/NWD Navisworks files, not Revit.

### 1.4 Disabling / re-enabling heatmaps

Workaround for the lack of an official "off" API (Stack Overflow 68389336):
- `updateSurfaceShading(() => null)` sets all to lowest value (not what you want)
- The only full unload is `viewer.unloadExtension('Autodesk.DataVisualization')` then re-initialize

---

## 2. GitHub Repo Catalog (ranked by relevance)

### Tier 1 — Must study

| # | Repo | Why it matters | URL |
|---|---|---|---|
| 1 | `autodesk-platform-services/aps-extensions` | The official **extension library** — 10 ready-to-use extensions (Phasing, XLS, CustomProperties, Draw Tool, IconMarkup, NestedViewer, CameraRotation, Transform, GoogleMapsLocator, Edit2D). Self-contained `extensionloader.js` pattern using `CustomEvent` for loose coupling. **Our best starting template for the Stage-3 extension system.** | https://github.com/autodesk-platform-services/aps-extensions |
| 2 | `autodesk-platform-services/aps-iot-extensions-demo` | **The current DataViz reference** (active). React + Yarn + Node.js. Live demo. Sensor mock data. `DataView` abstraction for plugging real IoT backends. | https://github.com/autodesk-platform-services/aps-iot-extensions-demo |
| 3 | `Autodesk-Forge/forge-dataviz-iot-reference-app` | **DEPRECATED but still useful** — has the Heatmap.jsx demo, the SensorTypes definitions, and the React component wrappers (`forge-dataviz-iot-react-components`). Code patterns to copy. | https://github.com/Autodesk-Forge/forge-dataviz-iot-reference-app |
| 4 | `Autodesk-Forge/forge-bim360reports` | **The canonical "dashboard on top of Viewer" reference.** Lists all property names available in a model, lets user pick one, builds a Chart.js bar/pie. Uses `getBulkProperties`. Excellent chart-panel pattern. | https://github.com/Autodesk-Forge/forge-bim360reports |
| 5 | `autodesk-platform-services/aps-bim360-issues` | **Pushpin extension demo for Issues** — uses built-in `Autodesk.BIM360.Extension.PushPin`. Shows how to render issues on model, link to 3D location, get issue data from ACC API. Core pattern for stage-4 RFIs/issues. | https://github.com/autodesk-platform-services/aps-bim360-issues |

### Tier 2 — Specific patterns we need

| # | Repo | Why it matters | URL |
|---|---|---|---|
| 6 | `Autodesk-Forge/library-javascript-viewer-extensions` | **Olympia Suite of extensions** — PropertyList (custom property panel), PropertyTranslator (auto-translate), StateManager (save/restore state), 3D markups, Material changer, Mesh inspector. The "everything extension" library. | https://github.com/Autodesk-Forge/library-javascript-viewer-extensions |
| 7 | `Autodesk-Forge/forge-bim360-clashissue` | **Clash detection visualization** — pulls Model Coordination API, highlights clash pairs in red/blue, can create Issue with pushpin. Directly relevant to SalfaCorp's constructability review workflow. | https://github.com/Autodesk-Forge/forge-bim360-clashissue |
| 8 | `XiaodongLiang/forgeviewer_embed_in_powerbi_report` | **Power BI embedding pattern** — DEPRECATED by Autodesk's own `aps-powerbi-tools`, but the source code is the cleanest reference for embedding the Viewer in a 3rd-party dashboard. | https://github.com/xiaodongliang/forgeviewer_embed_in_powerbi_report |
| 9 | `autodesk-platform-services/aps-powerbi-tools` | **Official Power BI visual** (called "Endymion") — embed Viewer in Power BI report, drive it from Power BI selection. Has 4D playback (Gantt + animation). Built by Autodesk to replace the 3rd-party visual. | https://github.com/autodesk-platform-services/aps-powerbi-tools |
| 10 | `petrbroz/forge-samples-docs` | **Petr Broz's curated tutorials index** — best starting point for any "I want to do X in Viewer" question. Covers provisioning, permissions, ACC, issues, markups, model derivatives. | https://github.com/petrbroz/forge-samples-docs |

### Bonus repos (community)

- `Autodesk-Forge/forge-digital-twin` — referenced in Stack Overflow 62888873 as a "best practices" demo for setThemingColor
- `PetrBroz/forge-potree-demo` — point cloud rendering for large site scans (relevant for SalfaCorp mining)
- `CodeVijay53/APS-Dashboard` — small community dashboard demo (https://aps-dashboard.onrender.com)
- Field of View blog (Philippe Leefsma) — `fieldofviewblog.wordpress.com` — the unofficial APS canon, 15+ years of pattern posts

---

## 3. Pattern Catalog

### 3.1 Pattern: Theming / Color-coding strategies

APS Viewer has **three distinct theming APIs** that are often confused:

| API | Use case | Resolution |
|---|---|---|
| `viewer.setThemingColor(dbId, color, model, recursive)` | Single color on one element (or subtree with `recursive=true`) | Per-element, RGBA `THREE.Vector4` |
| `viewer.setThemingColors(dbIdToColorMap)` — implicit via DataViz | Many elements at once | Bulk apply |
| `Autodesk.DataVisualization` (DataViz) | Heatmaps + sprite overlays | Per-room/level gradient |

**Categorical (one color per value)** — use `getBulkProperties` + iterate, e.g.:
```js
const tree = viewer.model.getInstanceTree();
const allDbIds = Object.keys(tree.nodeAccess.dbIdToIndex).map(Number);
viewer.model.getBulkProperties(allDbIds, { propFilter: ["Material"] }, (results) => {
  const palette = ["#e74c3c", "#2ecc71", "#3498db"]; // 3 materials, 3 colors
  const dbIdsByMaterial = {};
  results.forEach(({ dbId, properties }) => {
    const mat = properties.find(p => p.displayName === "Material")?.displayValue;
    if (mat) (dbIdsByMaterial[mat] ??= []).push(dbId);
  });
  Object.entries(dbIdsByMaterial).forEach(([mat, ids], i) => {
    ids.forEach(id => viewer.setThemingColor(id, new THREE.Vector4(...hexToVec4(palette[i % palette.length])), viewer.model));
  });
});
```

**Continuous (gradient)** — only the DataViz heatmap API supports this natively. For custom gradients on plain theming, build a color scale function and bin values manually.

**Heatmap with custom gradient bands** — Forge DataViz supports color stops like:
```js
const sensorColors = [0x0000ff, 0x00ff00, 0xffff00, 0xff0000]; // 4-stop rainbow
dataVizExt.registerSurfaceShadingColors("co2", sensorColors);
```

**Gotchas (Stack Overflow verified):**
- `setThemingColor` 2nd arg must be `THREE.Vector4`, not `THREE.Color` (51020571)
- For non-leaf dbIds, set `recursive=true` (5588711)
- If `skipPropertyDb: true`, recursive flag silently fails because no instance tree (79827166)
- Use `clearThemingColors(model)` to reset; pattern changed between v6.3 and v6.4 (55711511)

### 3.2 Pattern: Performance — large models (100K+ dbIds)

Performance is a **first-class concern** for SalfaCorp's mining / industrial projects. Verified techniques:

1. **Use SVF2** (not SVF1). SVF2 deduplicates meshes across viewables, dramatically reducing load time and memory. (Blog: "Model Derivative SVF2 enhancements — Part 1 Viewer", 2021-11-23)
2. **Consolidation** — `useConsolidation: true, consolidationMemoryLimit: 150 * 1024 * 1024` in viewer options. Trades BVH memory for fewer draw calls.
3. **Selective loading** — `viewer.loadModel(url, { ids: [1,2,3,...] })` loads only specified dbIds. Useful for "show only floor N" or "show only trades A+B". But beware: with `ids` filter, the property database gets mis-assigned (56295738).
4. **Skip property DB** — `viewer.loadModel(url, { skipPropertyDb: true })` for huge scene-only models. Saves hundreds of MB. Property panel becomes unavailable, but you can persist your own data via a custom backend.
5. **Disable extensions** — `disabledExtensions: { measure: true, viewcube: true, layermanage: true, ... }` in viewer options. From the official v7.93 list:
   ```js
   const ext3d = {
     viewcube: 'Autodesk.ViewCubeUi',
     explode: 'Autodesk.Explode',
     bimwalk: 'Autodesk.BimWalk',
     fusionOrbit: 'Autodesk.Viewing.FusionOrbit',
     measure: 'Autodesk.Measure',
     section: 'Autodesk.Section',
     layerManager: 'Autodesk.LayerManager',
     modelBrowser: 'Autodesk.ModelStructure',
     propertiesPanel: 'Autodesk.PropertiesManager'
   };
   ```
6. **MemoryLimited extension** — `viewer.loadExtension('Autodesk.MemoryLimited')` to cap memory and prevent browser crashes (64981274).
7. **GUIless viewer** — `new Autodesk.Viewing.Viewer3D(container, options)` (not `GuiViewer3D`) for headless / embedded contexts.
8. **Use `getBulkProperties`, not `getProperties`** — `getBulkProperties` batches requests; `getProperties` is per-dbId and slow.
9. **Avoid selecting 100K+ elements** — selection rendering is not optimized beyond ~1000 (64100445). Use **theming colors** instead of selection for "show all X" use cases.
10. **Split Navisworks by discipline** — for NWD files > 1 GB, the official Autodesk recommendation is to split by discipline/area and load on demand.

### 3.3 Pattern: Model browser — hierarchical navigation + search

Three levels of customization:

**Level 1 — Config the built-in `ViewerModelStructurePanel`:**
```js
viewer.addEventListener(Autodesk.Viewing.OBJECT_TREE_CREATED_EVENT, () => {
  const panel = new Autodesk.Viewing.Extensions.ViewerModelStructurePanel(viewer, 'Model Browser', {
    docStructureConfig: viewer.config.docStructureConfig,
    hideSearch: false,                         // show search box
    excludeRoot: viewer.config.modelBrowserExcludeRoot,
    startCollapsed: false,
    isolate: viewer.config.modelBrowserIsolateSelectedNodes,
    click: { onObject: ['selectOnly'] },       // click behavior
    clickShift: { onObject: ['isolate'] },
    clickCtrl: { onObject: ['selectToggle'] }
  });
  viewer.setModelStructurePanel(panel);
});
```

**Level 2 — Custom node labels:**
```js
viewer.modelstructure.tree.delegates[0].getTreeNodeLabel = (nodeId) => {
  // Async-fetch via getProperties, return cached value
  return customLabelMap.get(nodeId) ?? tree.getNodeName(nodeId);
};
```

**Level 3 — Replace the whole tree with a custom data structure** (for filtering by property values, custom buckets, etc.). Petr Broz's blog "Custom Tree Views" is the canonical reference; the `viewer.modelstructure.tree.delegates[i]` API is undocumented but stable.

**Search:** the built-in search box works on `viewer.search()` which supports attribute name filters:
```js
viewer.search("Walls", onSuccess, onError, ["Category"]);
```

**Persisting IDs across sessions** — Kean Walpole's approach (https://keanw.com/2020/02/persisting-identifiers-for-objects-in-the-forge-viewer.html): use `UniqueId` property to map between viewer dbIds and your backend's persistent IDs.

### 3.4 Pattern: Real-time IoT overlays

The DataViz extension is the answer. Architecture pattern (from `aps-iot-extensions-demo`):

```
[IoT Devices / Sensors]
        ↓ MQTT / HTTP / WebSocket
[Node.js Backend]                    services/iot.mocked.js
        ↓ REST API (one per sensor or batch)
[Frontend DataView class]            custom DataView implementation
        ↓ getSensors() / getSensorValue(deviceId, type)
[DataViz extension]
        ↓ addViewables() / renderSurfaceShading()
[Forge Viewer]
```

**Live update pattern** — render once, then call `updateSurfaceShading()` on a tick:
```js
// One-time setup
dataVizExt.renderSurfaceShading(floor.name, "temperature", getSensorValue);

// Live updates (cheap, run on every Kafka/WS message)
setInterval(() => {
  dataVizExt.updateSurfaceShading(getSensorValue);
}, 5000);
```

**For construction (not office buildings)** — the AEC DataViz extension expects **rooms** as units. For outdoor construction sites, you tip the model by:
- Treating each "construction zone" as a virtual room (manually-added Revit volumes)
- OR using **sprites only** (no heatmap) — sensor positions, no surface shading
- OR using a tile/grid overlay on a horizontal plane (custom shader)

### 3.5 Pattern: Dashboard panels (charts, tables, KPIs)

The reference pattern is `forge-bim360reports` (live at https://visualreports.autodesk.io):

```js
// 1. Get all leaf nodes
const tree = viewer.model.getInstanceTree();
const allLeafIds = [];  // enumerate via tree.enumNodeChildren + getChildCount

// 2. Bulk-fetch one property
viewer.model.getBulkProperties(allLeafIds, { propFilter: ['Material'] }, (results) => {
  // 3. Count occurrences
  const counts = {};
  results.forEach(r => {
    const v = r.properties.find(p => p.displayName === 'Material')?.displayValue;
    if (v) counts[v] = (counts[v] || 0) + 1;
  });

  // 4. Render Chart.js
  new Chart(ctx, {
    type: 'bar',
    data: { labels: Object.keys(counts), datasets: [{ data: Object.values(counts) }] }
  });
});
```

**Dashboard panel design (extracted from multiple refs):**
- Left panel: segmented controls (chart type: bar / pie / doughnut / polarArea)
- Top: dropdown that selects **property name** dynamically (Material, Category, Type Name, etc.)
- Center: the viewer
- Right: chart panel (Chart.js)
- Bottom: KPIs (total elements, count per category, % completed)

**Trend over time** — different problem. Needs time-series storage (InfluxDB, TimescaleDB) + a separate line chart. Not covered by Forge's built-in extensions.

### 3.6 Pattern: Issues / Pushpins (Stage 4)

The push-pin extension is built-in: `Autodesk.BIM360.Extension.PushPin`. Pattern:

```js
// 1. Load extension
const pushPinExt = await viewer.loadExtension('Autodesk.BIM360.Extension.PushPin');

// 2. For each issue, create a pin
issues.forEach(issue => {
  pushPinExt.createItem({
    id: issue.id,
    label: issue.identifier,           // shown when selected
    status: `${issue.type}-${issue.status}`,  // controls shape/color
    position: issue.pushpin_attributes.location, // {x,y,z}
    objectId: issue.pushpin_attributes.object_id, // (3D only) attach to element
    viewerState: issue.pushpin_attributes.viewer_state // camera at creation
  });
});

// 3. Toggle visibility
pushPinExt.showAll();
pushPinExt.removeAllItems();
```

**Issue types** are stored as `type-status` strings; out-of-the-box: `issues-open`, `issues-answered`, `issues-closed`, `issues-void`, `issues-draft`, etc. Custom issue types require custom icon registration.

**Pushpin limitations** (from APS blog "BIM 360/ACC API Known Issues"):
- `pushpin_attributes.viewer_state` is **empty for `.dwg` files** (only populated for Revit)
- Snapshot URN export is for `.dwg` only
- For 3D model issues, `objectId` ties the pushpin to a specific model element — clicking the element highlights the pushpin

### 3.7 Pattern: Markups / 2D annotations

Markups (`Autodesk.Viewing.MarkupsCore` + `Autodesk.Viewing.MarkupsGui`) are SVG-based. Pattern from Stack Overflow 63286409:

```js
// MUST load after model loads
viewer.addEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, async () => {
  await viewer.loadExtension('Autodesk.Viewing.MarkupsCore');
  await viewer.loadExtension('Autodesk.Viewing.MarkupsGui');
});
```

**Export to PDF** — no official API. Workaround:
1. Render the markup SVG to a PNG via Viewer screenshot
2. Use `pdfkit` to embed the PNG + the model screenshot side-by-side
3. Strip <g> elements for any markup you want to hide

**Field teams** would scan a QR code on-site → opens a web URL → can place a markup at exact location without installing native viewers. Doxel (commercial) does this with computer vision; the open-source equivalent is in the *Innovation* journal article 14072252 (AprilTags + phone camera).

### 3.8 Pattern: Multi-model aggregation

Construction projects need to visualize **structure + MEP + site** (or **architectural + structural + mechanical**) simultaneously. Forge Viewer supports this natively via `loadDocumentNode` with `keepCurrentModels: true`:

```js
const doc1 = await loadDoc(urn1);
const doc2 = await loadDoc(urn2);
viewer.loadDocumentNode(doc1, doc1.getRoot().getDefaultGeometry(), { keepCurrentModels: true });
viewer.loadDocumentNode(doc2, doc2.getRoot().getDefaultGeometry(), { keepCurrentModels: true });
```

But the **model structure panel** and **selection** need to be in "aggregate" mode:
- `Autodesk.Viewing.AGGREGATE_SELECTION_CHANGED_EVENT`
- `Autodesk.Viewing.AGGREGATE_ISOLATION_CHANGED_EVENT`
- `Autodesk.Viewing.AGGREGATE_FIT_TO_VIEW_EVENT`

For SalfaCorp mining projects, this is critical: structural + piping + electrical + HVAC would all be separate SVFs loaded into one viewer.

### 3.9 Pattern: Power BI / 3rd-party embedding

Autodesk ships an **official Power BI custom visual** (`aps-powerbi-tools`) that:
- Embeds the Viewer
- Reads model URN from a Power BI field
- Supports 3D selection sync (PBI row → model element)
- Supports **4D playback** (Gantt + animation driven by PBI date fields)

For users already in Power BI land (likely SalfaCorp's finance / project controls teams), this is **the fastest path** to a digital twin without writing a custom web app.

Custom embedding (into a different framework) is possible via the `aps-extensions/extensionloader.js` pattern (custom events for cross-frame messaging).

---

## 4. Roadmap — Concrete Roadmap for SalfaCorp Digital Twin

### Stage 3 — "View with Context" (weeks 1–6)

**Goal:** Multi-model viewer with property-driven theming and a search/filter panel.

| ID | Task | Reference | Effort |
|---|---|---|---|
| 3.1 | Stand up `aps-extensions` extension loader pattern | `aps-extensions` repo | 1 wk |
| 3.2 | Property-driven theming panel (categorical color by Material / Category / Phase) | `forge-bim360reports` DashboardPanel.js + bulk properties pattern | 1–2 wk |
| 3.3 | Custom model browser with filter (search by property value) | Stack Overflow 53792642 + "Custom Tree Views" blog | 1 wk |
| 3.4 | Chart.js dashboard panel (Material distribution, Floor count, Phase progress) | `forge-bim360reports` | 1 wk |
| 3.5 | Multiple model aggregation (architectural + structural + MEP) | "Supporting multiple models — new ModelStructurePanel" blog | 1 wk |
| 3.6 | Critical performance baseline (SVF2, disable unused extensions, `getBulkProperties`) | APS blog "Minimizing viewer workloads" | 0.5 wk |

**Total Stage 3 effort:** ~6 weeks

### Stage 4 — "Connect Field to Office" (weeks 7–14)

**Goal:** Pushpin issues, markups, 4D progress.

| ID | Task | Reference | Effort |
|---|---|---|---|
| 4.1 | Pushpin integration with ACC Issues API (read + write) | `aps-bim360-issues` repo | 1.5 wk |
| 4.2 | Markups extension + PDF export pipeline (pdfkit + screenshot) | Stack Overflow 71559071 | 1 wk |
| 4.3 | 4D progress (or use `aps-powerbi-tools` if Power BI is acceptable) | `aps-powerbi-tools` (AWPBI demo) | 2 wk |
| 4.4 | QR-code-on-site workflow (open viewer URL with deep link to element) | Doxel blog + Forge state-restore pattern | 1 wk |
| 4.5 | ACC RFI ↔ element linking via `objectId` in pushpin_attributes | APS Issues API docs | 1 wk |

**Total Stage 4 effort:** ~6–7 weeks

### Stage 5 — "Living Digital Twin" (weeks 15–24)

**Goal:** Real-time IoT overlays, automated theming, alerts.

| ID | Task | Reference | Effort |
|---|---|---|---|
| 5.1 | DataViz extension integration (sprites + heatmaps for rooms) | `aps-iot-extensions-demo` | 2 wk |
| 5.2 | IoT backend integration (replace `iot.mocked.js` with real data source) | `DataView` class pattern | 2 wk |
| 5.3 | Live tick updates via `updateSurfaceShading()` (WS / SSE) | DataViz API | 1 wk |
| 5.4 | Custom sensor types per construction zone (not Revit rooms) | "non-Revit NWC" workflow | 1 wk |
| 5.5 | Alert system (threshold-based theming color + push notification) | Custom + APS webhooks | 2 wk |
| 5.6 | Multi-model + aggregate heatmap (e.g., structural + MEP clash zones) | Aggregate selection pattern | 2 wk |

**Total Stage 5 effort:** ~10 weeks

---

## 5. Priority Ranking (effort vs. value)

| Priority | Pattern | Stage | Value | Effort | Why |
|---|---|---|---|---|---|
| **P0** | Theming + Chart.js dashboard | 3 | High | Low | Immediate "wow factor" for exec demos |
| **P0** | SVF2 + bulk properties perf | 3 | Critical | Low | Without this, large models break |
| **P1** | Custom model browser with filters | 3 | High | Medium | Differentiator vs plain Forge |
| **P1** | Pushpin issues (read+write) | 4 | High | Medium | Field-office workflow |
| **P1** | Markups + PDF export | 4 | High | Medium | Construction's daily bread |
| **P2** | DataViz heatmaps (rooms) | 5 | High | High | True digital twin value |
| **P2** | 4D progress (Power BI route) | 4 | High | Low | If Power BI is acceptable |
| **P3** | IoT real-time tick updates | 5 | Medium | High | Needs real IoT source |
| **P3** | Multi-model heatmap overlay | 5 | Medium | High | Niche use case |
| **P3** | AprilTags + phone-camera QC | 5+ | Low | High | Academic; commercial solutions exist |

---

## 6. SalfaCorp-Specific Context

### 6.1 What SalfaCorp already has

Based on public sources (salfacorp.com, LinkedIn, CTeC innovation page, Nueva Minería):

- **BIM ISO 19650-1/2 certified** — Salfa Montajes is the first AENOR-certified BIM construction company in Chile (industrial assembly)
- **CTeC partnership** — Chilean construction innovation center; trained 9+ SalfaCorp units (Aconcagua, Fe Grande, Inoval, Icem, Tecsa, Icsa, Novatec, Montajes, Salfa Industrial) in BIM methodology
- **Innovation program** — Multi-year innovation plan since 2021; "TallerBasaldeDesarrollo" workshops
- **Major active projects** — Minera Centinela DMC PV2 (EPC concentrator plant, 2024–2027), BHP Escondida, Codelco Andina/El Teniente, SQM, Albemarle
- **23,000+ employees**, $1B+ revenue, presence in Peru, Colombia, Panama

### 6.2 What gaps the digital twin fills

- **Multi-discipline coordination** — Minera Centinela EPC scaffolds + concrete + steel + piping + electrical. Each comes as separate RVT/NWD. Viewer aggregation + clash detection on top of Forge.
- **Construction progress vs. design** — 4D simulation per disciplina; traditional Synchro/Primavera workflows can be brought into the viewer.
- **Equipment monitoring** — Mining tailings, conveyors, pumps. Sensor data is available but siloed in SCADA. A digital twin unifies with the model.
- **Field-to-office RFIs** — Already using ACC (most likely) or moving to it. Pushpin workflow is a natural add-on.

### 6.3 Likely Chilean construction competitors / partners

- **Bimworks** (cl.linkedin.com/company/bimworks-cl) — BIM consultancy, 4D/5D/6D/7D, uses Twinzo for logistics + 3D
- **BIMERS Chile** — Bentley channel partner (Synchro 4D, ProjectWise, OpenRoads). Strong alternative stack.
- **BIM Studio** — Chile's BIM Forum standard, IFC Studio platform for IFC compliance
- **CTeC** — Government innovation center, the de facto BIM training partner

**No public facing SalfaCorp / Autodesk construction digital twin demo found.** This is a **blue-ocean opportunity** for the toolkit to be a reference implementation.

---

## 7. Open Questions / Risks

1. **PSet/Room naming for IFC models** — SalfaCorp's mining/industrial uses IFC + NWC, not Revit. The DataViz heatmap requires manual room-map construction for non-Revit. **Action:** Confirm with SalfaCorp's BIM team which file types will be ingested; plan the manual room-build pipeline.

2. **SVF2 + offline / disconnected sites** — SVF2 derivatives cannot be downloaded for offline viewing (APS blog). Mining sites often have poor connectivity. **Mitigation:** Use SVF1 for offline mode; SVF2 for online. Or look at `forge-convert-utils` for offline SVF1 hosting.

3. **Multi-model dbId uniqueness** — When multiple models are loaded, dbIds are **not globally unique** across models. Need to scope all queries by `model` parameter. Verified trap.

4. **License cost of DataViz extension** — DataViz is in the standard APS Viewer SDK (no extra fee), but check the term of service for the heatmap rendering on a per-session basis.

5. **Pushpin viewer_state for DWG** — `viewer_state` is empty for `.dwg` (only Revit populates it). For 2D drawing annotations, use `snapshot_urn` instead. Verify the SalfaCorp use case is 3D or 2D.

6. **Spanish-language UI** — All Autodesk docs and most extension samples are English-only. Custom dashboard panels will need Spanish localization for field users.

---

## 8. Sources

### Tier-1 Repos (verified URLs)
- `autodesk-platform-services/aps-extensions` — https://github.com/autodesk-platform-services/aps-extensions
- `autodesk-platform-services/aps-iot-extensions-demo` — https://github.com/autodesk-platform-services/aps-iot-extensions-demo
- `Autodesk-Forge/forge-dataviz-iot-reference-app` — https://github.com/Autodesk-Forge/forge-dataviz-iot-reference-app
- `Autodesk-Forge/forge-bim360reports` — https://github.com/Autodesk-Forge/forge-bim360reports
- `autodesk-platform-services/aps-bim360-issues` — https://github.com/autodesk-platform-services/aps-bim360-issues
- `Autodesk-Forge/library-javascript-viewer-extensions` — https://github.com/Autodesk-Forge/library-javascript-viewer-extensions
- `Autodesk-Forge/forge-bim360-clashissue` — https://github.com/Autodesk-Forge/forge-bim360-clashissue
- `autodesk-platform-services/aps-powerbi-tools` — https://github.com/autodesk-platform-services/aps-powerbi-tools
- `xiaodongliang/forgeviewer_embed_in_powerbi_report` — https://github.com/xiaodongliang/forgeviewer_embed_in_powerbi_report
- `petrbroz/forge-samples-docs` — https://github.com/petrbroz/forge-samples-docs

### Autodesk Blogs (verified)
- "BIM and IoT Integration with Digital Twins" — https://aps.autodesk.com/blog/bim-and-iot-integration-digital-twins
- "Add Data Visualization Heatmaps for Rooms of non-Revit model part 1 (NWC)" — https://aps.autodesk.com/blog/add-data-visualization-heatmaps-rooms-non-revit-model-part-i-nwc
- "Customizing ModelStructurePanel behavior" — https://aps.autodesk.com/blog/customizing-modelstructurepanel-behavior-forge-viewer
- "Minimizing Viewer workloads" — https://aps.autodesk.com/blog/minimizing-viewer-workloads-loading-models-partially-selected-components-and-features-only
- "Model Derivative SVF2 enhancements — Part 1 Viewer" — https://aps.autodesk.com/blog/model-derivative-svf2-enhancements-part-1-viewer
- "Support for multiple models in new ModelStructurePanel" — https://forge.autodesk.com/blog/supporting-multiple-models-new-modelstructurepanel
- "Custom Tree Views" — https://aps.autodesk.com/blog/custom-tree-views
- "Embed APS Viewer inside Power BI report" — https://aps.autodesk.com/blog/embed-aps-viewer-inside-power-bi-report
- "BIM 360/ACC API Known Issues and Wishes" — https://fieldofviewblog.wordpress.com/2019/06/15/bim-360-acc-api-known-issues-and-wishes/

### Stack Overflow (verified citations)
- 67301779 — How to make DataViz work with IFC (case-sensitivity)
- 68389336 — Disabling heatmaps
- 68179733 — Map heatmaps to room
- 64100445 — Selecting 100K+ elements (use theming)
- 64981274 — Performance with large files
- 62257573 — Forge Viewer optimization
- 71559071 — Export markups to PDF
- 62888873 — Best approach to color objects
- 53792642 — Change Model Browser content
- 71525553 — Forge Viewer in Power BI
- 57851899 — Create pushpin issues server-side
- 67105503 — Use BIM360 PushPin extension
- 71652233 — Viewer API on BIM 360 vs ACC hub
- 79827166 — setThemingColor without object tree

### SalfaCorp Verified Sources
- https://salfacorp.com/en/compania/trayectoria-e-hitos/
- https://ctecinnovacion.cl/publicaciones/ctec-realiza-jornada-de-capacitacion-en-bim-a-las-diferentes-unidades-de-salfacorp/
- https://cl.linkedin.com/company/salfamontajes (AENOR BIM 19650 certification)
- https://www.nuevamineria.com/revista/especial-empresas-de-ingenieria-salfacorp/

### Live Demos
- https://aps-iot-extensions-demo.autodesk.io (DataViz IoT reference)
- https://visualreports.autodesk.io (forge-bim360reports dashboard)
- https://aps-extensions.autodesk.io (Extension library)
- https://awpbi.com/power-bi-aps-viewer/ (Power BI visual with 4D playback)

---

**End of report. Next action: review with SalfaCorp's BIM lead to confirm file types (RVT vs IFC vs NWC) and decide if Power BI is acceptable for Stage 4 (saves ~2 weeks).**
