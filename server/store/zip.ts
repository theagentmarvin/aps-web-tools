/**
 * Minimal, dependency-free ZIP (PKZIP 2.0: stored / deflate, UTF-8 names) for
 * backups and export / import of the data home. Uses node:zlib only.
 *
 * Reader safety (import of a file chosen by a human — still untrusted bytes):
 *   - zip-slip: absolute paths, drive letters, "..", "." and empty segments,
 *     backslashes, ':' (alternate data streams), control characters and Windows
 *     reserved names are refused;
 *   - symlinks and encrypted entries are refused;
 *   - zip bombs: per-entry inflate capped at the declared size, total declared size capped,
 *     CRC-32 checked.
 * No ZIP64: more than 65 535 entries or 4 GiB is refused with a clear error.
 */
import { open, type FileHandle } from "node:fs/promises";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { CoordError } from "../util";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f),
  };
}

const MAX_U32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

interface CentralRecord {
  name: Buffer;
  crc: number;
  method: number;
  compSize: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

/** Streaming writer: entries are added one by one; `close()` writes the central directory. */
export class ZipWriter {
  private offset = 0;
  private readonly central: CentralRecord[] = [];
  private constructor(private readonly fh: FileHandle) {}

  static async create(path: string): Promise<ZipWriter> {
    return new ZipWriter(await open(path, "w"));
  }

  private async write(b: Buffer): Promise<void> {
    await this.fh.write(b);
    this.offset += b.length;
  }

  async add(name: string, data: Buffer, mtime: Date = new Date()): Promise<void> {
    if (this.central.length >= MAX_ENTRIES) throw new CoordError("validation_error", "Demasiados archivos para un respaldo ZIP (máx. 65 535).");
    assertSafeEntryName(name);
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    let method = 8;
    let body = deflateRawSync(data, { level: 6 });
    if (body.length >= data.length) {
      method = 0;
      body = data;
    }
    if (data.length >= MAX_U32 || body.length >= MAX_U32 || this.offset >= MAX_U32) throw new CoordError("validation_error", "Respaldo demasiado grande para ZIP sin ZIP64 (4 GiB).");
    const { time, date } = dosDateTime(mtime);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4); // version needed
    h.writeUInt16LE(0x0800, 6); // UTF-8 names
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(body.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(0, 28);
    const offset = this.offset;
    await this.write(h);
    await this.write(nameBuf);
    await this.write(body);
    this.central.push({ name: nameBuf, crc, method, compSize: body.length, size: data.length, offset, time, date });
  }

  async close(): Promise<void> {
    try {
      const start = this.offset;
      for (const c of this.central) {
        const h = Buffer.alloc(46);
        h.writeUInt32LE(0x02014b50, 0);
        h.writeUInt16LE(0x0314, 4); // made by: UNIX, 2.0 (lets us set regular-file mode bits)
        h.writeUInt16LE(20, 6);
        h.writeUInt16LE(0x0800, 8);
        h.writeUInt16LE(c.method, 10);
        h.writeUInt16LE(c.time, 12);
        h.writeUInt16LE(c.date, 14);
        h.writeUInt32LE(c.crc, 16);
        h.writeUInt32LE(c.compSize, 20);
        h.writeUInt32LE(c.size, 24);
        h.writeUInt16LE(c.name.length, 28);
        h.writeUInt16LE(0, 30); // extra
        h.writeUInt16LE(0, 32); // comment
        h.writeUInt16LE(0, 34); // disk
        h.writeUInt16LE(0, 36); // internal attrs
        h.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
        h.writeUInt32LE(c.offset, 42);
        await this.write(h);
        await this.write(c.name);
      }
      const size = this.offset - start;
      if (this.offset >= MAX_U32) throw new CoordError("validation_error", "Respaldo demasiado grande para ZIP sin ZIP64 (4 GiB).");
      const e = Buffer.alloc(22);
      e.writeUInt32LE(0x06054b50, 0);
      e.writeUInt16LE(0, 4);
      e.writeUInt16LE(0, 6);
      e.writeUInt16LE(this.central.length, 8);
      e.writeUInt16LE(this.central.length, 10);
      e.writeUInt32LE(size, 12);
      e.writeUInt32LE(start, 16);
      e.writeUInt16LE(0, 20);
      await this.write(e);
    } finally {
      await this.fh.close();
    }
  }

