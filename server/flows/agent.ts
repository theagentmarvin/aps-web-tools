/**
 * The `coordinador-flujos` agent: runs ONE skill procedure headless, from the materialised in-app agent
 * runtime (server/agent-runtime.ts; source agent-runtime/agents/coordinador-flujos.md, shipped with the app).
 * There is no fallback to a more permissive agent: without it the flows are unavailable.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type * as C from "../api/contract";
import { loadAgentDef, type ChatAgentDef } from "../chat/agent";
import { FLOW_FORBIDDEN } from "./catalog";

export const FLOW_AGENT = "coordinador-flujos";
export const FLOW_AGENT_MISSING = "Los flujos no están disponibles: falta el agente de flujos de la aplicación (agent-runtime/agents/coordinador-flujos.md). Reinicia la app con «Coordinador BIM.cmd»; si persiste, avisa a quien mantiene la app.";

/** Built-in tools a flow may have: delegate to subagents and read project notes / rules (never write). */
export const FLOW_BUILTINS = ["Agent", "Read", "Grep", "Glob"];

/** Flow agent from a materialised runtime folder. */
export function loadFlowAgent(runtimeDir: string | undefined): ChatAgentDef | undefined {
  return loadAgentDef(runtimeDir, FLOW_AGENT);
}

/** Pre-approved tools of one flow: the catalog list ∩ the agent's own list, never a forbidden one. */
export function flowAllowedTools(agent: Pick<ChatAgentDef, "tools" | "disallowedTools">, def: Pick<C.FlowDef, "tools" | "subagents">): string[] {
  const deny = new Set([...FLOW_FORBIDDEN, ...agent.disallowedTools]);
  const own = new Set(agent.tools);
  const builtins = FLOW_BUILTINS.filter((t) => own.has(t) && (t !== "Agent" || def.subagents.length > 0));
  return [...new Set([...def.tools.filter((t) => own.has(t)), ...builtins])].filter((t) => !deny.has(t));
}

/** Built-ins enabled for the run (`--tools`): only the allowed ones. */
export function flowBuiltins(allowed: readonly string[]): string[] {
  return FLOW_BUILTINS.filter((t) => allowed.includes(t));
}

export function flowDisallowed(agent: Pick<ChatAgentDef, "disallowedTools">): string[] {
  return [...new Set([...FLOW_FORBIDDEN, ...agent.disallowedTools])];
}

/** SKILL.md body (front matter dropped) from a materialised runtime folder. */
export function skillBody(runtimeDir: string, skill: string): { body: string; agent?: string } | undefined {
  for (const p of [join(runtimeDir, ".claude", "skills", skill, "SKILL.md")]) {
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    if (!m) return { body: text.trim() };
    const agent = /^agent:\s*(\S+)/m.exec(m[1]!)?.[1];
    return { body: m[2]!.trim(), ...(agent ? { agent } : {}) };
  }
  return undefined;
}

/** The flow prompt: context block (server data) + the skill procedure. No free text from the model. */
export function flowPrompt(def: C.FlowDef, run: { runId: string; projectId: string; modelSetId?: string; testKey?: string; args?: string }, skill: { body: string; agent?: string }): string {
  const ctx = { flujo: def.id, runId: run.runId, projectId: run.projectId, ...(run.modelSetId ? { modelSetId: run.modelSetId } : {}), ...(run.testKey ? { testKey: run.testKey } : {}) };
  const args = [run.projectId, run.modelSetId, run.testKey, run.args].filter(Boolean).join(" ");
  const body = skill.body.replace(/\$ARGUMENTS/g, args);
  const procedure = skill.agent
    ? `Delega TODO el procedimiento al subagente **${skill.agent}** (herramienta Agent) con este encargo y el testKey/projectId del contexto; luego resume su resultado:\n\n${body}`
    : body;
  return [
    // The starter's reason is for the human only: never in the prompt (the chat agent's text is not an instruction).
    `<contexto_flujo>${JSON.stringify(ctx)}</contexto_flujo>`,
    `Ejecuta el flujo «${def.label}» siguiendo este procedimiento. Usa el contexto anterior (fija set_active_context con projectId${run.testKey ? " y testKey" : ""} al empezar).`,
    "Produce solo propuestas, preguntas, borradores o informes. Nunca apliques, apruebes ni publiques nada; nada se escribe en ACC.",
    "",
    procedure,
  ]
    .filter((l) => l !== "")
    .join("\n");
}
