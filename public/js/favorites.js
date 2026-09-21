/**
 * Favourites and recently-played lists.
 *
 * The browser stores only game ids. Titles, artwork, genres and ratings are
 * fetched from /games/collection when a list is rendered, so a renamed game or
 * a replaced screenshot is never stale, and the stored payload stays tiny.
 */

const FAVORITES_KEY = "favoriteGames";
const RECENTLY_PLAYED_KEY = "recentlyPlayedGames";
const RECENTLY_PLAYED_LIMIT = 20;
const CONTINUE_PLAYING_LIMIT = 4;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function readList(key) {
  let parsed;

  try {
    parsed = JSON.parse(localStorage.getItem(key) || "[]");
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  // Entries used to carry a full copy of the game (title, image, description).
  // Keep the id and the timestamp, drop the rest.
  return parsed
    .filter((entry) => entry && entry.id !== undefined && entry.id !== null)
    .map((entry) => ({
      id: String(entry.id),
      addedAt: entry.addedAt || null,
      playedAt: entry.playedAt || null,
    }));
}

function writeList(key, list) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // Private browsing or a full quota — the site still works without it.
  }

  invalidateCollectionCache();
}

function getFavorites() {
  return readList(FAVORITES_KEY);
}

function getRecentlyPlayed() {
  return readList(RECENTLY_PLAYED_KEY);
}

function isFavorite(gameId) {
  const id = String(gameId);
  return getFavorites().some((entry) => entry.id === id);
}

function toggleFavorite(button) {
  const gameId = String(button.dataset.gameId);
  const favorites = getFavorites();
  const currentlyLiked = favorites.some((entry) => entry.id === gameId);

  if (currentlyLiked) {
    writeList(
      FAVORITES_KEY,
      favorites.filter((entry) => entry.id !== gameId),
    );
    updateFavoriteButton(button, false);
  } else {
    favorites.push({ id: gameId, addedAt: new Date().toISOString() });
    writeList(FAVORITES_KEY, favorites);
    updateFavoriteButton(button, true);

    button.classList.add("animate");
    setTimeout(() => button.classList.remove("animate"), 600);
  }

  updateFavoritesCount();
}

function addToRecentlyPlayed(gameId) {
  const id = String(gameId);
  const remaining = getRecentlyPlayed().filter((entry) => entry.id !== id);

  remaining.unshift({ id, playedAt: new Date().toISOString() });

  writeList(RECENTLY_PLAYED_KEY, remaining.slice(0, RECENTLY_PLAYED_LIMIT));
}

function removeFromRecentlyPlayed(gameId) {
  const id = String(gameId);

  writeList(
    RECENTLY_PLAYED_KEY,
    getRecentlyPlayed().filter((entry) => entry.id !== id),
  );
}

// ---------------------------------------------------------------------------
// Server hydration
// ---------------------------------------------------------------------------

/**
 * How many ids /games/collection will look up in one request.
 *
 * It has to match the cap in routes/games.ts, because that cap is silent: the
 * endpoint answers 200 with the first hundred games and says nothing about the
 * ids it dropped. Favourites are not capped — only recently-played is — so a
 * list longer than this used to be truncated on the way in, and hydrate()
 * below then wrote the truncated list back over the stored one. Everything
 * past the hundredth favourite was deleted from the browser for good, silently
 * and just by visiting the profile page.
 */
const COLLECTION_BATCH_SIZE = 100;

// The profile page hydrates several lists at once, which would otherwise ask
// the server for overlapping id sets a handful of times per load. Keyed per
// batch rather than per list, so overlapping lists share whole batches.
const collectionCache = new Map();

/**
 * One request's worth of ids. Resolves to null — not an empty map — when the
 * lookup failed, so the caller can tell "these games are gone" from "we never
 * found out", which is the distinction hydrate() prunes on.
 */
