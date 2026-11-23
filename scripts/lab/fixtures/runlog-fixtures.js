// Coati state lab — runlog/runlog.html fixtures. `run` is the broker's `run`
// payload (docs/PROTOCOL.md "Run log"); `run: null` answers found:false.
(function () {
  "use strict";

  var run = {
    startedAt: 0,
    ms: 31400,
    provider: "ollama",
    model: "qwen3:8b",
    question: "Which of these two laptops lasts longer on battery, and is it worth the price gap?",
    steps: [
      { t: 0, ms: 8400, kind: "call", n: 1, inputTokens: 2100, outputTokens: 340, stop: "marker",
        reasoning: "The user compares two laptops. I know neither model well enough: search for battery tests first.\nThen open the two most relevant reviews.",
        marker: { type: "search", query: "laptop A vs laptop B battery life test" }, decision: "accepted" },
      { t: 8400, ms: 1900, kind: "search", answer: "results", results: 8 },
      { t: 10300, ms: 7200, kind: "call", n: 2, inputTokens: 3400, outputTokens: 410, stop: "marker",
        reasoning: "Result 2 and 3 are full reviews with measured battery times.",
        marker: { type: "open", refs: [2, 3] }, decision: "accepted" },
      { t: 17500, ms: 2600, kind: "open", answer: "pages", pages: [
        { n: 2, title: "Laptop A review: a week with it", host: "reviews.example.org", chars: 18200 },
        { n: 3, title: "Battery shootout 2026", host: "bench.example.net", chars: 24100 } ] },
      { t: 20100, ms: 6800, kind: "call", n: 3, inputTokens: 9800, outputTokens: 520, stop: "marker",
        marker: { type: "open", refs: [5, 6, 7, 8, 9, 10, 11] }, decision: "refused", reason: "pages" },
      { t: 26900, ms: 4500, kind: "call", n: 4, uncounted: true, stop: "answer" },
    ],
    limits: { refused: [{ kind: "open", reason: "pages", count: 1, limit: 6 }], local: { contextTokens: 8192, tokensPerSec: 14, gpuPercent: 100 } },
  };

  var declinedSearch = {
    startedAt: 0,
    ms: 9600,
    provider: "ollama",
    model: "qwen3:8b",
    question: "Which of these two laptops lasts longer on battery, and is it worth the price gap?",
    steps: [
      { t: 0, ms: 4100, kind: "call", n: 1, inputTokens: 2600, outputTokens: 90, stop: "marker",
        marker: { type: "search", query: "laptop A vs laptop B price" }, decision: "accepted" },
      { t: 4100, ms: 3000, kind: "search", answer: "declined", declineReason: "blocked" },
      { t: 7100, ms: 2500, kind: "call", n: 2, inputTokens: 2700, outputTokens: 260, stop: "answer" },
    ],
    limits: { local: { contextTokens: 8192, tokensPerSec: 14, gpuPercent: 100, vramGb: 6.442 } },
  };

  window.__COATI_LAB_FIXTURES__ = {
    full: { status: "connected", features: ["run-log"], runs: { lab: run, lab2: declinedSearch } },
    "full-dev": { status: "connected", features: ["run-log"], runs: { lab: run, lab2: declinedSearch }, storageLocal: { "coati:devMode": true } },
    "not-found": { status: "connected", features: ["run-log"], run: null },
    "no-reasoning": {
      status: "connected",
      features: ["run-log"],
      run: {
        startedAt: 0, ms: 2100, provider: "claude-api", model: "claude-sonnet",
        question: "Summarize this page.",
        steps: [{ t: 0, ms: 2100, kind: "call", n: 1, inputTokens: 1200, outputTokens: 180, stop: "answer" }],
        limits: {},
      },
    },
    unsupported: { status: "connected", features: [], run: null },
  };
})();
