#!/usr/bin/env node
// scripts/ci/extension-e2e.mjs, "CI end to end": loads the built,
// unpacked Chrome/Brave extension (dist/stage/chrome — pinned ID via
// extension/manifest.json's "key", see docs/PROTOCOL.md)
// in a real Chromium via Playwright, wires the Native Messaging host
// manifest for a throwaway --user-data-dir, starts the broker on the REAL,
// fixed port 8787 (docs/PROTOCOL.md — the extension's CSP
// hard-codes it, COATI_PORT would make it refuse to connect) with a temp
// HOME and the fake provider module fixture, opens the panel page. Outside
// attach mode it then starts like a new user (a local OpenAI-compatible
// stand-in without its key): saving the key in the settings page must close
// the panel's first-run card. It sends a chat message, asserts the answer
// shows up, and checks the one-click OpenRouter sign-in.
//
// CI-only: needs Playwright's own downloaded Chromium
// (`npx playwright install --with-deps chromium`) and a free port 8787 — a
// normal dev machine typically has a real broker already listening there,
// and may lack a display/network. Only CI can tell whether it passes.
//
// Usage: node scripts/ci/extension-e2e.mjs
// Env:
//   COATI_E2E_BINARY      broker to spawn and to point the host manifest at
//                         (defaults to dist/bin/coati-broker-linux-x64).
//   COATI_E2E_ATTACH=1    the broker was installed and started by the real
//                         installer (scripts/ci/journey.sh): spawn nothing,
//                         write no config or manifest, use the real HOME and
//                         data dir, and leave the broker running. The caller
//                         wrote config.json before installing.
//   COATI_E2E_PROFILE_DIR use this --user-data-dir (kept afterwards) instead
//                         of a temporary one. Chromium reads the per-user
//                         manifest under it, so macOS passes the browser's
//                         default profile to see the installer's manifest.
//   COATI_E2E_CHANNEL     Playwright channel (default "chromium").
//   COATI_E2E_BROKER_LOG  broker log file, quoted in a failure report.

import { chromium } from "playwright";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const EXT_DIR = path.join(ROOT, "dist/stage/chrome");
const BINARY = process.env.COATI_E2E_BINARY || path.join(ROOT, "dist/bin/coati-broker-linux-x64");
const ATTACH = process.env.COATI_E2E_ATTACH === "1";
const CHANNEL = process.env.COATI_E2E_CHANNEL || "chromium";
const PINNED_ID = "hehlgipomfminodhahcjbencblepjhah";
const FIXTURE = path.join(ROOT, "broker/test/fixtures/modules/valid-provider.ts");

function pass(msg) {
  console.log(`PASS: ${msg}`);
}

if (!existsSync(EXT_DIR)) {
  console.error(`FAIL: ${EXT_DIR} missing — run scripts/build.sh first`);
  process.exit(1);
}
if (!ATTACH && !existsSync(BINARY)) {
  console.error(`FAIL: ${BINARY} missing — run scripts/build-binaries.sh first`);
  process.exit(1);
}

const home = ATTACH ? homedir() : mkdtempSync(path.join(tmpdir(), "coati-ext-e2e-home-"));
const ownProfile = !process.env.COATI_E2E_PROFILE_DIR;
const userDataDir = process.env.COATI_E2E_PROFILE_DIR || mkdtempSync(path.join(tmpdir(), "coati-ext-e2e-profile-"));
const dataDir = ATTACH
  ? process.env.COATI_DATA_DIR || path.join(home, ".local", "share", "coati")
  : path.join(home, ".local", "share", "coati");
// What the browser (and so the native host) inherits: the test HOME and data
// dir, or the real ones when the installer set everything up.
const childEnv = ATTACH ? process.env : { ...process.env, HOME: home, COATI_DATA_DIR: dataDir };

let broker;
let fakeOpenRouter;
const FAKE_MODEL_KEY = "sk-e2e-good";
const configPath = path.join(home, ".config", "coati", "config.json");
let exchangeBody = "";
let brokerLog = "";
const brokerLogTail = () =>
  process.env.COATI_E2E_BROKER_LOG && existsSync(process.env.COATI_E2E_BROKER_LOG)
    ? readFileSync(process.env.COATI_E2E_BROKER_LOG, "utf8")
    : brokerLog;

