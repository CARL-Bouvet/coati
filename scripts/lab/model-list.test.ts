// Pure helpers of extension/lib/model-list.js (goal « modèle visible »,
// amendement 2026-10-07 of docs/PROTOCOL.md). The DOM renderer itself is
// exercised by the lab states `model-menu-*` and the Chromium e2e.
import { describe, expect, test } from "bun:test";
import {
  bestGpuModel,
  classifyFit,
  currentModelVision,
  FIT_CONSTANTS,
  fitNoteKey,
  groupModels,
  isCurrentLocal,
  isSlowLocalModel,
  moduleLabelsFrom,
  providerDisplayName,
  readHost,
  sameModel,
  shortModelName,
  sizeInGb,
  suggestForHost,
} from "../../extension/lib/model-list.js";
import { OLLAMA_SUGGESTIONS } from "../../extension/lib/setup-data.js";
import { computeFit, FIT_CONSTANTS as BROKER_FIT_CONSTANTS } from "../../broker/src/host.ts";

const ROMAIN = { ramGb: 16, vramGb: 6.4, unifiedMemory: false };
const MAC_16 = { ramGb: 16, vramGb: null, unifiedMemory: true };
const NO_VRAM_16 = { ramGb: 16, vramGb: null, unifiedMemory: false };

describe("providerDisplayName — never the raw provider id", () => {
  const BUILT_IN: Record<string, string> = { "claude-api": "Claude (clé API)", "openai-compat": "Compatible OpenAI" };
  const providerLabel = (id: string, fallback?: string) => BUILT_IN[id] ?? fallback ?? id;
  const base = { providerLabel, fallback: "service en ligne" };

  test("module label from settings.available", () => {
    const moduleLabels = moduleLabelsFrom({ available: [{ id: "claude-cli", label: "Claude (abonnement)" }] });
    expect(providerDisplayName("claude-cli", { ...base, moduleLabels })).toBe("Claude (abonnement)");
  });

  test("unknown module without a label falls back to the generic words", () => {
    expect(providerDisplayName("claude-cli", base)).toBe("service en ligne");
  });

  test("openai-compat named after its address, else its built-in label", () => {
    expect(providerDisplayName("openai-compat", { ...base, baseUrl: "https://openrouter.ai/api/v1" })).toBe("OpenRouter");
    expect(providerDisplayName("openai-compat", { ...base, baseUrl: "http://localhost:1234/v1" })).toBe("LM Studio");
    expect(providerDisplayName("openai-compat", base)).toBe("Compatible OpenAI");
    expect(providerDisplayName("claude-api", base)).toBe("Claude (clé API)");
  });
});

