/*
 * Injected into the opencode web UI by the local proxy.
 *
 * The official opencode UI runs in a cross-origin iframe, so the extension
 * webview cannot listen to its keyboard or drag events. This bridge runs in
 * the same document as the UI and forwards those events to the extension.
 */
(function () {
  'use strict';

  var BRIDGE_SOURCE = 'opencode-pane-bridge';
  var HOST_SOURCE = 'opencode-pane-host';
  var COMPOSER_SELECTOR =
    '[data-component="composer-editor"][contenteditable="true"],' +
    '[data-component="composer-editor"][contenteditable="plaintext-only"]';
  var SESSION_ROUTE = /^\/server\/[^/]+\/session\/[^/]+/;
  var RESET_KEYS = ['opencode.global.dat:server', 'opencode.pwa.last-route'];
  var ATTACH_TIMEOUT_MS = 5000;

  function post(message) {
    try {
      window.parent.postMessage(
        Object.assign({ source: BRIDGE_SOURCE }, message),
        '*',
      );
    } catch {
      // The parent may have navigated away.
    }
  }

  function currentPath() {
    return window.location.pathname;
  }

  function reportRoute() {
    post({ type: 'route', path: currentPath() });
  }

  // Clear state that would otherwise point the UI at the previous project.
  function resetStoredState() {
    var params;
    try {
      params = new URLSearchParams(window.location.search);
    } catch {
      return;
    }
    if (!params.has('ocp_reset')) {
      return;
    }

    for (var i = 0; i < RESET_KEYS.length; i += 1) {
      try {
        window.localStorage.removeItem(RESET_KEYS[i]);
      } catch {
        // Storage may be disabled.
      }
    }

    params.delete('ocp_reset');
    var search = params.toString();
    try {
      window.history.replaceState(
        window.history.state,
        '',
        currentPath() + (search ? '?' + search : '') + window.location.hash,
      );
    } catch {
      // Ignore history failures.
    }
    post({ type: 'storage-reset' });
  }

  function shortcutFor(event) {
    if (event.isComposing || event.repeat) {
      return undefined;
    }
    if (!(event.ctrlKey || event.metaKey) || !event.altKey || event.shiftKey) {
      return undefined;
    }
    var key = String(event.key || '').toLowerCase();
    var code = String(event.code || '');
    if (key === 'n' || code === 'KeyN') {
      return 'new-session';
    }
    if (key === 'k' || code === 'KeyK') {
      return 'attach-selection';
    }
    if (key === 'd' || code === 'KeyD') {
      return 'review-changes';
    }
    return undefined;
  }

  function onKeyDown(event) {
    var command = shortcutFor(event);
    if (!command) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    post({ type: 'shortcut', command: command });
  }

  function findComposer() {
    var nodes = document.querySelectorAll(COMPOSER_SELECTOR);
    for (var i = nodes.length - 1; i >= 0; i -= 1) {
      var node = nodes[i];
      if (node && node.isContentEditable) {
        return node;
      }
    }
    return null;
  }

  function moveCaretToEnd(element) {
    element.focus();
    var selection = window.getSelection();
    if (!selection) {
      return;
    }
    var range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function insertText(element, text) {
    moveCaretToEnd(element);
    var inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch {
      inserted = false;
    }

    var current = String(element.innerText || element.textContent || '');
    if (inserted && current.indexOf(text.slice(0, 12)) !== -1) {
      return true;
    }

    // Fallback for browsers that reject execCommand inside a contenteditable.
    try {
      var selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        element.appendChild(document.createTextNode(text));
      } else {
        var range = selection.getRangeAt(0);
        range.deleteContents();
        var node = document.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      element.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: false,
          inputType: 'insertText',
          data: text,
        }),
      );
    } catch {
      return false;
    }
    return true;
  }

  function attachText(text, requestId) {
    var deadline = Date.now() + ATTACH_TIMEOUT_MS;

    function attempt() {
      var composer = findComposer();
      if (composer) {
        if (insertText(composer, text)) {
          post({ type: 'inserted', requestId: requestId });
        } else {
          post({ type: 'insert-failed', requestId: requestId, reason: 'insert-failed' });
        }
        return;
      }

      var onSession = SESSION_ROUTE.test(currentPath());
      var onDraft = currentPath() === '/new-session';
      if ((!onSession && !onDraft) || Date.now() >= deadline) {
        post({ type: 'insert-failed', requestId: requestId, reason: 'no-composer' });
        return;
      }
      window.setTimeout(attempt, 120);
    }

    attempt();
  }

  // --- drag and drop ------------------------------------------------------

  var overlay = null;

  function showOverlay() {
    if (overlay) {
      return;
    }
    overlay = document.createElement('div');
    overlay.setAttribute('data-opencode-pane-drop', '');
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'pointer-events:none',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'border:2px dashed rgba(120,120,120,0.75)',
      'background:rgba(120,120,120,0.12)',
      'font:500 13px system-ui,sans-serif',
      'color:inherit',
    ].join(';');
    var label = document.createElement('div');
    label.textContent = 'Drop files to attach to opencode';
    label.style.cssText = [
      'padding:8px 14px',
      'border-radius:6px',
      'background:rgba(30,30,30,0.82)',
      'color:#fff',
      'box-shadow:0 4px 18px rgba(0,0,0,0.25)',
    ].join(';');
    overlay.appendChild(label);
    document.documentElement.appendChild(overlay);
  }

  function hideOverlay() {
    if (!overlay) {
      return;
    }
    overlay.remove();
    overlay = null;
  }

  function hasFilePayload(dataTransfer) {
    if (!dataTransfer) {
      return false;
    }
    var types = Array.prototype.slice.call(dataTransfer.types || []);
    return (
      types.indexOf('Files') !== -1 ||
      types.indexOf('text/uri-list') !== -1 ||
      types.indexOf('application/vnd.code.uri-list') !== -1
    );
  }

  function looksLikePath(value) {
    return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || /^\//.test(value);
  }

  function fromFileUrl(value) {
    try {
      var url = new URL(value);
      if (url.protocol !== 'file:') {
        return undefined;
      }
      var decoded = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:\//.test(decoded)) {
        decoded = decoded.slice(1);
      }
      return decoded;
    } catch {
      return undefined;
    }
  }

  function collectPath(value, output) {
    if (!value) {
      return;
    }
    if (typeof value === 'string') {
      var fromUrl = fromFileUrl(value);
      if (fromUrl) {
        output.push(fromUrl);
      } else if (looksLikePath(value)) {
        // VS Code sometimes reports Windows paths as /c:/dir/file.
        output.push(/^\/[A-Za-z]:[\\/]/.test(value) ? value.slice(1) : value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i += 1) {
        collectPath(value[i], output);
      }
      return;
    }
    if (typeof value === 'object') {
      var keys = ['fsPath', 'path', 'uri', 'resource', 'value'];
      for (var k = 0; k < keys.length; k += 1) {
        if (keys[k] in value) {
          collectPath(value[keys[k]], output);
        }
      }
    }
  }

  function parseUriList(raw, output) {
    var text = String(raw || '').trim();
    if (!text) {
      return;
    }
    if (text[0] === '[' || text[0] === '{') {
      try {
        collectPath(JSON.parse(text), output);
        return;
      } catch {
        // Not JSON; fall through to line parsing.
      }
    }
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i].trim();
      if (!line || line[0] === '#') {
        continue;
      }
      collectPath(line, output);
    }
  }

  function extractPaths(dataTransfer) {
    var output = [];
    if (!dataTransfer) {
      return output;
    }

    var mimeTypes = [
      'text/uri-list',
      'application/vnd.code.uri-list',
      'text/plain',
    ];
    for (var i = 0; i < mimeTypes.length; i += 1) {
      try {
        var raw = dataTransfer.getData(mimeTypes[i]);
        if (raw) {
          parseUriList(raw, output);
        }
      } catch {
        // Ignore unreadable formats.
      }
    }

    var files = dataTransfer.files;
    if (files) {
      for (var f = 0; f < files.length; f += 1) {
        var file = files[f];
        if (file && typeof file.path === 'string' && file.path) {
          output.push(file.path);
        }
      }
    }

    var seen = {};
    var unique = [];
    for (var u = 0; u < output.length; u += 1) {
      var key = output[u].toLowerCase();
      if (!seen[key]) {
        seen[key] = true;
        unique.push(output[u]);
      }
    }
    return unique;
  }

  function onDragEnter(event) {
    if (!hasFilePayload(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    showOverlay();
  }

  function onDragOver(event) {
    if (!hasFilePayload(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    try {
      event.dataTransfer.dropEffect = 'copy';
    } catch {
      // Ignore.
    }
    showOverlay();
  }

  function onDragLeave(event) {
    if (!overlay || event.relatedTarget) {
      return;
    }
    hideOverlay();
  }

  function onDrop(event) {
    if (!hasFilePayload(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    hideOverlay();

    var paths = extractPaths(event.dataTransfer);
    if (paths.length > 0) {
      post({ type: 'drop', paths: paths });
    } else {
      post({ type: 'drop-failed' });
    }
  }

  // --- wiring -------------------------------------------------------------

  window.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('dragenter', onDragEnter, true);
  document.addEventListener('dragover', onDragOver, true);
  document.addEventListener('dragleave', onDragLeave, true);
  document.addEventListener('drop', onDrop, true);

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) {
      return;
    }
    var data = event.data;
    if (!data || data.source !== HOST_SOURCE) {
      return;
    }
    switch (data.type) {
      case 'hello':
        post({ type: 'bridge-ready', path: currentPath() });
        break;
      case 'attach-text':
        if (typeof data.text === 'string' && data.text) {
          attachText(data.text, String(data.requestId || ''));
        }
        break;
      case 'focus-composer': {
        var composer = findComposer();
        if (composer) {
          composer.focus();
        }
        break;
      }
      default:
        break;
    }
  });

  ['pushState', 'replaceState'].forEach(function (name) {
    var original = window.history[name];
    if (typeof original !== 'function') {
      return;
    }
    window.history[name] = function () {
      var result = original.apply(this, arguments);
      reportRoute();
      return result;
    };
  });
  window.addEventListener('popstate', reportRoute);
  window.addEventListener('hashchange', reportRoute);

  resetStoredState();
  post({ type: 'bridge-ready', path: currentPath() });
  window.setTimeout(function () {
    post({ type: 'bridge-ready', path: currentPath() });
  }, 250);
})();
