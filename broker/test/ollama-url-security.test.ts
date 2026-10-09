// notes/BUG_ollama_url_not_validated_and_redirects_followed_20261006.md —
// regression tests for the two gaps the bug named:
//   1. `ollamaUrl` validation: scheme http(s) only, no embedded credentials,
//      http restricted to loopback (localhost/127.0.0.0/8/[::1]) — mirrors
//      openai-compat's isAllowedBaseUrl, reused here as isAllowedOllamaUrl
//      (config.ts, to avoid a circular import with providers/ollama.ts).
//   2. Every fetch to Ollama uses `redirect: "error"` and treats a 3xx as a
//      failure, instead of following it.

import { describe, expect, test, afterEach } from "bun:test";
import { isAllowedOllamaUrl, loadConfig, DEFAULT_OLLAMA_URL } from "../src/config.ts";
import {
  ollamaProvider,
  __setFetchImplForTests,
  __resetFetchImplForTests,
} from "../src/providers/ollama.ts";
import { ModelUnavailableError, buildPrompt } from "../src/model.ts";
import { makeTmpDir } from "./helpers/tmp-dir.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

afterEach(() => {
  __resetFetchImplForTests();
});

// --- 1. isAllowedOllamaUrl — pure function ---------------------------------

describe("isAllowedOllamaUrl", () => {
  test("accepts loopback http (127.0.0.1, any 127.x, localhost, [::1])", () => {
    expect(isAllowedOllamaUrl("http://127.0.0.1:11434")).toBe(true);
    expect(isAllowedOllamaUrl("http://127.5.0.9:11434")).toBe(true);
    expect(isAllowedOllamaUrl("http://localhost:11434")).toBe(true);
    expect(isAllowedOllamaUrl("http://[::1]:11434")).toBe(true);
  });

  test("accepts https regardless of host (explicit user choice, encrypted)", () => {
    expect(isAllowedOllamaUrl("https://ollama.example.com:11434")).toBe(true);
  });

  test("rejects a non-loopback http host — would send page content off the machine", () => {
    expect(isAllowedOllamaUrl("http://192.168.1.20:11434")).toBe(false);
    expect(isAllowedOllamaUrl("http://ollama.example.com:11434")).toBe(false);
  });

  test("rejects a bad scheme", () => {
    expect(isAllowedOllamaUrl("ftp://127.0.0.1:11434")).toBe(false);
    expect(isAllowedOllamaUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedOllamaUrl("not a url")).toBe(false);
  });

  test("rejects embedded credentials, loopback or not", () => {
    expect(isAllowedOllamaUrl("http://user:pass@127.0.0.1:11434")).toBe(false);
    expect(isAllowedOllamaUrl("https://user:pass@ollama.example.com:11434")).toBe(false);
  });
});

// --- 2. loadConfig — rejects a bad ollamaUrl on disk ------------------------

function writeConfig(dir: string, body: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(body), { mode: 0o600 });
}

describe("loadConfig ollamaUrl validation", () => {
  test("a non-loopback http ollamaUrl in config.json is rejected, falls back to default", () => {
    const dir = makeTmpDir("coati-ollama-url-bad-");
    writeConfig(dir, { provider: "ollama", ollamaUrl: "http://192.168.1.20:11434" });
    const config = loadConfig({ configDir: dir, dataDir: dir });
    expect(config.ollamaUrl).toBe(DEFAULT_OLLAMA_URL);
  });

  test("a valid loopback ollamaUrl in config.json is kept", () => {
    const dir = makeTmpDir("coati-ollama-url-ok-");
    writeConfig(dir, { provider: "ollama", ollamaUrl: "http://127.0.0.1:22222" });
    const config = loadConfig({ configDir: dir, dataDir: dir });
    expect(config.ollamaUrl).toBe("http://127.0.0.1:22222");
  });

  test("an ollamaUrl with embedded credentials in config.json is rejected", () => {
    const dir = makeTmpDir("coati-ollama-url-creds-");
    writeConfig(dir, { provider: "ollama", ollamaUrl: "http://user:pass@127.0.0.1:11434" });
    const config = loadConfig({ configDir: dir, dataDir: dir });
    expect(config.ollamaUrl).toBe(DEFAULT_OLLAMA_URL);
  });
});

// --- 3. Runtime use-site rejection (defense in depth) -----------------------

describe("ollama provider rejects a disallowed ollamaUrl at use time", () => {
  test("isAvailable() reports unreachable for a non-loopback http url, never fetches", async () => {
    let fetchCalled = false;
    __setFetchImplForTests((async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }) as unknown as typeof fetch);

    const result = await ollamaProvider.isAvailable({ ollamaUrl: "http://192.168.1.20:11434" });
    expect(result.available).toBe(false);
    expect(fetchCalled).toBe(false);
  });

  test("checkStatus() reports ko for a non-loopback http url", async () => {
    const result = await ollamaProvider.checkStatus({ ollamaUrl: "http://192.168.1.20:11434" });
    expect(result.state).toBe("ko");
  });

  test("streamAnswer() throws ModelUnavailableError for a non-loopback http url, never fetches", async () => {
    let fetchCalled = false;
    __setFetchImplForTests((async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);

    const built = buildPrompt({ kind: "chat", text: "hi" });
    const iterator = ollamaProvider.streamAnswer(built, {
      model: "qwen3:8b",
      ollamaUrl: "http://192.168.1.20:11434",
    });
    await expect(
      (async () => {
        for await (const _ of iterator) {
          // drain
        }
      })(),
    ).rejects.toThrow(ModelUnavailableError);
    expect(fetchCalled).toBe(false);
  });
});

// --- 4. Redirects are refused, not followed ---------------------------------

describe("ollama provider refuses redirects", () => {
  test("/api/tags: a 307 from Ollama's own port is treated as unreachable, not followed", async () => {
    // redirect: "error" makes fetch() itself throw when the server tries to
    // redirect — simulate that exact behaviour, same as a real redirect
    // would surface through Bun's fetch.
    __setFetchImplForTests((async (url: string) => {
      if (String(url).endsWith("/api/tags")) {
        throw new TypeError("Fetch Request: fetch failed, redirect is not allowed");
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);

    const result = await ollamaProvider.isAvailable({ ollamaUrl: "http://127.0.0.1:11434" });
    expect(result.available).toBe(false);
  });

  test("/api/chat: a redirected response never reaches the stream parser", async () => {
    __setFetchImplForTests((async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "qwen3:8b", digest: "sha256:abc", size: 100 }] }),
          { status: 200 },
        );
      }
      if (u.endsWith("/api/show")) {
        return new Response(JSON.stringify({ capabilities: [] }), { status: 200 });
      }
      if (u.endsWith("/api/chat")) {
        // Confirm the request itself asks for redirect: "error" — the fix.
        expect((init as RequestInit & { redirect?: string })?.redirect).toBe("error");
        throw new TypeError("Fetch Request: fetch failed, redirect is not allowed");
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);

    const built = buildPrompt({ kind: "chat", text: "hi" });
    const iterator = ollamaProvider.streamAnswer(built, {
      model: "qwen3:8b",
      ollamaUrl: "http://127.0.0.1:11434",
    });
    await expect(
      (async () => {
        for await (const _ of iterator) {
          // drain
        }
      })(),
    ).rejects.toThrow(ModelUnavailableError);
  });
});
