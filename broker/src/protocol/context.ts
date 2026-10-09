// Context/Fact/Item/Element wire types (docs/PROTOCOL.md "Page types,
// facts and entries" / "Point at element") and their parser. Split out of
// protocol.ts (lot F5).

import { isRecord } from "./shared.ts";

export type ContextKind = "page" | "youtube";

// Amendement 2026-09-25 (types de page). Only meaningful when kind === "page"
// — see docs/PROTOCOL.md "Page types, facts and entries". Anything outside
// these four literals is not a PageKind: parseContext below drops it, and the
// broker then behaves exactly as it did before this amendment ("other").
export type PageKind = "list" | "listing" | "article" | "other";

// A "label: value" pair read verbatim off the page (context.facts). Only
// carried when pageKind === "listing" — see "Compatibility".
export interface Fact {
  label: string;
  value: string;
}

// One entry of a results page (context.items). Only carried when
// pageKind === "list" — see "Compatibility". `title` is the only required
// field; a malformed/absent one drops the whole entry (parseItem below).
export interface Item {
  title: string;
  price?: string;
  location?: string;
  detail?: string;
}

// Amendement 2026-10-08 (lot A1, "Montrer du doigt"). One interactive element
// the content script numbered on the page — see docs/PROTOCOL.md §2.2. Only
// carried when kind === "page", INDEPENDENT of pageKind (unlike facts/items,
// which require a specific pageKind) — present or not regardless of
// list/listing/article/other.
export interface Element {
  ref: string;
  role: ElementRole;
  label: string;
}

export interface Context {
  kind: ContextKind;
  url?: string;
  title?: string;
  text?: string;
  videoId?: string;

  // Amendement 2026-09-25 (types de page). Optional, page-controlled data —
  // same trust level as `text` (CLAUDE.md rule #3). See model.ts's
  // renderContext for how they're fenced, and server.ts's
  // contextBudgetError for the numeric caps ("Broker-side limits").
  pageKind?: PageKind;
  facts?: Fact[];
  items?: Item[];
  // Amendement 2026-10-08 (lot A1). See Element above.
  elements?: Element[];
}

// Amendement 2026-09-25 (types de page) — "Facts", "Entries", "Size budget".
// These are the contract's numeric bounds: parseContext below only
// enforces *shape* (drops a malformed field/element, never rejects the whole
// message — "Compatibility"); a numeric breach is refused outright by
// server.ts's contextBudgetError, never silently truncated here ("Broker-side
// limits": the broker refuses, it never truncates).
export const FACTS_MAX = 40;
export const FACT_LABEL_MAX = 60;
export const FACT_VALUE_MAX = 160;
export const ITEMS_MAX = 40;
export const ITEM_TITLE_MAX = 160;
export const ITEM_PRICE_MAX = 40;
export const ITEM_LOCATION_MAX = 80;
export const ITEM_DETAIL_MAX = 200;

// Amendement 2026-10-08 (lot A1, "Point at element" — docs/PROTOCOL.md §2.2).
// Same shape/numeric split as facts/items above: parseElement below only
// enforces SHAPE (a malformed element is dropped whole, others kept — no
// closed-list role, no ^e[1-9][0-9]{0,2}$ ref, no non-empty label means "not
// an Element"); the numeric bounds (count, label length) are a contract
// checked by server.ts's contextBudgetError, refused outright, never
// truncated — same "the broker refuses, it never truncates" stance.
export const ELEMENTS_MAX = 120;
export const ELEMENT_LABEL_MAX = 80;
export const ELEMENT_REF_RE = /^e[1-9][0-9]{0,2}$/;
// Closed list (docs/PROTOCOL.md §2.2) — an unknown role is not an ElementRole;
// parseElement drops the whole element, it never widens this list silently.
export const ELEMENT_ROLES = [
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "menuitem",
  "tab",
  "option",
  "switch",
] as const;
export type ElementRole = (typeof ELEMENT_ROLES)[number];

function isPageKind(v: unknown): v is PageKind {
  return v === "list" || v === "listing" || v === "article" || v === "other";
}

