/**
 * Minimal Server-Sent Events parser for fetch() streams (EventSource cannot
 * POST). Feed it decoded text chunks; it returns the complete events and keeps
 * the partial tail for the next chunk. Spec subset: `event:`, `data:`
 * (multi-line joined with "\n"), comments (`:`), blank-line dispatch.
 */
export interface SseMessage {
  event: string;
  data: string;
}

export class SseParser {
  private buffer = "";

  push(chunk: string): SseMessage[] {
    this.buffer += chunk.replace(/\r\n?/g, "\n");
    const out: SseMessage[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) >= 0) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length) out.push({ event, data: data.join("\n") });
    }
    return out;
  }
}

import { CHAT_ERROR_CODES, type ChatErrorCode } from "./types";

/** SSE message → typed chat event (unknown events are ignored). */
export function toChatEvent(m: SseMessage): import("./types").ChatEvent | null {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(m.data) as Record<string, unknown>;
  } catch {
    payload = { text: m.data };
  }
  const chatId = (payload.chatId ?? payload.sessionId ?? payload.sessionKey) as string | undefined;
  switch (m.event) {
    case "status": {
      // Server phases: starting | thinking | tool (+ tool name); older drafts sent free text.
      const phase = payload.phase as string | undefined;
      const tool = payload.tool as string | undefined;
      const text = phase === "tool" && tool ? `tool:${tool}` : phase ? `phase:${phase}` : String(payload.text ?? payload.message ?? "");
      return { type: "status", text, chatId };
    }
    case "tool": {
      // contract: { name, target? } → "tool:<name>" or "tool:<name>|<target>".
      const target = payload.target ? `|${String(payload.target)}` : "";
      return { type: "status", text: `tool:${String(payload.name ?? payload.tool ?? "")}${target}`, chatId };
    }
    case "delta":
      return { type: "delta", text: String(payload.text ?? "") };
    case "proposal":
    case "question": {
      // Cards come ONLY from these server events (never from the model's text).
      const p = (payload.proposal ?? payload) as import("./types").ChatProposal & { question?: string };
      if (m.event === "question") {
        const { question, ...rest } = p;
        return { type: "proposal", proposal: { ...rest, kind: "question", summary: String(question ?? p.summary ?? ""), questionId: (p.questionId ?? p.id) as string } };
      }
      return { type: "proposal", proposal: { ...p, summary: String(p.summary ?? "") } };
    }
    case "done":
    {
      const cost = typeof payload.costUsd === "number" ? payload.costUsd : typeof payload.cost === "number" ? payload.cost : undefined;
      return { type: "done", chatId, cost, durationMs: typeof payload.durationMs === "number" ? payload.durationMs : undefined };
    }
    case "error": {
      const code = String(payload.code ?? "failed") as ChatErrorCode;
      return { type: "error", code: CHAT_ERROR_CODES.includes(code) ? code : "failed", message: String(payload.message ?? "") };
    }
    default:
      return null;
  }
}
