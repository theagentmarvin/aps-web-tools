/**
 * Chat context (docs/ai/chat-agent-design.md §4, §5):
 * - contextBlock(): the server-built `<contexto_ui>` block (structured UI state, ≤ 4,000 chars;
 *   the browser's free text is never pasted in; model text wrapped as {untrusted}).
 * - selectionContext(): MCP get_selection_context (viewer selection → elements, clashes, groups, families).
 */
import type * as C from "../api/contract";
import type { Coordinator } from "../coordinator";
import { untrusted, type Untrusted } from "../sanitize";
import { CoordError } from "../util";

export const CONTEXT_MAX_CHARS = 4000;
export const SELECTION_RESOLVE_MAX = 50;
const CLASH_ROWS = 100;

type Table = { columns: string[]; rows: unknown[][] };

export interface SelectionContextOutput {
  testKey: string;
  elements: Array<{ ref: string; found: boolean; discipline?: string; category: string; family?: Untrusted; type?: Untrusted; level?: string; system?: Untrusted; externalId?: string; clashCount: number }>;
  clashes: Table & { truncated?: number };
  groups: Table;
  families: Table;
  notInTest: string[];
}

/** MCP get_selection_context. */
export async function selectionContext(coord: Coordinator, input: { testKey?: string; elements: Array<{ documentId: number | string; dbId: number }> }): Promise<SelectionContextOutput> {
  if (!input.elements.length || input.elements.length > SELECTION_RESOLVE_MAX) throw new CoordError("validation_error", `Entre 1 y ${SELECTION_RESOLVE_MAX} elementos.`);
  const { test, cls, views } = await coord.familyViewsFor(input.testKey);
  const refs = [...new Set(input.elements.map((e) => `E-${Number(e.documentId)}:${Number(e.dbId)}`))];
  for (const r of refs) if (!/^E-\d+:\d+$/.test(r)) throw new CoordError("validation_error", `Elemento inválido: ${r}`);
  const famOf = new Map(views.flatMap((f) => f.groupIds.map((g) => [g, f] as const)));
  const gById = new Map(cls.groups.map((g) => [g.id, g]));
  const states = await coord.groupStates(test.testKey, cls);
  const props = new Map<string, Record<string, unknown>>();
  try {
    const r = await coord.getElementProperties({ testKey: test.testKey, elements: refs, properties: "core" });
    for (const e of r.elements) if (e.found) props.set(e.ref, e.props as Record<string, unknown>);
  } catch {
    // properties pending: the clash records still describe the sides
  }
  const refSet = new Set(refs);
  const hits = cls.clashes.filter((c) => refSet.has(c.a.ref) || refSet.has(c.b.ref));
  const sideOf = new Map<string, (typeof hits)[number]["a"]>();
  for (const c of hits) for (const s of [c.a, c.b]) if (refSet.has(s.ref) && !sideOf.has(s.ref)) sideOf.set(s.ref, s);
  const count = new Map<string, number>();
  for (const c of hits) for (const s of [c.a, c.b]) if (refSet.has(s.ref)) count.set(s.ref, (count.get(s.ref) ?? 0) + 1);
  const val = (v: unknown) => (v && typeof v === "object" && "untrusted" in (v as object) ? (v as Untrusted).untrusted : v);
  const elements = refs.map((ref) => {
    const p = props.get(ref);
    const s = sideOf.get(ref);
    const str = (k: string) => {
      const v = val(p?.[k]);
      return v === undefined || v === null || v === "" ? undefined : String(v);
    };
    const family = str("family") ?? s?.family;
    const type = str("type") ?? s?.type;
    const system = str("system") ?? s?.system;
    return {
      ref,
      found: !!p || !!s,
      ...(s?.discipline ? { discipline: s.discipline } : {}),
      category: str("category") ?? s?.category ?? "?",
      ...(family ? { family: untrusted(family) } : {}),
      ...(type ? { type: untrusted(type) } : {}),
      ...((str("level") ?? s?.level) ? { level: untrusted(str("level") ?? s?.level).untrusted } : {}),
      ...(system ? { system: untrusted(system) } : {}),
      ...((str("externalId") ?? s?.externalId) ? { externalId: String(str("externalId") ?? s?.externalId) } : {}),
      clashCount: count.get(ref) ?? 0,
    };
  });
  const groupIds = [...new Set(hits.map((c) => c.groupId))];
  const famIds = [...new Set(groupIds.map((g) => famOf.get(g)?.id).filter((x): x is string => !!x))];
  return {
    testKey: test.testKey,
    elements,
    clashes: {
      columns: ["clashId", "groupId", "familyId", "otherRef", "otherCategory", "penetrationMm", "validity", "triageState"],
      rows: hits.slice(0, CLASH_ROWS).map((c) => {
        const other = refSet.has(c.a.ref) ? c.b : c.a;
        return [c.id, c.groupId, famOf.get(c.groupId)?.id ?? null, other.ref, untrusted(other.category), Math.round(c.penetrationMm), c.validity, c.triageState];
      }),
      ...(hits.length > CLASH_ROWS ? { truncated: hits.length - CLASH_ROWS } : {}),
    },
    groups: {
      columns: ["groupId", "familyId", "label", "validity", "band", "humanReview", "clashesFromSelection", "clashCount"],
      rows: groupIds.map((id) => {
        const g = gById.get(id)!;
        return [id, famOf.get(id)?.id ?? null, untrusted(g.title), g.validity, g.band, states.get(id) === "needs_review", hits.filter((c) => c.groupId === id).length, g.clashIds.length];
      }),
    },
    families: {
      columns: ["familyId", "title", "validity", "decisionState", "instances"],
      rows: famIds.map((id) => {
        const f = views.find((x) => x.id === id)!;
        return [id, untrusted(f.title), f.proposed.validity, f.state, f.instanceCount];
      }),
    },
    notInTest: refs.filter((r) => !count.get(r)),
  };
}

