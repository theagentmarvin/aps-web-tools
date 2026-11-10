/**
 * Viewer pane (spec §3.8): loads the test's documents once, follows the list
 * cursor (debounced), shows the A/B pair with showClashPair, markers, legend
 * and toolbar. Without models or an APS session (mock mode) it renders a
 * clear placeholder with the pair info instead of the viewer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n, useT } from "~/i18n";
import { useApi } from "~/lib/api";
import type { Clash } from "~/lib/api/types";
import { useAuth } from "~/lib/auth-context";
import { useCoordAuth } from "~/lib/coord-auth";
import { writeString } from "~/lib/storage";
import { ForgeViewer, type ModelHandle } from "~/lib/components/ForgeViewer";
import { IconCube, IconFit, IconMarker, IconSection, SideASwatch, SideBSwatch } from "~/lib/components/icons";
import {
  clearClashPair,
  clearClashMarkers,
  computeClashPoint,
  fitToCurrent,
  setClashMarkers,
  setSideVisibility,
  showClashPair,
  toggleSectionBox,
  type ClashSide,
} from "~/lib/viewer-tools/clash-highlight";
import { useTriageContext } from "./actions";
import { SaveViewButton, restoreSavedView } from "./MeetingViews";
import { rowKey, useTriage, type TriageStore, type ViewerMode } from "./store";

const COLOR_A = "#0072B2";
const COLOR_B = "#E69F00";
const MAX_MARKERS = 60;

const pairKeyOf = (c: Clash) => (c.a.documentId <= c.b.documentId ? `${c.a.documentId},${c.b.documentId}` : `${c.b.documentId},${c.a.documentId}`);

/**
 * What the viewer shows for the selected row (like ACC Model Coordination, but following the tree):
 * - a clash: that clash, in its document pair;
 * - any tree node (pair, problem type, grupo, ubicación): the UNION of the subtree clashes (under the
 *   active filters), with the models of every document involved (exactly 2 when the selection spans
 *   one document pair);
 * - with ?docs=a,b (opened from the grid): only that pair, whatever the selection.
 */
function viewPair(
  cursorKey: string | null,
  docsFilter: string | undefined,
  store: TriageStore,
): { docs: number[]; focus: Clash | undefined; target: Clash[]; members: Clash[] } {
  const { focus, members: all } = store.selectionMembers(cursorKey);
  let inView: (c: Clash) => boolean = () => true;
  if (docsFilter) {
    const [x, y] = docsFilter.split(",").map(Number);
    const key = x <= y ? `${x},${y}` : `${y},${x}`;
    inView = (c) => pairKeyOf(c) === key;
  } else if (focus) {
    const key = pairKeyOf(focus);
    inView = (c) => pairKeyOf(c) === key;
  }
  const members = all.filter(inView);
  const target = focus ? (inView(focus) ? [focus] : []) : members;
  const docs = [...new Set((focus ? [focus] : members).flatMap((c) => [c.a.documentId, c.b.documentId]))].sort((m, n) => m - n);
  return { docs, focus: focus && inView(focus) ? focus : undefined, target, members };
}

