/**
 * Coordinator rule change: Calibrar (outcome + numeric thresholds), Editar condiciones (guided
 * form or advanced YAML, position kept), Retirar (→ Biblioteca) and Restaurar. Always "Ver
 * impacto" first (server preview: impact on the selected test, shadowing, safety), then a rule
 * suggestion (origin coordinador) that is approved and published with passkey like the agent's.
 */
import { useMemo, useState, type ReactNode } from "react";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { classLabel } from "@core/group/labels";
import { useI18n, useT, type TKey } from "~/i18n";
import { useApi } from "~/lib/api";
import type { RuleChangePreview, RuleChangeRequest, RuleDefinition, RuleLibraryRow, RuleRow, RuleSuggestion, RuleThreshold } from "~/lib/api/types";
import { Modal } from "~/lib/components/Modal";
import { Button, inputCls } from "~/lib/components/ui";
import { VALIDITY_KEY } from "~/lib/labels";
import { emptySide, formToRule, ruleToForm, type RuleForm, type SideForm } from "./rule-form";

export type RuleChangeMode = "calibrate" | "edit" | "retire" | "restore";

const VALIDITIES = ["real", "false_positive", "tolerated", "needs_info"] as const;
const SEVERITIES = ["critical", "high", "medium", "low", "none"] as const;
const ACTIONS = ["create_issue", "hygiene_issue", "request_info", "escalate", "mark_reviewed", "close_not_issue"] as const;
const RESPONSIBLES = ["$a", "$b", "@mover", "@other", "COORD", "ARQ", "EST", "CLI", "SAN", "AP", "ALC", "ALL", "ELE", "CORR", "INC", "GAS", "ASC"];
const CLASS_SETS = ["", "STRUCTURE", "MEP_DIST", "MEP_ANY", "ARCH_FIXED"];
const ORIENTATIONS = ["vertical", "horizontal", "sloped"];
const FIELD_ES: Record<string, string> = { sizeMm: "tamaño (mm)", penetrationMm: "penetración (mm)", distanceMm: "distancia (mm)", penetrationRatio: "proporción de penetración", thicknessMm: "espesor (mm)", diameterMm: "diámetro (mm)", insulationThicknessMm: "aislación (mm)", modelAgeDays: "antigüedad del modelo (días)", widthMm: "ancho (mm)", heightMm: "alto (mm)" };
const OP_ES: Record<string, string> = { gte: "≥", gt: ">", lte: "≤", lt: "<", eq: "=" };
const BLOCK_ES: Record<string, string> = { a: "lado A", b: "lado B", both: "ambos lados", clash: "interferencia" };

export function responsibleLabel(t: ReturnType<typeof useT>, who: string): string {
  return who.startsWith("$") || who.startsWith("@") ? t(`rules.board.responsible.${who}` as TKey) : who;
}

export function thresholdLabel(th: RuleThreshold): string {
  return `${BLOCK_ES[th.block] ?? th.block} · ${FIELD_ES[th.field] ?? th.field} ${OP_ES[th.op] ?? th.op}`;
}

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const numOrNull = (s: string) => (s.trim() === "" || Number.isNaN(Number(s)) ? null : Number(s));

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block text-xs text-gray-600">
      <span className="mb-0.5 block">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[11px] text-gray-400">{hint}</span>}
    </label>
  );
}

interface Outcome {
  validity: string;
  responsibleDiscipline: string;
  severity: string;
  suggestedAction: string;
  humanReview: boolean;
}