/** The `<contexto_ui>` block (≤ 4,000 characters; viewer entries dropped from the end to fit). */
export async function contextBlock(coord: Coordinator, testKey: string, ctx: C.ChatContext = {}): Promise<string> {
  const sel = ctx.selection ?? [];
  const id = (s: string | undefined, re: RegExp) => (s && re.test(s) ? s : undefined);
  const focus = {
    ...(id(ctx.focus?.familyId, /^F-[0-9A-Za-z]{6,16}$/) ? { familyId: ctx.focus!.familyId } : {}),
    ...(ctx.focus?.groupIds?.length ? { groupIds: ctx.focus.groupIds.filter((g) => /^G-[0-9a-f]{6,16}$/.test(g)).slice(0, 20) } : {}),
    ...(ctx.focus?.clashIds?.length ? { clashIds: ctx.focus.clashIds.map((c) => c.replace(/^C-/, "")).filter((c) => /^\d{1,20}$/.test(c)).slice(0, 50) } : {}),
  };
  let visor: Array<Record<string, unknown>> = [];
  if (sel.length) {
    const sc = await selectionContext(coord, { testKey, elements: sel.slice(0, SELECTION_RESOLVE_MAX) }).catch(() => undefined);
    visor = (sc?.elements ?? []).map((e) => {
      const [doc, db] = e.ref.slice(2).split(":").map(Number);
      return { documentId: doc, dbId: db, ...(e.discipline ? { modelo: e.discipline } : {}), categoria: e.category, ...(e.type ? { tipo: e.type } : e.family ? { familia: e.family } : {}), ...(e.level ? { nivel: e.level } : {}), clashes: e.clashCount };
    });
  }
  const lens = ctx.lens && /^[a-z_]{1,20}$/.test(ctx.lens) ? ctx.lens : undefined;
  const make = (v: typeof visor) =>
    `<contexto_ui>${JSON.stringify({ ...(lens ? { lente: lens } : {}), testKey, ...(Object.keys(focus).length ? { seleccion: focus } : {}), ...(v.length ? { visor: v } : {}), ...(sel.length > v.length ? { visorTotal: sel.length } : {}) })}</contexto_ui>`;
  let block = make(visor);
  while (block.length > CONTEXT_MAX_CHARS && visor.length) {
    visor = visor.slice(0, Math.floor(visor.length * 0.7));
    block = make(visor);
  }
  return block;
}

/** The full prompt for one message: context + the user's message (both tagged). */
export function chatPrompt(block: string, message: string): string {
  return `${block}\n<mensaje_usuario>${message.replace(/<\/?(mensaje_usuario|contexto_ui)>/gi, "")}</mensaje_usuario>`;
}
