// Run-log page rendering (docs/PROTOCOL.md "Run log"). Pure DOM building: the
// document is a parameter so tests can pass a stand-in. textContent only;
// no markup parsing, no link: reasoning, titles and hosts are data.

import { t } from "../lib/i18n-page.js";
import { formatTokensK, hardwareRows, limitSentences } from "../lib/labels.js";

const seconds = (ms) =>
  t("runlog_total_time", [((ms || 0) / 1000).toLocaleString((typeof document !== "undefined" && document.documentElement.lang) || undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })]);

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function totals(steps) {
  const calls = steps.filter((s) => s.kind === "call");
  const counted = calls.filter((s) => !s.uncounted);
  return {
    tokens: counted.reduce((sum, s) => sum + (s.inputTokens || 0) + (s.outputTokens || 0), 0),
    anyCounted: counted.length > 0,
    anyUncounted: calls.some((s) => s.uncounted),
  };
}

function totalTokensText({ tokens, anyCounted, anyUncounted }) {
  if (!anyCounted) return anyUncounted ? t("runlog_uncounted") : "";
  return t(anyUncounted ? "runlog_total_tokens_at_least" : "runlog_total_tokens", [formatTokensK(tokens)]);
}

function renderHeader(doc, run) {
  const head = el(doc, "section", "c-card runlog-head");
  head.appendChild(el(doc, "h2", "c-section-title", t("runlog_question")));
  head.appendChild(el(doc, "p", "runlog-question", run.question));
  const meta = el(doc, "dl", "runlog-meta");
  const rows = [
    [t("runlog_model"), run.model],
    [null, seconds(run.ms)],
    [null, totalTokensText(totals(run.steps))],
  ];
  for (const [label, value] of rows) {
    if (!value) continue;
    const item = el(doc, "div", "runlog-meta-item");
    if (label) item.appendChild(el(doc, "dt", "runlog-meta-label", label));
    item.appendChild(el(doc, "dd", "runlog-meta-value", value));
    meta.appendChild(item);
  }
  head.appendChild(meta);
  const calls = run.steps.filter((s) => s.kind === "call");
  if (calls.length && !calls.some((s) => s.reasoning)) head.appendChild(el(doc, "p", "runlog-no-reasoning", t("runlog_no_reasoning")));
  return head;
}

const STOP_KEYS = {
  answer: "runlog_stop_answer",
  marker: "runlog_stop_marker",
  length: "runlog_stop_length",
  cut: "runlog_stop_cut",
  error: "runlog_stop_error",
  cancelled: "runlog_stop_cancelled",
};

function askedText(marker) {
  if (!marker) return "";
  if (marker.type === "search") return t("runlog_asked_search", [marker.query ?? ""]);
  if (marker.type === "open") return t("runlog_asked_open", [(marker.refs ?? []).join(", ")]);
  return t("runlog_asked_read");
}

/** The sentence for one refused step; the cap comes from the run's own `limits.refused`. */
function refusalSentence(step, limits) {
  const known = (limits?.refused ?? []).find((r) => r.reason === step.reason);
  return limitSentences({ refused: [{ reason: step.reason, limit: known?.limit }] })[0] ?? "";
}

function cell(doc, row, className, text) {
  if (text) row.appendChild(el(doc, "span", className, text));
}

/** A step: the start time in column 1, the body (first line, then details) in column 2. */
function stepShell(doc, kind, step) {
  const item = el(doc, "li", `runlog-step runlog-step--${kind}`);
  cell(doc, item, "runlog-time", seconds(step.t));
  const body = el(doc, "div", "runlog-body");
  const row = el(doc, "div", "runlog-row");
  body.appendChild(row);
  item.appendChild(body);
  return { item, body, row };
}

function renderCall(doc, step, limits) {
  const { item, body, row } = stepShell(doc, "call", step);
  cell(doc, row, "runlog-call", t("runlog_step_call", [String(step.n ?? "")]));
  cell(
    doc,
    row,
    "runlog-tokens",
    step.uncounted ? t("runlog_uncounted") : t("runlog_tokens_in_out", [formatTokensK(step.inputTokens), formatTokensK(step.outputTokens)]),
  );
  cell(doc, row, "runlog-ms", seconds(step.ms));
  cell(doc, row, "runlog-stop", STOP_KEYS[step.stop] ? t(STOP_KEYS[step.stop]) : "");

  if (step.marker) {
    const asked = el(doc, "p", "runlog-asked");
    asked.appendChild(el(doc, "span", "runlog-asked-what", askedText(step.marker)));
    if (step.decision) {
      const refused = step.decision === "refused";
      asked.appendChild(el(doc, "span", "runlog-arrow", "→"));
      asked.appendChild(el(doc, "span", refused ? "runlog-decision runlog-decision--refused" : "runlog-decision", t(refused ? "runlog_refused" : "runlog_accepted")));
      if (refused && step.reason) asked.appendChild(el(doc, "span", "runlog-reason", refusalSentence(step, limits)));
    }
    body.appendChild(asked);
  }

  if (step.reasoning) {
    const details = el(doc, "details", "runlog-reasoning");
    details.appendChild(el(doc, "summary", "runlog-reasoning-summary", t("runlog_reasoning")));
    if (step.reasoningCut) details.appendChild(el(doc, "p", "runlog-reasoning-cut", t("runlog_reasoning_cut")));
    details.appendChild(el(doc, "pre", "runlog-reasoning-text", step.reasoning));
    body.appendChild(details);
  }
  return item;
}

