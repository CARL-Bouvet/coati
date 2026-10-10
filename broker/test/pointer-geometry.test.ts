// Unit tests for the pure maths inside content/pointer.js ("Montrer du
// doigt" highlight, 3 intensity levels — product-owner feedback 08/10).
// pointer.js is a classic content script (no import/export, loaded via
// `executeScript({ files: [...] })`), so it can't be driven like a normal
// module — but importing it for its side effect is safe: nothing at its
// top level touches the DOM, it only *defines* functions and assigns
// `globalThis.__coatiPoint` / `globalThis.__coatiPointerInternals`, neither
// of which runs anything yet. `__coatiPointerInternals` is a test-only hook
// exposing the two pure helpers (normalizeEffect, pickArrowSide) with no
// access to page state — same spirit as retention.test.ts importing
// DOM-free logic straight from extension/panel/.
import { describe, expect, test } from "bun:test";
import "../../extension/content/pointer.js";

const { normalizeEffect, pickArrowSide } = (globalThis as any).__coatiPointerInternals;

describe("normalizeEffect", () => {
  test("accepts the three known levels", () => {
    expect(normalizeEffect("subtle")).toBe("subtle");
    expect(normalizeEffect("strong")).toBe("strong");
    expect(normalizeEffect("spectacular")).toBe("spectacular");
  });

  test("falls back to 'strong' for anything else, including undefined/garbage", () => {
    expect(normalizeEffect(undefined)).toBe("strong");
    expect(normalizeEffect(null)).toBe("strong");
    expect(normalizeEffect("")).toBe("strong");
    expect(normalizeEffect("nonsense")).toBe("strong");
  });
});

describe("pickArrowSide", () => {
  const VIEWPORT_W = 1200;
  const VIEWPORT_H = 800;

  test("picks the side with the most room — plenty below, element near the top", () => {
    const rect = { top: 20, bottom: 60, left: 500, right: 600, width: 100, height: 40 };
    expect(pickArrowSide(rect, VIEWPORT_W, VIEWPORT_H)).toBe("bottom");
  });

  test("picks 'top' when the element sits near the bottom of the viewport", () => {
    const rect = { top: 740, bottom: 780, left: 500, right: 600, width: 100, height: 40 };
    expect(pickArrowSide(rect, VIEWPORT_W, VIEWPORT_H)).toBe("top");
  });

  test("picks 'left' when the element is pinned to the right edge", () => {
    const rect = { top: 350, bottom: 390, left: 1150, right: 1195, width: 45, height: 40 };
    expect(pickArrowSide(rect, VIEWPORT_W, VIEWPORT_H)).toBe("left");
  });

  test("picks 'right' when the element is pinned to the left edge", () => {
    const rect = { top: 350, bottom: 390, left: 5, right: 50, width: 45, height: 40 };
    expect(pickArrowSide(rect, VIEWPORT_W, VIEWPORT_H)).toBe("right");
  });

  test("a perfectly centered element still returns one of the four sides", () => {
    const rect = { top: 380, bottom: 420, left: 575, right: 625, width: 50, height: 40 };
    expect(["top", "bottom", "left", "right"]).toContain(pickArrowSide(rect, VIEWPORT_W, VIEWPORT_H));
  });
});

// --- Click and type: refusal rules and the live-element check -------------
import "../../extension/content/forbidden-gesture.js";

type FakeAttrs = Record<string, string>;
function fake(tag: string, attrs: FakeAttrs = {}, text = "", inForm = false) {
  return {
    tagName: tag,
    innerText: text,
    isConnected: true,
    form: inForm ? {} : null,
    value: "",
    events: [] as string[],
    clicks: 0,
    getAttribute(n: string) {
      return n in attrs ? attrs[n] : null;
    },
    hasAttribute(n: string) {
      return n in attrs;
    },
    closest: () => null,
    click() {
      this.clicks++;
    },
    dispatchEvent(e: { type: string }) {
      this.events.push(e.type);
    },
  };
}
const forbidden = (el: any, action = "click") => (globalThis as any).__coatiForbiddenGesture(el, action);