  /** Close without finishing (error path). */
  async abort(): Promise<void> {
    await this.fh.close().catch(() => undefined);
  }
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Why an entry name is unsafe to extract, or undefined when it is fine. Directory entries end with "/". */
export function unsafeEntryReason(name: string): string | undefined {
  if (!name) return "nombre vacío";
  if (name.length > 400) return "ruta demasiado larga";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "caracteres de control";
  if (name.includes("\\")) return "barra invertida";
  if (name.startsWith("/")) return "ruta absoluta";
  if (/^[A-Za-z]:/.test(name)) return "unidad de disco";
  if (name.includes(":")) return "':' no permitido";
  const segs = name.replace(/\/$/, "").split("/");
  for (const s of segs) {
    if (s === "" || s === "." || s === "..") return "segmento '..', '.' o vacío";
    if (/[ .]$/.test(s)) return "segmento que termina en punto o espacio";
    if (WIN_RESERVED.test(s)) return "nombre reservado de Windows";
    if (/[<>"|?*]/.test(s)) return "carácter no permitido";
  }
  return undefined;
}

export function assertSafeEntryName(name: string): void {
  const why = unsafeEntryReason(name);
  if (why) throw new CoordError("validation_error", `Entrada ZIP insegura (${why}): ${JSON.stringify(name.slice(0, 120))}`);
}

export interface ZipEntry {
  name: string;
  isDir: boolean;
  size: number;
  /** Decompress (CRC-checked, capped at the declared size). */
  read(): Buffer;
}

export interface ReadZipOptions {
  /** Maximum total declared uncompressed size. Default 2 GiB. */
  maxTotalBytes?: number;
  maxEntries?: number;
}

/** Parse a ZIP held in memory. Throws CoordError("validation_error") on anything unsafe or malformed. */
export function readZip(buf: Buffer, opts: ReadZipOptions = {}): ZipEntry[] {
  const bad = (m: string) => new CoordError("validation_error", `ZIP inválido: ${m}`);
  const maxTotal = opts.maxTotalBytes ?? 2 * 1024 ** 3;
  const maxEntries = opts.maxEntries ?? 50_000;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad("sin directorio central");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === MAX_U32) throw bad("ZIP64 no soportado");
  if (count > maxEntries) throw bad(`demasiadas entradas (${count})`);
  if (cdOffset + cdSize > eocd) throw bad("directorio central fuera de rango");
  const out: ZipEntry[] = [];
  const names = new Set<string>();
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad("entrada del directorio central corrupta");
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const ext = buf.readUInt32LE(p + 38);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x0800 ? "utf8" : "latin1");
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x0001) throw bad(`entrada cifrada: ${name.slice(0, 120)}`);
    assertSafeEntryName(name);
    const key = name.toLowerCase();
    if (names.has(key)) throw bad(`entrada duplicada: ${name.slice(0, 120)}`);
    names.add(key);
    if (madeBy === 3 && ((ext >>> 16) & 0o170000) === 0o120000) throw bad(`enlace simbólico: ${name.slice(0, 120)}`);
    const isDir = name.endsWith("/");
    if (method !== 0 && method !== 8) throw bad(`método de compresión no soportado (${method}): ${name.slice(0, 120)}`);
    if (compSize === MAX_U32 || size === MAX_U32) throw bad("ZIP64 no soportado");
    total += size;
    if (total > maxTotal) throw bad("contenido descomprimido demasiado grande");
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw bad(`cabecera local corrupta: ${name.slice(0, 120)}`);
    const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    if (dataStart + compSize > buf.length) throw bad(`datos fuera de rango: ${name.slice(0, 120)}`);
    out.push({
      name,
      isDir,
      size,
      read: () => {
        const raw = buf.subarray(dataStart, dataStart + compSize);
        let data: Buffer;
        try {
          data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
        } catch (e) {
          throw bad(`no se pudo descomprimir ${name.slice(0, 120)}: ${(e as Error).message}`);
        }
        if (data.length !== size) throw bad(`tamaño distinto al declarado: ${name.slice(0, 120)}`);
        if (crc32(data) !== crc) throw bad(`CRC distinto: ${name.slice(0, 120)}`);
        return data;
      },
    });
  }
  return out;
}
