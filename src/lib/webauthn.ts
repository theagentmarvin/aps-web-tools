/**
 * Browser side of the WebAuthn (passkey / Windows Hello) flows in docs/api.md
 * "Browser approval flow":
 *
 *  - approveWithPasskey: approve-options → startAuthentication → approve
 *    (the same excludedItemIds in both calls; a fresh nonce per attempt).
 *  - enrollPasskey: register-options → (step-up assertion) → startRegistration
 *    → register.
 *
 * Errors are normalised to PasskeyError with a `kind` the UI translates to
 * Spanish (cancelled, timeout, no passkey enrolled, wrong host…).
 * The WebAuthn functions are injectable so the flow is unit-testable.
 */
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { ApiError, type CoordinatorApi } from "./api/coordinator-api";
import type { ApplyStatus } from "./api/types";

export type PasskeyErrorKind =
  | "not_supported" // browser without WebAuthn
  | "wrong_host" // opened on an IP (127.0.0.1): the RP ID is "localhost"
  | "cancelled" // user closed the Windows Hello dialog
  | "timeout" // the ceremony expired
  | "no_passkey" // server has no passkey enrolled
  | "already_registered" // this authenticator is already enrolled
  | "challenge_expired" // nonce used/expired or batch changed: ask for new options
  | "rejected" // server refused the assertion / code
  | "unknown";

export class PasskeyError extends Error {
  constructor(
    readonly kind: PasskeyErrorKind,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PasskeyError";
  }
}

export interface WebAuthnDeps {
  startAuthentication: typeof startAuthentication;
  startRegistration: typeof startRegistration;
  supported: () => boolean;
  hostname: () => string;
  origin: () => string;
  now: () => number;
}

/** location without depending on DOM lib types (this module is also type-checked by the server config via tests). */
const loc = () => (globalThis as unknown as { location?: { hostname: string; origin: string } }).location;

export const defaultDeps: WebAuthnDeps = {
  startAuthentication,
  startRegistration,
  supported: browserSupportsWebAuthn,
  hostname: () => loc()?.hostname ?? "localhost",
  origin: () => loc()?.origin ?? "",
  now: () => Date.now(),
};

/** Browsers reject IP addresses as RP ID: the app must be opened as http://localhost. */
export function isIpHost(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":") || hostname === "[::1]";
}

function precheck(deps: WebAuthnDeps) {
  if (isIpHost(deps.hostname())) throw new PasskeyError("wrong_host", "Abre la aplicación como http://localhost (no 127.0.0.1).");
  if (!deps.supported()) throw new PasskeyError("not_supported", "Este navegador no soporta passkeys (WebAuthn).");
}

/** Map a browser/ceremony error to a PasskeyError. NotAllowedError covers both cancel and timeout. */
export function classifyCeremonyError(err: unknown, startedAt: number, timeoutMs: number | undefined, deps: WebAuthnDeps): PasskeyError {
  if (err instanceof PasskeyError) return err;
  const e = err as { name?: string; code?: string; message?: string; cause?: { name?: string } };
  const name = e?.cause?.name ?? e?.name;
  const msg = e?.message ?? String(err);
  if (e?.code === "ERROR_INVALID_RP_ID" || e?.code === "ERROR_INVALID_DOMAIN" || name === "SecurityError")
    return new PasskeyError("wrong_host", msg, err);
  if (e?.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || name === "InvalidStateError") return new PasskeyError("already_registered", msg, err);
  if (e?.code === "ERROR_CEREMONY_ABORTED" || name === "AbortError") return new PasskeyError("cancelled", msg, err);
  if (name === "NotAllowedError") {
    const elapsed = deps.now() - startedAt;
    const limit = timeoutMs ?? 60000;
    return new PasskeyError(elapsed >= limit - 1000 ? "timeout" : "cancelled", msg, err);
  }
  if (/not supported/i.test(msg)) return new PasskeyError("not_supported", msg, err);
  return new PasskeyError("unknown", msg, err);
}

/** Map a server error (ApiError) to a PasskeyError where it is passkey-specific. */
export function classifyServerError(err: unknown): unknown {
  if (!(err instanceof ApiError)) return err;
  if (err.serverCode === "approval_missing") return new PasskeyError("no_passkey", err.message, err);
  if (err.serverCode === "approval_invalid" && /desaf[ií]o|cambi[óo]/i.test(err.message)) return new PasskeyError("challenge_expired", err.message, err);
  if (err.serverCode === "approval_invalid" || (err.code === "forbidden" && !/csrf|origen/i.test(err.message))) return new PasskeyError("rejected", err.message, err);
  return err;
}

async function ceremony<T>(timeoutMs: number | undefined, deps: WebAuthnDeps, run: () => Promise<T>): Promise<T> {
  const started = deps.now();
  try {
    return await run();
  } catch (err) {
    throw classifyCeremonyError(err, started, timeoutMs, deps);
  }
}

