/**
 * In-app agent definitions (`coordinador-chat`, `coordinador-flujos`) as materialised by
 * server/agent-runtime.ts: `<runtime dir>/.claude/agents/<name>.md`. The source ships with the app in
 * `agent-runtime/agents/`; there is no install step and no fallback to another definition.
 * Read-only here: this module never writes the definition.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CHAT_AGENT = "coordinador-chat";

export interface ChatAgentDef {
  source: "runtime";
  name: string;
  description: string;
  tools: string[];
  disallowedTools: string[];
  model?: string;
  omitClaudeMd?: boolean;
  prompt: string;
}

function list(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function parseAgentFile(text: string, source: ChatAgentDef["source"] = "runtime"): ChatAgentDef {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("agent file without front matter");
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return {
    source,
    name: fm.name ?? CHAT_AGENT,
    description: fm.description ?? "",
    tools: list(fm.tools),
    disallowedTools: list(fm.disallowedTools),
    ...(fm.model && fm.model !== "inherit" ? { model: fm.model } : {}),
    ...(fm.omitClaudeMd ? { omitClaudeMd: fm.omitClaudeMd === "true" } : {}),
    prompt: m[2]!.trim(),
  };
}

/** Path of an agent definition inside a materialised runtime folder. */
export function runtimeAgentPath(runtimeDir: string, name: string): string {
  return join(runtimeDir, ".claude", "agents", `${name}.md`);
}

/** Agent definition from a materialised runtime folder (undefined when missing). */
export function loadAgentDef(runtimeDir: string | undefined, name: string): ChatAgentDef | undefined {
  if (!runtimeDir) return undefined;
  const p = runtimeAgentPath(runtimeDir, name);
  return existsSync(p) ? parseAgentFile(readFileSync(p, "utf8"), "runtime") : undefined;
}

export function loadChatAgent(runtimeDir: string | undefined): ChatAgentDef | undefined {
  return loadAgentDef(runtimeDir, CHAT_AGENT);
}
