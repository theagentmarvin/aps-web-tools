/**
 * Level-2 problem-type catalogue (docs/domain/solution-families-proposal.md §3).
 * The server sends `problemTypes` with the triage payload; this is the
 * fallback and the source the mock uses. Spanish names are the UI names.
 */
import type { FamilyAction, ProblemTypeCode, ProblemTypeInfo, Validity } from "~/lib/api/types";

/** Mirror of core/families PROBLEM_TYPES (kept in sync by hand; the server sends `problemTypes` anyway). */
export const PROBLEM_TYPES: ProblemTypeInfo[] = [
  { code: "PT01", nameEs: "Pasada de instalación en viga", responsibility: "instalación → EST", options: ["Desviar bajo la viga", "Pasada en el tercio central, Ø ≤ h/3, sujeta al calculista", "Dividir o aplanar el ducto"] },
  { code: "PT02", nameEs: "Instalación invade franja de viga (altura insuficiente)", responsibility: "instalación → ARQ (cielo), EST", options: ["Bajar penetración + 25 mm verificando altura de cielo", "Aplanar el ducto (misma área)", "Pasada típica si Ø ≤ h/3"] },
  { code: "PT03", nameEs: "Instalación atraviesa pilar", responsibility: "instalación → EST", options: ["Desviar (obligatorio: los pilares no admiten pasadas)"] },
  { code: "PT04", nameEs: "Montante cruza losa sin pasada", responsibility: "EST → instalación", options: ["EST modela la pasada según el listado de la especialidad", "Sello cortafuego", "Losa postensada: coordinar con los cables antes de hormigonar"] },
  { code: "PT05", nameEs: "Tramo horizontal o en pendiente embebido en losa", responsibility: "instalación → EST", options: ["Bajar al entretecho (corregir nivel/pendiente)", "Gravitacional sin pendiente disponible: rebaje de losa o shaft (calculista)"] },
  { code: "PT06", nameEs: "Instalación atraviesa muro estructural o cortafuego", responsibility: "instalación → EST / ARQ", options: ["Pasada aprobada por el calculista y modelada por EST", "Sello cortafuego certificado", "Desviar"] },
  { code: "PT07", nameEs: "Red enterrada o pasada en fundación", responsibility: "instalación → EST", options: ["Verificar cotas de la red enterrada (bajo sello de fundación)", "Camisa en viga de fundación (decidir antes de excavar)"] },
  { code: "PT08", nameEs: "Cruce entre redes de instalaciones", responsibility: "la de menor jerarquía se mueve", options: ["Mover la red de menor jerarquía", "Gas vs eléctrico: separación normativa", "Gravitacional vs gravitacional: estudio conjunto de cotas (COORD)"] },
  { code: "PT09", nameEs: "Red contra equipo o artefacto", responsibility: "red → dueño del equipo", options: ["Si es la conexión propia de la red: falso positivo (regla nueva)", "Desviar la red", "Reubicar el equipo (layout)"] },
  { code: "PT10", nameEs: "Holgura insuficiente (mantención, aislación, cielo, rociadores)", responsibility: "instalación → ARQ / INC", options: ["Mover para recuperar la holgura", "Ajustar la zona de acceso", "Bajar el cielo (decisión ARQ)"] },
  { code: "PT11", nameEs: "Arquitectura, vanos y zonas restringidas", responsibility: "ARQ o instalación → EST", options: ["Ajustar vano, muro o elemento", "Desviar fuera de escalera, shaft o junta sísmica (junta flexible si debe cruzar)"] },
  { code: "PT12", nameEs: "Modelos superpuestos o duplicados", responsibility: "COORD / dueño del archivo", options: ["Limpiar el conjunto de modelos (una vista por archivo, quitar copias ajenas o antiguas)", "Una incidencia de higiene por par de archivos"] },
  { code: "PT13", nameEs: "Higiene / información faltante", responsibility: "COORD / dueño del archivo", options: ["Excluir del test", "Pedir LOD / categoría"] },
  { code: "PT14", nameEs: "No es problema (falso positivo / tolerado)", responsibility: "—", options: ["Cerrar o marcar revisado con el motivo", "Ajustar el test para que no vuelva"] },
  { code: "PT00", nameEs: "Sin tipificar", responsibility: "COORD", options: ["Revisión humana; el resultado alimenta al curador de reglas"] },
];

export function problemTypeOf(list: ProblemTypeInfo[] | undefined, code: ProblemTypeCode | undefined): ProblemTypeInfo | undefined {
  if (!code) return undefined;
  return (list?.length ? list : PROBLEM_TYPES).find((p) => p.code === code) ?? PROBLEM_TYPES.find((p) => p.code === code);
}

export const FAMILY_ACTIONS: FamilyAction[] = ["create_issue", "close", "mark_reviewed", "hygiene_issue", "escalate"];

/** Default family action per validity (mirrors defaultActionFor for groups). */
export function familyActionFor(v: Validity): FamilyAction {
  return v === "real" ? "create_issue" : v === "false_positive" ? "close" : v === "tolerated" ? "mark_reviewed" : "escalate";
}

/** True when the action would close or mark reviewed (never allowed on real instances through a family). */
export function isClosingAction(a: FamilyAction): boolean {
  return a === "close" || a === "mark_reviewed";
}
