/**
 * Software WebAuthn authenticator for tests (ES256, "none" attestation).
 * Produces registration and assertion responses in the JSON shape of
 * @simplewebauthn/browser, so the server verifies them with real crypto.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

export class SoftAuthenticator {
  readonly credId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly publicJwk: { x: string; y: string };
  private counter = 0;

  constructor(
    readonly rpID = "localhost",
    readonly origin = "http://localhost:3000",
  ) {
    const kp = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    this.privateKey = kp.privateKey;
    const jwk = kp.publicKey.export({ format: "jwk" }) as { x: string; y: string };
    this.publicJwk = jwk;
  }

  get id(): string {
    return b64url(this.credId);
  }

  private cosePublicKey(): Uint8Array {
    const m = new Map<number, number | Uint8Array>();
    m.set(1, 2); // kty EC2
    m.set(3, -7); // alg ES256
    m.set(-1, 1); // crv P-256
    m.set(-2, Buffer.from(this.publicJwk.x, "base64url"));
    m.set(-3, Buffer.from(this.publicJwk.y, "base64url"));
    return isoCBOR.encode(m);
  }

  private authData(flags: number, attested?: Uint8Array): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    return Buffer.concat([sha256(this.rpID), Buffer.from([flags]), counter, ...(attested ? [attested] : [])]);
  }

  /** navigator.credentials.create() equivalent. */
  register(options: { challenge: string }, opts: { origin?: string } = {}) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.credId.length);
    const attested = Buffer.concat([Buffer.alloc(16), len, this.credId, this.cosePublicKey()]);
    const authData = this.authData(0x45, attested); // UP | UV | AT
    const att = new Map<string, unknown>();
    att.set("fmt", "none");
    att.set("attStmt", new Map());
    att.set("authData", authData);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: opts.origin ?? this.origin, crossOrigin: false }));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(isoCBOR.encode(att as never)), transports: ["internal"] },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** navigator.credentials.get() equivalent. `userVerified: false` simulates a presence-only tap. */
  assert(options: { challenge: string }, opts: { origin?: string; userVerified?: boolean } = {}) {
    this.counter++;
    const authData = this.authData(opts.userVerified === false ? 0x01 : 0x05);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: opts.origin ?? this.origin, crossOrigin: false }));
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      response: { authenticatorData: b64url(authData), clientDataJSON: b64url(clientDataJSON), signature: b64url(signature) },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
