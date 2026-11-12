/** Pure helpers of the family "⋯" regroup actions (tested in tests/ui/parity-human.test.ts). */
import type { TriageFamily } from "~/lib/api/types";

/** Merge candidates: same discipline pair first, then the rest; never the family itself. */
export function mergeCandidates(f: TriageFamily, all: Iterable<TriageFamily>): TriageFamily[] {
  const samePair = (o: TriageFamily) => !!f.pair && !!o.pair && o.pair[0] === f.pair[0] && o.pair[1] === f.pair[1];
  return [...all]
    .filter((o) => o.id !== f.id)
    .sort((a, b) => Number(samePair(b)) - Number(samePair(a)) || b.instanceCount - a.instanceCount || a.id.localeCompare(b.id));
}
