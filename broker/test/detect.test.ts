// Unit tests for the page-type classifier. It lives under extension/content/
// (see comment there for why) but is plain, DOM-free JS, so it imports and
// runs fine from the broker's test runner without any browser mocking.
import { describe, expect, test } from "bun:test";
import { classifyPageType, classifyPageTypeFromMetadata } from "../../extension/content/detect.js";

describe("classifyPageType", () => {
  test("a YouTube watch URL is a video, even without a transcript yet", () => {
    const type = classifyPageType({
      url: "https://www.youtube.com/watch?v=abc123",
      textLength: 0,
      hasTranscript: false,
      hasVideoElement: false,
    });
    expect(type).toBe("video");
  });

  test("youtu.be short links are also videos", () => {
    const type = classifyPageType({ url: "https://youtu.be/abc123" });
    expect(type).toBe("video");
  });

  test("a <video> element with a transcript is a video even off YouTube", () => {
    const type = classifyPageType({
      url: "https://example.com/lesson",
      hasVideoElement: true,
      hasTranscript: true,
      textLength: 50,
    });
    expect(type).toBe("video");
  });

  test("a <video> element without a transcript is not enough to call it a video", () => {
    const type = classifyPageType({
      url: "https://example.com/ad-page",
      hasVideoElement: true,
      hasTranscript: false,
      textLength: 50,
    });
    expect(type).toBe("page");
  });

  test("<article> markup makes it an article regardless of length", () => {
    const type = classifyPageType({
      url: "https://example.com/post",
      hasArticleMarkup: true,
      textLength: 10,
    });
    expect(type).toBe("article");
  });

  test("a dense text block above the threshold is an article without explicit markup", () => {
    const type = classifyPageType({
      url: "https://example.com/blog/post",
      textLength: 5000,
    });
    expect(type).toBe("article");
  });

  test("a bare page with little text and no markers falls back to 'page'", () => {
    const type = classifyPageType({
      url: "https://example.com/",
      title: "Example",
      textLength: 40,
      hasTranscript: false,
      hasVideoElement: false,
    });
    expect(type).toBe("page");
  });

  test("missing signals default safely to 'page'", () => {
    expect(classifyPageType()).toBe("page");
    expect(classifyPageType({})).toBe("page");
  });

  test("a YouTube URL wins over article-length text (e.g. a long description)", () => {
    const type = classifyPageType({
      url: "https://www.youtube.com/watch?v=xyz",
      textLength: 9000,
      hasArticleMarkup: true,
    });
    expect(type).toBe("video");
  });
});

// URL-only classifier — used on tab switch, where reading the page is
// forbidden (règle du geste, CLAUDE.md rule #5). Must never guess: only a
// shape genuinely legible from the URL alone resolves to a type.
describe("classifyPageTypeFromMetadata", () => {
  test("a YouTube watch URL is a video from the URL alone", () => {
    const type = classifyPageTypeFromMetadata({ url: "https://www.youtube.com/watch?v=abc123" });
    expect(type).toBe("video");
  });

  test("a YouTube home URL is not a video", () => {
    const type = classifyPageTypeFromMetadata({ url: "https://www.youtube.com/" });
    expect(type).toBe(null);
  });

  test("an arbitrary article URL stays unknown, not 'article' — no guessing from shape alone", () => {
    const type = classifyPageTypeFromMetadata({
      url: "https://example.com/blog/post",
      title: "A very long article title that reads like a real post",
    });
    expect(type).toBe(null);
  });

  test("a chrome:// URL is unknown", () => {
    const type = classifyPageTypeFromMetadata({ url: "chrome://extensions" });
    expect(type).toBe(null);
  });

  test("missing signals default safely to unknown", () => {
    expect(classifyPageTypeFromMetadata()).toBe(null);
    expect(classifyPageTypeFromMetadata({})).toBe(null);
  });
});
