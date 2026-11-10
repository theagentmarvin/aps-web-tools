/**
 * G7 "Confirmar heredadas sin cambio": one dialog for every inherited decision that did NOT change
 * but that policy re-asks (critical, structural opening, life safety). Grouped by reason; structural
 * openings and life safety need their own acknowledgement (never passed silently); the coordinator
 * types the count to confirm. The server re-validates everything and audits each item.
 * An agent proposal (propose_group_action confirm_inherited) can preselect the list; only a human confirms.
 */
import { useMemo, useState } from "react";
import { useT, type TKey } from "~/i18n";
import { useApi, useAsync } from "~/lib/api";
import type { InheritedConfirmItem, InheritedConfirmList } from "~/lib/api/types";
import { Modal } from "~/lib/components/Modal";
import { useToast } from "~/lib/components/Toast";
import { Button, inputCls } from "~/lib/components/ui";
import { VALIDITY_KEY } from "~/lib/labels";
import { useTriageContext } from "./actions";

type Section = "structural_opening" | "life_safety" | "critical";
const SECTIONS: Section[] = ["structural_opening", "life_safety", "critical"];

/** The most restrictive reason decides the section (structural > life safety > critical). */
export function sectionOf(i: Pick<InheritedConfirmItem, "reasons">): Section {
  return SECTIONS.find((s) => i.reasons.includes(s)) ?? "critical";
}

/** Ids that will be sent: selected, and in an acknowledged section when that section needs one. */
export function confirmableIds(items: readonly InheritedConfirmItem[], selected: ReadonlySet<string>, ack: { structural: boolean; lifeSafety: boolean }): string[] {
  return items
    .filter((i) => selected.has(i.groupId))
    .filter((i) => (!i.reasons.includes("structural_opening") || ack.structural) && (!i.reasons.includes("life_safety") || ack.lifeSafety))
    .map((i) => i.groupId);
}

