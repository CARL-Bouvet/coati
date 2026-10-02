// Service worker orchestration of the Native Messaging handshake v2
// (extension/background/service-worker.js) — docs/PROTOCOL.md amendement
// 2026-09-30, "Plan de test", bullet "Extension": a simulated
// `runtime.sendNativeMessage` + a simulated WebSocket, checking:
//   - the key is stored in storage.session (never storage.local) and reused
//     across a simulated service-worker restart without calling the host;
//   - a wrong broker proof: exactly one automatic retry, then
//     "broker-untrusted", nothing sent afterwards;
//   - a 4401: exactly one automatic retry, then "no-token";
//   - the legacy pasted-key path (host unreachable) has no retry available
//     (no host to re-call) and fails straight to the terminal state;
//   - a host that never answers at all (and no pasted key) → "no-host",
//     no WebSocket ever opened;
//   - "coati:set-pasted-key" validates its input (64 lowercase hex) and is
//     ignored from an untrusted sender.
//
// This drives the real module (dynamically imported, cache-busted per test
// so its module-level `let`s — ws, wsState, retriedThisCycle, backoffMs —
// start fresh) against a hand-written chrome/WebSocket stand-in. It does not
// open a real socket or spawn a real native-messaging host — that is the
// broker-side "Poignée de main Native Messaging simulée" plan instead.
//
// extension/lib/browser-compat.js resolves `export const api = ... chrome`
// ONCE, the first time IT is ever imported in this process, as a direct
// object reference — so every test below shares that SAME `chrome` mock
// object identity (created once, module scope) and resets its mutable
// fields in `beforeEach` rather than replacing the object itself, or a later
// test's service-worker import would silently keep talking to a stale mock.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BACKGROUND_DIR = fileURLToPath(new URL("../../extension/background/", import.meta.url));
const SERVICE_WORKER_SOURCE = readFileSync(join(BACKGROUND_DIR, "service-worker.js"), "utf8");

function hmacHex(keyHex: string, message: string): string {
  return createHmac("sha256", Buffer.from(keyHex, "hex")).update(message).digest("hex");
}

const brokerProof = (keyHex: string, cN: string, bN: string) => hmacHex(keyHex, `coati-v2-broker:${cN}:${bN}`);
const extensionProof = (keyHex: string, cN: string, bN: string) => hmacHex(keyHex, `coati-v2-extension:${cN}:${bN}`);

const HEX64_RE = /^[0-9a-f]{64}$/;
const KEY_A = "1".repeat(64);
const KEY_B = "2".repeat(64);
const WRONG_PROOF = "0".repeat(64); // never matches any real HMAC output below

// --- Fake WebSocket ---------------------------------------------------------

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closeCode: number | null = null;
  private listeners: Record<string, Array<(evt: any) => void>> = {};

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (evt: any) => void) {
    (this.listeners[type] ||= []).push(cb);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number) {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.closeCode = code ?? 1000;
    this.fire("close", { code: this.closeCode });
  }

  private fire(type: string, evt: any) {
    for (const cb of this.listeners[type] ?? []) cb(evt);
  }

  // --- test-only driving helpers ---
  triggerOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.fire("open", {});
  }
  triggerMessage(payload: unknown) {
    this.fire("message", { data: JSON.stringify(payload) });
  }
  sentMessages(): any[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

// --- Fake chrome.storage.session --------------------------------------------

function makeSessionStore() {
  const data: Record<string, unknown> = {};
  return {
    get(keys: string | string[]) {
      const out: Record<string, unknown> = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (k in data) out[k] = data[k];
      return Promise.resolve(out);
    },
    set(obj: Record<string, unknown>) {
      Object.assign(data, obj);
      return Promise.resolve();
    },
    remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
      return Promise.resolve();
    },
    dump() {
      return { ...data };
    },
  };
}

