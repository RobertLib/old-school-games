/**
 * Click-to-play for the game page.
 *
 * The emulator frame is not in the page until the visitor asks for it. It
 * used to be: the frame booted js-dos with autoStart on the moment the page
 * loaded, and its load event both posted the play to /games/:id/play and
 * added the game to "Continue playing". A visitor who arrived from a search,
 * read the description and left had therefore "played" the game, the Most
 * Played ranking counted page views, and a megabyte of wasm plus the bundle
 * came down on every visit.
 *
 * Here the poster is a button. Its click creates the frame, records the play
 * and adds the game to the recently-played list — three things that now
 * mean what they say. The hero's "Play now" link does the same before it
 * scrolls, because that click is the same intent.
 *
 * Global helpers rather than a module, like every other script under
 * public/js: the page drops them in with a <script> tag, and tests/js runs
 * them through an indirect eval.
 */
(function () {
  let fullscreenFrame = null;

  function sendFullscreenState() {
    if (!fullscreenFrame) return;

    const active = document.fullscreenElement === fullscreenFrame;
    fullscreenFrame.contentWindow?.postMessage(
      { action: "frameFullscreen", active },
      new URL(fullscreenFrame.src).origin,
    );

    if (!active) fullscreenFrame = null;
  }

  function exitFullscreen() {
    // A browser can refuse fullscreen (or already be leaving it). A rejected
    // promise must not become an unhandled page error on a keyboard shortcut.
    document.exitFullscreen?.().catch(() => {});
  }

  document.addEventListener("fullscreenchange", sendFullscreenState);

  window.addEventListener("message", (event) => {
    const frame = fullscreenFrame;

    // Only the player we fullscreened may ask to leave it. Checking both
    // source and origin prevents another frame, or a navigated player, from
    // controlling the page through this return channel.
    if (!frame || event.source !== frame.contentWindow) return;
    if (event.origin !== new URL(frame.src).origin) return;
    if (event.data?.action === "getFrameFullscreen") {
      sendFullscreenState();
      return;
    }
    if (event.data?.action !== "exitFrameFullscreen") return;
    if (document.fullscreenElement === frame) exitFullscreen();
  });

  document.addEventListener("keydown", (event) => {
    // Alt+Enter in a comment or search field must keep its normal editing
    // behavior instead of losing the keystroke to the player.
    if (event.target.closest?.("input, textarea, select, [contenteditable]")) return;
    if (!event.altKey || event.key !== "Enter") return;

    const iframe = document.querySelector(".game-detail-stream");

    if (!iframe) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (document.fullscreenElement) {
      exitFullscreen();
      return;
    }

    // A second keypress before entry completes must not start another request
    // whose rejection would forget the first request's fullscreen owner.
    if (fullscreenFrame === iframe) return;

    const playerOrigin = new URL(iframe.src).origin;

    if (playerOrigin === window.location.origin) {
      iframe.contentWindow.postMessage({ action: "clickFullscreen" }, playerOrigin);
    } else if (typeof iframe.requestFullscreen === "function") {
      // Firefox silently ignores postMessage's experimental `delegate` member.
      // Fullscreen the iframe here, while this keypress's activation is still
      // available. Tell the child which document owns fullscreen so its next
      // Alt+Enter exits this frame rather than opening a second fullscreen.
      fullscreenFrame = iframe;
      iframe.requestFullscreen().then(
        () => {
          sendFullscreenState();
          if (document.fullscreenElement === iframe) iframe.focus();
        },
        () => {
          if (fullscreenFrame === iframe) fullscreenFrame = null;
        },
      );
    }
  });

  function readCsrfToken() {
    return (
      document
        .querySelector('meta[name="csrf-token"]')
        ?.getAttribute("content") || ""
    );
  }

  function recordPlay(gameId) {
    if (!gameId) return;

    if (typeof window.addGameToRecentlyPlayed === "function") {
      window.addGameToRecentlyPlayed(gameId);
    }

    fetch(`/games/${encodeURIComponent(gameId)}/play`, {
      method: "POST",
      headers: { "x-csrf-token": readCsrfToken() },
    }).catch(() => {});
  }

  /**
   * Swaps the poster for the emulator frame. Idempotent: a second call — the
   * hero link after the poster, say — finds the frame already there and does
   * nothing, so a play is counted once.
   */
  function startPlayer(player) {
    if (!player || player.querySelector(".game-detail-stream")) return false;

    const src = player.dataset.playerSrc;

    if (!src) return false;

    const iframe = document.createElement("iframe");
    iframe.className = "game-detail-stream";
    iframe.title = player.dataset.title || "";
    iframe.style.border = "0";

    /**
     * The same two attributes the <noscript> frame in
     * views/games/game-detail.ejs carries, and for the same reasons — that
     * comment is the long version.
     *
     * In short: the player runs third-party code with 'unsafe-eval', so it
     * is granted only what a DOS game uses — no navigation, popups, forms or
     * modals. It keeps an origin, because js-dos needs storage for saved
     * games and its own cache. That is a fence around the emulator's
     * ordinary behaviour and no more while the player is served from this
     * site: a same-origin frame with allow-scripts and allow-same-origin can
     * lift its own sandbox and reach into this page. It becomes a boundary
     * when the address in data-player-src is a player origin of its own
     * (PLAYER_ORIGIN) — the same attributes then keep *that* origin.
     *
     * Set before .src, because a sandbox applied after the document has
     * begun loading does not apply to it.
     */
    iframe.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-pointer-lock",
    );
    iframe.setAttribute("allow", "fullscreen; gamepad; autoplay");

    // A fast fullscreen request can precede the child's message listener.
    // Re-send on load so the first shortcut inside that frame still exits.
    iframe.addEventListener("load", sendFullscreenState);

    iframe.src = src;

    const poster = player.querySelector(".game-detail-poster");

    if (poster) {
      poster.replaceWith(iframe);
    } else {
      player.appendChild(iframe);
    }

    // Give the emulator keyboard input immediately after the poster is used.
    iframe.focus();

    recordPlay(player.dataset.gameId);

    return true;
  }

  function init() {
    const player = document.querySelector(".game-detail-player");

    if (!player) return;

    const poster = player.querySelector(".game-detail-poster");

    if (poster) {
      poster.addEventListener("click", () => startPlayer(player));
    }

    document.querySelectorAll(".game-hero-play").forEach((link) => {
      link.addEventListener("click", () => startPlayer(player));
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.GamePlayer = { start: startPlayer, init };
})();