export function InheritedConfirmDialog() {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const { store } = useTriageContext();
  const payload = store.state.payload;
  const testId = payload?.test.id ?? "";
  const { data, loading, error } = useAsync<InheritedConfirmList | undefined>(() => (api.getInheritedConfirmations ? api.getInheritedConfirmations(testId) : Promise.resolve(undefined)), [testId]);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [ack, setAck] = useState({ structural: false, lifeSafety: false });
  const [typed, setTyped] = useState("");
  const [proposalId, setProposalId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const items = data?.items ?? [];
  const sel = useMemo(() => selected ?? new Set(items.map((i) => i.groupId)), [selected, items]);
  const ids = confirmableIds(items, sel, ack);
  const close = () => store.setDialog(null);
  const toggle = (id: string, on: boolean) => {
    const next = new Set(sel);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
    setProposalId(undefined);
  };
  async function confirm() {
    if (!api.confirmInheritedBulk || !payload) return;
    setBusy(true);
    setErr(undefined);
    try {
      const r = await api.confirmInheritedBulk(testId, {
        groupIds: ids,
        typedCount: Number(typed),
        ...(ids.some((id) => items.find((i) => i.groupId === id)?.reasons.includes("structural_opening")) ? { acknowledgeStructural: ack.structural } : {}),
        ...(ids.some((id) => items.find((i) => i.groupId === id)?.reasons.includes("life_safety")) ? { acknowledgeLifeSafety: ack.lifeSafety } : {}),
        ...(proposalId ? { proposalId } : {}),
      });
      store.load(await api.getTriage(payload.project.id, payload.modelSet.id, testId));
      toast.show(t("inheritedBulk.done", { count: r.confirmed.length }));
      close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }
  const proposal = data?.proposals[0];
  return (
    <Modal
      title={t("inheritedBulk.title")}
      width="w-[640px]"
      onClose={close}
      footer={
        <>
          <label className="mr-auto flex items-center gap-2 text-xs text-gray-700">
            {t("inheritedBulk.typeCount", { count: ids.length })}
            <input aria-label={t("inheritedBulk.typeCount", { count: ids.length })} inputMode="numeric" className={`${inputCls} w-16`} value={typed} onChange={(e) => setTyped(e.target.value.replace(/[^0-9]/g, ""))} />
          </label>
          <Button onClick={close}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy || !ids.length || Number(typed) !== ids.length} onClick={() => void confirm()}>
            {t("inheritedBulk.confirm", { count: ids.length })}
          </Button>
        </>
      }
    >
      {loading && <p className="text-gray-500">{t("inheritedBulk.loading")}</p>}
      {error && <p className="text-red-700">{t("errors.load")}</p>}
      {data && (
        <div className="space-y-3 text-sm">
          <p className="text-gray-700">{t("inheritedBulk.intro")}</p>
          {data.changedCount > 0 && <p className="text-xs text-amber-800">{t("inheritedBulk.changed", { count: data.changedCount })}</p>}
          {!items.length && <p className="text-gray-500">{t("inheritedBulk.none")}</p>}
          {proposal && (
            <div className="flex items-center gap-2 rounded border border-violet-200 bg-violet-50 px-2 py-1.5 text-xs text-violet-900">
              <span className="flex-1">{t("inheritedBulk.agentProposal", { count: proposal.groupIds.length })}</span>
              <button
                type="button"
                className="rounded border border-violet-300 bg-white px-2 py-0.5 hover:bg-violet-100"
                onClick={() => {
                  setSelected(new Set(proposal.groupIds));
                  setProposalId(proposal.id);
                }}
              >
                {t("inheritedBulk.useProposal")}
              </button>
            </div>
          )}
          {SECTIONS.map((s) => {
            const rows = items.filter((i) => sectionOf(i) === s);
            if (!rows.length) return null;
            const needsAck = s === "structural_opening" || s === "life_safety";
            const acked = s === "structural_opening" ? ack.structural : s === "life_safety" ? ack.lifeSafety : true;
            return (
              <section key={s} aria-label={t(`inheritedBulk.section_${s}` as TKey)} className={`rounded border p-2 ${needsAck ? "border-amber-300 bg-amber-50/40" : "border-gray-200"}`}>
                <h3 className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-700">
                  <span className="flex-1">
                    {t(`inheritedBulk.section_${s}` as TKey)} · {rows.length}
                  </span>
                  <button type="button" className="font-normal normal-case text-brand hover:underline" onClick={() => setSelected(new Set([...sel, ...rows.map((r) => r.groupId)]))}>
                    {t("inheritedBulk.selectAll")}
                  </button>
                  <button type="button" className="font-normal normal-case text-brand hover:underline" onClick={() => setSelected(new Set([...sel].filter((id) => !rows.some((r) => r.groupId === id))))}>
                    {t("inheritedBulk.selectNone")}
                  </button>
                </h3>
                {needsAck && (
                  <label className="mb-1 flex items-start gap-2 text-xs text-amber-900">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-brand"
                      checked={acked}
                      onChange={(e) => setAck((a) => (s === "structural_opening" ? { ...a, structural: e.target.checked } : { ...a, lifeSafety: e.target.checked }))}
                    />
                    <span>
                      {t(s === "structural_opening" ? "inheritedBulk.ackStructural" : "inheritedBulk.ackLifeSafety")}
                      {!acked && <span className="block text-amber-700">{t("inheritedBulk.ackNeeded")}</span>}
                    </span>
                  </label>
                )}
                <ul className={`max-h-48 space-y-0.5 overflow-auto ${acked ? "" : "opacity-50"}`}>
                  {rows.map((i) => (
                    <li key={i.groupId}>
                      <label className="flex items-start gap-2 text-xs">
                        <input type="checkbox" className="mt-0.5 accent-brand" checked={sel.has(i.groupId)} onChange={(e) => toggle(i.groupId, e.target.checked)} />
                        <span className="min-w-0 flex-1">
                          <span lang="es" className="block truncate text-gray-900" title={i.title}>
                            {i.title}
                          </span>
                          <span className="text-gray-500">
                            {t("inheritedBulk.row", { version: i.fromVersion, decision: i.validity ? t(VALIDITY_KEY[i.validity]) : i.decision, source: t(i.source === "family" ? "inheritedBulk.sourceFamily" : "inheritedBulk.sourceHuman") })}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          {err && <p className="text-red-700">{err}</p>}
        </div>
      )}
    </Modal>
  );
}
