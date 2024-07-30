document.addEventListener("DOMContentLoaded", function () {
  syncNavbarHeight();
  initExpandedDescriptions();
  initLoadingStates();
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
 * Capture phase, and propagation stops on a cancel, so initLoadingStates
 * below never sees the event: its own submit listener sits on the form and
 * would otherwise have disabled the button for five seconds after the
 * visitor had just said no.
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
  // the animation would fight it and burn a frame callback forever.
  if (prefersReducedMotion()) {
    ticker.style.visibility = "visible";
    return;
  }

  const speed = 80; // px per second
  let pos = wrap.offsetWidth;
  let last = null;
  let running = false;
  let frame = null;

  // Set initial position before making visible to avoid flash at pos 0
  ticker.style.transform = "translateX(" + pos + "px)";
  ticker.style.visibility = "visible";

  function step(ts) {
    if (last !== null) {
      pos -= (speed * (ts - last)) / 1000;
      if (pos < -ticker.offsetWidth) {
        pos = wrap.offsetWidth;
      }
      ticker.style.transform = "translateX(" + pos + "px)";
    }
    last = ts;
    frame = requestAnimationFrame(step);
  }

  function start() {
    if (running) return;
    running = true;
    last = null;
    frame = requestAnimationFrame(step);
  }

  function stop() {
    if (!running) return;
    running = false;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  }

  // Scrolled out of view or the tab is in the background — no reason to keep
  // animating and draining the battery.
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) =>
          entry.isIntersecting && !document.hidden ? start() : stop(),
        );
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

function initLocalDates() {
  document.querySelectorAll("[data-date]").forEach((el) => {
    el.textContent = new Date(el.dataset.date).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  });
}

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

function initLoadingStates() {
  // Forms that post themselves over fetch — the comment form, see
  // public/js/comments.js — manage their own button and are left out. This
  // used to re-enable that button after a fixed five seconds whether or not
  // the request had come back, so on a slow connection a visitor could post
  // the same comment twice while the first was still in flight.
  document.querySelectorAll("form:not([data-async])").forEach((form) => {
    form.addEventListener("submit", function () {
      const submitBtn = this.querySelector('button[type="submit"]');
      if (submitBtn && !submitBtn.disabled) {
        submitBtn.disabled = true;

        setTimeout(() => {
          submitBtn.disabled = false;
        }, 5000);
      }
    });
  });
}

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
