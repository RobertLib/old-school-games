/**
 * Boots the DOS emulator inside the framed player, plus the CRT filter.
 *
 * This is an external file rather than the two inline <script> blocks it used
 * to be, because js-dos.html is a static file and the Content-Security-Policy
 * in app.ts allows inline script only by nonce. A nonce is minted per response
 * and stamped into the EJS templates; a file served by express.static has
 * nowhere to carry one, so both blocks were refused with "Executing inline
 * script violates the following Content Security Policy directive" and the
 * emulator never started on any game. Loaded by src, it is covered by 'self'.
 */
let dosInstance = null;

/**
 * The CRT preference. Wrapped, because a browser in private mode or with site
 * data blocked throws on access rather than answering — and the player has no
 * business failing to start a game over a display toggle.
 */
function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The choice holds for this session; it just will not be remembered.
  }
}

/**
 * Whether storage answers at all, asked once.
 *
 * Only js-dos needs to know. Its autoSave writes the game's changed files
 * back to browser storage, and where a browser refuses that (private mode,
 * site data blocked) every such write is a SecurityError raised inside the
 * emulator, where nothing here can catch it. Telling it up front that there
 * is no storage is the difference between a feature that does not work and a
 * library throwing on a path it does not expect to fail.
 *
 * A write, not a read: a browser can hand out a storage object that refuses
 * to keep anything.
 */
const STORAGE_AVAILABLE = (function () {
  const probe = "osg-storage-probe";

  try {
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);

    return true;
  } catch {
    return false;
  }
})();

/**
 * The one message this player accepts, and the two things that have to be
 * true about it: it comes from the document that framed this one, and that
 * document is this site. The game page addresses it to this origin too (see
 * the Alt+Enter script in views/games/game-detail.ejs), so both ends name
 * the other. Nothing posts back, and the game page installs no message
 * listener of its own: the relay only ever runs one way.
 */
window.addEventListener("message", function (event) {
  if (event.source !== window.parent) return;
  if (event.origin !== window.location.origin) return;

  if (event.data?.action === "clickFullscreen" && dosInstance) {
    dosInstance.setFullScreen(!document.fullscreenElement);
  }
});

document.addEventListener(
  "keydown",
  function (event) {
    if (event.altKey && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (dosInstance) {
        dosInstance.setFullScreen(!document.fullscreenElement);
      }
    }
  },
  true,
);

/**
 * Where a game bundle may be fetched from — the same address as MEDIA_ORIGIN
 * in utils/site.ts, which is also what the connect-src and img-src policies
 * in app.ts are built from.
 *
 * Duplicated here for the same reason JS_DOS_VERSION below is: this is a
 * static file, so there is no server-side value for it to read, and the
 * decision has to be made before the emulator is handed anything.
 * tests/public-assets.test.ts asserts this string equals MEDIA_ORIGIN's
 * default, so the copy cannot drift in silence — the suite already keeps the
 * js-dos release in step across two files the same way.
 *
 * A deployment serving its own bucket sets the MEDIA_ORIGIN environment
 * variable and changes this line with it.
 */
const MEDIA_ORIGIN = "https://trwglibsccninuamefls.supabase.co";

/**
 * The bundle URL arrives in the query string, so it is worth checking
 * before handing it to the emulator: a "javascript:" or "data:" URL
 * here would run inside the player's own origin.
 *
 * The origin is checked as well as the scheme, which it was not. connect-src
 * remains the control that actually refuses a fetch from anywhere else — but
 * a refused fetch is reported nowhere except the browser console, so a
 * crafted "?stream=https://somewhere-else/" got all the way to Dos() and then
 * failed with nothing on screen to say why. Every other value this app reads
 * out of a request is checked against what it is allowed to be before it is
 * used; this was the one place the pattern was missing.
 *
 * Same-origin is allowed alongside MEDIA_ORIGIN because validateGame accepts
 * a relative path for "stream" — artwork and bundles may be served from this
 * origin — and a relative value resolves to exactly that.
 */
