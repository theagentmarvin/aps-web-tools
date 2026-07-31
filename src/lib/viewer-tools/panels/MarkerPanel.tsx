/**
 * MarkerPanel — lists and manages 3D markers in the viewer.
 *
 * Displays all markers grouped by type (📷 Camera, 🚩 Issues, 📦 Objects, 📡 Sonar).
 * Click a marker to fly the camera to it. Delete with the × button.
 */
import { useState, useEffect, useCallback } from "react";
import {
  getMarkers,
  removeMarker,
  flyToMarker,
} from "../marker-service";
import type { Marker } from "../marker-types";
import { MARKER_ICONS, ISSUE_STATUS_COLORS } from "../marker-types";

interface Props {
  /** True when at least one model is loaded — enables marker interaction. */
  hasModel: boolean;
}

export function MarkerPanel({ hasModel }: Props) {
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [, setTick] = useState(0);

  // Poll for marker changes (service is non-React)
  useEffect(() => {
    const id = setInterval(() => {
      setMarkers(getMarkers());
    }, 500);
    return () => clearInterval(id);
  }, []);

  const handleClick = useCallback((marker: Marker) => {
    flyToMarker(marker.id);
    setTick((t) => t + 1);
  }, []);

  const handleDelete = useCallback((e: React.MouseEvent, markerId: string) => {
    e.stopPropagation();
    removeMarker(markerId);
    setMarkers(getMarkers());
  }, []);

  // Group by type
  const cameras = markers.filter((m) => m.type === "camera");
  const issues = markers.filter((m) => m.type === "issue");
  const objects = markers.filter((m) => m.type === "object");
  const sonars = markers.filter((m) => m.type === "sonar");

  const groups: { type: string; icon: string; items: Marker[] }[] = [
    { type: "Cameras", icon: MARKER_ICONS.camera, items: cameras },
    { type: "Issues", icon: MARKER_ICONS.issue, items: issues },
    { type: "Objects", icon: MARKER_ICONS.object, items: objects },
    { type: "Sonar", icon: MARKER_ICONS.sonar, items: sonars },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex-shrink-0 px-3 py-2 border-b border-brand-muted/20 bg-brand-surface">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wider">
            Markers
          </h3>
          {markers.length > 0 && (
            <span className="text-[10px] text-gray-400">{markers.length}</span>
          )}
        </div>
      </div>

      {/* No model */}
      {!hasModel && (
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-xs text-gray-400 text-center">
            Open a model to place markers.
          </p>
        </div>
      )}

      {/* No markers */}
      {hasModel && markers.length === 0 && (
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-xs text-gray-400 text-center">
            No markers yet.
            <br />
            <span className="text-[10px]">Use the toolbar to place markers in the 3D view.</span>
          </p>
        </div>
      )}

      {/* Marker list */}
      {markers.length > 0 && (
        <div className="flex-1 overflow-y-auto">
          {groups.map((group) =>
            group.items.length > 0 ? (
              <div key={group.type}>
                {/* Group header */}
                <div className="flex items-center gap-1 px-3 py-1 bg-brand-surface/50 border-b border-brand-muted/10 sticky top-0">
                  <span className="text-xs">{group.icon}</span>
                  <span className="text-[10px] font-medium text-gray-500 uppercase">
                    {group.type}
                  </span>
                  <span className="text-[10px] text-gray-400 ml-auto">
                    {group.items.length}
                  </span>
                </div>

                {/* Items */}
                <div>
                  {group.items.map((marker) => (
                    <div
                      key={marker.id}
                      onClick={() => handleClick(marker)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(marker); } }}
                      className="w-full flex items-center gap-2 px-4 py-1.5 hover:bg-brand-surface/40 text-left group cursor-pointer"
                    >
                      {/* Status dot for issues */}
                      {marker.type === "issue" && (
                        <span
                          className="w-2 h-2 rounded-full flex-shrink-0"
                          style={{
                            backgroundColor:
                              marker.color ||
                              ISSUE_STATUS_COLORS[marker.status] ||
                              "#95a5a6",
                          }}
                        />
                      )}
                      {/* Type icon for others */}
                      {marker.type !== "issue" && (
                        <span className="text-xs flex-shrink-0">
                          {MARKER_ICONS[marker.type]}
                        </span>
                      )}

                      <span className="text-[11px] text-gray-700 truncate flex-1">
                        {marker.label}
                      </span>

                      <button
                        onClick={(e) => handleDelete(e, marker.id)}
                        className="opacity-0 group-hover:opacity-100 text-[10px] text-gray-400 hover:text-red-500 flex-shrink-0"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}
