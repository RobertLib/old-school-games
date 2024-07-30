document.addEventListener("DOMContentLoaded", function () {
  syncNavbarHeight();
  initExpandedDescriptions();
  initLocalDates();
  initTicker();
  initAnchorScroll();
  initHashLanding();
});

/**
 * "Are you sure?" on the delete forms.
 *
 * These used to be onsubmit="return confirm(...)" attributes, which meant the
 * Content-Security-Policy had to allow inline event handlers site-wide. One
 * delegated listener reading data-confirm covers all of them, so script-src
 * -attr can be 'none'.
 *
 * Registered here rather than inside DOMContentLoaded, and on the document,
 * so that comments and game cards added by fetch afterwards are covered too.
 *
 * Capture phase, and propagation stops on a cancel, so the loading-state
 * listener below — delegated to the same document, but in the bubble phase —
 * never sees the event. It would otherwise have disabled the button for five
 * seconds after the visitor had just said no.
 */
document.addEventListener(
  "submit",
  function (event) {
    const form = event.target;

    if (!(form instanceof HTMLFormElement)) return;

    const message = form.dataset.confirm;

    if (message && !window.confirm(message)) {
      event.preventDefault();
      event.stopPropagation();
    }
  },
  true,
);

/**
 * --navbar-height drives the sticky sidebars' offsets and the scroll padding
 * that keeps #fragment landings clear of the header. The stylesheet carries a
 * desktop figure as a fallback, but below 640px the search drops to its own
 * row and the real header is half again as tall, so it is measured.
 */
function syncNavbarHeight() {
  const navbar = document.querySelector(".navbar");

  if (!navbar) return;

  const height = navbar.offsetHeight;

  if (height > 0) {
    document.documentElement.style.setProperty(
      "--navbar-height",
      `${height}px`,
    );
  }
}

// Coalesced to one measurement per frame: the handler reads offsetHeight and
// then writes a custom property, so an unthrottled resize drag would force a
// layout on every one of its events.
let navbarSyncQueued = false;

window.addEventListener("resize", () => {
  if (navbarSyncQueued) return;

  navbarSyncQueued = true;

  requestAnimationFrame(() => {
    navbarSyncQueued = false;
    syncNavbarHeight();
  });
});

/**
 * Landing on /some-game#comment-42 from the sidebar or the comment overview,
 * the browser scrolls before this script runs. scroll-padding-top is meant to
 * cover that, but browsers disagree on whether it applies to the initial
 * fragment navigation — so the jump is redone once the page has settled, where
 * the padding is honoured consistently.
 *
 * The re-jump is also deferred until document.fonts settles: the faces are
 * font-display: optional, so a page can still reflow once when a font wins
 * its race, and anything measured before that is measured against a layout
 * that is about to change.
 */
function initHashLanding() {
  if (!window.location.hash || window.location.hash === "#") return;

  let target;

  try {
    target = document.querySelector(window.location.hash);
  } catch {
    // A hash that is not a valid selector is somebody else's business.
    return;
  }

  if (!target) return;

  const land = () => {
    syncNavbarHeight();
    // Honours scroll-padding-top, so the offset lives in one place.
    target.scrollIntoView({ block: "start", behavior: "auto" });
  };

  requestAnimationFrame(land);

  if (document.fonts?.ready) {
    document.fonts.ready.then(land);
  } else {
    window.addEventListener("load", land, { once: true });
  }
}

