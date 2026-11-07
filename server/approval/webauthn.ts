/**
 * WebAuthn proof of human presence for batch approvals (live mode).
 *
 * - The approval challenge is DERIVED, not random:
 *     challenge = sha256(`${payloadHash}|${batchId}|${testVersion}|${nonce}`)
 *   where `nonce` is server-random, single use and valid for {@link CHALLENGE_TTL_MS}.
 *   The authenticator therefore signs the exact batch content.
 * - userVerification is REQUIRED (Windows Hello / platform passkey PIN or biometrics).
 * - The verified assertion is stored in the approval record; verifyBatchApproval
 *   re-verifies the signature against the stored public key and the challenge
 *   derived from the CURRENT payload hash, so editing the batch or forging a
 *   record needs a fresh user-verified signature over that exact payload.
 * - Credentials live in the secure (out-of-repo) directory, MAC'd with the
 *   approval key. Registering a credential needs an assertion from an existing
 *   credential, or, for the very first one, a one-time code printed by the
 *   interactive CLI (`npm run coordinator -- passkey-enroll`).
 *
 * Out of scope (v1 threat model): a malicious process running as the same OS
 * user can read DPAPI-protected keys and rewrite the credential list. The
 * defences target model error and prompt injection; see docs/api.md.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { writeFileAtomic } from "../store/fs";
import { canonicalJson, CoordError } from "../util";

export const CHALLENGE_TTL_MS = 2 * 60_000;
export const REGISTRATION_TTL_MS = 5 * 60_000;
export const ENROLL_CODE_TTL_MS = 10 * 60_000;

export interface StoredCredential {
  id: string;
  /** base64url of the COSE public key. */
  publicKey: string;
  counter: number;
  transports?: string[];
  label: string;
  createdAt: string;
  enrolledVia: "enroll-code" | "step-up";
}

/** What an approval record keeps to allow re-verification. */
export interface StoredAssertion {
  credentialId: string;
  nonce: string;
  origin: string;
  rpID: string;
  response: AuthenticationResponseJSON;
}

export interface WebAuthnSettings {
  rpID: string;
  rpName: string;
  /** Exact origins accepted (e.g. http://localhost:3000). */
  origins: string[];
}

const b64url = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");

/** Challenge bytes for an approval. */
export function approvalChallenge(payloadHash: string, batchId: string, testVersion: number, nonce: string): Uint8Array {
  return createHash("sha256").update(`${payloadHash}|${batchId}|${testVersion}|${nonce}`).digest();
}

interface CredFile {
  credentials: StoredCredential[];
  mac: string;
}

interface PendingApproval {
  batchId: string;
  payloadHash: string;
  testVersion: number;
  expiresAt: number;
}

export class WebAuthnService {
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingRegistrations = new Map<string, number>();
  private readonly pendingStepUps = new Map<string, number>();

  constructor(
    readonly dir: string,
    private readonly key: () => Promise<Buffer>,
    readonly settings: WebAuthnSettings,
    private readonly now: () => number = Date.now,
  ) {}

  private get credFile(): string {
    return join(this.dir, "webauthn-credentials.json");
  }

  private async mac(creds: StoredCredential[]): Promise<string> {
    return createHmac("sha256", await this.key()).update(canonicalJson({ credentials: creds, v: 1 })).digest("hex");
  }