describe("forbidden gestures", () => {
  test("password, card, one-time-code and iban fields", () => {
    expect(forbidden(fake("INPUT", { type: "password" }), "type")).toBe("sensitive-field");
    expect(forbidden(fake("INPUT", { type: "text", autocomplete: "cc-number" }), "type")).toBe("sensitive-field");
    expect(forbidden(fake("INPUT", { type: "text", autocomplete: "new-password" }), "type")).toBe("sensitive-field");
    expect(forbidden(fake("INPUT", { type: "text", autocomplete: "one-time-code" }), "type")).toBe("sensitive-field");
    expect(forbidden(fake("INPUT", { type: "text", name: "user_iban" }), "type")).toBe("sensitive-field");
    expect(forbidden(fake("INPUT", { type: "text", id: "cvv" }), "type")).toBe("sensitive-field");
  });

  test("form submit buttons: refused unless a plain GET form without a password field", () => {
    const form = (method: string | null, password = false) => ({
      getAttribute: (n: string) => (n === "method" ? method : null),
      querySelector: () => (password ? {} : null),
    });
    const inside = (f: any, attrs: Record<string, string> = {}) => ({ ...fake("BUTTON", attrs, "Go"), form: f });
    expect(forbidden(fake("BUTTON", { type: "submit" }, "Go"))).toBe("form-submit");
    expect(forbidden(fake("INPUT", { type: "submit", value: "Go" }))).toBe("form-submit");
    expect(forbidden(inside(form("post")))).toBe("form-submit");
    expect(forbidden(inside(form(null, true)))).toBe("form-submit");
    expect(forbidden(inside(form("get"), { formmethod: "post" }))).toBe("form-submit");
    expect(forbidden(inside(form(null)))).toBeNull();
    expect(forbidden(inside(form("GET"), { type: "submit" }))).toBeNull();
    expect(forbidden(fake("BUTTON", { type: "button" }, "Go", true))).toBeNull();
  });

  test("labels in English, French and Chinese, also in aria-label / value / title", () => {
    for (const label of ["Pay now", "Buy", "Checkout", "Delete", "Sign in", "Log in", "Publish", "Send", "Payer", "Acheter", "Se connecter", "S’inscrire", "Supprimer", "支付", "登录", "删除"]) {
      expect(forbidden(fake("A", {}, label))).toBe("forbidden-label");
    }
    expect(forbidden(fake("A", { "aria-label": "Commander" }, "→"))).toBe("forbidden-label");
    expect(forbidden(fake("A", { title: "下单" }, "→"))).toBe("forbidden-label");
  });

  test("a Search button outside a form is allowed; typing needs a text field", () => {
    expect(forbidden(fake("BUTTON", {}, "Search"))).toBeNull();
    expect(forbidden(fake("A", {}, "Rechercher"))).toBeNull();
    expect(forbidden(fake("BUTTON", {}, "Search"), "type")).toBe("not-editable");
    expect(forbidden(fake("INPUT", { type: "search" }, ""), "type")).toBeNull();
  });
});

describe("__coatiAct", () => {
  function setup(el: any, role = "textbox", label = "Name") {
    (globalThis as any).__coatiRefs = {
      extractionId: "x1",
      map: new Map([["e1", { weakRef: new WeakRef(el), role, label }]]),
    };
    return { extractionId: "x1", ref: "e1", role, label };
  }
  const act = (o: any) => (globalThis as any).__coatiAct(o);

  test("types by setting the value and firing input + change, never a key", () => {
    const el = fake("INPUT", { type: "text", placeholder: "Name" });
    const out = act({ ...setup(el), action: "type", text: "Ada" });
    expect(out.status).toBe("done");
    expect(el.value).toBe("Ada");
    expect(el.events).toEqual(["input", "change"]);
  });

  test("a password field is never filled", () => {
    const el = fake("INPUT", { type: "password", placeholder: "Name" });
    const out = act({ ...setup(el), action: "type", text: "secret" });
    expect(out).toEqual({ status: "blocked", reason: "sensitive-field" });
    expect(el.value).toBe("");
    expect(el.events).toEqual([]);
  });

  test("a click on an allowed button runs; on a submit button it does not", () => {
    const ok = fake("BUTTON", {}, "Search");
    expect(act({ ...setup(ok, "button", "Search"), action: "click" }).status).toBe("done");
    expect(ok.clicks).toBe(1);
    const submit = fake("BUTTON", { type: "submit" }, "Search");
    expect(act({ ...setup(submit, "button", "Search"), action: "click" }).reason).toBe("form-submit");
    expect(submit.clicks).toBe(0);
  });

  test("a stale reference changes nothing", () => {
    const el = fake("BUTTON", {}, "Search");
    const target = setup(el, "button", "Search");
    expect(act({ ...target, extractionId: "other", action: "click" }).status).toBe("stale");
    expect(act({ ...target, ref: "e9", action: "click" }).status).toBe("stale");
    expect(act({ ...target, label: "Other", action: "click" }).status).toBe("stale");
    el.isConnected = false;
    expect(act({ ...target, action: "click" }).status).toBe("stale");
    el.isConnected = true;
    (el as any).innerText = "Changed";
    expect(act({ ...target, action: "click" }).status).toBe("stale");
    expect(el.clicks).toBe(0);
  });
});