export interface ApproveInput {
  batchId: string;
  confirmWord: string;
  excludedItemIds: string[];
  note?: string;
}

/** Live approval: steps 2–4 of docs/api.md. Never applies. */
export async function approveWithPasskey(api: CoordinatorApi, input: ApproveInput, deps: WebAuthnDeps = defaultDeps): Promise<ApplyStatus> {
  precheck(deps);
  let opts;
  try {
    opts = await api.getApproveOptions(input.batchId, input.excludedItemIds);
  } catch (err) {
    throw classifyServerError(err);
  }
  const optionsJSON = opts.options as unknown as PublicKeyCredentialRequestOptionsJSON;
  const assertion = await ceremony(optionsJSON.timeout, deps, () => deps.startAuthentication({ optionsJSON }));
  try {
    return await api.approveBatch(input.batchId, {
      confirmWord: input.confirmWord,
      excludedItemIds: input.excludedItemIds,
      ...(input.note ? { note: input.note } : {}),
      webauthn: { nonce: opts.nonce, origin: deps.origin(), response: assertion as never },
    });
  } catch (err) {
    throw classifyServerError(err);
  }
}

export interface EnrollInput {
  label: string;
  /** First passkey: the one-time code from `npm run coordinator -- passkey-enroll`. */
  enrollCode?: string;
}

/** Ask the server which enrolment path applies ("enroll_code" for the first passkey, "step_up" for more). */
export async function registrationRequirement(api: CoordinatorApi): Promise<"enroll_code" | "step_up"> {
  try {
    return (await api.getRegisterOptions()).requires;
  } catch (err) {
    throw classifyServerError(err);
  }
}

/** Enrol a passkey (Windows Hello). Options are fetched fresh, so they never expire while the user types. */
export async function enrollPasskey(api: CoordinatorApi, input: EnrollInput, deps: WebAuthnDeps = defaultDeps) {
  precheck(deps);
  let r;
  try {
    r = await api.getRegisterOptions();
  } catch (err) {
    throw classifyServerError(err);
  }
  if (r.requires === "enroll_code" && !input.enrollCode?.trim()) throw new PasskeyError("rejected", "Falta el código de enrolamiento.");
  let stepUp;
  if (r.requires === "step_up" && r.stepUp) {
    const stepJSON = r.stepUp as unknown as PublicKeyCredentialRequestOptionsJSON;
    stepUp = await ceremony(stepJSON.timeout, deps, () => deps.startAuthentication({ optionsJSON: stepJSON }));
  }
  const regJSON = r.registration as unknown as PublicKeyCredentialCreationOptionsJSON;
  const response = await ceremony(regJSON.timeout, deps, () => deps.startRegistration({ optionsJSON: regJSON }));
  try {
    return await api.registerPasskey({
      response: response as never,
      label: input.label,
      ...(r.requires === "enroll_code" ? { enrollCode: input.enrollCode!.trim() } : {}),
      ...(stepUp ? { stepUp: stepUp as never } : {}),
    });
  } catch (err) {
    throw classifyServerError(err);
  }
}

/**
 * Agent harness update: install-options → startAuthentication → install.
 * The challenge is bound to the exact .claude/ files the server will write.
 */
export async function installHarnessWithPasskey(api: CoordinatorApi, deps: WebAuthnDeps = defaultDeps) {
  precheck(deps);
  let opts;
  try {
    opts = await api.getHarnessInstallOptions();
  } catch (err) {
    throw classifyServerError(err);
  }
  const optionsJSON = opts.options as unknown as PublicKeyCredentialRequestOptionsJSON;
  const assertion = await ceremony(optionsJSON.timeout, deps, () => deps.startAuthentication({ optionsJSON }));
  try {
    return await api.installHarness({ webauthn: { nonce: opts.nonce, origin: deps.origin(), response: assertion } });
  } catch (err) {
    throw classifyServerError(err);
  }
}

/**
 * G15 Publicar / Revertir a rule suggestion: publish-options → startAuthentication → publish|revert.
 * The challenge is bound to the exact rule files the server will write.
 */
export async function publishRuleWithPasskey(api: CoordinatorApi, id: string, op: "publish" | "revert", deps: WebAuthnDeps = defaultDeps) {
  precheck(deps);
  let opts;
  try {
    opts = await api.getRulePublishOptions(id, op);
  } catch (err) {
    throw classifyServerError(err);
  }
  const optionsJSON = opts.options as unknown as PublicKeyCredentialRequestOptionsJSON;
  const assertion = await ceremony(optionsJSON.timeout, deps, () => deps.startAuthentication({ optionsJSON }));
  try {
    return await api.publishRuleSuggestion(id, op, { webauthn: { nonce: opts.nonce, origin: deps.origin(), response: assertion } });
  } catch (err) {
    throw classifyServerError(err);
  }
}
