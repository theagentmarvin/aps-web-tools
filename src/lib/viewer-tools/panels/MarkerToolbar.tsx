/**
 * MarkerToolbar — floating toolbar to place 3D markers in the viewer.
 *
 * Click a marker type button → enters "placement mode". Click anywhere on
 * the model canvas → raycast to get world coordinates → add the marker.
 * Press Escape or click the active button again to cancel.
 *
 * Marker types:
 *   📷 Camera — saved viewpoint with optional screenshot
 *   🚩 Issue  — issue/RFI flag with status
 *   📦 Object — link to a dbId with optional property display
 *   📡 Sonar  — animated radar pulse ring
 */
import { useState, useRef, useCallback, useEffect } from "react";
import {
  addCameraMarker,
  addIssueMarker,
  addObjectMarker,
  addSonarMarker,
} from "../marker-service";
import { MARKER_ICONS } from "../marker-types";

type MarkerKind = "camera" | "issue" | "object" | "sonar";

interface Props {
  hasModel: boolean;
}

export function MarkerToolbar({ hasModel }: Props) {
  const [activeKind, setActiveKind] = useState<MarkerKind | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [clickPoint, setClickPoint] = useState<{ x: number; y: number; z: number } | null>(null);
  const [label, setLabel] = useState("");
  const [status, setStatus] = useState("open");
  const cancelRef = useRef(false);

  // ── Raycast on canvas click (placement mode) ──────────────────

  const handleCanvasClick = useCallback(
    (e: MouseEvent) => {
      if (!activeKind || cancelRef.current) return;

      const api = (window as unknown as Record<string, unknown>).__apsViewer as {
        getViewer?: () => {
          clientToWorld?: (x: number, y: number) => { point: { x: number; y: number; z: number } } | null;
          // Alternative: use hitTest
          impl?: { hitTest?: (x: number, y: number, ignoreTransparent?: boolean) => { intersectPoint?: { x: number; y: number; z: number }; dbId?: number } | null };
        };
      } | undefined;

      const viewer = api?.getViewer?.();
      if (!viewer) return;

      // Try hitTest first (returns dbId + intersect point)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hit = (viewer.impl as any)?.hitTest?.(e.offsetX, e.offsetY, false);
      if (hit && hit.intersectPoint) {
        setClickPoint(hit.intersectPoint);
        setShowForm(true);
        setLabel("");
        return;
      }

      // Fallback: clientToWorld (less precise, uses far plane)
      const world = viewer.clientToWorld?.(e.offsetX, e.offsetY);
      if (world?.point) {
        setClickPoint(world.point);
        setShowForm(true);
        setLabel("");
      }
    },
    [activeKind],
  );

  // ── Attach/detach canvas click listener ───────────────────────

  useEffect(() => {
    if (!activeKind || !hasModel) return;

    // Find the viewer canvas
    const canvas = document.querySelector("canvas");
    if (!canvas) return;

    cancelRef.current = false;
    canvas.style.cursor = "crosshair";

    const handler = (e: Event) => handleCanvasClick(e as MouseEvent);
    canvas.addEventListener("click", handler);

    // Cancel on Escape
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cancelRef.current = true;
        setActiveKind(null);
        setShowForm(false);
      }
    };
    window.addEventListener("keydown", keyHandler);

    return () => {
      canvas.removeEventListener("click", handler);
      canvas.style.cursor = "";
      window.removeEventListener("keydown", keyHandler);
    };
  }, [activeKind, hasModel, handleCanvasClick]);

  // ── Toggle placement mode ─────────────────────────────────────

  const selectKind = useCallback((kind: MarkerKind) => {
    if (activeKind === kind) {
      // Cancel placement
      cancelRef.current = true;
      setActiveKind(null);
      setShowForm(false);
    } else {
      cancelRef.current = false;
      setActiveKind(kind);
      setShowForm(false);
    }
  }, [activeKind]);

  // ── Submit marker ─────────────────────────────────────────────

  const handleSubmit = useCallback(() => {
    if (!clickPoint || !activeKind) return;

    const name = label.trim() || getDefaultLabel(activeKind);

    switch (activeKind) {
      case "camera":
        addCameraMarker({ position: clickPoint, label: name });
        break;
      case "issue":
        addIssueMarker({
          position: clickPoint,
          label: name,
          issueId: `ISS-${Date.now()}`,
          status: status as "open" | "answered" | "closed" | "void" | "draft",
        });
        break;
      case "object":
        addObjectMarker({ position: clickPoint, label: name, dbId: 0 });
        break;
      case "sonar":
        addSonarMarker({ position: clickPoint, label: name });
        break;
    }

    setShowForm(false);
    setActiveKind(null);
    setClickPoint(null);
  }, [clickPoint, activeKind, label, status]);

  // ── Render ────────────────────────────────────────────────────

  if (!hasModel) return null;

  const kinds: { kind: MarkerKind; icon: string; title: string }[] = [
    { kind: "camera", icon: MARKER_ICONS.camera, title: "Camera marker" },
    { kind: "issue", icon: MARKER_ICONS.issue, title: "Issue marker" },
    { kind: "object", icon: MARKER_ICONS.object, title: "Object marker" },
    { kind: "sonar", icon: MARKER_ICONS.sonar, title: "Sonar marker" },
  ];

  return (
    <div className="absolute bottom-3 left-[280px] z-20 flex flex-col gap-1">
      {/* Toolbar buttons */}
      <div className="flex gap-1">
        {kinds.map(({ kind, icon, title }) => (
          <button
            key={kind}
            onClick={() => selectKind(kind)}
            className={`text-sm w-8 h-8 rounded border flex items-center justify-center transition-colors ${
              activeKind === kind
                ? "bg-brand text-white border-brand shadow-md scale-110"
                : "bg-white/90 text-gray-500 border-brand-muted/30 hover:border-brand/50 hover:text-brand"
            }`}
            title={title}
          >
            {icon}
          </button>
        ))}
      </div>

      {/* Placement hint */}
      {activeKind && !showForm && (
        <div className="text-[10px] text-gray-400 bg-white/90 px-2 py-1 rounded border border-brand-muted/20 whitespace-nowrap">
          Click on the model to place a {activeKind} marker · Press Esc to cancel
        </div>
      )}

      {/* Marker form */}
      {showForm && activeKind && (
        <div className="bg-white/95 rounded border border-brand-muted/30 shadow-lg p-2 w-48">
          <div className="flex items-center gap-1 mb-2">
            <span className="text-xs">{MARKER_ICONS[activeKind]}</span>
            <span className="text-[10px] font-medium text-gray-600 uppercase">
              New {activeKind} marker
            </span>
          </div>

          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={getDefaultLabel(activeKind)}
            className="w-full text-xs px-2 py-1 rounded border border-brand-muted/20 mb-1.5 focus:outline-none focus:border-brand/50"
            autoFocus
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          />

          {activeKind === "issue" && (
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-full text-xs px-2 py-1 rounded border border-brand-muted/20 mb-1.5"
            >
              <option value="open">Open</option>
              <option value="answered">Answered</option>
              <option value="closed">Closed</option>
              <option value="draft">Draft</option>
              <option value="void">Void</option>
            </select>
          )}

          <div className="flex gap-1 mt-1">
            <button
              onClick={handleSubmit}
              className="flex-1 text-[10px] px-2 py-1 rounded bg-brand text-white hover:bg-brand-light"
            >
              Place
            </button>
            <button
              onClick={() => {
                setShowForm(false);
                setActiveKind(null);
              }}
              className="text-[10px] px-2 py-1 rounded border border-brand-muted/20 text-gray-500 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {clickPoint && !showForm && (
        <div className="text-[9px] text-gray-300 font-mono truncate max-w-[200px]">
          ({clickPoint.x.toFixed(1)}, {clickPoint.y.toFixed(1)}, {clickPoint.z.toFixed(1)})
        </div>
      )}
    </div>
  );
}

function getDefaultLabel(kind: MarkerKind): string {
  switch (kind) {
    case "camera": return "Viewpoint";
    case "issue": return "Issue";
    case "object": return "Object";
    case "sonar": return "Scan";
  }
}
