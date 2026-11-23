// Shared streamed-answer marker detector (docs/PROTOCOL.md "Page on demand",
// "Search"). ONE implementation, used by handlers/chat.ts regardless of which
// provider answered — marker detection never lives inside a provider file
// (providers/*.ts), the same provider-agnostic stance model/streaming.ts
// already takes for ThinkFilter.
//
// Markers the model is instructed to reply with (model/render.ts):
//  - literals: MARKER_TEXT (always offered) and MARKER_DEV (devMode only);
//  - parameterised: `[[SEARCH: <query>]]` (offered when the panel can search),
//    one line, 1 to SEARCH_QUERY_MAX_CHARS characters, no `]]` inside;
//    `[[OPEN: S<n> …]]` (same offer, detected always), result numbers separated
//    by spaces or commas, the first OPEN_MAX_REFS kept, any other body none —
//    whether they name real results is handlers/chat.ts's call;
// A new parameterised marker is one more entry in PARAM_MARKERS.
// None is ever forwarded to the client as text — that is the whole point of
// holding output back while it's still being decided. Text that merely looks
// like a marker (a too-long query, a newline inside) stays ordinary text.
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
// whether that is still allowed to trigger a request (the read, search and
// open caps, the turn bound) or must be silently stripped is
// handlers/chat.ts's own policy, not this one's.

import { OPEN_MAX_REFS, SEARCH_QUERY_MAX_CHARS } from "../protocol/chat.ts";

export const MARKER_TEXT = "[[READ_PAGE]]";
export const MARKER_DEV = "[[READ_PAGE_DEV]]";

export type PageMarkerLevel = "text" | "dev";
export type PageMarkerPosition = "start" | "mid";

export type PageMarker =
  | { type: "read"; level: PageMarkerLevel }
  | { type: "search"; query: string }
  | { type: "open"; refs: number[] };

export type PageMarkerEvent =
  | { kind: "text"; text: string }
  | { kind: "marker"; marker: PageMarker; position: PageMarkerPosition };

type Match = { len: number; marker: PageMarker } | "partial" | null;

/** `prefix` + one-line body + `]]`: the body once complete, "partial" while it
 * could still complete (retention is bounded by `maxBody`), null otherwise. A line
 * ending in a single `]` also closes it (at a newline, or at the end of the answer when `final`). */
function paramBody(s: string, prefix: string, maxBody: number, final: boolean): { body: string; len: number } | "partial" | null {
  const head = s.slice(0, prefix.length).toUpperCase();
  if (s.length < prefix.length) return prefix.startsWith(head) ? "partial" : null;
  if (head !== prefix) return null;
  const rest = s.slice(prefix.length);
  let end = rest.indexOf("]]");
  if (end !== -1 && rest[end + 2] === "]" && rest.slice(0, end).includes("[")) end++; // `[[OPEN: [S2]]]`
  const nl = rest.indexOf("\n");
  const lineEnd = nl !== -1 ? nl : final ? rest.length : -1;
  if (lineEnd !== -1 && (end === -1 || lineEnd < end)) {
    const line = rest.slice(0, lineEnd).trimEnd(); // `[[SEARCH: query]`
    return line.length > 1 && line.endsWith("]") ? { body: line.slice(0, -1), len: prefix.length + line.length } : null;
  }
  if (end === -1) return rest.length <= maxBody + 2 ? "partial" : null;
  return { body: rest.slice(0, end), len: prefix.length + end + 2 };
}

/** Refs as `S2 S5`, `S2,S5` or `[S2], [S5]`; anything else is not an OPEN. */
function buildOpen(body: string): PageMarker | null {
  const tokens = body.replace(/[[\]]/g, " ").trim().split(/[\s,]+/);
  if (!tokens.every((t) => /^S[1-9][0-9]{0,2}$/i.test(t))) return null;
  return { type: "open", refs: [...new Set(tokens.map((t) => Number(t.slice(1))))].slice(0, OPEN_MAX_REFS) };
}

