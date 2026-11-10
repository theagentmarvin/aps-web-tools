/**
 * Building blocks of the decision-first detail pane (DetailPanel.tsx):
 * element cards, the proposal editor, and the content of the collapsible
 * sections (clashes, full reasoning, changes, properties, issue draft, history).
 */
import { useEffect, useState } from "react";
import { useI18n, useT } from "~/i18n";
import { useApi } from "~/lib/api";
import type { Clash, Decision, ElementInfo, ElementProperties, FieldSource, IssueDraft, Priority, Proposal, ProposedAction, Validity } from "~/lib/api/types";
import { ConfidenceBadge, DecisionStateIcon, SourceBadge } from "~/lib/components/badges";
import { SideASwatch, SideBSwatch } from "~/lib/components/icons";
import { Kbd, inputCls } from "~/lib/components/ui";
import { DECISION_KEY, PRIORITY_KEY, STATUS_KEY, VALIDITY_KEY, VALIDITY_ORDER, VALIDITY_TIP } from "~/lib/labels";
import { useTriageContext } from "./actions";
import type { Evaluated } from "./filters";
import type { PairSummary } from "./pair-summary";
import { rowKey, useTriage } from "./store";

export function kindState(k: Decision["kind"]): "accepted" | "corrected" | "rejected" | "postponed" {
  return k === "accept" ? "accepted" : k === "correct" ? "corrected" : k === "reject" ? "rejected" : "postponed";
}

export function useActionLabel() {
  const t = useT();
  return (a: ProposedAction | undefined) => {
    if (!a) return "—";
    const parts: string[] = [];
    if (a.createIssue) parts.push(t("detail.actionCreateIssue"));
    if (a.setStatus) parts.push(t("detail.actionSetStatus", { status: t(STATUS_KEY[a.setStatus]) }));
    return parts.length ? parts.join(" + ") : t("detail.actionNone");
  };
}

// ── Element cards ("Detalles de elementos") ────────────────────────

function ElementCard({ side, el, disciplineLabel }: { side: "a" | "b"; el: ElementInfo; disciplineLabel: string }) {
  const t = useT();
  return (
    <div className={`min-w-0 flex-1 rounded border border-l-4 border-brand-muted/20 bg-white p-2 text-xs ${side === "a" ? "border-l-clash-a" : "border-l-clash-b"}`}>
      <div className={`mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide ${side === "a" ? "text-clash-a-ink" : "text-clash-b-ink"}`}>
        {side === "a" ? <SideASwatch /> : <SideBSwatch />}
        <span className="truncate">
          {side === "a" ? t("detail.elementA") : t("detail.elementB")} · {disciplineLabel}
        </span>
      </div>
      <div className="truncate font-medium text-gray-900" title={el.name} lang="es">
        {el.name}
      </div>
      <dl className="mt-1 space-y-0.5 text-gray-600">
        <div className="truncate" title={el.type}>
          <dt className="sr-only">{t("detail.type")}</dt>
          <dd>{el.type ?? el.category}</dd>
        </div>
        {el.system && (
          <div className="truncate" title={el.system}>
            <dt className="sr-only">{t("detail.system")}</dt>
            <dd>{el.system}</dd>
          </div>
        )}
        <div className="truncate" title={el.modelName}>
          <dt className="sr-only">{t("detail.model")}</dt>
          <dd>{el.modelName}</dd>
        </div>
        <div className="font-mono text-[11px] text-gray-500">
          <dt className="inline">{t("detail.elementId")} </dt>
          <dd className="inline">{el.dbId}</dd>
        </div>
      </dl>
    </div>
  );
}

export function ElementDetails({ pair, focusId }: { pair: PairSummary; focusId: string }) {
  const t = useT();
  const { lang } = useI18n();
  const { store } = useTriageContext();
  const disciplines = useTriage(store, (s) => s.disciplines);
  const dl = (code: string) => {
    const d = disciplines.find((x) => x.code === code);
    return d ? (lang === "en" ? d.en : d.es) : code;
  };
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <ElementCard side="a" el={pair.a.representative} disciplineLabel={dl(pair.a.discipline)} />
        <ElementCard side="b" el={pair.b.representative} disciplineLabel={dl(pair.b.discipline)} />
      </div>
      <button type="button" onClick={() => store.setDialog({ type: "compare", key: rowKey("clash", focusId) })} className="text-xs text-brand hover:underline">
        {t("detail.compareProperties")}
      </button>
    </div>
  );
}

