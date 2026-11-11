/**
 * Agent harness update (human-only): a banner in the app shell when harness-staging/ differs from
 * the installed .claude/, and a dialog listing the files with their diffs and "Instalar con
 * passkey". The server binds the passkey challenge to the exact files written; no agent tool
 * reaches these routes.
 */
import { useState } from "react";
import { useT } from "~/i18n";
import { useApi, useAsync } from "~/lib/api";
import type { HarnessDiff, HarnessStatus } from "~/lib/api/types";
import { Modal } from "~/lib/components/Modal";
import { useToast } from "~/lib/components/Toast";
import { Button } from "~/lib/components/ui";
import { passkeyMessage } from "~/lib/passkey-messages";
import { installHarnessWithPasskey } from "~/lib/webauthn";

const STATE_CLS: Record<string, string> = {
  added: "bg-emerald-50 text-emerald-800 border-emerald-200",
  changed: "bg-amber-50 text-amber-900 border-amber-200",
  removed: "bg-red-50 text-red-800 border-red-200",
  same: "bg-gray-50 text-gray-600 border-gray-200",
};

export function HarnessUpdateBanner() {
  const t = useT();
  const api = useApi();
  const status = useAsync(() => api.getHarnessStatus().catch(() => undefined), [api]);
  const [open, setOpen] = useState(false);
  const s = status.data;
  if (!s || s.upToDate) return null;
  const pending = s.files.filter((f) => f.state !== "same").length;
  return (
    <>
      <div role="status" className="flex flex-shrink-0 items-center gap-3 border-b border-sky-200 bg-sky-50 px-6 py-2 text-sm text-sky-900">
        <span className="flex-1">{t("harness.banner", { count: pending })}</span>
        <button type="button" onClick={() => setOpen(true)} className="rounded border border-sky-300 bg-white px-2 py-0.5 text-xs hover:bg-sky-100">
          {t("harness.review")}
        </button>
      </div>
      {open && (
        <HarnessUpdateDialog
          status={s}
          onClose={() => setOpen(false)}
          onInstalled={() => {
            setOpen(false);
            status.reload();
          }}
        />
      )}
    </>
  );
}

function HarnessUpdateDialog({ status, onClose, onInstalled }: { status: HarnessStatus; onClose: () => void; onInstalled: () => void }) {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const files = status.files.filter((f) => f.state !== "same");
  const demo = api.mode === "mock";
  async function install() {
    setBusy(true);
    setErr(null);
    try {
      const r = await installHarnessWithPasskey(api);
      toast.show(`${t("harness.installed", { count: r.installed.length })} ${t("harness.restart")}`, { durationMs: 12000 });
      onInstalled();
    } catch (e) {
      setErr(passkeyMessage(t, e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={t("harness.dialogTitle")}
      onClose={() => !busy && onClose()}
      width="w-[760px]"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void install()} disabled={busy || demo || status.installBlocked || !files.length}>
            {busy ? t("harness.installing") : t("harness.install")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-gray-700">{t("harness.intro")}</p>
        {status.stagedVersion && status.installedVersion && (
          <p className="font-mono text-xs text-gray-500">{t("harness.versions", { installed: status.installedVersion, staged: status.stagedVersion })}</p>
        )}
        <ul className="divide-y divide-gray-100 rounded border border-gray-200">
          {files.map((f) => (
            <HarnessFileRow key={f.path} path={f.path} state={f.state} />
          ))}
        </ul>
        {status.refused.length > 0 && <p className="text-xs text-gray-500">{t("harness.refused", { files: status.refused.join(", ") })}</p>}
        {demo ? (
          <p className="text-xs text-gray-600">{t("harness.demo")}</p>
        ) : status.installBlocked ? (
          <p role="alert" className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
            {t("harness.blocked")}
          </p>
        ) : (
          <p className="text-xs text-gray-600">{t("harness.passkeyHint")}</p>
        )}
        {err && (
          <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">
            {err}
          </p>
        )}
      </div>
    </Modal>
  );
}

function HarnessFileRow({ path, state }: { path: string; state: string }) {
  const t = useT();
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<HarnessDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !diff) {
      try {
        setDiff(await api.getHarnessDiff(path));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }
  return (
    <li className="px-3 py-2">
      <div className="flex items-center gap-2">
        <span className={`rounded-full border px-2 text-xs leading-5 ${STATE_CLS[state] ?? STATE_CLS.same}`}>{t(`harness.state.${state as "added"}`)}</span>
        <code className="min-w-0 flex-1 truncate text-xs text-gray-800" title={path}>
          {path}
        </code>
        <button type="button" onClick={() => void toggle()} aria-expanded={open} className="text-xs text-sky-800 underline underline-offset-2">
          {open ? t("harness.hideDiff") : t("harness.showDiff")}
        </button>
      </div>
      {open && (
        <div className="mt-2">
          {error ? (
            <p className="text-xs text-red-700">{error}</p>
          ) : !diff ? (
            <p className="text-xs text-gray-500">{t("harness.diffLoading")}</p>
          ) : (
            <>
              <pre className="max-h-80 overflow-auto rounded bg-gray-50 p-2 text-[11px] leading-4">
                {diff.diff.split("\n").map((line, i) => (
                  <span key={i} className={`block ${line.startsWith("+") && !line.startsWith("+++") ? "bg-emerald-50 text-emerald-900" : line.startsWith("-") && !line.startsWith("---") ? "bg-red-50 text-red-900" : "text-gray-700"}`}>
                    {line || " "}
                  </span>
                ))}
              </pre>
              {diff.truncated && <p className="mt-1 text-xs text-gray-500">{t("harness.diffTruncated")}</p>}
            </>
          )}
        </div>
      )}
    </li>
  );
}
