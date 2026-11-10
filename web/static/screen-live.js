// Idle screen push — keeps the terminal in sync with screen changes that
// didn't originate from this browser's own keystroke/submit (e.g. an
// unsolicited host update, or a Copilot tool call), instead of only
// refreshing on the user's next local interaction. Backed by a persistent
// Server-Sent Events connection (see ScreenStreamHandler in
// cmd/3270Web/screen_stream.go), which itself yields entirely to the
// existing chaos/playback polling in workflow.js while either is running
// for this session.
(function () {
  "use strict";

  // Focus normally rests inside .screen-container by default (a field is
  // auto-focused on load), so "is something focused in there" can't be the
  // skip signal the way it is for workflow.js's chaos/playback poller.
  // What actually must not be clobbered is an in-progress, not-yet-submitted
  // keystroke — 3270 fields are local until Enter/PF is pressed — so the
  // guard here is recency of actual typing instead.
  var RECENT_INPUT_GRACE_MS = 1500;
  var lastLocalInputAt = 0;
  // The form that typing went into. Typing protects only the screen it was
  // done on: once a key has been sent and that screen replaced, what was
  // typed has gone to the host, and holding back the host's answer on its
  // account is what left the answer to a fast key unshown. A TSO host frees
  // the keyboard before it answers, so its answer always arrives through this
  // stream, and always within moments of the operator's last keystroke.
  var lastInputForm = null;
  // An update held back while the operator types is kept, not dropped. The
  // server sends a screen once and does not send it again unless it changes,
  // so an update dropped here was gone until the host next drew something.
  var pendingUpdate = null;
  var pendingTimer = null;

  function typingOnThisScreen(container) {
    return (
      !!lastInputForm &&
      container.contains(lastInputForm) &&
      Date.now() - lastLocalInputAt < RECENT_INPUT_GRACE_MS
    );
  }

  function deferUpdate(container, payload) {
    pendingUpdate = payload;
    if (pendingTimer) {
      return;
    }
    var wait = RECENT_INPUT_GRACE_MS - (Date.now() - lastLocalInputAt) + 20;
    pendingTimer = setTimeout(function () {
      pendingTimer = null;
      var next = pendingUpdate;
      pendingUpdate = null;
      if (next) {
        applyUpdate(container, next);
      }
    }, Math.max(wait, 20));
  }

  function getFocusedFieldInfo(container) {
    var active = document.activeElement;
    if (!active || !container.contains(active)) {
      return null;
    }
    var caret = typeof active.selectionStart === "number" ? active.selectionStart : null;
    return { name: active.name || null, caret: caret };
  }

  function applyUpdate(container, payload) {
    if (!payload || typeof payload.html !== "string") {
      return;
    }
    if (typingOnThisScreen(container)) {
      deferUpdate(container, payload);
      return;
    }
    pendingUpdate = null;
    var screens = window.ThreeSeventyWeb && window.ThreeSeventyWeb.screens;
    if (screens && !screens.accept(payload)) {
      // Older than a screen already shown by the fetch after a key.
      return;
    }
    if (screens && screens.isShowing(payload)) {
      // The same screen the page already has, which is what the stream sends
      // when it first sees the screen a key's own fetch already put up.
      // Replacing it would throw away anything typed into it since.
      screens.shown(payload);
      if (typeof window.updateScreenStatusLine === "function") {
        window.updateScreenStatusLine(payload);
      }
      return;
    }

    var prior = getFocusedFieldInfo(container);
    container.innerHTML = payload.html;
    if (screens) {
      screens.shown(payload);
    }
    if (typeof window.updateScreenStatusLine === "function") {
      window.updateScreenStatusLine(payload);
    }
    var form = container.querySelector("form.renderer-form");
    var formId = form ? (form.id || form.getAttribute("name")) : null;
    if (typeof window.installKeyHandler === "function") {
      window.installKeyHandler(formId);
    }
    if (form && typeof window.restoreScreenFocus === "function") {
      window.restoreScreenFocus(
        form,
        prior && prior.name,
        prior && prior.caret,
        payload.cursorRow,
        payload.cursorCol
      );
    }
    if (typeof window.sizeScreenContainer === "function") {
      window.sizeScreenContainer();
    }

    // Announced rather than acted on: an unsolicited host repaint is exactly
    // the screen a caller polling after its own commands would never see, and
    // the embed bridge forwards this to a parent page. Fired after the DOM is
    // updated so a listener that reads the screen back gets the new one.
    document.dispatchEvent(
      new CustomEvent("3270web:screen-updated", { detail: payload })
    );
  }

  document.addEventListener("DOMContentLoaded", function () {
    var container = document.querySelector(".screen-container");
    if (!container || typeof window.EventSource !== "function") {
      return;
    }

    container.addEventListener(
      "input",
      function (event) {
        lastLocalInputAt = Date.now();
        lastInputForm = (event.target && event.target.form) || null;
      },
      true
    );

    var source = new EventSource("/screen/stream");
    source.onmessage = function (event) {
      var payload = null;
      try {
        payload = JSON.parse(event.data);
      } catch (_) {
        return;
      }
      applyUpdate(container, payload);
    };
    source.onerror = function () {
      // A transient network blip leaves readyState CONNECTING and the
      // browser retries on its own — nothing to do. readyState CLOSED means
      // the browser gave up for good, which happens when the initial (or a
      // reconnect) response wasn't a 200 text/event-stream — in practice,
      // an expired/reaped host session returning 401.
      if (
        source.readyState === EventSource.CLOSED &&
        window.ThreeSeventyWeb &&
        typeof window.ThreeSeventyWeb.notifySessionExpired === "function"
      ) {
        window.ThreeSeventyWeb.notifySessionExpired();
      }
    };
  });
})();