const PARAM_MARKERS: readonly {
  prefix: string;
  maxBody: number;
  always?: true; // detected even when search is not offered
  build(body: string): PageMarker | null;
}[] = [
  {
    prefix: "[[SEARCH:",
    maxBody: SEARCH_QUERY_MAX_CHARS,
    build: (body) => {
      const query = body.trim();
      return query.length >= 1 && query.length <= SEARCH_QUERY_MAX_CHARS ? { type: "search", query } : null;
    },
  },
  // Any other body (an address, a bare number) names no result: an OPEN with no refs, stripped as unknown.
  { prefix: "[[OPEN:", maxBody: 2048, always: true, build: (body) => buildOpen(body) ?? { type: "open", refs: [] } },
  // Small models mix READ_PAGE and OPEN: a READ_PAGE carrying S refs means OPEN.
  ...["[[READ_PAGE:", "[[READ_PAGE_DEV:"].map((prefix) => ({ prefix, maxBody: 64, build: buildOpen })),
];

export class PageMarkerDetector {
  private readonly literals: readonly string[];
  private readonly search: boolean; // SEARCH and OPEN
  private atStart = true;
  private buf = "";

  /** `allowDev: false` means MARKER_DEV is never recognised at all for this
   * call — a model that emits it anyway (devMode wasn't offered to it, or it
   * ignored the instruction) gets it treated as ordinary text (docs/PROTOCOL.md:
   * "dev marker refused when devMode false"). Same for `allowSearch` (SEARCH; OPEN is
   * always detected, and names no result when search was not offered). */
  constructor(opts: { allowDev: boolean; allowSearch?: boolean }) {
    this.literals = opts.allowDev ? [MARKER_TEXT, MARKER_DEV] : [MARKER_TEXT];
    this.search = opts.allowSearch === true;
  }

  /** Does `s` (starting at a candidate `[[`) hold a full marker at its start,
   * a prefix that could still become one, or neither? `final`: the answer ends here. */
  private matchAt(s: string, final = false): Match {
    let partial = false;
    for (const m of this.literals) {
      const head = s.slice(0, m.length).toUpperCase();
      if (head === m) return { len: m.length, marker: { type: "read", level: m === MARKER_DEV ? "dev" : "text" } };
      if (s.length < m.length && m.startsWith(head)) partial = true;
    }
    for (const pm of PARAM_MARKERS) {
      if (!this.search && !pm.always) continue;
      const r = paramBody(s, pm.prefix, pm.maxBody, final);
      if (r === "partial") partial = true;
      else if (r !== null) {
        const marker = pm.build(r.body);
        if (marker) return { len: r.len, marker };
      }
    }
    return partial ? "partial" : null;
  }

  private findMid(text: string): { index: number; match: Exclude<Match, null> } | null {
    for (let i = text.indexOf("["); i !== -1; i = text.indexOf("[", i + 1)) {
      const match = this.matchAt(text.slice(i));
      if (match !== null) return { index: i, match };
    }
    return null;
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
        const m = this.matchAt(trimmed);
        if (m !== null && m !== "partial" && m.len === trimmed.length) {
          events.push({ kind: "marker", marker: m.marker, position: "start" });
          this.atStart = false;
          text = ""; // the whole buffered text (incl. leading whitespace) was the marker
          continue;
        }
        if (m === "partial") {
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

      // Mid-stream: the earliest position holding a full marker or a prefix
      // of one. Text before it is forwarded; a prefix is held for the next delta.
      const hit = this.findMid(text);
      if (hit === null) {
        events.push({ kind: "text", text });
        text = "";
      } else if (hit.match === "partial") {
        if (hit.index > 0) events.push({ kind: "text", text: text.slice(0, hit.index) });
        this.buf = text.slice(hit.index);
        text = "";
      } else {
        if (hit.index > 0) events.push({ kind: "text", text: text.slice(0, hit.index) });
        events.push({ kind: "marker", marker: hit.match.marker, position: "mid" });
        text = text.slice(hit.index + hit.match.len);
      }
    }
    return events;
  }

  /** Flush the tail held back at end of stream: a marker if the end of the answer
   * closes it (`[[SEARCH: query]`), ordinary text otherwise. Must be called once
   * after the last feed(). */
  flush(): PageMarkerEvent[] {
    if (this.buf.length === 0) return [];
    const text = this.buf;
    this.buf = "";
    const lead = text.length - text.trimStart().length;
    const m = this.matchAt(text.slice(lead), true);
    if (m === null || m === "partial") return [{ kind: "text", text }];
    const after = text.slice(lead + m.len);
    const marker: PageMarkerEvent = { kind: "marker", marker: m.marker, position: this.atStart ? "start" : "mid" };
    return after.trim() ? [marker, { kind: "text", text: after }] : [marker];
  }
}
