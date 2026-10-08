// Lot C1 — protocol.ts wire-shape additions: chat.docSearch, settings.set
// (searchProvider/searchApiKey/clearKey), settings.test (target "search").

import { describe, expect, test } from "bun:test";
import { parseClientMessage, isValidOrigin } from "../src/protocol.ts";

describe("isValidOrigin", () => {
  test("accepts a bare https origin", () => expect(isValidOrigin("https://app.klingai.com")).toBe(true));
  test("accepts an origin with a port", () => expect(isValidOrigin("https://app.klingai.com:8443")).toBe(true));
  test("rejects a value carrying a path", () => expect(isValidOrigin("https://app.klingai.com/docs")).toBe(false));
  test("rejects a value carrying a query string", () => expect(isValidOrigin("https://a.com/?x=1")).toBe(false));
  test("rejects a malformed URL", () => expect(isValidOrigin("not a url")).toBe(false));
  test("rejects a non-string", () => expect(isValidOrigin(42)).toBe(false));
});

describe("chat.docSearch parsing", () => {
  test("parses a well-formed docSearch", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "chat", id: "c1", text: "hi", docSearch: { origin: "https://app.klingai.com" } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "chat") {
      expect(result.message.docSearch).toEqual({ origin: "https://app.klingai.com" });
    }
  });

  test("drops a docSearch with a path in origin — chat still goes through", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "chat", id: "c1", text: "hi", docSearch: { origin: "https://app.klingai.com/x" } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "chat") {
      expect(result.message.docSearch).toBeUndefined();
      expect(result.message.text).toBe("hi"); // the chat text itself is unaffected
    }
  });

  test("drops a malformed docSearch silently (not a bad-request)", () => {
    const result = parseClientMessage(JSON.stringify({ type: "chat", id: "c1", text: "hi", docSearch: "nope" }));
    expect(result.ok).toBe(true);
  });

  test("absent docSearch is simply absent", () => {
    const result = parseClientMessage(JSON.stringify({ type: "chat", id: "c1", text: "hi" }));
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "chat") {
      expect(result.message.docSearch).toBeUndefined();
    }
  });
});

describe("settings.set — search fields", () => {
  test("accepts searchProvider brave/tavily/empty", () => {
    for (const v of ["brave", "tavily", ""]) {
      const result = parseClientMessage(JSON.stringify({ type: "settings.set", id: "s1", searchProvider: v }));
      expect(result.ok).toBe(true);
    }
  });

  test("rejects an unknown searchProvider", () => {
    const result = parseClientMessage(JSON.stringify({ type: "settings.set", id: "s1", searchProvider: "google" }));
    expect(result.ok).toBe(false);
  });

  test("accepts a well-formed searchApiKey, including the empty-string 'forget' form", () => {
    const r1 = parseClientMessage(JSON.stringify({ type: "settings.set", id: "s1", searchApiKey: "abc123" }));
    expect(r1.ok).toBe(true);
    const r2 = parseClientMessage(JSON.stringify({ type: "settings.set", id: "s1", searchApiKey: "" }));
    expect(r2.ok).toBe(true);
  });

  test("rejects a searchApiKey with control characters", () => {
    const result = parseClientMessage(JSON.stringify({ type: "settings.set", id: "s1", searchApiKey: "abc\ndef" }));
    expect(result.ok).toBe(false);
  });

  test("accepts clearKey as an open ProviderId-shaped string", () => {
    for (const v of ["claude-api", "openai-compat", "brave", "tavily"]) {
      const result = parseClientMessage(JSON.stringify({ type: "settings.set", id: "s1", clearKey: v }));
      expect(result.ok).toBe(true);
      if (result.ok && result.message.type === "settings.set") {
        expect(result.message.clearKey).toBe(v);
      }
    }
  });

  test("settings.set with clearKey carries no other field", () => {
    const result = parseClientMessage(JSON.stringify({ type: "settings.set", id: "s1", clearKey: "claude-api" }));
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "settings.set") {
      expect(result.message.provider).toBeUndefined();
      expect(result.message.model).toBeUndefined();
    }
  });
});

describe("settings.test — target search", () => {
  test("parses target: search with a valid searchProvider", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "settings.test", id: "t1", target: "search", searchProvider: "brave" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "settings.test" && result.message.target === "search") {
      expect(result.message.searchProvider).toBe("brave");
    }
  });

  test("rejects target: search with no searchProvider", () => {
    const result = parseClientMessage(JSON.stringify({ type: "settings.test", id: "t1", target: "search" }));
    expect(result.ok).toBe(false);
  });

  test("target absent keeps today's model-provider shape, provider required", () => {
    const ok = parseClientMessage(JSON.stringify({ type: "settings.test", id: "t1", provider: "ollama" }));
    expect(ok.ok).toBe(true);
    const missing = parseClientMessage(JSON.stringify({ type: "settings.test", id: "t1" }));
    expect(missing.ok).toBe(false);
  });

  test("rejects an invalid target value", () => {
    const result = parseClientMessage(JSON.stringify({ type: "settings.test", id: "t1", target: "nope" }));
    expect(result.ok).toBe(false);
  });
});