const prefersReducedMotion = () =>
  window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function initTicker() {
  const wrap = document.querySelector(".ticker-wrap");
  const ticker = document.querySelector(".ticker");
  if (!wrap || !ticker) return;

  // The CSS already lays the text out statically for this preference; running
  // the animation would fight it and burn a frame callback forever. The pause
  // button stays hidden along with it: nothing moves, so it has nothing to
  // stop.
  if (prefersReducedMotion()) {
    return;
  }

  // What the text scrolls across: the box beside the pause button in
  // views/index.ejs. Measuring the wrap there would start the text a
  // button's width further right than the edge it is clipped at. The wrap
  // itself where the markup has no such box, which is what it was before.
  const viewport = wrap.querySelector(".ticker-viewport") || wrap;
  const toggle = wrap.querySelector(".ticker-toggle");

  const speed = 80; // px per second
  let pos = viewport.offsetWidth;
  let last = null;
  let running = false;
  let frame = null;
  // The visitor's own pause, which the automatic stops below must not undo:
  // scrolling back into view and returning to the tab restart a ticker that
  // went off screen or into the background, never one the visitor paused.
  let paused = false;
  let onScreen = true;

  // The starting position, written before the loop runs: the text is visible
  // from the first paint now (the stylesheet no longer hides it, so a visitor
  // with this script blocked reads it instead of a blank bar), and without
  // this the first frame would show it at 0 and jump.
  ticker.style.transform = "translateX(" + pos + "px)";

  function step(ts) {
    if (last !== null) {
      pos -= (speed * (ts - last)) / 1000;
      if (pos < -ticker.offsetWidth) {
        pos = viewport.offsetWidth;
      }
      ticker.style.transform = "translateX(" + pos + "px)";
    }
    last = ts;
    frame = requestAnimationFrame(step);
  }

  function start() {
    if (running || paused) return;
    running = true;
    // Reset so the first frame after a pause measures from itself, and the
    // text carries on from where it stopped rather than leaping ahead by the
    // time it spent paused.
    last = null;
    frame = requestAnimationFrame(step);
  }

  function stop() {
    if (!running) return;
    running = false;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  }

  /**
   * The pause control WCAG 2.2.2 asks for. The line scrolls for as long as
   * the page is open, and prefers-reduced-motion was the only way to stop it.
   *
   * Named for what pressing it will do, with the icon saying the same, and
   * no aria-pressed — the pattern the carousel's pause button follows, for
   * the reason renderPauseState in public/js/carousel.js gives: a name that
   * swaps *and* a pressed state announce two contradictory things at once.
   * A plain <button>, so Enter and Space work without any help from here, and
   * the listener is attached here rather than in the markup because the
   * policy allows no inline handlers.
   */
  if (toggle) {
    const icon = toggle.querySelector(".ticker-toggle-icon");

    const renderToggle = () => {
      toggle.setAttribute(
        "aria-label",
        paused ? "Resume scrolling text" : "Pause scrolling text",
      );

      if (icon) icon.textContent = paused ? "▶" : "❚❚";
    };

    toggle.addEventListener("click", () => {
      paused = !paused;
      renderToggle();

      if (paused) {
        stop();
      } else if (onScreen && !document.hidden) {
        start();
      }
    });

    renderToggle();

    // Revealed only now that the text is going to move. The markup ships it
    // hidden, so with this script blocked — the text standing still — there
    // is no control on the page that would do nothing.
    toggle.hidden = false;
  }

  // Scrolled out of view or the tab is in the background — no reason to keep
  // animating and draining the battery.
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          // Remembered for the pause button: resuming a ticker that has been
          // scrolled out of view would start a loop nothing is watching.
          onScreen = entry.isIntersecting;

          if (onScreen && !document.hidden) {
            start();
          } else {
            stop();
          }
        });
      },
      { threshold: 0 },
    ).observe(wrap);
  } else {
    start();
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stop();
    } else if (wrap.getBoundingClientRect().bottom > 0) {
      start();
    }
  });
}

/**
 * Rewrites the server's US-formatted dates into the reader's own locale.
 *
 * `root` so that comments fetched after load can be handed their own subtree:
 * this ran once on DOMContentLoaded, and the batch public/js/comments.js
 * inserts when "Load earlier comments" is pressed therefore kept the server's
 * "January 5, 2026" while everything around it had been rewritten — two date
 * formats in one list. Exposed on window for that one caller; the codebase has
 * no module system on the client, and this is the same shape
 * window.addGameToRecentlyPlayed (public/js/favorites.js) already uses.
 *
 * Idempotent, so re-running it over a subtree that was already done — or over
 * the whole document — changes nothing: the source of the text is the
 * data-date attribute, never what is currently rendered.
 */
function initLocalDates(root) {
  const scope = root || document;

  scope.querySelectorAll("[data-date]").forEach((el) => {
    el.textContent = new Date(el.dataset.date).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  });
}

