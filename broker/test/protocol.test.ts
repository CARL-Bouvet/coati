import { describe, expect, test } from "bun:test";
import { parseClientMessage, MAX_MESSAGE_BYTES } from "../src/protocol.ts";

describe("parseClientMessage", () => {
  const NONCE = "a".repeat(64);

  test("parses a valid hello message (v: 2, key defaults to undefined)", () => {
    const result = parseClientMessage(JSON.stringify({ type: "hello", v: 2, nonce: NONCE }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toEqual({ type: "hello", v: 2, nonce: NONCE, key: undefined });
    }
  });

  test("parses a hello message with key: pasted", () => {
    const result = parseClientMessage(JSON.stringify({ type: "hello", v: 2, nonce: NONCE, key: "pasted" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toEqual({ type: "hello", v: 2, nonce: NONCE, key: "pasted" });
    }
  });

  test("rejects a hello with v: 1 — the v: 1 handshake no longer exists", () => {
    const result = parseClientMessage(JSON.stringify({ type: "hello", v: 1, secret: "abc123" }));
    expect(result.ok).toBe(false);
  });

  test("rejects a hello with an invalid key value", () => {
    const result = parseClientMessage(JSON.stringify({ type: "hello", v: 2, nonce: NONCE, key: "made-up" }));
    expect(result.ok).toBe(false);
  });

  test("parses a valid auth message", () => {
    const result = parseClientMessage(JSON.stringify({ type: "auth", v: 2, proof: NONCE }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toEqual({ type: "auth", v: 2, proof: NONCE });
    }
  });

  test("parses a valid chat message with context", () => {
    const raw = JSON.stringify({
      type: "chat",
      id: "c1",
      text: "hello there",
      context: { kind: "page", url: "https://example.com", title: "Ex", text: "body" },
    });
    const result = parseClientMessage(raw);
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "chat") {
      expect(result.message.id).toBe("c1");
      expect(result.message.text).toBe("hello there");
      expect(result.message.context?.kind).toBe("page");
    }
  });

  test("parses a valid summarize message", () => {
    const raw = JSON.stringify({
      type: "summarize",
      id: "c2",
      context: { kind: "youtube", videoId: "abc" },
    });
    const result = parseClientMessage(raw);
    expect(result.ok).toBe(true);
  });

  // `length` removed from the protocol (KISS audit 2026-09-26, item H): a
  // client that still sends it is not an error — the field is just ignored.
  test("a stray 'length' field on summarize is ignored, not rejected", () => {
    const raw = JSON.stringify({
      type: "summarize",
      id: "c2b",
      context: { kind: "youtube", videoId: "abc" },
      length: "short",
    });
    const result = parseClientMessage(raw);
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "summarize") {
      expect((result.message as Record<string, unknown>).length).toBeUndefined();
    }
  });

  test("parses a valid act message", () => {
    const raw = JSON.stringify({
      type: "act",
      id: "c3",
      action: "translate",
      text: "bonjour",
      params: { targetLang: "en" },
    });
    const result = parseClientMessage(raw);
    expect(result.ok).toBe(true);
  });

  test("parses prompts.list / save (create) / delete / cancel", () => {
    expect(parseClientMessage(JSON.stringify({ type: "prompts.list", id: "c4" })).ok).toBe(true);
    const save = parseClientMessage(
      JSON.stringify({ type: "prompts.save", id: "c5", prompt: { site: "@youtube", title: "n", body: "b" } }),
    );
    expect(save.ok).toBe(true);
    if (save.ok && save.message.type === "prompts.save") {
      expect(save.message.prompt).toEqual({ id: undefined, site: "@youtube", title: "n", body: "b" });
    }
    expect(
      parseClientMessage(JSON.stringify({ type: "prompts.delete", id: "c6", promptId: "p_000000000000" })).ok,
    ).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: "cancel", id: "c7", target: "c2" })).ok).toBe(true);
  });

  test("parses prompts.save (update by id), site is carried but ignored server-side", () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: "prompts.save",
        id: "c5b",
        prompt: { id: "p_abcdef012345", site: "@youtube", body: "b2" },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "prompts.save") {
      expect(result.message.prompt.id).toBe("p_abcdef012345");
    }
  });

  test("prompts.save trims title, empty title becomes absent", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "prompts.save", id: "c5c", prompt: { site: "*", title: "  ", body: "b" } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "prompts.save") {
      expect(result.message.prompt.title).toBeUndefined();
    }
  });

  test("prompts.save rejects an invalid site key", () => {
    for (const site of ["www.x.com", "../x", "A B", "x".repeat(300)]) {
      const result = parseClientMessage(
        JSON.stringify({ type: "prompts.save", id: "c5d", prompt: { site, body: "b" } }),
      );
      expect(result.ok).toBe(false);
    }
  });

  test("prompts.save rejects an empty or missing body", () => {
    expect(
      parseClientMessage(JSON.stringify({ type: "prompts.save", id: "c5e", prompt: { site: "*", body: "" } })).ok,
    ).toBe(false);
    expect(
      parseClientMessage(JSON.stringify({ type: "prompts.save", id: "c5f", prompt: { site: "*" } })).ok,
    ).toBe(false);
  });

  test("prompts.save rejects a body or title over the length cap", () => {
    expect(
      parseClientMessage(
        JSON.stringify({ type: "prompts.save", id: "c5g", prompt: { site: "*", body: "x".repeat(8001) } }),
      ).ok,
    ).toBe(false);
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "prompts.save",
          id: "c5h",
          prompt: { site: "*", title: "x".repeat(121), body: "b" },
        }),
      ).ok,
    ).toBe(false);
  });

  test("prompts.delete rejects a missing or malformed promptId", () => {
    expect(parseClientMessage(JSON.stringify({ type: "prompts.delete", id: "c6b" })).ok).toBe(false);
    expect(
      parseClientMessage(JSON.stringify({ type: "prompts.delete", id: "c6c", promptId: "not-an-id" })).ok,
    ).toBe(false);
  });

  test("parses prompts.move", () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: "prompts.move",
        id: "c6d",
        promptId: "p_000000000000",
        site: "crisco4.unicaen.fr",
        order: ["p_000000000000", "coati:youtube:key-points"],
      }),
    );
    expect(result.ok).toBe(true);
  });

  test("prompts.move rejects an invalid order item and an oversized order", () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "prompts.move",
          id: "c6e",
          promptId: "p_000000000000",
          site: "*",
          order: ["not-an-id"],
        }),
      ).ok,
    ).toBe(false);
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "prompts.move",
          id: "c6f",
          promptId: "p_000000000000",
          site: "*",
          order: Array.from({ length: 201 }, (_, i) => `p_${String(i).padStart(12, "0")}`),
        }),
      ).ok,
    ).toBe(false);
  });

  test("parses prefs.get and prefs.set", () => {
    expect(parseClientMessage(JSON.stringify({ type: "prefs.get", id: "c8" })).ok).toBe(true);
    const result = parseClientMessage(
      JSON.stringify({
        type: "prefs.set",
        id: "c8b",
        site: "@youtube",
        prefs: { order: ["p_000000000000"], removed: ["coati:youtube:further"] },
      }),
    );
    expect(result.ok).toBe(true);
  });

  test("prefs.set rejects an invalid site key", () => {
    for (const site of ["www.x.com", "../x", "A B"]) {
      const result = parseClientMessage(
        JSON.stringify({ type: "prefs.set", id: "c8c", site, prefs: {} }),
      );
      expect(result.ok).toBe(false);
    }
  });

  test("rejects unknown type", () => {
    const result = parseClientMessage(JSON.stringify({ type: "nonsense", id: "c1" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("bad-request");
    }
  });

  test("rejects oversized payload", () => {
    const bigText = "x".repeat(MAX_MESSAGE_BYTES + 1);
    const raw = JSON.stringify({ type: "chat", id: "c1", text: bigText });
    const result = parseClientMessage(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("bad-request");
    }
  });

  test("rejects message missing id (non-hello)", () => {
    const result = parseClientMessage(JSON.stringify({ type: "chat", text: "hi" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("bad-request");
      expect(result.error.message).toContain("id");
    }
  });

  test("rejects invalid JSON", () => {
    const result = parseClientMessage("{not json");
    expect(result.ok).toBe(false);
  });

  test("rejects hello with a missing nonce", () => {
    const result = parseClientMessage(JSON.stringify({ type: "hello", v: 2 }));
    expect(result.ok).toBe(false);
  });

  test("rejects hello with a non-string nonce", () => {
    const result = parseClientMessage(JSON.stringify({ type: "hello", v: 2, nonce: 42 }));
    expect(result.ok).toBe(false);
  });

  test("parses settings.get", () => {
    const result = parseClientMessage(JSON.stringify({ type: "settings.get", id: "s1" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toEqual({ type: "settings.get", id: "s1" });
    }
  });

  test("parses settings.set with a known provider and a model", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "settings.set", id: "s2", provider: "ollama", model: "llama3.2" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toEqual({ type: "settings.set", id: "s2", provider: "ollama", model: "llama3.2" });
    }
  });

  test("parses settings.set with only a model, provider omitted", () => {
    const result = parseClientMessage(JSON.stringify({ type: "settings.set", id: "s3", model: "llama3.2" }));
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "settings.set") {
      expect(result.message.provider).toBeUndefined();
      expect(result.message.model).toBe("llama3.2");
    }
  });

  // Amendement 2026-09-29: `provider` is an open string (docs/PROTOCOL.md) —
  // parseClientMessage only rejects a malformed SHAPE, not an id outside a
  // closed list (a well-shaped but unknown id is accepted here and reported
  // unavailable later, by settings.get/provider.status — see server.ts).
  test("accepts settings.set with a well-shaped but unknown provider id", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "settings.set", id: "s4", provider: "openai-nonexistent" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "settings.set") {
      expect(result.message.provider).toBe("openai-nonexistent");
    }
  });

  test("rejects settings.set with a malformed provider (empty string)", () => {
    const result = parseClientMessage(JSON.stringify({ type: "settings.set", id: "s4b", provider: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("bad-request");
      expect(result.error.id).toBe("s4b");
    }
  });

  test("rejects settings.set with a non-string model", () => {
    const result = parseClientMessage(JSON.stringify({ type: "settings.set", id: "s5", model: 42 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("bad-request");
    }
  });
});
