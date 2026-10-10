// Guard for pages Coati opens on its own (search results, clicked links).
// Pure: no DOM, no chrome.*, no network. `new URL` already normalises the
// decimal / hex / octal IPv4 spellings to dotted decimal and compresses IPv6,
// so only those canonical forms are classified here.
//
// Limit: the hostname is never resolved. A public name whose DNS record points
// at a private address is not detected.

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan"];

// [base, prefix length] — loopback, private, link-local, CGNAT, test-net,
// multicast and reserved ranges.
const IPV4_LOCAL = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = (n << 8) | Number(p);
  }
  return n >>> 0;
}

function isLocalIPv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // malformed: fail closed
  return IPV4_LOCAL.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
  });
}

function expandIPv6(ip) {
  let addr = ip;
  let embeddedV4 = null;
  const v4 = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4) {
    embeddedV4 = ipv4ToInt(v4[1]);
    if (embeddedV4 === null) return null;
    addr = addr.slice(0, addr.length - v4[1].length) + "0:0";
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":").filter(Boolean) : [];
  let groups;
  if (halves.length === 2) {
    const missing = 8 - (head.length + tail.length);
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => Number.parseInt(g, 16));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  if (embeddedV4 !== null) {
    nums[6] = (embeddedV4 >>> 16) & 0xffff;
    nums[7] = embeddedV4 & 0xffff;
  }
  return nums;
}

function nums16ToV4(hi, lo) {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isLocalIPv6(ip) {
  const nums = expandIPv6(ip);
  if (!nums) return true; // malformed: fail closed
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96, incl. ::1 and ::).
  if (nums.slice(0, 5).every((n) => n === 0) && (nums[5] === 0xffff || nums[5] === 0)) {
    return isLocalIPv4(nums16ToV4(nums[6], nums[7]));
  }
  // NAT64 64:ff9b::/96
  if (nums[0] === 0x64 && nums[1] === 0xff9b && nums.slice(2, 6).every((n) => n === 0)) {
    return isLocalIPv4(nums16ToV4(nums[6], nums[7]));
  }
  // 6to4 2002::/16 embeds the IPv4 address in the next 32 bits.
  if (nums[0] === 0x2002) return isLocalIPv4(nums16ToV4(nums[1], nums[2]));
  if ((nums[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((nums[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((nums[0] & 0xffc0) === 0xfec0) return true; // fec0::/10
  if ((nums[0] & 0xff00) === 0xff00) return true; // ff00::/8
  return false;
}

/** True when `hostname` (as given by `URL.hostname`) is a local or private address or name. */
export function isLocalHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[")) return isLocalIPv6(host.slice(1, -1));
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isLocalIPv4(host);
  if (host === "localhost" || host === "") return true;
  return LOCAL_SUFFIXES.some((s) => host.endsWith(s));
}

function parse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Decides whether Coati may open `toUrl` while the user is on `fromUrl`.
 * level: "text" | "dev". Returns { verdict: "ok" | "warn-http" | "blocked", reason? }.
 */
export function checkOpen(fromUrl, toUrl, level) {
  const to = parse(toUrl);
  if (!to) return { verdict: "blocked", reason: "invalid-url" };
  if (to.protocol !== "https:" && to.protocol !== "http:") {
    return { verdict: "blocked", reason: "scheme" };
  }
  if (level !== "dev" && isLocalHostname(to.hostname)) {
    const from = parse(fromUrl);
    const fromIsLocalWeb =
      from && (from.protocol === "https:" || from.protocol === "http:") && isLocalHostname(from.hostname);
    const sameSite = fromIsLocalWeb && from.hostname.toLowerCase() === to.hostname.toLowerCase();
    if (!sameSite) return { verdict: "blocked", reason: "local-address" };
  }
  if (to.protocol === "http:") return { verdict: "warn-http", reason: "http" };
  return { verdict: "ok" };
}
