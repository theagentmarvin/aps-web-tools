/**
 * PropertyPanel — Tandem-style property discovery sidebar.
 *
 * Shows when a model is loaded. Discovers all properties, groups by category,
 * expands to show value distribution. Stage 1 — discovery only (no coloring yet).
 */
import { useState, useEffect, useCallback } from "react";
import { discoverProperties } from "../property-service";
import { isNumericProperty } from "../color-scales";
import { applyColorByProperty, getActiveColoring } from "../theming-service";
import { renderCategoryHeatmap, clearHeatmap, getCurrentHeatmap } from "../category-heatmap";
import type { PropertyDef, ApsViewerAPI } from "../types";

interface Props {
  /** True when at least one model is loaded in the viewer. */
  hasModel: boolean;
}

export function PropertyPanel({ hasModel }: Props) {
  const [properties, setProperties] = useState<PropertyDef[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [coloringProperty, setColoringProperty] = useState<string | null>(null);
  const [heatmapProperty, setHeatmapProperty] = useState<string | null>(null);

  // Poll active coloring state
  useEffect(() => {
    const id = setInterval(() => {
      const active = getActiveColoring();
      const heatmap = getCurrentHeatmap();
      setColoringProperty(active?.propertyName || null);
      setHeatmapProperty(heatmap?.registration?.category || null);
    }, 500);
    return () => clearInterval(id);
  }, []);

  const handleColorByProperty = useCallback((propName: string) => {
    applyColorByProperty(
      propName,
      "categorical",
      () => {},
      () => {},
    );
  }, []);

  const handleHeatmapByProperty = useCallback((propName: string) => {
    clearHeatmap();
    renderCategoryHeatmap(
      propName,
      "sequential",
      (msg) => setProgress(msg),
      () => setProgress(""),
    );
  }, []);

  const runDiscovery = useCallback(() => {
    const api = (window as unknown as Record<string, ApsViewerAPI>).__apsViewer;
    if (!api) {
      setError("Viewer not ready");
      return;
    }

    const viewer = api.getViewer() as Record<string, unknown>;
    const models = api.getModels() as Array<Record<string, unknown>>;
    if (!viewer || !models?.length) {
      setError("No model loaded");
      return;
    }

    setLoading(true);
    setError(null);
    setProperties([]);

    discoverProperties(
      viewer,
      models[0], // Use first loaded model
      (msg) => setProgress(msg),
      (props) => {
        setProperties(props);
        setLoading(false);
        setProgress("");
      },
    );
  }, []);

  // Auto-discover when model becomes available
  useEffect(() => {
    if (!hasModel) return;
    // Delay to let the viewer fully initialize
    const t = setTimeout(runDiscovery, 1000);
    return () => clearTimeout(t);
  }, [hasModel, runDiscovery]);

  const toggleExpanded = (propName: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(propName)) next.delete(propName);
      else next.add(propName);
      return next;
    });
  };

  const toggleCategory = (cat: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  // Group properties by category
  const byCategory = new Map<string, PropertyDef[]>();
  for (const p of properties) {
    const cat = p.category || "Other";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(p);
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex-shrink-0 px-3 py-2 border-b border-brand-muted/20 bg-brand-surface">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wider">
            Properties
          </h3>
          {properties.length > 0 && (
            <span className="text-[10px] text-gray-400">{properties.length}</span>
          )}
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex-1 flex flex-col items-center justify-center p-4 text-center">
          <div className="animate-spin text-lg mb-2">⏳</div>
          <p className="text-xs text-gray-500">{progress || "Discovering properties…"}</p>
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="p-3 m-2 rounded border border-red-200 bg-red-50">
          <p className="text-xs text-red-600">{error}</p>
          <button
            onClick={runDiscovery}
            className="mt-1 text-[10px] text-red-500 underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* No model */}
      {!hasModel && !loading && (
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-xs text-gray-400 text-center">
            Open a model to discover its properties.
          </p>
        </div>
      )}

      {/* Property list */}
      {properties.length > 0 && (
        <div className="flex-1 overflow-y-auto">
          {Array.from(byCategory.entries()).map(([cat, catProps]) => (
            <div key={cat}>
              {/* Category header */}
              <button
                onClick={() => toggleCategory(cat)}
                className="w-full flex items-center gap-1 px-3 py-1.5 bg-brand-surface/50 hover:bg-brand-surface text-left sticky top-0 border-b border-brand-muted/10"
              >
                <span className="text-[10px] text-gray-400">
                  {collapsedCategories.has(cat) ? "▶" : "▼"}
                </span>
                <span className="text-[11px] font-medium text-gray-500 uppercase">
                  {cat}
                </span>
                <span className="text-[10px] text-gray-400 ml-auto">{catProps.length}</span>
              </button>

              {!collapsedCategories.has(cat) && (
                <div>
                  {catProps.map((prop) => (
                    <div key={prop.name}>
                      {/* Property row */}
                      <button
                        onClick={() => toggleExpanded(prop.name)}
                        className={`w-full flex items-center gap-2 px-4 py-1.5 hover:bg-brand-surface/40 text-left ${
                          coloringProperty === prop.name ? "bg-brand/10" : ""
                        }`}
                      >
                        <span className="text-[10px] text-gray-400">
                          {expanded.has(prop.name) ? "▼" : "▶"}
                        </span>
                        <span className="text-xs text-gray-700 truncate flex-1">
                          {prop.name}
                        </span>
                        <span className="text-[10px] text-gray-400 flex-shrink-0">
                          {prop.values.length} values
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleColorByProperty(prop.name);
                          }}
                          className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                            coloringProperty === prop.name
                              ? "bg-brand text-white border-brand"
                              : "border-brand-muted/30 text-gray-400 hover:text-brand hover:border-brand/50"
                          }`}
                          title="Color model by this property"
                        >
                          {coloringProperty === prop.name ? "Colored" : "Color"}
                        </button>
                        {isNumericProperty(prop.values.map((v) => v.value)) && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleHeatmapByProperty(prop.name);
                            }}
                            className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                              heatmapProperty === prop.name
                                ? "bg-brand text-white border-brand"
                                : "border-brand-muted/30 text-gray-400 hover:text-orange-500 hover:border-orange-400/50"
                            }`}
                            title="Heatmap — gradient coloring by numeric value"
                          >
                            {heatmapProperty === prop.name ? "🔥 Active" : "🔥 Heatmap"}
                          </button>
                        )}
                      </button>

                      {/* Expanded: value list */}
                      {expanded.has(prop.name) && (
                        <div className="pl-8 pr-3 pb-1">
                          {prop.values.slice(0, 15).map((v) => (
                            <div
                              key={v.value}
                              className="flex items-center gap-2 py-0.5 text-[11px]"
                            >
                              <span className="flex-1 text-gray-600 truncate">
                                {v.value || "(empty)"}
                              </span>
                              <span className="text-gray-400 flex-shrink-0">
                                {v.count.toLocaleString()}
                              </span>
                            </div>
                          ))}
                          {prop.values.length > 15 && (
                            <p className="text-[10px] text-gray-400 mt-0.5">
                              +{prop.values.length - 15} more values
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
