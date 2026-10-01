// U1 (the language selector design notes, "Technique du
// sélecteur") — extension/lib/i18n.js's runtime loader: placeholder
// resolution (positional AND named, chrome.i18n-style), the en-then-key
// fallback chain, and the live re-render triggered by a `uiLang`
// chrome.storage.local change. Key parity across _locales/<lang>/ is
// covered by scripts/lab/g6-i18n.test.ts; hello.lang's own choice of
// language by scripts/lab/g6-hello-lang.test.ts.
//
// Each test imports extension/lib/i18n.js fresh (cache-busting query
// string) against its own `globalThis.chrome` mock: the module runs its
// loader as a side effect of being imported, so a shared instance across
// tests would leak state between them.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("../../extension/", import.meta.url));

type Mock = {
  chrome: any;
  setPref(value: string | undefined): Promise<void>;
};

function makeChromeMock(opts: { browserLang?: string; uiLangPref?: string; getMessage?: (key: string) => string } = {}): Mock {
  const localStore: Record<string, unknown> = {};
  if (opts.uiLangPref !== undefined) localStore.uiLang = opts.uiLangPref;
  const onChangedListeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];

  const chrome = {
    i18n: {
      getUILanguage: () => opts.browserLang,
      getMessage: opts.getMessage ?? ((key: string) => key),
    },
    runtime: {
      // Real files, straight off disk — Bun's fetch() supports file: URLs.
      getURL: (path: string) => `file://${join(EXT, path)}`,
    },
    storage: {
      local: {
        get: (keys: unknown) => {
          if (keys == null) return Promise.resolve({ ...localStore });
          const list = typeof keys === "string" ? [keys] : (keys as string[]);
          const out: Record<string, unknown> = {};
          for (const k of list) if (k in localStore) out[k] = localStore[k];
          return Promise.resolve(out);
        },
        set: (items: Record<string, unknown>) => {
          Object.assign(localStore, items);
          const changes: Record<string, unknown> = {};
          for (const k of Object.keys(items)) changes[k] = { newValue: items[k] };
          onChangedListeners.forEach((fn) => fn(changes, "local"));
          return Promise.resolve();
        },
      },
      onChanged: {
        addListener: (fn: (changes: Record<string, unknown>, area: string) => void) => {
          onChangedListeners.push(fn);
        },
      },
    },
  };

  return {
    chrome,
    setPref: (value) => (chrome.storage.local as any).set({ uiLang: value }),
  };
}

let importCounter = 0;
/** Fresh module instance per test — see the header comment. */
async function freshI18n() {
  importCounter++;
  const mod = await import(`../../extension/lib/i18n.js?t=${process.pid}-${importCounter}`);
  return mod as typeof import("../../extension/lib/i18n.js");
}

function waitForLangLoad(i18n: any): Promise<string> {
  return new Promise((resolve) => {
    i18n.onLanguageChange((lang: string) => {
      if (lang) resolve(lang);
    });
  });
}

const REAL_CHROME = (globalThis as any).chrome;

afterEach(() => {
  (globalThis as any).chrome = REAL_CHROME;
});

describe("i18n.js runtime loader — resolves to the stored/browser language", () => {
  test("uiLang 'auto' (default): follows the browser's own UI language", async () => {
    const { chrome } = makeChromeMock({ browserLang: "fr-FR" });
    (globalThis as any).chrome = chrome;
    const i18n = await freshI18n();
    const lang = await waitForLangLoad(i18n);
    expect(lang).toBe("fr");
    expect(i18n.t("panel_settings_title")).toBe("Réglages");
  });

  test("uiLang explicitly set: overrides the browser's UI language", async () => {
    const { chrome } = makeChromeMock({ browserLang: "fr-FR", uiLangPref: "en" });
    (globalThis as any).chrome = chrome;
    const i18n = await freshI18n();
    const lang = await waitForLangLoad(i18n);
    expect(lang).toBe("en");
    expect(i18n.t("panel_settings_title")).toBe("Settings");
  });
});

