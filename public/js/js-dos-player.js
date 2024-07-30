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

window.addEventListener("DOMContentLoaded", () => {
  const urlParams = new URLSearchParams(window.location.search);
  const stream = urlParams.get("stream");

  if (stream) {
    const match = stream.match(/\/assets\/([^/]+)/);
    if (match && match[1]) {
      let gameName = match[1];
      gameName = gameName.replace(/\.jsdos$/, "");
      const canonicalLink = document.createElement("link");
      canonicalLink.rel = "canonical";
      // This player is served from the same origin as the game page it
      // points at, so the address is read off the location rather than
      // written out. It used to name oldschoolgames.eu literally, which
      // sent any other deployment's canonical tag to the live site.
      canonicalLink.href = `${window.location.origin}/${gameName}`;
      document.head.appendChild(canonicalLink);
    }
  }
});

window.addEventListener("message", function (event) {
  // Only the page that framed this player may drive it.
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

dosInstance = Dos(document.getElementById("dos"), {
  autoStart: true,
  autoSave: true,
  mouseCapture: true,
  mouseSensitivity: 0.4,
  theme: "dark",
  pathPrefix: `https://cdn.jsdelivr.net/npm/js-dos@${JS_DOS_VERSION}/dist/emulators/`,
  url: stream,
});

// ── CRT toggle ────────────────────────────────────────────────
const dosEl = document.getElementById("dos");
const crtBtn = document.getElementById("crt-btn");
let crtOn = readStored("osg-crt") !== "0";

function setCRT(on) {
  crtOn = on;
  dosEl.classList.toggle("crt-on", on);
  crtBtn.textContent = on ? "CRT: ON" : "CRT: OFF";
  writeStored("osg-crt", on ? "1" : "0");
}

setCRT(crtOn);
crtBtn.addEventListener("click", () => setCRT(!crtOn));

// Alt+F7 toggles CRT (works in fullscreen too)
document.addEventListener("keydown", (e) => {
  if (e.altKey && e.key === "F7") {
    e.preventDefault();
    setCRT(!crtOn);
  }
});
// ─────────────────────────────────────────────────────────────
