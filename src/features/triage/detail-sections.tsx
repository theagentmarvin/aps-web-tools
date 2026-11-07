/**
 * Detail pane sections (spec §3.7). Order is deliberate: evidence before
 * verdict (Evidencia → Propuesta → Razonamiento → Cambios → Incidencia → Historial).
 */
import { useState } from "react";
import { useI18n, useT } from "~/i18n";
import type { Clash, Decision, DecisionChange, ElementInfo, FieldSource, IssueDraft, Priority, Proposal, ProposedAction, Validity } from "~/lib/api/types";
import { ConfidenceBadge, DecisionStateIcon, ReasonChip, SourceBadge, ValidityBadge } from "~/lib/components/badges";
import { SideASwatch, SideBSwatch } from "~/lib/components/icons";
import { Kbd, SectionTitle, inputCls } from "~/lib/components/ui";
import { DECISION_KEY, PRIORITY_KEY, STATUS_KEY, VALIDITY_KEY, VALIDITY_ORDER } from "~/lib/labels";
import { useTriageContext } from "./actions";
import type { Evaluated } from "./filters";
import { rowKey, useTriage } from "./store";

// ── Evidence ───────────────────────────────────────────────────────

function ElementCard({ side, el, disciplineLabel }: { side: "a" | "b"; el: ElementInfo; disciplineLabel: string }) {
  const t = useT();
  return (
    <div className={`min-w-0 flex-1 rounded border border-brand-muted/20 border-l-4 bg-white p-2 text-xs ${side === "a" ? "border-l-clash-a" : "border-l-clash-b"}`}>
      <div className={`mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide ${side === "a" ? "text-clash-a-ink" : "text-clash-b-ink"}`}>
        {side === "a" ? <SideASwatch /> : <SideBSwatch />}
        {side === "a" ? t("detail.elementA") : t("detail.elementB")} · {disciplineLabel}
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
          <div className="truncate">
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

export function EvidenceSection({ e, members }: { e: Evaluated; members: Clash[] }) {
  const t = useT();
  const { fmt, lang } = useI18n();
  const { store } = useTriageContext();
  const disciplines = useTriage(store, (s) => s.disciplines);
  const cursorKey = useTriage(store, (s) => s.cursorKey);
  const [open, setOpen] = useState(true);
  const dl = (code: string) => {
    const d = disciplines.find((x) => x.code === code);
    return d ? (lang === "en" ? d.en : d.es) : code;
  };
  const focusClash = e.s.clash ?? members[0];
  if (!focusClash) return null;
  const g = e.s.group;
  const penMax = e.s.kind === "group" && g ? g.penetrationMaxMm : Math.max(0, -focusClash.distanceMm);
  const penMin = e.s.kind === "group" && g ? g.penetrationMinMm : penMax;
  const loc = g?.location;

  return (
    <section aria-labelledby="sec-evidence">
      <SectionTitle>
        <span id="sec-evidence">{t("detail.evidence")}</span>
      </SectionTitle>
      <div className="space-y-2 px-4 pb-4 text-sm text-gray-800">
        {focusClash.distanceMm < 0 || e.s.kind === "group" ? (
          <p>{t("detail.penetrationRange", { max: fmt.number(penMax), min: fmt.number(penMin) })}</p>
        ) : (
          <p>{t("detail.clearance", { value: fmt.number(focusClash.distanceMm) })}</p>
        )}
        <p className="text-gray-600">
          {loc?.grid && <>{t("detail.grid", { grid: loc.grid })} · </>}
          {loc?.level ?? focusClash.level}
          {loc?.elevation !== undefined && ` (${loc.elevation >= 0 ? "+" : "−"}${fmt.number(Math.abs(loc.elevation), 2)})`}
        </p>
        <div className="flex gap-2">
          <ElementCard side="a" el={focusClash.a} disciplineLabel={dl(focusClash.a.discipline)} />
          <ElementCard side="b" el={focusClash.b} disciplineLabel={dl(focusClash.b.discipline)} />
        </div>
        <button type="button" onClick={() => store.setDialog({ type: "compare", key: rowKey("clash", focusClash.id) })} className="text-xs text-brand hover:underline">
          {t("detail.compareProperties")}
        </button>
        {e.s.kind === "group" && members.length > 0 && (
          <div>
            <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="text-xs font-medium text-gray-600 hover:text-brand">
              {t("detail.clashes", { count: members.length })} {open ? "▾" : "▸"}
            </button>
            {open && (
              <table className="mt-1 w-full table-fixed text-[11px]">
                <tbody>
                  {members.slice(0, 50).map((c) => (
                    <tr
                      key={c.id}
                      onClick={() => {
                        store.toggleExpand(c.groupId, true);
                        store.setCursor(rowKey("clash", c.id));
                      }}
                      className={`cursor-pointer border-t border-brand-muted/10 hover:bg-brand-surface ${cursorKey === rowKey("clash", c.id) ? "bg-brand-surface" : ""}`}
                    >
                      <td className="w-14 py-0.5 font-mono text-gray-500" title={c.id}>
                        {c.id.slice(-6)}
                      </td>
                      <td className="truncate text-clash-a-ink">{c.a.name}</td>
                      <td className="truncate text-clash-b-ink">{c.b.name}</td>
                      <td className="w-16 text-right font-mono">{fmt.mm(c.distanceMm)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ── Proposal ───────────────────────────────────────────────────────

type FieldName = "validity" | "priority" | "owner" | "action";

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

export function ProposalCard({ proposal, decision, calibration }: { proposal: Proposal; decision?: Decision; calibration: (c: number) => string | undefined }) {
  const t = useT();
  const { store } = useTriageContext();
  const actionLabel = useActionLabel();
  const editing = useTriage(store, (s) => s.editing);
  const changes = new Map<string, DecisionChange>((decision?.kind === "correct" ? decision.changes : []).map((c) => [c.field, c]));

  const render = (f: FieldName, v: unknown) => {
    if (f === "validity") return <ValidityBadge value={v as Validity} />;
    if (f === "priority") return t(PRIORITY_KEY[v as Priority]);
    if (f === "owner") return String(v);
    return actionLabel(v as ProposedAction);
  };
  const order: FieldName[] = ["validity", "priority", "owner", "action"];

  return (
    <section aria-labelledby="sec-proposal" className="border-t border-brand-muted/20">
      <SectionTitle>
        <span id="sec-proposal">{t("detail.proposal")}</span>
      </SectionTitle>
      {editing ? (
        <InlineEditor proposal={proposal} />
      ) : (
        <dl className="space-y-1.5 px-4 pb-4 text-sm">
          {order.map((f) => {
            const field = proposal.fields[f];
            const change = changes.get(f);
            const llmLow = field.source === "llm" && field.confidence < store.state.thresholds.medium;
            return (
              <div key={f} className={`grid grid-cols-[84px_1fr] items-start gap-2 ${llmLow ? "border-l-2 border-red-300 pl-1.5" : ""}`}>
                <dt className="pt-0.5 text-xs text-gray-500">{t(`detail.field.${f}`)}</dt>
                <dd className="flex flex-wrap items-center gap-1.5">
                  {change ? (
                    <>
                      <s className="text-gray-400 line-through">{render(f, change.aiValue)}</s>
                      <span className="font-medium">{render(f, change.humanValue)}</span>
                      {decision?.reasonCode && <ReasonChip code={decision.reasonCode} />}
                    </>
                  ) : (
                    <span>{render(f, field.value)}</span>
                  )}
                  <ConfidenceBadge value={field.confidence} calibration={calibration(field.confidence)} />
                  <SourceBadge source={field.source as FieldSource} ruleIds={field.ruleIds} onRuleClick={(id) => store.setDialog({ type: "rule", ruleId: id })} />
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </section>
  );
}

function InlineEditor({ proposal }: { proposal: Proposal }) {
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

  return (
    <form
      className="space-y-2 px-4 pb-4 text-sm"
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
      <label className="grid grid-cols-[84px_1fr] items-center gap-2">
        <span className="text-xs text-gray-500">{t("detail.field.validity")}</span>
        <select autoFocus className={inputCls} value={v} onChange={(e) => store.setEdits(targetId, { validity: e.target.value as Validity })}>
          {VALIDITY_ORDER.map((x) => (
            <option key={x} value={x}>
              {t(VALIDITY_KEY[x])}
            </option>
          ))}
        </select>
      </label>
      <label className="grid grid-cols-[84px_1fr] items-center gap-2">
        <span className="text-xs text-gray-500">{t("detail.field.priority")}</span>
        <select className={inputCls} value={p} onChange={(e) => store.setEdits(targetId, { priority: Number(e.target.value) as Priority })}>
          {([1, 2, 3, 4] as const).map((x) => (
            <option key={x} value={x}>
              {t(PRIORITY_KEY[x])}
            </option>
          ))}
        </select>
      </label>
      <label className="grid grid-cols-[84px_1fr] items-center gap-2">
        <span className="text-xs text-gray-500">{t("detail.field.owner")}</span>
        <select className={inputCls} value={o} onChange={(e) => store.setEdits(targetId, { owner: e.target.value })}>
          {disciplines.map((d) => (
            <option key={d.code} value={d.code}>
              {d.code} · {d.es}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="grid grid-cols-[84px_1fr] items-start gap-2">
        <legend className="sr-only">{t("detail.field.action")}</legend>
        <span className="text-xs text-gray-500">{t("detail.field.action")}</span>
        <div className="space-y-1">
          <label className="flex items-center gap-2">
            <input type="checkbox" className="accent-brand" checked={a.createIssue} onChange={(e) => store.setEdits(targetId, { action: { ...a, createIssue: e.target.checked } })} />
            {t("detail.actionCreateIssue")}
          </label>
          <select className={inputCls} value={a.setStatus ?? ""} onChange={(e) => store.setEdits(targetId, { action: { ...a, setStatus: (e.target.value || null) as ProposedAction["setStatus"] } })}>
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

// ── Rationale ──────────────────────────────────────────────────────

export function RationaleBlock({ proposal, defaultOpen }: { proposal: Proposal; defaultOpen: boolean }) {
  const t = useT();
  const { store } = useTriageContext();
  const toggled = useTriage(store, (s) => s.rationaleOpen);
  const open = toggled ?? defaultOpen;
  const text = proposal.rationale.length > 600 && !open ? proposal.rationale.slice(0, 600) + "…" : proposal.rationale;
  const hasLlm = Object.values(proposal.fields).some((f) => f.source !== "rule");
  return (
    <section aria-labelledby="sec-rationale" className="border-t border-brand-muted/20">
      <SectionTitle right={<Kbd>R</Kbd>}>
        <span id="sec-rationale">{t("detail.rationale")}</span>
      </SectionTitle>
      <div className="space-y-2 px-4 pb-4 text-sm text-gray-800">
        {proposal.flagged && (
          <p className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-800">{t("detail.flagged")}</p>
        )}
        <p lang="es" className={`whitespace-pre-line ${open ? "" : "line-clamp-3"}`}>
          {text}
        </p>
        <button type="button" aria-expanded={open} onClick={() => store.toggleRationale(defaultOpen)} className="text-xs text-brand hover:underline">
          {open ? t("common.less") : t("common.more")}
        </button>
        {open && (
          <>
            <div>
              <h4 className="text-xs text-gray-500">{t("detail.signals")}</h4>
              <ul className="mt-1 flex flex-wrap gap-1">
                {proposal.signals.map((s) => (
                  <li key={s.label} className="rounded border border-brand-muted/20 bg-gray-50 px-1.5 text-[11px] text-gray-700">
                    {s.label}: <span className="font-medium">{s.value}</span>
                  </li>
                ))}
              </ul>
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
          </>
        )}
      </div>
    </section>
  );
}

// ── Changes since last test ────────────────────────────────────────

export function ChangeSinceLastTest({ e, members }: { e: Evaluated; members: Clash[] }) {
  const t = useT();
  const { fmt } = useI18n();
  const p = e.s.proposal;
  const clash = e.s.clash;
  const ds = e.s.group?.deltaSummary;
  return (
    <section aria-labelledby="sec-changes" className="border-t border-brand-muted/20">
      <SectionTitle>
        <span id="sec-changes">{t("detail.changes")}</span>
      </SectionTitle>
      <div className="space-y-1 px-4 pb-4 text-sm text-gray-800">
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
        {e.s.group?.deltaSummary && ds && ds.new === e.s.count && <p className="text-xs text-gray-500">{t("delta.noPrevious")}</p>}
      </div>
    </section>
  );
}

// ── Issue draft ────────────────────────────────────────────────────

export function IssueDraftEditor({ targetId, draft, onPin }: { targetId: string; draft: IssueDraft; onPin: () => void }) {
  const t = useT();
  const { store } = useTriageContext();
  const disciplines = useTriage(store, (s) => s.disciplines);
  const edits = useTriage(store, (s) => s.edits.get(targetId)?.issue);
  const d = { ...draft, ...edits };
  const set = (patch: Partial<IssueDraft>) => store.setEdits(targetId, { issue: { ...edits, ...patch } });
  return (
    <section aria-labelledby="sec-issue" className="border-t border-brand-muted/20">
      <SectionTitle right={<Kbd>I</Kbd>}>
        <span id="sec-issue">{t("detail.issueDraft")}</span>
      </SectionTitle>
      <div className="space-y-2 px-4 pb-4 text-sm">
        <label className="block">
          <span className="text-xs text-gray-500">{t("issue.title")}</span>
          <input id="issue-title" className={`${inputCls} w-full`} value={d.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">{t("issue.description")}</span>
          <textarea className={`${inputCls} h-28 w-full font-mono text-xs`} value={d.description} onChange={(e) => set({ description: e.target.value })} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-xs text-gray-500">{t("issue.ownerDiscipline")}</span>
            <select className={`${inputCls} w-full`} value={d.ownerDiscipline} onChange={(e) => set({ ownerDiscipline: e.target.value })}>
              {disciplines.map((x) => (
                <option key={x.code} value={x.code}>
                  {x.code}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-gray-500">{t("issue.assignee")}</span>
            <input className={`${inputCls} w-full`} value={d.assigneeRole ?? ""} onChange={(e) => set({ assigneeRole: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-xs text-gray-500">{t("issue.dueDate")}</span>
            <input type="date" className={`${inputCls} w-full`} value={d.dueDate} onChange={(e) => set({ dueDate: e.target.value })} />
          </label>
          <label className="block">
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
    </section>
  );
}

function kindState(k: Decision["kind"]): "accepted" | "corrected" | "rejected" | "postponed" {
  return k === "accept" ? "accepted" : k === "correct" ? "corrected" : k === "reject" ? "rejected" : "postponed";
}

// ── History ────────────────────────────────────────────────────────

export function HistoryTimeline({ proposal, decisions, members }: { proposal?: Proposal; decisions: Decision[]; members: Clash[] }) {
  const t = useT();
  const { fmt } = useI18n();
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
  items.sort((a, b) => a.at.localeCompare(b.at));
  return (
    <section aria-labelledby="sec-history" className="border-t border-brand-muted/20">
      <SectionTitle>
        <span id="sec-history">{t("detail.history")}</span>
      </SectionTitle>
      <ol className="space-y-1 px-4 pb-4 text-xs text-gray-600">
        {items.length === 0 && <li>{t("detail.noHistory")}</li>}
        {items.map((it, i) => (
          <li key={i} className="flex gap-2">
            <span className="whitespace-nowrap font-mono text-gray-400">{fmt.dateTime(it.at)}</span>
            <span>{it.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