// A single facts[] element: kept only if both fields are strings — see
// "Compatibility": "label or value not a string" drops the element, others
// stay. No length/emptiness check here — that's a numeric bound, see
// FACT_LABEL_MAX/FACT_VALUE_MAX above and server.ts's contextBudgetError.
function parseFact(v: unknown): Fact | undefined {
  if (!isRecord(v)) return undefined;
  if (typeof v.label !== "string" || typeof v.value !== "string") return undefined;
  return { label: v.label, value: v.value };
}

function parseFacts(v: unknown): Fact[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map(parseFact).filter((f): f is Fact => f !== undefined);
}

// A single items[] element. `title` absent/non-string/empty drops the whole
// entry — "Entries": "an entry with no non-empty title is dropped". Each
// optional field is dropped on its own (not the whole entry) when present
// but not a string — "Compatibility": "optional field not a string".
function parseItem(v: unknown): Item | undefined {
  if (!isRecord(v)) return undefined;
  if (typeof v.title !== "string" || v.title.length === 0) return undefined;
  const item: Item = { title: v.title };
  if (typeof v.price === "string") item.price = v.price;
  if (typeof v.location === "string") item.location = v.location;
  if (typeof v.detail === "string") item.detail = v.detail;
  return item;
}

function parseItems(v: unknown): Item[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map(parseItem).filter((i): i is Item => i !== undefined);
}

function isElementRole(v: unknown): v is ElementRole {
  return typeof v === "string" && (ELEMENT_ROLES as readonly string[]).includes(v);
}

// A single elements[] entry. Unlike items' optional fields (dropped alone),
// here EVERY field is required for identity — ref/role/label all wrong-shape
// drops the WHOLE element, same as an item with no title — docs/PROTOCOL.md
// §2.2: "Element whose `ref` does not match the pattern, whose `role` is unknown,
// or whose `label` is not a non-empty string: dropped entirely." No
// length/count check here — that's ELEMENT_LABEL_MAX/ELEMENTS_MAX, enforced
// as a numeric contract by server.ts's contextBudgetError, never here.
function parseElement(v: unknown): Element | undefined {
  if (!isRecord(v)) return undefined;
  if (typeof v.ref !== "string" || !ELEMENT_REF_RE.test(v.ref)) return undefined;
  if (!isElementRole(v.role)) return undefined;
  if (typeof v.label !== "string" || v.label.length === 0) return undefined;
  return { ref: v.ref, role: v.role, label: v.label };
}

function parseElements(v: unknown): Element[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map(parseElement).filter((e): e is Element => e !== undefined);
}

export function parseContext(v: unknown): Context | undefined {
  if (v === undefined) return undefined;
  if (!isRecord(v)) return undefined;
  const kind = v.kind;
  if (kind !== "page" && kind !== "youtube") return undefined;
  const context: Context = { kind };
  if (typeof v.url === "string") context.url = v.url;
  if (typeof v.title === "string") context.title = v.title;
  if (typeof v.text === "string") context.text = v.text;
  if (typeof v.videoId === "string") context.videoId = v.videoId;

  // Amendement 2026-09-25 (types de page). pageKind/facts/items only exist
  // for kind === "page" — "Compatibility": "kind other than page →
  // pageKind, facts and items ignored". A pageKind outside the four known
  // values is dropped (undefined), same as an absent one — the client
  // behaves exactly as before this amendment ("other").
  if (kind === "page") {
    if (isPageKind(v.pageKind)) context.pageKind = v.pageKind;
    // "facts with a pageKind other than listing, items with a pageKind
    // other than list → field ignored (not rendered, not counted in budget)".
    if (context.pageKind === "listing") {
      const facts = parseFacts(v.facts);
      if (facts !== undefined) context.facts = facts;
    }
    if (context.pageKind === "list") {
      const items = parseItems(v.items);
      if (items !== undefined) context.items = items;
    }
    // Amendement 2026-10-08 (lot A1): elements is NOT gated by pageKind —
    // present or not regardless of list/listing/article/other, unlike
    // facts/items above.
    const elements = parseElements(v.elements);
    if (elements !== undefined) context.elements = elements;
  }
  return context;
}
