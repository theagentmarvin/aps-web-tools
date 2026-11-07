/**
 * Untrusted-text handling (docs/ai/harness-design.md §8.2) and validation of
 * agent-written text (§8.2 control 3).
 *
 * Model-derived strings (element names, family/type names, comments, file
 * names…) are sanitised: control / zero-width / bidi characters stripped,
 * whitespace collapsed, truncated to 120 chars, and flagged when they look
 * like instructions or contain URLs. Tools return them only inside
 * `{untrusted, flagged?}` objects.
 */

export type UntrustedFlag = "instruction_like" | "url" | "truncated";
export interface Untrusted {
  untrusted: string;
  flagged?: UntrustedFlag;
}

export const UNTRUSTED_MAX = 120;

// C0/C1 controls, zero-width, bidi overrides/isolates, BOM.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g;

const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|cl|ai|dev|app|co|xyz|ru|cn)(?:\/\S*)?\b/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const MENTION_RE = /(^|[\s(,;:])@[A-Za-z0-9_.-]{2,}/;
const INSTRUCTION_RE =
  /\b(ignora|ignore|ignorar|instrucci[oó]n(es)?|instructions?|aplica|apply|approve|aprueba|system|assistant|prompt|olvida|forget|disregard|execute|ejecuta|override)\b|<\/?[a-z]+[^>]*>|\{\{|\}\}/i;

/** Strip control chars and collapse whitespace (no truncation). */
export function cleanText(s: string): string {
  return s.replace(CONTROL, "").replace(/\s+/g, " ").trim();
}

/** Sanitise model text to a plain string (truncated). */
export function sanitizeModelText(v: unknown, max = UNTRUSTED_MAX): string {
  if (v === null || v === undefined) return "";
  const s = cleanText(String(v));
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function looksLikeInstruction(s: string): boolean {
  return INSTRUCTION_RE.test(s);
}

/** Wrap model text as {@link Untrusted}. */
export function untrusted(v: unknown): Untrusted {
  const raw = v === null || v === undefined ? "" : cleanText(String(v));
  const truncated = raw.length > UNTRUSTED_MAX;
  const text = truncated ? raw.slice(0, UNTRUSTED_MAX - 1) + "…" : raw;
  const flagged: UntrustedFlag | undefined = looksLikeInstruction(raw) ? "instruction_like" : URL_RE.test(raw) ? "url" : truncated ? "truncated" : undefined;
  return flagged ? { untrusted: text, flagged } : { untrusted: text };
}

export interface TextCheckOptions {
  /** Hostnames allowed in URLs (e.g. acc.autodesk.com). */
  urlAllowlist?: readonly string[];
}

/**
 * Validate free text written by the agent (rationale, issue title/description,
 * notes). Returns Spanish problems; empty = OK. No URLs (outside the
 * allowlist), no emails, no @mentions, no control characters.
 */
export function checkAgentText(field: string, text: string, opts: TextCheckOptions = {}): string[] {
  const problems: string[] = [];
  if (CONTROL.test(text)) problems.push(`${field}: contiene caracteres de control`);
  CONTROL.lastIndex = 0;
  if (EMAIL_RE.test(text)) problems.push(`${field}: no incluyas correos electrónicos`);
  else if (MENTION_RE.test(text)) problems.push(`${field}: no incluyas menciones @`);
  const urls = text.match(new RegExp(URL_RE.source, "gi")) ?? [];
  for (const u of urls) {
    const host = u.replace(/^https?:\/\//i, "").split(/[/?#]/)[0].toLowerCase();
    const allowed = (opts.urlAllowlist ?? []).some((a) => host === a || host.endsWith(`.${a}`));
    if (!allowed) {
      problems.push(`${field}: URL no permitida (${host})`);
      break;
    }
  }
  return problems;
}

/** Ids of the forms G-…, C-…, E-…, P-… referenced in a text. */
export function referencedIds(text: string): { groups: string[]; clashes: string[]; elements: string[]; proposals: string[] } {
  const uniq = (re: RegExp) => [...new Set(text.match(re) ?? [])];
  return {
    groups: uniq(/\bG-[0-9a-z]{4,12}\b/g),
    clashes: uniq(/\bC-\d+\b/g),
    elements: uniq(/\bE-\d+:\d+\b/g),
    proposals: uniq(/\bP-\d{8}-\d{4}\b/g),
  };
}
