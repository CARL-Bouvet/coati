// The one place every server-to-client frame is serialized. Split out of
// server.ts — every handler module below imports this instead of
// each defining its own copy.

import type { ServerMessage } from "./protocol.ts";

export function send(ws: { send(data: string): unknown }, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}