describe("i18n.js runtime loader — placeholders", () => {
  test("positional $NAME$ resolved via the placeholders map's $1/$2 content", async () => {
    const { chrome } = makeChromeMock({ browserLang: "en" });
    (globalThis as any).chrome = chrome;
    const i18n = await freshI18n();
    await waitForLangLoad(i18n);
    expect(i18n.t("common_error_detail", "connection refused")).toBe("Detail: connection refused");
  });

  test("two placeholders in message order, each resolved by name, not blind encounter order", async () => {
    const { chrome } = makeChromeMock({ browserLang: "en" });
    (globalThis as any).chrome = chrome;
    const i18n = await freshI18n();
    await waitForLangLoad(i18n);
    expect(i18n.t("panel_provider_status_line", ["Ollama (local)", "ready"])).toBe("Ollama (local): ready");
  });
});

describe("i18n.js runtime loader — fallback chain", () => {
  test("fetch failure (bad runtime.getURL): falls back to chrome.i18n.getMessage", async () => {
    const chrome = {
      i18n: {
        getUILanguage: () => "en",
        getMessage: (key: string) => (key === "panel_settings_title" ? "Settings (stub)" : key),
      },
      runtime: { getURL: (path: string) => `file:///nonexistent/${path}` },
      storage: { local: { get: () => Promise.resolve({}) }, onChanged: { addListener: () => {} } },
    };
    (globalThis as any).chrome = chrome;
    const i18n = await freshI18n();
    // No successful load ever happens here — give the failed fetch a turn,
    // then assert the synchronous chrome.i18n fallback, not onLanguageChange
    // (which never fires: runtimeState.lang stays null on a load failure).
    await new Promise((r) => setTimeout(r, 20));
    expect(i18n.t("panel_settings_title")).toBe("Settings (stub)");
  });

  test("unknown key with no extension runtime at all: returns the bare key", async () => {
    delete (globalThis as any).chrome;
    delete (globalThis as any).browser;
    const i18n = await freshI18n();
    expect(i18n.t("this_key_does_not_exist")).toBe("this_key_does_not_exist");
  });
});

describe("i18n.js runtime loader — live preference switch (storage.onChanged)", () => {
  test("setUiLangPreference() reloads the catalog and notifies onLanguageChange listeners", async () => {
    const { chrome, setPref } = makeChromeMock({ browserLang: "en" });
    (globalThis as any).chrome = chrome;
    const i18n = await freshI18n();
    await waitForLangLoad(i18n);
    expect(i18n.t("panel_settings_title")).toBe("Settings");

    const nextLang = new Promise((resolve) => {
      let first = true;
      i18n.onLanguageChange((lang: string) => {
        if (first) {
          first = false; // the immediate replay with the current language
          return;
        }
        resolve(lang);
      });
    });
    await setPref("fr");
    await nextLang;
    expect(i18n.t("panel_settings_title")).toBe("Réglages");
  });

  test("applyI18n()'s root is re-rendered automatically once the language changes", async () => {
    const { chrome, setPref } = makeChromeMock({ browserLang: "en" });
    (globalThis as any).chrome = chrome;
    const i18n = await freshI18n();
    await waitForLangLoad(i18n);

    const root = { children: [] } as any;
    const el = {
      getAttribute: (attr: string) => (attr === "data-i18n" ? "panel_settings_title" : null),
      setAttribute: () => {},
      set textContent(v: string) {
        (el as any)._text = v;
      },
      get textContent() {
        return (el as any)._text;
      },
    };
    root.querySelectorAll = (sel: string) => (sel === "[data-i18n]" ? [el] : []);
    i18n.applyI18n(root);
    expect((el as any)._text).toBe("Settings");

    const rerendered = new Promise<void>((resolve) => {
      let first = true;
      i18n.onLanguageChange(() => {
        if (first) {
          first = false;
          return;
        }
        resolve();
      });
    });
    await setPref("fr");
    await rerendered;
    expect((el as any)._text).toBe("Réglages");
  });
});