function fetchBatch(ids) {
  const key = ids.join(",");

  if (!collectionCache.has(key)) {
    collectionCache.set(
      key,
      (async () => {
        try {
          const response = await fetch(
            `/games/collection?ids=${encodeURIComponent(key)}`,
          );

          if (!response.ok) return null;

          const data = await response.json();

          return new Map(
            (data.games || []).map((game) => [String(game.id), game]),
          );
        } catch {
          return null;
        }
      })(),
    );
  }

  return collectionCache.get(key);
}

/**
 * Looks up every id, in batches small enough that the server returns all of
 * them.
 *
 * `complete` reports whether every batch actually came back. It matters more
 * now than it would have with a single request: one failed batch out of three
 * still leaves a populated map, and pruning on that would throw away the
 * favourites whose batch merely did not load.
 */
async function fetchGames(ids) {
  if (ids.length === 0) return { games: new Map(), complete: true };

  const batches = [];

  for (let index = 0; index < ids.length; index += COLLECTION_BATCH_SIZE) {
    batches.push(ids.slice(index, index + COLLECTION_BATCH_SIZE));
  }

  const results = await Promise.all(batches.map((batch) => fetchBatch(batch)));

  const games = new Map();
  let complete = true;

  for (const result of results) {
    if (!result) {
      complete = false;
      continue;
    }

    for (const [id, game] of result) games.set(id, game);
  }

  return { games, complete };
}

// Anything that changes a stored list invalidates the hydrated copies.
function invalidateCollectionCache() {
  collectionCache.clear();
}

/**
 * Pairs stored entries with fresh game data and drops entries whose game no
 * longer exists, so a deleted game cannot leave a dead card behind forever.
 */
async function hydrate(key) {
  const entries = readList(key);
  const { games, complete } = await fetchGames(
    entries.map((entry) => entry.id),
  );

  const hydrated = entries
    .filter((entry) => games.has(entry.id))
    .map((entry) => ({ ...entry, game: games.get(entry.id) }));

  // Only ever pruned against an answer that covers every stored id. This used
  // to prune whenever anything at all came back ("games.size > 0"), which is
  // the same test for a game that was deleted and for a lookup that never
  // happened — so a truncated response or a failed request deleted perfectly
  // good favourites. `complete` is the narrower question, and it also lets the
  // list empty out properly: when the server confirms none of the games exist
  // any more, "size > 0" was false and the dead cards stayed forever.
  if (complete && hydrated.length !== entries.length) {
    writeList(
      key,
      hydrated.map(({ game, ...entry }) => entry),
    );
  }

  return hydrated;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function element(tag, options = {}) {
  const node = document.createElement(tag);

  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.href) node.href = options.href;
  if (options.attrs) {
    Object.entries(options.attrs).forEach(([name, value]) =>
      node.setAttribute(name, value),
    );
  }
  (options.children || []).forEach((child) => node.appendChild(child));

  return node;
}

function gameThumbnail(game, className) {
  const link = element("a", { className, href: `/${game.slug}` });

  // No artwork means no <img>. src="" is not an empty image: the browser
  // resolves it against the current document and fetches the whole page
  // again, then shows a broken-image icon for it.
  if (!game.image) return link;

  const img = element("img", {
    attrs: {
      // The same alt and the same box as a server-rendered cover (see
      // views/games/game-item.ejs): "Doom" alone reads as if the link were
      // the word, and a width without a height leaves the card to reflow
      // once the image arrives.
      alt: `${game.title} – MS-DOS cover art`,
      src: game.image,
      width: "100",
      height: "127",
      loading: "lazy",
    },
  });

  link.appendChild(img);

  return link;
}

function buildGameCard(entry, { footer, meta }) {
  const game = entry.game;

  const heading = element("a", {
    className: "color-primary font-bold",
    href: `/${game.slug}`,
    children: [
      element("h3", {
        className: "text-lg",
        text: game.title,
        attrs: { style: "margin: 0" },
      }),
    ],
  });

  const body = element("div", {
    className: "clearfix",
    children: [
      gameThumbnail(game, "game-item-initial"),
      element("div", {
        text:
          game.description ||
          "A classic MS-DOS game. Open it to read more and play.",
      }),
    ],
  });

  const children = [heading, body];

  if (meta) children.push(meta);
  if (footer) children.push(footer);

  return element("article", {
    className: "game-item card",
    children: [element("div", { children })],
  });
}

