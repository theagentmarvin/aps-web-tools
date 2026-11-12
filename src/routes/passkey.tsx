/**
 * /ajustes/passkey — passkey (Windows Hello) enrolment for approvals
 * (docs/api.md "Browser approval flow"). The first passkey uses the one-time
 * code printed by `npm run coordinator -- passkey-enroll`; more passkeys need
 * an assertion from an existing one (step-up).
 */
import { useEffect, useState } from "react";
import { useT } from "~/i18n";
import { useApi } from "~/lib/api";
import { useCoordAuth } from "~/lib/coord-auth";
import { PageHeader } from "~/lib/components/PageHeader";
import { useToast } from "~/lib/components/Toast";
import { Banner, Button, Skeleton, cardCls, inputCls } from "~/lib/components/ui";
import { passkeyMessage } from "~/lib/passkey-messages";
import { enrollPasskey, isIpHost, registrationRequirement } from "~/lib/webauthn";

export function PasskeyPage() {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const { status } = useCoordAuth();
  const live = api.mode === "http" && status?.dataSource === "live";
  const [requires, setRequires] = useState<"enroll_code" | "step_up" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState(() => t("passkey.labelDefault"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!live) return;
    registrationRequirement(api).then(setRequires, (err) => setLoadError(passkeyMessage(t, err)));
  }, [api, live, t]);

  async function register() {
    setBusy(true);
    setError(null);
    try {
      const res = await enrollPasskey(api, { label: label.trim() || t("passkey.labelDefault"), enrollCode: requires === "enroll_code" ? code : undefined });
      toast.show(t("passkey.registered", { label: res.label }));
      setCode("");
      setRequires("step_up");
    } catch (err) {
      setError(passkeyMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <PageHeader title={t("passkey.title")} crumbs={[{ label: t("settings.title"), to: "/ajustes" }, { label: t("passkey.title") }]} />
      <p className="mb-4 text-sm text-gray-600">{t("passkey.intro")}</p>
      {isIpHost(window.location.hostname) && (
        <Banner tone="warning" className="mb-4 rounded">
          {t("passkey.errors.wrong_host")}
        </Banner>
      )}
      {!status ? (
        <Skeleton className="h-32" />
      ) : !live ? (
        <Banner tone="info" className="rounded">
          {t("passkey.notInFixtures")}
        </Banner>
      ) : loadError ? (
        <Banner tone="error" className="rounded">
          {loadError}
        </Banner>
      ) : !requires ? (
        <Skeleton className="h-32" />
      ) : (
        <section className={`${cardCls} space-y-3 p-4 text-sm`}>
          <h2 className="font-semibold text-gray-800">{requires === "enroll_code" ? t("passkey.firstTitle") : t("passkey.stepUpTitle")}</h2>
          <p className="text-xs text-gray-600">{requires === "enroll_code" ? t("passkey.firstSteps") : t("passkey.stepUpSteps")}</p>
          {requires === "enroll_code" && (
            <label className="block">
              <span className="text-xs text-gray-500">{t("passkey.code")}</span>
              <input className={`${inputCls} mt-1 w-56 font-mono uppercase tracking-widest`} value={code} onChange={(e) => setCode(e.target.value)} maxLength={16} autoComplete="one-time-code" spellCheck={false} />
            </label>
          )}
          <label className="block">
            <span className="text-xs text-gray-500">{t("passkey.label")}</span>
            <input className={`${inputCls} mt-1 w-full`} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
          </label>
          {error && (
            <p role="alert" className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
              {error}
            </p>
          )}
          <Button variant="primary" disabled={busy || (requires === "enroll_code" && code.trim().length < 6)} onClick={register}>
            {busy ? t("approve.passkeyWaiting") : t("passkey.register")}
          </Button>
        </section>
      )}
    </div>
  );
}