// --- Shared, single-instance chrome mock ------------------------------------
// See the file-level comment: this object is created once and reused for
// every test; only its fields are reset (see resetChromeMock()).

let broadcasts: any[];
let nativeMessageCalls: number;
let nativeMessageImpl: (app: string, message: unknown) => Promise<unknown>;
let onMessageHandler: ((message: any, sender: any, sendResponse: (r?: any) => void) => unknown) | null;
let sessionStore: ReturnType<typeof makeSessionStore>;

const chromeMock: any = {
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
    sendMessage(message: any) {
      broadcasts.push(message);
      return Promise.resolve();
    },
    sendNativeMessage(app: string, message: unknown) {
      nativeMessageCalls++;
      return nativeMessageImpl(app, message);
    },
  },
  storage: {
    get session() {
      return sessionStore;
    },
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

function resetChromeMock() {
  broadcasts = [];
  nativeMessageCalls = 0;
  nativeMessageImpl = async () => {
    throw new Error("no native host configured for this test");
  };
  onMessageHandler = null;
  sessionStore = makeSessionStore();
}

let importCounter = 0;

/** Fresh module instance against the CURRENT chromeMock — its module-level
 * `let`s (ws, wsState, retriedThisCycle, backoffMs) must start at their
 * initial values every time, exactly like a real service-worker restart.
 * `bun test` caches ESM modules by resolved path and ignores query-string
 * cache-busting (`?t=`) — verified empirically, unlike plain `bun -e`/Node.
 * So this writes the real source, verbatim, to a throwaway file in the SAME
 * directory (so its relative "../lib/..." imports keep resolving) under a
 * name unique per call, imports it, and deletes it immediately after — the
 * module is already loaded into memory by then. */
async function importServiceWorker() {
  importCounter++;
  const tmpPath = join(BACKGROUND_DIR, `.test-service-worker-${process.pid}-${importCounter}.mjs`);
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

function triggerConnect() {
  // Only "coati:panel-ready" calls connectIfNeeded() — "coati:get-status"
  // just reports the current state (see service-worker.js).
  onMessageHandler!({ type: "coati:panel-ready" }, { id: "test-ext-id" }, () => {});
}

function statusStates(): string[] {
  return broadcasts.filter((m) => m.type === "coati:status").map((m) => m.state);
}

// Bun's own built-in WebSocket (real network sockets) — other test files
// (firefox-pairing.test.ts, protocol.test.ts, ...) open real connections to
// a real broker server and need it back exactly as it was, not deleted:
// `delete globalThis.WebSocket` removes the built-in for the rest of the
// process, since it's an own property of globalThis, and there is no way to
// recreate it afterwards — a bug caught by running the full `bun test`
// suite, not just this file alone.
const REAL_WEB_SOCKET = (globalThis as any).WebSocket;

beforeEach(() => {
  resetChromeMock();
  (globalThis as any).chrome = chromeMock;
  delete (globalThis as any).browser; // isGecko stays false — see browser-compat.js
  (globalThis as any).WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];
  // Collapse the pairing retry delays to 0 ms so the 3-retry sequence
  // completes within waitFor's 1 s window (amendement 2026-10-02).
  (globalThis as any).__coatiTestRetryDelays__ = [0, 0, 0];
});

afterEach(() => {
  // Cancel any pending pairing-retry setTimeout so it doesn't fire in the
  // next test's context and corrupt nativeMessageCalls / FakeWebSocket state
  // (amendement 2026-10-02 — spaced retries are macrotasks).
  (globalThis as any).__coatiCancelPairingRetry__?.();
  (globalThis as any).WebSocket = REAL_WEB_SOCKET;
});

describe("service-worker: key storage and reuse", () => {
  test("a fresh connect calls the host once, stores brokerKey in storage.session", async () => {
    nativeMessageImpl = async (app, message) => {
      expect(app).toBe("com.getcoati.broker");
      expect(message).toEqual({ type: "key.get", v: 1 });
      return { type: "key", v: 1, key: KEY_A };
    };
    await importServiceWorker();
    triggerConnect();

    await waitFor(() => FakeWebSocket.instances.length === 1);
    expect(nativeMessageCalls).toBe(1);
    expect(sessionStore.dump()).toEqual({ brokerKey: KEY_A });

    const ws = FakeWebSocket.instances[0];
    ws.triggerOpen();
    const hello = ws.sentMessages()[0];
    expect(hello.type).toBe("hello");
    expect(hello.v).toBe(2);
    expect(hello.key).toBe("native");
    expect(HEX64_RE.test(hello.nonce)).toBe(true);
  });

  test("a simulated service-worker restart reuses the stored key without calling the host again", async () => {
    nativeMessageImpl = async () => ({ type: "key", v: 1, key: KEY_A });
    await importServiceWorker();
    triggerConnect();
    await waitFor(() => FakeWebSocket.instances.length === 1);
    expect(nativeMessageCalls).toBe(1);

    // "Restart": re-import the module fresh (module-level state gone) but
    // keep the SAME sessionStore — that persistence is the whole point of
    // chrome.storage.session surviving a service-worker restart.
    onMessageHandler = null;
    await importServiceWorker();
    triggerConnect();
    await waitFor(() => FakeWebSocket.instances.length === 2);

    expect(nativeMessageCalls).toBe(1); // still 1 — no second host call
    const hello = FakeWebSocket.instances[1].sentMessages();
    // hello isn't sent until "open" fires — nothing sent yet is expected here.
    expect(hello.length).toBe(0);
    FakeWebSocket.instances[1].triggerOpen();
    expect(FakeWebSocket.instances[1].sentMessages()[0].key).toBe("native");
  });

  test("host failure with nothing stored anywhere: no-host, no WebSocket ever opened", async () => {
    nativeMessageImpl = async () => {
      throw new Error("Specified native messaging host not found.");
    };
    await importServiceWorker();
    triggerConnect();

    await waitFor(() => statusStates().includes("no-host"));
    expect(FakeWebSocket.instances.length).toBe(0);
  });
});

describe("service-worker: wrong broker proof (close 4000)", () => {
  // amendement 2026-10-02: up to 3 retries (delays collapsed to 0 ms via
  // __coatiTestRetryDelays__ — see beforeEach).
  test("retries 3 times via the host, then broker-untrusted — nothing sent after any failure", async () => {
    let hostCall = 0;
    nativeMessageImpl = async () => {
      hostCall++;
      return { type: "key", v: 1, key: (hostCall % 2 === 1 ? KEY_A : KEY_B) };
    };
    await importServiceWorker();
    triggerConnect();

    // Drive 4 WS connections: initial + 3 retries.  Each gets a wrong proof.
    for (let i = 1; i <= 4; i++) {
      await waitFor(() => FakeWebSocket.instances.length === i);
      const ws = FakeWebSocket.instances[i - 1];
      ws.triggerOpen();
      ws.triggerMessage({ type: "challenge", v: 2, nonce: "b".repeat(64), proof: WRONG_PROOF });
      await waitFor(() => ws.readyState === FakeWebSocket.CLOSED);
      expect(ws.sentMessages().length).toBe(1); // hello only — no auth sent
      expect(ws.closeCode).toBe(4000);
      if (i < 4) {
        // Between retries the state must pass through "pairing-retry".
        await waitFor(() => statusStates().includes("pairing-retry"));
      }
    }

    await waitFor(() => statusStates().includes("broker-untrusted"));
    expect(FakeWebSocket.instances.length).toBe(4); // exactly initial + 3 retries
    expect(nativeMessageCalls).toBe(4); // each retry re-calls the host
    expect(sessionStore.dump().brokerKey).toBeUndefined(); // cleared
  });

  test("a correct broker proof gets an auth reply, and hello-ok reaches 'connected'", async () => {
    nativeMessageImpl = async () => ({ type: "key", v: 1, key: KEY_A });
    await importServiceWorker();
    triggerConnect();
    await waitFor(() => FakeWebSocket.instances.length === 1);

    const ws = FakeWebSocket.instances[0];
    ws.triggerOpen();
    const cN = ws.sentMessages()[0].nonce;
    const bN = "b".repeat(64);
    const bP = brokerProof(KEY_A, cN, bN);
    ws.triggerMessage({ type: "challenge", v: 2, nonce: bN, proof: bP });

    await waitFor(() => ws.sentMessages().length === 2);
    const auth = ws.sentMessages()[1];
    expect(auth.type).toBe("auth");
    expect(auth.proof).toBe(extensionProof(KEY_A, cN, bN));

    ws.triggerMessage({ type: "hello-ok", v: 2 });
    await waitFor(() => statusStates().includes("connected"));
    // hello-ok never carries a key back to the extension (docs/PROTOCOL.md).
    expect(broadcasts.some((m) => JSON.stringify(m).includes(KEY_A))).toBe(false);
  });
});

describe("service-worker: 4401 (auth/origin refused)", () => {
  // amendement 2026-10-02: 3 retries, "pairing-retry" state between each.
  test("retries 3 times via the host, then no-token; pairing-retry shown between each attempt", async () => {
    let hostCall = 0;
    nativeMessageImpl = async () => {
      hostCall++;
      return { type: "key", v: 1, key: hostCall % 2 === 1 ? KEY_A : KEY_B };
    };
    await importServiceWorker();
    triggerConnect();

    for (let i = 1; i <= 4; i++) {
      await waitFor(() => FakeWebSocket.instances.length === i);
      const ws = FakeWebSocket.instances[i - 1];
      ws.triggerOpen();
      ws.close(4401);
      await waitFor(() => ws.readyState === FakeWebSocket.CLOSED);
      if (i < 4) {
        await waitFor(() => statusStates().includes("pairing-retry"));
      }
    }

    await waitFor(() => statusStates().includes("no-token"));
    expect(FakeWebSocket.instances.length).toBe(4);
    expect(nativeMessageCalls).toBe(4);
    expect(sessionStore.dump().brokerKey).toBeUndefined();
  });
});

describe("service-worker: pairing-retry — counter reset on hello-ok", () => {
  // amendement 2026-10-02: after a hello-ok, the retry budget resets so the
  // very next 4401 gets 3 fresh retries (not zero because they were "used up").
  test("a 4401 after hello-ok gets a fresh 3-retry budget (4 WS total, ends no-token)", async () => {
    nativeMessageImpl = async () => ({ type: "key", v: 1, key: KEY_A });
    await importServiceWorker();
    triggerConnect();
    await waitFor(() => FakeWebSocket.instances.length === 1);

    // First cycle: complete a valid handshake so hello-ok fires and the budget
    // resets to 0.
    const ws1 = FakeWebSocket.instances[0];
    ws1.triggerOpen();
    const cN = ws1.sentMessages()[0].nonce;
    const bN = "b".repeat(64);
    ws1.triggerMessage({ type: "challenge", v: 2, nonce: bN, proof: brokerProof(KEY_A, cN, bN) });
    await waitFor(() => ws1.sentMessages().length === 2);
    ws1.triggerMessage({ type: "hello-ok", v: 2 });
    await waitFor(() => statusStates().includes("connected"));

    // Second cycle: close with 4401 — should get 3 more retries (not 0)
    // because hello-ok reset the counter, proving the "fresh budget" invariant.
    ws1.close(4401);
    // Drive 3 retries: each retry creates a new WS, we close it with 4401.
    for (let i = 2; i <= 4; i++) {
      await waitFor(() => FakeWebSocket.instances.length === i);
      const ws = FakeWebSocket.instances[i - 1];
      ws.triggerOpen();
      ws.close(4401);
    }
    // 4th attempt (initial + 3 retries) exhausted → no-token.
    await waitFor(() => statusStates().includes("no-token"));
    expect(FakeWebSocket.instances.length).toBe(4); // 1 connected + 3 retries
    expect(nativeMessageCalls).toBe(4); // each retry re-calls the host
    expect(sessionStore.dump().brokerKey).toBeUndefined();
  });
});

describe("service-worker: legacy pasted key (host unreachable)", () => {
  test("used only because the host call fails; a wrong proof fails straight to broker-untrusted (no host to retry)", async () => {
    nativeMessageImpl = async () => {
      throw new Error("Specified native messaging host not found.");
    };
    await importServiceWorker();
    await sessionStore.set({ pastedKey: KEY_A });
    triggerConnect();

    await waitFor(() => FakeWebSocket.instances.length === 1);
    expect(nativeMessageCalls).toBe(1); // host WAS tried first, and failed

    const ws = FakeWebSocket.instances[0];
    ws.triggerOpen();
    expect(ws.sentMessages()[0].key).toBe("pasted");
    ws.triggerMessage({ type: "challenge", v: 2, nonce: "b".repeat(64), proof: WRONG_PROOF });

    await waitFor(() => statusStates().includes("broker-untrusted"));
    expect(FakeWebSocket.instances.length).toBe(1); // no retry — nothing to re-call
    expect(sessionStore.dump().pastedKey).toBeUndefined();
  });
});

describe("service-worker: coati:set-pasted-key", () => {
  test("stores a valid 64-hex key from a trusted sender and reconnects", async () => {
    nativeMessageImpl = async () => {
      throw new Error("no host in this test");
    };
    await importServiceWorker();
    let response: any;
    await new Promise<void>((resolve) => {
      const kept = onMessageHandler!(
        { type: "coati:set-pasted-key", key: KEY_A.toUpperCase() },
        { id: "test-ext-id", url: "chrome-extension://test-ext-id/options.html" },
        (r: any) => {
          response = r;
          resolve();
        },
      );
      expect(kept).toBe(true); // channel kept open for the async sendResponse
    });
    expect(response).toEqual({ ok: true });
    expect(sessionStore.dump().pastedKey).toBe(KEY_A); // lowercased
  });

  test("rejects a value that isn't 64 hex chars, without storing it", async () => {
    await importServiceWorker();
    let response: any;
    await new Promise<void>((resolve) => {
      onMessageHandler!(
        { type: "coati:set-pasted-key", key: "not-a-valid-secret" },
        { id: "test-ext-id", url: "chrome-extension://test-ext-id/options.html" },
        (r: any) => {
          response = r;
          resolve();
        },
      );
    });
    expect(response).toEqual({ ok: false });
    expect(sessionStore.dump().pastedKey).toBeUndefined();
  });

  test("is ignored from an untrusted sender (forged sender.id)", async () => {
    await importServiceWorker();
    let called = false;
    const result = onMessageHandler!(
      { type: "coati:set-pasted-key", key: KEY_A },
      { id: "some-other-extension-id", url: "chrome-extension://some-other-extension-id/x.html" },
      () => {
        called = true;
      },
    );
    expect(result).toBeUndefined();
    expect(called).toBe(false);
    expect(sessionStore.dump().pastedKey).toBeUndefined();
  });
});

describe("service-worker: broker proof required before trusting anything (final security review, I3)", () => {
  test("hello-ok before challenge → no connected, pending request not sent, socket closed 4000", async () => {
    nativeMessageImpl = async () => ({ type: "key", v: 1, key: KEY_A });
    await importServiceWorker();
    triggerConnect();
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const ws = FakeWebSocket.instances[0];
    ws.triggerOpen();

    // Hold a pending request while still mid-handshake — must never reach
    // the wire on the strength of an unverified hello-ok.
    onMessageHandler!(
      { type: "coati:client-message", payload: { id: "req-1", type: "prompt" } },
      { id: "test-ext-id", url: "chrome-extension://test-ext-id/panel.html" },
      () => {},
    );

    // hello-ok arrives WITHOUT a prior challenge — brokerVerified is still false.
    ws.triggerMessage({ type: "hello-ok", v: 2 });

    expect(ws.closeCode).toBe(4000);
    expect(statusStates()).not.toContain("connected");
    // Only `hello` was ever sent — no auth, and the pending request never went out.
    const sent = ws.sentMessages();
    expect(sent.length).toBe(1);
    expect(sent[0].type).toBe("hello");
    expect(sent.some((m) => m.id === "req-1")).toBe(false);
  });

  test("chunk before challenge → not broadcast, socket closed 4000", async () => {
    nativeMessageImpl = async () => ({ type: "key", v: 1, key: KEY_A });
    await importServiceWorker();
    triggerConnect();
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const ws = FakeWebSocket.instances[0];
    ws.triggerOpen();

    ws.triggerMessage({ type: "chunk", id: "req-1", text: "leaked" });
    expect(ws.closeCode).toBe(4000);
    expect(broadcasts.some((m) => m.type === "coati:broker-message")).toBe(false);
  });

  test("prompts before challenge → not broadcast, socket closed 4000", async () => {
    nativeMessageImpl = async () => ({ type: "key", v: 1, key: KEY_A });
    await importServiceWorker();
    triggerConnect();
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const ws = FakeWebSocket.instances[0];
    ws.triggerOpen();

    ws.triggerMessage({ type: "prompts", id: "req-1", prompts: ["x"] });
    expect(ws.closeCode).toBe(4000);
    expect(broadcasts.some((m) => m.type === "coati:broker-message")).toBe(false);
  });

  test("a second challenge (racing the first, before verification settles) is ignored and closes the socket", async () => {
    nativeMessageImpl = async () => ({ type: "key", v: 1, key: KEY_A });
    await importServiceWorker();
    triggerConnect();
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const ws = FakeWebSocket.instances[0];
    ws.triggerOpen();
    const cN = ws.sentMessages()[0].nonce;
    const bN = "b".repeat(64);
    const bP = brokerProof(KEY_A, cN, bN);

    // First challenge starts async verification (handshakeSettled flips
    // synchronously, before verifyHmacHex's crypto.subtle call resolves).
    ws.triggerMessage({ type: "challenge", v: 2, nonce: bN, proof: bP });
    // Fired synchronously right after — handshakeSettled is already true, so
    // this one is refused outright rather than starting a parallel verify.
    ws.triggerMessage({ type: "challenge", v: 2, nonce: bN, proof: bP });

    expect(ws.closeCode).toBe(4000);
    // Never reaches "connected" even though the first challenge's proof was
    // objectively correct — the socket was already closed by the second one.
    await new Promise((r) => setTimeout(r, 20)); // let the pending verify settle
    expect(statusStates()).not.toContain("connected");
  });
});

describe("service-worker: invariants", () => {
  test("coati:get-status never returns brokerKey/pastedKey", async () => {
    nativeMessageImpl = async () => ({ type: "key", v: 1, key: KEY_A });
    await importServiceWorker();
    let response: any;
    onMessageHandler!({ type: "coati:get-status" }, { id: "test-ext-id" }, (r: any) => {
      response = r;
    });
    expect(Object.keys(response ?? {}).sort()).toEqual(["state", "workerInstanceId"].sort());
  });

  test("storage.local is never touched by this file (no such API in the mock at all)", async () => {
    expect(chromeMock.storage.local).toBeUndefined();
    nativeMessageImpl = async () => ({ type: "key", v: 1, key: KEY_A });
    await importServiceWorker();
    triggerConnect();
    await waitFor(() => FakeWebSocket.instances.length === 1);
    // No throw above ⇒ service-worker.js never dereferenced storage.local.
  });
});
