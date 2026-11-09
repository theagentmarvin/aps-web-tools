/**
 * X3 helpers: what an option of a coordinator question means, so the answer
 * carries `validity` / `action` and the server records it as the decision.
 * Options are Spanish free text from the agent; unknown wording = answer only.
 */
import type { AgentQuestion, InheritedDecision, QuestionAnswerRequest, Validity } from "~/lib/api/types";
import type { TFunction } from "~/i18n";
import { VALIDITY_KEY } from "~/lib/labels";

export function answerMeaning(kind: AgentQuestion["kind"], option: string): Pick<QuestionAnswerRequest, "validity" | "action"> {
  const o = option.toLowerCase();
  if (kind === "validity") {
    if (/falso|no es (un )?problema|pasada prevista/.test(o)) return { validity: "false_positive" };
    if (/tolera/.test(o)) return { validity: "tolerated" };
    if (/información|info|no sé/.test(o)) return { validity: "needs_info" };
    if (/real|válid|sí/.test(o)) return { validity: "real" };
  }
  if (kind === "action") {
    if (/incidencia|issue/.test(o)) return { action: "create_issue" };
    if (/cerrar|close/.test(o)) return { action: "close" };
    if (/revisad|reviewed/.test(o)) return { action: "mark_reviewed" };
    if (/posponer|reunión|postpone/.test(o)) return { action: "postpone" };
  }
  return {};
}

/** "Válida · Crear incidencia" style summary of an inherited decision. */
export function inheritedSummary(t: TFunction, inh: InheritedDecision): string {
  const parts: string[] = [];
  if (inh.validity) parts.push(t(VALIDITY_KEY[inh.validity as Validity]));
  parts.push(t(`inherited.effect.${inh.effect}`));
  return parts.join(" · ");
}

/** "Heredada de v10 · decidida por ti / por el grupo / en ACC" */
export function inheritedTooltip(t: TFunction, inh: InheritedDecision): string {
  return t("inherited.tooltip", { version: inh.fromVersion, who: t(`inherited.source.${inh.source}`) });
}
