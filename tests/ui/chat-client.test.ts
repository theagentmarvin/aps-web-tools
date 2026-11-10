/**
 * Agent chat client: the SSE parser (fetch streams, chunk boundaries anywhere),
 * the SSE → UI event mapping (cards come only from `proposal` / `question`
 * events), and the viewer selection → chat context mapping (≤ 50 elements).
 */
import { beforeAll, describe, expect, it } from "vitest";

// Browser-side modules are loaded at runtime so the Node-only server tsconfig
// (which typechecks tests/) does not walk into src/.
const SSE_MODULE: string = "../../src/lib/api/sse";
const SELECTION_MODULE: string = "../../src/features/triage/viewer-selection";
/* eslint-disable @typescript-eslint/no-explicit-any */
let SseParser: any;
let toChatEvent: any;
let selectionToElements: any;
let SELECTION_CAP: number;

beforeAll(async () => {
  ({ SseParser, toChatEvent } = await import(/* @vite-ignore */ SSE_MODULE));
  ({ selectionToElements, SELECTION_CAP } = await import(/* @vite-ignore */ SELECTION_MODULE));
});

describe("SseParser", () => {
  it("parses complete events and keeps the partial tail", () => {
    const p = new SseParser();
    expect(p.push('event: delta\ndata: {"text":"Ho')).toEqual([]);
    expect(p.push('la"}\n')).toEqual([]);
    expect(p.push('\nevent: done\ndata: {"durationMs":5}\n\n')).toEqual([
      { event: "delta", data: '{"text":"Hola"}' },
      { event: "done", data: '{"durationMs":5}' },
    ]);
  });

  it("handles CRLF, comments, multi-line data and the default event name", () => {
    const p = new SseParser();
    const out = p.push(": keep-alive\r\n\r\nevent: delta\r\ndata: a\r\ndata: b\r\n\r\ndata:x\n\n");
    expect(out).toEqual([
      { event: "delta", data: "a\nb" },
      { event: "message", data: "x" },
    ]);
  });

  it("splits a stream at every byte boundary the same way", () => {
    const stream = 'event: tool\ndata: {"name":"get_group","target":"G-12"}\n\nevent: delta\ndata: {"text":"ok"}\n\n';
    for (let i = 1; i < stream.length; i++) {
      const p = new SseParser();
      const out = [...p.push(stream.slice(0, i)), ...p.push(stream.slice(i))];
      expect(out.map((m: { event: string }) => m.event)).toEqual(["tool", "delta"]);
    }
  });
});

describe("toChatEvent", () => {
  const ev = (event: string, data: unknown) => toChatEvent({ event, data: JSON.stringify(data) });

  it("maps status phases and tool calls to status lines", () => {
    expect(ev("status", { type: "status", phase: "thinking" })).toEqual({ type: "status", text: "phase:thinking", chatId: undefined });
    expect(ev("tool", { type: "tool", name: "get_group", target: "G-12" })).toMatchObject({ type: "status", text: "tool:get_group|G-12" });
    expect(ev("tool", { type: "tool", name: "list_groups" })).toMatchObject({ text: "tool:list_groups" });
  });

  it("maps delta text", () => {
    expect(ev("delta", { type: "delta", text: "Hola " })).toEqual({ type: "delta", text: "Hola " });
  });

  it("builds cards only from proposal / question events", () => {
    expect(ev("proposal", { type: "proposal", id: "P-1", kind: "classification", summary: "Real" })).toEqual({
      type: "proposal",
      proposal: { type: "proposal", id: "P-1", kind: "classification", summary: "Real" },
    });
    const q = ev("question", { type: "question", id: "Q-7", question: "¿Mover el ducto?" });
    expect(q.type).toBe("proposal");
    expect(q.proposal).toMatchObject({ id: "Q-7", kind: "question", summary: "¿Mover el ducto?", questionId: "Q-7" });
  });

  it("reads cost and duration from done", () => {
    expect(ev("done", { type: "done", messageId: "M1", costUsd: 0.042, durationMs: 8100 })).toMatchObject({ type: "done", cost: 0.042, durationMs: 8100 });
  });

  it("keeps known error codes and folds unknown ones into failed", () => {
    expect(ev("error", { code: "not_logged_in", message: "x" })).toEqual({ type: "error", code: "not_logged_in", message: "x" });
    expect(ev("error", { code: "rate_limited", message: "" })).toMatchObject({ code: "rate_limited" });
    expect(ev("error", { code: "weird", message: "" })).toMatchObject({ code: "failed" });
  });

  it("ignores unknown events", () => {
    expect(ev("ping", {})).toBeNull();
  });
});

describe("selectionToElements", () => {
  const A = { name: "arq" };
  const B = { name: "mep" };
  const C = { name: "not in the model set" };
  const urns = new Map<unknown, string>([
    [A, "urn:a"],
    [B, "urn:b"],
    [C, "urn:c"],
  ]);
  const urnOf = (m: unknown) => urns.get(m);
  const docs = [
    { documentId: 1, urn: "urn:a" },
    { documentId: 2, urn: "urn:b" },
  ];

  it("maps model → URN → documentId and dedupes", () => {
    const r = selectionToElements(
      [
        { model: A, selection: [10, 11, 10] },
        { model: B, dbIdArray: [7] },
        { model: C, selection: [99] },
      ],
      urnOf,
      docs,
    );
    expect(r.elements).toEqual([
      { documentId: 1, dbId: 10 },
      { documentId: 1, dbId: 11 },
      { documentId: 2, dbId: 7 },
    ]);
    expect(r).toMatchObject({ truncated: false, total: 3 });
  });

  it(`caps at ${50} and reports the total ("50 de N")`, () => {
    expect(SELECTION_CAP).toBe(50);
    const ids = Array.from({ length: 120 }, (_, i) => i + 1);
    const r = selectionToElements([{ model: A, selection: ids }], urnOf, docs);
    expect(r.elements).toHaveLength(50);
    expect(r.elements[0]).toEqual({ documentId: 1, dbId: 1 });
    expect(r).toMatchObject({ truncated: true, total: 120 });
  });

  it("returns nothing for an empty or unknown selection", () => {
    expect(selectionToElements([], urnOf, docs)).toEqual({ elements: [], truncated: false, total: 0 });
    expect(selectionToElements([{ model: {}, selection: [1] }], urnOf, docs).total).toBe(0);
  });
});
