/**
 * Assign a document discipline from the grid: discipline select, optional
 * naming rule ("Aplicar también a archivos que contengan …") with a live
 * preview, then "Reclasificando…" until the regrouped grid arrives.
 * In step mode it walks through the unassigned models one by one.
 */
import { useEffect, useRef, useState } from "react";
import { useI18n, useT } from "~/i18n";
import { useApi } from "~/lib/api";
import type { ClashGrid, Discipline, DisciplinePreview, DisciplineRuleInput, GridDocument } from "~/lib/api/types";

type PreviewMatch = DisciplinePreview["rules"][number]["matches"][number];
import { UNASSIGNED } from "~/lib/api/types";
import { Spinner } from "~/lib/components/icons";
import { Modal } from "~/lib/components/Modal";
import { Button, inputCls } from "~/lib/components/ui";
import { assignDiscipline, sourceLabel, suggestedRule } from "./disciplines";

interface Props {
  projectId: string;
  modelSetId: string;
  test?: string;
  /** Documents to edit: one, or the unassigned queue in step mode. */
  queue: GridDocument[];
  disciplines: Discipline[];
  onGrid: (g: ClashGrid) => void;
  onClose: () => void;
}

export function DisciplineDialog({ projectId, modelSetId, test, queue, disciplines, onGrid, onClose }: Props) {
  const [index, setIndex] = useState(0);
  const doc = queue[index];
  if (!doc) return null;
  const step = queue.length > 1;
  return (
    <DocForm
      key={doc.lineageUrn}
      projectId={projectId}
      modelSetId={modelSetId}
      test={test}
      doc={doc}
      disciplines={disciplines}
      position={step ? { current: index + 1, total: queue.length } : undefined}
      onSaved={(g) => {
        onGrid(g);
        if (step && index + 1 < queue.length) setIndex(index + 1);
        else onClose();
      }}
      onSkip={step && index + 1 < queue.length ? () => setIndex(index + 1) : undefined}
      onClose={onClose}
    />
  );
}

function DocForm({
  projectId,
  modelSetId,
  test,
  doc,
  disciplines,
  position,
  onSaved,
  onSkip,
  onClose,
}: {
  projectId: string;
  modelSetId: string;
  test?: string;
  doc: GridDocument;
  disciplines: Discipline[];
  position?: { current: number; total: number };
  onSaved: (g: ClashGrid) => void;
  onSkip?: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const { fmt, lang } = useI18n();
  const api = useApi();
  const choices = disciplines.filter((d) => d.code !== UNASSIGNED);
  // Unassigned: the coordinator must pick explicitly (no silent default).
  const initial = doc.discipline !== UNASSIGNED ? doc.discipline : "";
  const [discipline, setDiscipline] = useState(initial);
  const [withRule, setWithRule] = useState(true);
  const [rule, setRule] = useState<DisciplineRuleInput>(() => suggestedRule(doc, initial));
  const previewDiscipline = discipline || "SIN";
  const [matches, setMatches] = useState<PreviewMatch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectRef = useRef<HTMLSelectElement>(null);

  // Live preview of the optional rule (debounced).
  useEffect(() => {
    if (!withRule || !rule.value.trim()) {
      setMatches(null);
      return;
    }
    const id = window.setTimeout(() => {
      api.previewDisciplineRules(projectId, { modelSetId, rules: [{ ...rule, discipline: previewDiscipline }] }).then(
        (p) => setMatches(p.rules[0]?.matches ?? []),
        () => setMatches(null),
      );
    }, 250);
    return () => window.clearTimeout(id);
  }, [api, projectId, modelSetId, rule, previewDiscipline, withRule]);

  async function save() {
    if (!discipline) return;
    setBusy(true);
    setError(null);
    try {
      const g = await assignDiscipline(api, projectId, modelSetId, doc, { discipline, ...(withRule && rule.value.trim() ? { createRule: { ...rule, value: rule.value.trim(), discipline } } : {}) }, test);
      onSaved(g);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const label = (d: Discipline) => `${d.code} · ${lang === "en" ? d.en : d.es}`;
  const names = (matches ?? []).map((m) => `${m.fileName}${m.viewName ? ` - ${m.viewName}` : ""}`);

  return (
    <Modal
      title={t("disc.dialogTitle", { file: `${doc.fileName} - ${doc.viewName}` })}
      width="w-[520px]"
      onClose={busy ? () => undefined : onClose}
      initialFocus={selectRef}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !(e.target as HTMLElement).matches("textarea") && !busy && discipline) {
          e.preventDefault();
          void save();
        }
      }}
      footer={
        <>
          {position && <span className="mr-auto self-center text-xs text-gray-500">{t("disc.step", position)}</span>}
          {onSkip && (
            <Button onClick={onSkip} disabled={busy}>
              {t("disc.skip")}
            </Button>
          )}
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={save} disabled={busy || !discipline}>
            {busy ? (
              <>
                <Spinner /> {t("disc.reclassifying")}
              </>
            ) : onSkip ? (
              t("disc.saveNext")
            ) : (
              t("common.save")
            )}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-xs text-gray-600">
        {doc.discipline === UNASSIGNED || doc.disciplineSource === "unassigned"
          ? t("disc.currentUnassigned")
          : t("disc.current", { discipline: doc.discipline, source: sourceLabel(t, doc, fmt.pct) })}
        {doc.folderPath && <span className="ml-1 text-gray-400">· {t("grid.folder", { folder: doc.folderPath })}</span>}
      </p>
      <label className="block">
        <span className="text-xs text-gray-500">{t("disc.choose")}</span>
        <select ref={selectRef} className={`${inputCls} mt-1 w-full`} value={discipline} onChange={(e) => setDiscipline(e.target.value)}>
          {!discipline && <option value="">{t("disc.pick")}</option>}
          {choices.map((d) => (
            <option key={d.code} value={d.code}>
              {label(d)}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="mt-4 rounded border border-brand-muted/20 p-3">
        <legend className="sr-only">{t("disc.applyAlso")}</legend>
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <input type="checkbox" className="accent-brand" checked={withRule} onChange={(e) => setWithRule(e.target.checked)} />
          {t("disc.applyAlso")}
          <select aria-label={t("grid.view")} className={`${inputCls} py-0.5 text-xs`} value={rule.field} disabled={!withRule} onChange={(e) => setRule({ ...rule, field: e.target.value as DisciplineRuleInput["field"] })}>
            <option value="fileName">{t("disc.field.fileName")}</option>
            <option value="folder">{t("disc.field.folder")}</option>
          </select>
          <select aria-label={t("disc.token")} className={`${inputCls} py-0.5 text-xs`} value={rule.match} disabled={!withRule} onChange={(e) => setRule({ ...rule, match: e.target.value as DisciplineRuleInput["match"] })}>
            <option value="contains">{t("disc.match.contains")}</option>
            <option value="startsWith">{t("disc.match.startsWith")}</option>
          </select>
          <input aria-label={t("disc.token")} className={`${inputCls} w-40 py-0.5 font-mono text-xs`} value={rule.value} disabled={!withRule} onChange={(e) => setRule({ ...rule, value: e.target.value })} />
        </label>
        {withRule && (
          <p className="mt-2 text-xs text-gray-600" aria-live="polite">
            {matches === null ? "…" : matches.length === 0 ? t("disc.previewNone") : t("disc.preview", { count: matches.length, names: names.join(", ") })}
          </p>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="mt-3 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
          {error}
        </p>
      )}
    </Modal>
  );
}
