/**
 * The `coordinador-chat` agent definition. Installed copy (.claude/agents/) first, else the staged
 * copy (harness-staging/.claude/agents/), passed inline with `--agents <json>` (no dependency on
 * `npm run setup`). Read-only here: this module never writes the definition.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CHAT_AGENT = "coordinador-chat";

export interface ChatAgentDef {
  source: "installed" | "staged";
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

export function parseAgentFile(text: string, source: ChatAgentDef["source"]): ChatAgentDef {
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

export function loadChatAgent(root: string): ChatAgentDef | undefined {
  const installed = join(root, ".claude", "agents", `${CHAT_AGENT}.md`);
  const staged = join(root, "harness-staging", ".claude", "agents", `${CHAT_AGENT}.md`);
  if (existsSync(installed)) return parseAgentFile(readFileSync(installed, "utf8"), "installed");
  if (existsSync(staged)) return parseAgentFile(readFileSync(staged, "utf8"), "staged");
  return undefined;
}

/** `--agents` JSON for the staged copy (same fields Claude Code reads from the .md front matter). */
export function inlineAgentsJson(def: ChatAgentDef): string {
  return JSON.stringify({
    [def.name]: {
      description: def.description,
      prompt: def.prompt,
      tools: def.tools,
      disallowedTools: def.disallowedTools,
      ...(def.model ? { model: def.model } : {}),
      ...(def.omitClaudeMd !== undefined ? { omitClaudeMd: def.omitClaudeMd } : {}),
    },
  });
}