export function ClashViewerPane() {
  const t = useT();
  const api = useApi();
  const { getAccessToken, session, login } = useAuth();
  const { status: coordStatus } = useCoordAuth();
  const { store } = useTriageContext();
  const payload = useTriage(store, (s) => s.payload);
  const viewer = useTriage(store, (s) => s.viewer);
  const cursorKey = useTriage(store, (s) => s.cursorKey);
  // Tree rows select their whole subtree under the filters: re-render when the filtered set changes.
  const visibleSet = useTriage(store, (s) => s.visibleByGroup);
  const docs = useMemo(() => payload?.test.documents ?? [], [payload]);
  const docsFilter = useTriage(store, (s) => s.query.docs);
  // Only the models involved in what is on screen: the current clash/group, else the grid
  // cell's pair (?docs=a,b), else the first row. Never the whole model set.
  const wantedUrns = useMemo(() => {
    const key = cursorKey ?? store.state.rows[0]?.key ?? null;
    const { docs: ids } = viewPair(key, docsFilter, store);
    const urnOf = new Map(docs.map((d) => [d.documentId, d.urn]));
    return ids.flatMap((id) => (urnOf.get(id) ? [urnOf.get(id)!] : []));
  }, [cursorKey, docsFilter, docs, store, visibleSet]);
  const wantedKey = wantedUrns.join(",");
  // Stable identity while the pair is unchanged, so ForgeViewer does nothing on cursor moves within it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const viewerUrns = useMemo(() => wantedUrns, [wantedKey]);
  const hasSdk = typeof window !== "undefined" && !!window.Autodesk?.Viewing;
  // Real models only with live ACC data: fixtures URNs are fake, so fixtures/mock keep the placeholder.
  const live = api.mode === "http" && coordStatus?.dataSource === "live" && docs.length > 0 && hasSdk;
  const [viewerToken, setViewerToken] = useState<"checking" | "ok" | "none">("checking");
  useEffect(() => {
    if (!live) return;
    let alive = true;
    // Downscoped viewer token from the server (POST /api/auth/refresh); null = browser login needed.
    void getAccessToken().then((tk) => alive && setViewerToken(tk ? "ok" : "none"));
    return () => {
      alive = false;
    };
  }, [live, getAccessToken]);
  const canView = live && viewerToken === "ok";
  const modelsRef = useRef<Map<string, ModelHandle>>(new Map());

  useEffect(() => {
    store.setViewer({ status: canView ? "init" : "placeholder", loaded: 0, total: docs.length, failedDocs: [] });
  }, [canView, docs.length, store]);

  // Dispose caches on test change / unmount.
  useEffect(() => {
    return () => {
      clearClashPair();
    };
  }, [payload?.test.id]);

  const sidesFor = useCallback(
    (list: Clash[]): { a: ClashSide[]; b: ClashSide[] } => {
      const urnOf = new Map(docs.map((d) => [d.documentId, d.urn]));
      const collect = (pick: (c: Clash) => { documentId: number; dbId: number }) => {
        const byModel = new Map<ModelHandle, Set<number>>();
        for (const c of list) {
          const el = pick(c);
          const model = modelsRef.current.get(urnOf.get(el.documentId) ?? "");
          if (!model) continue;
          const set = byModel.get(model) ?? new Set<number>();
          set.add(el.dbId);
          byModel.set(model, set);
        }
        return [...byModel].map(([model, ids]) => ({ model, dbIds: [...ids] }));
      };
      return { a: collect((c) => c.a), b: collect((c) => c.b) };
    },
    [docs],
  );

  // Follow the cursor (debounced; only the settled position is rendered).
  useEffect(() => {
    if (viewer.status !== "ready") return;
    const id = window.setTimeout(() => {
      const { focus, members, target } = viewPair(cursorKey, docsFilter, store);
      if (!target.length) {
        clearClashPair();
        return;
      }
      const { a, b } = sidesFor(target);
      showClashPair(a, b, { mode: viewer.mode, colorA: COLOR_A, colorB: COLOR_B });
      if (viewer.side !== "both") setSideVisibility(viewer.side);
      // Lens Reunión: a grupo with a saved camera opens on it.
      if (store.effectiveLens() === "reunion") {
        const fid = store.viewFamilyOf(cursorKey);
        const saved = fid ? store.state.savedViews.get(fid) : undefined;
        if (saved?.camera) window.setTimeout(() => restoreSavedView(saved.camera), 250);
      }
      if (viewer.markers) {
        const specs = members.slice(0, MAX_MARKERS).flatMap((c, i) => {
          const s = sidesFor([c]);
          const p = computeClashPoint(s.a, s.b);
          if (!p) return [];
          const active = focus ? c.id === focus.id : i === 0;
          return [{ id: c.id, label: active ? t("viewer.clashPoint") : String(i + 1), position: p, active }];
        });
        setClashMarkers(specs, (clashId) => {
          const c = store.state.clashes.get(clashId);
          if (!c) return;
          if (store.state.query.view !== "clashes") store.toggleExpand(c.groupId, true);
          store.reveal(rowKey("clash", clashId));
        });
      } else clearClashMarkers();
    }, 150);
    return () => window.clearTimeout(id);
  }, [cursorKey, docsFilter, viewer.status, viewer.mode, viewer.markers, sidesFor, store, t, viewer.side, visibleSet, viewerUrns]);

  useEffect(() => {
    if (viewer.status === "ready") setSideVisibility(viewer.side);
  }, [viewer.side, viewer.status]);

  useEffect(() => {
    if (viewer.fitNonce && viewer.status === "ready") fitToCurrent();
  }, [viewer.fitNonce, viewer.status]);

  const sectionRef = useRef(viewer.section);
  useEffect(() => {
    if (viewer.status !== "ready" || sectionRef.current === viewer.section) return;
    sectionRef.current = viewer.section;
    toggleSectionBox();
  }, [viewer.section, viewer.status]);

  // Viewer → list sync: clicking an element selects the first row that involves it.
  const onViewerReady = useCallback(() => {
    const v = (window as unknown as { __apsViewer?: { getViewer: () => { addEventListener: (e: string, cb: (ev: { dbIdArray?: number[]; model?: ModelHandle }) => void) => void } | null } }).__apsViewer?.getViewer();
    const Ev = window.Autodesk?.Viewing?.AGGREGATE_SELECTION_CHANGED_EVENT ?? window.Autodesk?.Viewing?.SELECTION_CHANGED_EVENT;
    if (!v || !Ev) return;
    v.addEventListener(Ev, (ev: { dbIdArray?: number[]; model?: ModelHandle; selections?: { model: ModelHandle; dbIdArray: number[] }[] }) => {
      const sel = ev.selections?.[0] ?? (ev.dbIdArray ? { model: ev.model, dbIdArray: ev.dbIdArray } : undefined);
      const dbId = sel?.dbIdArray?.[0];
      if (dbId === undefined) return;
      const urn = [...modelsRef.current].find(([, m]) => m === sel?.model)?.[0];
      const doc = docs.find((d) => d.urn === urn);
      if (!doc) return;
      const hits = [...store.state.clashes.values()].filter((c) => (c.a.documentId === doc.documentId && c.a.dbId === dbId) || (c.b.documentId === doc.documentId && c.b.dbId === dbId));
      if (!hits.length) return;
      const groups = new Set(hits.map((c) => c.groupId));
      const rows = store.state.rows;
      const row = rows.find((r) => (r.kind === "group" && groups.has(r.id)) || (r.kind === "clash" && hits.some((c) => c.id === r.id)));
      if (row) store.setCursor(row.key);
      if (groups.size > 1) store.setHint(t("workspace.elementInGroups", { count: groups.size }));
    });
  }, [docs, store, t]);

  const failedNames = docs.filter((d) => viewer.failedDocs.includes(d.documentId)).map((d) => d.name);

  return (
    <div className="relative min-w-0 flex-1 bg-brand-bg">
      {canView ? (
        <ForgeViewer
          getToken={getAccessToken}
          expiresIn={session ? Math.max(60, Math.floor((session.expiresAt - Date.now()) / 1000)) : 3600}
          modelUrns={viewerUrns}
          extensions={["Autodesk.Section"]}
          hideLoadErrors
          onViewerReady={onViewerReady}
          onProgress={(loaded, total) => store.setViewer({ status: "loading", loaded, total })}
          onModelsLoaded={(map, failed) => {
            // Keep every model loaded so far (hidden ones are cached by ForgeViewer).
            for (const [urn, m] of map) modelsRef.current.set(urn, m);
            store.setViewer({
              status: map.size ? "ready" : "failed",
              loaded: map.size,
              total: wantedUrns.length,
              failedDocs: docs.filter((d) => failed.includes(d.urn)).map((d) => d.documentId),
            });
          }}
        />
      ) : (
        <ViewerPlaceholder
          hasDocs={docs.length > 0}
          needsLogin={live && viewerToken === "none"}
          onLogin={() => {
            writeString("coord.returnTo", window.location.pathname + window.location.search, "session");
            login();
          }}
        />
      )}
      {viewer.status === "loading" && (
        <div className="absolute inset-x-0 top-12 flex justify-center">
          <span className="rounded-full bg-white/95 px-3 py-1 text-xs text-gray-700 shadow-sm">{t("viewer.loadingModels", { loaded: viewer.loaded, total: viewer.total })}</span>
        </div>
      )}
      {failedNames.length > 0 && (
        <div role="alert" className="absolute left-3 right-48 top-3 rounded border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
          {failedNames.map((n) => (
            <div key={n}>{t("viewer.modelFailed", { name: n })}</div>
          ))}
        </div>
      )}
      <ClashViewerToolbar />
      <ClashLegend />
    </div>
  );
}

