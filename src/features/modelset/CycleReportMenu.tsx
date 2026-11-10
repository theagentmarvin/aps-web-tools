/**
 * "Informe del ciclo" menu on the model set header (docs/ai/agent-human-parity.md #68):
 *   - Abrir para imprimir (HTML) / Descargar .md, built from GET /reports;
 *   - the report files the agent wrote with generate_report (view / download).
 * Agent files are shown as text (md) or in a sandboxed iframe without scripts (html).
 */
import { useEffect, useState } from "react";
import { useI18n, useT } from "~/i18n";
import { useApi } from "~/lib/api";
import type { ReportFile, ReportFileContent } from "~/lib/api/types";
import { MenuButton, menuItemCls } from "~/lib/components/MenuButton";
import { Modal } from "~/lib/components/Modal";
import { useToast } from "~/lib/components/Toast";
import { Button } from "~/lib/components/ui";
import { downloadBlob } from "~/lib/csv";
import { cycleReportMarkdown, markdownToPrintableHtml, reportFileName, type CycleReportMeta } from "./cycle-report";

export function CycleReportMenu({ projectId, projectName, modelSetId, modelSetName }: { projectId: string; projectName: string; modelSetId: string; modelSetName: string }) {
  const t = useT();
  const { fmt } = useI18n();
  const api = useApi();
  const toast = useToast();
  const [files, setFiles] = useState<ReportFile[] | null>(null);
  const [viewing, setViewing] = useState<ReportFileContent | null>(null);
  const [busy, setBusy] = useState(false);

  async function build(): Promise<{ md: string; meta: CycleReportMeta } | null> {
    setBusy(true);
    try {
      const r = await api.getReport({ projectId, modelSetId });
      const meta = { projectName, modelSetName, date: new Date().toISOString().slice(0, 10) };
      return { md: cycleReportMarkdown(r, meta), meta };
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), { tone: "error" });
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function openPrint() {
    // Open the window synchronously (popup blockers), fill it when the data arrives.
    const w = window.open("", "_blank");
    const b = await build();
    if (!b) return w?.close();
    const html = markdownToPrintableHtml(b.md, t("parity.report.title"));
    if (w) {
      // Our own, fully escaped HTML (cycle-report.ts): no model text reaches markup unescaped.
      w.opener = null;
      w.document.open();
      w.document.write(html);
      w.document.close();
      w.focus();
      w.print();
    } else downloadBlob(reportFileName(b.meta, "html"), new Blob([html], { type: "text/html;charset=utf-8" }));
  }
  async function downloadMd() {
    const b = await build();
    if (b) downloadBlob(reportFileName(b.meta, "md"), new Blob([b.md], { type: "text/markdown;charset=utf-8" }));
  }
  // Cheap listing (file names only): fetched once per project.
  useEffect(() => {
    let alive = true;
    api.listReportFiles(projectId).then((f) => alive && setFiles(f), () => alive && setFiles([]));
    return () => {
      alive = false;
    };
  }, [api, projectId]);
  async function view(f: ReportFile) {
    try {
      setViewing(await api.getReportFile(projectId, f.name));
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), { tone: "error" });
    }
  }
  const ofSet = files ?? [];

  return (
    <>
      <MenuButton
          title={t("parity.report.menu")}
          label={<>{t("parity.report.menu")} ▾</>}
          className="rounded-lg border border-brand-muted/30 px-3 py-1.5 text-xs font-medium text-gray-700 hover:text-brand disabled:opacity-50"
          panelClassName="w-80"
        >
          {(close) => (
            <>
              <button type="button" role="menuitem" disabled={busy} className={menuItemCls} onClick={() => (close(), void openPrint())}>
                {t("parity.report.print")}
              </button>
              <button type="button" role="menuitem" disabled={busy} className={menuItemCls} onClick={() => (close(), void downloadMd())}>
                {t("parity.report.downloadMd")}
              </button>
              <div className="mt-1 border-t border-brand-muted/20 px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{t("parity.report.agentFiles")}</div>
              {files === null ? (
                <p className="px-3 py-1 text-xs text-gray-500">{t("common.loading")}</p>
              ) : !ofSet.length ? (
                <p className="px-3 py-1 text-xs text-gray-500">{t("parity.report.noFiles")}</p>
              ) : (
                <ul className="max-h-60 overflow-y-auto">
                  {ofSet.slice(0, 30).map((f) => (
                    <li key={f.name}>
                      <button type="button" role="menuitem" className={menuItemCls} title={f.name} onClick={() => (close(), void view(f))}>
                        <span className="min-w-0 flex-1 truncate">
                          {f.kind ? t(`parity.report.kind.${["weekly", "test_summary", "hygiene", "proposals_digest"].includes(f.kind) ? f.kind : "other"}` as Parameters<typeof t>[0]) : f.name}
                          {f.testKey ? <span className="ml-1 font-mono text-[11px] text-gray-400">{f.testKey}</span> : null}
                        </span>
                        <span className="shrink-0 text-[11px] text-gray-500">
                          {fmt.date(f.modifiedAt)} · {f.format}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
      </MenuButton>
      {viewing && (
        <Modal
          title={viewing.name}
          onClose={() => setViewing(null)}
          width="w-[860px] max-w-[95vw]"
          footer={
            <>
              <Button onClick={() => downloadBlob(viewing.name, new Blob([viewing.content], { type: viewing.format === "html" ? "text/html;charset=utf-8" : "text/markdown;charset=utf-8" }))}>{t("parity.report.download")}</Button>
              <Button variant="primary" onClick={() => setViewing(null)}>
                {t("common.close")}
              </Button>
            </>
          }
        >
          {viewing.format === "html" ? (
            // No allow-scripts / allow-same-origin: the file is shown, never executed.
            <iframe title={viewing.name} sandbox="" srcDoc={viewing.content} className="h-[60vh] w-full rounded border border-brand-muted/20 bg-white" />
          ) : (
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded border border-brand-muted/20 bg-gray-50 p-3 text-xs text-gray-800">{viewing.content}</pre>
          )}
        </Modal>
      )}
    </>
  );
}
