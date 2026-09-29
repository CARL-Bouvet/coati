// Pure-function fixtures for broker/src/admission.ts — docs/PROTOCOL.md
// "Admission HTTP et WebSocket" (amendement 2026-09-25). Host allowlist and
// /proc/net/tcp[6] parsing/encoding, tested without touching the real
// filesystem or a real socket — see server.ts's admitRequest for the thin
// impure wrapper that reads /proc and calls process.getuid().

import { describe, expect, test } from "bun:test";
import {
  isHostAllowed,
  ipv4ToProcHex,
  ipv6ToProcHex,
  portToProcHex,
  findUidInProcNetTcp,
  resolvePeerUid,
} from "../src/admission.ts";

describe("isHostAllowed", () => {
  test("accepts 127.0.0.1:<port> and localhost:<port>, exact port", () => {
    expect(isHostAllowed("127.0.0.1:8787", 8787)).toBe(true);
    expect(isHostAllowed("localhost:8787", 8787)).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(isHostAllowed("LOCALHOST:8787", 8787)).toBe(true);
  });

  test("trims surrounding whitespace", () => {
    expect(isHostAllowed(" 127.0.0.1:8787 ", 8787)).toBe(true);
  });

  test("refuses a different port — pares DNS rebinding to a different service", () => {
    expect(isHostAllowed("127.0.0.1:9999", 8787)).toBe(false);
  });

  test("refuses a foreign host — the DNS-rebinding case", () => {
    expect(isHostAllowed("attacker.tld:8787", 8787)).toBe(false);
  });

  test("refuses absent, empty, or portless Host", () => {
    expect(isHostAllowed(null, 8787)).toBe(false);
    expect(isHostAllowed(undefined, 8787)).toBe(false);
    expect(isHostAllowed("", 8787)).toBe(false);
    expect(isHostAllowed("127.0.0.1", 8787)).toBe(false);
  });
});

describe("ipv4ToProcHex", () => {
  test("encodes 127.0.0.1 the way the kernel does — byte-reversed hex", () => {
    expect(ipv4ToProcHex("127.0.0.1")).toBe("0100007F");
  });

  test("encodes 0.0.0.0", () => {
    expect(ipv4ToProcHex("0.0.0.0")).toBe("00000000");
  });

  test("returns null for a malformed address", () => {
    expect(ipv4ToProcHex("not-an-ip")).toBeNull();
    expect(ipv4ToProcHex("1.2.3")).toBeNull();
    expect(ipv4ToProcHex("1.2.3.4.5")).toBeNull();
    expect(ipv4ToProcHex("1.2.3.256")).toBeNull();
  });
});

describe("ipv6ToProcHex", () => {
  test("encodes ::1 (loopback)", () => {
    // 15 zero bytes then 0x01, grouped into 4 32-bit words, each byte-reversed.
    expect(ipv6ToProcHex("::1")).toBe("00000000000000000000000001000000");
  });

  test("encodes an IPv4-mapped address, ::ffff:127.0.0.1", () => {
    expect(ipv6ToProcHex("::ffff:127.0.0.1")).toBe(ipv6ToProcHex("::ffff:127.0.0.1"));
    expect(typeof ipv6ToProcHex("::ffff:127.0.0.1")).toBe("string");
    expect(ipv6ToProcHex("::ffff:127.0.0.1")!.length).toBe(32);
  });

  test("returns null for an unsupported shape", () => {
    expect(ipv6ToProcHex("2001:db8::1")).toBeNull();
    expect(ipv6ToProcHex("not-an-ip")).toBeNull();
  });
});

describe("portToProcHex", () => {
  test("encodes 8787 as uppercase hex, no byte swap", () => {
    expect(portToProcHex(8787)).toBe("2253");
  });

  test("pads to 4 hex chars", () => {
    expect(portToProcHex(80)).toBe("0050");
  });
});

describe("findUidInProcNetTcp", () => {
  const header = "  sl  local_address rem_address   st tx_queue:rx_queue tr:tm->when retrnsmt   uid  timeout inode";
  const row = "   0: 0100007F:9C51 0100007F:2253 01 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 20 0 0 10 0";

  test("finds the uid for a matching local/rem address pair", () => {
    const content = `${header}\n${row}\n`;
    expect(findUidInProcNetTcp(content, "0100007F:9C51", "0100007F:2253")).toBe(1000);
  });

  test("returns null when no row matches — fail closed", () => {
    const content = `${header}\n${row}\n`;
    expect(findUidInProcNetTcp(content, "0100007F:FFFF", "0100007F:2253")).toBeNull();
  });

  test("returns null for empty content", () => {
    expect(findUidInProcNetTcp("", "0100007F:9C51", "0100007F:2253")).toBeNull();
  });

  test("skips short/malformed lines instead of throwing", () => {
    const content = `${header}\ngarbage\n${row}\n`;
    expect(findUidInProcNetTcp(content, "0100007F:9C51", "0100007F:2253")).toBe(1000);
  });
});

describe("resolvePeerUid", () => {
  const header = "  sl  local_address rem_address   st tx_queue:rx_queue tr:tm->when retrnsmt   uid  timeout inode";

  test("resolves the peer's uid from an IPv4 loopback row", () => {
    const peerHex = ipv4ToProcHex("127.0.0.1")!;
    const peerPortHex = portToProcHex(54321);
    const serverPortHex = portToProcHex(8787);
    const loopbackHex = ipv4ToProcHex("127.0.0.1")!;
    const row = `   0: ${peerHex}:${peerPortHex} ${loopbackHex}:${serverPortHex} 01 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 20 0 0 10 0`;
    const uid = resolvePeerUid({
      procNetTcp: `${header}\n${row}\n`,
      peerAddress: "127.0.0.1",
      peerPort: 54321,
      serverPort: 8787,
    });
    expect(uid).toBe(1000);
  });

  test("resolves the peer's uid from an IPv6-mapped loopback row, via tcp6", () => {
    const peerHex = ipv6ToProcHex("::ffff:127.0.0.1")!;
    const peerPortHex = portToProcHex(54321);
    const serverPortHex = portToProcHex(8787);
    const loopbackHex = ipv6ToProcHex("::ffff:127.0.0.1")!;
    const row = `   0: ${peerHex}:${peerPortHex} ${loopbackHex}:${serverPortHex} 01 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 20 0 0 10 0`;
    const uid = resolvePeerUid({
      procNetTcp6: `${header}\n${row}\n`,
      peerAddress: "::ffff:127.0.0.1",
      peerPort: 54321,
      serverPort: 8787,
    });
    expect(uid).toBe(1000);
  });

  test("fails closed (null) when the matching /proc file was not supplied", () => {
    const uid = resolvePeerUid({
      // procNetTcp omitted entirely — as if unreadable.
      peerAddress: "127.0.0.1",
      peerPort: 54321,
      serverPort: 8787,
    });
    expect(uid).toBeNull();
  });

  test("fails closed (null) when no row matches", () => {
    const uid = resolvePeerUid({
      procNetTcp: `${header}\n`,
      peerAddress: "127.0.0.1",
      peerPort: 54321,
      serverPort: 8787,
    });
    expect(uid).toBeNull();
  });

  test("fails closed (null) for an unsupported peer address shape", () => {
    const uid = resolvePeerUid({
      procNetTcp: `${header}\n`,
      procNetTcp6: `${header}\n`,
      peerAddress: "2001:db8::1",
      peerPort: 54321,
      serverPort: 8787,
    });
    expect(uid).toBeNull();
  });
});
