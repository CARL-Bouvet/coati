// Fixture: a module whose default export IS a function, but the object it
// returns doesn't have the required ModelProvider shape — for
// broker/test/loader.test.ts. Must be logged and skipped, never crash.
export default function createProvider() {
  return { id: "missing-the-rest" }; // no label, no isAvailable/checkStatus/streamAnswer
}