window.initLocalDates = initLocalDates;

function initExpandedDescriptions() {
  document.querySelectorAll(".description .more-btn").forEach((moreBtn) => {
    const description = moreBtn.closest(".description");
    const content = description?.querySelector(".description-content");

    // The button says what it does to assistive tech, and points at what it
    // toggles when the content has an id to point at.
    moreBtn.setAttribute(
      "aria-expanded",
      description?.classList.contains("expanded") ? "true" : "false",
    );

    if (content?.id && !moreBtn.hasAttribute("aria-controls")) {
      moreBtn.setAttribute("aria-controls", content.id);
    }

    // Nothing to reveal: the text already fits in the collapsed box, so a
    // "more..." button would expand nothing. Only when a layout exists —
    // clientHeight is 0 before one, and in a DOM with no renderer.
    if (
      content &&
      content.clientHeight > 0 &&
      content.scrollHeight <= content.clientHeight
    ) {
      moreBtn.hidden = true;
    }

    moreBtn.addEventListener("click", function () {
      const target = this.closest(".description");
      const expanded = target.classList.toggle("expanded");

      this.textContent = expanded ? "...less" : "more...";
      this.setAttribute("aria-expanded", expanded ? "true" : "false");
    });
  });
}

/**
 * Disables a form's submit button for five seconds, so an impatient
 * double-click does not post the thing twice.
 *
 * One delegated listener on the document rather than one per form, for the
 * same reason the data-confirm handler above is delegated: this ran once on
 * DOMContentLoaded, so the admin delete forms inside comments fetched later
 * (public/js/comments.js inserts a batch of them) were never covered — and
 * those are exactly the forms where a double submit is a second DELETE
 * against a row that is already gone.
 *
 * Forms that post themselves over fetch — the comment form — manage their own
 * button and are left out. This used to re-enable that button after a fixed
 * five seconds whether or not the request had come back, so on a slow
 * connection a visitor could post the same comment twice while the first was
 * still in flight.
 *
 * Registered on the bubble phase, so the capture-phase data-confirm listener
 * above still gets to cancel a submit before this one disables anything.
 */
document.addEventListener("submit", function (event) {
  const form = event.target;

  if (!(form instanceof HTMLFormElement)) return;

  if (form.hasAttribute("data-async")) return;

  const submitBtn = form.querySelector('button[type="submit"]');

  if (!submitBtn || submitBtn.disabled) return;

  submitBtn.disabled = true;

  setTimeout(() => {
    submitBtn.disabled = false;
  }, 5000);
});

// Offsets in-page jumps by the sticky navbar, which would otherwise cover the
// heading the visitor just clicked towards.
function initAnchorScroll() {
  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener("click", function (event) {
      const hash = this.getAttribute("href");

      if (!hash || hash === "#") return;

      let target;

      // href="#" plus anything the CSS parser will not take — "#1", "#a b" —
      // throws out of querySelector, and the exception took the whole click
      // handler with it: the navigation the browser would have done by
      // itself never happened either. A hash that is not a selector is the
      // browser's business, so it is left to do it.
      try {
        target = document.querySelector(hash);
      } catch {
        return;
      }

      if (!target) return;

      event.preventDefault();

      const navbarHeight =
        document.querySelector(".navbar")?.offsetHeight || 70;
      const top =
        target.getBoundingClientRect().top +
        window.scrollY -
        navbarHeight -
        12;

      window.scrollTo({
        top,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });

      // preventDefault above cancels the whole navigation, which took the
      // address bar and the back button with it: the fragment never reached
      // location.hash, so the jump could not be undone or shared. Pushing it
      // by hand puts both back.
      if (window.history?.pushState) {
        window.history.pushState(null, "", hash);
      } else {
        window.location.hash = hash;
      }

      // The skip link is the reason this matters. Cancelling the navigation
      // also cancels the focus move the browser would have made, so a
      // keyboard visitor was scrolled to <main> with focus still on the link
      // — the next Tab took them straight back into the navbar they had just
      // asked to skip. <main> carries tabindex="-1" for exactly this.
      if (typeof target.focus === "function") {
        target.focus({ preventScroll: true });
      }
    });
  });
}
