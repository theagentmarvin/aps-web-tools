/**
 * Pilot-readiness review issue 10: meeting notes must not carry personal data.
 * A non-blocking check: emails, phone numbers and "Nombre Apellido" patterns.
 * Disciplines, companies and model words are not names (small allow-list).
 */
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /(?:\+?\d[\d\s().-]{7,}\d)/;
const NAME = /\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})\b/g;
const NOT_NAMES = new Set(
  [
    "nivel", "losa", "viga", "vigas", "muro", "muros", "ducto", "ductos", "tubería", "tuberías", "entretecho", "edificio", "torre", "piso", "subterráneo",
    "fundación", "pilar", "cielo", "shaft", "eje", "ejes", "zona", "modelo", "versión", "incidencia", "reunión", "coordinación", "estructura", "arquitectura",
    "clima", "climatización", "sanitaria", "sanitarias", "electricidad", "agua", "potable", "gas", "incendio", "red", "húmeda", "seca", "lunes", "martes",
    "miércoles", "jueves", "viernes", "sábado", "domingo", "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre",
    "noviembre", "diciembre", "calculista", "constructora", "contratista", "subcontrato", "mandante", "inspección", "salfacorp",
  ].map((w) => w.toLowerCase()),
);

export type PersonalDataKind = "email" | "phone" | "name";

/** The first kind of personal data the text seems to contain, or null. */
export function personalDataIn(text: string): PersonalDataKind | null {
  if (EMAIL.test(text)) return "email";
  if (PHONE.test(text)) return "phone";
  for (const m of text.matchAll(NAME)) {
    const [, a, b] = m;
    if (!NOT_NAMES.has(a.toLowerCase()) && !NOT_NAMES.has(b.toLowerCase())) return "name";
  }
  return null;
}
