/**
 * Reglas › Reglas: explainer, pending suggestions (agent or coordinator), active rules grouped by
 * discipline pair with their use in the selected test and their acierto, the Biblioteca of retired
 * rules and the read-only automatic alerts. Human actions per rule: Calibrar · Editar condiciones ·
 * Retirar (· Restaurar in the Biblioteca) — each becomes a suggestion approved and published with
 * passkey, exactly like the agent's.
 */
import { useState } from "react";
import { Link } from "react-router";
import { useI18n, useT, type TKey } from "~/i18n";
import { useApi, useAsync } from "~/lib/api";
import type { RuleLibraryRow, RuleRow, RulesOverview } from "~/lib/api/types";
import { MenuButton, menuItemCls } from "~/lib/components/MenuButton";
import { IconMore } from "~/lib/components/icons";
import { useToast } from "~/lib/components/Toast";
import { Button, ErrorState, SkeletonRows, cardCls, inputCls } from "~/lib/components/ui";
import { VALIDITY_KEY } from "~/lib/labels";
import { readString, writeString } from "~/lib/storage";
import type { Validity } from "~/lib/api/types";
import { RuleChangeDialog, responsibleLabel, type RuleChangeMode } from "./RuleChangeDialog";
import { accuracyTone, GROUP_GENERAL, GROUP_HYGIENE, groupRulesByPair, pairTokens } from "./rule-groups";
import { Suggestions } from "./SuggestionCard";

const EXPLAINER_KEY = "coord.rules.explainer";
const KNOWN_SIDES = new Set(["EST", "ARQ", "MEP", "INC", "ASC"]);

export function useRuleLabels() {
  const t = useT();
  const side = (s: string) => (s === "*" ? t("rules.board.side.any") : KNOWN_SIDES.has(s) ? t(`rules.board.side.${s}` as TKey) : s);
  const groupLabel = (key: string) => (key === GROUP_HYGIENE ? t("rules.board.group.HYG") : key === GROUP_GENERAL ? t("rules.board.group.GEN") : pairTokens(key).map(side).join(" × "));
  const validity = (v: string) => (v in VALIDITY_KEY ? t(VALIDITY_KEY[v as Validity]) : v);
  const outcome = (r: Pick<RuleRow, "validity" | "responsible" | "action" | "humanReview">) =>
    [validity(r.validity), t("rules.board.outcomeResponsible", { who: responsibleLabel(t, r.responsible) }), t(`chat.cardAction.${r.action}` as TKey), r.humanReview ? t("rules.board.humanReview") : ""].filter(Boolean).join(" · ");
  return { side, groupLabel, validity, outcome };
}

function Explainer() {
  const t = useT();
  const [open, setOpen] = useState(() => readString(EXPLAINER_KEY) !== "closed");
  const toggle = () => {
    writeString(EXPLAINER_KEY, open ? "closed" : "open");
    setOpen(!open);
  };
  if (!open)
    return (
      <button type="button" onClick={toggle} className="mb-3 text-xs text-brand hover:underline">
        {t("rules.board.show")}
      </button>
    );
  return (
    <section className="mb-4 rounded-lg border border-brand-muted/20 bg-brand-surface/40 p-3 text-sm text-gray-700" aria-label={t("rules.board.explainerTitle")}>
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-sm font-semibold text-gray-800">{t("rules.board.explainerTitle")}</h2>
        <button type="button" onClick={toggle} className="text-xs text-brand hover:underline">
          {t("rules.board.hide")}
        </button>
      </div>
      <p className="mt-1">{t("rules.board.explainer1")}</p>
      <p className="mt-1">{t("rules.board.explainer2")}</p>
      <p className="mt-1 text-xs text-gray-500">{t("rules.board.explainer3")}</p>
    </section>
  );
}

type DialogState = { mode: RuleChangeMode; row?: RuleRow; lib?: RuleLibraryRow } | null;

