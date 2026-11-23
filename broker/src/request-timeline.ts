// Per-request timeline of what the broker sent to the client and when, so a
// "no news from the local program" case can be placed in time from the
// journal. Metadata only: kinds, stages, levels, codes — never any content.

import type { ServerMessage } from "./protocol.ts";

export interface TimelineEvent {
  /** Milliseconds since the request was received. */
  t: number;
  kind: string;
  /** Stage / level / code, or the number of chunks in a run. */
  detail?: string | number;
}

interface Entry {
  start: number;
  events: TimelineEvent[];
  calls: number;
  lastChunkAt: number | undefined;
  longestSilenceMs: number;
}

/** Requests that never complete are evicted oldest-first past this many. */
const MAX_TRACKED = 256;

const entries = new Map<string, Entry>();

export function timelineStart(id: string): void {
  if (entries.size >= MAX_TRACKED) entries.delete(entries.keys().next().value!);
  entries.set(id, { start: Date.now(), events: [], calls: 0, lastChunkAt: undefined, longestSilenceMs: 0 });
}

function record(entry: Entry, kind: string, detail?: string | number): void {
  const t = Date.now() - entry.start;
  if (entry.lastChunkAt !== undefined) entry.longestSilenceMs = Math.max(entry.longestSilenceMs, t - entry.lastChunkAt);
  const last = entry.events[entry.events.length - 1];
  if (kind === "chunk") {
    entry.lastChunkAt = t;
    if (last?.kind === "chunk") {
      last.detail = (last.detail as number) + 1;
      return;
    }
    entry.events.push({ t, kind, detail: 1 });
    return;
  }
  // A model call is internal: the client still hears nothing, so the silence goes on.
  if (!kind.startsWith("call")) entry.lastChunkAt = undefined;
  entry.events.push({ t, kind, ...(detail !== undefined ? { detail } : {}) });
}

export function timelineCall(id: string): void {
  const entry = entries.get(id);
  if (entry) record(entry, `call${++entry.calls}`);
}

/** Records a frame leaving the broker for request `id`. */
export function timelineSent(msg: ServerMessage): void {
  const id = (msg as { id?: unknown }).id;
  const entry = typeof id === "string" ? entries.get(id) : undefined;
  if (!entry) return;
  switch (msg.type) {
    case "progress":
      return record(entry, "progress", msg.stage);
    case "chunk":
      return record(entry, "chunk");
    case "page.request":
      return record(entry, "page.request", msg.level);
    case "search.request":
    case "open.request":
    case "done":
      return record(entry, msg.type);
    case "error":
      return record(entry, "error", msg.code);
  }
}

/** Removes the request's timeline and returns it, or undefined when unknown. */
export function timelineFinish(id: string): { events: TimelineEvent[]; longestSilenceMs: number } | undefined {
  const entry = entries.get(id);
  if (!entry) return undefined;
  entries.delete(id);
  const end = Date.now() - entry.start;
  const trailing = entry.lastChunkAt !== undefined ? end - entry.lastChunkAt : 0;
  return { events: entry.events, longestSilenceMs: Math.max(entry.longestSilenceMs, trailing) };
}

export function formatTimeline(events: TimelineEvent[], longestSilenceMs: number): string {
  const secs = (ms: number) => (ms / 1000).toFixed(1);
  const parts = events.map((e) => {
    if (e.kind === "chunk") return `${secs(e.t)} chunk×${e.detail}`;
    return `${secs(e.t)} ${e.kind}${e.detail !== undefined ? `:${e.detail}` : ""}`;
  });
  return `${parts.join(" · ")} · longest silence after a chunk ${Math.round(longestSilenceMs / 1000)} s`;
}
