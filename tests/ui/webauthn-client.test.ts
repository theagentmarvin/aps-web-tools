/**
 * Browser WebAuthn client flow (src/lib/webauthn.ts) against a mocked
 * `navigator.credentials`, using the real @simplewebauthn/browser functions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type CoordinatorApi } from "../../src/lib/api/coordinator-api";
import { PasskeyError, approveWithPasskey, defaultDeps, enrollPasskey, isIpHost, type WebAuthnDeps } from "../../src/lib/webauthn";

const b64url = (s: string) => Buffer.from(s).toString("base64url");
const buf = (s: string) => new Uint8Array(Buffer.from(s)).buffer;

function fakeAssertion(id = "cred-1") {
  return {
    id,
    rawId: buf(id),
    type: "public-key",
    authenticatorAttachment: "platform",
    response: { authenticatorData: buf("auth-data"), clientDataJSON: buf("client-data"), signature: buf("sig"), userHandle: buf("user") },
    getClientExtensionResults: () => ({}),
  };
}

function fakeAttestation(id = "new-cred") {
  return {
    id,
    rawId: buf(id),
    type: "public-key",
    authenticatorAttachment: "platform",
    response: {
      clientDataJSON: buf("client-data"),
      attestationObject: buf("attestation"),
      getTransports: () => ["internal"],
      getAuthenticatorData: () => buf("auth-data"),
      getPublicKey: () => null,
      getPublicKeyAlgorithm: () => -7,
    },
    getClientExtensionResults: () => ({}),
  };
}

const requestOptions = { challenge: b64url("challenge-123"), timeout: 60000, rpId: "localhost", userVerification: "required", allowCredentials: [{ id: b64url("cred-1"), type: "public-key" }] };
const creationOptions = {
  challenge: b64url("reg-challenge"),
  rp: { id: "localhost", name: "Coordinación BIM" },
  user: { id: b64url("user-1"), name: "coord", displayName: "Coordinadora" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  timeout: 60000,
  authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
};

function fakeApi(over: Partial<CoordinatorApi> = {}) {
  const api = {
    getApproveOptions: vi.fn(async (batchId: string) => ({ batchId, nonce: "nonce-1", payloadHash: "h", testVersion: 42, items: 3, options: requestOptions })),
    approveBatch: vi.fn(async (batchId: string) => ({ batchId, state: "approved", issues: { done: 0, total: 1 }, statuses: { done: 0, total: 2 }, log: [], failures: [] })),
    getRegisterOptions: vi.fn(async () => ({ requires: "enroll_code" as const, registration: creationOptions })),
    registerPasskey: vi.fn(async (r: { label?: string }) => ({ credentialId: "new-cred", label: r.label ?? "", enrolledVia: "enroll-code" as const })),
    ...over,
  };
  return api as unknown as CoordinatorApi & typeof api;
}

let clock = 0;
const deps: WebAuthnDeps = { ...defaultDeps, supported: () => true, hostname: () => "localhost", origin: () => "http://localhost:3000", now: () => clock };
const credentials = { get: vi.fn(), create: vi.fn() };

beforeEach(() => {
  clock = 1_000;
  credentials.get.mockReset();
  credentials.create.mockReset();
  vi.stubGlobal("PublicKeyCredential", class {});
  vi.stubGlobal("location", { hostname: "localhost", origin: "http://localhost:3000" });
  Object.defineProperty(globalThis.navigator, "credentials", { value: credentials, configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("approveWithPasskey", () => {
  it("asks for options, runs the ceremony and approves with the same exclusions", async () => {
    credentials.get.mockResolvedValue(fakeAssertion());
    const api = fakeApi();
    const status = await approveWithPasskey(api, { batchId: "L-1", confirmWord: "APLICAR", excludedItemIds: ["I-9"] }, deps);

    expect(status.state).toBe("approved");
    expect(api.getApproveOptions).toHaveBeenCalledWith("L-1", ["I-9"]);
    const publicKey = credentials.get.mock.calls[0]![0].publicKey;
    expect(Buffer.from(publicKey.challenge).toString()).toBe("challenge-123");
    const body = vi.mocked(api.approveBatch).mock.calls[0]![1]!;
    expect(body.excludedItemIds).toEqual(["I-9"]);
    expect(body.confirmWord).toBe("APLICAR");
    expect(body.webauthn?.nonce).toBe("nonce-1");
    expect(body.webauthn?.origin).toBe("http://localhost:3000");
    expect(body.webauthn?.response.id).toBe("cred-1");
    expect(body.webauthn?.response.response.signature).toBe(b64url("sig"));
    expect(body).not.toHaveProperty("demo");
  });

  it("maps a quick NotAllowedError to cancelled and never approves", async () => {
    credentials.get.mockRejectedValue(new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"));
    const api = fakeApi();
    const err = await approveWithPasskey(api, { batchId: "L-1", confirmWord: "APLICAR", excludedItemIds: [] }, deps).catch((e) => e);
    expect(err).toBeInstanceOf(PasskeyError);
    expect(err.kind).toBe("cancelled");
    expect(api.approveBatch).not.toHaveBeenCalled();
  });

  it("maps a NotAllowedError after the timeout to timeout", async () => {
    credentials.get.mockImplementation(async () => {
      clock += 61_000;
      throw new DOMException("timed out", "NotAllowedError");
    });
    const err = await approveWithPasskey(fakeApi(), { batchId: "L-1", confirmWord: "APLICAR", excludedItemIds: [] }, deps).catch((e) => e);
    expect(err.kind).toBe("timeout");
  });

  it("reports 'no passkey enrolled' from the server", async () => {
    const api = fakeApi({
      getApproveOptions: vi.fn(async () => {
        throw new ApiError("No hay passkeys registradas.", 409, "conflict", "approval_missing");
      }),
    } as Partial<CoordinatorApi>);
    const err = await approveWithPasskey(api, { batchId: "L-1", confirmWord: "APLICAR", excludedItemIds: [] }, deps).catch((e) => e);
    expect(err.kind).toBe("no_passkey");
    expect(credentials.get).not.toHaveBeenCalled();
  });

  it("refuses on an IP host before contacting the server", async () => {
    const api = fakeApi();
    const err = await approveWithPasskey(api, { batchId: "L-1", confirmWord: "APLICAR", excludedItemIds: [] }, { ...deps, hostname: () => "127.0.0.1" }).catch((e) => e);
    expect(err.kind).toBe("wrong_host");
    expect(api.getApproveOptions).not.toHaveBeenCalled();
  });

  it("reports an expired / changed challenge", async () => {
    credentials.get.mockResolvedValue(fakeAssertion());
    const api = fakeApi({
      approveBatch: vi.fn(async () => {
        throw new ApiError("El lote cambió desde que se emitió el desafío WebAuthn. Pide opciones nuevas.", 403, "forbidden", "approval_invalid");
      }),
    } as Partial<CoordinatorApi>);
    const err = await approveWithPasskey(api, { batchId: "L-1", confirmWord: "APLICAR", excludedItemIds: [] }, deps).catch((e) => e);
    expect(err.kind).toBe("challenge_expired");
  });
});

describe("enrollPasskey", () => {
  it("first passkey: sends the enrol code and the registration response", async () => {
    credentials.create.mockResolvedValue(fakeAttestation());
    const api = fakeApi();
    const res = await enrollPasskey(api, { label: "Windows Hello", enrollCode: " ABCDE12345 " }, deps);
    expect(res.credentialId).toBe("new-cred");
    expect(credentials.get).not.toHaveBeenCalled();
    const body = vi.mocked(api.registerPasskey).mock.calls[0]![0]!;
    expect(body.enrollCode).toBe("ABCDE12345");
    expect(body.response.id).toBe("new-cred");
    expect(body).not.toHaveProperty("stepUp");
  });

  it("first passkey without a code is refused locally", async () => {
    const err = await enrollPasskey(fakeApi(), { label: "x" }, deps).catch((e) => e);
    expect(err).toBeInstanceOf(PasskeyError);
    expect(credentials.create).not.toHaveBeenCalled();
  });

  it("more passkeys: step-up assertion first, then registration", async () => {
    credentials.get.mockResolvedValue(fakeAssertion("existing"));
    credentials.create.mockResolvedValue(fakeAttestation());
    const api = fakeApi({
      getRegisterOptions: vi.fn(async () => ({ requires: "step_up" as const, registration: creationOptions, stepUp: requestOptions })),
    } as Partial<CoordinatorApi>);
    await enrollPasskey(api, { label: "Portátil" }, deps);
    expect(credentials.get).toHaveBeenCalledTimes(1);
    expect(credentials.create).toHaveBeenCalledTimes(1);
    const body = vi.mocked(api.registerPasskey).mock.calls[0]![0]!;
    expect(body.stepUp?.id).toBe("existing");
    expect(body).not.toHaveProperty("enrollCode");
  });

  it("maps an already-registered authenticator", async () => {
    credentials.create.mockRejectedValue(new DOMException("already registered", "InvalidStateError"));
    const err = await enrollPasskey(fakeApi(), { label: "x", enrollCode: "ABCDE12345" }, deps).catch((e) => e);
    expect(err.kind).toBe("already_registered");
  });
});

describe("isIpHost", () => {
  it("flags IPs, accepts localhost", () => {
    expect(isIpHost("127.0.0.1")).toBe(true);
    expect(isIpHost("::1")).toBe(true);
    expect(isIpHost("localhost")).toBe(false);
  });
});
