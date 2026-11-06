import { Outlet, useMatch } from "react-router";
import { useT } from "~/i18n";
import { Nav } from "~/lib/components/nav";

export function Layout() {
  const t = useT();
  const workspace = useMatch("/coordinacion/:projectId/:modelSetId");
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-1 focus:text-sm">
        {t("app.skipToContent")}
      </a>
      <Nav />
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
