/**
 * ElementTooltip — floating popup that shows element info on hover.
 *
 * Reference: Autodesk ObjectTooltipExtension (Stack Overflow 79133029).
 * Uses translate3d for GPU-accelerated positioning that follows 3D elements.
 */
import { useEffect, useState, useRef } from "react";
import { subscribeToTooltip } from "../tooltip-service";

interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  content: {
    name: string;
    dbId: number;
    properties: { name: string; value: string }[];
  } | null;
}

export function ElementTooltip() {
  const [state, setState] = useState<TooltipState>({
    visible: false,
    x: 0,
    y: 0,
    content: null,
  });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsub = subscribeToTooltip(setState);
    return unsub;
  }, []);

  if (!state.visible || !state.content) return null;

  // Offset: position above cursor/element so card doesn't occlude
  const offsetX = 0;
  const offsetY = -24;

  return (
    <div
      ref={ref}
      className="absolute z-50 pointer-events-none"
      style={{
        left: 0,
        top: 0,
        transform: `translate3d(${state.x + offsetX}px, ${state.y + offsetY}px, 0)`,
      }}
    >
      <div
        className="bg-gray-800/95 backdrop-blur-sm text-white rounded-lg shadow-xl border border-gray-600/50 min-w-[180px] max-w-[260px]"
      >
        {/* Header */}
        <div className="px-2.5 py-1.5 border-b border-gray-600/30">
          <p className="text-[11px] font-semibold truncate">
            {state.content.name}
          </p>
          <p className="text-[9px] text-gray-400">
            dbId: {state.content.dbId}
          </p>
        </div>

        {/* Properties */}
        {state.content.properties.length > 0 && (
          <div className="px-2.5 py-1.5">
            {state.content.properties.map((p, i) => (
              <div key={i} className="flex justify-between gap-3 py-0.5">
                <span className="text-[10px] text-gray-400 truncate">
                  {p.name}
                </span>
                <span className="text-[10px] text-gray-200 text-right truncate max-w-[120px]">
                  {p.value}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Arrow pointing down */}
        <div
          className="absolute left-1/2 -translate-x-1/2 -bottom-1.5 w-3 h-3 bg-gray-800/95 border-r border-b border-gray-600/50 rotate-45"
          style={{ backdropFilter: "blur(8px)" }}
        />
      </div>
    </div>
  );
}