function OutcomeFields({ value, onChange }: { value: Outcome; onChange: (o: Outcome) => void }) {
  const t = useT();
  const sel = `${inputCls} w-full py-1`;
  const responsibles = RESPONSIBLES.includes(value.responsibleDiscipline) ? RESPONSIBLES : [value.responsibleDiscipline, ...RESPONSIBLES];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Field label={t("rules.board.dialog.validity")}>
        <select className={sel} value={value.validity} onChange={(e) => onChange({ ...value, validity: e.target.value })}>
          {VALIDITIES.map((v) => (
            <option key={v} value={v}>
              {t(VALIDITY_KEY[v])}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("rules.board.dialog.responsible")}>
        <select className={sel} value={value.responsibleDiscipline} onChange={(e) => onChange({ ...value, responsibleDiscipline: e.target.value })}>
          {responsibles.map((r) => (
            <option key={r} value={r}>
              {responsibleLabel(t, r)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("rules.board.dialog.severity")}>
        <select className={sel} value={value.severity} onChange={(e) => onChange({ ...value, severity: e.target.value })}>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {t(`severity.${s}` as TKey)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("rules.board.dialog.action")}>
        <select className={sel} value={value.suggestedAction} onChange={(e) => onChange({ ...value, suggestedAction: e.target.value })}>
          {ACTIONS.map((a) => (
            <option key={a} value={a}>
              {t(`chat.cardAction.${a}` as TKey)}
            </option>
          ))}
        </select>
      </Field>
      <label className="col-span-2 flex items-center gap-2 text-xs text-gray-700 sm:col-span-4">
        <input type="checkbox" checked={value.humanReview} onChange={(e) => onChange({ ...value, humanReview: e.target.checked })} />
        {t("rules.board.dialog.humanReview")}
      </label>
    </div>
  );
}

function SideFields({ value, onChange, title }: { value: SideForm; onChange: (s: SideForm) => void; title: string }) {
  const t = useT();
  const txt = `${inputCls} w-full py-1`;
  const classes = value.classes.map((c) => classLabel(c).one).join(", ");
  return (
    <fieldset className="space-y-1.5 rounded border border-brand-muted/20 p-2">
      <legend className="px-1 text-xs font-medium text-gray-700">{title}</legend>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("rules.board.dialog.disciplines")} hint={t("rules.board.dialog.listHint")}>
          <input className={txt} value={value.disciplines.join(", ")} onChange={(e) => onChange({ ...value, disciplines: list(e.target.value.toUpperCase()) })} placeholder={t("rules.board.dialog.any")} />
        </Field>
        <Field label={t("rules.board.dialog.classSet")}>
          <select className={txt} value={value.classSet} onChange={(e) => onChange({ ...value, classSet: e.target.value, ...(e.target.value ? { classes: [] } : {}) })}>
            {CLASS_SETS.map((c) => (
              <option key={c} value={c}>
                {c || "—"}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("rules.board.dialog.classes")} hint={classes || t("rules.board.dialog.listHint")}>
          <input className={txt} disabled={!!value.classSet} value={value.classes.join(", ")} onChange={(e) => onChange({ ...value, classes: list(e.target.value) })} placeholder={t("rules.board.dialog.any")} />
        </Field>
        <Field label={t("rules.board.dialog.categories")} hint={t("rules.board.dialog.listHint")}>
          <input className={txt} value={value.categories.join(", ")} onChange={(e) => onChange({ ...value, categories: list(e.target.value) })} placeholder={t("rules.board.dialog.any")} />
        </Field>
        <Field label={t("rules.board.dialog.system")}>
          <input className={txt} value={value.systemMatches} onChange={(e) => onChange({ ...value, systemMatches: e.target.value })} placeholder={t("rules.board.dialog.any")} />
        </Field>
        <Field label={t("rules.board.dialog.orientation")}>
          <span className="flex gap-2 py-1">
            {ORIENTATIONS.map((o) => (
              <label key={o} className="flex items-center gap-1 text-gray-700">
                <input type="checkbox" checked={value.orientation.includes(o)} onChange={(e) => onChange({ ...value, orientation: e.target.checked ? [...value.orientation, o] : value.orientation.filter((x) => x !== o) })} />
                {o}
              </label>
            ))}
          </span>
        </Field>
        <Field label={value.sizeMinOp === "gt" ? t("rules.board.dialog.sizeMin").replace("≥", ">") : t("rules.board.dialog.sizeMin")}>
          <input type="number" className={txt} value={value.sizeMin ?? ""} onChange={(e) => onChange({ ...value, sizeMin: numOrNull(e.target.value) })} />
        </Field>
        <Field label={value.sizeMaxOp === "lt" ? t("rules.board.dialog.sizeMax").replace("≤", "<") : t("rules.board.dialog.sizeMax")}>
          <input type="number" className={txt} value={value.sizeMax ?? ""} onChange={(e) => onChange({ ...value, sizeMax: numOrNull(e.target.value) })} />
        </Field>
      </div>
    </fieldset>
  );
}

function PreviewView({ p }: { p: RuleChangePreview }) {
  const t = useT();
  const { fmt } = useI18n();
  const names = (l: { ruleId: string; nameEs: string; clashes: number }[]) => l.map((x) => `«${x.nameEs}» (${x.ruleId}, ${fmt.number(x.clashes)})`).join(", ");
  return (
    <section className="space-y-2 rounded border border-brand-muted/20 bg-brand-surface/40 p-3 text-sm" aria-live="polite" lang="es">
      {p.errors.length > 0 && (
        <div role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">
          <p className="font-medium">{t("rules.board.dialog.errors")}</p>
          <ul className="list-disc pl-4">
            {p.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {p.effect.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-gray-600">{t("rules.board.dialog.effect")}</h3>
          <ul className="list-disc pl-5 text-gray-800">
            {p.effect.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {p.impact && (
        <div className="text-xs text-gray-700">
          <h3 className="font-medium text-gray-600">{t("rules.board.dialog.impactTitle", { version: p.impact.version })}</h3>
          <p>{t("rules.board.dialog.impactLine", { clashes: fmt.number(p.impact.clashes), groups: fmt.number(p.impact.groups), families: fmt.number(p.impact.families), changed: fmt.number(p.impact.ruleChanged) })}</p>
          {p.impact.toFallback > 0 && <p>{t("rules.board.dialog.toFallback", { count: fmt.number(p.impact.toFallback) })}</p>}
          {p.impact.newlyClosing > 0 && <p className="text-amber-800">{t("rules.board.dialog.newlyClosing", { count: fmt.number(p.impact.newlyClosing) })}</p>}
        </div>
      )}
      {p.focus && (
        <div className="text-xs text-gray-700">
          <p>{t("rules.board.dialog.focusLine", { matches: fmt.number(p.focus.matches), wins: fmt.number(p.focus.wins) })}</p>
          {p.focus.shadowedBy.length > 0 && <p>{t("rules.board.dialog.shadowedBy", { list: names(p.focus.shadowedBy) })}</p>}
          {p.focus.shadows.length > 0 && <p>{t("rules.board.dialog.shadows", { list: names(p.focus.shadows) })}</p>}
        </div>
      )}
      {p.warnings.length > 0 && (
        <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
          <p className="font-medium">{t("rules.board.dialog.warnings")}</p>
          <ul className="list-disc pl-4">
            {p.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

const outcomeOf = (then: RuleDefinition["then"]): Outcome => ({
  validity: String(then.validity),
  responsibleDiscipline: String(then.responsibleDiscipline),
  severity: String(then.severity),
  suggestedAction: String(then.suggestedAction),
  humanReview: !!then.humanReview,
});

export function RuleChangeDialog({
  mode,
  row,
  lib,
  testKey,
  onClose,
  onCreated,
}: {
  mode: RuleChangeMode;
  row?: RuleRow;
  lib?: RuleLibraryRow;
  testKey?: string;
  onClose: () => void;
  onCreated: (s: RuleSuggestion) => void;
}) {
  const t = useT();
  const api = useApi();
  const raw = row?.raw;
  const name = row?.nameEs ?? lib?.nameEs ?? "";
  const [outcome, setOutcome] = useState<Outcome | null>(raw ? outcomeOf(raw.then) : null);
  const [thresholds, setThresholds] = useState<Record<string, string>>(() => Object.fromEntries((row?.thresholds ?? []).map((x) => [x.path, String(x.value)])));
  const [nameEs, setNameEs] = useState(raw?.nameEs ?? name);
  const initialForm = useMemo(() => (raw ? ruleToForm({ ...raw, nameEs: raw.nameEs ?? name }) : null), [raw, name]);
  const [form, setForm] = useState<RuleForm | null>(initialForm);
  const [advanced, setAdvanced] = useState(mode === "edit" && !initialForm);
  const [yaml, setYaml] = useState(() => (raw ? toYaml({ id: raw.id, name: raw.name, nameEs: raw.nameEs ?? name, when: raw.when, then: raw.then }, { lineWidth: 0 }) : ""));
  const [rationale, setRationale] = useState("");
  const [preview, setPreview] = useState<RuleChangePreview | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState<"preview" | "submit" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const touch = () => preview && setStale(true);

  function change(): RuleChangeRequest {
    if (mode === "retire") return { kind: "retire", ruleIds: [row!.id] };
    if (mode === "restore") return { kind: "restore", ruleIds: [lib!.id] };
    if (mode === "calibrate") {
      const then: Record<string, unknown> = {};
      const o = outcome!;
      const old = outcomeOf(raw!.then);
      for (const k of ["validity", "responsibleDiscipline", "severity", "suggestedAction", "humanReview"] as const) if (o[k] !== old[k]) then[k] = o[k];
      const th = (row?.thresholds ?? []).filter((x) => numOrNull(thresholds[x.path] ?? "") !== null && Number(thresholds[x.path]) !== x.value).map((x) => ({ path: x.path, value: Number(thresholds[x.path]) }));
      return { kind: "calibrate", ruleId: row!.id, ...(Object.keys(then).length ? { then } : {}), ...(th.length ? { thresholds: th } : {}), ...(nameEs.trim() && nameEs.trim() !== (raw!.nameEs ?? name) ? { nameEs: nameEs.trim() } : {}) };
    }
    if (advanced) return { kind: "edit", ruleId: row!.id, rule: yaml };
    return { kind: "edit", ruleId: row!.id, rule: formToRule(form!) };
  }

  async function run(kind: "preview" | "submit") {
    setBusy(kind);
    setErr(null);
    try {
      if (kind === "preview") {
        setPreview(await api.previewRuleChange(change(), testKey));
        setStale(false);
      } else {
        onCreated(await api.createRuleSuggestion({ change: change(), rationale: rationale.trim(), ...(testKey ? { testKey } : {}) }));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const title =
    mode === "calibrate" ? t("rules.board.dialog.calibrateTitle", { name }) : mode === "edit" ? t("rules.board.dialog.editTitle", { name }) : mode === "retire" ? t("rules.board.dialog.retireTitle", { name }) : t("rules.board.dialog.restoreTitle", { name });
  const canSubmit = !!preview && !stale && preview.errors.length === 0 && rationale.trim().length > 0 && !busy;
  const txt = `${inputCls} w-full py-1`;

  return (
    <Modal
      title={title}
      onClose={onClose}
      width="w-[min(860px,96vw)]"
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-[11px] text-gray-500">{t("rules.board.dialog.passkeyNote")}</span>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button disabled={!!busy} onClick={() => void run("preview")}>
            {busy === "preview" ? t("rules.board.dialog.previewing") : t("rules.board.dialog.preview")}
          </Button>
          <Button variant="primary" disabled={!canSubmit} onClick={() => void run("submit")}>
            {busy === "submit" ? t("rules.board.dialog.submitting") : t("rules.board.dialog.submit")}
          </Button>
        </div>
      }
    >
      <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1 text-sm">
        {mode === "retire" && <p className="text-gray-700">{t("rules.board.dialog.retireExplain")}</p>}
        {mode === "restore" && <p className="text-gray-700">{t("rules.board.dialog.restoreExplain")}</p>}
        {mode === "calibrate" && outcome && (
          <>
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">{t("rules.board.dialog.outcome")}</h3>
              <OutcomeFields
                value={outcome}
                onChange={(o) => {
                  setOutcome(o);
                  touch();
                }}
              />
            </section>
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">{t("rules.board.dialog.thresholds")}</h3>
              {row?.thresholds.length ? (
                <div className="grid grid-cols-2 gap-2">
                  {row.thresholds.map((th) => (
                    <Field key={th.path} label={thresholdLabel(th)}>
                      <input
                        type="number"
                        className={txt}
                        value={thresholds[th.path] ?? ""}
                        onChange={(e) => {
                          setThresholds({ ...thresholds, [th.path]: e.target.value });
                          touch();
                        }}
                      />
                    </Field>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-gray-500">{t("rules.board.dialog.noThresholds")}</p>
              )}
            </section>
            <Field label={t("rules.board.dialog.nameEs")}>
              <input
                className={txt}
                value={nameEs}
                onChange={(e) => {
                  setNameEs(e.target.value);
                  touch();
                }}
              />
            </Field>
          </>
        )}
        {mode === "edit" && !advanced && form && (
          <>
            <Field label={t("rules.board.dialog.nameEs")}>
              <input
                className={txt}
                value={form.nameEs}
                onChange={(e) => {
                  setForm({ ...form, nameEs: e.target.value });
                  touch();
                }}
              />
            </Field>
            <label className="flex items-center gap-2 text-xs text-gray-700">
              <input
                type="checkbox"
                checked={form.symmetric}
                onChange={(e) => {
                  setForm({ ...form, symmetric: e.target.checked, b: emptySide() });
                  touch();
                }}
              />
              {t("rules.board.dialog.symmetric")}
            </label>
            <div className={`grid gap-2 ${form.symmetric ? "" : "sm:grid-cols-2"}`}>
              <SideFields
                title={t("rules.board.dialog.sideA")}
                value={form.a}
                onChange={(a) => {
                  setForm({ ...form, a });
                  touch();
                }}
              />
              {!form.symmetric && (
                <SideFields
                  title={t("rules.board.dialog.sideB")}
                  value={form.b}
                  onChange={(b) => {
                    setForm({ ...form, b });
                    touch();
                  }}
                />
              )}
            </div>
            <fieldset className="grid grid-cols-3 gap-2 rounded border border-brand-muted/20 p-2">
              <legend className="px-1 text-xs font-medium text-gray-700">{t("rules.board.dialog.and")}</legend>
              <Field label={t("rules.board.dialog.penetrationMin")}>
                <input
                  type="number"
                  className={txt}
                  value={form.penetrationMinMm ?? ""}
                  onChange={(e) => {
                    setForm({ ...form, penetrationMinMm: numOrNull(e.target.value) });
                    touch();
                  }}
                />
              </Field>
              <Field label={t("rules.board.dialog.distanceMax")}>
                <input
                  type="number"
                  className={txt}
                  value={form.distanceMaxMm ?? ""}
                  onChange={(e) => {
                    setForm({ ...form, distanceMaxMm: numOrNull(e.target.value) });
                    touch();
                  }}
                />
              </Field>
              <Field label={t("rules.board.dialog.sameLevel")}>
                <select
                  className={txt}
                  value={form.sameLevel === null ? "" : String(form.sameLevel)}
                  onChange={(e) => {
                    setForm({ ...form, sameLevel: e.target.value === "" ? null : e.target.value === "true" });
                    touch();
                  }}
                >
                  <option value="">{t("rules.board.dialog.indifferent")}</option>
                  <option value="true">{t("rules.board.dialog.yes")}</option>
                  <option value="false">{t("rules.board.dialog.no")}</option>
                </select>
              </Field>
            </fieldset>
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">{t("rules.board.dialog.then")}</h3>
              <OutcomeFields
                value={outcomeOf(form.then)}
                onChange={(o) => {
                  setForm({ ...form, then: { ...form.then, ...o } });
                  touch();
                }}
              />
            </section>
            <button type="button" className="text-xs text-brand hover:underline" onClick={() => {
              setYaml(toYaml(formToRule(form), { lineWidth: 0 }));
              setAdvanced(true);
              touch();
            }}>
              {t("rules.board.dialog.advanced")}
            </button>
          </>
        )}
        {mode === "edit" && advanced && (
          <>
            {!initialForm && <p className="text-xs text-gray-600">{t("rules.board.dialog.advancedHint")}</p>}
            <Field label={t("rules.board.dialog.advanced")}>
              <textarea
                className={`${inputCls} h-64 w-full font-mono text-xs`}
                spellCheck={false}
                value={yaml}
                onChange={(e) => {
                  setYaml(e.target.value);
                  touch();
                }}
              />
            </Field>
            {initialForm && (
              <button
                type="button"
                className="text-xs text-brand hover:underline"
                onClick={() => {
                  try {
                    const back = ruleToForm(parseYaml(yaml) as RuleDefinition);
                    if (back) {
                      setForm(back);
                      setAdvanced(false);
                    }
                  } catch {
                    /* stays in YAML */
                  }
                }}
              >
                {t("rules.board.dialog.toForm")}
              </button>
            )}
          </>
        )}
        <Field label={t("rules.board.dialog.rationale")}>
          <textarea className={`${inputCls} h-16 w-full`} value={rationale} placeholder={t("rules.board.dialog.rationalePlaceholder")} onChange={(e) => setRationale(e.target.value)} maxLength={1500} />
        </Field>
        {preview && <PreviewView p={preview} />}
        {stale && <p className="text-xs text-amber-800">{t("rules.board.dialog.stale")}</p>}
        {err && (
          <p role="alert" className="text-xs text-red-700">
            {err}
          </p>
        )}
      </div>
    </Modal>
  );
}
