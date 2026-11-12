/**
 * Viewer selection → chat context: the elements the coordinator selected in
 * the APS viewer, as `{documentId, dbId}` of the model set (model → URN →
 * document), capped at 50. Pure mapping + a small registry the viewer pane
 * fills when models load.
 */
import type { ChatSelectedElement } from "~/lib/api/types";

/** docs/ai/chat-agent-design.md: get_selection_context takes 1..50 elements. */
export const SELECTION_CAP = 50;

/** model object → URN (filled by ClashViewerPane.onModelsLoaded). */
const modelUrns = new Map<unknown, string>();
export function registerModel(urn: string, model: unknown) {
  modelUrns.set(model, urn);
}

/** One entry of `viewer.getAggregateSelection()`. */
export interface AggregateSelectionEntry {
  model: unknown;
  selection?: number[];
  dbIdArray?: number[];
}

export function selectionToElements(
  sel: AggregateSelectionEntry[],
  urnOf: (model: unknown) => string | undefined,
  docs: { documentId: number; urn: string }[],
  cap = SELECTION_CAP,
): { elements: ChatSelectedElement[]; truncated: boolean; total: number } {
  const docByUrn = new Map(docs.map((d) => [d.urn, d.documentId]));
  const elements: ChatSelectedElement[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const s of sel) {
    const urn = urnOf(s.model);
    const documentId = urn !== undefined ? docByUrn.get(urn) : undefined;
    if (documentId === undefined) continue;
    for (const dbId of s.selection ?? s.dbIdArray ?? []) {
      const k = `${documentId}:${dbId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      total++;
      if (elements.length < cap) elements.push({ documentId, dbId });
    }
  }
  return { elements, truncated: total > elements.length, total };
}

type Viewer = {
  getAggregateSelection?: () => AggregateSelectionEntry[];
  addEventListener: (ev: string, cb: () => void) => void;
  removeEventListener: (ev: string, cb: () => void) => void;
};
function viewer(): Viewer | null {
  try {
    return (window as unknown as { __apsViewer?: { getViewer: () => Viewer | null } }).__apsViewer?.getViewer() ?? null;
  } catch {
    return null;
  }
}

/** Current viewer selection, mapped to model-set documents. */
export function readViewerSelection(docs: { documentId: number; urn: string }[]) {
  const v = viewer();
  return selectionToElements(v?.getAggregateSelection?.() ?? [], (m) => modelUrns.get(m), docs);
}

/** Live updates on selection changes; returns an unsubscribe. No-op without a viewer. */
export function onViewerSelection(cb: () => void): () => void {
  const v = viewer();
  const Ev = (window as unknown as { Autodesk?: { Viewing?: { AGGREGATE_SELECTION_CHANGED_EVENT?: string } } }).Autodesk?.Viewing?.AGGREGATE_SELECTION_CHANGED_EVENT;
  if (!v || !Ev) return () => undefined;
  v.addEventListener(Ev, cb);
  return () => v.removeEventListener(Ev, cb);
}
