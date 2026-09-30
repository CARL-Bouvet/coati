// Native Messaging call to the local host (extension/lib/native-host.js) —
// docs/PROTOCOL.md amendement 2026-09-30, "Cadrage et échange avec l'hôte".
// `api.runtime.sendNativeMessage` is mocked here; the real browser API is
// exercised by the broker-side simulated-handshake test plan (see
// PROTOCOL.md "Poignée de main Native Messaging simulée"), out of scope for
// a `bun test` unit test.
import { describe, expect, test } from "bun:test";
import { requestBrokerKeyFromHost, NATIVE_HOST_NAME } from "../../extension/lib/native-host.js";

const VALID_KEY = "f".repeat(64);

function fakeApi(sendNativeMessage: (app: string, message: unknown) => Promise<unknown>) {
  return { runtime: { sendNativeMessage } };
}

describe("requestBrokerKeyFromHost", () => {
  test("sends {type:'key.get', v:1} to 'com.getcoati.broker'", async () => {
    let seenApp: string | undefined;
    let seenMessage: unknown;
    const api = fakeApi(async (app, message) => {
      seenApp = app;
      seenMessage = message;
      return { type: "key", v: 1, key: VALID_KEY };
    });
    await requestBrokerKeyFromHost(api as any);
    expect(seenApp).toBe(NATIVE_HOST_NAME);
    expect(seenApp).toBe("com.getcoati.broker");
    expect(seenMessage).toEqual({ type: "key.get", v: 1 });
  });

  test("resolves with the key on a valid {type:'key'} reply", async () => {
    const api = fakeApi(async () => ({ type: "key", v: 1, key: VALID_KEY }));
    await expect(requestBrokerKeyFromHost(api as any)).resolves.toBe(VALID_KEY);
  });

  test("rejects on every {type:'error'} code", async () => {
    for (const code of ["broker-not-running", "forbidden-caller", "bad-request", "internal"]) {
      const api = fakeApi(async () => ({ type: "error", v: 1, code }));
      await expect(requestBrokerKeyFromHost(api as any)).rejects.toThrow();
    }
  });

  test("rejects when the browser itself rejects the call (host not installed, wrong id, ...)", async () => {
    const api = fakeApi(async () => {
      throw new Error("Specified native messaging host not found.");
    });
    await expect(requestBrokerKeyFromHost(api as any)).rejects.toThrow();
  });

  test("rejects on a malformed reply (wrong shape, non-hex key)", async () => {
    const bad = [null, {}, { type: "key" }, { type: "key", key: "not-hex" }, { type: "key", key: "ab" }];
    for (const reply of bad) {
      const api = fakeApi(async () => reply);
      await expect(requestBrokerKeyFromHost(api as any)).rejects.toThrow();
    }
  });

  test("rejects after the timeout when the host never answers", async () => {
    const api = fakeApi(() => new Promise(() => {})); // never resolves
    await expect(requestBrokerKeyFromHost(api as any, 20)).rejects.toThrow();
  });
});
