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
 * The site this player belongs to — SITE_URL in utils/site.ts.
 *
 * The player is served either from the site itself, which is the default, or
 * — when PLAYER_ORIGIN is set — from an origin of its own, and then its own
 * origin says nothing about the site whose pages frame it and whose games it
 * may load. A static file cannot ask the server which site that is, so the
 * address is written down here, as MEDIA_ORIGIN further down is and for the
 * same reason; tests/public-assets.test.ts asserts it equals SITE_URL, so the
 * copy cannot drift in silence.
 *
 * A constant rather than anything this document could be told. The query
 * string is whatever the address that opened the player says, and the
 * parent's address cannot be read across origins; trusting either would let
 * whoever opens the player decide which site it believes it belongs to.
 */
const SITE_ORIGIN = "https://oldschoolgames.eu";

/**
 * The origins this player takes a page's word from: its own, and the site's.
 *
 * On the site itself, in production, the two are the same origin, so the
 * checks below are exactly the "window.location.origin" they used to be. On
 * a player origin they differ, and it is SITE_ORIGIN that matters: the game
 * page framing the player is there, and so is any game stored as a path on
 * the site. A development server is the one place the second entry is new —
 * it would also accept a game from the live site, which its own connect-src
 * then refuses, so nothing more loads than did.
 *
 * A Set first, so the ordinary case is one origin rather than the same one
 * twice in the console message below.
 */
const SITE_ORIGINS = [...new Set([window.location.origin, SITE_ORIGIN])];

/**
 * The one message this player accepts, and the two things that have to be
 * true about it: it comes from the document that framed this one, and that
 * document is this site — see SITE_ORIGINS. The game page addresses it to
 * the player's own origin too (see the Alt+Enter script in
 * views/games/game-detail.ejs), so both ends name the other. Nothing posts
 * back, and the game page installs no message listener of its own: the
 * relay only ever runs one way.
 */
window.addEventListener("message", function (event) {
  if (event.source !== window.parent) return;
  if (!SITE_ORIGINS.includes(event.origin)) return;

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
 * tests/public-assets.test.ts asserts this string equals MEDIA_ORIGIN as the
 * process reads it, so the copy cannot drift in silence — the suite already
 * keeps the js-dos release in step across two files the same way.
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
 * The site is allowed alongside MEDIA_ORIGIN because validateGame accepts a
 * path on the site for "stream" — artwork and bundles may be served from it.
 * On the site a relative value resolves to exactly that. On a player origin
 * it would resolve to the player's own origin, which serves nothing but the
 * player, so the game page resolves it against the site before handing it
 * over (see the player markup in views/games/game-detail.ejs) and it arrives
 * here as an address on SITE_ORIGIN.
 *
 * What comes out is the address, or the reason there is none. The reason
 * used to go to the console alone, and the emulator was started anyway with
 * no game in it — see showMessage below for what that looked like.
 */
const NO_GAME =
  "No game was given to this player, so there is nothing to start.";

const REFUSED_GAME =
  "This game cannot be started here: its files are not hosted anywhere this " +
  "player loads games from.";

const stream = (function () {
  const value = new URLSearchParams(window.location.search).get("stream");

  if (!value) return { url: null, problem: NO_GAME };

  let url;

  try {
    url = new URL(value, window.location.origin);
  } catch {
    return { url: null, problem: REFUSED_GAME };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { url: null, problem: REFUSED_GAME };
  }

  if (!SITE_ORIGINS.includes(url.origin) && url.origin !== MEDIA_ORIGIN) {
    // Said out loud in the console as well as in the frame, because the
    // console is where the address is worth having: the visitor is told the
    // game cannot start, and whoever looks next is told which host it named.
    console.error(
      `Refusing to load a game bundle from ${url.origin}: not this site (${SITE_ORIGINS.join(", ")}) and not ${MEDIA_ORIGIN}.`,
    );

    return { url: null, problem: REFUSED_GAME };
  }

  return { url: url.href, problem: null };
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
 * Puts a sentence where the emulator would have been, for the two cases in
 * which there is nothing to start.
 *
 * Both used to end in a frame that said nothing. A missing loader threw, and
 * the visitor got a black frame; a missing or refused game started Dos() on
 * `url: null` anyway, and the visitor got an emulator with nothing in it —
 * the reason, if there was one, in a console nobody has open. The frame is
 * where they are looking, so that is where the reason goes.
 *
 * role="alert", so a screen reader announces the sentence as it appears
 * rather than leaving it to be found; the frame's own title, which the game
 * page sets to the game's name, says which game it is about.
 *
 * replaceChildren, so every child of #dos goes with it — the CRT overlays,
 * the SVG filter and the toggle button included. That is the point (a
 * scanline overlay over an error message is nonsense) and it is also why
 * everything in the CRT section below has to tolerate the button and the
 * container being absent: it used to dereference a #crt-btn this had just
 * removed, and the TypeError took the message down with it.
 */
function showMessage(className, text) {
  const frame = document.getElementById("dos");

  if (!frame) return;

  const message = document.createElement("p");

  message.setAttribute("role", "alert");
  message.textContent = text;

  frame.replaceChildren(message);
  frame.classList.add(className);
}

/**
 * No game to start comes first: without an address there is nothing a
 * working loader could do either, so that is the more useful thing to say.
 *
 * Then the loader, which may not have arrived: the CDN can be down, an
 * extension can block it, and a hash mismatch — jsDelivr re-publishing the
 * file — makes the browser refuse it outright, which is what the integrity
 * attribute is for. `Dos` is then undefined, and calling it threw a
 * ReferenceError that took everything below down with it.
 */
if (stream.url === null) {
  showMessage("dos-no-game", stream.problem);
} else if (typeof Dos !== "function") {
  showMessage(
    "dos-load-failed",
    "The emulator could not be loaded. Check your connection or any " +
      "content blocker, then reload the page.",
  );
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
    url: stream.url,
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

  if (crtBtn) {
    crtBtn.textContent = on ? "CRT: ON" : "CRT: OFF";
    // A toggle button, so its state belongs in aria-pressed as well as in the
    // label. The label alone is readable, but a screen reader announced this
    // as a plain button called "CRT: ON" — which sounds like a command to turn
    // it on rather than a control that is already pressed. Written here rather
    // than only in the click handler, because Alt+F7 and the initial load come
    // through this function too.
    crtBtn.setAttribute("aria-pressed", on ? "true" : "false");
  }
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
