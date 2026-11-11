/**
 * Catalog of domain flows (docs/domain/next-steps-and-flows.md). Each flow runs ONE existing skill
 * procedure (harness-staging/.claude/skills or .claude/skills) with the `coordinador-flujos` agent,
 * headless, like the chat. A flow only produces what the skill produces: proposals, questions,
 * issue drafts, rule suggestions and report files. It never applies, approves, publishes, installs
 * or edits anything (no such tool is in any list below; tests/server/flows.test.ts checks it).
 */
import type { FlowDef, FlowId } from "../api/contract";

const coord = (...names: string[]) => names.map((n) => `mcp__coord__${n}`);

/** Reads every flow may use (context and evidence). */
const BASE = coord("get_session_status", "set_active_context", "get_next_steps", "list_proposals", "list_questions", "summarize_clashes", "list_groups", "get_group", "list_families", "get_family", "get_element_properties");
/** Tools the subagents use (they share the flow's MCP server and permissions). */
const TRIAGER = coord("list_clashes", "propose_family_decision", "propose_classification", "propose_group_action", "propose_status_change", "withdraw_proposal", "ask_coordinator");
const ISSUE_WRITER = coord("draft_issue", "withdraw_proposal");
const CURATOR = coord("get_rule_insights", "list_feedback", "evaluate_ruleset", "propose_rule_change");

const MIN = 60_000;

export const FLOWS: readonly FlowDef[] = [
  {
    id: "preparar-ciclo",
    label: "Preparar el ciclo",
    description: "Ingesta y clasificación de la última versión, cambios de alcance, revisión IA solo de lo que cambió y requiere juicio, preguntas y verificación de incidencias.",
    skill: "preparar-ciclo",
    requires: ["projectId"],
    costCapUsd: 3,
    timeoutMs: 30 * MIN,
    tools: [...BASE, ...coord("list_projects", "list_model_sets", "list_model_set_versions", "list_clash_tests", "ingest_clash_test", "run_classification", "diff_test_versions", "get_model_hygiene_stats", "list_issue_checks", "get_rule_insights", "propose_rule_change"), ...TRIAGER],
    subagents: ["clash-triager"],
    produces: "Propuestas de decisión por grupo, preguntas al coordinador y hasta 3 sugerencias de reglas.",
  },
  {
    id: "triage",
    label: "Revisión IA de lo pendiente",
    description: "Revisa con IA los grupos que el motor marcó para revisión humana y que aún no tienen propuesta (sin redactar incidencias).",
    skill: "triage",
    requires: ["projectId", "testKey"],
    costCapUsd: 2,
    timeoutMs: 20 * MIN,
    tools: [...BASE, ...coord("list_clash_tests", "run_classification"), ...TRIAGER],
    subagents: ["clash-triager"],
    produces: "Propuestas de clasificación o decisión por grupo y preguntas cuando falta información.",
  },
  {
    id: "acta",
    label: "Pasar el acta",
    description: "Lee las notas de reunión escritas en la UI y las convierte en borradores de decisión por grupo; lo ambiguo se pregunta.",
    skill: "acta",
    requires: ["projectId", "testKey"],
    costCapUsd: 1,
    timeoutMs: 10 * MIN,
    tools: [...BASE, ...coord("list_meeting_notes", "propose_family_decision", "ask_coordinator")],
    subagents: [],
    produces: "Borradores de decisión por grupo (con fecha solo si la nota la cita) y preguntas.",
  },
  {
    id: "redactar-issues",
    label: "Redactar incidencias",
    description: "Redacta borradores de incidencias ACC para los grupos reales P1–P2 que aún no tienen una.",
    skill: "redactar-issues",
    requires: ["projectId", "testKey"],
    costCapUsd: 2,
    timeoutMs: 20 * MIN,
    tools: [...BASE, ...ISSUE_WRITER],
    subagents: ["issue-writer"],
    produces: "Borradores de incidencia (título ≤ 100, descripción ≤ 1000) para aprobar en la UI.",
  },
  {
    id: "informe-semanal",
    label: "Informe semanal",
    description: "Genera el informe semanal del ciclo (evolución, persistentes, avance por disciplina, higiene) con narrativa ejecutiva.",
    skill: "informe-semanal",
    requires: ["projectId", "testKey"],
    costCapUsd: 1,
    timeoutMs: 10 * MIN,
    tools: [...BASE, ...coord("list_clash_tests", "list_model_set_versions", "diff_test_versions", "get_model_hygiene_stats", "generate_report")],
    subagents: [],
    produces: "Un archivo de informe (reports/<proyecto>/…) con cifras del servidor.",
  },
  {
    id: "auditar-modelo",
    label: "Auditar higiene del modelo",
    description: "Audita la higiene de los modelos (duplicados, documentos sin disciplina, elementos sin nivel o sistema) y entrega hallazgos priorizados.",
    skill: "auditar-modelo",
    requires: ["projectId", "testKey"],
    costCapUsd: 1,
    timeoutMs: 10 * MIN,
    tools: [...BASE, ...coord("get_model_hygiene_stats", "list_disciplines", "propose_discipline_mapping")],
    subagents: ["model-hygiene-auditor"],
    produces: "Hallazgos de higiene por documento y sugerencias de disciplina para documentos sin asignar.",
  },
  {
    id: "curar-reglas",
    label: "Curar reglas",
    description: "Busca condiciones sin regla (DEF-999) y correcciones repetidas y propone reglas nuevas, calibraciones o retiros con evidencia.",
    skill: "curar-reglas",
    requires: ["projectId"],
    costCapUsd: 2,
    timeoutMs: 20 * MIN,
    tools: [...BASE, ...CURATOR],
    subagents: ["rules-curator"],
    produces: "Sugerencias de reglas para aprobar y publicar con passkey en Reglas › Sugerencias pendientes.",
  },
];

export const FLOW_IDS = FLOWS.map((f) => f.id) as readonly FlowId[];

export function flowDef(id: string): FlowDef | undefined {
  return FLOWS.find((f) => f.id === id);
}

/**
 * Tool names no flow may ever list (defence in depth: also in the agent's disallowedTools and absent
 * from the flow-mode MCP server): ACC writes, flow recursion, and every built-in that edits or runs.
 */
export const FLOW_FORBIDDEN = [
  "mcp__coord__apply_approved_proposals",
  "mcp__coord__start_flow",
  "mcp__coord__get_flow_status",
  "Bash",
  "PowerShell",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Skill",
  "Monitor",
];
