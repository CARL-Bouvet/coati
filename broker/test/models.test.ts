// Tests for models.list (amendment 2026-10-07):
//   - models.list with a non-ollama active provider still lists Ollama models
//   - embedding-only model (capabilities without "completion") is filtered out
//   - unreachable Ollama → sources state "unreachable", no crash
//   - lastModels round-trip (settings.set records, settings.set {provider} restores)
//   - ThinkFilter: strips <think>…</think> blocks, handles split-across-chunk tags
//   - think:false only sent when Ollama capabilities include "thinking"

import { describe, expect, test, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { ServerMessage, SettingsMessage } from "../src/protocol.ts";
import type { ModelsMessage } from "../src/protocol.ts";
import { ThinkFilter } from "../src/model.ts";
import { makeTmpDir } from "./helpers/tmp-dir.ts";
import {
  __setFetchImplForTests as __setOllamaFetch,
  __resetFetchImplForTests as __resetOllamaFetch,
  __resetShowCacheForTests,
} from "../src/providers/ollama.ts";
import { __setFetchImplForTests as __setClaudeApiFetch, __resetFetchImplForTests as __resetClaudeApiFetch } from "../src/providers/claude-api.ts";
import { __setFetchImplForTests as __setOpenAiFetch, __resetFetchImplForTests as __resetOpenAiFetch } from "../src/providers/openai-compat.ts";
import { connectAndAuthV2OrThrow } from "./helpers/handshake-v2.ts";
import {
  readHostCapacity,
  computeFit,
  FIT_CONSTANTS,
  __setFsForTests,
  __setSpawnForTests,
  __setPlatformForTests,
  __overrideCapacityForTests,
  __resetHostForTests,
} from "../src/host.ts";

const ALLOWED_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd", "hex");

let servers: ReturnType<typeof startServer>[] = [];

function boot(configOverrides?: Partial<Parameters<typeof startServer>[0]>, configDir?: string) {
  const dataDir = makeTmpDir("coati-models-");
  const server = startServer(
    { port: 0, allowedExtensionIds: [ALLOWED_ID], ...configOverrides },
    KEY,
    { dataDir, configDir },
  );
  servers.push(server);
  return server;
}

afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
  __resetOllamaFetch();
  __resetOpenAiFetch();
  __resetClaudeApiFetch();
  __resetShowCacheForTests();
  __resetHostForTests();
});

async function connectAndAuth(server: ReturnType<typeof startServer>): Promise<WebSocket> {
  return connectAndAuthV2OrThrow(`ws://127.0.0.1:${server.port}/ws`, `chrome-extension://${ALLOWED_ID}`, KEY);
}

function nextMessage(ws: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      ws.removeEventListener("message", onMessage);
      resolve(JSON.parse(event.data as string));
    };
    ws.addEventListener("message", onMessage);
  });
}

// --- Fake Ollama setup -------------------------------------------------------

