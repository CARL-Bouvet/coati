// Coati state lab — chrome/browser API stub.
//
// Classic script (no ES modules — file:// refuses them), loaded BEFORE the
// bundled panel.js/options.js IIFE. Replays a per-state FIXTURE (see
// fixtures/panel-fixtures.js, fixtures/options-fixtures.js) so the real page
// code reaches a deterministic target state with no network, no broker, no
// real extension runtime.
//
// Regenerated verbatim into every .tmp/lab/<light|dark> tree by
// scripts/lab/build-lab.ts — never edit a copy in .tmp/lab, edit this file
// or the fixtures instead.
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  var stateId = params.get("state") || "idle";

  // --- i18n (G6) -----------------------------------------------------------
  // `?lang=en|fr|zh_CN`, default "fr" so existing captures made before G6
  // don't change. window.__COATI_LAB_MESSAGES__ is written by build-lab.ts
  // from the REAL extension/_locales/<lang>/messages.json files — never
  // hand-duplicated here.
  var lang = params.get("lang") || "fr";
  var messagesTable = (window.__COATI_LAB_MESSAGES__ && window.__COATI_LAB_MESSAGES__[lang]) || {};
  document.documentElement.lang = lang;
  function labGetMessage(key, substitutions) {
    var entry = messagesTable[key];
    if (!entry) return key;
    var text = entry.message;
    if (substitutions != null) {
      var values = Array.isArray(substitutions) ? substitutions : [substitutions];
      var i = 0;
      text = text.replace(/\$[A-Z][A-Z0-9_]*\$/g, function () {
        var v = values[i++];
        return v == null ? "" : String(v);
      });
    }
    return text;
  }
  var table = window.__COATI_LAB_FIXTURES__ || {};
  var fixture = table[stateId];
  if (!fixture) {
    var firstKey = Object.keys(table)[0];
    console.error("[lab] unknown state id '" + stateId + "' — falling back to '" + firstKey + "'");
    fixture = table[firstKey] || {};
    stateId = firstKey || stateId;
  }
  window.__COATI_LAB_STATE__ = stateId;
  window.__COATI_LAB_FIXTURE__ = fixture;

  // --- Prompts + prefs in-memory store (docs/PROTOCOL.md "Bibliothèque de
  // prompts et préférences par site") ---------------------------------------
  // Seeded from the fixture (fixture.prompts: PromptEntry[], fixture.prefs:
  // {sites: {...}}), then mutated in place by prompts.save/delete/move and
  // prefs.set — a real (if tiny) broker stand-in, so clicking in the lab
  // works: a saved prompt actually shows up in the encart on the next
  // prompts.list, an order change actually reorders it.
  var promptsStore = (fixture.prompts || []).map(function (p) {
    return Object.assign({}, p);
  });
  var prefsStore = {};
  Object.keys((fixture.prefs && fixture.prefs.sites) || {}).forEach(function (site) {
    var entry = fixture.prefs.sites[site];
    prefsStore[site] = {
      order: (entry.order || []).slice(),
      removed: (entry.removed || []).slice(),
    };
  });
  var nextPromptId = 1;
  function newPromptId() {
    return "p_lab" + String(nextPromptId++).padStart(8, "0");
  }

  function promptsReply(extra) {
    return Object.assign({ type: "prompts", items: promptsStore.slice() }, extra || {});
  }

  function prefsReply() {
    return { type: "prefs", sites: JSON.parse(JSON.stringify(prefsStore)) };
  }

  function handlePromptsSave(prompt) {
    if (prompt && prompt.id) {
      var existing = promptsStore.find(function (p) {
        return p.id === prompt.id;
      });
      if (existing) {
        if (typeof prompt.title === "string") existing.title = prompt.title;
        if (typeof prompt.body === "string") existing.body = prompt.body;
      }
    } else if (prompt) {
      promptsStore.push({ id: newPromptId(), site: prompt.site, title: prompt.title, body: prompt.body });
    }
    return promptsReply();
  }

  function handlePromptsDelete(promptId) {
    promptsStore = promptsStore.filter(function (p) {
      return p.id !== promptId;
    });
    return promptsReply();
  }

  function handlePromptsMove(promptId, site, order) {
    var prompt = promptsStore.find(function (p) {
      return p.id === promptId;
    });
    var sourceSite = prompt ? prompt.site : null;
    if (prompt) prompt.site = site;
    if (sourceSite && sourceSite !== site && prefsStore[sourceSite]) {
      prefsStore[sourceSite].order = (prefsStore[sourceSite].order || []).filter(function (id) {
        return id !== promptId;
      });
    }
    prefsStore[site] = Object.assign({}, prefsStore[site], { order: (order || []).slice() });
    return promptsReply({ prefs: { sites: JSON.parse(JSON.stringify(prefsStore)) } });
  }

  function handlePrefsSet(site, prefs) {
    var current = prefsStore[site] || {};
    var next = {
      order: prefs && Array.isArray(prefs.order) ? prefs.order.slice() : current.order || [],
      removed: prefs && Array.isArray(prefs.removed) ? prefs.removed.slice() : current.removed || [],
    };
    if (next.order.length === 0 && next.removed.length === 0) {
      delete prefsStore[site];
    } else {
      prefsStore[site] = next;
    }
    return prefsReply();
  }

  // Number of permissions.request() calls the fixture let through. Fixtures
  // with `tabAfterGrant` / `extractionAfterGrant` switch to those once a
  // grant happened (G5, the encart's "Lire cette page" button: no access
  // before the click, a readable page after it).
  var grantCount = 0;
  function currentTab() {
    return grantCount > 0 && fixture.tabAfterGrant ? fixture.tabAfterGrant : fixture.tab;
  }

  // --- storage.local / storage.session -----------------------------------
  function makeArea(seed) {
    var store = Object.assign({}, seed || {});
    return {
      get: function (keys) {
        var out = {};
        if (keys == null) {
          Object.assign(out, store);
        } else if (typeof keys === "string") {
          if (keys in store) out[keys] = store[keys];
        } else if (Array.isArray(keys)) {
          keys.forEach(function (k) {
            if (k in store) out[k] = store[k];
          });
        } else {
          Object.keys(keys).forEach(function (k) {
            out[k] = k in store ? store[k] : keys[k];
          });
        }
        return Promise.resolve(out);
      },
      set: function (items) {
        Object.assign(store, items);
        return Promise.resolve();
      },
      remove: function (keys) {
        (Array.isArray(keys) ? keys : [keys]).forEach(function (k) {
          delete store[k];
        });
        return Promise.resolve();
      },
    };
  }

  // --- runtime.onMessage listeners ---------------------------------------
  var messageListeners = [];

  function dispatchToListeners(message) {
    messageListeners.slice().forEach(function (fn) {
      try {
        fn(message);
      } catch (err) {
        console.error("[lab] onMessage listener threw", err);
      }
    });
  }
  // Exposed so lab-runtime.js's scripted "broker-message" steps can inject
  // a message through the exact same path a real broker reply would use.
  window.__coatiLabDispatch = dispatchToListeners;

  // --- runtime.sendMessage router -----------------------------------------
  function handleSendMessage(message) {
    if (!message || typeof message !== "object") return Promise.resolve(null);

    if (message.type === "coati:panel-ready" || message.type === "coati:get-status") {
      return Promise.resolve({ state: fixture.status || "connected", workerInstanceId: "lab" });
    }

    if (message.type === "coati:set-token") {
      return Promise.resolve(null);
    }

    if (message.type === "coati:client-message") {
      var payload = message.payload || {};
      if (payload.type === "prompts.list") {
        setTimeout(function () {
          dispatchToListeners({ type: "coati:broker-message", message: promptsReply() });
        }, 0);
      } else if (payload.type === "prompts.save") {
        setTimeout(function () {
          dispatchToListeners({ type: "coati:broker-message", message: handlePromptsSave(payload.prompt) });
        }, 0);
      } else if (payload.type === "prompts.delete") {
        setTimeout(function () {
          dispatchToListeners({ type: "coati:broker-message", message: handlePromptsDelete(payload.promptId) });
        }, 0);
      } else if (payload.type === "prompts.move") {
        setTimeout(function () {
          dispatchToListeners({
            type: "coati:broker-message",
            message: handlePromptsMove(payload.promptId, payload.site, payload.order),
          });
        }, 0);
      } else if (payload.type === "prefs.get") {
        setTimeout(function () {
          dispatchToListeners({ type: "coati:broker-message", message: prefsReply() });
        }, 0);
      } else if (payload.type === "prefs.set") {
        setTimeout(function () {
          dispatchToListeners({ type: "coati:broker-message", message: handlePrefsSet(payload.site, payload.prefs) });
        }, 0);
      } else if (payload.type === "settings.get") {
        setTimeout(function () {
          dispatchToListeners({
            type: "coati:broker-message",
            message: Object.assign({ type: "settings" }, fixture.settings || {}),
          });
        }, 0);
      } else if (payload.type === "provider.status" && fixture.providerStatus) {
        // G5 first-launch card: only fixtures that declare `providerStatus`
        // answer, so every older fixture keeps its unchanged status line.
        setTimeout(function () {
          dispatchToListeners({
            type: "coati:broker-message",
            message: Object.assign(
              { type: "provider.status-result", id: payload.id, checkedAt: "2026-09-30T09:00:00Z" },
              fixture.providerStatus,
            ),
          });
        }, 0);
      } else if (payload.type === "settings.test") {
        setTimeout(function () {
          var result = (fixture.testResults && fixture.testResults[payload.provider]) || {
            ok: true,
            message: "OK",
          };
          dispatchToListeners({
            type: "coati:broker-message",
            message: Object.assign({ type: "settings.test-result", provider: payload.provider }, result),
          });
        }, 20);
      }
      // Chat/summarize/act/cancel: no scripted reply needed by any fixture
      // today — the streaming state is reached by staying in-flight (no
      // "done"/"error" ever arrives), which is the point of that fixture.
      // Ack only.
      return Promise.resolve({ workerInstanceId: "lab" });
    }

    return Promise.resolve(null);
  }

  // --- scripting.executeScript ---------------------------------------------
  function handleExecuteScript(details) {
    // content/extract.js injection (files: ["/content/extract.js"]) — the
    // one path panel.js's extractFromTab() relies on for every real read.
    if (details && Array.isArray(details.files)) {
      var extraction = grantCount > 0 && fixture.extractionAfterGrant ? fixture.extractionAfterGrant : fixture.extraction;
      // G5 "reading" state: the read never finishes, so the button stays in
      // its spinning state for the capture.
      if (extraction && extraction.pending) return new Promise(function () {});
      if (!extraction) return Promise.reject(new Error("no extraction fixture for state '" + stateId + "'"));
      if (extraction.error === "no-access") {
        return Promise.reject(
          new Error(
            'Cannot access contents of url "' +
              extraction.origin +
              '/…". Extension manifest must request permission to access this host.',
          ),
        );
      }
      if (extraction.error === "other") {
        return Promise.reject(new Error(extraction.message || "erreur d'extraction (lab)"));
      }
      return Promise.resolve([{ result: extraction.context }]);
    }
    // Ad hoc func-based calls (YouTube transcript open, video seek) — no real
    // page behind the lab; report "nothing happened" rather than throwing.
    return Promise.resolve([{ result: false }]);
  }

  // --- permissions -----------------------------------------------------------
  var grantedOrigins = (fixture.permissions || []).slice();
  var permissionListeners = { added: [], removed: [] };

  var api = {
    i18n: {
      getMessage: labGetMessage,
      getUILanguage: function () {
        return lang;
      },
    },
    runtime: {
      id: "coati-lab",
      getManifest: function () {
        return { version: "0.1.0-lab" };
      },
      getURL: function (path) {
        if (String(path).indexOf("_favicon") !== -1) return fixture.faviconUrl || "";
        // Anything else (showBuildInfo()'s code-fingerprint fetch, mainly) —
        // a real chrome-extension:// URL has no meaning here; a data: URL at
        // least resolves instead of failing loudly in the console for a
        // value lab-runtime.js overwrites anyway (constraint 7).
        return "data:application/octet-stream;base64,";
      },
      openOptionsPage: function () {
        console.info("[lab] runtime.openOptionsPage() — no-op in the lab");
      },
      sendMessage: function (message) {
        return handleSendMessage(message);
      },
      onMessage: {
        addListener: function (fn) {
          messageListeners.push(fn);
        },
        removeListener: function (fn) {
          messageListeners = messageListeners.filter(function (l) {
            return l !== fn;
          });
        },
      },
    },
    tabs: {
      create: function () {
        return Promise.resolve({});
      },
      query: function () {
        var tab = currentTab();
        return Promise.resolve(tab ? [tab] : []);
      },
      get: function () {
        var tab = currentTab();
        return tab ? Promise.resolve(tab) : Promise.reject(new Error("no such tab (lab)"));
      },
      onActivated: { addListener: function () {} },
      onUpdated: { addListener: function () {} },
    },
    // commands.getAll() (options page, "Raccourci clavier"). fixture.commands
    // overrides the manifest default; `shortcut: ""` = unset by the user.
    commands: {
      getAll: function () {
        return Promise.resolve(
          (fixture.commands || [{ name: "_execute_action", shortcut: "Alt+Shift+C" }]).map(function (c) {
            return Object.assign({ description: "" }, c);
          }),
        );
      },
    },
    scripting: {
      executeScript: function (details) {
        return handleExecuteScript(details);
      },
    },
    storage: {
      // The first-launch card (G5, T51) is marked done by default so every
      // pre-G5 fixture renders exactly as before; `firstRun: true` opts in.
      local: makeArea(
        Object.assign(fixture.firstRun ? {} : { "coati:firstRunDone": true }, fixture.storageLocal),
      ),
      session: makeArea(fixture.storageSession),
      // No cross-page writes in the lab: the listener is accepted, never fired.
      onChanged: { addListener: function () {}, removeListener: function () {} },
    },
    permissions: {
      // Simplification (goal-8qVhz10H, lot 4/panel): `contains`/`request`/
      // `remove` compare match patterns by exact string, not by real
      // match-pattern semantics (no host-suffix/scheme/port matching). Safe
      // here because every fixture's `permissions` array is populated with
      // the exact literal strings that
      // extension/lib/suggestions-data.js's permissionPatternsFor() emits —
      // the same function panel.js calls — so a fixture never needs the
      // stub to reconcile two differently-shaped patterns for the same
      // site. Real match-pattern matching would only matter for a fixture
      // that granted a broader/narrower pattern than the one panel.js
      // requests, which none of the panel fixtures below do.
      contains: function (query) {
        var origins = (query && query.origins) || [];
        return Promise.resolve(
          origins.every(function (o) {
            return grantedOrigins.indexOf(o) !== -1;
          }),
        );
      },
      // fixture.permissionRequestResult === false simulates the user
      // clicking "Refuser" in the browser's prompt (G5, refused state).
      request: function (query) {
        var origins = (query && query.origins) || [];
        if (fixture.permissionRequestResult === false) return Promise.resolve(false);
        grantCount += 1;
        origins.forEach(function (o) {
          if (grantedOrigins.indexOf(o) === -1) grantedOrigins.push(o);
        });
        setTimeout(function () {
          permissionListeners.added.forEach(function (fn) {
            fn({ origins: origins, permissions: [] });
          });
        }, 0);
        return Promise.resolve(true);
      },
      remove: function (query) {
        var origins = (query && query.origins) || [];
        grantedOrigins = grantedOrigins.filter(function (o) {
          return origins.indexOf(o) === -1;
        });
        setTimeout(function () {
          permissionListeners.removed.forEach(function (fn) {
            fn({ origins: origins, permissions: [] });
          });
        }, 0);
        return Promise.resolve(true);
      },
      getAll: function () {
        return Promise.resolve({ origins: grantedOrigins.slice(), permissions: [] });
      },
      onAdded: {
        addListener: function (fn) {
          permissionListeners.added.push(fn);
        },
      },
      onRemoved: {
        addListener: function (fn) {
          permissionListeners.removed.push(fn);
        },
      },
    },
  };

  window.chrome = api;
  // Firefox detection (extension/lib/browser-compat.js): a `browser` global
  // whose runtime carries `getBrowserInfo`. Only synthesized when the
  // fixture asks for it (fixture.gecko) — e.g. the "disconnected" panel
  // fixture, whose "Ouvrir /pair" CTA only renders under IS_GECKO.
  if (fixture.gecko) {
    window.browser = Object.assign({}, api, {
      runtime: Object.assign({}, api.runtime, {
        getBrowserInfo: function () {
          return Promise.resolve({ name: "Firefox" });
        },
      }),
    });
    // Firefox >= 137 only; fixture.geckoShortcutSettings: false simulates an
    // older Firefox (the options page then shows a manual instruction).
    if (fixture.geckoShortcutSettings !== false) {
      window.browser.commands = Object.assign({}, api.commands, {
        openShortcutSettings: function () {
          console.info("[lab] commands.openShortcutSettings() — no-op in the lab");
          return Promise.resolve();
        },
      });
    }
  }
})();
