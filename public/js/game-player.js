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
     * is denied navigation, popups, forms and modals, and given only the
     * capabilities a DOS game actually uses. It keeps this origin, because
     * js-dos needs storage for saved games and its own cache. They are set
     * before .src, because a sandbox applied after the document has begun
     * loading does not apply to it.
     */
    iframe.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-pointer-lock",
    );
    iframe.setAttribute("allow", "fullscreen; gamepad; autoplay");

    iframe.src = src;

    const poster = player.querySelector(".game-detail-poster");

    if (poster) {
      poster.replaceWith(iframe);
    } else {
      player.appendChild(iframe);
    }

    // So Alt+Enter, which the page forwards to the frame, has somewhere to go.
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
