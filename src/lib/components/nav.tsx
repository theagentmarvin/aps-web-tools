/**
 * App navigation (spec §2.3): brand, main links with the approvals badge,
 * agent status, language switch, user menu.
 */
import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { useT, type TKey } from "~/i18n";
import { useApi } from "~/lib/api";
import { useCoordAuth } from "~/lib/coord-auth";
import { AgentStatusIndicator, LanguageSwitch } from "./shell-widgets";

const LINKS: { to: string; key: TKey; end?: boolean }[] = [
  { to: "/", key: "nav.home", end: true },
  { to: "/proyectos", key: "nav.projects" },
  { to: "/aprobaciones", key: "nav.approvals" },
  { to: "/reglas", key: "nav.rules" },
  { to: "/reportes", key: "nav.reports" },
  { to: "/auditoria", key: "nav.audit" },
];

function useReadyBatchCount(): number {
  const api = useApi();
  const location = useLocation();
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    api.listBatches({ state: ["ready"] }).then(
      (b) => alive && setCount(b.length),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, location.pathname]);
  return count;
}

function UserMenu() {
  const t = useT();
  const api = useApi();
  const { status, logout } = useCoordAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const initials = status?.user?.initials ?? "··";
  const name = status?.user?.name ?? "";
  const canSignOut = api.mode === "http" && status?.loggedIn && status.dataSource === "live";

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("nav.userMenu")}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-surface text-xs font-semibold text-brand hover:bg-brand/10"
      >
        {initials}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-9 z-40 w-48 rounded-lg border border-brand-muted/20 bg-white py-1 text-sm shadow-lg" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
          {name && <div className="truncate px-3 py-1.5 text-xs text-gray-500">{name}</div>}
          <Link role="menuitem" to="/ajustes" onClick={() => setOpen(false)} className="block px-3 py-1.5 text-gray-700 hover:bg-brand-surface">
            {t("nav.settings")}
          </Link>
          {canSignOut && (
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                void logout();
                setOpen(false);
              }}
              className="block w-full px-3 py-1.5 text-left text-gray-700 hover:bg-brand-surface"
            >
              {t("nav.signOut")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function Nav() {
  const t = useT();
  const api = useApi();
  const { status: coordStatus } = useCoordAuth();
  const ready = useReadyBatchCount();
  return (
    <nav aria-label={t("nav.mainNav")} className="flex flex-shrink-0 items-center gap-6 border-b border-brand-muted/20 bg-white px-6 py-2 shadow-sm">
      <Link to="/" className="flex items-center gap-2 whitespace-nowrap text-lg font-bold tracking-tight text-brand">
        <span aria-hidden className="inline-block h-3 w-3 bg-brand" />
        {t("app.company")}
        <span className="font-normal text-gray-300">|</span>
        <span className="text-base">{t("app.name")}</span>
      </Link>
      <ul className="flex gap-4 text-sm">
        {LINKS.map((l) => (
          <li key={l.to}>
            <NavLink
              to={l.to}
              end={l.end}
              className={({ isActive }) =>
                `inline-flex items-center gap-1 border-b-2 py-1.5 transition-colors ${isActive ? "border-brand text-brand" : "border-transparent text-gray-600 hover:text-brand"}`
              }
            >
              {t(l.key)}
              {l.to === "/aprobaciones" && ready > 0 && <span className="rounded-full bg-brand px-1.5 text-[10px] text-white">{ready}</span>}
            </NavLink>
          </li>
        ))}
      </ul>
      <div className="ml-auto flex items-center gap-4">
        {api.mode === "mock" ? (
          <span title={t("app.demoModeHint")} className="hidden rounded border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800 lg:inline">
            {t("app.demoMode")}
          </span>
        ) : (
          coordStatus?.dataSource === "fixtures" && <span className="hidden rounded border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800 lg:inline">{t("auth.demoSession")}</span>
        )}
        <AgentStatusIndicator />
        <LanguageSwitch />
        <UserMenu />
      </div>
    </nav>
  );
}
