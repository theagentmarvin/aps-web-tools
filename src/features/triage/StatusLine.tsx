/**
 * One slim status line in the workspace header (replaces the stacked banners):
 * only the highest-priority item is visible (scope change > stale version >
 * new agent proposals > pace nudge); "Ver detalle" opens a small popover and
 * "+N" lists the others. It lives in the header row, which is always present,
 * so nothing shifts the tree when an item appears or goes away.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n, useT } from "~/i18n";
import { CopyCommand } from "~/lib/components/shell-widgets";
import { useTriageContext } from "./actions";
import { useTriage } from "./store";

interface Item {
  id: "scope" | "stale" | "proposals" | "pace";
  tone: "warning" | "info";
  /** One line, already short. */
  text: string;
  action?: ReactNode;
  detail?: ReactNode;
}

const KIND_KEY = {
  document_added: "scope.kind.added",
  document_removed: "scope.kind.removed",
  model_replaced: "scope.kind.replaced",
  test_config_changed: "scope.kind.config",
  mass_resolution: "scope.kind.mass",
} as const;

/** "MODELING TEST S3.rvt, S4.rvt": shared prefix shown once, names truncated by the line itself. */
function shortNames(names: string[]): string {
  if (names.length < 2) return names.join("");
  let prefix = names[0];
  for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
  const cut = prefix.lastIndexOf(" ") + 1;
  return cut > 3 ? [names[0], ...names.slice(1).map((n) => n.slice(cut))].join(", ") : names.join(", ");
}

function useItems(): Item[] {
  const t = useT();
  const { fmt } = useI18n();
  const { store } = useTriageContext();
  const payload = useTriage(store, (s) => s.payload);
  const pending = useTriage(store, (s) => s.pendingProposals.length);
  const pace = useTriage(store, (s) => s.paceNudge);
  if (!payload) return [];
  const items: Item[] = [];
  const scope = payload.scopeChanges ?? [];
  const outOfScope = payload.changeSummary?.outOfScope ?? 0;
  if (scope.length || outOfScope > 0) {
    const byKind = new Map<string, string[]>();
    for (const c of scope) byKind.set(c.kind, [...(byKind.get(c.kind) ?? []), c.fileName ?? "—"]);
    const parts = [...byKind].map(([kind, names]) => `${t(KIND_KEY[kind as keyof typeof KIND_KEY] ?? "scope.kind.other", { count: names.length })}${names.length && names[0] !== "—" ? ` (${shortNames(names)})` : ""}`);
    if (outOfScope > 0) parts.push(t("scope.outOfScopeShort", { count: outOfScope }));
    items.push({
      id: "scope",
      tone: "warning",
      text: t("scope.line", { parts: parts.join(" · ") }),
      detail: (
        <div className="space-y-1">
          <p className="font-medium">{t("scope.title", { version: payload.changeSummary?.baseVersion ?? payload.changeSummary?.previousVersion ?? "—" })}</p>
          <ul className="space-y-0.5">
            {scope.map((c, i) => (
              <li key={i}>
                {c.fileName && <span className="font-medium">{c.fileName}: </span>}
                {c.message}
              </li>
            ))}
            {outOfScope > 0 && <li title={t("scope.outOfScopeTip")}>{t("scope.outOfScope", { count: outOfScope })}</li>}
          </ul>
        </div>
      ),
    });
  }
  const ms = payload.modelSet;
  const newest = payload.tests[0];
  const staleVersion = ms.analyzedVersion !== undefined && ms.latestVersion > ms.analyzedVersion;
  if (staleVersion || (newest && newest.id !== payload.test.id))
    items.push({
      id: "stale",
      tone: "warning",
      text: staleVersion ? t("stale.banner", { latest: ms.latestVersion, analyzed: ms.analyzedVersion ?? "" }) : t("stale.newerTest", { date: fmt.date(newest.completedOn) }),
      detail: <CopyCommand text={ms.agentCommand} compact />,
    });
  if (pending > 0)
    items.push({
      id: "proposals",
      tone: "info",
      text: t("workspace.newProposals", { count: pending }),
      action: (
        <button type="button" onClick={() => store.applyProposalUpdates()} className="shrink-0 font-medium text-brand hover:underline">
          {t("workspace.refresh")}
        </button>
      ),
    });
  if (pace)
    items.push({
      id: "pace",
      tone: "warning",
      text: t("guard.paceNudge"),
      action: (
        <button type="button" onClick={() => store.dismissPace()} className="shrink-0 text-gray-600 hover:underline">
          {t("workspace.paceNudgeDismiss")}
        </button>
      ),
    });
  return items;
}

export function StatusLine() {
  const t = useT();
  const items = useItems();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  if (!items.length) return null;
  const [top, ...rest] = items;
  const tone = top.tone === "warning" ? "border-amber-300 bg-amber-50 text-amber-900" : "border-brand-light/40 bg-brand-surface text-brand";
  return (
    <div ref={ref} className="relative min-w-0 flex-1" data-testid="status-line">
      <div role={top.tone === "warning" ? "alert" : "status"} className={`flex h-7 min-w-0 items-center gap-2 rounded border px-2 text-xs ${tone}`}>
        <span aria-hidden="true">{top.tone === "warning" ? "⚠" : "ℹ"}</span>
        <span className="min-w-0 flex-1 truncate" title={top.text}>
          {top.text}
        </span>
        {top.action}
        {(top.detail || rest.length > 0) && (
          <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="shrink-0 whitespace-nowrap font-medium hover:underline">
            {t("scope.seeDetail")}
          </button>
        )}
        {rest.length > 0 && (
          <button type="button" aria-label={t("scope.moreItems", { count: rest.length })} title={rest.map((r) => r.text).join("\n")} onClick={() => setOpen(true)} className="shrink-0 rounded-full border border-current px-1.5 text-[10px] leading-4">
            +{rest.length}
          </button>
        )}
      </div>
      {open && (
        <div
          role="dialog"
          aria-label={t("scope.seeDetail")}
          onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
          className="absolute left-0 right-0 top-8 z-40 max-h-80 overflow-y-auto rounded-lg border border-brand-muted/20 bg-white p-3 text-xs text-gray-800 shadow-lg"
        >
          {[top, ...rest].map((it, i) => (
            <div key={it.id} className={i ? "mt-2 border-t border-brand-muted/10 pt-2" : ""}>
              {it.detail ?? <p>{it.text}</p>}
              {i > 0 && it.action && <div className="mt-1">{it.action}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
