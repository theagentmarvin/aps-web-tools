/**
 * HMAC-SHA256 signing of human approval records. The key lives OUTSIDE the
 * repository in the secure directory (server/secure/keystore.ts), DPAPI
 * protected on Windows, and is never returned by any MCP tool or HTTP endpoint.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { loadOrCreateSecret, readSecret } from "../secure/keystore";
import type { ApprovalRecord } from "../store/types";
import { canonicalJson } from "../util";

export const APPROVAL_KEY_NAME = "approval-key";

/** Read the key, creating it when missing. */
export function loadOrCreateApprovalKey(secureDir: string): Promise<Buffer> {
  return loadOrCreateSecret(secureDir, APPROVAL_KEY_NAME);
}

/** Read-only variant: never creates a key (verify-only paths). */
export function readApprovalKey(secureDir: string): Promise<Buffer | undefined> {
  return readSecret(secureDir, APPROVAL_KEY_NAME).catch(() => undefined);
}

export function signingPayload(rec: Omit<ApprovalRecord, "hmac">): string {
  return canonicalJson({ ...rec, v: 2 });
}

export function signApproval(key: Buffer, rec: Omit<ApprovalRecord, "hmac">): string {
  return createHmac("sha256", key).update(signingPayload(rec)).digest("hex");
}

export function verifyApprovalSignature(key: Buffer, rec: ApprovalRecord): boolean {
  const { hmac, ...rest } = rec;
  if (typeof hmac !== "string" || !/^[0-9a-f]{64}$/.test(hmac)) return false;
  const expected = Buffer.from(signApproval(key, rest), "hex");
  const got = Buffer.from(hmac, "hex");
  return expected.length === got.length && timingSafeEqual(expected, got);
}
