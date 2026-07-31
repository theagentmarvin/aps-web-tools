/**
 * ColorLegend — inline legend showing active coloring state.
 *
 * Stage 2: color swatches for categorical properties.
 * Stage 3: gradient bar for sequential/diverging numeric properties.
 */
import { getActiveColoring, clearColoring } from "../theming-service";
import type { ScaleType } from "../theming-service";
import { useState, useEffect, useCallback } from "react";

/** Mini gradient bar for numeric scales. */
function GradientBar({ low, high }: { low: number; high: number }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <div className="flex-1 h-3 rounded-sm" style={{
        background: "linear-gradient(to right, #f7fbff, #6baed6, #2171b5, #08306b)",
      }} />
      <div className="flex justify-between text-[10px] text-gray-400 w-full">
        <span>{low.toFixed(1)}</span>
        <span>{high.toFixed(1)}</span>
      </div>
    </div>
  );
}

/** Swatch list for categorical scales. */
function SwatchList({ entries }: { entries: [string, string][] }) {
  return (
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
  );
}

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
  const scaleLabel: Record<ScaleType, string> = {
    categorical: "Categorical",
    sequential: "Numeric → gradient",
    diverging: "Numeric → diverging",
  };

  return (
    <div className="border-t border-brand-muted/20 bg-brand-surface/50 px-3 py-2">
      <div className="flex items-center justify-between mb-1.5">
        <div>
          <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
            Coloring: {coloring.propertyName}
          </h4>
          <span className="text-[9px] text-gray-400">{scaleLabel[coloring.scaleType]}</span>
        </div>
        <button
          onClick={handleClear}
          className="text-[10px] text-red-500 hover:text-red-600"
        >
          Clear
        </button>
      </div>

      {coloring.scaleType !== "categorical" && coloring.numericRange ? (
        <GradientBar low={coloring.numericRange[0]} high={coloring.numericRange[1]} />
      ) : (
        <SwatchList entries={entries} />
      )}
    </div>
  );
}
