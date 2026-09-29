// Unit tests for the external provider module loader (docs/MODULES.md,
// docs/PROTOCOL.md's amendement 2026-09-29) — broker/src/providers/registry.ts.
// Covers the four cases CLAUDE.md security rule #3 requires: a valid module
// loads, a broken module (import throws, bad shape, missing default export)
// is logged and skipped rather than crashing, and a missing file behaves the
// same way. Never loads anything but a local file path.

import { describe, expect, test, afterEach } from "bun:test";
import { join } from "node:path";
import { loadProviderModules, initRegistry, getProviders, __resetProvidersForTests } from "../src/providers/registry.ts";
import { buildProviderHost, type ProviderLogger } from "../src/providers/host.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "modules");

function fakeHost(): { host: ReturnType<typeof buildProviderHost>; warnings: string[]; infos: string[] } {
  const warnings: string[] = [];
  const infos: string[] = [];
  const logger: ProviderLogger = {
    info: (m) => infos.push(m),
    warn: (m) => warnings.push(m),
  };
  return { host: buildProviderHost(logger), warnings, infos };
}

afterEach(() => {
  __resetProvidersForTests();
});

describe("loadProviderModules", () => {
  test("a valid module loads and its provider is usable", async () => {
    const { host, warnings } = fakeHost();
    const { providers, warnings: loadWarnings } = await loadProviderModules(
      [{ path: join(FIXTURES, "valid-provider.ts") }],
      host,
    );
    expect(loadWarnings).toEqual([]);
    expect(warnings).toEqual([]);
    expect(providers).toHaveLength(1);
    expect(providers[0]!.id).toBe("fixture-valid");
    const availability = await providers[0]!.isAvailable({});
    expect(availability.available).toBe(true);
  });

  test("options are passed through to createProvider untouched", async () => {
    const { host } = fakeHost();
    const { providers } = await loadProviderModules(
      [{ path: join(FIXTURES, "valid-provider.ts"), options: { id: "renamed", label: "Renamed" } }],
      host,
    );
    expect(providers[0]!.id).toBe("renamed");
    expect(providers[0]!.label).toBe("Renamed");
  });

  // loadProviderModules() itself only RETURNS warnings — it's initRegistry()
  // (tested below) that forwards them to host.logger.warn.
  test("a module whose import throws is logged and skipped, never crashes", async () => {
    const { host } = fakeHost();
    const { providers, warnings: loadWarnings } = await loadProviderModules(
      [{ path: join(FIXTURES, "throwing-provider.ts") }],
      host,
    );
    expect(providers).toEqual([]);
    expect(loadWarnings).toHaveLength(1);
    expect(loadWarnings[0]).toContain("failed to import");
  });

  test("a module with no default export is logged and skipped", async () => {
    const { host } = fakeHost();
    const { providers, warnings } = await loadProviderModules(
      [{ path: join(FIXTURES, "no-default-export.ts") }],
      host,
    );
    expect(providers).toEqual([]);
    expect(warnings[0]).toContain("no default export function");
  });

  test("a module returning the wrong shape is logged and skipped", async () => {
    const { host } = fakeHost();
    const { providers, warnings } = await loadProviderModules(
      [{ path: join(FIXTURES, "bad-shape-provider.ts") }],
      host,
    );
    expect(providers).toEqual([]);
    expect(warnings[0]).toContain("did not return a valid provider");
  });

  test("a missing file is logged and skipped", async () => {
    const { host } = fakeHost();
    const { providers, warnings } = await loadProviderModules(
      [{ path: join(FIXTURES, "does-not-exist.ts") }],
      host,
    );
    expect(providers).toEqual([]);
    expect(warnings[0]).toContain("failed to import");
  });

  test("one broken module among several never blocks the valid ones from loading", async () => {
    const { host } = fakeHost();
    const { providers, warnings } = await loadProviderModules(
      [
        { path: join(FIXTURES, "throwing-provider.ts") },
        { path: join(FIXTURES, "valid-provider.ts"), options: { id: "second-valid" } },
        { path: join(FIXTURES, "bad-shape-provider.ts") },
      ],
      host,
    );
    expect(providers.map((p) => p.id)).toEqual(["second-valid"]);
    expect(warnings).toHaveLength(2);
  });

  test("no entries at all: no providers, no warnings", async () => {
    const { host, warnings } = fakeHost();
    const { providers, warnings: loadWarnings } = await loadProviderModules([], host);
    expect(providers).toEqual([]);
    expect(loadWarnings).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("initRegistry — installs built-ins + loaded modules as the process-wide registry", () => {
  test("with no modules: only the two built-ins", async () => {
    await initRegistry([]);
    expect(getProviders().map((p) => p.id)).toEqual(["ollama", "claude-api"]);
  });

  test("with a valid module: built-ins plus it", async () => {
    await initRegistry([{ path: join(FIXTURES, "valid-provider.ts") }]);
    expect(getProviders().map((p) => p.id)).toEqual(["ollama", "claude-api", "fixture-valid"]);
  });

  test("a broken module leaves only the built-ins, never throws", async () => {
    await expect(initRegistry([{ path: join(FIXTURES, "throwing-provider.ts") }])).resolves.toBeDefined();
    expect(getProviders().map((p) => p.id)).toEqual(["ollama", "claude-api"]);
  });
});
