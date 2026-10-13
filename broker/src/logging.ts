// Request/startup logging and the two size-budget checks every streaming
// request is gated on before it ever reaches a provider. Split out of
// server.ts.

import { readFileSync } from "node:fs";
import {
  FACTS_MAX,
  FACT_LABEL_MAX,
  FACT_VALUE_MAX,
  ITEMS_MAX,
  ITEM_TITLE_MAX,
  ITEM_PRICE_MAX,
  ITEM_LOCATION_MAX,
  ITEM_DETAIL_MAX,
  ELEMENTS_MAX,
  ELEMENT_LABEL_MAX,
  type Context,
} from "./protocol.ts";

// Content is truncated to 40 000 chars by the content script (see PROTOCOL.md).
// The broker enforces the same cap server-side as a safety net.
export const MAX_CONTEXT_CHARS = 40_000;

// "page on demand" — docs/PROTOCOL.md "Page
// on demand": the dev level's own, much larger cap — a client answering
// `page.request { level: "dev" }` with cleaned HTML may send up to this many
// characters of `page.content.context.text` (further fit to the active
// model's own context window, see handlers/chat.ts's devContentCharBudget —
// that fit is usually the SMALLER of the two, truncating from the end and
// reporting it in `done.page`, never a refusal).
export const MAX_DEV_CONTEXT_CHARS = 400_000;

// Open-ended wire capabilities this build understands (docs/PROTOCOL.md,
// "Handshake"); all unconditional, whatever the active model or provider.
export const BROKER_FEATURES: string[] = ["elements", "vision", "history", "pageOnDemand", "search"];

export function contextTooLarge(text: string | undefined): boolean {
  return typeof text === "string" && text.length > MAX_CONTEXT_CHARS;
}

// "Size budget" / "Broker-side
// limits". `text` + `facts` + `items` now share the same 40 000-character
// budget, and each of `facts`/`items` has its own count and per-field length
// caps. Checked AFTER protocol.ts's parseContext has already dropped
// malformed-shaped elements ("after dropping malformed-shape elements") —
// every count/length here is on data that is at least well-formed. On any
// breach the broker refuses outright — it never truncates (a legitimate client
// already respects every one of these bounds; a breach signals a broken
// client, not something to paper over).
// Returns the exact bound crossed (for the error's `message`, which "names
// the bound crossed"), or undefined when the context fits.
export function contextBudgetError(context: Context | undefined): string | undefined {
  if (!context) return undefined;
  const facts = context.facts ?? [];
  const items = context.items ?? [];
  // "Montrer du doigt" — docs/PROTOCOL.md §2.
  const elements = context.elements ?? [];

  if (facts.length > FACTS_MAX) return `facts exceeds ${FACTS_MAX} entries`;
  if (items.length > ITEMS_MAX) return `items exceeds ${ITEMS_MAX} entries`;
  if (elements.length > ELEMENTS_MAX) return `elements exceeds ${ELEMENTS_MAX} entries`;

  for (const fact of facts) {
    if (fact.label.length > FACT_LABEL_MAX) return `fact label exceeds ${FACT_LABEL_MAX} characters`;
    if (fact.value.length > FACT_VALUE_MAX) return `fact value exceeds ${FACT_VALUE_MAX} characters`;
  }
  for (const item of items) {
    if (item.title.length > ITEM_TITLE_MAX) return `item title exceeds ${ITEM_TITLE_MAX} characters`;
    if (item.price !== undefined && item.price.length > ITEM_PRICE_MAX) {
      return `item price exceeds ${ITEM_PRICE_MAX} characters`;
    }
    if (item.location !== undefined && item.location.length > ITEM_LOCATION_MAX) {
      return `item location exceeds ${ITEM_LOCATION_MAX} characters`;
    }
    if (item.detail !== undefined && item.detail.length > ITEM_DETAIL_MAX) {
      return `item detail exceeds ${ITEM_DETAIL_MAX} characters`;
    }
  }
  for (const el of elements) {
    if (el.label.length > ELEMENT_LABEL_MAX) return `element label exceeds ${ELEMENT_LABEL_MAX} characters`;
  }

  const total =
    (context.text?.length ?? 0) +
    facts.reduce((sum, f) => sum + f.label.length + f.value.length, 0) +
    items.reduce(
      (sum, it) =>
        sum + it.title.length + (it.price?.length ?? 0) + (it.location?.length ?? 0) + (it.detail?.length ?? 0),
      0,
    ) +
    elements.reduce((sum, el) => sum + el.ref.length + el.role.length + el.label.length, 0);
  if (total > MAX_CONTEXT_CHARS) return `context exceeds ${MAX_CONTEXT_CHARS} characters`;

  return undefined;
}