function favoriteToggleButton(gameId, gameTitle) {
  const button = element("button", {
    className: "favorite-btn liked",
    attrs: { type: "button", title: "Favorite" },
  });

  button.dataset.gameId = gameId;
  // Before updateFavoriteButton, which reads it to build the label.
  if (gameTitle) button.dataset.title = gameTitle;
  updateFavoriteButton(button, true);

  return button;
}

function renderEmpty(container, message, actionHref, actionLabel) {
  container.replaceChildren(
    element("div", {
      className: "collection-empty",
      children: [
        element("p", { text: message }),
        element("a", {
          className: "btn btn-sm btn-primary",
          href: actionHref,
          text: actionLabel,
        }),
      ],
    }),
  );
}

async function loadFavoriteGames() {
  const container = document.getElementById("favorite-games-container");

  if (!container) return;

  const entries = await hydrate(FAVORITES_KEY);

  if (entries.length === 0) {
    renderEmpty(
      container,
      "No favourites yet. Tap the heart on any game to keep it here.",
      "/",
      "Browse games",
    );
    return;
  }

  const list = element("div", { className: "game-list" });

  entries.forEach((entry) => {
    const button = favoriteToggleButton(entry.game.id, entry.game.title);

    button.addEventListener("click", () => {
      toggleFavorite(button);
      loadFavoriteGames();
      // The stats above the list count favourites, so they are stale the
      // moment one is removed — the recently-played handler below has always
      // refreshed them and this one did not.
      renderCollectionStats();
    });

    const footer = element("div", {
      className: "flex",
      attrs: {
        style:
          "justify-content: space-between; margin-top: 10px; width: 100%",
      },
      children: [
        element("a", {
          className: "btn btn-sm",
          href: `/${entry.game.slug}`,
          text: "Show game",
        }),
        button,
      ],
    });

    list.appendChild(buildGameCard(entry, { footer }));
  });

  container.replaceChildren(list);
}

async function loadRecentlyPlayedGames() {
  const container = document.getElementById("recently-played-games-container");

  if (!container) return;

  const entries = await hydrate(RECENTLY_PLAYED_KEY);

  if (entries.length === 0) {
    renderEmpty(
      container,
      "You haven't played anything yet. Pick a game and it will show up here.",
      "/random",
      "🎲 Play a random game",
    );
    return;
  }

  const list = element("div", { className: "game-list" });

  entries.forEach((entry) => {
    const playedDate = entry.playedAt
      ? new Date(entry.playedAt).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : "";

    const meta = element("div", {
      className: "text-sm",
      attrs: { style: "margin-top: 8px" },
      children: [
        element("strong", { text: "Last played: " }),
        element("span", { text: playedDate }),
      ],
    });

    const removeButton = element("button", {
      className: "btn btn-sm btn-outline",
      text: "Remove",
      attrs: { type: "button", title: "Remove from recently played" },
    });

    removeButton.addEventListener("click", () => {
      removeFromRecentlyPlayed(entry.game.id);
      loadRecentlyPlayedGames();
      renderCollectionStats();
    });

    const footer = element("div", {
      className: "flex",
      attrs: {
        style:
          "justify-content: space-between; margin-top: 10px; width: 100%",
      },
      children: [
        element("a", {
          className: "btn btn-sm",
          href: `/${entry.game.slug}`,
          text: "Play again",
        }),
        removeButton,
      ],
    });

    list.appendChild(buildGameCard(entry, { footer, meta }));
  });

  container.replaceChildren(list);
}

/**
 * The homepage strip of games in progress — the main reason a returning
 * visitor has something personal above the fold.
 */
