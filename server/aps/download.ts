/**
 * Safe downloads of APS resource files.
 *
 * - SSRF guard (research §8.11): only https URLs on hosts APS/AWS use for
 *   resource files are fetched; every redirect hop is re-validated, and the
 *   APS `Authorization` header is dropped when the origin changes (research §4
 *   "Download with Authorization and follow redirects").
 * - Presigned clash resources: send exactly the `headers` the API returned and
 *   never the APS bearer token (research §3.1 "Download").
 * - gzip: sniff the `1f 8b` magic bytes; gunzip only when present
 *   (research §3.1 "Compression", UNVERIFIED whether HTTP already decoded it).
 * - NDJSON (Index v2 fields/properties) is streamed line by line (research §4).
 */
import { gunzipSync } from "node:zlib";
import { DecompressionStream, TextDecoderStream, ReadableStream } from "node:stream/web";
import { ApsError, errorFromResponse, safePath } from "./errors";
import { fetchWithRetry, type RetryDeps } from "./http";

/**
 * Host suffixes allowed for resource downloads. Presigned clash resources are
 * S3 (`*.amazonaws.com`); Index v2 files are on `developer.api.autodesk.com`
 * and may 303-redirect to Autodesk/AWS storage.
 */
export const DEFAULT_ALLOWED_HOST_SUFFIXES: readonly string[] = [".amazonaws.com", ".autodesk.com"];

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Throw `blocked_url` unless `raw` is an https URL on an allowed host suffix,
 * default port, no credentials, and not an IP literal.
 */
export function assertAllowedResourceUrl(raw: string, allowedSuffixes: readonly string[] = DEFAULT_ALLOWED_HOST_SUFFIXES): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ApsError({ code: "blocked_url", detail: "URL inválida" });
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const reject = (why: string): never => {
    throw new ApsError({ code: "blocked_url", path: `${host}${u.pathname}`, detail: why });
  };
  if (u.protocol !== "https:") reject("only https is allowed");
  if (u.username || u.password) reject("credentials in URL are not allowed");
  if (u.port && u.port !== "443") reject("non-default port");
  if (IPV4.test(host) || host.includes(":") || host.startsWith("[")) reject("IP literals are not allowed");
  const ok = allowedSuffixes.some((s) => {
    const suffix = s.toLowerCase();
    return host.endsWith(suffix) && host.length > suffix.length;
  });
  if (!ok) reject("host not in allowlist");
  return u;
}

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Gunzip when the magic bytes say so, else return the input unchanged. */
export function maybeGunzip(bytes: Uint8Array, maxOutputBytes = 1024 * 1024 * 1024): Uint8Array {
  if (!isGzip(bytes)) return bytes;
  try {
    return gunzipSync(bytes, { maxOutputLength: maxOutputBytes });
  } catch (cause) {
    throw new ApsError({ code: "invalid_response", detail: "gzip inválido o demasiado grande", cause });
  }
}

export function parseJsonBytes<T>(bytes: Uint8Array): T {
  const text = new TextDecoder("utf-8").decode(maybeGunzip(bytes));
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new ApsError({ code: "invalid_response", detail: "JSON inválido en recurso", cause });
  }
}

/** Parse a whole NDJSON text (blank lines ignored). */
export function parseNdjson<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t) out.push(JSON.parse(t) as T);
  }
  return out;
}

export interface DownloadOptions {
  /** Headers to send (the presigned `headers` object, or `Authorization` for APS). */
  headers?: Record<string, string>;
  /** Origin the `Authorization` header may be sent to; dropped on any other origin. */
  authOrigin?: string;
  allowedHostSuffixes?: readonly string[];
  maxRedirects?: number;
  /** Abort when the (compressed) body exceeds this. Default 512 MiB. */
  maxBytes?: number;
}

/** GET with manual, re-validated redirects. Returns the final OK Response. */
export async function safeGet(url: string, deps: RetryDeps, opts: DownloadOptions = {}): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 5); hop++) {
    const u = assertAllowedResourceUrl(current, opts.allowedHostSuffixes);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      if (k.toLowerCase() === "authorization" && u.origin !== opts.authOrigin) continue;
      headers[k] = v;
    }
    const res = await fetchWithRetry(current, { method: "GET", headers, redirect: "manual" }, deps);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!loc) throw new ApsError({ code: "invalid_response", status: res.status, path: safePath(current) });
      current = new URL(loc, current).toString();
      continue;
    }
    if (!res.ok) throw await errorFromResponse(res, "GET", current);
    return res;
  }
  throw new ApsError({ code: "invalid_response", path: safePath(url), detail: "too many redirects" });
}

/** Read a Response body into memory with a size cap. */
export async function readBodyLimited(res: Response, maxBytes = 512 * 1024 * 1024): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new ApsError({ code: "too_large", detail: `content-length ${declared}` });
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ApsError({ code: "too_large", detail: `body > ${maxBytes} bytes` });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Download bytes from a validated URL (no gunzip). */
export async function downloadBytes(url: string, deps: RetryDeps, opts: DownloadOptions = {}): Promise<Uint8Array> {
  const res = await safeGet(url, deps, opts);
  return readBodyLimited(res, opts.maxBytes);
}

/**
 * Stream NDJSON rows from a byte stream, gunzipping when the first bytes are
 * `1f 8b`. Works on any web ReadableStream (fetch body or test fixture).
 */
export async function* iterateNdjsonStream<T>(body: ReadableStream<Uint8Array> | globalThis.ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const first = await reader.read();
  if (first.done) return;
  const head = first.value;
  const replay = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(head);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const decompressed = isGzip(head) ? replay.pipeThrough(new DecompressionStream("gzip")) : replay;
  const text = decompressed.pipeThrough(new TextDecoderStream("utf-8"));
  let buf = "";
  for await (const chunk of text) {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line) as T;
    }
  }
  const rest = buf.trim();
  if (rest) yield JSON.parse(rest) as T;
}
