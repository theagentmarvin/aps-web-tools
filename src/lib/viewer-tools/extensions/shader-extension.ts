/**
 * ShaderExtension — native APS Viewer toolbar extension for X-Ray and Glow.
 *
 * Adds toggle buttons directly to the viewer's own toolbar.
 * Uses direct DOM click listeners on button containers (not btn.onClick
 * property, which the viewer can overwrite during toolbar assembly).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  enableXRay,
  disableXRay,
  enableGlow,
  disableGlow,
  disableAll,
  isXRayActive,
  isGlowActive,
} from "../shader-effects";

let _instance: ShaderExtension | null = null;

class ShaderExtension {
  viewer: any;
  private xrayBtn: any = null;
  private glowBtn: any = null;
  private clearBtn: any = null;
  private group: any = null;
  private cleanups: Array<() => void> = [];

  constructor(viewer: any) {
    this.viewer = viewer;
    _instance = this;
  }

  load(): boolean { return true; }

  unload(): boolean {
    _instance = null;
    this.removeToolbar();
    return true;
  }

  onToolbarCreated(toolbar: any): void {
    this.removeToolbar();
    this.createUI(toolbar);
  }

  private createUI(toolbar: any): void {
    const ADSK = (window as any).Autodesk;
    if (!ADSK?.Viewing?.UI) return;
    const Button = ADSK.Viewing.UI.Button;
    const ControlGroup = ADSK.Viewing.UI.ControlGroup;

    // ── Create buttons ──
    this.xrayBtn = new Button("shader-xray-btn");
    this.xrayBtn.setToolTip("X-Ray: select element → isolate");
    this.setIconOnButton(this.xrayBtn, "🔦");

    this.glowBtn = new Button("shader-glow-btn");
    this.glowBtn.setToolTip("Glow: select element → highlight");
    this.setIconOnButton(this.glowBtn, "✨");

    this.clearBtn = new Button("shader-clear-btn");
    this.clearBtn.setToolTip("Clear all shader effects");
    this.setIconOnButton(this.clearBtn, "✕");

    // ── Add to group and toolbar ──
    this.group = new ControlGroup("shader-toolbar");
    this.group.addControl(this.xrayBtn);
    this.group.addControl(this.glowBtn);
    this.group.addControl(this.clearBtn);
    toolbar.addControl(this.group);

    // ── Attach click handlers AFTER toolbar assembly ──
    // (btn.onClick property can be overwritten during toolbar rendering)
    const bind = (btn: any, fn: () => void) => {
      const el: HTMLElement | null = btn?.container || btn?.domElement;
      if (el) {
        const handler = (e: Event) => { e.preventDefault(); e.stopPropagation(); fn(); };
        el.addEventListener("click", handler);
        this.cleanups.push(() => el.removeEventListener("click", handler));
      }
    };

    bind(this.xrayBtn, () => this.toggleXRay());
    bind(this.glowBtn, () => this.toggleGlow());
    bind(this.clearBtn, () => this.clearAll());
  }

  private removeToolbar(): void {
    for (const c of this.cleanups) { try { c(); } catch { /* ignore */ } }
    this.cleanups = [];
    const viewer = (window as any).__apsViewer?.getViewer?.();
    if (viewer?.toolbar && this.group) {
      try { viewer.toolbar.removeControl(this.group); } catch { /* ignore */ }
    }
    this.xrayBtn = this.glowBtn = this.clearBtn = this.group = null;
  }

  private getSelection(): number[] {
    const viewer = (window as any).__apsViewer?.getViewer?.();
    return viewer?.getSelection?.() || [];
  }

  private toggleXRay(): void {
    console.log("[ShaderExtension] toggleXRay");
    if (isXRayActive()) { disableXRay(); this.updateStates(); return; }
    const sel = this.getSelection();
    if (sel.length === 0) return;
    disableGlow();
    enableXRay(sel);
    this.updateStates();
  }

  private toggleGlow(): void {
    console.log("[ShaderExtension] toggleGlow");
    if (isGlowActive()) { disableGlow(); this.updateStates(); return; }
    const sel = this.getSelection();
    if (sel.length === 0) return;
    disableXRay();
    enableGlow(sel);
    this.updateStates();
  }

  private clearAll(): void {
    console.log("[ShaderExtension] clearAll");
    disableAll();
    this.updateStates();
  }

  private updateStates(): void {
    const ADSK = (window as any).Autodesk;
    if (!ADSK?.Viewing?.UI?.Button?.State) return;
    const S = ADSK.Viewing.UI.Button.State;
    if (this.xrayBtn) this.xrayBtn.setState?.(isXRayActive() ? S.ACTIVE : S.INACTIVE);
    if (this.glowBtn) this.glowBtn.setState?.(isGlowActive() ? S.ACTIVE : S.INACTIVE);
  }

  private setIconOnButton(btn: any, text: string): void {
    try {
      if (btn.container) {
        btn.container.textContent = text;
        btn.container.style.fontSize = "14px";
      }
    } catch { /* ignore */ }
  }
}

export function registerShaderExtension(): void {
  const ADSK = (window as any).Autodesk;
  if (!ADSK?.Viewing) return;

  const Base = ADSK.Viewing.Extension;

  function ShaderExtClass(this: any, viewer: any, options: any) {
    Base.call(this, viewer, options);
    const inst = new ShaderExtension(viewer);
    this.load = () => inst.load();
    this.unload = () => inst.unload();
    this.onToolbarCreated = (t: any) => inst.onToolbarCreated(t);
  }
  ShaderExtClass.prototype = Object.create(Base.prototype);
  ShaderExtClass.prototype.constructor = ShaderExtClass;

  try {
    ADSK.Viewing.theExtensionManager?.registerExtension?.("ApsViewerToolkit.Shader", ShaderExtClass as any);
    console.log("[ShaderExtension] registered");
  } catch (e) {
    console.warn("[ShaderExtension] register failed:", e);
  }
}

export function getShaderInstance(): ShaderExtension | null { return _instance; }