async function loadContinuePlaying() {
  const section = document.getElementById("continue-playing");
  const container = document.getElementById("continue-playing-list");

  if (!section || !container) return;

  const entries = (await hydrate(RECENTLY_PLAYED_KEY)).slice(
    0,
    CONTINUE_PLAYING_LIMIT,
  );

  if (entries.length === 0) {
    section.hidden = true;
    container.replaceChildren();
    return;
  }

  // Swaps into the placeholders the inline script already reserved space for,
  // so this replaces content without changing the section's height. The small
  // stagger makes the cards read as arriving rather than blinking on.
  container.replaceChildren(
    ...entries.map((entry, index) =>
      element("a", {
        className: "continue-playing-card",
        href: `/${entry.game.slug}`,
        attrs: { style: `animation-delay: ${index * 45}ms` },
        // Filtered, so a game with no artwork gets a card with no <img>
        // rather than src="", which the browser resolves against the current
        // document and fetches the whole page for.
        children: [
          entry.game.image &&
            element("img", {
              className: "continue-playing-image",
              attrs: {
                alt: entry.game.title,
                src: entry.game.image,
                // Above the fold and at most four — waiting for lazy loading
                // would just make them pop in a second time.
                loading: "eager",
                decoding: "async",
              },
            }),
          element("span", {
            className: "continue-playing-name",
            text: entry.game.title,
          }),
        ].filter(Boolean),
      }),
    ),
  );

  section.hidden = false;
}

// ---------------------------------------------------------------------------
// Profile stats
// ---------------------------------------------------------------------------

function statTile(value, label) {
  return element("div", {
    className: "stat-tile",
    children: [
      element("span", { className: "stat-value", text: String(value) }),
      element("span", { className: "stat-label", text: label }),
    ],
  });
}

async function renderCollectionStats() {
  const container = document.getElementById("collection-stats");

  if (!container) return;

  const [played, favorites] = await Promise.all([
    hydrate(RECENTLY_PLAYED_KEY),
    hydrate(FAVORITES_KEY),
  ]);

  if (played.length === 0 && favorites.length === 0) {
    container.replaceChildren();
    return;
  }

  const genreCounts = new Map();

  played.forEach((entry) => {
    const genre = entry.game.genre;

    if (!genre) return;

    genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
  });

  const topGenre = [...genreCounts.entries()].sort((a, b) => b[1] - a[1])[0];

  const tiles = [
    statTile(played.length, played.length === 1 ? "game played" : "games played"),
    statTile(favorites.length, "in favourites"),
    statTile(genreCounts.size, genreCounts.size === 1 ? "genre" : "genres"),
  ];

  if (topGenre) {
    const label = topGenre[0].charAt(0) + topGenre[0].slice(1).toLowerCase();
    tiles.push(statTile(label, "favourite genre"));
  }

  const children = [element("div", { className: "stat-row", children: tiles })];

  // Nudge towards a genre they have never opened.
  const untried = ["ADVENTURE", "RPG", "STRATEGY", "PUZZLE", "ACTION"].find(
    (genre) => !genreCounts.has(genre),
  );

  if (untried && played.length > 0) {
    const label = untried.charAt(0) + untried.slice(1).toLowerCase();

    children.push(
      element("p", {
        className: "stat-nudge text-sm",
        children: [
          element("span", { text: `You haven't tried a ${label.toLowerCase()} game yet — ` }),
          element("a", {
            className: "color-primary underline",
            href: `/${untried.toLowerCase()}`,
            text: `browse ${label} games`,
          }),
        ],
      }),
    );
  }

  container.replaceChildren(...children);
}

// ---------------------------------------------------------------------------
// Export / import — the collection lives in one browser, so give people a way
// to move it to another one.
// ---------------------------------------------------------------------------

