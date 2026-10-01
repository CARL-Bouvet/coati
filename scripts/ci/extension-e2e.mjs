#!/usr/bin/env node
// scripts/ci/extension-e2e.mjs — goal G4, "CI end to end": loads the built,
// unpacked Chrome/Brave extension (dist/stage/chrome — pinned ID via
// extension/manifest.json's "key", see docs/PROTOCOL.md "Poignée de main")
// in a real Chromium via Playwright, wires the Native Messaging host
// manifest for a throwaway --user-data-dir, starts the broker on the REAL,
// fixed port 8787 (docs/PROTOCOL.md "Transport" — the extension's CSP
// hard-codes it, COATI_PORT would make it refuse to connect) with a temp
// HOME and the fake provider module fixture, opens the panel page, sends a
// chat message, and asserts the fake provider's answer shows up and the
// connection status reaches "connected".
//
// CI-only (ubuntu-latest job): needs Playwright's own downloaded Chromium
// (`npx playwright install --with-deps chromium`) and a free port 8787 — a
// normal dev machine typically has a real broker already listening there,
// and may lack a display/network. See the G4 worker's report, "Only CI can
// tell", for exactly what this script could NOT be run through locally.
//
// Usage: node scripts/ci/extension-e2e.mjs
// Env: COATI_E2E_BINARY (defaults to dist/bin/coati-broker-linux-x64 — the
//      target scripts/build-binaries.sh produces on ubuntu-latest).

import { chromium } from "playwright";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const EXT_DIR = path.join(ROOT, "dist/stage/chrome");
const BINARY = process.env.COATI_E2E_BINARY || path.join(ROOT, "dist/bin/coati-broker-linux-x64");
const PINNED_ID = "hehlgipomfminodhahcjbencblepjhah";
const FIXTURE = path.join(ROOT, "broker/test/fixtures/modules/valid-provider.ts");

function pass(msg) {
  console.log(`PASS: ${msg}`);
}

if (!existsSync(EXT_DIR)) {
  console.error(`FAIL: ${EXT_DIR} missing — run scripts/build.sh first`);
  process.exit(1);
}
if (!existsSync(BINARY)) {
  console.error(`FAIL: ${BINARY} missing — run scripts/build-binaries.sh first`);
  process.exit(1);
}

const home = mkdtempSync(path.join(tmpdir(), "coati-ext-e2e-home-"));
const userDataDir = mkdtempSync(path.join(tmpdir(), "coati-ext-e2e-profile-"));
const dataDir = path.join(home, ".local", "share", "coati");

mkdirSync(path.join(home, ".config", "coati"), { recursive: true });
writeFileSync(
  path.join(home, ".config", "coati", "config.json"),
  JSON.stringify(
    {
      port: 8787,
      allowedExtensionIds: [PINNED_ID],
      provider: "e2e-fixture",
      modules: [{ path: FIXTURE, options: { id: "e2e-fixture", label: "E2E Fixture" } }],
    },
    null,
    2,
  ),
);

// Where Chromium looks for a NativeMessagingHosts manifest for a custom
// --user-data-dir isn't pinned down (see the module doc comment above) — the
// manifest is written to every plausible candidate, all pointing at the same
// binary, so whichever one the CI runner's Chromium actually reads works.
const manifestTemplate = JSON.parse(
  readFileSync(path.join(ROOT, "packaging", "native-host", "com.getcoati.broker.chromium.json"), "utf8"),
);
manifestTemplate.path = BINARY;
const manifestJson = JSON.stringify(manifestTemplate, null, 2);
const candidateDirs = [
  path.join(userDataDir, "NativeMessagingHosts"),
  path.join(home, ".config", "google-chrome", "NativeMessagingHosts"),
  path.join(home, ".config", "chromium", "NativeMessagingHosts"),
];
for (const dir of candidateDirs) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "com.getcoati.broker.json"), manifestJson);
}