  async listCredentials(): Promise<StoredCredential[]> {
    let text: string;
    try {
      text = await readFile(this.credFile, "utf8");
    } catch {
      return [];
    }
    const f = JSON.parse(text) as CredFile;
    const expected = Buffer.from(await this.mac(f.credentials), "hex");
    const got = Buffer.from(String(f.mac ?? ""), "hex");
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
      throw new CoordError("approval_invalid", "El registro de credenciales WebAuthn fue alterado.");
    }
    return f.credentials;
  }

  private async saveCredentials(creds: StoredCredential[]): Promise<void> {
    await writeFileAtomic(this.credFile, JSON.stringify({ credentials: creds, mac: await this.mac(creds) } satisfies CredFile, null, 2));
  }

  private checkOrigin(origin: string): void {
    if (!this.settings.origins.includes(origin)) throw new CoordError("forbidden", `Origen WebAuthn no permitido: ${origin}`);
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.pendingApprovals) if (v.expiresAt < t) this.pendingApprovals.delete(k);
    for (const m of [this.pendingRegistrations, this.pendingStepUps]) for (const [k, v] of m) if (v < t) m.delete(k);
  }

  // ── approval ──────────────────────────────────────────────────────────────

  async approvalOptions(batchId: string, payloadHash: string, testVersion: number): Promise<{ nonce: string; options: PublicKeyCredentialRequestOptionsJSON }> {
    const creds = await this.listCredentials();
    if (!creds.length) throw new CoordError("approval_missing", "No hay passkeys registradas.", "Ejecuta `npm run coordinator -- passkey-enroll` en tu terminal y registra la passkey en la UI.");
    this.sweep();
    const nonce = randomBytes(16).toString("hex");
    this.pendingApprovals.set(nonce, { batchId, payloadHash, testVersion, expiresAt: this.now() + CHALLENGE_TTL_MS });
    const options = await generateAuthenticationOptions({
      rpID: this.settings.rpID,
      challenge: approvalChallenge(payloadHash, batchId, testVersion, nonce),
      userVerification: "required",
      timeout: CHALLENGE_TTL_MS,
      allowCredentials: creds.map((c) => ({ id: c.id, ...(c.transports ? { transports: c.transports } : {}) })),
    });
    return { nonce, options };
  }

  /** Verify a fresh assertion for an approval: single-use nonce, UV required, counter updated. */
  async verifyApproval(input: { batchId: string; payloadHash: string; testVersion: number; nonce: string; origin: string; response: AuthenticationResponseJSON }): Promise<StoredAssertion> {
    this.checkOrigin(input.origin);
    this.sweep();
    const pending = this.pendingApprovals.get(input.nonce);
    this.pendingApprovals.delete(input.nonce); // single use, even on failure
    if (!pending) throw new CoordError("approval_invalid", "Desafío WebAuthn inexistente, usado o vencido. Pide opciones nuevas.");
    if (pending.batchId !== input.batchId || pending.payloadHash !== input.payloadHash || pending.testVersion !== input.testVersion) {
      throw new CoordError("approval_invalid", "El lote cambió desde que se emitió el desafío WebAuthn. Pide opciones nuevas.");
    }
    const creds = await this.listCredentials();
    const cred = creds.find((c) => c.id === input.response.id);
    if (!cred) throw new CoordError("approval_invalid", "Passkey no registrada.");
    const expectedChallenge = b64url(approvalChallenge(input.payloadHash, input.batchId, input.testVersion, input.nonce));
    let verified;
    try {
      verified = await verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge,
        expectedOrigin: input.origin,
        expectedRPID: this.settings.rpID,
        credential: { id: cred.id, publicKey: Buffer.from(cred.publicKey, "base64url"), counter: cred.counter, ...(cred.transports ? { transports: cred.transports } : {}) },
        requireUserVerification: true,
      });
    } catch (err) {
      throw new CoordError("approval_invalid", `Firma WebAuthn inválida: ${(err as Error).message}`);
    }
    if (!verified.verified || !verified.authenticationInfo.userVerified) throw new CoordError("approval_invalid", "La passkey no verificó al usuario (PIN/biometría).");
    cred.counter = verified.authenticationInfo.newCounter;
    await this.saveCredentials(creds);
    return { credentialId: cred.id, nonce: input.nonce, origin: input.origin, rpID: this.settings.rpID, response: input.response };
  }

  /**
   * Re-verify a stored assertion against the CURRENT payload hash (no counter
   * check: the signature was already accepted once; replays are prevented by
   * the single-use nonce at approval time).
   */
  async reverify(a: StoredAssertion, payloadHash: string, batchId: string, testVersion: number): Promise<boolean> {
    try {
      const cred = (await this.listCredentials()).find((c) => c.id === a.credentialId);
      if (!cred || a.response.id !== a.credentialId) return false;
      const r = await verifyAuthenticationResponse({
        response: a.response,
        expectedChallenge: b64url(approvalChallenge(payloadHash, batchId, testVersion, a.nonce)),
        expectedOrigin: a.origin,
        expectedRPID: a.rpID,
        credential: { id: cred.id, publicKey: Buffer.from(cred.publicKey, "base64url"), counter: 0 },
        requireUserVerification: true,
      });
      return r.verified && r.authenticationInfo.userVerified;
    } catch {
      return false;
    }
  }

  // ── enrolment ─────────────────────────────────────────────────────────────

  private get enrollFile(): string {
    return join(this.dir, "webauthn-enroll.json");
  }

  /** CLI only (interactive TTY): one-time code for the FIRST passkey. */
  async createEnrollCode(): Promise<{ code: string; expiresAt: string }> {
    if ((await this.listCredentials()).length) throw new CoordError("forbidden", "Ya hay passkeys: agrega nuevas desde la UI con una passkey existente.");
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const code = Array.from({ length: 10 }, () => alphabet[randomInt(alphabet.length)]).join("");
    const expiresAt = new Date(this.now() + ENROLL_CODE_TTL_MS).toISOString();
    const key = await this.key();
    await writeFileAtomic(this.enrollFile, JSON.stringify({ codeMac: createHmac("sha256", key).update(`enroll|${code}`).digest("hex"), expiresAt }));
    return { code, expiresAt };
  }

  private async consumeEnrollCode(code: string): Promise<boolean> {
    let f: { codeMac: string; expiresAt: string };
    try {
      f = JSON.parse(await readFile(this.enrollFile, "utf8"));
    } catch {
      return false;
    }
    await writeFileAtomic(this.enrollFile, JSON.stringify({ used: true })); // single use
    if (!f.codeMac || Date.parse(f.expiresAt) < this.now()) return false;
    const mac = Buffer.from(createHmac("sha256", await this.key()).update(`enroll|${code.trim().toUpperCase()}`).digest("hex"), "hex");
    const want = Buffer.from(f.codeMac, "hex");
    return mac.length === want.length && timingSafeEqual(mac, want);
  }

  async registrationOptions(userName: string): Promise<{ registration: PublicKeyCredentialCreationOptionsJSON; stepUp?: PublicKeyCredentialRequestOptionsJSON; requires: "enroll_code" | "step_up" }> {
    const creds = await this.listCredentials();
    this.sweep();
    const registration = await generateRegistrationOptions({
      rpName: this.settings.rpName,
      rpID: this.settings.rpID,
      userName,
      attestationType: "none",
      timeout: REGISTRATION_TTL_MS,
      excludeCredentials: creds.map((c) => ({ id: c.id })),
      authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "preferred", userVerification: "required" },
    });
    this.pendingRegistrations.set(registration.challenge, this.now() + REGISTRATION_TTL_MS);
    if (!creds.length) return { registration, requires: "enroll_code" };
    const stepUp = await generateAuthenticationOptions({
      rpID: this.settings.rpID,
      userVerification: "required",
      timeout: REGISTRATION_TTL_MS,
      allowCredentials: creds.map((c) => ({ id: c.id })),
    });
    this.pendingStepUps.set(stepUp.challenge, this.now() + REGISTRATION_TTL_MS);
    return { registration, stepUp, requires: "step_up" };
  }

  async register(input: { origin: string; response: RegistrationResponseJSON; label?: string; enrollCode?: string; stepUp?: AuthenticationResponseJSON }): Promise<StoredCredential> {
    this.checkOrigin(input.origin);
    this.sweep();
    const creds = await this.listCredentials();
    let via: StoredCredential["enrolledVia"];
    if (!creds.length) {
      if (!input.enrollCode || !(await this.consumeEnrollCode(input.enrollCode))) {
        throw new CoordError("forbidden", "Código de enrolamiento inválido o vencido (npm run coordinator -- passkey-enroll).");
      }
      via = "enroll-code";
    } else {
      if (!input.stepUp) throw new CoordError("forbidden", "Agregar una passkey requiere confirmar con una passkey existente.");
      const cred = creds.find((c) => c.id === input.stepUp!.id);
      if (!cred) throw new CoordError("forbidden", "Passkey de confirmación no registrada.");
      try {
        const r = await verifyAuthenticationResponse({
          response: input.stepUp,
          expectedChallenge: (c) => this.takeChallenge(this.pendingStepUps, c),
          expectedOrigin: input.origin,
          expectedRPID: this.settings.rpID,
          credential: { id: cred.id, publicKey: Buffer.from(cred.publicKey, "base64url"), counter: cred.counter },
          requireUserVerification: true,
        });
        if (!r.verified || !r.authenticationInfo.userVerified) throw new Error("no verificada");
        cred.counter = r.authenticationInfo.newCounter;
      } catch (err) {
        throw new CoordError("forbidden", `Confirmación con passkey existente fallida: ${(err as Error).message}`);
      }
      via = "step-up";
    }
    let reg;
    try {
      reg = await verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: (c) => this.takeChallenge(this.pendingRegistrations, c),
        expectedOrigin: input.origin,
        expectedRPID: this.settings.rpID,
        requireUserVerification: true,
      });
    } catch (err) {
      throw new CoordError("validation_error", `Registro WebAuthn inválido: ${(err as Error).message}`);
    }
    if (!reg.verified) throw new CoordError("validation_error", "Registro WebAuthn no verificado.");
    const c = reg.registrationInfo.credential;
    const stored: StoredCredential = {
      id: c.id,
      publicKey: b64url(c.publicKey),
      counter: c.counter,
      ...(c.transports ? { transports: c.transports } : {}),
      label: (input.label ?? "passkey").slice(0, 60),
      createdAt: new Date(this.now()).toISOString(),
      enrolledVia: via,
    };
    await this.saveCredentials([...creds.filter((x) => x.id !== stored.id), stored]);
    return stored;
  }

  private takeChallenge(map: Map<string, number>, challenge: string): boolean {
    const exp = map.get(challenge);
    map.delete(challenge);
    return exp !== undefined && exp >= this.now();
  }
}