function exportCollection() {
  const payload = {
    version: 2,
    exportedAt: new Date().toISOString(),
    favorites: getFavorites(),
    recentlyPlayed: getRecentlyPlayed(),
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "oldschoolgames-collection.json";
  document.body.appendChild(link);
  link.click();
  link.remove();

  // Revoked on the next turn of the event loop rather than on this one.
  // click() only *starts* the download; revoking the blob address in the same
  // synchronous block races the browser's own read of it, and a browser that
  // loses that race saves nothing and reports nothing. It happens to work in
  // current engines, which is the worst kind of working — the failure would
  // arrive as a version bump, on the one feature whose whole purpose is not
  // losing somebody's collection. A tick costs nothing and removes the race.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function mergeById(existing, incoming, timestampKey) {
  const merged = new Map(existing.map((entry) => [entry.id, entry]));

  incoming.forEach((entry) => {
    if (!entry || entry.id === undefined || entry.id === null) return;

    const id = String(entry.id);
    const current = merged.get(id);

    // Keep whichever copy has the more recent timestamp.
    if (
      !current ||
      String(entry[timestampKey] || "") > String(current[timestampKey] || "")
    ) {
      merged.set(id, { id, [timestampKey]: entry[timestampKey] || null });
    }
  });

  return [...merged.values()].sort((a, b) =>
    String(b[timestampKey] || "").localeCompare(String(a[timestampKey] || "")),
  );
}

/**
 * How many entries in `after` were not in `before`, by id.
 *
 * What the reader is told they got, rather than what the file happened to
 * hold. The message used to count the entries in the export — so re-importing
 * the same file reported "Imported 40 favourites" having added none, and an
 * export overlapping the collection by half overstated it by half.
 *
 * Counted against the list that was actually stored, which is also what makes
 * it right at the cap: recently-played is trimmed to RECENTLY_PLAYED_LIMIT, so
 * a merge that adds five games to a full list displaces five others and the
 * lengths do not move. Comparing ids sees the five; comparing sizes sees zero.
 */
function countNew(before, after) {
  const existing = new Set(before.map((entry) => entry.id));

  return after.reduce((count, entry) => count + (existing.has(entry.id) ? 0 : 1), 0);
}

/** "1 favourite", "2 favourites" — the plural this file spelled out twice. */
function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function importCollection(text) {
  let payload;

  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, message: "That file isn't a valid collection export." };
  }

  if (!payload || typeof payload !== "object") {
    return { ok: false, message: "That file isn't a valid collection export." };
  }

  const favorites = Array.isArray(payload.favorites) ? payload.favorites : [];
  const recentlyPlayed = Array.isArray(payload.recentlyPlayed)
    ? payload.recentlyPlayed
    : [];

  if (favorites.length === 0 && recentlyPlayed.length === 0) {
    return { ok: false, message: "That export doesn't contain any games." };
  }

  const favoritesBefore = getFavorites();
  const playedBefore = getRecentlyPlayed();

  const mergedFavorites = mergeById(favoritesBefore, favorites, "addedAt");
  const mergedPlayed = mergeById(
    playedBefore,
    recentlyPlayed,
    "playedAt",
  ).slice(0, RECENTLY_PLAYED_LIMIT);

  writeList(FAVORITES_KEY, mergedFavorites);
  writeList(RECENTLY_PLAYED_KEY, mergedPlayed);

  const addedFavorites = countNew(favoritesBefore, mergedFavorites);
  const addedPlayed = countNew(playedBefore, mergedPlayed);

  // Nothing new is a real outcome and worth saying plainly. Reported as a
  // success because it is one — the file was read, and the collection now
  // contains everything in it.
  if (addedFavorites === 0 && addedPlayed === 0) {
    return {
      ok: true,
      message: "Every game in that export was already in your collection.",
    };
  }

  return {
    ok: true,
    message: `Added ${plural(addedFavorites, "favourite")} and ${plural(
      addedPlayed,
      "played game",
    )}.`,
  };
}

// ---------------------------------------------------------------------------
// Buttons and counters
// ---------------------------------------------------------------------------

