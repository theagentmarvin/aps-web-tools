/**
 * Workspace dialogs: reason-code picker, validity menu, bulk accept guard,
 * note, property compare, rule drawer, shortcut overlay.
 */
import { useState } from "react";
import { Link } from "react-router";
import { useT, type TKey } from "~/i18n";
import { useApi, useAsync } from "~/lib/api";
import { band } from "~/lib/api/decision-utils";
import type { ElementProperties, ReasonCode, Validity } from "~/lib/api/types";
import { useSettings } from "~/lib/settings";
import { Modal } from "~/lib/components/Modal";
import { Button, Kbd, inputCls } from "~/lib/components/ui";
import { displayKey, useHotkeyDocs, type HotkeyGroup } from "~/lib/hotkeys";
import { FIELD_KEY, PRIORITY_KEY, VALIDITY_KEY, VALIDITY_ORDER } from "~/lib/labels";
import { BULK_CAP, REASONS_BY_FIELD, changesFromEdits, isRisky, useTriageContext } from "./actions";
import { parseKey, useTriage, type Dialog } from "./store";
import { FamilyApproveDialog, FamilyRejectDialog } from "./FamilyDialogs";
import { IssueRejectDialog } from "./IssueViews";

// ── Reason code picker (§4.4) ──────────────────────────────────────

function ReasonCodePicker({ dialog }: { dialog: Extract<Dialog, { type: "reason" }> }) {
  const t = useT();
  const { store, actions } = useTriageContext();
  const [code, setCode] = useState<ReasonCode | null>(dialog.suggested ?? null);
  const [note, setNote] = useState("");
  const [suggestRule, setSuggestRule] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codes = REASONS_BY_FIELD[dialog.field];
  const first = parseKey(dialog.keys[0]);
  const change = dialog.mode === "correct" ? changesFromEdits(store.proposalFor(first.kind, first.id), dialog.edits).find((c) => c.field === dialog.field) : undefined;
  const fmtValue = (v: unknown) => {
    if (dialog.field === "validity" && typeof v === "string") return t(VALIDITY_KEY[v as Validity]);
    if (dialog.field === "priority" && typeof v === "number") return t(PRIORITY_KEY[v as 1 | 2 | 3 | 4]);
    return v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v);
  };

  function save() {
    if (!code) return;
    if (code === "R99" && !note.trim()) {
      setError(t("reasons.noteRequiredError"));
      return;
    }
    actions.saveReason(code, note.trim(), suggestRule);
  }

  return (
    <Modal
      title={dialog.mode === "reject" ? t("reasons.rejectTitle") : t("reasons.title")}
      onClose={() => store.setDialog(null)}
      onKeyDown={(e) => {
        const target = e.target as HTMLElement;
        if (target.tagName === "TEXTAREA" || (target.tagName === "INPUT" && (target as HTMLInputElement).type === "text")) {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          }
          return;
        }
        const n = e.key === "0" ? 10 : Number(e.key);
        if (n >= 1 && n <= codes.length) {
          e.preventDefault();
          setCode(codes[n - 1]);
        } else if (e.key === "Enter") {
          e.preventDefault();
          save();
        }
      }}
      footer={
        <>
          <Button onClick={() => store.setDialog(null)}>
            {t("common.cancel")} <Kbd>Esc</Kbd>
          </Button>
          <Button variant="primary" onClick={save} disabled={!code}>
            {t("common.save")} <kbd className="rounded border border-white/40 px-1 font-mono text-[10px]">Enter</kbd>
          </Button>
        </>
      }
    >
      {change && (
        <p className="mb-2 text-xs text-gray-600">
          {t("reasons.fieldChange", { field: t(FIELD_KEY[change.field]), from: fmtValue(change.aiValue), to: fmtValue(change.humanValue) })}
        </p>
      )}
      {dialog.keys.length > 1 && <p className="mb-2 text-xs text-gray-600">{t("reasons.bulkApplies", { count: dialog.keys.length })}</p>}
      <p className="mb-2 text-[11px] text-gray-500">{t("reasons.pickHint")}</p>
      <div role="radiogroup" aria-label={t("reasons.title")} className="space-y-1">
        {codes.map((c, i) => (
          <label key={c} className={`flex cursor-pointer items-center gap-2 rounded border px-2 py-1 ${code === c ? "border-brand-light/40 bg-brand/5" : "border-transparent hover:bg-gray-50"}`}>
            <input type="radio" name="reason" className="accent-brand" checked={code === c} onChange={() => setCode(c)} />
            <Kbd>{i === 9 ? 0 : i + 1}</Kbd>
            <span className="flex-1 text-sm">{t(`reasons.${c}` as TKey)}</span>
            {dialog.suggested === c && <span className="text-[10px] font-medium text-brand">★ {t("reasons.suggested")}</span>}
          </label>
        ))}
      </div>
      <label className="mt-3 block">
        <span className="text-xs text-gray-500">{code === "R99" ? t("reasons.noteRequired") : t("reasons.note")}</span>
        <input type="text" className={`${inputCls} w-full`} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
      <label className="mt-2 flex items-center gap-2 text-xs text-gray-600">
        <input type="checkbox" className="accent-brand" checked={suggestRule} onChange={(e) => setSuggestRule(e.target.checked)} />
        {t("reasons.suggestRule")}
      </label>
    </Modal>
  );
}