export function RulesBoard() {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const [testKey, setTestKey] = useState<string | undefined>(() => readString("coord.rules.test") ?? undefined);
  const { data, error, loading, reload } = useAsync<RulesOverview>(() => api.getRulesOverview(testKey), [api, testKey]);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [version, setVersion] = useState(0);
  const pending = (s: { state: string }) => s.state === "pending" || s.state === "approved";
  return (
    <div className="space-y-5">
      <Explainer />
      <section aria-labelledby="rb-pending">
        <PendingHeader version={version} />
        <Suggestions filter={pending} emptyKey="rules.board.noPending" version={version} />
      </section>
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading || !data ? (
        <SkeletonRows count={8} height="h-8" />
      ) : (
        <>
          <ActiveRules
            data={data}
            onTest={(k) => {
              writeString("coord.rules.test", k);
              setTestKey(k);
            }}
            onAction={setDialog}
          />
          <Library data={data} onRestore={(lib) => setDialog({ mode: "restore", lib })} />
          <Alerts data={data} />
        </>
      )}
      {dialog && (
        <RuleChangeDialog
          mode={dialog.mode}
          row={dialog.row}
          lib={dialog.lib}
          testKey={data?.selectedTestKey}
          onClose={() => setDialog(null)}
          onCreated={() => {
            setDialog(null);
            setVersion((v) => v + 1);
            toast.show(t("rules.board.dialog.created"));
          }}
        />
      )}
    </div>
  );
}

function PendingHeader({ version }: { version: number }) {
  const t = useT();
  const api = useApi();
  const { data } = useAsync(() => api.listRuleSuggestions(), [api, version]);
  const n = (data ?? []).filter((s) => s.state === "pending" || s.state === "approved").length;
  return (
    <h2 id="rb-pending" className="mb-2 text-sm font-semibold text-gray-800">
      {t("rules.board.agentSuggestions", { count: n })}
    </h2>
  );
}