describe("machine capacity (lot 4) — copy of the local program's rule", () => {
  test("constants match broker/src/host.ts", () => {
    expect(FIT_CONSTANTS).toEqual(BROKER_FIT_CONSTANTS);
  });

  test("classifyFit agrees with the local program's computeFit on a grid", () => {
    const hosts = [ROMAIN, MAC_16, NO_VRAM_16, { ramGb: 8, vramGb: 2, unifiedMemory: false }];
    for (const host of hosts) {
      for (let gb = 0.5; gb <= 30; gb += 0.7) {
        const bytes = gb * 1e9;
        expect(classifyFit(bytes, host)).toBe(computeFit(bytes, { ...host, unifiedMemory: host.unifiedMemory || undefined }));
      }
    }
  });

  test("PROTOCOL reference machine: qwen3:4b gpu, qwen3:8b shared, 17 GB too-big", () => {
    expect(classifyFit(2.5e9, ROMAIN)).toBe("gpu");
    expect(classifyFit(5.2e9, ROMAIN)).toBe("shared");
    expect(classifyFit(17e9, ROMAIN)).toBe("too-big");
  });

  test("readHost rejects an absent or malformed host", () => {
    expect(readHost(null)).toBeNull();
    expect(readHost({ ramGb: "16" })).toBeNull();
    expect(readHost({ ramGb: 16, vramGb: null })).toEqual(NO_VRAM_16);
    expect(readHost({ ramGb: 16, vramGb: null, unifiedMemory: true })).toEqual(MAC_16);
  });

  test("curated list has no qwen3:4b (thinking-only)", () => {
    expect(OLLAMA_SUGGESTIONS.map((r) => r.model)).not.toContain("qwen3:4b");
  });

  test("Romain's machine: qwen3.5:4b recommended (largest gpu), bigger ones shared", () => {
    const rows = suggestForHost(OLLAMA_SUGGESTIONS, ROMAIN);
    const byModel = Object.fromEntries(rows.map((r) => [r.model, r]));
    expect(rows.filter((r) => r.recommended).map((r) => r.model)).toEqual(["qwen3.5:4b"]);
    expect(byModel["qwen3.5:2b"].fit).toBe("gpu");
    expect(byModel["qwen3:8b"].fit).toBe("shared");
    expect(byModel["qwen3.5:9b"].fit).toBe("shared");
    expect(byModel["gemma4:12b"].fit).toBe("shared");
  });

  test("Mac with 16 GB unified: everything gpu, largest recommended", () => {
    const rows = suggestForHost(OLLAMA_SUGGESTIONS, MAC_16);
    expect(rows.every((r) => r.fit === "gpu")).toBe(true);
    expect(rows.find((r) => r.recommended)?.model).toBe("gemma4:12b");
  });

  test("unknown VRAM: CPU rule, too-big hidden, smallest shared recommended", () => {
    const rows = suggestForHost(OLLAMA_SUGGESTIONS, NO_VRAM_16);
    expect(rows.map((r) => r.model)).toEqual(["qwen3.5:2b", "qwen3.5:4b", "qwen3:8b"]);
    expect(rows.every((r) => r.fit === "shared")).toBe(true);
    expect(rows.find((r) => r.recommended)?.model).toBe("qwen3.5:2b");
  });

  test("a tiny machine gets no suggestion at all", () => {
    expect(suggestForHost(OLLAMA_SUGGESTIONS, { ramGb: 4, vramGb: null, unifiedMemory: false })).toEqual([]);
  });

  test("fitNoteKey: measured gpuPercent wins over the estimate", () => {
    expect(fitNoteKey({ fit: "shared", gpuPercent: 62 })).toBe("model_fit_loaded_percent");
    expect(fitNoteKey({ fit: "gpu" })).toBe("model_fit_gpu");
    expect(fitNoteKey({ fit: "shared" })).toBe("model_fit_shared");
    expect(fitNoteKey({ fit: "too-big" })).toBe("model_fit_too_big");
    expect(fitNoteKey({})).toBeNull();
  });

  test("groupModels keeps fit / gpuPercent / host, drops invalid values", () => {
    const grouped = groupModels({
      current: { provider: "ollama", model: "a" },
      entries: [
        { provider: "ollama", model: "a", local: true, fit: "gpu", gpuPercent: 100 },
        { provider: "ollama", model: "b", local: true, fit: "huge", gpuPercent: 140 },
      ],
      sources: [],
      host: { ramGb: 16, vramGb: 6.4 },
    });
    expect(grouped.local[0].fit).toBe("gpu");
    expect(grouped.local[0].gpuPercent).toBe(100);
    expect(grouped.local[1].fit).toBeUndefined();
    expect(grouped.local[1].gpuPercent).toBeUndefined();
    expect(grouped.host).toEqual(ROMAIN);
  });
});

const REPLY = {
  type: "models",
  id: "x",
  current: { provider: "ollama", model: "qwen3:4b" },
  entries: [
    { provider: "ollama", model: "qwen3:4b", local: true, sizeBytes: 2_600_000_000, thinks: true },
    { provider: "ollama", model: "llama3.2:latest", local: true, sizeBytes: 2_000_000_000 },
    { provider: "claude-cli", model: "claude-sonnet-4-5", local: false },
    { provider: "ollama", model: "", local: true },
    { nonsense: true },
  ],
  sources: [
    { provider: "ollama", state: "ok" },
    { provider: "claude-cli", state: "ok" },
  ],
  host: null,
};

describe("model-list helpers", () => {
  test("sameModel tolerates Ollama's implicit :latest", () => {
    expect(sameModel("llama3.2", "llama3.2:latest")).toBe(true);
    expect(sameModel("qwen3:4b", "qwen3:8b")).toBe(false);
    expect(sameModel(null, "x")).toBe(false);
  });

  test("shortModelName drops :latest and a vendor/ prefix", () => {
    expect(shortModelName("llama3.2:latest")).toBe("llama3.2");
    expect(shortModelName("meta-llama/llama-3.3-70b-instruct:free")).toBe("llama-3.3-70b-instruct:free");
    expect(shortModelName("qwen3:4b")).toBe("qwen3:4b");
    expect(shortModelName(undefined)).toBe("");
  });

  test("sizeInGb rounds to one decimal, null when unknown", () => {
    expect(sizeInGb(2_600_000_000)).toBe(2.6);
    expect(sizeInGb(2_049_999_999)).toBe(2);
    expect(sizeInGb(undefined)).toBeNull();
    expect(sizeInGb(0)).toBeNull();
  });

  test("groupModels splits local/online, drops malformed entries, marks current and thinks", () => {
    const grouped = groupModels(REPLY);
    expect(grouped.local.map((e) => e.model)).toEqual(["qwen3:4b", "llama3.2:latest"]);
    expect(grouped.online.map((e) => e.model)).toEqual(["claude-sonnet-4-5"]);
    expect(grouped.currentEntry?.model).toBe("qwen3:4b");
    expect(grouped.local[0].thinks).toBe(true);
    expect(grouped.local[1].thinks).toBe(false);
    expect(grouped.ollamaUnreachable).toBe(false);
    expect(isCurrentLocal(grouped)).toBe(true);
  });

  test("current matches across :latest", () => {
    const grouped = groupModels({ ...REPLY, current: { provider: "ollama", model: "llama3.2" } });
    expect(grouped.currentEntry?.model).toBe("llama3.2:latest");
  });

  test("Ollama unreachable is reported; an unknown current provider is presumed online", () => {
    const grouped = groupModels({
      current: { provider: "openai-compat", model: "gpt-x" },
      entries: [],
      sources: [{ provider: "ollama", state: "unreachable" }],
    });
    expect(grouped.ollamaUnreachable).toBe(true);
    expect(grouped.currentEntry).toBeNull();
    expect(isCurrentLocal(grouped)).toBe(false);
  });

  test("a missing or empty reply yields empty groups, no throw", () => {
    const grouped = groupModels(null);
    expect(grouped.local).toEqual([]);
    expect(grouped.online).toEqual([]);
    expect(grouped.current).toEqual({ provider: null, model: null });
  });
});

