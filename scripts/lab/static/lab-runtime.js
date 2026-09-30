// Coati state lab — post-bundle harness.
//
// Runs AFTER panel.js's/options.js's bundle has executed. Two jobs:
//   1. Stamp the required "LAB — données simulées — <state>" marker into
//      document.title and, on the panel, the #buildInfo footer — in place of
//      the version stamp, never as a new element (task constraint 7).
//   2. Replay `fixture.autoAction`, when a state needs a scripted user
//      gesture to reach it (e.g. "streaming": fill the composer, click Send)
//      rather than a value it can just preload into storage.
(function () {
  "use strict";

  var stateId = window.__COATI_LAB_STATE__ || "?";
  var fixture = window.__COATI_LAB_FIXTURE__ || {};
  var marker = "LAB — données simulées — " + stateId;

  document.title = marker;

  var buildInfo = document.getElementById("buildInfo");
  if (buildInfo) {
    var applyMarker = function () {
      if (buildInfo.textContent !== marker) buildInfo.textContent = marker;
    };
    applyMarker();
    new MutationObserver(applyMarker).observe(buildInfo, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  function runStep(step) {
    if (step.type === "click") {
      var target = document.querySelector(step.selector);
      if (target) target.click();
    } else if (step.type === "fill") {
      var input = document.querySelector(step.selector);
      if (input) {
        input.value = step.value || "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } else if (step.type === "focus") {
      var toFocus = document.querySelector(step.selector);
      if (toFocus) toFocus.focus();
    } else if (step.type === "broker-message" && window.__coatiLabDispatch) {
      window.__coatiLabDispatch(step.message);
    }
  }

  function runAutoAction() {
    var action = fixture.autoAction;
    if (!action || !Array.isArray(action.steps)) return;
    action.steps.forEach(function (step) {
      setTimeout(function () {
        runStep(step);
      }, step.delayMs || 0);
    });
  }

  // `?motion=live` lifts the determinism stylesheet so an animation can be
  // watched (G5: the encart button's breathing ring and reading spinner);
  // `?motion=<ms>` also freezes every running animation at that time, for a
  // deterministic capture of a mid-animation frame (e.g. motion=500 = halo
  // half-grown). Without the param, nothing changes.
  function applyMotionParam() {
    var motion = new URLSearchParams(location.search).get("motion");
    if (!motion) return;
    document.querySelectorAll('link[href$="lab-determinism.css"]').forEach(function (link) {
      link.remove();
    });
    var frameMs = Number(motion);
    if (!isFinite(frameMs)) return;
    setTimeout(function () {
      document.getAnimations().forEach(function (animation) {
        animation.pause();
        animation.currentTime = frameMs;
      });
      document.documentElement.dataset.labFrozenAt = String(frameMs);
    }, 800);
  }

  function onLoad() {
    applyMotionParam();
    runAutoAction();
  }

  if (document.readyState === "complete") onLoad();
  else window.addEventListener("load", onLoad);
})();