function ViewerPlaceholder({ hasDocs, needsLogin, onLogin }: { hasDocs: boolean; needsLogin: boolean; onLogin: () => void }) {
  const t = useT();
  const { fmt } = useI18n();
  const { store } = useTriageContext();
  const cursorKey = useTriage(store, (s) => s.cursorKey);
  // Tree rows select their whole subtree under the filters: re-render when the filtered set changes.
  useTriage(store, (s) => s.visibleByGroup);
  const { focus, members } = store.selectionMembers(cursorKey);
  const c = focus ?? members[0];
  return (
    <div className="clash-placeholder-grid flex h-full w-full items-center justify-center p-6">
      <div className="max-w-md rounded-lg border border-brand-muted/20 bg-white/95 p-5 text-center shadow-sm">
        <IconCube size={28} className="mx-auto mb-2 text-brand-muted" />
        <p className="font-medium text-gray-800">{t("viewer.placeholderTitle")}</p>
        <p className="mt-1 text-xs text-gray-500">{needsLogin ? t("viewer.needsLogin") : hasDocs ? t("viewer.placeholderMock") : t("viewer.placeholderNoModels")}</p>
        {needsLogin && (
          <button type="button" onClick={onLogin} className="mt-3 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-light">
            {t("viewer.connect")}
          </button>
        )}
        {c ? (
          <div className="mt-4 space-y-2 text-left text-sm">
            <div className="flex items-start gap-2 rounded border border-l-4 border-brand-muted/20 border-l-clash-a p-2">
              <SideASwatch className="mt-1" />
              <div className="min-w-0">
                <div className="truncate font-medium text-clash-a-ink">
                  A · {c.a.discipline} · {c.a.name}
                </div>
                <div className="truncate text-xs text-gray-500">
                  {c.a.type} · {c.a.modelName} · id {c.a.dbId}
                </div>
              </div>
            </div>
            <div className="flex items-start gap-2 rounded border border-l-4 border-brand-muted/20 border-l-clash-b p-2">
              <SideBSwatch className="mt-1" />
              <div className="min-w-0">
                <div className="truncate font-medium text-clash-b-ink">
                  B · {c.b.discipline} · {c.b.name}
                </div>
                <div className="truncate text-xs text-gray-500">
                  {c.b.type} · {c.b.modelName} · id {c.b.dbId}
                </div>
              </div>
            </div>
            <p className="text-center text-xs text-gray-600">
              {t("viewer.distance", { value: fmt.mm(c.distanceMm) })} · {c.level}
              {!focus && members.length > 1 && ` · ${t("list.clashesCount", { count: members.length })}`}
            </p>
          </div>
        ) : (
          <p className="mt-3 text-xs text-gray-500">{t("viewer.placeholderSelect")}</p>
        )}
      </div>
    </div>
  );
}

