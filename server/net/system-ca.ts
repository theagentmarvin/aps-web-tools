/**
 * Trust the operating system's certificate store in addition to Node's bundled CAs.
 *
 * Why: corporate networks (e.g. SalfaCorp) inspect HTTPS and re-sign traffic with a
 * company root CA that IT installs in the Windows store. Browsers trust it; Node does
 * not, so downloads of ACC clash results from Amazon S3 fail with
 * SELF_SIGNED_CERT_IN_CHAIN. This keeps TLS verification ON — it only adds the
 * system's trusted roots. Never "fix" this with NODE_TLS_REJECT_UNAUTHORIZED=0.
 *
 * Import for side effects as the FIRST import of every Node entry point.
 * Opt out with COORD_SYSTEM_CA=0. Requires Node >= 22.19 / 24.5 (tls.setDefaultCACertificates);
 * on older Node it logs a hint to run with `--use-system-ca`.
 */
import tls from "node:tls";

type TlsWithCa = typeof tls & {
  getCACertificates?: (type: "default" | "system" | "bundled" | "extra") => string[];
  setDefaultCACertificates?: (certs: string[]) => void;
};

let applied: { system: number; total: number } | null = null;

export function trustSystemCertificates(): { system: number; total: number } | null {
  if (applied) return applied;
  if (process.env.COORD_SYSTEM_CA === "0") return null;
  const t = tls as TlsWithCa;
  if (typeof t.getCACertificates !== "function" || typeof t.setDefaultCACertificates !== "function") {
    process.stderr.write("[coord] Node sin tls.setDefaultCACertificates: si la red corporativa inspecciona HTTPS, ejecuta con NODE_OPTIONS=--use-system-ca\n");
    return null;
  }
  try {
    const system = t.getCACertificates("system");
    const merged = [...new Set([...t.getCACertificates("default"), ...system])];
    t.setDefaultCACertificates(merged);
    applied = { system: system.length, total: merged.length };
  } catch (e) {
    process.stderr.write(`[coord] No se pudo cargar el almacén de certificados del sistema: ${(e as Error).message}\n`);
  }
  return applied;
}

trustSystemCertificates();
