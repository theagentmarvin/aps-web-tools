/**
 * Triage decision flows shared by hotkeys and buttons: accept with the dwell
 * guard, corrections with reason codes, reject, postpone, bulk actions
 * (spec §3.4, §3.5, §4.4, §4.5).
 */
import { createContext, useContext, useMemo } from "react";
import { useT, type TFunction } from "~/i18n";
import { band } from "~/lib/api/decision-utils";
import type { DecisionChange, DecisionField, Priority, Proposal, ProposedAction, ReasonCode, Validity } from "~/lib/api/types";
import { useToast } from "~/lib/components/Toast";
import { useSettings, type Settings } from "~/lib/settings";
import type { Evaluated } from "./filters";
import { parseKey, type PendingEdits, type TriageStore } from "./store";

export const BULK_CAP = 500;

export const REASONS_BY_FIELD: Record<DecisionField | "reject", ReasonCode[]> = {
  validity: ["R01", "R02", "R03", "R04", "R05", "R06", "R11", "R99"],
  priority: ["R08", "R09", "R99"],
  owner: ["R06", "R10", "R99"],
  action: ["R11", "R12", "R99"],
  group: ["R04", "R07", "R99"],
  issueDraft: ["R13", "R99"],
  reject: ["R01", "R02", "R03", "R04", "R05", "R06", "R07", "R11", "R12", "R99"],
};

const VALIDITY_REASON: Record<Validity, ReasonCode> = {
  false_positive: "R01",
  by_design: "R02",
  tolerance: "R03",
  duplicate: "R04",
  model_error: "R05",
  real: "R06",
  unknown: "R99",
};

export function defaultActionFor(v: Validity): ProposedAction {
  if (v === "real" || v === "model_error") return { createIssue: true, setStatus: "reviewed" };
  if (v === "unknown") return { createIssue: false, setStatus: null };
  return { createIssue: false, setStatus: "closed" };
}