if (!ATTACH) {
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

  // Local stand-ins: OpenRouter's code-for-key exchange (one-click sign-in step below) and an
  // OpenAI-compatible model that answers only once its key is saved (first-run step below).
  fakeOpenRouter = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.url === "/auth/keys") {
        exchangeBody = body;
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ key: `sk-or-v1-${"e2e0".repeat(16)}` }));
      }
      if (req.headers.authorization !== `Bearer ${FAKE_MODEL_KEY}`) {
        res.statusCode = 401;
        return res.end("{}");
      }
      if (req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ data: [{ id: "e2e-model" }] }));
      }
      res.setHeader("content-type", "text/event-stream");
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "echo: fake model" } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise((r) => fakeOpenRouter.listen(0, "127.0.0.1", r));
  childEnv.COATI_OPENROUTER_API_BASE = `http://127.0.0.1:${fakeOpenRouter.address().port}`;
  // Start like a new user: an online service chosen, its key not saved yet.
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  writeFileSync(
    configPath,
    JSON.stringify({ ...config, provider: "openai-compat", baseUrl: `http://127.0.0.1:${fakeOpenRouter.address().port}/v1`, model: "e2e-model" }, null, 2),
  );

  broker = spawn(BINARY, ["--serve"], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  broker.stdout.on("data", (d) => (brokerLog += d));
  broker.stderr.on("data", (d) => (brokerLog += d));
}

