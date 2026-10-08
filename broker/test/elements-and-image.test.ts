// Lot A1 ("Montrer du doigt") + lot B1 ("Regarder l'écran") — docs/PROTOCOL.md
// "Amendement 2026-10-08". Covers the parts of plan §3A/§3B owned by this
// worker: context.elements parsing/budget/render, chat.image validation,
// the two-tier message size cap, and the vision-unsupported gate.

import { describe, expect, test } from "bun:test";
import {
  parseClientMessage,
  MAX_MESSAGE_BYTES,
  MAX_IMAGE_MESSAGE_BYTES,
  ELEMENTS_MAX,
  ELEMENT_LABEL_MAX,
  type ChatMessage,
} from "../src/protocol.ts";
import { buildPrompt, VisionUnsupportedError, isVisionUnsupportedError } from "../src/model.ts";
import { contextBudgetError } from "../src/server.ts";

describe("context.elements — parsing (lot A1)", () => {
  test("parses a well-formed element list", () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: "chat",
        id: "c1",
        text: "hi",
        context: { kind: "page", elements: [{ ref: "e12", role: "button", label: "Générer" }] },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "chat") {
      expect(result.message.context?.elements).toEqual([{ ref: "e12", role: "button", label: "Générer" }]);
    }
  });

  test("drops an element with an unknown role, keeps the others", () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: "chat",
        id: "c1",
        text: "hi",
        context: {
          kind: "page",
          elements: [
            { ref: "e1", role: "spaceship", label: "bad" },
            { ref: "e2", role: "link", label: "good" },
          ],
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "chat") {
      expect(result.message.context?.elements).toEqual([{ ref: "e2", role: "link", label: "good" }]);
    }
  });

  test("drops an element whose ref doesn't match ^e[1-9][0-9]{0,2}$", () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: "chat",
        id: "c1",
        text: "hi",
        context: { kind: "page", elements: [{ ref: "e0", role: "button", label: "x" }] },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "chat") {
      expect(result.message.context?.elements).toEqual([]);
    }
  });

  test("elements is independent of pageKind — present on an 'other' page", () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: "chat",
        id: "c1",
        text: "hi",
        context: { kind: "page", pageKind: "other", elements: [{ ref: "e1", role: "tab", label: "x" }] },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "chat") {
      expect(result.message.context?.elements?.length).toBe(1);
    }
  });

  test("contextBudgetError refuses more than ELEMENTS_MAX entries", () => {
    const elements = Array.from({ length: ELEMENTS_MAX + 1 }, (_, i) => ({
      ref: `e${i + 1}`,
      role: "button" as const,
      label: "x",
    }));
    const err = contextBudgetError({ kind: "page", elements });
    expect(err).toContain(`${ELEMENTS_MAX}`);
  });

  test("contextBudgetError refuses a label over ELEMENT_LABEL_MAX", () => {
    const err = contextBudgetError({
      kind: "page",
      elements: [{ ref: "e1", role: "button", label: "x".repeat(ELEMENT_LABEL_MAX + 1) }],
    });
    expect(err).toContain(`${ELEMENT_LABEL_MAX}`);
  });
});

describe("context.elements — rendering in the prompt (lot A1)", () => {
  test("renders the fixed header and [[ref]] role — label line, after items, before text", () => {
    const built = buildPrompt({
      kind: "chat",
      text: "Où est le bouton ?",
      context: {
        kind: "page",
        text: "Du texte de page.",
        elements: [{ ref: "e12", role: "button", label: "Générer" }],
      },
    });
    expect(built.prompt).toContain("Éléments interactifs visibles :");
    expect(built.prompt).toContain("[[e12]] button — Générer");
    const elementsIdx = built.prompt.indexOf("Éléments interactifs visibles :");
    const textIdx = built.prompt.indexOf("Du texte de page.");
    expect(elementsIdx).toBeGreaterThan(-1);
    expect(textIdx).toBeGreaterThan(elementsIdx);
  });

  test("adds the outside-the-fence instruction only when elements is non-empty", () => {
    const withElements = buildPrompt({
      kind: "chat",
      text: "hi",
      context: { kind: "page", text: "t", elements: [{ ref: "e1", role: "link", label: "x" }] },
    });
    expect(withElements.prompt).toContain("double square brackets");

    const withoutElements = buildPrompt({
      kind: "chat",
      text: "hi",
      context: { kind: "page", text: "t" },
    });
    expect(withoutElements.prompt).not.toContain("double square brackets");
  });

  test("a client with no elements field gets byte-identical prompt shape (no regression)", () => {
    const built = buildPrompt({ kind: "chat", text: "hi", context: { kind: "page", text: "t" } });
    expect(built.prompt).not.toContain("Éléments interactifs visibles");
  });
});

