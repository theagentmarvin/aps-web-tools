/**
 * HMAC-SHA256 signing of human approval records. The key is generated on
 * first use into `.coordinator/secret/approval.key` (mode 0600 best effort)
 * and is never returned by any MCP tool or HTTP endpoint.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson } from "../util";
import type { ApprovalRecord } from "../store/types";

export function approvalKeyPath(home: string): string {
  return join(home, "secret", "approval.key");
}

/** Read the key, creating it atomically (O_EXCL) when missing. */
export async function loadOrCreateApprovalKey(home: string): Promise<Buffer> {
  const path = approvalKeyPath(home);
  try {
    return Buffer.from((await readFile(path, "utf8")).trim(), "hex");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await mkdir(dirname(path), { recursive: true });
  const key = randomBytes(32);
  try {
    const fh = await open(path, "wx", 0o600);
    await fh.writeFile(key.toString("hex"));
    await fh.close();
    await chmod(path, 0o600).catch(() => undefined);
    return key;
  } catch (err) {
    // Another process created it first.
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return Buffer.from((await readFile(path, "utf8")).trim(), "hex");
    throw err;
  }
}

/** Read-only variant: never creates a key (used by verify-only paths). */
export async function readApprovalKey(home: string): Promise<Buffer | undefined> {
  try {
    return Buffer.from((await readFile(approvalKeyPath(home), "utf8")).trim(), "hex");
  } catch {
    return undefined;
  }
}

export function signingPayload(rec: Omit<ApprovalRecord, "hmac">): string {
  return canonicalJson({ ...rec, v: 1 });
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