const DECLINE_KEYS = {
  "no-access": "runlog_declined_no_access",
  "no-result": "runlog_declined_no_result",
  failed: "runlog_declined_failed",
};

function answerText(step) {
  switch (step.answer) {
    case "results":
      return t("runlog_answer_results", [String(step.results ?? 0)]);
    case "pages":
      return t("runlog_answer_pages", [String((step.pages ?? []).length)]);
    case "page":
      return t("runlog_answer_page", [formatTokensK(step.chars)]);
    case "declined":
      return t(DECLINE_KEYS[step.declineReason] ?? "runlog_declined_blocked");
    case "failed":
      return t("runlog_answer_failed");
    default:
      return "";
  }
}

function renderClientStep(doc, step) {
  const { item, body, row } = stepShell(doc, "client", step);
  cell(doc, row, "runlog-answer", answerText(step));
  cell(doc, row, "runlog-ms", seconds(step.ms));
  if (step.pages?.length) {
    const list = el(doc, "ul", "runlog-pages");
    for (const page of step.pages) {
      const line = el(doc, "li", "runlog-page");
      line.appendChild(el(doc, "span", "runlog-page-title", `${page.n}. ${page.title}`));
      line.appendChild(el(doc, "span", "runlog-page-host", page.host));
      line.appendChild(el(doc, "span", "runlog-page-chars", t("runlog_answer_page", [formatTokensK(page.chars)])));
      list.appendChild(line);
    }
    body.appendChild(list);
  }
  return item;
}

function renderLimits(doc, run) {
  const uncounted = run.steps.some((s) => s.kind === "call" && s.uncounted);
  const lines = limitSentences(run.limits, { uncounted });
  const rows = hardwareRows(run.limits?.local);
  if (!lines.length && !rows.length) return null;
  const block = el(doc, "section", "c-card runlog-limits");
  block.appendChild(el(doc, "h2", "c-section-title", t("runlog_limits")));
  if (lines.length) {
    const list = el(doc, "ul", "runlog-limit-list");
    for (const line of lines) list.appendChild(el(doc, "li", "runlog-limit", line));
    block.appendChild(list);
  }
  if (rows.length) {
    const dl = el(doc, "dl", "runlog-hardware");
    for (const [label, value] of rows) {
      dl.appendChild(el(doc, "dt", "runlog-meta-label", label));
      dl.appendChild(el(doc, "dd", "runlog-meta-value", value));
    }
    block.appendChild(dl);
  }
  return block;
}

/** Appends one run to `root`: header, one row per step, limits block. A `part` (2, 3...) adds the "Read the rest" heading. */
export function appendRun(doc, root, run, part) {
  if (part > 1) root.appendChild(el(doc, "h2", "c-section-title runlog-part", t("runlog_continued", [String(part)])));
  root.appendChild(renderHeader(doc, run));
  const steps = el(doc, "ol", "runlog-steps");
  for (const step of run.steps) {
    steps.appendChild(step.kind === "call" ? renderCall(doc, step, run.limits) : renderClientStep(doc, step));
  }
  root.appendChild(steps);
  const limits = renderLimits(doc, run);
  if (limits) root.appendChild(limits);
}

/** Fills `root` with one run. */
export function renderRun(doc, root, run) {
  root.replaceChildren();
  appendRun(doc, root, run, 1);
}

/** Fills `root` with a chain of runs, oldest first; `null` entries are runs the broker no longer has. */
export function renderRuns(doc, root, runs) {
  root.replaceChildren();
  runs.forEach((run, i) => {
    if (run) return appendRun(doc, root, run, i + 1);
    if (i > 0) root.appendChild(el(doc, "h2", "c-section-title runlog-part", t("runlog_continued", [String(i + 1)])));
    root.appendChild(el(doc, "p", "runlog-note", t("runlog_not_found")));
  });
}

/** A single message in place of the run (loading, not found, offline, unsupported). */
export function renderNote(doc, root, key) {
  root.replaceChildren(el(doc, "p", "runlog-note", t(key)));
}