const stream = (function () {
  const value = new URLSearchParams(window.location.search).get("stream");

  if (!value) return null;

  let url;

  try {
    url = new URL(value, window.location.origin);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  if (url.origin !== window.location.origin && url.origin !== MEDIA_ORIGIN) {
    // Said out loud rather than dropped, because the symptom on its own — a
    // player that loads and never starts a game — looks identical to half a
    // dozen other failures.
    console.error(
      `Refusing to load a game bundle from ${url.origin}: not this site and not ${MEDIA_ORIGIN}.`,
    );

    return null;
  }

  return url.href;
})();

/**
 * Where the emulator itself is loaded from — emulators.js, wdosbox.js and the
 * 1.4 MB wdosbox.wasm that actually runs the game.
 *
 * Named rather than left to js-dos, which defaults it to
 * "https://v8.js-dos.com/latest/emulators/". Pinning the loader in
 * js-dos.html without this would have pinned the smaller half of the problem:
 * the wasm is the part that runs the game, it was still coming from a moving
 * /latest/, and a wasm module is no less privileged than a script.
 *
 * Must name the same release as the two files in js-dos.html — a loader and
 * an emulator runtime from different builds is not a combination anyone
 * tests.
 */
const JS_DOS_VERSION = "8.4.1";

/**
 * The loader may not have arrived: the CDN can be down, an extension can
 * block it, and a hash mismatch — jsDelivr re-publishing the file — makes the
 * browser refuse it outright, which is what the integrity attribute is for.
 * `Dos` is then undefined, and calling it threw a ReferenceError that took
 * everything below down with it: the visitor got a black frame with no
 * message and nothing to click, the only word of it in the console.
 */
if (typeof Dos !== "function") {
  const frame = document.getElementById("dos");

  if (frame) {
    // textContent, so every child of #dos goes with it — the CRT overlays,
    // the SVG filter and the toggle button included. That is the point (a
    // scanline overlay over an error message is nonsense) and it is also why
    // everything in the CRT section below has to tolerate the button and the
    // container being absent: it used to dereference a #crt-btn this line
    // had just removed, and the TypeError took the message down with it.
    frame.textContent =
      "The emulator could not be loaded. Check your connection or any " +
      "content blocker, then reload the page.";
    frame.classList.add("dos-load-failed");
  }
} else {
  dosInstance = Dos(document.getElementById("dos"), {
    autoStart: true,
    // Off wherever storage is refused — see STORAGE_AVAILABLE. Saved games
    // are what the frame's "allow-same-origin" exists to keep; see the
    // sandbox comment in views/games/game-detail.ejs.
    autoSave: STORAGE_AVAILABLE,
    mouseCapture: true,
    mouseSensitivity: 0.4,
    theme: "dark",
    pathPrefix: `https://cdn.jsdelivr.net/npm/js-dos@${JS_DOS_VERSION}/dist/emulators/`,
    url: stream,
  });
}

// ── CRT toggle ────────────────────────────────────────────────
const dosEl = document.getElementById("dos");
const crtBtn = document.getElementById("crt-btn");
let crtOn = readStored("osg-crt") !== "0";

/**
 * Shows the current choice, and stores nothing.
 *
 * Both halves matter. The guards are because the branch above may have
 * emptied #dos: a player that could not load its emulator has no toggle
 * button, and dereferencing it threw a TypeError that replaced the "could
 * not be loaded" message with a blank frame — the failure path failing.
 *
 * The write moved to chooseCRT below because this also runs once on load,
 * and writing there meant every visit stored the preference it had just
 * read — or, for a visitor who had never touched the toggle, stored a
 * default they never chose. Storage should record a decision, not a page
 * view.
 */
function setCRT(on) {
  crtOn = on;

  if (dosEl) dosEl.classList.toggle("crt-on", on);
  if (crtBtn) crtBtn.textContent = on ? "CRT: ON" : "CRT: OFF";
}

/** The same, for the two places where the visitor has actually chosen. */
function chooseCRT(on) {
  setCRT(on);
  writeStored("osg-crt", on ? "1" : "0");
}

setCRT(crtOn);

if (crtBtn) {
  crtBtn.addEventListener("click", () => chooseCRT(!crtOn));
}

// Alt+F7 toggles CRT (works in fullscreen too)
document.addEventListener("keydown", (e) => {
  if (e.altKey && e.key === "F7") {
    e.preventDefault();
    chooseCRT(!crtOn);
  }
});
// ─────────────────────────────────────────────────────────────