/**
 * The heart's two states, in every channel that carries them.
 *
 * Only the icon and the class used to change. aria-pressed was never set at
 * all — so a toggle button reported itself as an ordinary one — and the
 * aria-label the template rendered ("Add Doom to favorites") stayed on the
 * button after it had been pressed, telling a screen reader the opposite of
 * what the page showed.
 *
 * The game's name comes from data-title, which every place that renders one
 * of these now carries; without it the label falls back to the unqualified
 * wording rather than naming the wrong game.
 */
function setFavoriteButtonState(button, isLiked) {
  button.setAttribute("aria-pressed", isLiked ? "true" : "false");

  const title = button.dataset.title;
  const verb = isLiked ? "Remove" : "Add";

  button.setAttribute(
    "aria-label",
    title
      ? `${verb} ${title} ${isLiked ? "from" : "to"} favorites`
      : `${verb} ${isLiked ? "from" : "to"} favorites`,
  );
}

function updateFavoriteButton(button, isLiked) {
  setFavoriteButtonState(button, isLiked);

  if (isLiked) {
    button.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
        <path d="M11.645 20.91l-.007-.003-.022-.012a15.247 15.247 0 01-.383-.218 25.18 25.18 0 01-4.244-3.17C4.688 15.36 2.25 12.174 2.25 8.25 2.25 5.322 4.714 3 7.688 3A5.5 5.5 0 0112 5.052 5.5 5.5 0 0116.313 3c2.973 0 5.437 2.322 5.437 5.25 0 3.925-2.438 7.111-4.739 9.256a25.175 25.175 0 01-4.244 3.17 15.247 15.247 0 01-.383.219l-.022.012-.007.004-.003.001a.752.752 0 01-.704 0l-.003-.001z" />
      </svg>`;
    button.classList.add("liked");
  } else {
    button.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18">
        <path stroke-linecap="round" stroke-linejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" />
      </svg>`;
    button.classList.remove("liked");
  }
}

function updateFavoritesCount() {
  const countElement = document.getElementById("favorites-count");

  if (!countElement) return;

  const count = getFavorites().length;

  countElement.textContent = count;
  countElement.style.display = count === 0 ? "none" : "inline";

  // The badge is aria-hidden (see views/navbar.ejs): it is the link's only
  // text, so a screen reader announced the profile link as a bare number.
  // The count belongs in the link's name instead, where it is announced as
  // what it counts.
  const profileLink = countElement.closest("a");

  if (profileLink) {
    profileLink.setAttribute(
      "aria-label",
      count === 0
        ? "Profile"
        : `Profile, ${count} favourite${count === 1 ? "" : "s"}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function initCollectionTools() {
  const exportButton = document.getElementById("export-collection");
  const importInput = document.getElementById("import-collection");
  const status = document.getElementById("collection-transfer-status");

  if (exportButton) {
    exportButton.addEventListener("click", exportCollection);
  }

  if (importInput) {
    importInput.addEventListener("change", async (event) => {
      const file = event.target.files && event.target.files[0];

      if (!file) return;

      const result = importCollection(await file.text());

      if (status) {
        status.textContent = result.message;
        status.className = result.ok
          ? "collection-transfer-status is-ok"
          : "collection-transfer-status is-error";
      }

      event.target.value = "";

      if (result.ok) {
        updateFavoritesCount();
        loadFavoriteGames();
        loadRecentlyPlayedGames();
        renderCollectionStats();
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", function () {
  updateFavoritesCount();

  document.querySelectorAll(".favorite-btn").forEach((btn) => {
    updateFavoriteButton(btn, isFavorite(btn.dataset.gameId));

    btn.addEventListener("click", function (event) {
      event.preventDefault();
      toggleFavorite(btn);
    });
  });

  initCollectionTools();
  loadContinuePlaying();

  if (document.getElementById("favorite-games-container")) {
    loadFavoriteGames();
    loadRecentlyPlayedGames();
    renderCollectionStats();
  }
});

window.addGameToRecentlyPlayed = function (gameId) {
  addToRecentlyPlayed(gameId);
};
