// Fixture: a valid external provider module, for broker/test/loader.test.ts.
// Mirrors the shape docs/MODULES.md documents.
export default function createProvider(host: any, options: any) {
  return {
    id: options?.id ?? "fixture-valid",
    label: options?.label ?? "Fixture Valid Provider",
    async isAvailable() {
      return { available: true };
    },
    async checkStatus() {
      return { state: "ok", reason: "ready" };
    },
    async *streamAnswer(built: any) {
      yield { kind: "delta", text: `echo:${built.prompt}` };
      yield { kind: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}