const broker = spawn(BINARY, [], {
  env: { ...process.env, HOME: home, COATI_DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});
let brokerLog = "";
broker.stdout.on("data", (d) => (brokerLog += d));
broker.stderr.on("data", (d) => (brokerLog += d));

let ctx;
function cleanup() {
  broker.kill();
  rmSync(home, { recursive: true, force: true });
  rmSync(userDataDir, { recursive: true, force: true });
}

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${label}`);
}

try {
  await waitFor(() => existsSync(path.join(dataDir, "broker-key.json")), 10000, "broker-key.json");
  pass("broker started on the real port 8787, key file written");

  // `channel: "chromium"` forces Playwright's full Chrome binary rather than
  // its default, lighter `chromium-headless-shell` for headless runs — the
  // shell build does NOT support extensions at all (verified locally: with
  // it, ctx.serviceWorkers() simply stays empty, no error). The full binary
  // in headless:true uses Chromium's "new" headless mode, which does support
  // extensions. xvfb-run + headless:false is the fallback if a future
  // Chromium/Playwright bump regresses that (see this file's header).
  ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: "chromium",
    // The native host is launched BY Chromium and inherits its environment:
    // without the test HOME/COATI_DATA_DIR it would read the key file of
    // whatever broker belongs to the real account (none on a CI runner →
    // "no-host"; a developer's real broker locally → "broker-untrusted").
    env: { ...process.env, HOME: home, COATI_DATA_DIR: dataDir },
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, "--no-sandbox"],
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(sw.url()).host;
  if (extensionId !== PINNED_ID) {
    throw new Error(
      `extension loaded under id ${extensionId}, expected the pinned id ${PINNED_ID} — ` +
        `did dist/stage/chrome/manifest.json lose its "key" field?`,
    );
  }
  pass(`extension loaded, pinned id confirmed (${extensionId})`);

  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extensionId}/panel/panel.html`);

  await waitFor(
    async () => {
      const cls = await page.locator("#status").getAttribute("class").catch(() => "");
      return (cls || "").includes("status--connected");
    },
    20000,
    "status--connected",
  ).catch(async (err) => {
    const cls = await page.locator("#status").getAttribute("class").catch(() => "?");
    const text = await page.locator("#status").textContent().catch(() => "?");
    const banner = await page.locator("body").innerText().catch(() => "?");
    throw new Error(
      `${err.message}\nstatus class="${cls}" text="${text}"\n--- panel text ---\n${banner.slice(0, 800)}` +
        `\n--- broker log ---\n${brokerLog}`,
    );
  });
  pass("panel reached status--connected (Native Messaging handshake succeeded)");

  // The panel is opened as a plain tab, so there is no page Coati may read;
  // with "Lire la page" on (the default) the question would be held back
  // ("Coati n'a pas accès à cette page"). Turn it off: this test is about the
  // pairing and the round trip, not page reading.
  // The switch settles asynchronously after "connected" (stored preference,
  // first-run flags): wait for it to turn on before turning it off, otherwise
  // a late render switches it back on after our check (flaky, seen in U2).
  const attachOn = await waitFor(
    async () => (await page.locator("#attachPage").getAttribute("aria-checked")) === "true",
    5000,
    "attachPage on",
  ).then(() => true, () => false);
  if (attachOn) {
    await page.locator("#attachPage").click();
  }
  await page.waitForTimeout(300);
  if ((await page.locator("#attachPage").getAttribute("aria-checked")) === "true") {
    await page.locator("#attachPage").click();
  }
  const question = `coati extension e2e ${Date.now()}`;
  await page.locator("#input").fill(question);
  await page.locator("#send").click();

  await waitFor(
    async () => {
      const bubble = page.locator(".message--assistant").last();
      if ((await bubble.count()) === 0) return false;
      const streaming = await page.locator(".message--assistant.message--streaming").count();
      const text = await bubble.textContent().catch(() => "");
      return streaming === 0 && !!text && text.includes("echo:");
    },
    30000,
    "assistant answer from the fake provider",
  ).catch(async (err) => {
    const panel = await page.locator("body").innerText().catch(() => "?");
    const html = await page.locator("#messages, main, body").first().innerHTML().catch(() => "?");
    throw new Error(
      `${err.message}\n--- panel text ---\n${panel.slice(0, 800)}\n--- markup ---\n${html.slice(0, 1500)}` +
        `\n--- broker log ---\n${brokerLog}`,
    );
  });
  const answerText = await page.locator(".message--assistant").last().textContent();
  pass(`assistant answer received from the fake provider: ${answerText.slice(0, 80)}`);

  console.log("== scripts/ci/extension-e2e.mjs: ALL PASS ==");
} catch (err) {
  console.error(`FAIL: ${err.stack || err}`);
  if (process.env.GITHUB_ACTIONS) {
    // Job logs need a signed-in account; annotations are public.
    const enc = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "").replace(/\n/g, "%0A");
    const body = `${err.stack || err}\n--- broker log (tail) ---\n${brokerLog.split("\n").slice(-25).join("\n")}`;
    console.log(`::error title=scripts/ci/extension-e2e.mjs::${enc(body).slice(0, 6000)}`);
  }
  process.exitCode = 1;
} finally {
  if (ctx) await ctx.close().catch(() => {});
  cleanup();
}