// --- chat.image (lot B1) ----------------------------------------------------

const TINY_JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(20).fill(0)]).toString("base64");
const TINY_PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(20).fill(0)]).toString(
  "base64",
);
const NOT_AN_IMAGE_B64 = Buffer.from("not an image at all").toString("base64");

function chatWithImage(image: unknown): string {
  return JSON.stringify({ type: "chat", id: "c1", text: "regarde", image });
}

describe("chat.image — validation (lot B1)", () => {
  test("accepts a well-formed JPEG image", () => {
    const result = parseClientMessage(
      chatWithImage({ mediaType: "image/jpeg", data: TINY_JPEG_B64, width: 800, height: 600 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "chat") {
      expect((result.message as ChatMessage).image?.mediaType).toBe("image/jpeg");
    }
  });

  test("accepts a well-formed PNG image", () => {
    const result = parseClientMessage(
      chatWithImage({ mediaType: "image/png", data: TINY_PNG_B64, width: 100, height: 100 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "chat") {
      expect((result.message as ChatMessage).image?.mediaType).toBe("image/png");
    }
  });

  test("drops the image (not the chat) when the magic bytes don't match mediaType", () => {
    const result = parseClientMessage(
      chatWithImage({ mediaType: "image/jpeg", data: NOT_AN_IMAGE_B64, width: 100, height: 100 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "chat") {
      expect((result.message as ChatMessage).image).toBeUndefined();
    }
  });

  test("drops the image when mediaType is outside the closed list", () => {
    const result = parseClientMessage(
      chatWithImage({ mediaType: "image/gif", data: TINY_JPEG_B64, width: 100, height: 100 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "chat") {
      expect((result.message as ChatMessage).image).toBeUndefined();
    }
  });

  test("drops the image when a side exceeds 2000px", () => {
    const result = parseClientMessage(
      chatWithImage({ mediaType: "image/jpeg", data: TINY_JPEG_B64, width: 2001, height: 600 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "chat") {
      expect((result.message as ChatMessage).image).toBeUndefined();
    }
  });

  // Note: an image whose decoded bytes exceed IMAGE_MAX_DECODED_BYTES (1 MiB)
  // necessarily produces a base64 frame over MAX_MESSAGE_BYTES (256 KiB) —
  // there is no "small frame, oversized image" case to test in isolation.
  // See the L6 test below (security review 2026-10-08) for what happens to
  // this exact shape under the fixed oversized gate.

  // Security review (L6): a frame whose only path past MAX_MESSAGE_BYTES was
  // an image that turns out INVALID (here: genuinely too big to decode,
  // IMAGE_MAX_DECODED_BYTES) must be refused outright — the 1.5 MiB
  // allowance exists only to carry a VALID image, never as a side door for
  // an oversized frame whose "image" doesn't actually check out.
  test("L6: an oversized frame whose image fails validation (too big) is refused, not silently accepted text-only", () => {
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1024 * 1024 + 10, 1)]);
    const raw = chatWithImage({ mediaType: "image/jpeg", data: big.toString("base64"), width: 800, height: 600 });
    expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(MAX_MESSAGE_BYTES);
    const result = parseClientMessage(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.oversized).toBe(true);
  });
});

describe("message size cap — 256 KiB vs 1.5 MiB (lot B1, docs/PROTOCOL.md §5)", () => {
  test("a chat with text only over 256 KiB is still refused at MAX_MESSAGE_BYTES", () => {
    const raw = JSON.stringify({ type: "chat", id: "c1", text: "x".repeat(MAX_MESSAGE_BYTES + 1) });
    const result = parseClientMessage(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe(`message exceeds ${MAX_MESSAGE_BYTES} byte cap`);
      expect(result.error.oversized).toBe(true);
    }
  });

  test("a chat with a well-formed image is allowed up to MAX_IMAGE_MESSAGE_BYTES", () => {
    // Padding, not a real decodable image beyond the magic bytes — well
    // under the 1 MiB decoded cap, but the padded TEXT field pushes the
    // whole JSON message past MAX_MESSAGE_BYTES while staying under 1.5 MiB.
    const raw = JSON.stringify({
      type: "chat",
      id: "c1",
      text: "x".repeat(MAX_MESSAGE_BYTES + 1000),
      image: { mediaType: "image/jpeg", data: TINY_JPEG_B64, width: 800, height: 600 },
    });
    expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(MAX_MESSAGE_BYTES);
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThan(MAX_IMAGE_MESSAGE_BYTES);
    const result = parseClientMessage(raw);
    expect(result.ok).toBe(true);
  });

  test("a chat claiming an image but over MAX_IMAGE_MESSAGE_BYTES is refused", () => {
    const raw = JSON.stringify({
      type: "chat",
      id: "c1",
      text: "x".repeat(MAX_IMAGE_MESSAGE_BYTES + 1000),
      image: { mediaType: "image/jpeg", data: TINY_JPEG_B64, width: 800, height: 600 },
    });
    const result = parseClientMessage(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.oversized).toBe(true);
    }
  });
});

describe("VisionUnsupportedError (lot B1)", () => {
  test("isVisionUnsupportedError recognises the typed error, not a generic one", () => {
    expect(isVisionUnsupportedError(new VisionUnsupportedError("no vision"))).toBe(true);
    expect(isVisionUnsupportedError(new Error("no vision"))).toBe(false);
  });
});

describe("security review 2026-10-08 — L5/L6 fixes", () => {
  test("L5: data is re-encoded canonically, never the client's raw base64 string", () => {
    // Valid JPEG bytes, but encoded with a non-canonical base64 variant
    // (URL-safe alphabet + missing padding) that Buffer.from still decodes
    // leniently — the client's raw string must never reach the wire back out.
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(20).fill(0)]);
    const canonical = bytes.toString("base64");
    const nonCanonical = canonical.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(nonCanonical).not.toBe(canonical);
    const result = parseClientMessage(
      chatWithImage({ mediaType: "image/jpeg", data: nonCanonical, width: 800, height: 600 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "chat") {
      expect((result.message as ChatMessage).image?.data).toBe(canonical);
      expect((result.message as ChatMessage).image?.data).not.toBe(nonCanonical);
    }
  });

  test("L6: a fake image field can't be used to smuggle a huge text payload past 256 KiB", () => {
    // `image` LOOKS like chat+image (an object) to the cheap shape gate, so
    // the frame is let past the 256 KiB byte-length check — but it never
    // parses as a valid image, so it must still be held to 256 KiB on the
    // whole message, not silently accepted up to 1.5 MiB.
    const raw = JSON.stringify({
      type: "chat",
      id: "c1",
      text: "x".repeat(MAX_MESSAGE_BYTES + 1000),
      image: { not: "a real image" },
    });
    expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(MAX_MESSAGE_BYTES);
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThan(MAX_IMAGE_MESSAGE_BYTES);
    const result = parseClientMessage(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.oversized).toBe(true);
      expect(result.error.message).toBe(`message exceeds ${MAX_MESSAGE_BYTES} byte cap`);
    }
  });

  test("L6: a VALID image still gets the full 1.5 MiB allowance (no regression)", () => {
    const raw = JSON.stringify({
      type: "chat",
      id: "c1",
      text: "x".repeat(MAX_MESSAGE_BYTES + 1000),
      image: { mediaType: "image/jpeg", data: TINY_JPEG_B64, width: 800, height: 600 },
    });
    const result = parseClientMessage(raw);
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "chat") {
      expect((result.message as ChatMessage).image).toBeDefined();
    }
  });
});
