/**
 * Project page › Disciplinas: compact editor of the project ACC issue settings (G4, G5):
 * default issue type / subtype (from the project's ACC list, GET only) and discipline → ACC
 * assignee (company / role / user), plus agent propose_issue_responsible suggestions (Accept /
 * Reject). Writes are local (.coordinator/projects/<id>/issue-settings.json) and audited.
 */
import { useState } from "react";
import { useT, type TKey } from "~/i18n";
import { useApi, useAsync } from "~/lib/api";
import type { IssueSettings } from "~/lib/api/types";
import { AssigneePicker } from "~/lib/components/AssigneePicker";
import { useToast } from "~/lib/components/Toast";
import { Button, ErrorState, Skeleton, cardCls, inputCls } from "~/lib/components/ui";
import { typeChoices, useIssueOptions } from "~/lib/issue-options";

export function IssueSettingsPanel({ projectId }: { projectId: string }) {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const { data, setData, error, loading, reload } = useAsync<IssueSettings>(() => api.getIssueSettings(projectId), [api, projectId]);
  const opts = useIssueOptions(api, projectId);
  const [busy, setBusy] = useState(false);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !data) return <Skeleton className="h-32" />;

  async function run(fn: () => Promise<IssueSettings>) {
    setBusy(true);
    try {
      setData(await fn());
      toast.show(t("accIssues.saved"));
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  const choices = typeChoices(opts?.types ?? []);
  const current = data.issueType ? `${data.issueType.typeId}|${data.issueType.subtypeId}` : "";
  const eff = data.effectiveIssueType;
  const mapped = new Map(data.assignees.map((a) => [a.discipline, a]));
  return (
    <section className={`${cardCls} space-y-4 p-4 text-sm`} aria-labelledby="h-acc-issues">
      <div>
        <h2 id="h-acc-issues" className="font-semibold text-gray-800">
          {t("accIssues.title")}
        </h2>
        <p className="mt-1 text-xs text-gray-600">{t("accIssues.hint")}</p>
      </div>

      <div className="space-y-1">
        <label className="block text-xs font-medium text-gray-700" htmlFor="acc-issue-type">
          {t("accIssues.type")}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <select
            id="acc-issue-type"
            className={`${inputCls} text-xs`}
            disabled={busy || !choices.length}
            value={current}
            onChange={(e) => {
              const c = choices.find((x) => `${x.typeId}|${x.subtypeId}` === e.target.value);
              if (c) void run(() => api.setIssueType(projectId, c));
            }}
          >
            <option value="">{t("accIssues.typeChoose")}</option>
            {choices.map((c) => (
              <option key={`${c.typeId}|${c.subtypeId}`} value={`${c.typeId}|${c.subtypeId}`}>
                {c.label}
              </option>
            ))}
          </select>
          {data.issueType && (
            <Button disabled={busy} onClick={() => void run(() => api.setIssueType(projectId, { clear: true }))}>
              {t("accIssues.typeClear")}
            </Button>
          )}
        </div>
        <p className="text-xs text-gray-600">
          {eff ? t("accIssues.typeEffective", { label: eff.label ?? `${eff.typeId.slice(0, 8)}…`, source: t(`accIssues.source.${eff.source}` as TKey) }) : t("accIssues.typeNone")}
        </p>
        {opts && !opts.types.length && <p className="text-xs text-amber-800">{t("accIssues.typesUnavailable")}</p>}
      </div>

      <div className="space-y-1">
        <h3 className="text-xs font-medium text-gray-700">{t("accIssues.assignees")}</h3>
        {opts && !opts.assignees.length && <p className="text-xs text-amber-800">{t("accIssues.candidatesEmpty")}</p>}
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-1 pr-2 font-normal">{t("accIssues.discipline")}</th>
              <th className="py-1 font-normal">{t("accIssues.assignee")}</th>
            </tr>
          </thead>
          <tbody>
            {data.codes.map((c) => {
              const a = mapped.get(c.code);
              return (
                <tr key={c.code} className="border-t border-brand-muted/10">
                  <td className="py-1 pr-2 align-middle font-mono" title={c.label}>
                    {c.code}
                  </td>
                  <td className="py-1">
                    <AssigneePicker
                      key={a ? `${a.type}:${a.id}` : "none"}
                      label={`${t("accIssues.assignee")} ${c.code}`}
                      value={a ? { id: a.id, type: a.type, label: a.label } : null}
                      candidates={opts?.assignees ?? []}
                      disabled={busy}
                      onChange={(v) => void run(() => api.setIssueAssignee(projectId, c.code, v))}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {data.pendingProposals.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-gray-700">{t("accIssues.suggestions")}</h3>
          {data.pendingProposals.map((p) => (
            <article key={p.id} className="flex flex-wrap items-start gap-2 rounded border border-brand-muted/20 p-2 text-xs">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-gray-900">{p.summary}</p>
                <p className="text-gray-600">{p.rationale}</p>
              </div>
              <Button variant="primary" disabled={busy} onClick={() => void run(() => api.decideIssueSettingsSuggestion(projectId, p.id, "accept"))}>
                {t("accIssues.accept")}
              </Button>
              <Button disabled={busy} onClick={() => void run(() => api.decideIssueSettingsSuggestion(projectId, p.id, "reject"))}>
                {t("accIssues.reject")}
              </Button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
