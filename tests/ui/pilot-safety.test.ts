/**
 * Pilot-readiness fixes (docs/domain/pilot-readiness-review.md):
 * - an agent question is decided ONLY by a structured option index, never by
 *   text (the old regex read "No, no es falso positivo: es real" as false_positive);
 * - a deciding answer on > 3 ubicaciones carries confirmCount;
 * - meeting notes warn on emails, phones and person-like names.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { personalDataIn } from "../../src/features/triage/privacy";

// questions.ts pulls UI labels (browser i18n): loaded at runtime so the Node-only server tsconfig stays clean.
const QUESTIONS_MODULE: string = "../../src/features/triage/questions";
type Option = { index: number; label: string; decides: boolean; validity?: string };
type Body = { optionIndex?: number; answer?: string; confirmCount?: number; validity?: unknown; action?: unknown };
let optionsOf: (q: unknown) => Option[];
let answerBody: (q: unknown, o: Option | null, text: string, confirmed: boolean) => Body;
let decidedCount: (q: unknown) => number;

beforeAll(async () => {
  ({ optionsOf, answerBody, decidedCount } = await import(/* @vite-ignore */ QUESTIONS_MODULE));
});

const question = (over: Record<string, unknown> = {}) => ({
  id: "Q-1",
  kind: "validity",
  question: "¿Es real?",
  groupIds: ["G-1"],
  affectedGroups: 1,
  state: "open",
  options: [
    { label: "Sí, es real", validity: "real" },
    { label: "No, hay pasada prevista (falso positivo)", validity: "false_positive" },
  ],
  ...over,
});

describe("agent questions: no decision from text", () => {
  it("free text with a negation decides nothing", () => {
    const body = answerBody(question(), null, "No, no es falso positivo: es real", false);
    expect(body).toEqual({ answer: "No, no es falso positivo: es real" });
    expect(body.optionIndex).toBeUndefined();
    expect(body.validity).toBeUndefined();
    expect(body.action).toBeUndefined();
  });

  it("a structured option is sent by index only", () => {
    const q = question();
    const [real] = optionsOf(q);
    expect(real.decides).toBe(true);
    expect(answerBody(q, real, "", false)).toEqual({ optionIndex: 0 });
  });

  it("plain-string options (older servers) decide nothing", () => {
    const q = question({ options: ["No, no es falso positivo: es real"] });
    const [o] = optionsOf(q);
    expect(o.decides).toBe(false);
    expect(o.validity).toBeUndefined();
  });

  it("more than 3 ubicaciones: confirmCount only after an explicit confirmation", () => {
    const q = question({ groupIds: ["G-1", "G-2", "G-3", "G-4", "G-5"], affectedGroups: 5 });
    const [real] = optionsOf(q);
    expect(decidedCount(q)).toBe(5);
    expect(answerBody(q, real, "", false).confirmCount).toBeUndefined();
    expect(answerBody(q, real, "", true)).toEqual({ optionIndex: 0, confirmCount: 5 });
  });
});

describe("meeting notes: personal data warning", () => {
  it("flags emails, phones and person-like names", () => {
    expect(personalDataIn("Llamar a juan.perez@contratista.cl")).toBe("email");
    expect(personalDataIn("Fono +56 9 8765 4321")).toBe("phone");
    expect(personalDataIn("Juan Pérez baja el ducto")).toBe("name");
  });
  it("does not flag disciplines, levels or model words", () => {
    expect(personalDataIn("CLI baja el ducto 100 mm en Nivel 3; EST revisa la Losa Nivel 2 antes del Viernes")).toBeNull();
    expect(personalDataIn("Climatización y Estructura acuerdan pasada tipo")).toBeNull();
  });
});