let ctx;
function cleanup() {
  if (ATTACH) return;
  broker.kill();
  fakeOpenRouter.close();
  rmSync(home, { recursive: true, force: true });
  if (ownProfile) rmSync(userDataDir, { recursive: true, force: true });
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
  await waitFor(() => existsSync(path.join(dataDir, "broker-key.json")), ATTACH ? 30000 : 10000, "broker-key.json");
  pass(`broker ${ATTACH ? "(started by the installer)" : "started"} on the real port 8787, key file written`);

  // `channel: "chromium"` forces Playwright's full Chrome binary rather than
  // its default, lighter `chromium-headless-shell` for headless runs — the
  // shell build does NOT support extensions at all (verified locally: with
  // it, ctx.serviceWorkers() simply stays empty, no error). The full binary
  // in headless:true uses Chromium's "new" headless mode, which does support
  // extensions. xvfb-run + headless:false is the fallback if a future
  // Chromium/Playwright bump regresses that (see this file's header).
  ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: CHANNEL,
    // The native host is launched BY Chromium and inherits its environment:
    // without the test HOME/COATI_DATA_DIR it would read the key file of
    // whatever broker belongs to the real account (none on a CI runner →
    // "no-host"; a developer's real broker locally → "broker-untrusted").
    env: childEnv,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
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
        `\n--- broker log ---\n${brokerLogTail()}`,
    );
  });
  pass("panel reached status--connected (Native Messaging handshake succeeded)");

  let options;
  const optionsErrors = [];
  if (!ATTACH) {
    // The first-run card says the model does not answer; saving the key in the settings page
    // must close it in the open panel, with no reload.
    const modelStep = page.locator('#firstRun:not([hidden]) .first-run-step[data-check="model"][data-status="missing"]');
    await waitFor(async () => (await modelStep.count()) > 0, 15_000, "first-run card: model missing");
    options = await ctx.newPage();
    options.on("pageerror", (e) => optionsErrors.push(String(e)));
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    // A loopback address counts as "on this computer", where the settings page shows no key
    // field: send exactly what the key field sends (lib/key-input.js submit()).
    await options.waitForFunction(() => document.getElementById("status")?.className.includes("status--connected"));
    await options.evaluate(
      (key) => chrome.runtime.sendMessage({ type: "coati:client-message", payload: { type: "settings.set", id: "e2e-key", provider: "openai-compat", apiKey: key } }),
      FAKE_MODEL_KEY,
    );
    await waitFor(async () => await page.locator("#firstRun").isHidden(), 10_000, "first-run card closing after the key is saved").catch(
      async (err) => {
        const card = await page.locator("#firstRun").innerText().catch(() => "?");
        throw new Error(`${err.message}\n--- card ---\n${card}\n--- broker log ---\n${brokerLogTail()}`);
      },
    );
    pass("key saved in the settings page: the open panel's first-run card closed without a reload");
    // The first-run card closing starts the guided tour once.
    await page.locator(".tour .tour-skip").click({ timeout: 5000 });
  }

  // The panel is opened as a plain tab, so there is no page Coati may read:
  // the question must still go out, without the page (no switch to turn page
  // reading off any more — an unreadable tab never blocks a question).
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
        `\n--- broker log ---\n${brokerLogTail()}`,
    );
  });
  const answerText = await page.locator(".message--assistant").last().textContent();
  pass(`assistant answer received from the fake provider: ${answerText.slice(0, 80)}`);

  // The settings page loads as a module graph the lab bundle never exercises.
  if (!options) {
    options = await ctx.newPage();
    options.on("pageerror", (e) => optionsErrors.push(String(e)));
  }
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await waitFor(
    async () => (await options.locator("#setupLocal .setup-step").count()) > 0,
    15_000,
    "settings page renders the local setup guide",
  );
  if (optionsErrors.length) throw new Error(`settings page errors:\n${optionsErrors.join("\n")}`);
  pass("settings page rendered the local setup guide without errors");

  if (!ATTACH) {
    // One-click sign-in: the guide asks the program for the sign-in address and opens it; the
    // provider then sends the browser back to the program, which exchanges the code for a key.
    const openRouterRow = options.locator('.setup-service[data-service="openrouter"]:visible');
    await waitFor(
      async () => {
        if ((await openRouterRow.count()) > 0) return true;
        if ((await options.locator("#tabOnline").getAttribute("aria-expanded")) !== "true") await options.locator("#tabOnline").click();
        await options.locator("#addService").evaluate((d) => (d.open = true));
        return false;
      },
      10_000,
      "the online side's service list",
    );
    await openRouterRow.click();
    await options.locator(".setup-oauth button:visible").click();
    // The real site may already have bounced the tab to its sign-up page, which carries the
    // sign-in address as `redirect_url`.
    const signInPage = () => ctx.pages().find((p) => p.url().startsWith("https://openrouter.ai/"));
    await waitFor(async () => Boolean(signInPage()), 10_000, "the sign-in tab").catch(async (err) => {
      const status = await options.locator(".setup-oauth").innerText().catch(() => "?");
      throw new Error(`${err.message}\ntabs: ${ctx.pages().map((p) => p.url()).join(" | ")}\nguide: ${status}\n--- broker log ---\n${brokerLogTail()}`);
    });
    const signIn = signInPage();
    const opened = new URL(signIn.url());
    const authUrl = opened.pathname === "/auth" ? opened : new URL(opened.searchParams.get("redirect_url"));
    await signIn.close();
    const callback = new URL(authUrl.searchParams.get("callback_url"));
    if (authUrl.host !== "openrouter.ai" || callback.hostname !== "localhost") throw new Error(`unexpected sign-in address ${authUrl}`);
    callback.search = new URLSearchParams({ code: "e2e-code", state: authUrl.searchParams.get("state") }).toString();
    const back = await ctx.newPage();
    const response = await back.goto(callback.toString());
    if (response.status() !== 200) throw new Error(`callback answered ${response.status()}: ${await back.locator("body").innerText()}`);
    if (!exchangeBody.includes('"code":"e2e-code"')) throw new Error(`exchange not received: ${exchangeBody}`);
    const saved = JSON.parse(readFileSync(path.join(home, ".config", "coati", "config.json"), "utf8"));
    if (saved.provider !== "openai-compat" || saved.baseUrl !== "https://openrouter.ai/api/v1" || !saved.apiKeys?.["openai-compat"]?.["https://openrouter.ai"]) {
      throw new Error(`OpenRouter not active after sign-in: provider=${saved.provider} baseUrl=${saved.baseUrl}`);
    }
    pass("one-click OpenRouter sign-in: callback on localhost, code exchanged, key saved and service active");
  }

  console.log("== scripts/ci/extension-e2e.mjs: ALL PASS ==");
} catch (err) {
  console.error(`FAIL: ${err.stack || err}`);
  if (process.env.GITHUB_ACTIONS) {
    // Job logs need a signed-in account; annotations are public.
    const enc = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "").replace(/\n/g, "%0A");
    const body = `${err.stack || err}\n--- broker log (tail) ---\n${brokerLogTail().split("\n").slice(-25).join("\n")}`;
    console.log(`::error title=scripts/ci/extension-e2e.mjs::${enc(body).slice(0, 6000)}`);
  }
  process.exitCode = 1;
} finally {
  if (ctx) await ctx.close().catch(() => {});
  cleanup();
}
