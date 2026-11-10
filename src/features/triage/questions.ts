/**
 * X3 helpers. SECURITY (pilot-readiness review): the UI NEVER derives a
 * decision from option or answer TEXT. A decision comes only from a
 * structured option the server sent (`{label, validity?, action?}`); the UI
 * sends the selected option's index/id and the server applies it. Free text
 * is only an answer. Plain-string options (older servers) decide nothing.
 */
import type { TFunction } from "~/i18n";
import type { AgentQuestion, InheritedDecision, QuestionAnswerRequest, Validity } from "~/lib/api/types";
import { VALIDITY_KEY } from "~/lib/labels";

/** A question option as the UI uses it (normalised from the wire). */
export interface UiOption {
  index: number;
  label: string;
  validity?: Validity;
  action?: WireOption["action"];
  /** True when choosing it decides the ubicaciones of the question (server-structured only). */
  decides: boolean;
}
type WireOption = import("~/lib/api/types").QuestionOption;

export function optionsOf(q: AgentQuestion): UiOption[] {
  // Older servers sent plain strings: they decide nothing.
  const raw = (q.options ?? []) as Array<WireOption | string>;
  return raw.map((o, index) => (typeof o === "string" ? { index, label: o, decides: false } : { index, label: o.label, validity: o.validity, action: o.action, decides: !!(o.validity || o.action) }));
}

/** Ubicaciones a deciding answer applies to ("Esta respuesta decidirá N ubicaciones"). */
export function decidedCount(q: AgentQuestion): number {
  return q.affectedGroups ?? q.groupIds.length;
}

/** Above this many ubicaciones, a deciding answer needs an explicit confirmation (sent as confirmCount). */
export const CONFIRM_ABOVE = 3;

/** Body of POST /questions/:id/answer: the option INDEX is the only way an answer decides; free text decides nothing. */
export function answerBody(q: AgentQuestion, option: UiOption | null, freeText: string, confirmed: boolean): QuestionAnswerRequest {
  if (!option) return { answer: freeText.trim() };
  const body: QuestionAnswerRequest = { optionIndex: option.index };
  if (option.decides && decidedCount(q) > CONFIRM_ABOVE && confirmed) body.confirmCount = decidedCount(q);
  return body;
}

/** "Real · Crear incidencia" style summary of an inherited decision. */
export function inheritedSummary(t: TFunction, inh: InheritedDecision): string {
  const parts: string[] = [];
  if (inh.validity) parts.push(t(VALIDITY_KEY[inh.validity as Validity]));
  parts.push(t(`inherited.effect.${inh.effect}`));
  return parts.join(" · ");
}

/** "Heredada de v10 · decidida por ti / por el grupo / en ACC" (or "Confirmar decisión heredada" when pending). */
export function inheritedTooltip(t: TFunction, inh: InheritedDecision): string {
  if (inh.needsConfirmation) return t("inherited.needsConfirmationTip", { version: inh.fromVersion, summary: inheritedSummary(t, inh) });
  return t("inherited.tooltip", { version: inh.fromVersion, who: t(`inherited.source.${inh.source}`) });
}
