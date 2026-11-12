/**
 * ACC assignee picker (G5): company / role / user from the project members, "none", or an ACC id
 * entered by hand when ACC does not list the members. The value is ACC metadata only.
 */
import { useState } from "react";
import { useT, type TKey } from "~/i18n";
import type { Assignee } from "~/lib/api/types";
import { Button, inputCls } from "~/lib/components/ui";

export interface AssigneeValue {
  id: string;
  type: "user" | "role" | "company";
  label: string;
}

const KINDS = ["company", "role", "user"] as const;
const MANUAL = "__manual__";

export function AssigneePicker({ value, candidates, onChange, disabled, label }: { value: AssigneeValue | null; candidates: Assignee[]; onChange: (v: AssigneeValue | null) => void; disabled?: boolean; label: string }) {
  const t = useT();
  const known = !value || candidates.some((c) => c.id === value.id && c.kind === value.type);
  const [manual, setManual] = useState(!known);
  const [id, setId] = useState(value && !known ? value.id : "");
  const [type, setType] = useState<AssigneeValue["type"]>(value?.type ?? "company");
  const key = value ? `${value.type}:${value.id}` : "";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <select
        className={`${inputCls} min-w-0 max-w-full text-xs`}
        aria-label={label}
        disabled={disabled}
        value={manual ? MANUAL : key}
        onChange={(e) => {
          const v = e.target.value;
          if (v === MANUAL) return setManual(true);
          setManual(false);
          if (!v) return onChange(null);
          const c = candidates.find((x) => `${x.kind}:${x.id}` === v);
          if (c) onChange({ id: c.id, type: c.kind, label: c.name });
        }}
      >
        <option value="">{t("accIssues.none")}</option>
        {KINDS.map((k) => {
          const list = candidates.filter((c) => c.kind === k);
          return list.length ? (
            <optgroup key={k} label={t(`accIssues.kind.${k}` as TKey)}>
              {list.map((c) => (
                <option key={c.id} value={`${c.kind}:${c.id}`}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          ) : null;
        })}
        <option value={MANUAL}>{t("accIssues.manual")}</option>
      </select>
      {manual && (
        <>
          <input className={`${inputCls} w-40 font-mono text-xs`} value={id} onChange={(e) => setId(e.target.value)} placeholder={t("accIssues.manualId")} aria-label={t("accIssues.manualId")} disabled={disabled} />
          <select className={`${inputCls} text-xs`} value={type} onChange={(e) => setType(e.target.value as AssigneeValue["type"])} aria-label={t("accIssues.manualType")} disabled={disabled}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`accIssues.kind.${k}` as TKey)}
              </option>
            ))}
          </select>
          <Button disabled={disabled || !id.trim()} onClick={() => onChange({ id: id.trim(), type, label: id.trim() })}>
            {t("common.save")}
          </Button>
        </>
      )}
    </div>
  );
}
