/**
 * Ajustes → "Datos y respaldos": where the data lives (outside the repo), the daily
 * backups, "Respaldar ahora", "Exportar", "Restaurar…" (passkey) and the optional external
 * copy target. Human-only (server/data-admin.ts); the agent has no tool for any of this.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n, type TKey } from "~/i18n";
import { useApi } from "~/lib/api";
import type { DataImportStage, DataStatus } from "~/lib/api/types";
import { useToast } from "~/lib/components/Toast";
import { Banner, Button, Skeleton, cardCls, inputCls } from "~/lib/components/ui";
import { passkeyMessage } from "~/lib/passkey-messages";
import { restoreDataWithPasskey } from "~/lib/webauthn";

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function DataBackupsSection() {
  const { t, fmt } = useI18n();
  const api = useApi();
  const toast = useToast();
  const [status, setStatus] = useState<DataStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"backup" | "export" | "stage" | "restore" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetDir, setTargetDir] = useState("");
  const [keep, setKeep] = useState(14);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [stage, setStage] = useState<DataImportStage | null>(null);
  const [restoredMsg, setRestoredMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const s = await api.getDataStatus();
      setStatus(s);
      setTargetDir(s.settings.targetDir);
      setKeep(s.settings.keep);
      setLoadError(null);
    } catch (err) {
      setLoadError(errText(err));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run<T>(kind: NonNullable<typeof busy>, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(kind);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(kind === "restore" ? passkeyMessage(t, err) : errText(err));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function backupNow() {
    const b = await run("backup", () => api.backupNow());
    if (b) {
      toast.show(t("dataBackup.backupDone", { name: b.name }));
      await load();
    }
  }

  async function exportAll() {
    const r = await run("export", () => api.exportData());
    if (!r) return;
    const url = URL.createObjectURL(r.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = r.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setStage(null);
    setRestoredMsg(null);
    const s = await run("stage", () => api.stageDataImport(file));
    if (s) setStage(s);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function restore(demo: boolean) {
    if (!stage) return;
    const r = await run("restore", () => (demo ? api.restoreData(stage.id, { demo: true }) : restoreDataWithPasskey(api, stage.id)));
    if (r) {
      setStage(null);
      setRestoredMsg(t("dataBackup.restored", { files: r.restoredFiles, backup: r.preRestoreBackup }));
      await load();
    }
  }

  async function cancelRestore() {
    if (stage) await api.cancelDataImport(stage.id).catch(() => undefined);
    setStage(null);
    setRestoreOpen(false);
  }

  async function save() {
    const s = await run("save", () => api.saveDataSettings({ targetDir: targetDir.trim(), keep }));
    if (s) {
      toast.show(t("dataBackup.saved"));
      await load();
    }
  }

  const heading = (
    <h2 id="h-data" className="pt-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
      {t("dataBackup.title")}
    </h2>
  );
  if (loadError)
    return (
      <section className={`${cardCls} mb-4 px-4 pb-4`} aria-labelledby="h-data">
        {heading}
        <Banner tone="error" className="mt-2 rounded">
          {loadError}
        </Banner>
      </section>
    );
  if (!status)
    return (
      <section className={`${cardCls} mb-4 px-4 pb-4`} aria-labelledby="h-data">
        {heading}
        <Skeleton className="mt-2 h-24" />
      </section>
    );

  const m = status.migration;
  const last = status.lastBackup;
  const fixtures = status.mode === "fixtures";
  return (
    <section className={`${cardCls} mb-4 space-y-3 px-4 pb-4 text-sm`} aria-labelledby="h-data">
      {heading}
      <p className="text-xs text-gray-600">{t("dataBackup.intro")}</p>

      {m.migratedAt && m.from && (
        <Banner tone="info" className="rounded">
          {t("dataBackup.migrated", { from: m.from, date: fmt.dateTime(m.migratedAt), count: m.fileCount ?? 0 })}
        </Banner>
      )}
      {m.pending && m.error && (
        <Banner tone="warning" className="rounded">
          {t("dataBackup.migrationFailed", { message: m.error.message })}
        </Banner>
      )}
      {m.pending && !m.error && status.mode === "legacy" && (
        <Banner tone="warning" className="rounded">
          {t("dataBackup.migrationPending")}
        </Banner>
      )}
      {m.bothExistWarning && (
        <Banner tone="warning" className="rounded">
          {m.bothExistWarning}
        </Banner>
      )}

      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[12rem_1fr]">
        <dt className="text-gray-500">{t("dataBackup.folder")}</dt>
        <dd>
          <div className="break-all font-mono text-xs text-gray-800">{status.home}</div>
          <div className="text-xs text-gray-500">{t(`dataBackup.mode_${status.mode}` as TKey)}</div>
        </dd>
        <dt className="text-gray-500">{t("dataBackup.backupsFolder")}</dt>
        <dd className="break-all font-mono text-xs text-gray-800">{status.backupsDir}</dd>
        <dt className="text-gray-500">{t("dataBackup.lastBackup")}</dt>
        <dd className="text-gray-800">{last ? t("dataBackup.lastBackupValue", { date: fmt.dateTime(last.createdAt), size: size(last.bytes), files: last.fileCount }) : t("dataBackup.never")}</dd>
      </dl>
      <p className="text-xs text-gray-500">{status.scheduleActive ? t("dataBackup.scheduleOn") : t("dataBackup.scheduleOff")}</p>
      {status.lastError && (
        <Banner tone="error" className="rounded">
          {t("dataBackup.lastError", { date: fmt.dateTime(status.lastError.at), message: status.lastError.message })}
        </Banner>
      )}
      {last?.external && !last.external.ok && (
        <Banner tone="warning" className="rounded">
          {t("dataBackup.externalFailed", { message: last.external.error ?? "" })}
        </Banner>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy !== null} onClick={backupNow}>
          {busy === "backup" ? t("dataBackup.backingUp") : t("dataBackup.backupNow")}
        </Button>
        <Button disabled={busy !== null} onClick={exportAll} title={t("dataBackup.exportHint")}>
          {busy === "export" ? t("dataBackup.exporting") : t("dataBackup.export")}
        </Button>
        <Button disabled={busy !== null} onClick={() => setRestoreOpen((o) => !o)} aria-expanded={restoreOpen}>
          {t("dataBackup.restore")}
        </Button>
      </div>
      <p className="text-xs text-gray-500">{t("dataBackup.exportHint")}</p>

      {error && (
        <p role="alert" className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
          {error}
        </p>
      )}
      {restoredMsg && (
        <Banner tone="info" className="rounded">
          {restoredMsg}
        </Banner>
      )}

      {restoreOpen && (
        <div className="space-y-2 rounded border border-brand-muted/20 p-3">
          <h3 className="font-semibold text-gray-800">{t("dataBackup.restoreTitle")}</h3>
          <p className="text-xs text-gray-600">{t("dataBackup.restoreSteps")}</p>
          <label className="block">
            <span className="text-xs text-gray-500">{t("dataBackup.restoreFile")}</span>
            <input ref={fileRef} type="file" accept=".zip,application/zip" className="mt-1 block text-xs" disabled={busy !== null} onChange={(e) => void onFile(e.target.files?.[0])} />
          </label>
          {busy === "stage" && <p className="text-xs text-gray-500">{t("dataBackup.validating")}</p>}
          {stage && (
            <>
              <Banner tone="info" className="rounded">
                {t("dataBackup.staged", { date: stage.createdAt ? fmt.dateTime(stage.createdAt) : "—", files: stage.fileCount, size: size(stage.bytes), projects: stage.projects })}
              </Banner>
              {stage.warnings.map((w) => (
                <p key={w} className="text-xs text-amber-700">
                  {w}
                </p>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button variant="danger" disabled={busy !== null} onClick={() => void restore(fixtures)}>
                  {busy === "restore" ? t("dataBackup.restoring") : fixtures ? t("dataBackup.confirmRestoreDemo") : t("dataBackup.confirmRestore")}
                </Button>
                <Button disabled={busy !== null} onClick={() => void cancelRestore()}>
                  {t("dataBackup.cancel")}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {status.backups.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-semibold text-gray-600">{t("dataBackup.list")}</h3>
          <ul className="max-h-48 divide-y divide-brand-muted/10 overflow-auto rounded border border-brand-muted/20 text-xs">
            {status.backups.map((b) => (
              <li key={b.name} className="flex flex-wrap items-center justify-between gap-2 px-2 py-1">
                <span className="font-mono text-gray-800">{b.name}</span>
                <span className="text-gray-500">
                  {t(`dataBackup.kind_${b.kind}` as TKey)} · {fmt.dateTime(b.createdAt)} · {size(b.bytes)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2 border-t border-brand-muted/10 pt-3">
        <label className="block">
          <span className="text-xs text-gray-700">{t("dataBackup.target")}</span>
          <input className={`${inputCls} mt-1 w-full font-mono text-xs`} value={targetDir} placeholder={t("dataBackup.targetPlaceholder")} onChange={(e) => setTargetDir(e.target.value)} maxLength={400} spellCheck={false} />
          <span className="mt-1 block text-xs text-gray-500">{t("dataBackup.targetHint")}</span>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-xs text-gray-700">{t("dataBackup.keep")}</span>
          <input type="number" min={1} max={365} step={1} className={`${inputCls} w-20`} value={keep} onChange={(e) => setKeep(Math.max(1, Math.min(365, Math.round(Number(e.target.value) || 1))))} />
        </label>
        <Button disabled={busy !== null || (targetDir.trim() === status.settings.targetDir && keep === status.settings.keep)} onClick={save}>
          {t("dataBackup.save")}
        </Button>
      </div>
      <p className="text-xs text-gray-500">{t("dataBackup.humanOnly")}</p>
    </section>
  );
}