// ── Clashes of the group ("Interferencias (N)") ─────────────────────

export function ClashesTable({ pair, groupId }: { pair: PairSummary; groupId: string }) {
  const { fmt } = useI18n();
  const { store } = useTriageContext();
  const cursorKey = useTriage(store, (s) => s.cursorKey);
  return (
    <table className="w-full table-fixed text-[11px]">
      <tbody>
        {pair.clashes.slice(0, 50).map((c) => (
          <tr
            key={c.id}
            onClick={() => {
              store.toggleExpand(groupId, true);
              store.setCursor(rowKey("clash", c.id));
            }}
            className={`cursor-pointer border-t border-brand-muted/10 hover:bg-brand-surface ${cursorKey === rowKey("clash", c.id) ? "bg-brand-surface" : ""}`}
          >
            <td className="w-14 py-0.5 font-mono text-gray-500" title={c.id}>
              {c.id.slice(-6)}
            </td>
            <td className="truncate text-clash-a-ink" title={c.a.name}>
              {c.a.name}
            </td>
            <td className="truncate text-clash-b-ink" title={c.b.name}>
              {c.b.name}
            </td>
            <td className="w-16 text-right font-mono">{fmt.mm(c.distanceMm)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Proposal editor ("Cambiar", E) ──────────────────────────────────

export function InlineEditor({ proposal }: { proposal: Proposal }) {
  const t = useT();
  const { store, actions } = useTriageContext();
  const disciplines = useTriage(store, (s) => s.disciplines);
  const key = store.state.cursorKey;
  const targetId = key ? key.slice(2) : "";
  const edits = useTriage(store, (s) => s.edits.get(targetId));
  const v = edits?.validity ?? proposal.fields.validity.value;
  const p = edits?.priority ?? proposal.fields.priority.value;
  const o = edits?.owner ?? proposal.fields.owner.value;
  const a = edits?.action ?? proposal.fields.action.value;

  function save() {
    if (!key) return;
    actions.openCorrection([key], { ...edits, validity: v, priority: p, owner: o, action: a });
  }

  const row = "grid grid-cols-[96px_minmax(0,1fr)] items-center gap-2";
  return (
    <form
      className="space-y-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          save();
        }
        if (e.key === "Escape") store.setEditing(false);
      }}
    >
      <p className="text-xs font-medium text-brand">{t("detail.editing")}</p>
      <label className={row}>
        <span className="text-xs text-gray-500">{t("detail.field.validity")}</span>
        <select autoFocus className={`${inputCls} min-w-0`} value={v} onChange={(e) => store.setEdits(targetId, { validity: e.target.value as Validity })}>
          {VALIDITY_ORDER.map((x) => (
            <option key={x} value={x} title={t(VALIDITY_TIP[x])}>
              {t(VALIDITY_KEY[x])}
            </option>
          ))}
        </select>
      </label>
      <label className={row}>
        <span className="text-xs text-gray-500">{t("detail.field.priority")}</span>
        <select className={`${inputCls} min-w-0`} value={p} onChange={(e) => store.setEdits(targetId, { priority: Number(e.target.value) as Priority })}>
          {([1, 2, 3, 4] as const).map((x) => (
            <option key={x} value={x}>
              {t(PRIORITY_KEY[x])}
            </option>
          ))}
        </select>
      </label>
      <label className={row}>
        <span className="text-xs text-gray-500">{t("detail.whoMoves")}</span>
        <select className={`${inputCls} min-w-0`} value={o} onChange={(e) => store.setEdits(targetId, { owner: e.target.value })}>
          {disciplines.map((d) => (
            <option key={d.code} value={d.code}>
              {d.code} · {d.es}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="grid grid-cols-[96px_minmax(0,1fr)] items-start gap-2">
        <legend className="sr-only">{t("detail.suggestedAction")}</legend>
        <span className="text-xs text-gray-500">{t("detail.suggestedAction")}</span>
        <div className="min-w-0 space-y-1">
          <label className="flex items-center gap-2">
            <input type="checkbox" className="accent-brand" checked={a.createIssue} onChange={(e) => store.setEdits(targetId, { action: { ...a, createIssue: e.target.checked } })} />
            {t("detail.actionCreateIssue")}
          </label>
          <select className={`${inputCls} w-full`} value={a.setStatus ?? ""} onChange={(e) => store.setEdits(targetId, { action: { ...a, setStatus: (e.target.value || null) as ProposedAction["setStatus"] } })}>
            <option value="">{t("detail.actionNone")}</option>
            {(["reviewed", "closed", "active"] as const).map((s) => (
              <option key={s} value={s}>
                {t("detail.actionSetStatus", { status: t(STATUS_KEY[s]) })}
              </option>
            ))}
          </select>
        </div>
      </fieldset>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={() => store.setEditing(false)} className="rounded border border-brand-muted/30 px-2 py-1 text-xs">
          {t("common.cancel")} <Kbd>Esc</Kbd>
        </button>
        <button type="submit" className="rounded bg-brand px-2 py-1 text-xs text-white hover:bg-brand-light">
          {t("detail.saveEdit")}
        </button>
      </div>
    </form>
  );
}

// ── Full reasoning and rules ────────────────────────────────────────

export function ReasoningContent({ proposal, calibration }: { proposal: Proposal; calibration: (c: number) => string | undefined }) {
  const t = useT();
  const { store } = useTriageContext();
  const hasLlm = Object.values(proposal.fields).some((f) => f.source !== "rule");
  const fields = ["validity", "priority", "owner", "action"] as const;
  return (
    <div className="space-y-3 text-sm text-gray-800">
      {proposal.flagged && <p className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-800">{t("detail.flagged")}</p>}
      <p lang="es" className="whitespace-pre-line break-words">
        {proposal.rationale}
      </p>
      {proposal.signals.length > 0 && (
        <div>
          <h4 className="text-xs text-gray-500">{t("detail.signals")}</h4>
          <ul className="mt-1 flex flex-wrap gap-1">
            {proposal.signals.map((s) => (
              <li key={s.label} className="max-w-full break-words rounded border border-brand-muted/20 bg-gray-50 px-1.5 text-[11px] text-gray-700">
                {s.label}: <span className="font-medium">{s.value}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h4 className="text-xs text-gray-500">{t("detail.perField")}</h4>
        <dl className="mt-1 space-y-1 text-xs">
          {fields.map((f) => (
            <div key={f} className="flex flex-wrap items-center gap-1.5">
              <dt className="w-24 text-gray-500">{t(`detail.field.${f}`)}</dt>
              <dd className="flex flex-wrap items-center gap-1">
                <ConfidenceBadge value={proposal.fields[f].confidence} calibration={calibration(proposal.fields[f].confidence)} />
                <SourceBadge source={proposal.fields[f].source as FieldSource} ruleIds={proposal.fields[f].ruleIds} onRuleClick={(id) => store.setDialog({ type: "rule", ruleId: id })} />
              </dd>
            </div>
          ))}
        </dl>
      </div>
      {proposal.ruleIds.length > 0 && (
        <p className="text-xs text-gray-600">
          {t("detail.rulesApplied")}:{" "}
          {proposal.ruleIds.map((id, i) => (
            <span key={id}>
              {i > 0 && ", "}
              <button type="button" onClick={() => store.setDialog({ type: "rule", ruleId: id })} className="font-mono text-brand hover:underline">
                {id}
              </button>
            </span>
          ))}
        </p>
      )}
      {hasLlm && <p className="text-xs text-gray-500">{t("source.llmDetail", { model: proposal.model ?? "—", runId: proposal.runId })}</p>}
    </div>
  );
}

// ── Changes since the previous test ─────────────────────────────────

/** True when there is something worth showing (not just "all new" on the first test). */
export function hasChanges(e: Evaluated, members: Clash[]): boolean {
  const ds = e.s.group?.deltaSummary;
  const clash = e.s.clash;
  return !!(
    e.s.proposal?.inherited ||
    e.s.group?.elementMissing ||
    clash?.elementMissing ||
    (clash && clash.delta !== "new") ||
    members.some((c) => c.delta === "modified") ||
    (ds && (ds.persisting > 0 || ds.reappeared > 0 || ds.modified > 0))
  );
}

export function ChangesContent({ e, members }: { e: Evaluated; members: Clash[] }) {
  const t = useT();
  const { fmt } = useI18n();
  const p = e.s.proposal;
  const clash = e.s.clash;
  const ds = e.s.group?.deltaSummary;
  return (
    <div className="space-y-1 text-sm text-gray-800">
      {e.s.kind === "group" && ds && <p>{t("delta.groupSummary", { new: ds.new, persisting: ds.persisting, reappeared: ds.reappeared })}</p>}
      {clash && (
        <p>
          {clash.delta === "persisting" && clash.persistingCount ? t("delta.persistingFor", { count: clash.persistingCount }) : t(`delta.${clash.delta}`)}
          {clash.delta === "modified" && clash.previousDistanceMm !== undefined && (
            <span className="ml-2 font-mono text-xs">{t("delta.distanceChange", { from: fmt.mm(clash.previousDistanceMm).replace(" mm", ""), to: fmt.mm(clash.distanceMm).replace(" mm", "") })}</span>
          )}
        </p>
      )}
      {e.s.kind === "group" && members.some((c) => c.delta === "modified") && (
        <ul className="text-xs text-gray-600">
          {members
            .filter((c) => c.delta === "modified" && c.previousDistanceMm !== undefined)
            .slice(0, 3)
            .map((c) => (
              <li key={c.id} className="font-mono">
                {c.id.slice(-6)}: {t("delta.distanceChange", { from: fmt.mm(c.previousDistanceMm!).replace(" mm", ""), to: fmt.mm(c.distanceMm).replace(" mm", "") })}
              </li>
            ))}
        </ul>
      )}
      {p?.inherited && (
        <p className="flex items-center gap-1 text-gray-600">
          <DecisionStateIcon state="inherited" />
          {t("delta.inheritedFrom", { date: fmt.date(p.inherited.decidedAt), user: p.inherited.userName, reason: p.inherited.reasonCode ?? t(DECISION_KEY[kindState(p.inherited.kind)]) })}
        </p>
      )}
      {(e.s.group?.elementMissing || clash?.elementMissing) && <p className="text-amber-800">{t("delta.elementMissing")}</p>}
    </div>
  );
}

// ── Properties (A vs B, loaded when opened) ─────────────────────────

export function PropertiesContent({ testId, a, b }: { testId: string; a: ElementInfo; b: ElementInfo }) {
  const t = useT();
  const api = useApi();
  const [data, setData] = useState<ElementProperties[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    setData(null);
    setError(false);
    api.getElementProperties(testId, [a.ref, b.ref]).then(
      (d) => alive && setData(d),
      () => alive && setError(true),
    );
    return () => {
      alive = false;
    };
  }, [api, testId, a.ref, b.ref]);
  if (error) return <p className="text-xs text-red-700">{t("errors.load")}</p>;
  if (!data) return <p className="text-xs text-gray-500">{t("detail.propsLoading")}</p>;
  const [pa, pb] = data;
  const names = [...new Set([...Object.keys(pa?.props ?? {}), ...Object.keys(pb?.props ?? {})])];
  const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));
  return (
    <table className="w-full table-fixed text-[11px]">
      <thead>
        <tr className="text-left text-gray-500">
          <th className="w-1/3 py-1 font-medium">{t("common.property")}</th>
          <th className="font-medium text-clash-a-ink">A</th>
          <th className="font-medium text-clash-b-ink">B</th>
        </tr>
      </thead>
      <tbody>
        {names.map((n) => {
          const va = show(pa?.props[n]);
          const vb = show(pb?.props[n]);
          return (
            <tr key={n} className={`border-t border-brand-muted/10 align-top ${va !== vb ? "bg-amber-50" : ""}`}>
              <td className="break-words py-0.5 pr-1 text-gray-600">{n}</td>
              <td className="break-words pr-1" lang="es">
                {va}
              </td>
              <td className="break-words" lang="es">
                {vb}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Issue draft ────────────────────────────────────────────────────

export function IssueDraftFields({ targetId, draft, onPin }: { targetId: string; draft: IssueDraft; onPin: () => void }) {
  const t = useT();
  const { store } = useTriageContext();
  const disciplines = useTriage(store, (s) => s.disciplines);
  const edits = useTriage(store, (s) => s.edits.get(targetId)?.issue);
  const d = { ...draft, ...edits };
  const set = (patch: Partial<IssueDraft>) => store.setEdits(targetId, { issue: { ...edits, ...patch } });
  return (
    <div className="space-y-2 text-sm">
      <label className="block">
        <span className="text-xs text-gray-500">{t("issue.title")}</span>
        <input id="issue-title" className={`${inputCls} w-full`} value={d.title} onChange={(e) => set({ title: e.target.value })} />
      </label>
      <label className="block">
        <span className="text-xs text-gray-500">{t("issue.description")}</span>
        <textarea className={`${inputCls} h-28 w-full font-mono text-xs`} value={d.description} onChange={(e) => set({ description: e.target.value })} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block min-w-0">
          <span className="text-xs text-gray-500">{t("issue.ownerDiscipline")}</span>
          <select className={`${inputCls} w-full`} value={d.ownerDiscipline} onChange={(e) => set({ ownerDiscipline: e.target.value })}>
            {disciplines.map((x) => (
              <option key={x.code} value={x.code}>
                {x.code}
              </option>
            ))}
          </select>
        </label>
        <label className="block min-w-0">
          <span className="text-xs text-gray-500">{t("issue.assignee")}</span>
          <input className={`${inputCls} w-full`} value={d.assigneeRole ?? ""} onChange={(e) => set({ assigneeRole: e.target.value })} />
        </label>
        <label className="block min-w-0">
          <span className="text-xs text-gray-500">{t("issue.dueDate")}</span>
          <input type="date" className={`${inputCls} w-full`} value={d.dueDate} onChange={(e) => set({ dueDate: e.target.value })} />
        </label>
        <label className="block min-w-0">
          <span className="text-xs text-gray-500">{t("issue.type")}</span>
          <input className={`${inputCls} w-full`} value={d.issueType ?? ""} onChange={(e) => set({ issueType: e.target.value })} />
        </label>
      </div>
      <label className="block">
        <span className="text-xs text-gray-500">{t("issue.location")}</span>
        <input className={`${inputCls} w-full`} value={d.location ?? ""} onChange={(e) => set({ location: e.target.value })} />
      </label>
      <div className="flex items-center justify-between text-xs">
        <label className="flex items-center gap-2">
          <input type="checkbox" className="accent-brand" checked={d.includeView} onChange={(e) => set({ includeView: e.target.checked })} />
          {t("issue.includeView")}
        </label>
        <button type="button" onClick={onPin} className="text-brand hover:underline">
          {d.pinnedView ? t("issue.viewPinned") : t("issue.pinView")}
        </button>
      </div>
      <p className="text-[11px] text-gray-500">
        {t("issue.snapshotAtApply")} · {t("issue.linkedClashes", { count: d.linkClashIds.length })}
      </p>
    </div>
  );
}

// ── History ────────────────────────────────────────────────────────

export function useHistoryItems(proposal: Proposal | undefined, decisions: Decision[], members: Clash[]) {
  const t = useT();
  const items: { at: string; text: string }[] = [];
  if (proposal) items.push({ at: proposal.createdAt, text: t("detail.agentProposed", { runId: proposal.runId }) });
  if (proposal && proposal.updatedAt !== proposal.createdAt) items.push({ at: proposal.updatedAt, text: t("detail.agentUpdated") });
  const prev = members.find((c) => c.previousDecision)?.previousDecision ?? proposal?.inherited;
  if (prev) items.push({ at: prev.decidedAt, text: t("detail.previousDecision", { decision: t(DECISION_KEY[kindState(prev.kind)]), user: prev.userName }) });
  for (const d of decisions) {
    const label =
      d.kind === "note"
        ? `${t("actions.note")}: ${d.note ?? ""}`
        : d.kind === "undo"
          ? t("decision.undone", { action: "" }).replace(/:\s*$/, "")
          : `${t(DECISION_KEY[kindState(d.kind)])}${d.reasonCode ? ` · ${d.reasonCode}` : ""}`;
    items.push({ at: d.decidedAt, text: `${label} — ${d.userName}` });
  }
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

export function HistoryList({ items }: { items: { at: string; text: string }[] }) {
  const { fmt } = useI18n();
  return (
    <ol className="space-y-1 text-xs text-gray-600">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2">
          <span className="whitespace-nowrap font-mono text-gray-400">{fmt.dateTime(it.at)}</span>
          <span className="min-w-0 break-words">{it.text}</span>
        </li>
      ))}
    </ol>
  );
}