export function suggestReason(field: DecisionField | "reject", ai: unknown, human: unknown): ReasonCode | undefined {
  if (field === "priority" && typeof ai === "number" && typeof human === "number") return human < ai ? "R09" : "R08";
  if (field === "validity") return VALIDITY_REASON[human as Validity];
  if (field === "owner") return "R10";
  if (field === "group") return "R07";
  if (field === "action") return "R12";
  return undefined;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Field-level changes of `edits` against the AI proposal (only real differences). */
export function changesFromEdits(proposal: Proposal | undefined, edits: PendingEdits, groupId?: string): DecisionChange[] {
  const out: DecisionChange[] = [];
  const f = proposal?.fields;
  const push = (field: DecisionField, ai: unknown, human: unknown, meta?: { confidence: number; source: string; ruleIds?: string[] }) => {
    if (human === undefined || same(ai, human)) return;
    out.push({ field, aiValue: ai ?? null, humanValue: human, aiConfidence: meta?.confidence, aiSource: meta?.source, ruleIds: meta?.ruleIds });
  };
  push("validity", f?.validity.value, edits.validity, f?.validity);
  push("priority", f?.priority.value, edits.priority, f?.priority);
  push("owner", f?.owner.value, edits.owner, f?.owner);
  push("action", f?.action.value, edits.action, f?.action);
  if (edits.group !== undefined) push("group", groupId ?? null, edits.group);
  if (edits.issue && Object.keys(edits.issue).length) push("issueDraft", proposal?.issueDraft ?? null, { ...proposal?.issueDraft, ...edits.issue });
  return out;
}

export function isRisky(e: Evaluated, s: Settings): boolean {
  const lowConf = e.d.confidence !== null && band(e.d.confidence, s.thresholds) === "baja";
  return lowConf || e.d.priority === 1 || e.values.delta.includes("reaparecida") || !!e.s.proposal?.spotCheck;
}

export interface TriageActions {
  accept(key?: string): void;
  reject(keys?: string[]): void;
  postpone(key?: string): void;
  setPriority(p: Priority): void;
  setValidity(v: Validity): void;
  openCorrection(keys: string[], edits: PendingEdits): void;
  saveReason(code: ReasonCode, note: string, suggestRule: boolean): void;
  bulkAccept(): void;
  confirmBulkAccept(keys: string[]): void;
  bulkReject(): void;
  bulkPriority(p: Priority): void;
  bulkValidity(v: Validity): void;
  bulkPostpone(): void;
  merge(): void;
  split(): void;
  undo(): void;
  redo(): void;
  acceptInherited(): void;
}

function announce(t: TFunction, label: string, store: TriageStore) {
  const el = document.getElementById("triage-live");
  if (!el) return;
  const i = store.cursorIndex();
  const pos = t("detail.group", { current: i + 1, total: store.state.rows.length });
  el.textContent = t("a11y.decisionAnnounce", { decision: label, position: pos });
}

export function createActions(store: TriageStore, settings: Settings, t: TFunction, toast: ReturnType<typeof useToast>): TriageActions {
  const cursor = () => store.state.cursorKey;
  const checkedKeys = () => [...store.state.checked].filter((k) => store.state.rows.some((r) => r.key === k));
  const advance = settings.autoAdvance;

  function openCorrection(keys: string[], edits: PendingEdits) {
    if (!keys.length) return;
    const { kind, id } = parseKey(keys[0]);
    const p = store.proposalFor(kind, id);
    const groupId = kind === "group" ? id : store.state.clashes.get(id)?.groupId;
    const changes = changesFromEdits(p, edits, groupId);
    if (!changes.length) {
      if (keys.length === 1) actions.accept(keys[0]);
      return;
    }
    const nonIssue = changes.filter((c) => c.field !== "issueDraft");
    if (!nonIssue.length) {
      // Only issue wording changed: R13 recorded automatically, no picker (§3.7).
      store.decide(keys, "correct", (k) => changesFor(k, edits), { reasonCode: "R13", label: t("decision.corrected"), advance });
      return;
    }
    const first = nonIssue[0];
    store.setDialog({ type: "reason", mode: "correct", keys, edits, field: first.field, suggested: suggestReason(first.field, first.aiValue, first.humanValue) });
  }

  function changesFor(key: string, edits: PendingEdits): DecisionChange[] {
    const { kind, id } = parseKey(key);
    const groupId = kind === "group" ? id : store.state.clashes.get(id)?.groupId;
    return changesFromEdits(store.proposalFor(kind, id), edits, groupId);
  }

  function blockedReason(e: Evaluated | undefined): string | null {
    if (!e?.s.proposal) return t("actions.nothingToAccept");
    if (e.s.group?.elementMissing || e.s.clash?.elementMissing) return t("delta.elementMissing");
    return null;
  }

  const actions: TriageActions = {
    accept(key = cursor() ?? undefined) {
      if (!key) return;
      const { kind, id } = parseKey(key);
      const e = store.evaluate(kind, id);
      const blocked = blockedReason(e);
      if (blocked) {
        store.setHint(blocked);
        return;
      }
      const edits = store.state.edits.get(id);
      if (edits && changesFor(key, edits).length) {
        openCorrection([key], edits);
        return;
      }
      if (e && isRisky(e, settings) && store.dwellFor(id) < settings.dwellGuardSec * 1000) {
        const g = store.state.guard;
        if (!g || g.targetId !== id || Date.now() - g.at > 3000) {
          store.setGuard(id, t("guard.lookFirst"));
          return;
        }
      }
      store.decide([key], "accept", () => [], { label: t("decision.accepted"), advance });
      announce(t, t("decision.accepted"), store);
    },

    reject(keys) {
      const ks = keys ?? (cursor() ? [cursor()!] : []);
      if (!ks.length) return;
      store.setDialog({ type: "reason", mode: "reject", keys: ks.slice(0, BULK_CAP), edits: {}, field: "reject" });
    },

    postpone(key = cursor() ?? undefined) {
      if (!key) return;
      store.decide([key], "postpone", () => [], { label: t("decision.postponed"), advance });
      announce(t, t("decision.postponed"), store);
    },

    setPriority(p) {
      const key = cursor();
      if (!key) return;
      const edits = { ...store.state.edits.get(parseKey(key).id), priority: p };
      openCorrection([key], edits);
    },

    setValidity(v) {
      const key = cursor();
      if (!key) return;
      const edits = { ...store.state.edits.get(parseKey(key).id), validity: v, action: defaultActionFor(v) };
      openCorrection([key], edits);
    },

    openCorrection,

    saveReason(code, note, suggestRule) {
      const d = store.state.dialog;
      if (!d || d.type !== "reason") return;
      store.setDialog(null);
      if (d.mode === "reject") {
        store.decide(d.keys, "reject", () => [], { reasonCode: code, note: note || undefined, suggestRule, label: t("decision.rejected"), advance: d.keys.length === 1 && advance });
        if (d.keys.length > 1) store.clearChecks();
        announce(t, t("decision.rejected"), store);
        return;
      }
      store.decide(d.keys, "correct", (k) => changesFor(k, d.edits), {
        reasonCode: code,
        note: note || undefined,
        suggestRule,
        label: t("decision.corrected"),
        advance: d.keys.length === 1 && advance,
      });
      if (d.keys.length > 1) store.clearChecks();
      announce(t, t("decision.corrected"), store);
    },

    bulkAccept() {
      const keys = checkedKeys();
      if (!keys.length) return;
      store.setDialog({ type: "bulkAccept", keys: keys.slice(0, BULK_CAP) });
    },

    confirmBulkAccept(keys) {
      store.setDialog(null);
      if (!keys.length) return;
      store.decide(keys, "accept", () => [], { label: t("bulk.confirm", { count: keys.length }) });
      store.clearChecks();
      toast.show(t("bulk.confirm", { count: keys.length }));
    },

    bulkReject() {
      const keys = checkedKeys();
      if (keys.length) actions.reject(keys);
    },

    bulkPriority(p) {
      const keys = checkedKeys().slice(0, BULK_CAP);
      if (keys.length) store.setDialog({ type: "reason", mode: "correct", keys, edits: { priority: p }, field: "priority", suggested: "R99" });
    },

    bulkValidity(v) {
      const keys = checkedKeys().slice(0, BULK_CAP);
      if (keys.length) store.setDialog({ type: "reason", mode: "correct", keys, edits: { validity: v, action: defaultActionFor(v) }, field: "validity", suggested: VALIDITY_REASON[v] });
    },

    bulkPostpone() {
      const keys = checkedKeys().slice(0, BULK_CAP);
      if (!keys.length) return;
      store.decide(keys, "postpone", () => [], { label: t("decision.postponed") });
      store.clearChecks();
    },

    merge() {
      const keys = checkedKeys().filter((k) => k.startsWith("g:"));
      if (keys.length < 2) return;
      const target = parseKey(keys[0]).id;
      store.setDialog({ type: "reason", mode: "correct", keys, edits: { group: target }, field: "group", suggested: "R07" });
    },

    split() {
      const keys = checkedKeys().filter((k) => k.startsWith("c:"));
      if (!keys.length) return;
      store.setDialog({ type: "reason", mode: "correct", keys, edits: { group: "nuevo" }, field: "group", suggested: "R07" });
    },

    undo() {
      const label = store.undo();
      if (label) toast.show(t("decision.undone", { action: label }));
    },

    redo() {
      const label = store.redo();
      if (label) toast.show(`${t("decision.redo")}: ${label}`);
    },

    acceptInherited() {
      const keys = store.state.rows.filter((r) => !r.nested && store.evaluate(r.kind, r.id)?.d.state === "inherited").map((r) => r.key);
      if (!keys.length) return;
      store.decide(keys.slice(0, BULK_CAP), "accept", () => [], { label: t("workspace.acceptInherited", { count: keys.length }) });
      toast.show(t("workspace.acceptInherited", { count: keys.length }));
    },
  };
  return actions;
}

export const TriageContext = createContext<{ store: TriageStore; actions: TriageActions } | null>(null);

export function useTriageContext() {
  const ctx = useContext(TriageContext);
  if (!ctx) throw new Error("TriageContext missing");
  return ctx;
}

export function useCreateActions(store: TriageStore): TriageActions {
  const t = useT();
  const toast = useToast();
  const { settings } = useSettings();
  return useMemo(() => createActions(store, settings, t, toast), [store, settings, t, toast]);
}

