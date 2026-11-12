/**
 * "Qué sigue" / Flujos glue (WS-N): URLs of human steps and the app-wide events that open the Flujos
 * drawer. A step's action comes from the server (server/next-steps.ts).
 */
import type { NextStepAction } from "~/lib/api/types";

export const OPEN_FLOWS_EVENT = "coord:open-flows";
/** Fired after a flow starts / ends so cards and the nav badge reload. */
export const FLOWS_CHANGED_EVENT = "coord:flows-changed";

export function openFlows(runId?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_FLOWS_EVENT, { detail: { runId } }));
}

export function flowsChanged(): void {
  window.dispatchEvent(new Event(FLOWS_CHANGED_EVENT));
}

const enc = encodeURIComponent;

/** In-app URL of a human step (null = handled in place, e.g. the agent-update dialog). */
export function stepHref(a: NextStepAction): string | null {
  if (a.type !== "open") return null;
  const p = a.params;
  switch (a.route) {
    case "triage": {
      if (!p.projectId || !p.modelSetId) return null;
      const q = new URLSearchParams();
      if (p.testKey) q.set("test", p.testKey);
      if (p.lente) q.set("lente", p.lente);
      const s = q.toString();
      return `/coordinacion/${enc(p.projectId)}/${enc(p.modelSetId)}${s ? `?${s}` : ""}`;
    }
    case "batch":
      return p.batchId ? `/aprobaciones/${enc(p.batchId)}` : "/aprobaciones";
    case "approvals":
      return "/aprobaciones";
    case "rules":
      return "/reglas";
    case "disciplines":
    case "hygiene":
      return p.projectId ? `/proyectos/${enc(p.projectId)}?${new URLSearchParams({ ...(p.modelSetId ? { modelSet: p.modelSetId } : {}), tab: a.route === "disciplines" ? "disciplinas" : "higiene" }).toString()}` : null;
    case "reports":
      return p.projectId ? `/proyectos/${enc(p.projectId)}` : null;
    default:
      return null;
  }
}

/** Coordination workspace of a run's test (to review what a flow produced). */
export function runHref(run: { projectId: string; modelSetId?: string; testKey?: string }): string | null {
  if (!run.modelSetId) return `/proyectos/${enc(run.projectId)}`;
  return `/coordinacion/${enc(run.projectId)}/${enc(run.modelSetId)}${run.testKey ? `?test=${enc(run.testKey)}` : ""}`;
}