function ActiveRules({ data, onTest, onAction }: { data: RulesOverview; onTest: (k: string) => void; onAction: (d: DialogState) => void }) {
  const t = useT();
  const { fmt } = useI18n();
  const L = useRuleLabels();
  const test = data.tests.find((x) => x.testKey === data.selectedTestKey);
  const groups = groupRulesByPair(data.rules);
  const link = (r: RuleRow) => (test ? `/coordinacion/${encodeURIComponent(test.projectId)}/${encodeURIComponent(test.modelSetId)}?test=${encodeURIComponent(test.testKey)}&regla=${r.id}&decision=&lente=todo` : undefined);
  return (
    <section aria-labelledby="rb-active">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h2 id="rb-active" className="text-sm font-semibold text-gray-800">
          {t("rules.board.activeTitle", { count: data.rules.length })}
        </h2>
        <label className="ml-auto flex items-center gap-2 text-xs text-gray-600">
          {t("rules.board.testLabel")}
          <select className={`${inputCls} max-w-[22rem] py-1 text-xs`} value={data.selectedTestKey ?? ""} onChange={(e) => onTest(e.target.value)} disabled={!data.tests.length}>
            {data.tests.map((x) => (
              <option key={x.testKey} value={x.testKey}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!test && <p className="mb-2 text-xs text-gray-500">{t("rules.board.noTest")}</p>}
      <div className={`${cardCls} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-brand-muted/20 text-left text-xs text-gray-500">
              <th className="px-3 py-2 font-medium">{t("rules.columns.name")}</th>
              <th className="px-3 py-2 font-medium">{t("rules.outcome")}</th>
              <th className="px-3 py-2 font-medium">{t("rules.board.testLabel")}</th>
              <th className="px-3 py-2 font-medium">{t("rules.board.accuracy")}</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.key}>
              <tr className="bg-gray-50">
                <th colSpan={5} className="px-3 py-1.5 text-left text-xs font-semibold text-gray-700">
                  {L.groupLabel(g.key)} <span className="font-normal text-gray-400">· {g.rows.length}</span>
                </th>
              </tr>
              {g.rows.map((r) => {
                const tone = accuracyTone(r.accuracy);
                const href = link(r);
                return (
                  <tr key={r.id} className="border-b border-brand-muted/10 align-top last:border-0 hover:bg-gray-50/60">
                    <td className="px-3 py-1.5">
                      <span lang="es" className="text-gray-900">
                        {r.nameEs}
                      </span>{" "}
                      <Link to={`/reglas/${r.id}`} className="font-mono text-[11px] text-gray-400 hover:text-brand">
                        {r.id}
                      </Link>
                    </td>
                    <td className="px-3 py-1.5 text-xs text-gray-700">{L.outcome(r)}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-xs">
                      {r.usage === null ? (
                        "—"
                      ) : r.usage.clashes > 0 && href ? (
                        <Link to={href} className="text-brand hover:underline" title={t("rules.board.openWorkspace")}>
                          {t("rules.board.inProject", { clashes: fmt.number(r.usage.clashes), groups: fmt.number(r.usage.groups) })}
                        </Link>
                      ) : (
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500" title={r.totalUse ? t("rules.board.zeroUseTip") : t("rules.board.neverUsed")}>
                          {r.totalUse ? t("rules.board.inProjectZero") : t("rules.board.zeroUse")}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-xs">
                      {tone === "none" ? (
                        <span className="text-gray-400" title={t("rules.board.accuracyNoneTip", { min: data.minAccuracyN })}>
                          {t("rules.board.accuracyNone")}
                          {r.accuracy.n > 0 ? ` (n=${r.accuracy.n})` : ""}
                        </span>
                      ) : (
                        <span className={tone === "low" ? "font-medium text-red-700" : "text-gray-700"} title={[t("rules.board.accuracyTip", { agree: r.accuracy.agree, n: r.accuracy.n }), r.accuracy.topCorrection ? t("rules.board.topCorrection", { text: r.accuracy.topCorrection }) : "", tone === "low" ? t("rules.board.accuracyLow") : ""].filter(Boolean).join(" · ")}>
                          {t("rules.board.accuracyValue", { pct: fmt.pct(r.accuracy.rate ?? 0), n: r.accuracy.n })}
                          {tone === "low" ? " ⚠" : ""}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button className="py-0.5 text-xs" onClick={() => onAction({ mode: "calibrate", row: r })}>
                          {t("rules.board.calibrate")}
                        </Button>
                        <MenuButton label={<IconMore size={14} />} title={t("rules.board.more")} className="inline-flex h-6 w-7 items-center justify-center rounded border border-brand-muted/30 text-gray-600 hover:text-brand" panelClassName="w-52">
                          {(close) => (
                            <>
                              <button type="button" role="menuitem" className={menuItemCls} onClick={() => (close(), onAction({ mode: "edit", row: r }))}>
                                {t("rules.board.editConditions")}
                              </button>
                              <button type="button" role="menuitem" className={menuItemCls} disabled={r.fallback} title={r.fallback ? t("rules.board.fallbackNote") : undefined} onClick={() => (close(), onAction({ mode: "retire", row: r }))}>
                                {t("rules.board.retire")}
                              </button>
                              <Link role="menuitem" to={`/reglas/${r.id}`} className={menuItemCls} onClick={close}>
                                {t("rules.board.viewDetail")}
                              </Link>
                            </>
                          )}
                        </MenuButton>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  );
}

function Library({ data, onRestore }: { data: RulesOverview; onRestore: (lib: RuleLibraryRow) => void }) {
  const t = useT();
  const { fmt } = useI18n();
  const L = useRuleLabels();
  return (
    <details className={`${cardCls} p-3`}>
      <summary className="cursor-pointer text-sm font-semibold text-gray-800">{t("rules.board.libraryTitle", { count: data.library.length })}</summary>
      <p className="mt-1 text-xs text-gray-600">{t("rules.board.libraryIntro")}</p>
      {data.archiveError && <p className="mt-1 text-xs text-red-700">{t("rules.board.archiveError", { message: data.archiveError })}</p>}
      {data.library.length === 0 ? (
        <p className="mt-2 text-xs text-gray-500">{t("rules.board.libraryEmpty")}</p>
      ) : (
        <ul className="mt-2 divide-y divide-brand-muted/10 text-sm">
          {data.library.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-2 py-1.5">
              <span lang="es" className="text-gray-800">
                {x.nameEs}
              </span>
              <span className="font-mono text-[11px] text-gray-400">{x.id}</span>
              <span className="text-xs text-gray-500">
                {L.validity(x.validity)} · {t("rules.board.retiredAt", { date: fmt.date(x.retiredAt) })}
              </span>
              <Button className="ml-auto py-0.5 text-xs" onClick={() => onRestore(x)}>
                {t("rules.board.restore")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function Alerts({ data }: { data: RulesOverview }) {
  const t = useT();
  return (
    <details className={`${cardCls} p-3`}>
      <summary className="cursor-pointer text-sm font-semibold text-gray-800">{t("rules.board.alertsTitle")}</summary>
      <p className="mt-1 text-xs text-gray-600">{t("rules.board.alertsIntro")}</p>
      <ul className="mt-2 space-y-1 text-xs">
        {data.annotations.map((a) => (
          <li key={a.id} className="flex gap-2">
            <span className="font-mono text-gray-400">{a.id}</span>
            <span className="font-medium text-gray-700">{a.tags.join(", ")}</span>
            {a.note && (
              <span className="text-gray-600" lang="es">
                {a.note}
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