// Lot B3 (plan-montrer-voir-chercher-08-10.md §3B) — vision is a real
// tri-state (true/false/undefined), never coerced to a plain boolean.
describe("vision (Lot B3) — tri-state, never coerced", () => {
  function replyWith(vision: unknown) {
    return {
      current: { provider: "ollama", model: "m" },
      entries: [{ provider: "ollama", model: "m", local: true, ...(vision === undefined ? {} : { vision }) }],
      sources: [],
      host: null,
    };
  }

  test("vision: true passes through", () => {
    expect(currentModelVision(groupModels(replyWith(true)))).toBe(true);
  });

  test("vision: false passes through (greys the checkbox out)", () => {
    expect(currentModelVision(groupModels(replyWith(false)))).toBe(false);
  });

  test("vision absent on the entry: undefined (unknown — checkbox stays active)", () => {
    expect(currentModelVision(groupModels(replyWith(undefined)))).toBeUndefined();
  });

  test("no current entry at all (older local program, no models.list): undefined", () => {
    expect(currentModelVision(groupModels(null))).toBeUndefined();
    expect(currentModelVision(groupModels({ current: { provider: "openai-compat", model: "gpt-x" }, entries: [], sources: [], host: null }))).toBeUndefined();
  });
});

describe("slow model advice (plan-ollama-rapide-07-10.md, points 4 and 6)", () => {
  const reply = {
    current: { provider: "ollama", model: "qwen3:8b" },
    entries: [
      { provider: "ollama", model: "qwen3:8b", local: true, sizeBytes: 5_225_387_923, fit: "shared", contextTokens: 8192 },
      { provider: "ollama", model: "qwen3:4b", local: true, sizeBytes: 2_600_000_000, fit: "gpu" },
      { provider: "ollama", model: "qwen3.5:4b", local: true, sizeBytes: 3_300_000_000, fit: "gpu" },
      { provider: "ollama", model: "gemma3:27b", local: true, sizeBytes: 17_396_936_315, fit: "too-big" },
      { provider: "claude-cli", model: "claude-sonnet-4-5", local: false },
    ],
  };

  test("bestGpuModel picks the largest model that fits the card", () => {
    expect(bestGpuModel(groupModels(reply))?.model).toBe("qwen3.5:4b");
  });

  test("bestGpuModel is null when nothing fits", () => {
    const none = { ...reply, entries: reply.entries.filter((e) => e.fit !== "gpu") };
    expect(bestGpuModel(groupModels(none))).toBeNull();
  });

  test("isSlowLocalModel: shared / too-big Ollama models, measured share wins", () => {
    const grouped = groupModels(reply);
    const byName = (name: string) => grouped.local.find((e) => e.model === name);
    expect(isSlowLocalModel(byName("qwen3:8b"))).toBe(true);
    expect(isSlowLocalModel(byName("gemma3:27b"))).toBe(true);
    expect(isSlowLocalModel(byName("qwen3:4b"))).toBe(false);
    expect(isSlowLocalModel({ provider: "ollama", local: true, fit: "shared", gpuPercent: 100 })).toBe(false);
    expect(isSlowLocalModel({ provider: "ollama", local: true, fit: "gpu", gpuPercent: 68 })).toBe(true);
    expect(isSlowLocalModel(grouped.online[0])).toBe(false);
    expect(isSlowLocalModel(null)).toBe(false);
  });

  test("contextTokens is kept on Ollama entries", () => {
    expect(groupModels(reply).currentEntry?.contextTokens).toBe(8192);
    expect(groupModels(reply).local[1].contextTokens).toBeUndefined();
  });
});
