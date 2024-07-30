const STARS = 5;

/**
 * The shadow root's stylesheet, by its bare name: this is script rather than
 * a template, so app.locals.asset — which stamps a content hash into every
 * address a view writes — is out of reach. app.ts serves it revalidating for
 * exactly that reason, the same treatment the two player files get.
 */
const STYLESHEET_HREF = "/css/rating-stars.css";

const STAR_PATH =
  "M316.9 18C311.6 7 300.4 0 288.1 0s-23.4 7-28.8 18L195 150.3 51.4 171.5c-12 1.8-22 10.2-25.7 21.7s-.7 24.2 7.9 32.7L137.8 329 113.2 474.7c-2 12 3 24.2 12.9 31.3s23 8 33.8 2.3l128.3-68.5 128.3 68.5c10.8 5.7 23.9 4.9 33.8-2.3s14.9-19.3 12.9-31.3L438.5 329 542.7 225.9c8.6-8.5 11.7-21.2 7.9-32.7s-13.7-19.9-25.7-21.7L381.2 150.3 316.9 18z";

// Ratings this browser has already cast, fetched once per page so every set of
// stars on the page can show the visitor's own vote back to them.
let voterRatingsPromise = null;

function loadVoterRatings() {
  if (!voterRatingsPromise) {
    // Wrapped in a promise chain so a fetch that throws synchronously never
    // takes the stars down with it — they still render, just without the
    // visitor's own vote highlighted.
    voterRatingsPromise = Promise.resolve()
      .then(() => fetch("/games/my-ratings"))
      .then((response) => (response.ok ? response.json() : { ratings: {} }))
      .then((data) => data.ratings || {})
      .catch(() => ({}));
  }

  return voterRatingsPromise;
}

class RatingStars extends HTMLElement {
  constructor() {
    super();

    this.attachShadow({ mode: "open" });

    // The stylesheet is linked once, here, and the markup lives in .root
    // below it — see public/css/rating-stars.css for why it is a file at all.
    // render() replaces only .root, so the sheet is resolved once per element
    // rather than again on every vote.
    this.shadowRoot.innerHTML =
      `<link rel="stylesheet" href="${STYLESHEET_HREF}" />` +
      `<span class="root"></span>`;

    this.root = this.shadowRoot.querySelector(".root");

    this.template = document.createElement("template");
    this.userRating = null;
  }

  connectedCallback() {
    // parseFloat, not parseInt: an average of 4.8 used to render as 4 stars.
    this.averageRating = parseFloat(this.getAttribute("rating")) || 0;
    this.ratingCount = parseInt(this.getAttribute("ratingCount"), 10) || 0;
    this.userRating = parseInt(this.getAttribute("userRating"), 10) || null;
    this.readonly = this.getAttribute("readonly") === "true";

    const gameId = this.getAttribute("gameId");

    this.render();

    if (this.readonly) return;

    if (this.userRating === null) {
      loadVoterRatings().then((ratings) => {
        const stored = ratings[gameId];

        // Checked again on arrival: a visitor who clicked a star while this
        // was in flight has a newer vote than the one stored, and writing the
        // stored one back over it showed their previous rating until reload.
        if (stored && this.userRating === null) {
          this.userRating = stored;
          this.render();
        }
      });
    }

    /** The rating a star stands for, or null if the event missed one. */
    const ratingFor = (target) => {
      const star = target?.closest?.(".star");

      if (!star) return null;

      return (
        Array.from(this.shadowRoot.querySelectorAll(".star")).indexOf(star) + 1
      );
    };

    // Attached once per element, never once per connection.
    //
    // connectedCallback runs again every time the element is moved in the
    // DOM — and favorites.js and comments.js both build markup and insert it
    // — so a re-attach added a second click listener and a second keydown
    // listener to the same shadow root, and one tap on a star sent two
    // votes. The handlers are remembered on the instance so
    // disconnectedCallback below can take them off again.
    if (this.listenersAttached) return;

    this.listenersAttached = true;

    this.onShadowClick = (event) => {
      const rating = ratingFor(event.target);

      if (rating) this.submitRating(gameId, rating);
    };

    this.shadowRoot.addEventListener("click", this.onShadowClick);

    /**
     * Enter and Space, because each star carries role="button" and
     * tabindex="0".
     *
     * Those two attributes are a promise: they put every star in the tab
     * order and tell a screen reader it is a button. Only a click listener
     * backed that up, so a visitor using the keyboard could tab onto a star,
     * see the focus ring the stylesheet draws for it, press Enter — and
     * nothing happened. A real <button> would have handled both keys itself;
     * anything wearing the role has to do it by hand.
     */
    this.onShadowKeydown = (event) => {
      // " " is the modern name for the space bar; "Spacebar" is what older
      // browsers report.
      if (!["Enter", " ", "Spacebar"].includes(event.key)) return;

      const rating = ratingFor(event.target);

      if (!rating) return;

      // Space would otherwise scroll the page out from under the stars.
      event.preventDefault();

      this.submitRating(gameId, rating);
    };

    this.shadowRoot.addEventListener("keydown", this.onShadowKeydown);
  }

