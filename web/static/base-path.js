// The path prefix this instance is served under, for the scripts that build
// URLs. Loaded first on every page. See cmd/3270Web/basepath.go for the server's
// half and BASE_PATH in docs/configuration.md for the setting.
//
// Requests are handled here once, rather than at each of the hundreds of places
// a script names an endpoint: fetch, XMLHttpRequest and EventSource take a rooted
// path and get the prefix added. Anything else that leaves the page (a navigation,
// a link's href, window.open) has no such hook, so it calls basePath.url itself.
// TestStaticScriptsKeepNavigationsUnderPrefix holds that line.
//
// A path passed to fetch is always one this application's routes know, never one
// that already has the prefix: a prefix such as /screen would otherwise make
// /screen/content look finished. An absolute URL, which is what form.action
// returns, is left alone.
(function () {
  "use strict";

  var meta = document.querySelector('meta[name="base-path"]');
  var prefix = (meta && meta.getAttribute("content")) || "";

  // url puts the prefix on a rooted path and returns anything else unchanged.
  function url(path) {
    if (!prefix || typeof path !== "string" || path.charAt(0) !== "/") {
      return path;
    }
    return prefix + path;
  }

  // strip is the reverse, for a script comparing a pathname with a route.
  function strip(path) {
    if (!prefix || typeof path !== "string") {
      return path;
    }
    if (path === prefix) {
      return "/";
    }
    return path.indexOf(prefix + "/") === 0 ? path.slice(prefix.length) : path;
  }

  window.basePath = { prefix: prefix, url: url, strip: strip };

  if (!prefix) {
    return;
  }

  var nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    return nativeFetch.call(window, url(input), init);
  };

  var nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, target) {
    var args = Array.prototype.slice.call(arguments);
    args[1] = url(target);
    return nativeOpen.apply(this, args);
  };

  var NativeEventSource = window.EventSource;
  if (typeof NativeEventSource === "function") {
    window.EventSource = class extends NativeEventSource {
      constructor(target, options) {
        super(url(target), options);
      }
    };
  }
})();
