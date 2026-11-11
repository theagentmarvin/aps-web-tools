/**
 * Agent ↔ coordinator loop: one visual language for the four actors (docs/ux/agent-human-loop-proposal.md §3).
 * Every mark is glyph + word + colour (never colour alone); colours are the `--color-actor-*` theme tokens.
 */
import type { ReactNode } from "react";

export type Actor = "engine" | "agent" | "human" | "acc";

export const ACTOR_GLYPH: Record<Actor, string> = { engine: "⚙", agent: "✦", human: "●", acc: "▲" };

/** Tailwind classes per actor (text / background / border), shared app-wide. */
export const ACTOR_CLASS: Record<Actor, string> = {
  engine: "text-actor-engine bg-actor-engine-bg border-actor-engine-bd",
  agent: "text-actor-agent bg-actor-agent-bg border-actor-agent-bd",
  human: "text-actor-human bg-actor-human-bg border-actor-human-bd",
  acc: "text-actor-acc bg-actor-acc-bg border-actor-acc-bd",
};

/** Chip with the actor glyph: «⚙ Regla EST-004 · acierto 92 % · n=24». */
export function ActorMark({ actor, glyph, children, title, dashed, className = "" }: { actor: Actor; glyph?: string; children: ReactNode; title?: string; dashed?: boolean; className?: string }) {
  return (
    <span title={title} className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 text-[11px] leading-5 ${dashed ? "border-dashed" : ""} ${ACTOR_CLASS[actor]} ${className}`}>
      <span aria-hidden="true" className="shrink-0 text-[10px]">
        {glyph ?? ACTOR_GLYPH[actor]}
      </span>
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
