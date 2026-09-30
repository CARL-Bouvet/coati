// Goal G6 (docs/PROTOCOL.md "Langue de la connexion") — dedicated coverage
// for broker/src/messages.ts (normalizeLang, catalog parity), the `hello.lang`
// negotiation end to end, and the reply-language instruction in model.ts's
// buildSystemPrompt/buildPrompt. Message TEXT is never asserted beyond the
// language under test's own known wording (see messages.ts's own header).

import { describe, expect, test, afterEach } from "bun:test";
import {
  normalizeLang,
  messageCodes,
  t,
  DEFAULT_LANG,
  SUPPORTED_LANGS,
  type Lang,
} from "../src/messages.ts";
import { buildPrompt, buildSystemPrompt, LANGUAGE_NAME } from "../src/model.ts";
import { startServer } from "../src/server.ts";
import { makeTmpDir } from "./helpers/tmp-dir.ts";
import { connectAndAuthV2 } from "./helpers/handshake-v2.ts";

describe("normalizeLang", () => {
  test("fr-family normalises to fr", () => {
    for (const raw of ["fr", "fr-FR", "fr-CA"]) {
      expect(normalizeLang(raw)).toBe("fr");
    }
  });

  test("Simplified-Chinese-leaning zh tags normalise to zh_CN", () => {
    for (const raw of ["zh", "zh-CN", "zh-Hans", "zh-SG", "zh-Hans-CN"]) {
      expect(normalizeLang(raw)).toBe("zh_CN");
    }
  });

  test("Traditional-Chinese-leaning zh tags fall through to en", () => {
    for (const raw of ["zh-TW", "zh-Hant", "zh-HK"]) {
      expect(normalizeLang(raw)).toBe("en");
    }
  });

  test("anything else (including missing/malformed) normalises to en", () => {
    const garbage: unknown[] = ["en-US", "de", "", undefined, "not-a-lang-tag", 42, null, {}];
    for (const raw of garbage) {
      expect(normalizeLang(raw as string | null | undefined)).toBe("en");
    }
  });
});

describe("catalog parity", () => {
  const PLACEHOLDER_RE = /\{[a-zA-Z0-9_]+\}/g;

  function placeholders(text: string): string[] {
    return [...text.matchAll(PLACEHOLDER_RE)].map((m) => m[0]).sort();
  }

  for (const code of messageCodes()) {
    test(`${code}: every supported lang has a non-empty string`, () => {
      for (const lang of SUPPORTED_LANGS) {
        const text = t(code, lang);
        expect(typeof text).toBe("string");
        expect(text.length).toBeGreaterThan(0);
      }
    });

    test(`${code}: same {placeholders} across fr, en, zh_CN`, () => {
      const enPh = placeholders(t(code, "en"));
      const frPh = placeholders(t(code, "fr"));
      const zhPh = placeholders(t(code, "zh_CN"));
      expect(frPh).toEqual(enPh);
      expect(zhPh).toEqual(enPh);
    });
  }
});

describe("hello negotiation — lang end to end", () => {
  const ALLOWED_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const KEY = Buffer.alloc(32, 0xab);

  let servers: ReturnType<typeof startServer>[] = [];
  afterEach(() => {
    for (const s of servers) s.stop(true);
    servers = [];
  });

  function boot() {
    const dataDir = makeTmpDir("coati-lang-e2e-");
    const server = startServer({ port: 0, allowedExtensionIds: [ALLOWED_ID] }, KEY, { dataDir });
    servers.push(server);
    return server;
  }

  // A representative status/error code that's easy to reach without a real
  // model call: `settings.test` for "claude-api" with no API key configured
  // resolves synchronously to messages.ts's "testConnection.noApiKey".
  async function testResultMessage(server: ReturnType<typeof boot>, lang?: string): Promise<string> {
    const auth = await connectAndAuthV2(`ws://127.0.0.1:${server.port}/ws`, `chrome-extension://${ALLOWED_ID}`, KEY, {
      lang,
    });
    expect(auth.ok).toBe(true);
    const ws = auth.ws;
    const message = await new Promise<any>((resolve) => {
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "settings.test-result") resolve(msg);
      });
      ws.send(JSON.stringify({ type: "settings.test", id: "t1", provider: "claude-api" }));
    });
    ws.close();
    return message.message as string;
  }

  test('hello.lang "fr-FR" yields the French human message', async () => {
    const server = boot();
    const msg = await testResultMessage(server, "fr-FR");
    expect(msg).toBe(t("testConnection.noApiKey", "fr"));
  });

  test("hello with no lang yields the English (default) message", async () => {
    const server = boot();
    const msg = await testResultMessage(server, undefined);
    expect(msg).toBe(t("testConnection.noApiKey", "en"));
  });
});

describe("reply-language instruction", () => {
  const LANGS: Lang[] = ["fr", "en", "zh_CN"];

  test("buildSystemPrompt names the target language", () => {
    for (const lang of LANGS) {
      const prompt = buildSystemPrompt("deadbeefdeadbeef", lang);
      expect(prompt).toContain(LANGUAGE_NAME[lang]);
    }
  });

  test("buildPrompt (summarize) names the target language", () => {
    for (const lang of LANGS) {
      const { prompt } = buildPrompt({ kind: "summarize", context: { kind: "page", title: "t", url: "https://example.com" } }, lang);
      expect(prompt.toUpperCase()).toContain(LANGUAGE_NAME[lang].toUpperCase());
    }
  });

  test("DEFAULT_LANG is en, matching buildSystemPrompt's own default", () => {
    expect(DEFAULT_LANG).toBe("en");
    expect(buildSystemPrompt("deadbeefdeadbeef")).toContain(LANGUAGE_NAME.en);
  });
});
