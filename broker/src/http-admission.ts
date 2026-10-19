// Admission (Host allowlist + peer UID) — docs/PROTOCOL.md "Admission HTTP
// et WebSocket". Applied before ANY routing, on
// every HTTP request (/pair, /ws before upgrade, unknown routes included).
// Split out of server.ts.

import { readFileSync } from "node:fs";
import { isHostAllowed, resolvePeerUid } from "./admission.ts";
import { sanitizeLogValue } from "./logging.ts";

export type AdmissionOutcome =
  | { ok: true }
  | { ok: false; stage: "host"; host: string | null }
  | { ok: false; stage: "peer"; peerUid: number | null };

/** Bun-provided IP lookup, narrowed to what admitRequest needs — a thin seam
 * so tests could substitute it, though the integration tests below exercise
 * the real Bun.serve/server.requestIP path directly. */
export interface RequestIpSource {
  requestIP(req: Request): { address: string; port: number } | null;
}

export function admitRequest(
  req: Request,
  server: RequestIpSource,
  port: number,
  opts: { allowLocalhostHost?: boolean } = {},
): AdmissionOutcome {
  const host = req.headers.get("host");
  const localhostOk = opts.allowLocalhostHost === true && host?.trim().toLowerCase() === `localhost:${port}`;
  if (!isHostAllowed(host, port) && !localhostOk) {
    return { ok: false, stage: "host", host };
  }
  // Peer-UID check: Linux only (docs/PROTOCOL.md "Threat boundary" — not
  // enforced elsewhere, logged once at startup instead, see startServer).
  if (process.platform === "linux") {
    const ip = server.requestIP(req);
    let uid: number | null = null;
    if (ip) {
      let procNetTcp: string | undefined;
      let procNetTcp6: string | undefined;
      try {
        procNetTcp = readFileSync("/proc/net/tcp", "utf8");
      } catch {
        // Unreadable: treated as "not found" below — fail closed.
      }
      try {
        procNetTcp6 = readFileSync("/proc/net/tcp6", "utf8");
      } catch {
        // ditto
      }
      uid = resolvePeerUid({
        procNetTcp,
        procNetTcp6,
        peerAddress: ip.address,
        peerPort: ip.port,
        serverPort: port,
      });
    }
    if (uid === null || uid !== process.getuid?.()) {
      return { ok: false, stage: "peer", peerUid: uid };
    }
  }
  return { ok: true };
}

export function logAdmissionRejection(outcome: Extract<AdmissionOutcome, { ok: false }>): void {
  if (outcome.stage === "host") {
    console.error(`coati-broker: reject stage=host host=${sanitizeLogValue(outcome.host)}`);
  } else {
    const detail = outcome.peerUid === null ? "reason=not-found" : `peerUid=${outcome.peerUid}`;
    console.error(`coati-broker: reject stage=peer ${detail}`);
  }
}

export const FORBIDDEN_RESPONSE_HEADERS = { "content-type": "text/plain" };

// docs/PROTOCOL.md "Handshake `v: 2`" — "Unauthenticated connection cap".
export const MAX_UNAUTH_CONNECTIONS = 16;
// Rate limit for the cap-rejection log line: at most one line per window,
// carrying the count of rejections that happened during it.
export const UNAUTH_CAP_LOG_WINDOW_MS = 10_000;
