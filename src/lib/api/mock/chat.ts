/**
 * Mock agent chat: a fake streaming agent. It answers from the context it
 * receives (focused item, viewer selection), streams the answer word by word
 * with status lines, and emits one proposal card. Errors can be forced with a
 * message starting with "/error <code>" (for UI checks).
 */
import type { ChatErrorCode, ChatEvent, ChatHistory, ChatMessage, ChatProposal, ChatRequest } from "../types";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
  });

export class MockChat {
  private chats = new Map<string, ChatHistory>();
  private seq = 0;
  private running = new Set<string>();

  get(chatId: string): ChatHistory {
    return this.chats.get(chatId) ?? { chatId, testId: "", messages: [] };
  }

  cancel(chatId: string) {
    this.running.delete(chatId);
  }

  async run(req: ChatRequest, onEvent: (e: ChatEvent) => void, signal?: AbortSignal): Promise<void> {
    const chatId = (!req.newSession && req.chatId) || `chat-${req.testId}-${++this.seq}`;
    const chat = this.chats.get(chatId) ?? { chatId, testId: req.testId, messages: [] };
    this.chats.set(chatId, chat);
    if (this.running.has(chatId)) return onEvent({ type: "error", code: "busy", message: "El agente ya está respondiendo en esta conversación." });
    const forced = /^\/error\s+(\w+)/.exec(req.message)?.[1] as ChatErrorCode | undefined;
    if (forced) return onEvent({ type: "error", code: forced, message: `Error simulado: ${forced}` });

    this.running.add(chatId);
    chat.messages.push({ role: "user", text: req.message, at: new Date().toISOString(), context: req.context });
    const answer: ChatMessage = { role: "agent", text: "", at: new Date().toISOString(), proposals: [] };
    try {
      onEvent({ type: "status", text: "phase:thinking", chatId });
      await sleep(400, signal);
      const focus = req.context.focus;
      const sel = req.context.selection?.length ?? 0;
      if (focus || sel) {
        onEvent({ type: "status", text: sel ? "tool:get_selection_context" : "tool:get_group" });
        await sleep(500, signal);
      }
      const text = [
        focus ? `Revisé **${focus.label ?? focus.id}**.` : "Revisé el estado de la prueba.",
        sel ? `Tengo ${sel} elementos seleccionados en el visor: los usé para acotar las interferencias.` : "",
        "",
        "Lo que veo:",
        "- La penetración máxima supera la tolerancia del par, así que no es un contacto superficial.",
        "- No hay una pasada modelada a menos de 50 mm del punto de choque.",
        `- Sugiero tratarlo como **conflicto** y crear una incidencia para la disciplina que mueve.`,
        "",
        "Dejé una **propuesta** abajo: no se aplica nada hasta que la apruebes.",
      ]
        .filter((l, i, a) => l !== "" || a[i - 1] !== "")
        .join("\n");
      for (const word of text.split(/(?<=\s)/)) {
        if (!this.running.has(chatId)) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
        answer.text += word;
        onEvent({ type: "delta", text: word });
        await sleep(25, signal);
      }
      const proposal: ChatProposal = sel
        ? { id: `CP-${this.seq}-${Date.now()}`, kind: "regroup", summary: `Agrupar ${sel} elementos seleccionados con ${focus?.label ?? "el grupo actual"}`, targetCount: sel, groupIds: focus?.kind === "group" ? [focus.id] : [] }
        : focus?.kind === "family"
          ? { id: `CP-${this.seq}-${Date.now()}`, kind: "family_decision", summary: `Decidir el grupo como conflicto · crear incidencia`, targetCount: 1, familyId: focus.id }
          : { id: `CP-${this.seq}-${Date.now()}`, kind: "decision", summary: `Marcar como conflicto y crear incidencia`, targetCount: 1, groupIds: focus?.kind === "group" ? [focus.id] : [], clashIds: focus?.kind === "clash" ? [focus.id] : [] };
      answer.proposals!.push(proposal);
      onEvent({ type: "proposal", proposal });
      const started = Date.parse(answer.at);
      answer.cost = 0.03 + sel * 0.001;
      answer.durationMs = Date.now() - started;
      onEvent({ type: "done", chatId, cost: answer.cost, durationMs: answer.durationMs });
    } catch (err) {
      if ((err as Error).name !== "AbortError") throw err;
      answer.text += "\n\n_(cancelado)_";
    } finally {
      this.running.delete(chatId);
      chat.messages.push(answer);
    }
  }
}