/** Builds a fake fetch that handles /api/tags and optionally /api/show. */
function makeFakeOllamaFetch(opts: {
  tags: Array<{ name: string; digest: string; size: number }>;
  show?: Record<string, { capabilities?: string[]; template?: string }>;
}): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.endsWith("/api/tags")) {
      return new Response(
        JSON.stringify({ models: opts.tags }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (urlStr.endsWith("/api/show") && opts.show) {
      const body = init?.body ? JSON.parse(String(init.body)) as { name?: string } : {};
      const modelName = body.name ?? "";
      const data = opts.show[modelName] ?? {};
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected ollama fetch: ${urlStr}`);
  }) as unknown as typeof fetch;
}

// Template snippets for the two model classes, taken verbatim from Ollama 0.35.1:
const HYBRID_TEMPLATE = `{{- if .System }}{{ .System }}{{ end }}
{{- range .Messages }}{{ if and $.IsThinkSet (not $.Think) -}}
/no_think
{{- end }}{{ .Role }}: {{ .Content }}
{{- end }}`;
const THINKING_ONLY_TEMPLATE = `{{- range .Messages }}<|im_start|>{{ .Role }}
{{ .Content }}<|im_end|>
{{- end }}<|im_start|>assistant
<think>
`;

// --- models.list with non-ollama active provider ----------------------------

describe("models.list — always queries Ollama regardless of active provider", () => {
  test("active provider is 'claude-cli' (unknown module), Ollama models still appear", async () => {
    __setOllamaFetch(
      makeFakeOllamaFetch({
        tags: [
          { name: "qwen3:4b", digest: "sha256:aaa", size: 2600000000 },
          { name: "llama3.2:latest", digest: "sha256:bbb", size: 2000000000 },
        ],
        show: {
          "qwen3:4b": { capabilities: ["completion", "thinking"] },
          "llama3.2:latest": { capabilities: ["completion"] },
        },
      }),
    );

    // Use an unknown provider (simulates claude-cli as a module not loaded here)
    const server = boot({ provider: "claude-cli" });
    const ws = await connectAndAuth(server);

    ws.send(JSON.stringify({ type: "models.list", id: "ml1" }));
    const msg = (await nextMessage(ws)) as ModelsMessage;

    expect(msg.type).toBe("models");
    expect(msg.id).toBe("ml1");
    expect(msg.current.provider).toBe("claude-cli");
    const ollamaEntries = msg.entries.filter((e) => e.provider === "ollama");
    expect(ollamaEntries.length).toBe(2);
    expect(ollamaEntries.map((e) => e.model).sort()).toEqual(["llama3.2:latest", "qwen3:4b"]);
    // sizeBytes present from /api/tags
    expect(ollamaEntries.find((e) => e.model === "qwen3:4b")?.sizeBytes).toBe(2600000000);
    // All Ollama models are local: true
    expect(ollamaEntries.every((e) => e.local === true)).toBe(true);
    // Ollama source state = ok
    expect(msg.sources.find((s) => s.provider === "ollama")?.state).toBe("ok");
    // host is now a HostCapacity object (lot 4 done)
    expect(msg.host).not.toBeNull();
    expect(typeof (msg.host as { ramGb: number }).ramGb).toBe("number");

    ws.close();
  });
});

// --- Embedding-only model filtered out --------------------------------------

describe("models.list — embedding model filtered", () => {
  test("model with capabilities=['embedding'] is excluded; model without capabilities field is kept", async () => {
    __setOllamaFetch(
      makeFakeOllamaFetch({
        tags: [
          { name: "nomic-embed-text:latest", digest: "sha256:emb", size: 1000000000 },
          { name: "llama3.2:latest", digest: "sha256:bbb", size: 2000000000 },
          { name: "mystery-model:latest", digest: "sha256:ccc", size: 500000000 },
        ],
        show: {
          "nomic-embed-text:latest": { capabilities: ["embedding"] },
          "llama3.2:latest": { capabilities: ["completion"] },
          // mystery-model: no capabilities field → kept
          "mystery-model:latest": {},
        },
      }),
    );

    const server = boot();
    const ws = await connectAndAuth(server);

    ws.send(JSON.stringify({ type: "models.list", id: "ml2" }));
    const msg = (await nextMessage(ws)) as ModelsMessage;

    expect(msg.type).toBe("models");
    const names = msg.entries.map((e) => e.model);
    expect(names).not.toContain("nomic-embed-text:latest");
    expect(names).toContain("llama3.2:latest");
    expect(names).toContain("mystery-model:latest");

    ws.close();
  });
});

// --- Unreachable Ollama → sources.state = "unreachable" --------------------

describe("models.list — unreachable Ollama", () => {
  test("unreachable Ollama daemon: sources has state='unreachable', entries is empty for ollama", async () => {
    __setOllamaFetch((async () => {
      throw new Error("fetch failed: connect ECONNREFUSED 127.0.0.1:11434");
    }) as unknown as typeof fetch);

    const server = boot();
    const ws = await connectAndAuth(server);

    ws.send(JSON.stringify({ type: "models.list", id: "ml3" }));
    const msg = (await nextMessage(ws)) as ModelsMessage;

    expect(msg.type).toBe("models");
    expect(msg.entries.filter((e) => e.provider === "ollama")).toHaveLength(0);
    const ollamaSource = msg.sources.find((s) => s.provider === "ollama");
    expect(ollamaSource?.state).toBe("unreachable");

    ws.close();
  });
});

// --- lastModels round-trip --------------------------------------------------

describe("lastModels — per-provider model memory", () => {
  test("settings.set with model records lastModels; switching provider without model restores it", async () => {
    const configDir = makeTmpDir("coati-lastmodels-");
    const server = boot({ provider: "ollama" }, configDir);
    const ws = await connectAndAuth(server);

    // Set ollama model
    ws.send(JSON.stringify({ type: "settings.set", id: "lm1", provider: "ollama", model: "qwen3:4b" }));
    const r1 = (await nextMessage(ws)) as SettingsMessage;
    expect(r1.model).toBe("qwen3:4b");

    // Switch to claude-api WITHOUT specifying a model
    ws.send(JSON.stringify({ type: "settings.set", id: "lm2", provider: "claude-api" }));
    const r2 = (await nextMessage(ws)) as SettingsMessage;
    // No remembered model for claude-api yet, model stays whatever it was
    expect(r2.provider).toBe("claude-api");

    // Switch back to ollama WITHOUT specifying a model → should restore qwen3:4b
    ws.send(JSON.stringify({ type: "settings.set", id: "lm3", provider: "ollama" }));
    const r3 = (await nextMessage(ws)) as SettingsMessage;
    expect(r3.provider).toBe("ollama");
    expect(r3.model).toBe("qwen3:4b");

    ws.close();
  });

  test("lastModels is persisted to config.json and read back on reload", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const configDir = makeTmpDir("coati-lastmodels-persist-");

    const server = boot({ provider: "ollama" }, configDir);
    const ws = await connectAndAuth(server);

    ws.send(JSON.stringify({ type: "settings.set", id: "lm4", provider: "ollama", model: "granite4:tiny-h" }));
    await nextMessage(ws);
    ws.close();

    const onDisk = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(onDisk.lastModels?.["ollama"]).toBe("granite4:tiny-h");
  });

  test("older config.json without lastModels is seeded on load", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { loadConfig } = await import("../src/config.ts");

    const configDir = makeTmpDir("coati-lastmodels-seed-");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ port: 8787, allowedExtensionIds: [ALLOWED_ID], provider: "ollama", model: "llama3.2" }),
      { mode: 0o600 },
    );
    const cfg = loadConfig({ configDir, dataDir: configDir });
    expect(cfg.lastModels?.["ollama"]).toBe("llama3.2");
  });

  test("older config.json carrying searchProvider/searchKeys still loads, the keys ignored", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { loadConfig } = await import("../src/config.ts");

    const configDir = makeTmpDir("coati-old-search-keys-");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        port: 8787,
        allowedExtensionIds: [ALLOWED_ID],
        provider: "ollama",
        model: "llama3.2",
        searchProvider: "brave",
        searchKeys: { brave: "BSA-secret" },
      }),
      { mode: 0o600 },
    );
    const cfg = loadConfig({ configDir, dataDir: configDir });
    expect(cfg.model).toBe("llama3.2");
    expect(JSON.stringify(cfg)).not.toContain("BSA-secret");
  });

  // Amendment 2026-10-07 bis — bug report: "modèle configuré absent
  // d'Ollama" shown even though the model was installed, because switching
  // AWAY from a provider before it ever had a model recorded in lastModels
  // lost that model for good.
  test("switching provider captures the OLD provider's current model before switching away", async () => {
    const server = boot({ provider: "ollama", model: "qwen3:8b" });
    const ws = await connectAndAuth(server);

    // Switch to claude-api — ollama's current model ("qwen3:8b") was never
    // recorded via its own settings.set, only set at boot.
    ws.send(JSON.stringify({ type: "settings.set", id: "sw1", provider: "claude-api", apiKey: "sk-ant-x" }));
    await nextMessage(ws);

    // Switch back to ollama without naming a model — must restore "qwen3:8b".
    ws.send(JSON.stringify({ type: "settings.set", id: "sw2", provider: "ollama" }));
    const r = (await nextMessage(ws)) as SettingsMessage;
    expect(r.provider).toBe("ollama");
    expect(r.model).toBe("qwen3:8b");

    ws.close();
  });
});

// --- claude-api: the menu is the API's own list ---------------------------

function fakeClaudeModelsFetch(status: number, ids: string[] = []): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status })) as unknown as typeof fetch;
}

describe("models.list — claude-api offers only what the API returns", () => {
  test("lists the API's models; a remembered model absent from them is forgotten", async () => {
    __setOllamaFetch(makeFakeOllamaFetch({ tags: [] }));
    __setClaudeApiFetch(fakeClaudeModelsFetch(200, ["claude-sonnet-x", "claude-haiku-x"]));

    const server = boot({ provider: "claude-api", model: "claude-opus-5" });
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "fm1", provider: "claude-api", apiKey: "sk-ant-good" }));
    await nextMessage(ws);

    ws.send(JSON.stringify({ type: "models.list", id: "fm2" }));
    const msg = (await nextMessage(ws)) as ModelsMessage;

    expect(msg.entries.filter((e) => e.provider === "claude-api").map((e) => e.model)).toEqual([
      "claude-sonnet-x",
      "claude-haiku-x",
    ]);
    expect(msg.current.model).toBe("claude-sonnet-x");
    ws.close();
  });

  test("a failing key offers no claude-api entry", async () => {
    __setOllamaFetch(makeFakeOllamaFetch({ tags: [] }));
    __setClaudeApiFetch(fakeClaudeModelsFetch(401));

    const server = boot({ provider: "claude-api" });
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "fm1", provider: "claude-api", apiKey: "sk-ant-bad" }));
    await nextMessage(ws);

    ws.send(JSON.stringify({ type: "models.list", id: "fm2" }));
    const msg = (await nextMessage(ws)) as ModelsMessage;

    expect(msg.entries.some((e) => e.provider === "claude-api")).toBe(false);
    ws.close();
  });

  test('a key that is not a key ("claude /login") is refused and not stored', async () => {
    const server = boot({ provider: "claude-api" });
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "fk1", provider: "claude-api", apiKey: "claude /login" }));
    const reply = (await nextMessage(ws)) as { type: string; code?: string };
    expect(reply.type).toBe("error");
    expect(reply.code).toBe("bad-request");

    ws.send(JSON.stringify({ type: "settings.get", id: "fk2" }));
    const settings = (await nextMessage(ws)) as SettingsMessage;
    expect(settings.available.find((p) => p.id === "claude-api")?.configured).toBe(false);
    ws.close();
  });
});

// --- ThinkFilter unit tests -------------------------------------------------

describe("ThinkFilter", () => {
  test("passes text with no think tags unchanged", () => {
    const f = new ThinkFilter();
    expect(f.filter("Hello world")).toBe("Hello world");
    expect(f.flush()).toBe("");
  });

  test("strips a complete <think>…</think> block in one chunk", () => {
    const f = new ThinkFilter();
    expect(f.filter("Before<think>reasoning</think>After")).toBe("BeforeAfter");
    expect(f.flush()).toBe("");
  });

  test("strips a block split across two chunks", () => {
    const f = new ThinkFilter();
    expect(f.filter("Hello<think>rea")).toBe("Hello");
    expect(f.filter("soning</think>World")).toBe("World");
    expect(f.flush()).toBe("");
  });

  test("handles opening tag split across chunks", () => {
    const f = new ThinkFilter();
    // "<think>" split: chunk ends with "<thi"
    expect(f.filter("Hello<thi")).toBe("Hello");
    expect(f.filter("nk>hidden</think>World")).toBe("World");
    expect(f.flush()).toBe("");
  });

  test("handles closing tag split across chunks", () => {
    const f = new ThinkFilter();
    expect(f.filter("Hello<think>hidden</thi")).toBe("Hello");
    expect(f.filter("nk>World")).toBe("World");
    expect(f.flush()).toBe("");
  });

  test("stream starting with unclosed <think> drops content until </think>", () => {
    const f = new ThinkFilter();
    expect(f.filter("<think>I am thinking...")).toBe("");
    expect(f.filter("still thinking...")).toBe("");
    expect(f.filter("</think>The answer is 42.")).toBe("The answer is 42.");
    expect(f.flush()).toBe("");
  });

  test("flushes buffered partial open tag as text at end of stream", () => {
    // Chunk ends with partial "<th" — not a complete tag, so it's output if no
    // full tag ever arrives (flush emits it).
    const f = new ThinkFilter();
    expect(f.filter("Hello <th")).toBe("Hello ");
    expect(f.flush()).toBe("<th");
  });

  test("multiple think blocks in one chunk", () => {
    const f = new ThinkFilter();
    expect(f.filter("<think>a</think>b<think>c</think>d")).toBe("bd");
    expect(f.flush()).toBe("");
  });
});

// --- think:false / think:true strategy + thinks field -----------------------

describe("ollama streamAnswer — thinking strategy by template", () => {
  /** Helper: boot a server with a fake Ollama, send a chat, return the captured /api/chat body. */
  async function runChatCapture(
    modelName: string,
    showPayload: { capabilities?: string[]; template?: string },
    digest = "sha256:aaa",
  ): Promise<Record<string, unknown>> {
    let capturedBody: Record<string, unknown> = {};
    __setOllamaFetch((async (url: string, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: modelName, digest, size: 2600000000 }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.endsWith("/api/show")) {
        return new Response(JSON.stringify(showPayload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (urlStr.endsWith("/api/chat")) {
        capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ message: { role: "assistant", content: "ok" }, done: true, eval_count: 1, prompt_eval_count: 1 }) + "\n",
          { status: 200, headers: { "content-type": "application/x-ndjson" } },
        );
      }
      throw new Error(`unexpected: ${urlStr}`);
    }) as unknown as typeof fetch);

    const server = boot({ provider: "ollama", model: modelName });
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "chat", id: "tc", text: "hello" }));
    let done = false;
    while (!done) {
      const msg = await nextMessage(ws);
      if (msg.type === "done" || msg.type === "error") done = true;
    }
    ws.close();
    return capturedBody;
  }

  test("hybrid (template has 'not $.Think'): think:false is sent", async () => {
    const body = await runChatCapture("qwen3:8b", {
      capabilities: ["completion", "tools", "thinking"],
      template: HYBRID_TEMPLATE,
    }, "sha256:hybrid");
    expect(body.think).toBe(false);
  });

  test("thinking-only (template has no 'not $.Think'): think:true is sent", async () => {
    const body = await runChatCapture("qwen3:4b", {
      capabilities: ["completion", "thinking"],
      template: THINKING_ONLY_TEMPLATE,
    }, "sha256:thinkonly");
    expect(body.think).toBe(true);
  });

  test("non-thinking model: think field is absent", async () => {
    const body = await runChatCapture("llama3.2", {
      capabilities: ["completion"],
      template: "{{ .System }}\n{{ range .Messages }}{{ .Role }}: {{ .Content }}\n{{ end }}",
    }, "sha256:llama");
    expect(body.think).toBeUndefined();
  });

  test("thinking-only: message.thinking chunks are NOT yielded as deltas", async () => {
    const deltas: string[] = [];
    __setOllamaFetch((async (url: string, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "qwen3:4b", digest: "sha256:thinkonly2", size: 1 }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.endsWith("/api/show")) {
        return new Response(
          JSON.stringify({ capabilities: ["completion", "thinking"], template: THINKING_ONLY_TEMPLATE }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.endsWith("/api/chat")) {
        // Simulate: thinking arrives in message.thinking, clean answer in message.content
        const ndjson = [
          JSON.stringify({ message: { role: "assistant", content: "", thinking: "I am reasoning..." }, done: false }),
          JSON.stringify({ message: { role: "assistant", content: "The answer is 42.", thinking: "" }, done: false }),
          JSON.stringify({ message: { role: "assistant", content: "" }, done: true, eval_count: 5, prompt_eval_count: 2 }),
        ].join("\n") + "\n";
        return new Response(ndjson, { status: 200, headers: { "content-type": "application/x-ndjson" } });
      }
      throw new Error(`unexpected: ${urlStr}`);
    }) as unknown as typeof fetch);

    const server = boot({ provider: "ollama", model: "qwen3:4b" });
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "chat", id: "tth", text: "what is the answer?" }));
    let done = false;
    while (!done) {
      const msg = await nextMessage(ws);
      if (msg.type === "chunk") deltas.push(msg.delta);
      if (msg.type === "done" || msg.type === "error") done = true;
    }
    ws.close();

    // Reasoning tokens must not appear in deltas
    expect(deltas.join("")).not.toContain("I am reasoning");
    expect(deltas.join("")).toContain("42");
  });
});

describe("models.list — thinks field for thinking-only models", () => {
  test("hybrid model (canDisableThinking) has no thinks field; thinking-only model has thinks:true", async () => {
    __setOllamaFetch(
      makeFakeOllamaFetch({
        tags: [
          { name: "qwen3:8b", digest: "sha256:hybrid", size: 5200000000 },
          { name: "qwen3:4b", digest: "sha256:thinkonly", size: 2600000000 },
          { name: "llama3.2:latest", digest: "sha256:plain", size: 2000000000 },
        ],
        show: {
          "qwen3:8b": { capabilities: ["completion", "tools", "thinking"], template: HYBRID_TEMPLATE },
          "qwen3:4b": { capabilities: ["completion", "thinking"], template: THINKING_ONLY_TEMPLATE },
          "llama3.2:latest": { capabilities: ["completion"] },
        },
      }),
    );

    const server = boot();
    const ws = await connectAndAuth(server);

    ws.send(JSON.stringify({ type: "models.list", id: "mlt" }));
    const msg = (await nextMessage(ws)) as ModelsMessage;

    const hybrid = msg.entries.find((e) => e.model === "qwen3:8b");
    const thinkingOnly = msg.entries.find((e) => e.model === "qwen3:4b");
    const plain = msg.entries.find((e) => e.model === "llama3.2:latest");

    expect(hybrid?.thinks).toBeUndefined();
    expect(thinkingOnly?.thinks).toBe(true);
    expect(plain?.thinks).toBeUndefined();

    ws.close();
  });
});

// --- think:false only sent when capability present (legacy tests, kept) ------

describe("ollama streamAnswer — think:false conditional on capabilities (legacy)", () => {
  test("think:false is added to request body for a hybrid model with 'thinking' capability", async () => {
    let capturedBody: Record<string, unknown> = {};

    __setOllamaFetch((async (url: string, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "qwen3:4b", digest: "sha256:aaa", size: 2600000000 }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.endsWith("/api/show")) {
        return new Response(
          JSON.stringify({ capabilities: ["completion", "thinking"], template: HYBRID_TEMPLATE }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.endsWith("/api/chat")) {
        capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        // Return a minimal valid stream
        return new Response(
          JSON.stringify({ message: { role: "assistant", content: "ok" }, done: true, eval_count: 1, prompt_eval_count: 1 }) + "\n",
          { status: 200, headers: { "content-type": "application/x-ndjson" } },
        );
      }
      throw new Error(`unexpected: ${urlStr}`);
    }) as unknown as typeof fetch);

    const server = boot({ provider: "ollama", model: "qwen3:4b" });
    const ws = await connectAndAuth(server);

    ws.send(JSON.stringify({ type: "chat", id: "t1", text: "hello" }));
    // Drain messages until done/error
    let done = false;
    while (!done) {
      const msg = await nextMessage(ws);
      if (msg.type === "done" || msg.type === "error") done = true;
    }

    expect(capturedBody.think).toBe(false);

    ws.close();
  });

  test("think:false is NOT added for a model without 'thinking' capability", async () => {
    let capturedBody: Record<string, unknown> = {};

    __setOllamaFetch((async (url: string, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "llama3.2", digest: "sha256:bbb", size: 2000000000 }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.endsWith("/api/show")) {
        return new Response(
          JSON.stringify({ capabilities: ["completion"] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.endsWith("/api/chat")) {
        capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ message: { role: "assistant", content: "ok" }, done: true, eval_count: 1, prompt_eval_count: 1 }) + "\n",
          { status: 200, headers: { "content-type": "application/x-ndjson" } },
        );
      }
      throw new Error(`unexpected: ${urlStr}`);
    }) as unknown as typeof fetch);

    const server = boot({ provider: "ollama", model: "llama3.2" });
    const ws = await connectAndAuth(server);

    ws.send(JSON.stringify({ type: "chat", id: "t2", text: "hello" }));
    let done = false;
    while (!done) {
      const msg = await nextMessage(ws);
      if (msg.type === "done" || msg.type === "error") done = true;
    }

    expect(capturedBody.think).toBeUndefined();

    ws.close();
  });
});

// =============================================================================
// LOT 4: host capacity + fit classification + gpuPercent
// =============================================================================

// --- readHostCapacity unit tests ---------------------------------------------

describe("readHostCapacity — AMD sysfs", () => {
  test("card0 mem_info_vram_total = 6425673728 → vramGb 6.4", async () => {
    __setPlatformForTests("linux");
    __setFsForTests(
      (_path) => ["card0"],
      (path, _enc) => {
        if (path.includes("mem_info_vram_total")) return "6425673728\n";
        throw new Error(`unexpected read: ${path}`);
      },
    );
    const cap = await readHostCapacity();
    expect(cap.vramGb).toBe(6.4);
    expect(cap.unifiedMemory).toBeUndefined();
  });

  test("multiple cards — picks the largest", async () => {
    __setPlatformForTests("linux");
    __setFsForTests(
      (_path) => ["card0", "card1", "renderD128"],
      (path, _enc) => {
        if (path.includes("card0") && path.includes("mem_info_vram_total")) return "2000000000";
        if (path.includes("card1") && path.includes("mem_info_vram_total")) return "8000000000";
        throw new Error(`unexpected: ${path}`);
      },
    );
    const cap = await readHostCapacity();
    expect(cap.vramGb).toBe(8.0);
  });
});

describe("readHostCapacity — nvidia-smi fallback", () => {
  test("no AMD cards → tries nvidia-smi; 6144 MiB → vramGb 6.4", async () => {
    __setPlatformForTests("linux");
    __setFsForTests(
      (_path) => [],
      (_path, _enc) => { throw new Error("no file"); },
    );
    __setSpawnForTests((_cmd, _args, _opts) => ({
      pid: 0, output: [], signal: null, status: 0, stderr: "", error: undefined,
      stdout: "6144\n",
    }));
    const cap = await readHostCapacity();
    // 6144 MiB × 1 048 576 = 6 442 450 944 bytes → 6.442... GB → 6.4
    expect(cap.vramGb).toBe(6.4);
  });

  test("nvidia-smi exits non-zero → vramGb null", async () => {
    __setPlatformForTests("linux");
    __setFsForTests((_p) => [], (_p, _e) => { throw new Error(); });
    __setSpawnForTests((_cmd, _args, _opts) => ({
      pid: 0, output: [], signal: null, status: 1, stderr: "not found", error: undefined,
      stdout: "",
    }));
    const cap = await readHostCapacity();
    expect(cap.vramGb).toBeNull();
  });
});

describe("readHostCapacity — darwin", () => {
  test("macOS → unifiedMemory:true, vramGb null", async () => {
    __setPlatformForTests("darwin");
    const cap = await readHostCapacity();
    expect(cap.unifiedMemory).toBe(true);
    expect(cap.vramGb).toBeNull();
  });
});

describe("readHostCapacity — nothing found (Linux, no GPU)", () => {
  test("no DRM, no nvidia-smi → vramGb null", async () => {
    __setPlatformForTests("linux");
    __setFsForTests((_p) => [], (_p, _e) => { throw new Error(); });
    __setSpawnForTests((_cmd, _args, _opts) => ({
      pid: 0, output: [], signal: null, status: 127, stderr: "", error: undefined,
      stdout: "",
    }));
    const cap = await readHostCapacity();
    expect(cap.vramGb).toBeNull();
    expect(cap.unifiedMemory).toBeUndefined();
    expect(typeof cap.ramGb).toBe("number");
  });
});

// --- computeFit unit tests (table-driven) ------------------------------------
// Reference machine: RX 5600 XT = 6.4 GB VRAM, 16 GB RAM.
// OVERHEAD = 1.5 GB. needed = sizeBytes + 1.5e9.

describe("computeFit — table-driven", () => {
  const host16_64 = { ramGb: 16, vramGb: 6.4 };
  const hostUnified = { ramGb: 16, vramGb: null, unifiedMemory: true as const };
  const hostNoGpu = { ramGb: 16, vramGb: null };

  // qwen3:4b 2.5 GB → needed 4 GB ≤ 6.4 GB VRAM → gpu
  test("qwen3:4b 2.5 GB on 6.4 VRAM → gpu", () => {
    expect(computeFit(2_500_000_000, host16_64)).toBe("gpu");
  });

  // qwen3:8b 5.2 GB → needed 6.7 GB > 6.4, ≤ 6.4 + 8 = 14.4 → shared
  test("qwen3:8b 5.2 GB on 6.4 VRAM + 16 RAM → shared", () => {
    expect(computeFit(5_200_000_000, host16_64)).toBe("shared");
  });

  // 17 GB → needed 18.5 GB > 14.4 → too-big
  test("17 GB model on 6.4 VRAM + 16 RAM → too-big", () => {
    expect(computeFit(17_000_000_000, host16_64)).toBe("too-big");
  });

  // unified 16 GB: threshold = 0.75×16 = 12 GB; 4+1.5=5.5 ≤ 12 → gpu
  test("4 GB model on unified 16 GB → gpu", () => {
    expect(computeFit(4_000_000_000, hostUnified)).toBe("gpu");
  });

  // unified: 11+1.5=12.5 > 12 → too-big
  test("11 GB model on unified 16 GB → too-big", () => {
    expect(computeFit(11_000_000_000, hostUnified)).toBe("too-big");
  });

  // no GPU: threshold = 0.5×16 = 8 GB; 6+1.5=7.5 ≤ 8 → shared
  test("6 GB model on no-GPU 16 GB → shared", () => {
    expect(computeFit(6_000_000_000, hostNoGpu)).toBe("shared");
  });

  // no GPU: 8+1.5=9.5 > 8 → too-big
  test("8 GB model on no-GPU 16 GB → too-big", () => {
    expect(computeFit(8_000_000_000, hostNoGpu)).toBe("too-big");
  });
});

// --- fit field in models.list response ---------------------------------------

describe("models.list — fit field (lot 4)", () => {
  test("fit classified on Ollama entries; host shape in response", async () => {
    __overrideCapacityForTests({ ramGb: 16, vramGb: 6.4 });
    __setOllamaFetch(
      makeFakeOllamaFetch({
        tags: [
          { name: "qwen3:4b", digest: "sha256:f1", size: 2_500_000_000 },
          { name: "qwen3:8b", digest: "sha256:f2", size: 5_200_000_000 },
          { name: "bigmodel:latest", digest: "sha256:f3", size: 17_000_000_000 },
        ],
        show: {
          "qwen3:4b": { capabilities: ["completion"] },
          "qwen3:8b": { capabilities: ["completion"] },
          "bigmodel:latest": { capabilities: ["completion"] },
        },
      }),
    );

    const server = boot();
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "models.list", id: "fit1" }));
    const msg = (await nextMessage(ws)) as ModelsMessage;

    expect(msg.host).toMatchObject({ ramGb: 16, vramGb: 6.4 });

    const e4b = msg.entries.find((e) => e.model === "qwen3:4b");
    const e8b = msg.entries.find((e) => e.model === "qwen3:8b");
    const eBig = msg.entries.find((e) => e.model === "bigmodel:latest");

    expect(e4b?.fit).toBe("gpu");
    expect(e8b?.fit).toBe("shared");
    expect(eBig?.fit).toBe("too-big");

    ws.close();
  });
});

// --- gpuPercent from /api/ps -------------------------------------------------

describe("models.list — gpuPercent from /api/ps", () => {
  test("gpuPercent = round(100 × size_vram / size) for loaded models", async () => {
    __overrideCapacityForTests({ ramGb: 16, vramGb: 6.4 });
    __setOllamaFetch((async (url: string, init?: RequestInit) => {
      const s = String(url);
      if (s.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [
            { name: "qwen3:8b", digest: "sha256:ps1", size: 5_961_395_730 },
            { name: "llama3.2:latest", digest: "sha256:ps2", size: 2_000_000_000 },
          ]}),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (s.endsWith("/api/show")) {
        return new Response(JSON.stringify({ capabilities: ["completion"] }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (s.endsWith("/api/ps")) {
        return new Response(
          JSON.stringify({ models: [
            { name: "qwen3:8b", size: 5_961_395_730, size_vram: 4_198_194_216 },
          ]}),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected: ${s}`);
    }) as unknown as typeof fetch);

    const server = boot();
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "models.list", id: "ps1" }));
    const msg = (await nextMessage(ws)) as ModelsMessage;

    const qwen = msg.entries.find((e) => e.model === "qwen3:8b");
    const llama = msg.entries.find((e) => e.model === "llama3.2:latest");

    // round(100 × 4198194216 / 5961395730) = round(70.42…) = 70
    expect(qwen?.gpuPercent).toBe(70);
    expect(llama?.gpuPercent).toBeUndefined();

    ws.close();
  });

  test("/api/ps down → no gpuPercent (no crash)", async () => {
    __overrideCapacityForTests({ ramGb: 16, vramGb: 6.4 });
    __setOllamaFetch((async (url: string, init?: RequestInit) => {
      const s = String(url);
      if (s.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "qwen3:4b", digest: "sha256:psdown", size: 2_500_000_000 }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (s.endsWith("/api/show")) {
        return new Response(JSON.stringify({ capabilities: ["completion"] }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (s.endsWith("/api/ps")) {
        throw new Error("simulated /api/ps failure");
      }
      throw new Error(`unexpected: ${s}`);
    }) as unknown as typeof fetch);

    const server = boot();
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "models.list", id: "psdown" }));
    const msg = (await nextMessage(ws)) as ModelsMessage;

    expect(msg.type).toBe("models");
    const entry = msg.entries.find((e) => e.model === "qwen3:4b");
    expect(entry).toBeDefined();
    expect(entry?.gpuPercent).toBeUndefined();

    ws.close();
  });
});
