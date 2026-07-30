/**
 * ColorLegend — inline legend showing active coloring state.
 *
 * Displays when a color-by-property is active. Shows color swatches,
 * value names, and element counts. Includes a "Clear" button.
 */
import { getActiveColoring, clearColoring } from "../theming-service";
import { useState, useEffect, useCallback } from "react";

export function ColorLegend() {
  const [coloring, setColoring] = useState(getActiveColoring());
  const [, setTick] = useState(0);

  // Poll for coloring changes (theming-service is non-React)
  useEffect(() => {
    const id = setInterval(() => {
      const current = getActiveColoring();
      if (current !== coloring) {
        setColoring(current);
        setTick((t) => t + 1);
      }
    }, 500);
    return () => clearInterval(id);
  }, [coloring]);

  const handleClear = useCallback(() => {
    clearColoring();
    setColoring(null);
  }, []);

  if (!coloring) return null;

  const entries = Array.from(coloring.colorMap.entries());

  return (
    <div className="border-t border-brand-muted/20 bg-brand-surface/50 px-3 py-2">
      <div className="flex items-center justify-between mb-1.5">
        <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
          Coloring: {coloring.propertyName}
        </h4>
        <button
          onClick={handleClear}
          className="text-[10px] text-red-500 hover:text-red-600"
        >
          Clear
        </button>
      </div>
      <div className="space-y-0.5 max-h-32 overflow-y-auto">
        {entries.map(([value, color]) => (
          <div key={value} className="flex items-center gap-1.5">
            <span
              className="w-2.5 h-2.5 rounded-full flex-shrink-0 border border-black/10"
              style={{ backgroundColor: color }}
            />
            <span className="text-[11px] text-gray-600 truncate">
              {value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
