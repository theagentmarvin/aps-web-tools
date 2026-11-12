/**
 * "⋯" menu of the family pane (docs/ai/agent-human-parity.md #31, #32): the
 * direct human gestures behind the agent's regroup proposals —
 *   Separar una ubicación (POST /families/:id/detach) and
 *   Fusionar con otra familia (POST /families/merge).
 * Both are local regroupings (nothing reaches ACC) and always go through a
 * confirmation dialog that states exactly what moves.
 */
import { useState } from "react";
import { useT } from "~/i18n";
import { ApiError, useApi } from "~/lib/api";
import type { TriageFamily } from "~/lib/api/types";
import { IconMore } from "~/lib/components/icons";
import { MenuButton, menuItemCls } from "~/lib/components/MenuButton";
import { Modal } from "~/lib/components/Modal";
import { useToast } from "~/lib/components/Toast";
import { Button, inputCls } from "~/lib/components/ui";
import { useTriageContext } from "./actions";
import { mergeCandidates } from "./family-regroup";
import { useTriage } from "./store";

type Mode = "detach" | "merge" | null;

export function FamilyMoreMenu({ family }: { family: TriageFamily }) {
  const t = useT();
  const [mode, setMode] = useState<Mode>(null);
  const decided = family.decision?.status === "approved";
  return (
    <>
      <MenuButton title={t("parity.family.more")} label={<IconMore size={14} />} className="rounded p-0.5 text-gray-500 hover:bg-brand-surface hover:text-brand" panelClassName="w-60">
        {(close) => (
          <>
            <button type="button" role="menuitem" className={menuItemCls} disabled={family.groupIds.length < 2} title={family.groupIds.length < 2 ? t("parity.family.detachSingle") : undefined} onClick={() => (close(), setMode("detach"))}>
              {t("parity.family.detach")}
            </button>
            <button type="button" role="menuitem" className={menuItemCls} disabled={decided} title={decided ? t("parity.family.mergeDecided") : undefined} onClick={() => (close(), setMode("merge"))}>
              {t("parity.family.merge")}
            </button>
          </>
        )}
      </MenuButton>
      {mode && <RegroupDialog family={family} mode={mode} onClose={() => setMode(null)} />}
    </>
  );
}

function RegroupDialog({ family, mode, onClose }: { family: TriageFamily; mode: "detach" | "merge"; onClose: () => void }) {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const { store } = useTriageContext();
  const families = useTriage(store, (s) => s.families);
  const groups = useTriage(store, (s) => s.groups);
  const candidates = mode === "merge" ? mergeCandidates(family, families.values()) : [];
  const [target, setTarget] = useState<string>(mode === "merge" ? (candidates[0]?.id ?? "") : (family.groupIds[0] ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const testId = store.state.payload?.test.id ?? "";
  const into = families.get(target);
  const g = groups.get(target);

  async function confirm() {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "detach") {
        store.applyFamilies(await api.detachFamilyInstance(family.id, { testId, groupId: target }));
        toast.show(t("parity.family.detached", { group: target }));
      } else {
        store.applyFamilies(await api.mergeFamilies({ testId, from: family.id, into: target }));
        store.reveal(`f:${target}`);
        toast.show(t("parity.family.merged", { from: family.id, into: target }));
      }
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  }

  const label = (f: TriageFamily) => `${f.id} · ${f.pair ? `${f.pair[0]}×${f.pair[1]} · ` : ""}${f.title} · ${t("parity.family.instances", { count: f.instanceCount })}`;
  return (
    <Modal
      title={mode === "detach" ? t("parity.family.detachTitle") : t("parity.family.mergeTitle")}
      onClose={onClose}
      width="w-[520px] max-w-[95vw]"
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={!target || busy} onClick={() => void confirm()}>
            {mode === "detach" ? t("parity.family.detachConfirm") : t("parity.family.mergeConfirm")}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <label className="block text-xs text-gray-600">
          {mode === "detach" ? t("parity.family.pickInstance") : t("parity.family.pickTarget")}
          <select className={`${inputCls} mt-1 w-full text-sm`} value={target} onChange={(e) => setTarget(e.target.value)}>
            {mode === "detach"
              ? family.groupIds.map((id) => {
                  const x = groups.get(id);
                  return (
                    <option key={id} value={id}>
                      {id} · {x?.location?.level ?? "—"} · {t("list.clashesCount", { count: x?.clashIds.length ?? 0 })}
                    </option>
                  );
                })
              : candidates.map((f) => (
                  <option key={f.id} value={f.id}>
                    {label(f)}
                  </option>
                ))}
          </select>
        </label>
        <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="status">
          {mode === "detach"
            ? t("parity.family.detachEffect", { group: target, title: g?.title ?? target, family: family.id })
            : t("parity.family.mergeEffect", { from: family.id, count: family.instanceCount, into: into ? label(into) : target })}
        </p>
        <p className="text-[11px] text-gray-500">{t("parity.family.localOnly")}</p>
        {error && (
          <p role="alert" className="text-xs text-red-700">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