// --- A2: one journal line per request -------------------------------------
//
// Before this, the broker only logged handshake rejections and its own
// listen line — a request that hung or errored left
// nothing in `journalctl --user -u coati-broker` to even start diagnosing
// from. Exactly one line on receipt, one on completion; never page text,
// user content, or the pairing token — these go straight to the systemd
// journal and must stay safe to paste into a bug report as-is.
// L4: `id` is entirely client-supplied (protocol.ts
// only requires it to be a non-empty string — see isNonEmptyString) and, once
// authenticated, was logged raw here. Up to 256 KB of newlines/ANSI escapes
// in it could forge journal lines (including these very grant/reject-shaped
// ones). Every client-supplied value in these two lines goes through
// sanitizeLogValue(), same as Host/Origin elsewhere in this file.
// "Broker-side limits": "the receive
// log line may carry a validated pageKind and fact/entry counts; never a
// label, a value, a title, or any other page content." pageKind/factsCount/
// itemsCount are optional so chat (which
// carries no pageKind) keep their existing "-"/0/0 shape.
export function logRequestReceived(
  type: string,
  id: string,
  contextKind: string | undefined,
  textLength: number,
  pageKind?: string,
  factsCount = 0,
  itemsCount = 0,
  // docs/PROTOCOL.md §3: "Never logged
  // (only `image: true` + bytes)" — a boolean presence flag only,
  // never mediaType/data/dimensions.
  hasImage = false,
): void {
  console.log(
    `coati-broker: request received type=${type} id=${sanitizeLogValue(id)} context=${contextKind ?? "-"} textLength=${textLength} pageKind=${pageKind ?? "-"} facts=${factsCount} items=${itemsCount} image=${hasImage}`,
  );
}

// `reason` (docs/PROTOCOL.md): the technical detail
// behind an error outcome — a provider's own captured explanation, when it
// has one, else whatever the thrown Error's message says. Optional and
// omitted for non-error outcomes
// (ok/cancelled) — there is nothing to explain. Goes through the same
// sanitizeLogValue() as every other client- or provider-sourced value logged
// here: control chars stripped, cut to 200 chars, never raw.
export function logRequestCompleted(id: string, outcome: string, elapsedMs: number, reason?: string): void {
  const reasonPart = reason ? ` reason="${sanitizeLogValue(reason)}"` : "";
  console.log(
    `coati-broker: request completed id=${sanitizeLogValue(id)} outcome=${outcome} elapsedMs=${elapsedMs}${reasonPart}`,
  );
}

// --- A1: systemd unit drift detection -------------------------------------
//
// Example: the installed unit (~/.config/systemd/user/coati-broker.service)
// had drifted from packaging/coati-broker.service in the repo — it lost an
// `Environment=` line a provider depended on — and requests failed for a
// reason nothing surfaced. Diagnosis cost an hour. This can't prevent a
// drifted unit from being *used* (systemd already launched the process by
// the time this runs), but it can name the problem loudly instead of the
// broker failing every request with no clue why.

/** Pure: true when the installed unit differs from the repo's template. Exact
 * compare except the `@@…@@` placeholders install-service.sh substitutes
 * (machine paths) — the goal is catching "someone hand-edited or forgot to
 * re-copy the unit", not semantic diffing. */
export function unitFileDrifted(installedContent: string, repoContent: string): boolean {
  const pattern = repoContent
    .split(/@@[A-Z_]+@@/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^\\n]+");
  return !new RegExp(`^${pattern}$`).test(installedContent);
}

/**
 * Startup-only, best-effort warning. Never throws, never blocks startup:
 *  - Skipped silently when not started by systemd — a bare `bun run
 *    src/server.ts` from a terminal has no INVOCATION_ID (see systemd.exec(5))
 *    and no installed unit to compare against.
 *  - Skipped silently when either file can't be read — a stripped-down
 *    deployment without a `packaging/` directory, or a permissions quirk,
 *    must never turn into a startup failure over a diagnostic nicety.
 */
export function checkUnitDriftAtStartup(
  paths: { installedUnitPath: string; repoUnitPath: string },
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!env.INVOCATION_ID) return;
  let installed: string;
  let repo: string;
  try {
    installed = readFileSync(paths.installedUnitPath, "utf8");
    repo = readFileSync(paths.repoUnitPath, "utf8");
  } catch {
    return;
  }
  if (unitFileDrifted(installed, repo)) {
    console.warn(
      `coati-broker: warning — the installed systemd unit (${paths.installedUnitPath}) differs from ` +
        `${paths.repoUnitPath} in the repo. An environment line may have silently disappeared: ` +
        `run "bash scripts/install-service.sh" to bring it back up to date.`,
    );
  }
}

// Client-controlled values (Host, Origin) are logged sanitized — control
// characters replaced with `?`, cut to 200 chars — see docs/PROTOCOL.md
// "Journalisation".
export function sanitizeLogValue(value: string | null | undefined): string {
  if (value === null || value === undefined) return "(none)";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f]/g, "?").slice(0, 200);
}
