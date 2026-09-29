// Fixture: a module whose import itself throws (top-level code error) — for
// broker/test/loader.test.ts. Must be logged and skipped, never crash the
// broker.
throw new Error("boom: this module fails to import on purpose");

export default function createProvider() {
  return {};
}
