/**
 * ShaderToolbar — floating toggle buttons for X-Ray and Glow effects.
 *
 * Appears when a model is loaded. X-Ray isolation: dims everything except
 * selection. Glow: bright fresnel highlight on selection.
 */
import { useState, useCallback } from "react";
import {
  enableXRay,
  disableXRay,
  enableGlow,
  disableGlow,
  disableAll,
} from "../shader-effects";

interface Props {
  /** True when at least one model is loaded. */
  hasModel: boolean;
}

export function ShaderToolbar({ hasModel }: Props) {
  const [xrayOn, setXrayOn] = useState(false);
  const [glowOn, setGlowOn] = useState(false);

  const toggleXRay = useCallback(() => {
    if (xrayOn) {
      disableXRay();
      setXrayOn(false);
    } else {
      // Use current viewer selection
      const api = (window as unknown as Record<string, unknown>).__apsViewer as
        { getViewer?: () => { getSelection?: () => number[] } } | undefined;
      const viewer = api?.getViewer?.();
      const selection = viewer?.getSelection?.() || [];
      if (selection.length === 0) return;
      enableXRay(selection);
      setXrayOn(true);
      setGlowOn(false);
    }
  }, [xrayOn]);

  const toggleGlow = useCallback(() => {
    if (glowOn) {
      disableGlow();
      setGlowOn(false);
    } else {
      const api = (window as unknown as Record<string, unknown>).__apsViewer as
        { getViewer?: () => { getSelection?: () => number[] } } | undefined;
      const viewer = api?.getViewer?.();
      const selection = viewer?.getSelection?.() || [];
      if (selection.length === 0) return;
      enableGlow(selection);
      setGlowOn(true);
      setXrayOn(false);
    }
  }, [glowOn]);

  const clearAll = useCallback(() => {
    disableAll();
    setXrayOn(false);
    setGlowOn(false);
  }, []);

  if (!hasModel) return null;

  return (
    <div className="absolute bottom-3 left-3 z-20 flex gap-1.5">
      {/* X-Ray */}
      <button
        onClick={toggleXRay}
        className={`text-[10px] px-2 py-1 rounded border transition-colors ${
          xrayOn
            ? "bg-brand text-white border-brand shadow-md"
            : "bg-white/90 text-gray-500 border-brand-muted/30 hover:border-brand/50 hover:text-brand"
        }`}
        title="X-Ray: select an element first, then click to isolate"
      >
        🔦 X-Ray
      </button>

      {/* Glow */}
      <button
        onClick={toggleGlow}
        className={`text-[10px] px-2 py-1 rounded border transition-colors ${
          glowOn
            ? "bg-brand text-white border-brand shadow-md"
            : "bg-white/90 text-gray-500 border-brand-muted/30 hover:border-brand/50 hover:text-brand"
        }`}
        title="Glow: select an element first, then click to highlight"
      >
        ✨ Glow
      </button>

      {/* Clear */}
      {(xrayOn || glowOn) && (
        <button
          onClick={clearAll}
          className="text-[10px] px-2 py-1 rounded border border-red-200 bg-white/90 text-red-500 hover:bg-red-50"
        >
          ✕ Clear
        </button>
      )}
    </div>
  );
}
