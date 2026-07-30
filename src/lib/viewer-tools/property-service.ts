/**
 * Property Service — discovers and queries model properties.
 *
 * Pure functions that wrap the APS Viewer SDK's property APIs.
 * All functions require a viewer + model reference (obtained from window.__apsViewer).
 */

import type { PropertyDef, PropertyValue } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GuiViewer3D = any;

// ── Leaf Node Enumeration ────────────────────────────────────────────

/**
 * Get all leaf node dbIds from a model's instance tree.
 * Leaf nodes = elements with no children (actual geometry, not categories).
 */
export function getLeafNodes(model: { getInstanceTree: () => { getRootId: () => number; getChildCount: (id: number) => number; enumNodeChildren: (id: number, cb: (dbId: number) => void, recursive: boolean) => void } }): number[] {
  const tree = model.getInstanceTree();
  const dbIds: number[] = [];
  const rootId = tree.getRootId();

  function walk(nodeId: number) {
    const childCount = tree.getChildCount(nodeId);
    if (childCount === 0) {
      dbIds.push(nodeId);
      return;
    }
    tree.enumNodeChildren(nodeId, (childId: number) => walk(childId), false);
  }
  walk(rootId);

  return dbIds;
}

// ── Property Discovery ───────────────────────────────────────────────

/**
 * Discover all properties in a model by sampling leaf nodes.
 *
 * Strategy: sample ~500 leaf nodes, batch-get their properties,
 * aggregate unique (category, name) pairs, then count occurrence across all elements.
 */
export function discoverProperties(
  viewer: GuiViewer3D,
  model: unknown,
  onProgress: (message: string) => void,
  onComplete: (properties: PropertyDef[]) => void,
): void {
  onProgress("Enumerating elements…");

  const allDbIds = getLeafNodes(model as Parameters<typeof getLeafNodes>[0]);

  if (allDbIds.length === 0) {
    onComplete([]);
    return;
  }

  onProgress(`Found ${allDbIds.length} elements. Reading properties…`);

  // Phase 1: sample a subset to discover property names
  const sampleSize = Math.min(500, allDbIds.length);
  const step = Math.max(1, Math.floor(allDbIds.length / sampleSize));
  const sampleDbIds = allDbIds.filter((_, i) => i % step === 0);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (viewer as any).model.getBulkProperties2(
    sampleDbIds,
    { ignoreHidden: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (results: any[]) => {
      // Build (category, name) → values set map
      const propMap = new Map<string, { category: string; values: Set<string> }>();

      for (const elem of results) {
        for (const prop of (elem.properties || [])) {
          const key = `${prop.displayCategory}::${prop.displayName}`;
          let entry = propMap.get(key);
          if (!entry) {
            entry = { category: prop.displayCategory || "Other", values: new Set() };
            propMap.set(key, entry);
          }
          entry.values.add(String(prop.displayValue ?? ""));
        }
      }

      const propertyNames = Array.from(propMap.entries()).map(([key, entry]) => ({
        name: key.split("::")[1],
        category: entry.category,
        values: Array.from(entry.values).slice(0, 50), // cap unique values for discovery
      }));

      onProgress(`Found ${propertyNames.length} properties. Counting values…`);

      // Phase 2: count values across ALL leaf nodes using smaller batches
      const batchSize = 200;
      const totals = new Map<string, Map<string, number>>();

      for (const pn of propertyNames) {
        totals.set(pn.name, new Map());
      }

      function processBatch(startIdx: number) {
        const batch = allDbIds.slice(startIdx, startIdx + batchSize);
        if (batch.length === 0) {
          // Done — build result
          const props: PropertyDef[] = propertyNames.map((pn) => {
            const valueMap = totals.get(pn.name)!;
            const values: PropertyValue[] = Array.from(valueMap.entries())
              .sort((a, b) => b[1] - a[1])
              .slice(0, 30)
              .map(([value, count]) => ({ value, count }));
            return {
              name: pn.name,
              category: pn.category,
              elementCount: allDbIds.length,
              values,
            };
          });

          // Sort by category then name
          props.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

          onComplete(props);
          return;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (viewer as any).model.getBulkProperties2(
          batch,
          { ignoreHidden: true },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (batchResults: any[]) => {
            for (const elem of batchResults) {
              for (const prop of (elem.properties || [])) {
                const valueMap = totals.get(prop.displayName);
                if (valueMap) {
                  const val = String(prop.displayValue ?? "(empty)");
                  valueMap.set(val, (valueMap.get(val) || 0) + 1);
                }
              }
            }
            // Schedule next batch (yield to UI thread)
            setTimeout(() => processBatch(startIdx + batchSize), 0);
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (err: any) => {
            console.error("[property-service] batch error:", err);
            setTimeout(() => processBatch(startIdx + batchSize), 0);
          },
        );
      }

      processBatch(0);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (err: any) => {
      console.error("[property-service] discovery error:", err);
      onComplete([]);
    },
  );
}

// ── Get Properties for Specific dbIds ─────────────────────────────────

/**
 * Get properties for a specific set of dbIds (used when filtering/coloring).
 * Returns map of dbId → property value.
 */
export function getPropertyForElements(
  viewer: GuiViewer3D,
  dbIds: number[],
  propertyName: string,
  callback: (map: Map<number, string>) => void,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (viewer as any).model.getBulkProperties2(
    dbIds,
    { ignoreHidden: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (results: any[]) => {
      const map = new Map<number, string>();
      for (const elem of results) {
        const prop = (elem.properties || []).find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (p: any) => p.displayName === propertyName,
        );
        map.set(elem.dbId, String(prop?.displayValue ?? ""));
      }
      callback(map);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (err: any) => {
      console.error("[property-service] getPropertyForElements error:", err);
      callback(new Map());
    },
  );
}
