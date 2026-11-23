// Per-request recorder. Two views of one entry:
//  - the timeline of what the broker sent to the client and when, written to
//    the journal when the request ends: metadata only (kinds, stages, levels,
//    codes), never any content;
//  - the run log of a `chat` (steps, reasoning, limits), kept in memory only
//    and served by `run.get`: the last few finished runs, nothing on disk.

import type { ServerMessage, RunLimits, RunLog, RunStep } from "./protocol.ts";

export interface TimelineEvent {
  /** Milliseconds since the request was received. */
  t: number;
  kind: string;
  /** Stage / level / code, or the number of chunks in a run. */
  detail?: string | number;
}

interface RunState {
  provider: string;
  model: string;
  question: string;
  steps: RunStep[];
  limits?: RunLimits;
  reasoningChars: number;
}

interface Entry {
  start: number;
  run?: RunState;
  events: TimelineEvent[];
  calls: number;
  lastChunkAt: number | undefined;
  longestSilenceMs: number;
}

/** Requests that never complete are evicted oldest-first past this many. */
const MAX_TRACKED = 256;

const entries = new Map<string, Entry>();

/** Finished runs kept for `run.get`, oldest evicted first. */
const MAX_FINISHED_RUNS = 5;
/** Reasoning kept per run, in characters: the head and the tail, the middle dropped. */
const REASONING_CAP = 100_000;
const finished = new Map<string, { startedAt: number; ms: number; run: RunState }>();

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
  if (!entry) return;
  record(entry, `call${++entry.calls}`);
  openStep(entry, "call", { n: entry.calls });
}

function openStep(entry: Entry, kind: RunStep["kind"], extra: Partial<RunStep> = {}): void {
  entry.run?.steps.push({ t: Date.now() - entry.start, ms: 0, kind, ...extra });
}

/** Starts the run log of a `chat`. */
export function runBegin(id: string, info: { provider: string; model: string; question: string }): void {
  const entry = entries.get(id);
  if (entry) entry.run = { ...info, steps: [], reasoningChars: 0 };
}

/** Opens a step for the client's answer to a page, search or open request. */
export function runClientStep(id: string, kind: "search" | "open" | "read"): void {
  const entry = entries.get(id);
  if (entry) openStep(entry, kind);
}

/** Merges `patch` into the latest step. */
export function runStepNote(id: string, patch: Partial<RunStep>): void {
  const run = entries.get(id)?.run;
  const step = run?.steps[run.steps.length - 1];
  if (step) Object.assign(step, patch);
}

/** Sets the latest step's duration, then merges `patch` into it. */
export function runCloseStep(id: string, patch: Partial<RunStep> = {}): void {
  const entry = entries.get(id);
  const step = entry?.run?.steps[entry.run.steps.length - 1];
  if (entry && step) Object.assign(step, patch, { ms: Date.now() - entry.start - step.t });
}

/** Adds reasoning text to the latest model call. */
export function runReasoning(id: string, text: string): void {
  const run = entries.get(id)?.run;
  const step = run?.steps[run.steps.length - 1];
  if (!run || step?.kind !== "call") return;
  step.reasoning = (step.reasoning ?? "") + text;
  run.reasoningChars += text.length;
  if (run.reasoningChars > 2 * REASONING_CAP) trimReasoning(run);
}

export function runSetLimits(id: string, limits: RunLimits): void {
  const run = entries.get(id)?.run;
  if (run) run.limits = limits;
}

/** Keeps the first and the last half of the run's reasoning, across its steps. */
function trimReasoning(run: RunState): void {
  const total = run.steps.reduce((n, s) => n + (s.reasoning?.length ?? 0), 0);
  run.reasoningChars = total;
  if (total <= REASONING_CAP) return;
  const head = REASONING_CAP / 2;
  const tailFrom = total - (REASONING_CAP - head);
  let offset = 0;
  for (const step of run.steps) {
    const text = step.reasoning;
    if (!text) continue;
    const start = offset;
    offset += text.length;
    const kept = text.slice(0, Math.max(0, head - start)) + text.slice(Math.max(0, tailFrom - start));
    if (kept.length === text.length) continue;
    step.reasoningCut = true;
    if (kept) step.reasoning = kept;
    else delete step.reasoning;
  }
  run.reasoningChars = REASONING_CAP;
}

function viewRun(run: RunState, startedAt: number, ms: number): RunLog {
  trimReasoning(run);
  return { startedAt, ms, provider: run.provider, model: run.model, question: run.question, steps: run.steps, limits: run.limits ?? {} };
}

/** The run log of `id`, in flight or among the last finished ones. */
export function runGet(id: string): RunLog | undefined {
  const entry = entries.get(id);
  if (entry?.run) return viewRun(entry.run, entry.start, Date.now() - entry.start);
  const done = finished.get(id);
  return done ? viewRun(done.run, done.startedAt, done.ms) : undefined;
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
  if (entry.run) {
    trimReasoning(entry.run);
    finished.delete(id);
    finished.set(id, { startedAt: entry.start, ms: end, run: entry.run });
    if (finished.size > MAX_FINISHED_RUNS) finished.delete(finished.keys().next().value!);
  }
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
