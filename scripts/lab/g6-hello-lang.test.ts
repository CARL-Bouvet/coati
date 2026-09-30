// G6 (docs/PROTOCOL.md amendement 2026-09-30 ter, "Langue de la connexion") —
// the extension's `hello` v: 2 message carries `lang` = raw
// chrome.i18n.getUILanguage(), straight from browser-stub-style chrome mock.
// Deliberately minimal and self-contained (own hand-rolled chrome/WebSocket
// mock, not broker/test/ext-service-worker-handshake.test.ts's shared one —
// this file lives under scripts/lab/ specifically so it never needs to touch
// broker/test/, same ownership split as the rest of G6). Only checks the
// FIRST `ws.send()` payload (the `hello` itself); it never completes the
// handshake, since that isn't what's under test here.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BACKGROUND_DIR = fileURLToPath(new URL("../../extension/background/", import.meta.url));
const SERVICE_WORKER_SOURCE = readFileSync(join(BACKGROUND_DIR, "service-worker.js"), "utf8");

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  private listeners: Record<string, Array<(ev: any) => void>> = {};

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: any) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
  // Test helper: simulate the socket opening.
  triggerOpen() {
    this.readyState = FakeWebSocket.OPEN;
    (this.listeners.open ?? []).forEach((fn) => fn({}));
  }
}

function makeSessionStore(seed: Record<string, unknown> = {}) {
  const store = { ...seed };
  return {
    get: (keys: string[]) => {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (k in store) out[k] = store[k];
      return Promise.resolve(out);
    },
    set: (items: Record<string, unknown>) => {
      Object.assign(store, items);
      return Promise.resolve();
    },
    remove: () => Promise.resolve(),
  };
}

let onMessageHandler: ((message: any, sender: any, sendResponse: (r?: any) => void) => unknown) | null;
let uiLanguage: string | undefined;

function makeChromeMock() {
  return {
    runtime: {
      id: "test-ext-id",
      getURL: (p: string) => `chrome-extension://test-ext-id/${p}`,
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: {
        addListener(fn: any) {
          onMessageHandler = fn;
        },
      },
      sendMessage() {
        return Promise.resolve();
      },
      sendNativeMessage() {
        return Promise.reject(new Error("not needed: a valid brokerKey is pre-seeded"));
      },
    },
    // hello.lang's whole point (docs/PROTOCOL.md, G6): raw
    // chrome.i18n.getUILanguage(), untouched, sent as-is.
    i18n: {
      getUILanguage: () => uiLanguage,
    },
    storage: {
      session: makeSessionStore({ brokerKey: "a".repeat(64) }),
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    contextMenus: {
      removeAll(cb?: () => void) {
        cb?.();
      },
      create() {},
      onClicked: { addListener() {} },
    },
  };
}

let importCounter = 0;
async function importServiceWorker() {
  importCounter++;
  const tmpPath = join(BACKGROUND_DIR, `.test-hello-lang-${process.pid}-${importCounter}.mjs`);
  writeFileSync(tmpPath, SERVICE_WORKER_SOURCE);
  try {
    await import(`file://${tmpPath}`);
  } finally {
    unlinkSync(tmpPath);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 4));
  }
}

const REAL_WEB_SOCKET = (globalThis as any).WebSocket;

beforeEach(() => {
  onMessageHandler = null;
  (globalThis as any).chrome = makeChromeMock();
  delete (globalThis as any).browser;
  (globalThis as any).WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];
});

afterEach(() => {
  (globalThis as any).WebSocket = REAL_WEB_SOCKET;
});

async function firstHelloPayload(): Promise<Record<string, unknown>> {
  await importServiceWorker();
  onMessageHandler!({ type: "coati:panel-ready" }, { id: "test-ext-id" }, () => {});
  await waitFor(() => FakeWebSocket.instances.length > 0);
  const sock = FakeWebSocket.instances[0];
  sock.triggerOpen();
  await waitFor(() => sock.sent.length > 0);
  return JSON.parse(sock.sent[0]);
}

describe("service-worker: hello.lang (G6, docs/PROTOCOL.md 'Langue de la connexion')", () => {
  test("carries the raw chrome.i18n.getUILanguage() value untouched", async () => {
    uiLanguage = "fr-FR";
    const hello = await firstHelloPayload();
    expect(hello.type).toBe("hello");
    expect(hello.lang).toBe("fr-FR");
  });

  test("another UI language: sent as-is, never normalised client-side", async () => {
    uiLanguage = "zh-CN";
    const hello = await firstHelloPayload();
    expect(hello.lang).toBe("zh-CN");
  });

  test("no chrome.i18n.getUILanguage() answer: hello omits lang rather than sending garbage", async () => {
    uiLanguage = undefined;
    const hello = await firstHelloPayload();
    expect("lang" in hello).toBe(false);
  });
});
