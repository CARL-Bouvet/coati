// Admission checks applied to every HTTP request and every WebSocket upgrade,
// BEFORE any routing — see docs/PROTOCOL.md "Admission HTTP et WebSocket"
// (amendement 2026-09-25). Two independent guards:
//   1. `Host` header allowlist — pares DNS rebinding (a hostile page resolving
//      to 127.0.0.1 still sends its own Host header, which this rejects).
//   2. Peer UID (Linux only) — pares another OS account on the same machine
//      from reaching the broker, via /proc/net/tcp[6].
// Both the Host check and the /proc/net/tcp line lookup are pure functions,
// tested with fixtures; only the thin wrapper that actually reads /proc and
// calls process.getuid() is impure (server.ts's admitConnection).

/** Pure: true iff `hostHeader`, lower-cased, is exactly `127.0.0.1:<port>` or
 * `localhost:<port>`. Absent, empty, without a port, or any other host/port
 * is refused — this is what stops DNS rebinding (a hostile page's request
 * carries `Host: attacker.tld:8787`, not `127.0.0.1:8787`). */
export function isHostAllowed(hostHeader: string | null | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const h = hostHeader.trim().toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

function ipv4Bytes(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

function bytesToHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** Pure: encodes a dotted-quad IPv4 address the way the Linux kernel does in
 * /proc/net/tcp — 8 hex chars, byte order reversed (little-endian display).
 * `127.0.0.1` -> `"0100007F"`. Returns null for a malformed address. */
export function ipv4ToProcHex(ip: string): string | null {
  const bytes = ipv4Bytes(ip);
  if (!bytes) return null;
  return bytesToHex(bytes.slice().reverse());
}

/** Pure: encodes an IPv6 address the way the kernel does in /proc/net/tcp6 —
 * 32 hex chars, one 8-char group per 32-bit word, each word byte-reversed.
 * Only the two shapes the broker ever needs to look up are supported:
 * `::1` (loopback) and `::ffff:a.b.c.d` (IPv4-mapped, what a dual-stack
 * kernel reports for a peer that reached an IPv4-bound socket over the v6
 * stack). Anything else returns null — callers treat that as "not found",
 * i.e. fail closed, exactly like an unreadable /proc file. */
export function ipv6ToProcHex(ip: string): string | null {
  let bytes: number[];
  if (ip === "::1") {
    bytes = [...new Array(15).fill(0), 1];
  } else {
    const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip.trim());
    if (!m) return null;
    const v4 = ipv4Bytes(m[1]);
    if (!v4) return null;
    bytes = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...v4];
  }
  let hex = "";
  for (let w = 0; w < 4; w++) {
    hex += bytesToHex(bytes.slice(w * 4, w * 4 + 4).reverse());
  }
  return hex;
}

/** Pure: 4 hex chars, uppercase, no byte swap — how /proc/net/tcp[6] encodes
 * a port number. Port 8787 (0x2253) -> `"2253"`. */
export function portToProcHex(port: number): string {
  return port.toString(16).padStart(4, "0").toUpperCase();
}

/**
 * Pure: searches the raw content of /proc/net/tcp or /proc/net/tcp6 (header
 * line included, as read from disk) for the row whose `local_address` column
 * equals `localAddrHex` and whose `rem_address` column equals `remAddrHex`
 * (both already kernel-hex-encoded, e.g. via ipv4ToProcHex/portToProcHex),
 * and returns that row's `uid` column. Returns null if no row matches —
 * callers must treat that as "fail closed", never as "not restricted".
 *
 * Column layout (kernel doc, proc(5)):
 *   sl  local_address rem_address   st tx:rx tr:tm retrnsmt  uid ...
 */
export function findUidInProcNetTcp(content: string, localAddrHex: string, remAddrHex: string): number | null {
  const lines = content.split("\n");
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8) continue;
    const local = fields[1];
    const rem = fields[2];
    const uidStr = fields[7];
    if (local === localAddrHex && rem === remAddrHex) {
      const uid = Number(uidStr);
      return Number.isFinite(uid) ? uid : null;
    }
  }
  return null;
}

export interface PeerUidQuery {
  /** Content of /proc/net/tcp, or undefined if it could not be read. */
  procNetTcp?: string;
  /** Content of /proc/net/tcp6, or undefined if it could not be read. */
  procNetTcp6?: string;
  /** The connecting peer's own address, as reported by the runtime
   * (Bun's `server.requestIP()`). */
  peerAddress: string;
  peerPort: number;
  /** The port the broker is actually listening on. */
  serverPort: number;
}

/**
 * Pure: resolves the OS uid that owns the peer's end of a loopback TCP
 * connection, by finding — in the broker's own read of /proc/net/tcp[6] —
 * the row that represents the PEER's socket: its local_address:port is the
 * peer's own address (what the broker sees as the remote side), and its
 * rem_address:port is 127.0.0.1:<serverPort> (where the peer connected to).
 * Loopback connections show up as two distinct rows system-wide — this looks
 * up the client's row, not the broker's own listening row.
 *
 * Returns null (fail closed) when the peer address isn't a supported shape,
 * the matching /proc file wasn't supplied, or no row matches.
 */
export function resolvePeerUid(query: PeerUidQuery): number | null {
  const serverPortHex = portToProcHex(query.serverPort);
  const peerPortHex = portToProcHex(query.peerPort);

  const v4 = ipv4ToProcHex(query.peerAddress);
  if (v4 !== null) {
    if (query.procNetTcp === undefined) return null;
    const loopbackHex = ipv4ToProcHex("127.0.0.1")!;
    return findUidInProcNetTcp(query.procNetTcp, `${v4}:${peerPortHex}`, `${loopbackHex}:${serverPortHex}`);
  }

  const v6 = ipv6ToProcHex(query.peerAddress);
  if (v6 !== null) {
    if (query.procNetTcp6 === undefined) return null;
    const loopbackHex = ipv6ToProcHex("::ffff:127.0.0.1")!;
    return findUidInProcNetTcp(query.procNetTcp6, `${v6}:${peerPortHex}`, `${loopbackHex}:${serverPortHex}`);
  }

  return null;
}
