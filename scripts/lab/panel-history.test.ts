// Amendement 2026-10-08 bis ("historique", docs/PROTOCOL.md) — pure logic
// of extension/panel/history.js. Same convention as g5-panel-state.test.ts:
// lives under scripts/lab/ but imports the real extension module directly
// (paths are root-based), no chrome.*/DOM involved.
import { describe, expect, test } from "bun:test";
import {
  extractExchanges,
  buildHistoryForWire,
  historyAlertState,
  HISTORY_MAX_EXCHANGES,
  LONG_CONVERSATION_FROM_EXCHANGES,
} from "../../extension/panel/history.js";

function userMsg(text, overrides = {}) {
  return { id: `${text}-u`, role: "user", text, relaunch: { type: "chat", text }, ...overrides };
}
function assistantMsg(text, overrides = {}) {
  return { id: `${text}-a`, role: "assistant", text, ...overrides };
}

describe("extractExchanges", () => {
  test("pairs a user turn with the following assistant turn", () => {
    const conversation = [userMsg("Q1"), assistantMsg("A1")];
    expect(extractExchanges(conversation)).toEqual([{ userText: "Q1", assistantText: "A1" }]);
  });

  test("notice/system messages in between never break a pending pair", () => {
    const conversation = [userMsg("Q1"), { id: "n", role: "notice", text: "..." }, assistantMsg("A1")];
    expect(extractExchanges(conversation)).toEqual([{ userText: "Q1", assistantText: "A1" }]);
  });

  test("a still-streaming answer is excluded, but still consumes the pending user turn", () => {
    const conversation = [userMsg("Q1"), assistantMsg("", { streaming: true }), userMsg("Q2"), assistantMsg("A2")];
    expect(extractExchanges(conversation)).toEqual([{ userText: "Q2", assistantText: "A2" }]);
  });

  test("a cancelled or failed answer is excluded", () => {
    const conversation = [
      userMsg("Q1"),
      assistantMsg("some partial text", { cancelled: true }),
      userMsg("Q2"),
      assistantMsg("sorry", { modelUnavailable: true }),
      userMsg("Q3"),
      assistantMsg("A3"),
    ];
    expect(extractExchanges(conversation)).toEqual([{ userText: "Q3", assistantText: "A3" }]);
  });

  test("prefers msg.relaunch.text over msg.text (strips the '+page attached' display suffix)", () => {
    const conversation = [
      { id: "u", role: "user", text: "Q1\n\n+ page", relaunch: { type: "chat", text: "Q1" } },
      assistantMsg("A1"),
    ];
    expect(extractExchanges(conversation)).toEqual([{ userText: "Q1", assistantText: "A1" }]);
  });

  test("a summarize-triggered exchange (relaunch.type 'summarize') counts too, using msg.text as-is", () => {
    const conversation = [
      { id: "u", role: "user", text: "Résumer : titre", relaunch: { type: "summarize" } },
      assistantMsg("Le résumé."),
    ];
    expect(extractExchanges(conversation)).toEqual([{ userText: "Résumer : titre", assistantText: "Le résumé." }]);
  });
});

describe("buildHistoryForWire", () => {
  test("empty conversation yields no entries", () => {
    expect(buildHistoryForWire([])).toEqual({ entries: [], totalExchanges: 0, sentExchanges: 0 });
  });

  test("builds alternating {role,text} entries, oldest first", () => {
    const conversation = [userMsg("Q1"), assistantMsg("A1")];
    expect(buildHistoryForWire(conversation).entries).toEqual([
      { role: "user", text: "Q1" },
      { role: "assistant", text: "A1" },
    ]);
  });

  test(`caps at ${HISTORY_MAX_EXCHANGES} exchanges, dropping the OLDEST first`, () => {
    const conversation = [];
    for (let i = 0; i < HISTORY_MAX_EXCHANGES + 3; i++) {
      conversation.push(userMsg(`Q${i}`), assistantMsg(`A${i}`));
    }
    const { entries, totalExchanges, sentExchanges } = buildHistoryForWire(conversation);
    expect(totalExchanges).toBe(HISTORY_MAX_EXCHANGES + 3);
    expect(sentExchanges).toBe(HISTORY_MAX_EXCHANGES);
    expect(entries).toHaveLength(HISTORY_MAX_EXCHANGES * 2);
    expect(entries[0]).toEqual({ role: "user", text: "Q3" }); // the 3 oldest (Q0-Q2) were dropped
  });
});

describe("historyAlertState", () => {
  test("null below the long-conversation threshold, nothing dropped", () => {
    expect(historyAlertState({ totalExchanges: LONG_CONVERSATION_FROM_EXCHANGES - 1, sentExchanges: LONG_CONVERSATION_FROM_EXCHANGES - 1 })).toBeNull();
  });

  test("'long' from the configured threshold, nothing dropped", () => {
    expect(historyAlertState({ totalExchanges: LONG_CONVERSATION_FROM_EXCHANGES, sentExchanges: LONG_CONVERSATION_FROM_EXCHANGES })).toBe("long");
  });

  test("'dropped' when the panel's own cap already left exchanges out", () => {
    expect(historyAlertState({ totalExchanges: HISTORY_MAX_EXCHANGES + 1, sentExchanges: HISTORY_MAX_EXCHANGES })).toBe("dropped");
  });

  test("'dropped' when the broker reports keeping fewer entries than were sent", () => {
    expect(historyAlertState({ totalExchanges: 3, sentExchanges: 3, historyKept: 4 })).toBe("dropped");
  });

  test("historyKept equal to what was sent is not 'dropped'", () => {
    expect(historyAlertState({ totalExchanges: 3, sentExchanges: 3, historyKept: 6 })).toBeNull();
  });
});
