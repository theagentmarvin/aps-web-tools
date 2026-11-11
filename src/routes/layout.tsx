import { Outlet, useMatch } from "react-router";
import { useT } from "~/i18n";
import { Nav } from "~/lib/components/nav";
import { isIpHost } from "~/lib/webauthn";
import { HarnessUpdateBanner } from "~/features/harness/HarnessUpdate";

export function Layout() {
  const t = useT();
  const workspace = useMatch("/coordinacion/:projectId/:modelSetId");
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-1 focus:text-sm">
        {t("app.skipToContent")}
      </a>
      <Nav />
      <WrongHostBanner />
      <HarnessUpdateBanner />
      <main id="main" className="min-h-0 flex-1">
        {workspace ? (
          <Outlet />
        ) : (
          <div className="h-full overflow-y-auto">
            <div className="print-full mx-auto max-w-7xl px-6 py-6">
              <Outlet />
            </div>
            <footer className="mx-auto max-w-7xl px-6 pb-6 text-xs text-gray-400">{t("app.governance")}</footer>
          </div>
        )}
      </main>
    </div>
  );
}

/** The WebAuthn RP ID and the APS callback are "localhost": warn when opened on an IP. */
function WrongHostBanner() {
  const t = useT();
  const { hostname, port, pathname, search } = window.location;
  if (!isIpHost(hostname)) return null;
  const target = `http://localhost${port ? `:${port}` : ""}${pathname}${search}`;
  return (
    <div role="alert" className="flex flex-shrink-0 items-center gap-3 border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-amber-900">
      <span className="flex-1">{t("app.wrongHost", { port })}</span>
      <a href={target} className="rounded border border-amber-300 bg-white px-2 py-0.5 text-xs">
        {t("app.wrongHostLink")}
      </a>
    </div>
  );
}
