/**
 * Workspace keyboard map (spec §3.4), registered in the shared hotkey registry
 * so the `?` overlay is generated from these bindings.
 */
import { useNavigate } from "react-router";
import { useT } from "~/i18n";
import { useToast } from "~/lib/components/Toast";
import { useHotkeys, type HotkeyBinding } from "~/lib/hotkeys";
import { useSettings } from "~/lib/settings";
import { useTriageContext } from "./actions";
import { groupChange } from "./change";
import { useIssueDecision } from "./IssueViews";
import { isDecisionKey, parseKey } from "./store";

export function useTriageHotkeys(opts: { onSend: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const toast = useToast();
  const { settings } = useSettings();
  const { store, actions } = useTriageContext();
  const decideIssue = useIssueDecision();

  // Decision target under the cursor (g:/c:); tree rows (families, nodes) return null.
  const current = () => (isDecisionKey(store.state.cursorKey) ? store.state.cursorKey : null);
  const focusList = () => document.getElementById("triage-list")?.focus({ preventScroll: true });

  const bindings: HotkeyBinding[] = [
    // Navigation
    { keys: ["j", "ArrowDown"], labelKey: "shortcuts.next", group: "navigation", run: () => store.move(1) },
    { keys: ["k", "ArrowUp"], labelKey: "shortcuts.prev", group: "navigation", run: () => store.move(-1) },
    { keys: ["J"], labelKey: "shortcuts.nextClash", group: "navigation", run: () => store.moveWithinGroup(1) },
    { keys: ["K"], labelKey: "shortcuts.prevClash", group: "navigation", run: () => store.moveWithinGroup(-1) },
    {
      keys: ["Enter"],
      labelKey: "shortcuts.keepInherited",
      group: "decisions",
      run: () => {
        const k = current();
        const g = k?.startsWith("g:") ? store.state.groups.get(k.slice(2)) : undefined;
        if (k && g?.inherited && groupChange(g) === "unchanged" && !store.state.latest.has(g.id)) return actions.keepInherited(k);
        store.expandCurrent();
      },
    },
    { keys: ["l", "ArrowRight"], labelKey: "shortcuts.expand", group: "navigation", run: () => store.expandCurrent() },
    { keys: ["h", "ArrowLeft"], labelKey: "shortcuts.collapse", group: "navigation", run: () => store.collapseCurrent() },
    { keys: ["g g", "G"], labelKey: "shortcuts.firstLast", group: "navigation", run: (e) => (e.key === "G" ? store.last() : store.first()) },
    // Decisions
    {
      keys: ["a"],
      labelKey: "shortcuts.accept",
      group: "decisions",
      run: () => {
        // Issue rows (lens Incidencias): accept the verdict (read-only against ACC).
        const k = store.state.cursorKey;
        if (k?.startsWith("i:")) {
          const c = store.state.issueChecks.get(k.slice(2));
          if (c && !c.decision) void decideIssue(c, "accept");
          return;
        }
        actions.accept();
      },
    },
    {
      keys: ["e"],
      labelKey: "shortcuts.edit",
      group: "decisions",
      run: () => {
        if (store.state.cursorKey?.startsWith("f:")) return store.setEditing(true);
        const k = current();
        if (!k) return;
        const { kind, id } = parseKey(k);
        if (!store.proposalFor(kind, id)) return store.setHint(t("actions.nothingToAccept"));
        store.setEditing(true);
      },
    },
    { keys: ["x"], labelKey: "shortcuts.reject", group: "decisions", run: () => actions.reject() },
    { keys: ["1", "2", "3", "4"], labelKey: "shortcuts.priority", group: "decisions", run: (e) => actions.setPriority(Number(e.key) as 1 | 2 | 3 | 4) },
    { keys: ["v"], labelKey: "shortcuts.validity", group: "decisions", run: () => current() && store.setDialog({ type: "validity" }) },
    {
      keys: ["i"],
      labelKey: "shortcuts.issue",
      group: "decisions",
      run: () => {
        const k = current();
        if (!k) return;
        const { kind, id } = parseKey(k);
        const p = store.proposalFor(kind, id);
        if (!p?.issueDraft && !store.state.edits.get(id)?.issue) {
          const base = p?.fields.action.value ?? { createIssue: false, setStatus: null };
          store.setEdits(id, { issue: {}, action: { ...base, createIssue: true, setStatus: base.setStatus ?? "reviewed" } });
        }
        window.setTimeout(() => document.getElementById("issue-title")?.focus(), 50);
      },
    },
    { keys: ["s"], labelKey: "shortcuts.postpone", group: "decisions", run: () => actions.postpone() },
    { keys: ["n"], labelKey: "shortcuts.note", group: "decisions", run: () => current() && store.setDialog({ type: "note", key: current()! }) },
    { keys: ["p"], labelKey: "shortcuts.compare", group: "decisions", run: () => {
      const k = current();
      if (!k) return;
      const { kind, id } = parseKey(k);
      const clashId = kind === "clash" ? id : store.state.clashesByGroup.get(id)?.[0]?.id;
      if (clashId) store.setDialog({ type: "compare", key: `c:${clashId}` });
    } },
    { keys: ["u", "Ctrl+z"], labelKey: "shortcuts.undo", group: "decisions", run: () => actions.undo() },
    { keys: ["Ctrl+Shift+z", "Ctrl+Shift+Z"], labelKey: "shortcuts.redo", group: "decisions", run: () => actions.redo() },
    // Selection
    { keys: ["Space"], labelKey: "shortcuts.toggleCheck", group: "selection", run: () => store.state.cursorKey && store.toggleCheckSubtree(store.state.cursorKey) },
    { keys: ["Shift+Space"], labelKey: "shortcuts.rangeCheck", group: "selection", run: () => current() && store.rangeCheck(current()!) },
    {
      keys: ["Ctrl+a"],
      labelKey: "shortcuts.checkAll",
      group: "selection",
      run: () => {
        const n = store.checkAll();
        if (n) toast.show(t("list.selected", { count: n }));
      },
    },
    { keys: ["A"], labelKey: "shortcuts.bulkAccept", group: "selection", run: () => actions.bulkAccept() },
    { keys: ["X"], labelKey: "shortcuts.bulkReject", group: "selection", run: () => actions.bulkReject() },
    { keys: ["/"], labelKey: "shortcuts.search", group: "selection", run: () => document.getElementById("triage-search")?.focus() },
    { keys: ["F"], labelKey: "shortcuts.filters", group: "selection", run: () => document.getElementById("add-filter-btn")?.click() },
    // Viewer
    { keys: ["c"], labelKey: "shortcuts.cycleMode", group: "viewer", run: () => store.cycleViewerMode() },
    { keys: ["z"], labelKey: "shortcuts.fit", group: "viewer", run: () => store.setViewer({ fitNonce: store.state.viewer.fitNonce + 1 }) },
    { keys: ["b"], labelKey: "shortcuts.sectionBox", group: "viewer", run: () => store.setViewer({ section: !store.state.viewer.section }) },
    { keys: ["m"], labelKey: "shortcuts.markers", group: "viewer", run: () => store.setViewer({ markers: !store.state.viewer.markers }) },
    {
      keys: ["[", "]", "="],
      labelKey: "shortcuts.sides",
      group: "viewer",
      run: (e) => store.setViewer({ side: e.key === "[" ? "a" : e.key === "]" ? "b" : "both" }),
    },
    // General
    {
      keys: ["r"],
      labelKey: "shortcuts.rationale",
      group: "global",
      run: () => {
        const k = current();
        if (!k) return;
        const e = store.evaluate(parseKey(k).kind, parseKey(k).id);
        store.toggleRationale(e?.d.confidence === null || (e?.d.confidence ?? 1) < store.state.thresholds.high);
      },
    },
    { keys: ["\\"], labelKey: "shortcuts.toggleDetail", group: "global", run: () => store.toggleDetail() },
    { keys: ["R"], labelKey: "shortcuts.reload", group: "global", run: () => store.applyProposalUpdates() },
    { keys: ["Ctrl+Enter"], labelKey: "shortcuts.send", group: "global", run: () => opts.onSend() },
    {
      keys: ["g a", "g i", "g r", "g p"],
      labelKey: "shortcuts.goTo",
      group: "global",
      run: (e) => navigate(({ a: "/aprobaciones", i: "/", r: "/reglas", p: "/reportes" } as Record<string, string>)[e.key] ?? "/"),
    },
    { keys: ["?"], labelKey: "shortcuts.help", group: "global", run: () => store.setDialog(store.state.dialog?.type === "shortcuts" ? null : { type: "shortcuts" }) },
    {
      keys: ["Escape"],
      labelKey: "shortcuts.escape",
      group: "global",
      run: () => {
        if (store.state.editing) return store.setEditing(false);
        if (store.state.hint) return store.setHint(null);
        if (store.state.checked.size) return store.clearChecks();
        focusList();
      },
    },
  ];

  useHotkeys("triage", bindings, { singleKey: settings.singleKeyShortcuts, onEscapeFromInput: focusList });
}
