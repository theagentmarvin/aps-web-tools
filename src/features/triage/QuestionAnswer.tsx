/**
 * X3 answer flow for an agent question, shared by the Detalle callout and the
 * chat card (G12). A decision comes only from a STRUCTURED option sent by the
 * server (never from text); free text is only an answer. "Esta respuesta
 * decidirá N ubicaciones"; above 3 an explicit confirmation.
 */
import { useState } from "react";
import { useT } from "~/i18n";
import { useApi } from "~/lib/api";
import type { AgentQuestion } from "~/lib/api/types";
import { useToast } from "~/lib/components/Toast";
import { useTriageContext } from "./actions";
import { CONFIRM_ABOVE, answerBody, decidedCount, optionsOf, type UiOption } from "./questions";

export function QuestionAnswer({ q, onAnswered }: { q: AgentQuestion; onAnswered?: () => void }) {
  const t = useT();
  const api = useApi();
  const toast = useToast();
  const { store } = useTriageContext();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<UiOption | null>(null);
  const options = optionsOf(q);
  const n = decidedCount(q);
  const anyDecides = options.some((o) => o.decides);
  async function send(option: UiOption | null, confirmed: boolean) {
    if (!option && !text.trim()) return;
    setBusy(true);
    try {
      const res = await api.answerQuestion(q.id, answerBody(q, option, text, confirmed));
      store.applyAnswer(q.id, res);
      if (res.decisionIds?.length) {
        const page = await api.listDecisions({ testId: store.state.payload?.test.id, limit: 200 });
        store.mergeServerDecisions(page.items);
      }
      toast.show(res.decisionIds?.length ? t("questions.answeredDecision") : t("questions.answered"));
      setText("");
      setPending(null);
      onAnswered?.();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), { tone: "error" });
    } finally {
      setBusy(false);
    }
  }
  function choose(o: UiOption) {
    if (o.decides && n > CONFIRM_ABOVE) setPending(o);
    else void send(o, false);
  }
  if (q.state === "stale") return <p className="mt-1 text-xs text-gray-600">{t("questions.stale", { reason: q.staleReason ?? "" })}</p>;
  if (q.state !== "open") return <p className="mt-1 text-xs text-gray-700">{t("questions.answeredBy", { user: q.answeredBy ?? "—", answer: q.answer ?? "" })}</p>;
  return (
    <>
      {anyDecides && <p className="mt-1 text-xs font-medium text-violet-900">{t("questions.willDecide", { count: n })}</p>}
      {!!options.length && !pending && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {options.map((o) => (
            <button
              key={o.index}
              type="button"
              disabled={busy}
              onClick={() => choose(o)}
              title={o.decides ? t("questions.optionDecides", { count: n }) : t("questions.optionAnswerOnly")}
              className="rounded border border-violet-300 bg-white px-2 py-1 text-xs text-violet-900 hover:border-violet-500 disabled:opacity-50"
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
      {pending && (
        <div role="alertdialog" aria-labelledby={`qc-${q.id}`} className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs">
          <p id={`qc-${q.id}`} className="font-medium text-amber-900">
            {t("questions.confirmText", { option: pending.label, count: n })}
          </p>
          <div className="mt-1.5 flex gap-1.5">
            <button type="button" disabled={busy} onClick={() => void send(pending, true)} className="rounded bg-brand px-2 py-1 text-white disabled:opacity-50">
              {t("questions.confirm", { count: n })}
            </button>
            <button type="button" onClick={() => setPending(null)} className="rounded border border-brand-muted/30 px-2 py-1 text-gray-700">
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
      <form
        className="mt-2 flex gap-1.5"
        onSubmit={(ev) => {
          ev.preventDefault();
          void send(null, false);
        }}
      >
        <input value={text} onChange={(ev) => setText(ev.target.value)} placeholder={options.length ? t("questions.otherOption") : t("questions.placeholder")} aria-label={t("questions.placeholder")} title={t("questions.freeTextHint")} maxLength={1000} className="min-w-0 flex-1 rounded border border-violet-200 px-2 py-1 text-xs" />
        <button type="submit" disabled={busy || !text.trim()} className="rounded bg-violet-700 px-2 py-1 text-xs text-white disabled:opacity-50">
          {t("questions.send")}
        </button>
      </form>
    </>
  );
}
