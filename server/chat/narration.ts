/**
 * Safety net for the chat stream (G12): the prompt already asks for Spanish and no pre-tool
 * narration, but the model sometimes opens with "I'll check the family's details first.".
 * Each text segment (text between tool calls) is held until it is clearly content:
 *  - a segment followed by a tool call is DROPPED when it is English, or short narration
 *    ("Reviso el grupo…", "Voy a consultar:");
 *  - a held segment that ends the turn is always shown (never an empty answer);
 *  - a Spanish segment longer than HOLD_CHARS streams live from then on.
 */

export const HOLD_CHARS = 200;

const EN = new Set(["the", "i", "i'll", "i'm", "let", "let's", "me", "check", "first", "will", "of", "and", "to", "is", "this", "that", "for", "with", "now", "look", "details", "family", "group", "it", "are", "be", "on", "at", "a", "an", "what", "which", "here", "see", "get", "into", "about"]);
const ES = new Set(["el", "la", "los", "las", "de", "del", "que", "en", "es", "por", "un", "una", "con", "se", "su", "y", "para", "grupo", "ubicación", "ubicaciones", "reviso", "voy", "primero", "ahora", "al", "lo", "no", "son", "está", "hay", "como"]);

/** True when the text reads as English (function words), not Spanish. */
export function looksEnglish(text: string): boolean {
  const words = text.toLowerCase().match(/[a-záéíóúñü']+/g) ?? [];
  let en = 0;
  let es = 0;
  for (const w of words) {
    if (EN.has(w)) en++;
    if (ES.has(w)) es++;
  }
  if (/[áéíóúñ¿¡]/i.test(text)) es += 2;
  return en >= 2 && en > es;
}

const NARRATION = /^\s*(voy a|vamos a|reviso|revisaré|consulto|consultaré|primero|déjame|veamos|ahora|busco|miro|verifico|compruebo|obtengo|analizo|leo|cargo|necesito (revisar|consultar|ver))\b/i;

/** Short "about to do something" line before a tool call. */
export function looksLikeNarration(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > HOLD_CHARS || t.includes("\n\n")) return false;
  return NARRATION.test(t) || /[:…]$|\.\.\.$/.test(t);
}

/** Per-turn filter: push deltas, signal segment boundaries; `emit` receives what may be shown. */
export class NarrationFilter {
  private held = "";
  private streaming = false;
  private segStarted = false;
  /** Text already shown. */
  shown = "";

  constructor(private readonly emit: (text: string) => void) {}

  private out(text: string) {
    if (!text) return;
    // First output of a new segment after earlier text: keep the paragraphs apart.
    const sep = !this.segStarted && this.shown && !this.shown.endsWith("\n") ? "\n\n" : "";
    this.segStarted = true;
    this.shown += sep + text;
    this.emit(sep + text);
  }

  push(text: string): void {
    if (this.streaming) return this.out(text);
    this.held += text;
    if (this.held.length >= HOLD_CHARS && !looksEnglish(this.held)) {
      this.streaming = true;
      const h = this.held;
      this.held = "";
      this.out(h);
    }
  }

  /** The current segment ended. toolFollows: a tool call comes next (the segment was a preamble). */
  end(toolFollows: boolean): void {
    const h = this.held;
    this.held = "";
    this.streaming = false;
    if (h.trim() && !(toolFollows && (looksEnglish(h) || looksLikeNarration(h)))) this.out(h);
    this.segStarted = false;
  }
}
