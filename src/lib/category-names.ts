/**
 * Revit category → short Spanish/English noun (singular, plural), used to
 * write plain-language lines ("8 tuberías CAL atraviesan Viga 12" x 18"").
 * Category names are model data; unknown ones fall back to the raw name.
 */
import type { Lang } from "~/i18n";

type Names = { es: [string, string]; en: [string, string] };

const CATEGORY: Record<string, Names> = {
  Pipes: { es: ["tubería", "tuberías"], en: ["pipe", "pipes"] },
  "Pipe Fittings": { es: ["fitting de tubería", "fittings de tubería"], en: ["pipe fitting", "pipe fittings"] },
  "Pipe Accessories": { es: ["accesorio de tubería", "accesorios de tubería"], en: ["pipe accessory", "pipe accessories"] },
  "Flex Pipes": { es: ["tubería flexible", "tuberías flexibles"], en: ["flex pipe", "flex pipes"] },
  Ducts: { es: ["ducto", "ductos"], en: ["duct", "ducts"] },
  "Duct Fittings": { es: ["fitting de ducto", "fittings de ducto"], en: ["duct fitting", "duct fittings"] },
  "Duct Accessories": { es: ["accesorio de ducto", "accesorios de ducto"], en: ["duct accessory", "duct accessories"] },
  "Flex Ducts": { es: ["ducto flexible", "ductos flexibles"], en: ["flex duct", "flex ducts"] },
  "Air Terminals": { es: ["difusor", "difusores"], en: ["air terminal", "air terminals"] },
  "Cable Trays": { es: ["escalerilla", "escalerillas"], en: ["cable tray", "cable trays"] },
  "Cable Tray Fittings": { es: ["fitting de escalerilla", "fittings de escalerilla"], en: ["cable tray fitting", "cable tray fittings"] },
  Conduits: { es: ["conduit", "conduits"], en: ["conduit", "conduits"] },
  Sprinklers: { es: ["rociador", "rociadores"], en: ["sprinkler", "sprinklers"] },
  "Mechanical Equipment": { es: ["equipo mecánico", "equipos mecánicos"], en: ["mechanical equipment", "mechanical equipment"] },
  "Plumbing Fixtures": { es: ["artefacto sanitario", "artefactos sanitarios"], en: ["plumbing fixture", "plumbing fixtures"] },
  "Electrical Equipment": { es: ["equipo eléctrico", "equipos eléctricos"], en: ["electrical equipment", "electrical equipment"] },
  "Lighting Fixtures": { es: ["luminaria", "luminarias"], en: ["light fixture", "light fixtures"] },
  "Structural Framing": { es: ["viga", "vigas"], en: ["beam", "beams"] },
  "Structural Columns": { es: ["pilar", "pilares"], en: ["column", "columns"] },
  "Structural Foundations": { es: ["fundación", "fundaciones"], en: ["foundation", "foundations"] },
  Floors: { es: ["losa", "losas"], en: ["slab", "slabs"] },
  Walls: { es: ["muro", "muros"], en: ["wall", "walls"] },
  Ceilings: { es: ["cielo", "cielos"], en: ["ceiling", "ceilings"] },
  Roofs: { es: ["techumbre", "techumbres"], en: ["roof", "roofs"] },
  Doors: { es: ["puerta", "puertas"], en: ["door", "doors"] },
  Windows: { es: ["ventana", "ventanas"], en: ["window", "windows"] },
  Stairs: { es: ["escalera", "escaleras"], en: ["stair", "stairs"] },
  Railings: { es: ["baranda", "barandas"], en: ["railing", "railings"] },
  "Generic Models": { es: ["modelo genérico", "modelos genéricos"], en: ["generic model", "generic models"] },
  Mass: { es: ["masa", "masas"], en: ["mass", "masses"] },
  "Specialty Equipment": { es: ["equipo especial", "equipos especiales"], en: ["specialty equipment", "specialty equipment"] },
};

const ELEMENT: Record<Lang, [string, string]> = { es: ["elemento", "elementos"], en: ["element", "elements"] };

/** Singular or plural noun for a category ("tubería" / "tuberías"). */
export function categoryNoun(category: string | undefined, count: number, lang: Lang): string {
  const n = (category && CATEGORY[category]?.[lang]) || null;
  const pair = n ?? (category && category !== "?" ? ([category, category] as [string, string]) : ELEMENT[lang]);
  return count === 1 ? pair[0] : pair[1];
}

/** Capitalised singular, for a single host element ("Losa", "Viga"). */
export function categoryTitle(category: string | undefined, lang: Lang): string {
  const s = categoryNoun(category, 1, lang);
  return s.charAt(0).toUpperCase() + s.slice(1);
}