function ClashViewerToolbar() {
  const t = useT();
  const { store } = useTriageContext();
  const v = useTriage(store, (s) => s.viewer);
  const lens = useTriage(store, () => store.effectiveLens());
  const btn = (active: boolean) => `h-8 rounded px-2 text-xs ${active ? "bg-brand text-white" : "text-gray-700 hover:bg-brand-surface"}`;
  const modes: { m: ViewerMode; label: string }[] = [
    { m: "isolate", label: t("viewer.isolate") },
    { m: "xray", label: t("viewer.xray") },
    { m: "context", label: t("viewer.context") },
  ];
  return (
    <div role="toolbar" aria-label={t("viewer.mode")} className="absolute right-3 top-3 flex gap-1 rounded-lg border border-brand-muted/20 bg-white/95 p-1 shadow-sm">
      <div role="group" aria-label={`${t("viewer.mode")} (C)`} className="flex gap-0.5 border-r border-brand-muted/20 pr-1">
        {modes.map(({ m, label }) => (
          <button key={m} type="button" aria-pressed={v.mode === m} title={`${label} (C)`} className={btn(v.mode === m)} onClick={() => store.setViewer({ mode: m })}>
            {label}
          </button>
        ))}
      </div>
      {lens === "reunion" && <SaveViewButton className={btn(false)} />}
      <button type="button" title={t("viewer.fit")} aria-label={t("viewer.fit")} className={btn(false)} onClick={() => store.setViewer({ fitNonce: v.fitNonce + 1 })}>
        <IconFit />
      </button>
      <button type="button" title={t("viewer.sectionBox")} aria-label={t("viewer.sectionBox")} aria-pressed={v.section} className={btn(v.section)} onClick={() => store.setViewer({ section: !v.section })}>
        <IconSection />
      </button>
      <button type="button" title={t("viewer.markers")} aria-label={t("viewer.markers")} aria-pressed={v.markers} className={btn(v.markers)} onClick={() => store.setViewer({ markers: !v.markers })}>
        <IconMarker />
      </button>
      <div role="group" className="flex gap-0.5 border-l border-brand-muted/20 pl-1">
        <button type="button" title={t("viewer.onlyA")} aria-pressed={v.side === "a"} className={btn(v.side === "a")} onClick={() => store.setViewer({ side: "a" })}>
          A
        </button>
        <button type="button" title={t("viewer.onlyB")} aria-pressed={v.side === "b"} className={btn(v.side === "b")} onClick={() => store.setViewer({ side: "b" })}>
          B
        </button>
        <button type="button" title={t("viewer.both")} aria-pressed={v.side === "both"} className={btn(v.side === "both")} onClick={() => store.setViewer({ side: "both" })}>
          A+B
        </button>
      </div>
    </div>
  );
}

