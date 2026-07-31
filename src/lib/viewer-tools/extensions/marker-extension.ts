/**
 * MarkerExtension — native APS Viewer toolbar extension for 3D markers + KPI cards.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  placeKpiCard,
  addCameraMarker,
  addIssueMarker,
  addObjectMarker,
  addSonarMarker,
  toggleCardsVisibility,

} from "../marker-service";
// KPI icons inline, no longer needed from marker-types

type MarkerKind = "camera" | "issue" | "object" | "sonar" | "kpi";

class MarkerExtension {
  viewer: any;
  private buttons: Array<{ kind: MarkerKind; btn: any; cleanup: () => void }> = [];
  private group: any = null;
  private activeKind: MarkerKind | null = null;
  private clickHandler: ((e: MouseEvent) => void) | null = null;
  private canvasEl: HTMLElement | null = null;
  private kpiForm: HTMLElement | null = null;
  private kpiPoint: { x: number; y: number; z: number } | null = null;

  constructor(viewer: any) { this.viewer = viewer; }
  load(): boolean { return true; }
  unload(): boolean { this.cancelPlacement(); this.removeToolbar(); return true; }
  onToolbarCreated(toolbar: any): void { this.removeToolbar(); this.createUI(toolbar); }

  private createUI(toolbar: any): void {
    const ADSK = (window as any).Autodesk;
    if (!ADSK?.Viewing?.UI) return;
    const Button = ADSK.Viewing.UI.Button;
    const ControlGroup = ADSK.Viewing.UI.ControlGroup;

    const kinds: Array<{ kind: MarkerKind; icon: string; tip: string }> = [
      { kind: "camera", icon: "📷", tip: "Place camera marker" },
      { kind: "issue", icon: "🚩", tip: "Place issue marker" },
      { kind: "object", icon: "📦", tip: "Place object marker" },
      { kind: "sonar", icon: "📡", tip: "Place sonar marker" },
      { kind: "kpi", icon: "📊", tip: "Place KPI card (status + progress)" },
    ];

    this.group = new ControlGroup("marker-toolbar");

    for (const { kind, icon, tip } of kinds) {
      const btn = new Button(`marker-${kind}-btn`);
      btn.setToolTip(tip);
      this.setIconOnButton(btn, icon);
      this.buttons.push({ kind, btn, cleanup: () => {} });
      (this.group as any).addControl(btn);
    }

    toolbar.addControl(this.group);

    // ── Toggle Cards button ──
    const toggleBtn = new Button("toggle-cards-btn");
    toggleBtn.setToolTip("Show/Hide all placed KPI cards");
    const toggleLabel = document.createElement("span");
    toggleLabel.textContent = "👁";
    toggleLabel.style.fontSize = "14px";
    try { toggleBtn.setContent(toggleLabel); } catch {} 
    const toggleGroup = new ControlGroup("toggle-cards-toolbar");
    toggleGroup.addControl(toggleBtn);
    toolbar.addControl(toggleGroup);
    const toggleEl = toggleBtn.container || toggleBtn.domElement;
    if (toggleEl) {
      toggleEl.addEventListener("click", function(e: Event) { e.preventDefault(); e.stopPropagation(); toggleCardsVisibility(); });
    }
    // Attach DOM click handlers AFTER toolbar assembly
    for (const entry of this.buttons) {
      const { kind, btn } = entry;
      const el = (btn as any).container || (btn as any).domElement;
      if (el) {
        const handler = (e: Event) => { e.preventDefault(); e.stopPropagation(); this.toggleKind(kind); };
        el.addEventListener("click", handler);
        entry.cleanup = () => el.removeEventListener("click", handler);
      }
    }
  }

  private removeToolbar(): void {
    for (const { cleanup } of this.buttons) { try { cleanup(); } catch { /* ignore */ } }
    this.buttons = [];
    const viewer = (window as any).__apsViewer?.getViewer?.();
    if (viewer?.toolbar && this.group) {
      try { viewer.toolbar.removeControl(this.group); } catch { /* ignore */ }
    }
    this.group = null;
  }

  private toggleKind(kind: MarkerKind): void {
    console.log("[MarkerExtension] toggleKind:", kind);
    const ADSK = (window as any).Autodesk;
    if (this.activeKind === kind) { this.cancelPlacement(); return; }
    this.cancelPlacement();
    this.activeKind = kind;

    if (ADSK?.Viewing?.UI?.Button?.State) {
      const S = ADSK.Viewing.UI.Button.State;
      for (const { kind: k, btn } of this.buttons) {
        btn.setState?.(k === kind ? S.ACTIVE : S.INACTIVE);
      }
    }
    this.startListening();
  }

  private startListening(): void {
    const api = (window as any).__apsViewer;
    const viewer = api?.getViewer?.();
    const container = viewer?.container || viewer?.impl?.getCanvas()?.parentElement || null;
    this.canvasEl = container?.querySelector?.("canvas") ?? document.querySelector("canvas");
    if (!this.canvasEl) { this.cancelPlacement(); return; }
    this.canvasEl.style.cursor = "crosshair";
    this.clickHandler = (e: MouseEvent) => this.placeMarker(e);
    this.canvasEl.addEventListener("click", this.clickHandler);
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") { this.cancelPlacement(); window.removeEventListener("keydown", esc); }
    };
    window.addEventListener("keydown", esc);
  }

  private placeMarker(e: MouseEvent): void {
    const api = (window as any).__apsViewer;
    const viewer = api?.getViewer?.();
    if (!viewer || !this.activeKind) return;

    let point: { x: number; y: number; z: number } | null = null;
    try { const hit = viewer.impl?.hitTest?.(e.offsetX, e.offsetY, false); if (hit?.intersectPoint) point = hit.intersectPoint; } catch {}

    if (!point) {
      try { const w = viewer.clientToWorld?.(e.offsetX, e.offsetY); if (w?.point) point = w.point; } catch {}
    }
    if (!point) { this.cancelPlacement(); return; }

    if (this.activeKind === "kpi") {
      // Show KPI form instead of immediately placing
      this.kpiPoint = point;
      this.showKpiForm(e.clientX, e.clientY);
      return;
    }

    const label = this.defaultLabel();
    switch (this.activeKind) {
      case "camera": addCameraMarker({ position: point, label }); break;
      case "issue": addIssueMarker({ position: point, label, issueId: `ISS-${Date.now()}`, status: "open" }); break;
      case "object": addObjectMarker({ position: point, label, dbId: 0 }); break;
      case "sonar": addSonarMarker({ position: point, label }); break;
    }
    console.log("[MarkerExtension] marker placed:", this.activeKind);
    this.cancelPlacement();
  }

  private showKpiForm(cx: number, cy: number): void {
    this.removeKpiForm();

    const form = document.createElement("div");
    form.id = "kpi-placement-form";
    form.style.cssText = `
      position:fixed;z-index:200;left:${cx}px;top:${cy}px;
      background:rgba(30,30,30,0.95);color:#fff;border:1px solid rgba(255,255,255,0.15);
      border-radius:10px;padding:12px 14px;font:13px -apple-system,sans-serif;
      min-width:200px;box-shadow:0 4px 16px rgba(0,0,0,0.4);
      transform:translate(-50%,-120%);
    `;

    form.innerHTML = `
      <div style="font-weight:600;margin-bottom:8px;font-size:14px;">📊 New KPI Card</div>
      <input id="kpi-title" placeholder="Title (e.g. IWP-12)" style="width:100%;margin-bottom:6px;padding:4px 6px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:#fff;font-size:12px;box-sizing:border-box;">
      <select id="kpi-status" style="width:100%;margin-bottom:6px;padding:4px 6px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:#fff;font-size:12px;box-sizing:border-box;">
        <option value="">Status (none)</option>
        <option value="completed">Completed</option>
        <option value="in_progress">In Progress</option>
        <option value="pending">Pending</option>
        <option value="blocked">Blocked</option>
      </select>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
        <span style="font-size:10px;color:#aaa;">Progress:</span>
        <input id="kpi-progress" type="range" min="0" max="100" value="0" style="flex:1;">
        <span id="kpi-progress-val" style="font-size:10px;color:#aaa;width:30px;">0%</span>
      </div>
      <textarea id="kpi-desc" placeholder="Description (optional)" rows="2" style="width:100%;margin-bottom:6px;padding:4px 6px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:#fff;font-size:11px;box-sizing:border-box;resize:none;"></textarea>
      <div style="display:flex;gap:6px;justify-content:flex-end;">
        <button id="kpi-cancel" style="padding:4px 12px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.15);border-radius:4px;color:#aaa;font-size:11px;cursor:pointer;">Cancel</button>
        <button id="kpi-submit" style="padding:4px 12px;background:#27ae60;border:none;border-radius:4px;color:#fff;font-size:11px;cursor:pointer;font-weight:600;">Place</button>
      </div>
    `;

    document.body.appendChild(form);
    this.kpiForm = form;

    // Progress slider sync
    const progInput = form.querySelector("#kpi-progress") as HTMLInputElement;
    const progVal = form.querySelector("#kpi-progress-val") as HTMLElement;
    progInput?.addEventListener("input", () => { if (progVal) progVal.textContent = progInput.value + "%"; });

    // Buttons
    form.querySelector("#kpi-cancel")?.addEventListener("click", () => this.cancelPlacement());
    form.querySelector("#kpi-submit")?.addEventListener("click", () => {
      const title = (form.querySelector("#kpi-title") as HTMLInputElement)?.value?.trim() || "KPI";
      const status = (form.querySelector("#kpi-status") as HTMLSelectElement)?.value || "";
      const progress = parseInt((form.querySelector("#kpi-progress") as HTMLInputElement)?.value || "0", 10);
      const desc = (form.querySelector("#kpi-desc") as HTMLTextAreaElement)?.value?.trim() || "";

      if (this.kpiPoint) {
        // placeKpiCard now calls showInfoCardById synchronously after
        // rebuilding markupItems, so the info card is visible immediately.
        placeKpiCard(this.kpiPoint, { title, status, progress, description: desc });
        console.log("[MarkerExtension] KPI placed:", title, status, progress + "%");
      }
      this.cancelPlacement();
    });

    // Focus title
    setTimeout(() => (form.querySelector("#kpi-title") as HTMLInputElement)?.focus(), 50);
  }

  private removeKpiForm(): void {
    if (this.kpiForm) { this.kpiForm.remove(); this.kpiForm = null; }
    this.kpiPoint = null;
  }

  private cancelPlacement(): void {
    if (this.canvasEl && this.clickHandler) {
      this.canvasEl.removeEventListener("click", this.clickHandler);
      this.canvasEl.style.cursor = "";
    }
    this.clickHandler = null;
    this.canvasEl = null;
    this.activeKind = null;
    this.removeKpiForm();

    const ADSK = (window as any).Autodesk;
    if (ADSK?.Viewing?.UI?.Button?.State) {
      const S = ADSK.Viewing.UI.Button.State;
      for (const { btn } of this.buttons) { btn.setState?.(S.INACTIVE); }
    }
  }

  private defaultLabel(): string {
    switch (this.activeKind) {
      case "camera": return "Viewpoint";
      case "issue": return "Issue";
      case "object": return "Object";
      case "sonar": return "Scan";
      default: return "Marker";
    }
  }

  private setIconOnButton(btn: any, text: string): void {
    try {
      if (btn.container) { btn.container.textContent = text; btn.container.style.fontSize = "14px"; }
    } catch {}
  }
}

export function registerMarkerExtension(): void {
  const ADSK = (window as any).Autodesk;
  if (!ADSK?.Viewing) return;
  const Base = ADSK.Viewing.Extension;

  function MarkerExtClass(this: any, viewer: any, options: any) {
    Base.call(this, viewer, options);
    const inst = new MarkerExtension(viewer);
    this.load = () => inst.load();
    this.unload = () => inst.unload();
    this.onToolbarCreated = (t: any) => inst.onToolbarCreated(t);
  }
  MarkerExtClass.prototype = Object.create(Base.prototype);
  MarkerExtClass.prototype.constructor = MarkerExtClass;

  try {
    ADSK.Viewing.theExtensionManager?.registerExtension?.("ApsViewerToolkit.Marker", MarkerExtClass as any);
    console.log("[MarkerExtension] registered");
  } catch (e) { console.warn("[MarkerExtension] register failed:", e); }
}
