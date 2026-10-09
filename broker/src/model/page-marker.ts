// Shared streamed-answer marker detector for "page on demand" (lot 7,
// docs/PROTOCOL.md "Page on demand"). ONE implementation, used by
// handlers/chat.ts regardless of which provider answered — marker detection
// never lives inside a provider file (providers/*.ts), the same
// provider-agnostic stance model/streaming.ts already takes for ThinkFilter.
//
// Two literal markers the model is instructed to reply with
// (model/render.ts's pageOnDemandInstruction) when it needs page content it
// wasn't given: MARKER_TEXT (always offered) and MARKER_DEV (offered only
// when devMode is true). Neither is ever forwarded to the client as text —
// that is the whole point of holding output back while it's still being
// decided.
//
// Detection has two phases per detector instance (one instance = one
// provider call):
//  - "start": the answer's own first characters (after trimming leading
//    whitespace) are held back for as long as they could still complete
//    into a marker. The instant they do, this is reported as position
//    "start" — nothing was ever forwarded, so the caller has nothing to
//    discard, only the provider stream to abort.
//  - "mid": once the start phase has committed to NOT being a marker (the
//    held-back text diverged from every candidate), the detector keeps
//    scanning the rest of the stream — including the text it just committed
//    to, so a marker starting right where the start phase gave up is still
//    caught — for either marker appearing later inside otherwise-normal
//    text, holding back a short trailing tail across feed() calls (same
//    split-across-chunks handling as ThinkFilter's own partial-tag buffer)
//    so a marker split across two deltas is still found.
//
// This file only ever reports "a marker was found here, at this position" —
// whether that is still allowed to trigger a `page.request` (the read caps:
// at most one read per level, two per question) or must be silently
// stripped once exhausted is handlers/chat.ts's own policy, not this one's.

export const MARKER_TEXT = "[[READ_PAGE]]";
export const MARKER_DEV = "[[READ_PAGE_DEV]]";

export type PageMarkerLevel = "text" | "dev";
export type PageMarkerPosition = "start" | "mid";

export type PageMarkerEvent =
  | { kind: "text"; text: string }
  | { kind: "marker"; level: PageMarkerLevel; position: PageMarkerPosition };

function levelOf(marker: string): PageMarkerLevel {
  return marker === MARKER_DEV ? "dev" : "text";
}

export class PageMarkerDetector {
  private readonly candidates: readonly string[];
  private readonly maxLen: number;
  private atStart = true;
  private buf = "";

  /** `allowDev: false` means MARKER_DEV is never recognised at all for this
   * call — a model that emits it anyway (devMode wasn't offered to it, or it
   * ignored the instruction) gets it treated as ordinary text, same as any
   * other string that happens to look like one of these (docs/PROTOCOL.md:
   * "dev marker refused when devMode false"). */
  constructor(opts: { allowDev: boolean }) {
    this.candidates = opts.allowDev ? [MARKER_TEXT, MARKER_DEV] : [MARKER_TEXT];
    this.maxLen = Math.max(...this.candidates.map((m) => m.length));
  }

  /** Feed the next text delta from the provider. Returns zero or more
   * events, in the order they should be acted on — a "text" event is safe
   * to forward immediately; a "marker" event means neither it nor anything
   * buffered before it was ever returned as text. */
  feed(delta: string): PageMarkerEvent[] {
    const events: PageMarkerEvent[] = [];
    let text = this.buf + delta;
    this.buf = "";

    while (text.length > 0) {
      if (this.atStart) {
        const trimmed = text.replace(/^\s+/, "");
        if (trimmed.length === 0) {
          this.buf = text; // all whitespace so far — the decision isn't made yet
          return events;
        }
        const full = this.candidates.find((m) => trimmed === m);
        if (full) {
          events.push({ kind: "marker", level: levelOf(full), position: "start" });
          this.atStart = false;
          text = ""; // the whole buffered text (incl. leading whitespace) was the marker
          continue;
        }
        const stillPossible = this.candidates.some((m) => m.startsWith(trimmed) && trimmed.length < m.length);
        if (stillPossible) {
          this.buf = text; // could still complete into a marker — keep holding
          return events;
        }
        // Committed: the start of this answer is not a marker. Don't forward
        // yet — fall through to mid-stream scanning on this SAME text, so a
        // marker starting right where the held-back prefix diverged is still
        // caught (e.g. the model wrote a short aside, then the marker).
        this.atStart = false;
        continue;
      }

      // Mid-stream: find the earliest full marker in `text`, if any.
      let earliestIndex = -1;
      let earliestMarker = "";
      for (const m of this.candidates) {
        const idx = text.indexOf(m);
        if (idx !== -1 && (earliestIndex === -1 || idx < earliestIndex)) {
          earliestIndex = idx;
          earliestMarker = m;
        }
      }
      if (earliestIndex !== -1) {
        if (earliestIndex > 0) events.push({ kind: "text", text: text.slice(0, earliestIndex) });
        events.push({ kind: "marker", level: levelOf(earliestMarker), position: "mid" });
        text = text.slice(earliestIndex + earliestMarker.length);
        continue;
      }
      // No full marker in what we have. Hold back a trailing slice that
      // could still be the START of one (split across this and the next
      // delta); forward the rest now.
      let holdLen = 0;
      const maxHold = Math.min(this.maxLen - 1, text.length);
      for (let k = maxHold; k > 0; k--) {
        const suffix = text.slice(text.length - k);
        if (this.candidates.some((m) => m.startsWith(suffix))) {
          holdLen = k;
          break;
        }
      }
      if (holdLen > 0) events.push({ kind: "text", text: text.slice(0, text.length - holdLen) });
      else events.push({ kind: "text", text });
      this.buf = holdLen > 0 ? text.slice(text.length - holdLen) : "";
      text = "";
    }
    return events;
  }

  /** Flush any partial tail left at end of stream — it never completed into
   * a marker (the stream ended first), so it is ordinary text. Must be
   * called once after the last feed(). */
  flush(): PageMarkerEvent[] {
    if (this.buf.length === 0) return [];
    const text = this.buf;
    this.buf = "";
    return [{ kind: "text", text }];
  }
}