function ClashLegend() {
  const t = useT();
  const { fmt, lang } = useI18n();
  const { store } = useTriageContext();
  const cursorKey = useTriage(store, (s) => s.cursorKey);
  // Tree rows select their whole subtree under the filters: re-render when the filtered set changes.
  useTriage(store, (s) => s.visibleByGroup);
  const disciplines = useTriage(store, (s) => s.disciplines);
  const { focus, members } = store.selectionMembers(cursorKey);
  const c = focus ?? members[0];
  if (!c) return null;
  const dl = (code: string) => {
    const d = disciplines.find((x) => x.code === code);
    return d ? (lang === "en" ? d.en : d.es) : code;
  };
  return (
    <div className="absolute bottom-3 left-3 max-w-[60%] rounded-lg border border-brand-muted/20 bg-white/95 px-3 py-2 text-xs shadow-sm">
      <div className="flex items-center gap-1.5 truncate">
        <SideASwatch />
        <span className="text-clash-a-ink">{t("viewer.legendA", { discipline: dl(c.a.discipline), element: c.a.name })}</span>
      </div>
      <div className="flex items-center gap-1.5 truncate">
        <SideBSwatch />
        <span className="text-clash-b-ink">{t("viewer.legendB", { discipline: dl(c.b.discipline), element: c.b.name })}</span>
      </div>
      <div className="mt-0.5 text-gray-500">
        {focus ? t("viewer.distance", { value: fmt.mm(c.distanceMm) }) : t("viewer.selectionSummary", { clashes: members.length, locations: new Set(members.map((m) => m.groupId)).size })}
        {!focus && members.length > MAX_MARKERS && <span className="ml-1">· {t("viewer.moreMarkers", { count: members.length - MAX_MARKERS })}</span>}
      </div>
    </div>
  );
}
