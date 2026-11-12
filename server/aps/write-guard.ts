/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  WRITE GUARD — the only door to ACC writes                               ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  docs/PLAN.md "Write policy": the agent never writes to ACC directly.    ║
 * ║  Every function that changes ACC state (clashes:assign, clashes:close,   ║
 * ║  clashes:reopen, and future issue PATCH/POST) takes an                   ║
 * ║  `ApprovedWriteToken<Op>` argument.                                      ║
 * ║                                                                          ║
 * ║  1. COMPILE TIME: the token type carries a `unique symbol` brand that is ║
 * ║     not exported, so no other module can write an object literal of      ║
 * ║     that type. The ONLY way to obtain one is                             ║
 * ║     `issueApprovedWriteToken()` below.                                   ║
 * ║  2. RUN TIME: issued tokens are remembered in a module-private WeakSet.  ║
 * ║     A forged token (an `as` cast) is rejected. Each token is bound to    ║
 * ║     one operation and to the sha256 of the exact request body, expires  ║
 * ║     after `ttlMs`, and is SINGLE USE.                                    ║
 * ║                                                                          ║
 * ║  WHO MAY CALL `issueApprovedWriteToken`:                                 ║
 * ║  ONLY the approval/apply module (server/store approval path) AFTER it    ║
 * ║  has verified a human approval record (HMAC, payload hash, expiry, test  ║
 * ║  freshness — docs/ai/harness-design.md §2.3 and §4). MCP tools, the      ║
 * ║  HTTP API handlers, scripts and the agent must NEVER import it. Tests    ║
 * ║  may import it to exercise the write clients against a mocked fetch.    ║
 * ║  Code review rule: any new import of this function outside the approval  ║
 * ║  module and tests is a blocking finding.                                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */
import { createHash } from "node:crypto";
import { ApsError } from "./errors";

declare const APPROVED_WRITE_BRAND: unique symbol;

export type WriteOperation = "clash.assign" | "clash.close" | "clash.reopen";

/** Opaque, branded proof that a human approved this exact write. */
export interface ApprovedWriteToken<Op extends WriteOperation = WriteOperation> {
  readonly [APPROVED_WRITE_BRAND]: Op;
  readonly operation: Op;
  /** Local proposal ids this write applies (for the audit log). */
  readonly proposalIds: readonly string[];
  /** Identity that approved (APS user id / name from the approval record). */
  readonly approvedBy: string;
  /** sha256 of the canonical JSON of the exact request body. */
  readonly bodyHash: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

const issued = new WeakSet<object>();
const consumed = new WeakSet<object>();

/** Deterministic JSON (object keys sorted) so the hash does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function hashWriteBody(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

/**
 * THE single constructor of {@link ApprovedWriteToken}. See the header comment:
 * only the approval module may call this, after verifying a human approval.
 */
export function issueApprovedWriteToken<Op extends WriteOperation>(input: {
  operation: Op;
  proposalIds: readonly string[];
  approvedBy: string;
  /** The exact body that will be sent to APS. */
  body: unknown;
  ttlMs?: number;
  now?: number;
}): ApprovedWriteToken<Op> {
  if (input.proposalIds.length === 0) throw new Error("ApprovedWriteToken requires at least one proposal id");
  if (!input.approvedBy) throw new Error("ApprovedWriteToken requires approvedBy");
  const now = input.now ?? Date.now();
  const token = Object.freeze({
    operation: input.operation,
    proposalIds: Object.freeze([...input.proposalIds]),
    approvedBy: input.approvedBy,
    bodyHash: hashWriteBody(input.body),
    issuedAt: now,
    expiresAt: now + (input.ttlMs ?? 10 * 60_000),
  }) as unknown as ApprovedWriteToken<Op>;
  issued.add(token);
  return token;
}

/**
 * Validate and burn a token right before the HTTP write. Throws a Spanish
 * `ApsError` (code `config`) for forged, reused, expired, mismatched tokens.
 */
export function consumeApprovedWriteToken<Op extends WriteOperation>(
  token: ApprovedWriteToken<Op>,
  operation: Op,
  body: unknown,
  now: number = Date.now(),
): void {
  const fail = (why: string): never => {
    throw new ApsError({ code: "config", detail: `Escritura en ACC rechazada: ${why}` });
  };
  if (typeof token !== "object" || token === null || !issued.has(token)) fail("token de aprobación no emitido por el módulo de aprobación");
  if (consumed.has(token)) fail("token de aprobación ya utilizado");
  if (token.operation !== operation) fail(`operación ${operation} no coincide con la aprobada (${token.operation})`);
  if (now > token.expiresAt) fail("token de aprobación expirado");
  if (hashWriteBody(body) !== token.bodyHash) fail("el contenido difiere del aprobado");
  consumed.add(token);
}