// ── Validity menu (v) ──────────────────────────────────────────────

function ValidityMenu() {
  const t = useT();
  const { store, actions } = useTriageContext();
  const pick = (v: Validity) => {
    store.setDialog(null);
    actions.setValidity(v);
  };
  return (
    <Modal
      title={t("actions.setValidity")}
      width="w-[320px]"
      onClose={() => store.setDialog(null)}
      onKeyDown={(e) => {
        const n = Number(e.key);
        if (n >= 1 && n <= VALIDITY_ORDER.length) {
          e.preventDefault();
          pick(VALIDITY_ORDER[n - 1]);
        }
      }}
    >
      <ul className="space-y-1">
        {VALIDITY_ORDER.map((v, i) => (
          <li key={v}>
            <button type="button" onClick={() => pick(v)} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-brand-surface">
              <Kbd>{i + 1}</Kbd>
              {t(VALIDITY_KEY[v])}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

// ── Bulk accept guard (§3.5) ───────────────────────────────────────

function BulkConfirmDialog({ dialog }: { dialog: Extract<Dialog, { type: "bulkAccept" }> }) {
  const t = useT();
  const { settings } = useSettings();
  const { store, actions } = useTriageContext();
  const [includeRisky, setIncludeRisky] = useState(false);
  const evaluated = dialog.keys
    .map((k) => ({ key: k, e: store.evaluate(parseKey(k).kind, parseKey(k).id) }))
    .filter((x) => x.e?.s.proposal && (x.e.d.state === "pending" || x.e.d.state === "inherited"));
  const counts = { high: 0, medium: 0, low: 0, p1: 0 };
  const risky: string[] = [];
  const safe: string[] = [];
  for (const { key, e } of evaluated) {
    if (!e) continue;
    const b = e.d.confidence === null ? "alta" : band(e.d.confidence, settings.thresholds);
    counts[b === "alta" ? "high" : b === "media" ? "medium" : "low"]++;
    if (e.d.priority === 1) counts.p1++;
    const unviewed = store.dwellFor(e.s.id) < settings.dwellGuardSec * 1000;
    if (isRisky(e, settings) && unviewed) risky.push(key);
    else safe.push(key);
  }
  const keys = includeRisky ? [...safe, ...risky] : safe;
  return (
    <Modal
      title={t("bulk.title", { count: evaluated.length })}
      onClose={() => store.setDialog(null)}
      footer={
        <>
          <Button onClick={() => store.setDialog(null)}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={!keys.length} onClick={() => actions.confirmBulkAccept(keys)}>
            {t("bulk.confirm", { count: keys.length })}
          </Button>
        </>
      }
    >
      {!evaluated.length && <p className="text-gray-500">{t("bulk.nothing")}</p>}
      <p>{t("bulk.breakdown", counts)}</p>
      {risky.length > 0 && (
        <>
          <p className="mt-2 text-amber-800">{t("bulk.excludedRisky", { count: risky.length })}</p>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input type="checkbox" className="accent-brand" checked={includeRisky} onChange={(e) => setIncludeRisky(e.target.checked)} />
            {t("bulk.includeRisky", { count: risky.length })}
          </label>
        </>
      )}
      <p className="mt-2 text-xs text-gray-500">{t("bulk.cap", { max: BULK_CAP })}</p>
    </Modal>
  );
}

// ── Note (n) ───────────────────────────────────────────────────────

function NoteDialog({ dialog }: { dialog: Extract<Dialog, { type: "note" }> }) {
  const t = useT();
  const { store } = useTriageContext();
  const [text, setText] = useState("");
  const save = () => {
    if (text.trim()) store.note(dialog.key, text.trim());
    store.setDialog(null);
  };
  return (
    <Modal
      title={t("actions.note")}
      onClose={() => store.setDialog(null)}
      footer={
        <>
          <Button onClick={() => store.setDialog(null)}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={save}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <textarea
        autoFocus
        className={`${inputCls} h-24 w-full`}
        placeholder={t("detail.notePlaceholder")}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            save();
          }
        }}
      />
    </Modal>
  );
}

// ── Property compare (p) ───────────────────────────────────────────

function PropertyCompareModal({ dialog }: { dialog: Extract<Dialog, { type: "compare" }> }) {
  const t = useT();
  const api = useApi();
  const { store } = useTriageContext();
  const testId = store.state.payload?.test.id ?? "";
  const clash = store.state.clashes.get(parseKey(dialog.key).id);
  const { data, loading } = useAsync<ElementProperties[]>(() => (clash ? api.getElementProperties(testId, [clash.a.ref, clash.b.ref]) : Promise.resolve([])), [clash?.id]);
  if (!clash) return null;
  const [a, b] = data ?? [];
  const names = [...new Set([...Object.keys(a?.props ?? {}), ...Object.keys(b?.props ?? {})])];
  return (
    <Modal title={t("detail.compareProperties").replace(/\s*\(P\)$/, "")} width="w-[640px]" onClose={() => store.setDialog(null)} footer={<Button onClick={() => store.setDialog(null)}>{t("common.close")}</Button>}>
      {loading ? (
        <p className="text-gray-500">{t("detail.propsLoading")}</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-1">{t("common.property")}</th>
              <th className="text-clash-a-ink">A · {clash.a.name}</th>
              <th className="text-clash-b-ink">B · {clash.b.name}</th>
            </tr>
          </thead>
          <tbody>
            {names.map((n) => {
              const va = a?.props[n];
              const vb = b?.props[n];
              return (
                <tr key={n} className={`border-t border-brand-muted/10 ${String(va) !== String(vb) ? "bg-amber-50" : ""}`}>
                  <td className="py-1 pr-2 text-gray-600">{n}</td>
                  <td lang="es">{va === null || va === undefined ? "—" : String(va)}</td>
                  <td lang="es">{vb === null || vb === undefined ? "—" : String(vb)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

// ── Rule drawer (side drawer, stays in the workspace) ──────────────

function RuleDrawer({ dialog }: { dialog: Extract<Dialog, { type: "rule" }> }) {
  const t = useT();
  const api = useApi();
  const { store } = useTriageContext();
  const ruleId = dialog.ruleId;
  const { data, loading, error } = useAsync(() => api.getRule(ruleId), [ruleId]);
  return (
    <Modal title={ruleId} width="w-[480px]" onClose={() => store.setDialog(null)} footer={
      <>
        <Link to={`/reglas/${ruleId}`} target="_blank" className="text-xs text-brand hover:underline">
          {t("common.openInNewTab")}
        </Link>
        <Button onClick={() => store.setDialog(null)}>{t("common.close")}</Button>
      </>
    }>
      {loading && <p className="text-gray-500">{t("common.loading")}</p>}
      {error && <p className="text-red-700">{t("errors.load")}</p>}
      {data && (
        <div className="space-y-2 text-sm">
          <p className="font-medium">{data.name}</p>
          <p className="text-gray-600">{data.description}</p>
          <ul className="list-disc pl-5 text-xs text-gray-600">
            {data.conditions.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <p className="text-xs text-gray-500">
            {t("rules.columns.hits")}: {data.hits7d} · {t("rules.columns.acceptance")}: {data.acceptance === null ? "—" : `${Math.round(data.acceptance * 100)} %`}
          </p>
        </div>
      )}
    </Modal>
  );
}

// ── Shortcut overlay (?) ───────────────────────────────────────────

const GROUP_LABEL: Record<HotkeyGroup, TKey> = {
  navigation: "shortcuts.navigation",
  decisions: "shortcuts.decisions",
  selection: "shortcuts.selection",
  viewer: "shortcuts.viewer",
  global: "shortcuts.global",
};

function ShortcutOverlay() {
  const t = useT();
  const { store } = useTriageContext();
  const docs = useHotkeyDocs();
  const groups: HotkeyGroup[] = ["navigation", "decisions", "selection", "viewer", "global"];
  return (
    <Modal title={t("shortcuts.title")} width="w-[900px]" onClose={() => store.setDialog(null)} onKeyDown={(e) => e.key === "?" && store.setDialog(null)}>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        {groups.map((g) => (
          <div key={g}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{t(GROUP_LABEL[g])}</h3>
            <dl className="space-y-1 text-xs">
              {docs
                .filter((d) => d.group === g)
                .map((d) => (
                  <div key={d.labelKey + d.keys.join()} className="flex items-start justify-between gap-2">
                    <dt className="text-gray-700">{t(d.labelKey)}</dt>
                    <dd className="flex flex-wrap justify-end gap-0.5">
                      {d.keys.map((k) => (
                        <Kbd key={k}>{displayKey(k)}</Kbd>
                      ))}
                    </dd>
                  </div>
                ))}
            </dl>
          </div>
        ))}
      </div>
      <p className="mt-4 border-t border-brand-muted/20 pt-2 text-xs text-gray-500">{t("source.legend")}</p>
      <p className="mt-1 text-xs text-gray-400">{t("shortcuts.closeHint")}</p>
    </Modal>
  );
}

/** Renders the open workspace dialog (fresh mount per dialog, so state resets). */
export function WorkspaceDialogs() {
  const { store } = useTriageContext();
  const dialog = useTriage(store, (s) => s.dialog);
  if (!dialog) return null;
  switch (dialog.type) {
    case "reason":
      return <ReasonCodePicker key={dialog.keys.join()} dialog={dialog} />;
    case "validity":
      return <ValidityMenu />;
    case "bulkAccept":
      return <BulkConfirmDialog dialog={dialog} />;
    case "note":
      return <NoteDialog dialog={dialog} />;
    case "compare":
      return <PropertyCompareModal dialog={dialog} />;
    case "rule":
      return <RuleDrawer dialog={dialog} />;
    case "shortcuts":
      return <ShortcutOverlay />;
    case "familyApprove":
      return <FamilyApproveDialog key={dialog.familyId} familyId={dialog.familyId} />;
    case "issueReject":
      return <IssueRejectDialog key={dialog.issueId} issueId={dialog.issueId} />;
    case "familyReject":
      return <FamilyRejectDialog key={dialog.familyId} familyId={dialog.familyId} />;
    default:
      return null;
  }
}
