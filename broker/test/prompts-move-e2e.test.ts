// End-to-end coverage for server.ts's dispatch of prompts.save / prompts.move /
// prefs.get / prefs.set over a real WebSocket connection — the unit tests in
// prompts.test.ts / prefs.test.ts exercise the storage layer directly, this
// file exercises the new wiring in server.ts (handleMessage's new cases).
import { describe, expect, test, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { ServerMessage } from "../src/protocol.ts";
import { makeTmpDir } from "./helpers/tmp-dir.ts";

const ALLOWED_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECRET = "0123456789abcdef0123456789abcdef";

let servers: ReturnType<typeof startServer>[] = [];

function boot() {
  const dataDir = makeTmpDir("coati-prompts-e2e-");
  const server = startServer({ port: 0, allowedExtensionIds: [ALLOWED_ID] }, SECRET, { dataDir });
  servers.push(server);
  return server;
}

afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
});

async function connectAndAuth(server: ReturnType<typeof startServer>): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
    headers: { Origin: `chrome-extension://${ALLOWED_ID}` },
  } as any);
  await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
  const helloOk = new Promise<void>((resolve) => {
    const onMessage = (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string);
      if (msg.type === "hello-ok") {
        ws.removeEventListener("message", onMessage);
        resolve();
      }
    };
    ws.addEventListener("message", onMessage);
  });
  ws.send(JSON.stringify({ type: "hello", secret: SECRET, v: 1 }));
  await helloOk;
  return ws;
}

function waitFor(ws: WebSocket, id: string): Promise<ServerMessage> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string) as ServerMessage & { id?: string };
      if (msg.id === id) {
        ws.removeEventListener("message", onMessage);
        resolve(msg as ServerMessage);
      }
    };
    ws.addEventListener("message", onMessage);
  });
}

describe("prompts / prefs message dispatch (server.ts)", () => {
  test("prompts.list starts empty", async () => {
    const ws = await connectAndAuth(boot());
    const reply = waitFor(ws, "r1");
    ws.send(JSON.stringify({ type: "prompts.list", id: "r1" }));
    const msg = await reply;
    expect(msg).toEqual({ type: "prompts", id: "r1", items: [] });
    ws.close();
  });

  test("prompts.save (create) then prompts.move updates both files, reply carries items+prefs", async () => {
    const ws = await connectAndAuth(boot());

    const saved = waitFor(ws, "s1");
    ws.send(JSON.stringify({ type: "prompts.save", id: "s1", prompt: { site: "@youtube", body: "hello" } }));
    const savedMsg = (await saved) as { type: "prompts"; items: { id: string }[] };
    expect(savedMsg.type).toBe("prompts");
    const promptId = savedMsg.items[0]!.id;

    const prefsSet = waitFor(ws, "p1");
    ws.send(
      JSON.stringify({
        type: "prefs.set",
        id: "p1",
        site: "@youtube",
        prefs: { order: [promptId, "coati:youtube:key-points"] },
      }),
    );
    await prefsSet;

    const moved = waitFor(ws, "m1");
    ws.send(
      JSON.stringify({
        type: "prompts.move",
        id: "m1",
        promptId,
        site: "crisco4.unicaen.fr",
        order: [promptId],
      }),
    );
    const movedMsg = (await moved) as any;
    expect(movedMsg.type).toBe("prompts");
    expect(movedMsg.items[0].site).toBe("crisco4.unicaen.fr");
    expect(movedMsg.prefs.sites["@youtube"]).toEqual({ order: ["coati:youtube:key-points"] });
    expect(movedMsg.prefs.sites["crisco4.unicaen.fr"]).toEqual({ order: [promptId] });

    ws.close();
  });

  test("prompts.move with an unknown promptId replies bad-request", async () => {
    const ws = await connectAndAuth(boot());
    const reply = waitFor(ws, "m2");
    ws.send(
      JSON.stringify({ type: "prompts.move", id: "m2", promptId: "p_000000000000", site: "*", order: [] }),
    );
    const msg = (await reply) as any;
    expect(msg.type).toBe("error");
    expect(msg.code).toBe("bad-request");
    ws.close();
  });

  test("prompts.delete is idempotent — unknown id still returns the full list", async () => {
    const ws = await connectAndAuth(boot());
    const reply = waitFor(ws, "d1");
    ws.send(JSON.stringify({ type: "prompts.delete", id: "d1", promptId: "p_000000000000" }));
    const msg = await reply;
    expect(msg).toEqual({ type: "prompts", id: "d1", items: [] });
    ws.close();
  });

  test("prefs.get / prefs.set round-trip", async () => {
    const ws = await connectAndAuth(boot());
    const empty = waitFor(ws, "g1");
    ws.send(JSON.stringify({ type: "prefs.get", id: "g1" }));
    expect(await empty).toEqual({ type: "prefs", id: "g1", sites: {} });

    const set = waitFor(ws, "g2");
    ws.send(
      JSON.stringify({ type: "prefs.set", id: "g2", site: "*", prefs: { order: ["coati:youtube:key-points"] } }),
    );
    expect(await set).toEqual({ type: "prefs", id: "g2", sites: { "*": { order: ["coati:youtube:key-points"] } } });
    ws.close();
  });
});
