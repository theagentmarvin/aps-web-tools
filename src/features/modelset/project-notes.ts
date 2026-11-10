/** Pure helpers of the project conventions panel (tested in tests/ui/parity-human.test.ts). */

/** Only the dated convention lines ("- yyyy-mm-dd · [kind] text"); headings and blanks are dropped. */
export function noteLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2));
}