  /**
   * Removed from the page — a comment batch replaced, a collection list
   * re-rendered — so the listeners come off with it.
   *
   * Nothing leaks while the page lives, because the handlers only reference
   * the element they are attached to. What this buys is the guarantee that
   * re-inserting the same element attaches exactly one of each again, which
   * is the contract the `listenersAttached` flag above depends on.
   */
  disconnectedCallback() {
    if (!this.listenersAttached) return;

    this.shadowRoot.removeEventListener("click", this.onShadowClick);
    this.shadowRoot.removeEventListener("keydown", this.onShadowKeydown);

    this.listenersAttached = false;
  }

  /**
   * Fills each star by how much of it the average covers, so 4.6 reads as
   * "four and a bit" instead of rounding away the difference.
   */
  starMarkup(index) {
    const displayed = this.userRating ?? this.averageRating;
    const fill = Math.max(0, Math.min(1, displayed - index));
    const clipId = `clip-${index}`;

    if (this.readonly) {
      return `<span class="star readonly">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512" width="15" height="15">
          <defs>
            <clipPath id="${clipId}">
              <rect x="0" y="0" width="${(fill * 576).toFixed(1)}" height="512" />
            </clipPath>
          </defs>
          <path d="${STAR_PATH}" fill="none" stroke="currentColor" stroke-width="34" opacity="0.55" />
          <path d="${STAR_PATH}" fill="currentColor" clip-path="url(#${clipId})" />
        </svg>
      </span>`;
    }

    // aria-pressed names the visitor's own vote, so a screen reader hears
    // which of the five is theirs rather than five identical buttons.
    return `<span class="star ${fill > 0 ? "selected" : ""}" role="button" tabindex="0"
        aria-label="Rate ${index + 1} out of 5"
        aria-pressed="${this.userRating === index + 1 ? "true" : "false"}">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512" width="15" height="15">
          <defs>
            <clipPath id="${clipId}">
              <rect x="0" y="0" width="${(fill * 576).toFixed(1)}" height="512" />
            </clipPath>
          </defs>
          <path d="${STAR_PATH}" fill="none" stroke="currentColor" stroke-width="34" opacity="0.55" />
          <path d="${STAR_PATH}" fill="currentColor" clip-path="url(#${clipId})" />
        </svg>
      </span>`;
  }

  summaryMarkup() {
    if (this.userRating) {
      return `<span class="summary">your rating: ${this.userRating}/5</span>`;
    }

    if (this.ratingCount > 0) {
      return `<span class="summary">${this.averageRating.toFixed(1)} · ${
        this.ratingCount
      } vote${this.ratingCount === 1 ? "" : "s"}</span>`;
    }

    // Some callers pass an average without a count; showing the average is
    // still better than claiming the game has no ratings.
    if (this.averageRating > 0) {
      return `<span class="summary">${this.averageRating.toFixed(1)}</span>`;
    }

    return `<span class="summary">not rated yet</span>`;
  }

  render() {
    // Which star was focused, so replacing the markup below does not drop the
    // visitor back to the top of the page. Submitting a rating re-renders, and
    // for someone using the keyboard that is exactly the moment their place in
    // the document would otherwise vanish. activeElement is guarded because
    // not every environment the suite runs in implements it on a shadow root.
    const focused = this.shadowRoot.activeElement ?? null;
    const focusedIndex = focused
      ? Array.from(this.shadowRoot.querySelectorAll(".star")).indexOf(focused)
      : -1;

    this.template.innerHTML = `
      <span class="stars">
        ${Array.from({ length: STARS }, (_, index) => this.starMarkup(index)).join("")}
      </span>
      ${this.summaryMarkup()}
    `;

    this.root.innerHTML = this.template.innerHTML;

    if (focusedIndex >= 0) {
      this.shadowRoot.querySelectorAll(".star")[focusedIndex]?.focus();
    }
  }

  async submitRating(gameId, rating) {
    try {
      const csrfToken = document
        .querySelector('meta[name="csrf-token"]')
        ?.getAttribute("content");
      const headers = { "Content-Type": "application/json" };
      if (csrfToken) headers["X-CSRF-Token"] = csrfToken;

      const response = await fetch(`/games/${gameId}/rate`, {
        method: "POST",
        headers,
        body: JSON.stringify({ rating }),
      });

      if (response.ok) {
        const { averageRating, ratingCount, userRating } =
          await response.json();

        this.averageRating = averageRating ?? this.averageRating;
        this.ratingCount = ratingCount ?? this.ratingCount;
        this.userRating = userRating ?? rating;

        // The stars now show the visitor's own vote, which is feedback
        // enough — the old alert() interrupted every single rating.
        this.render();
      } else {
        const errorData = await response.json().catch(() => ({}));
        alert(errorData.error || "Failed to submit rating.");
      }
    } catch (error) {
      console.error("Error submitting rating:", error);
      alert("Error submitting rating.");
    }
  }
}

customElements.define("rating-stars", RatingStars);
