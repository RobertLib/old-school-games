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

/**
 * Stores a list, and says whether storage kept it.
 *
 * A refused write is still swallowed — private browsing, blocked site data or
 * a full quota, and the site works without it — but no longer silently: the
 * import below used to report "Added 2 favourites" having saved nothing, the
 * list beneath it re-rendering empty, because nothing here told it otherwise.
 */
function writeList(key, list) {
  let saved = true;

  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    saved = false;
  }

  invalidateCollectionCache();

  return saved;
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
  const stored = favorites.some((entry) => entry.id === gameId);

  // What a press asks for is decided by what the heart showed, not by what
  // storage says now. Storage is shared by every tab on the site, and a heart
  // drawn before another tab changed it is stale: favouriting a game in one
  // tab and then pressing its still-empty heart in another — asking to add it
  // — found it "already a favourite" and removed it, leaving the heart empty
  // and the game gone. aria-pressed is the state updateFavoriteButton draws,
  // so it is what the visitor was looking at; a button that has never been
  // drawn carries none, and storage is the only answer there is for it.
  const pressed = button.getAttribute("aria-pressed");
  const currentlyLiked = pressed === null ? stored : pressed === "true";

  if (currentlyLiked) {
    writeList(
      FAVORITES_KEY,
      favorites.filter((entry) => entry.id !== gameId),
    );
    updateFavoriteButton(button, false);
  } else {
    // Another tab may have added it in the meantime; it is kept once.
    if (!stored) {
      favorites.push({ id: gameId, addedAt: new Date().toISOString() });
    }
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
    const request = (async () => {
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
    })();

    collectionCache.set(key, request);

    // A failure is not an answer worth keeping. Every list that asked while
    // this was in flight shares it, which is the point of the cache, but held
    // on to afterwards it was handed straight back to the next request for
    // the same batch — so "Try again" on a list that could not load (see
    // renderLoadFailure) got the same failure without a request being made.
    // Only this request's own entry is dropped: a write may have cleared the
    // cache and a newer request taken the key in the meantime.
    request.then((result) => {
      if (result === null && collectionCache.get(key) === request) {
        collectionCache.delete(key);
      }
    });
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
 *
 * Resolves to `{ entries, complete }` rather than to the entries alone. A
 * lookup that failed hydrates to an empty list, and an empty list is what the
 * empty states are drawn from, so a profile whose /games/collection request
 * failed — offline, a 429, the database having a bad minute — told somebody
 * with three favourites that they had "No favourites yet". `complete` is what
 * lets a list tell those two apart (see renderLoadFailure).
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
    // What the server has confirmed gone is taken out of the list as it is
    // *now*, rather than writing back the copy read before the await. Two
    // removals in quick succession put two of these in flight, and the older
    // one comes back holding the list from before the newer removal: writing
    // that back put the removed game into storage again — whatever the page
    // then showed, the next visit brought it back.
    const gone = new Set(
      entries.filter((entry) => !games.has(entry.id)).map((entry) => entry.id),
    );

    writeList(
      key,
      readList(key).filter((entry) => !gone.has(entry.id)),
    );
  }

  return { entries: hydrated, complete };
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

/**
 * Through replacePreservingFocus, like the lists themselves, and for the
 * reason that helper gives: the empty state is where the *last* removal
 * lands. It used to call replaceChildren directly, so the one press that
 * empties a list — the heart on the only favourite left, "Remove" on the only
 * game played — was the one that still destroyed the focused button with
 * nothing to hand focus to, and dropped a keyboard visitor to <body>.
 */
function renderEmpty(container, message, actionHref, actionLabel) {
  replacePreservingFocus(
    container,
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

/**
 * What a list says when its games could not be looked up, in place of the
 * empty state it used to fall through to.
 *
 * A failed /games/collection hydrates to nothing, and "No favourites yet" /
 * "You haven't played anything yet" beside a navbar badge counting three read
 * as the collection having been lost. It was not — hydrate() prunes only
 * against a complete answer — so this says as much, and offers to ask again.
 *
 * Through replacePreservingFocus like the other two states: pressing "Try
 * again" destroys the button, and a retry that fails as well draws a new one,
 * which the data-collection-retry mark is how focus finds.
 */
function renderLoadFailure(container, message) {
  const retry = element("button", {
    className: "btn btn-sm",
    text: "Try again",
    attrs: { type: "button", "data-collection-retry": "" },
  });

  // Everything on the page drawn from the collection, not only this list:
  // whatever stopped this one from loading stopped the others with it.
  retry.addEventListener("click", reloadCollection);

  replacePreservingFocus(
    container,
    element("div", {
      className: "collection-empty collection-error",
      children: [element("p", { text: message }), retry],
    }),
  );
}

/** Everything on the profile page that is drawn from the stored lists. */
function reloadCollection() {
  loadFavoriteGames();
  loadRecentlyPlayedGames();
  renderCollectionStats();
}

/**
 * Which render of a container is the newest one asked for.
 *
 * Every removal re-renders its list, and each render waits on a
 * /games/collection request of its own — so two removals in quick succession
 * put two of them in flight, and nothing makes them come back in order. When
 * the first one, asked for while the second game was still stored, answered
 * last, it drew the list over the newer one with that game back in it. Its
 * heart still worked, so pressing it added the game straight back (storage
 * went from ['3'] to ['3', '2']).
 *
 * So each render takes a ticket, and one that finds a newer ticket issued by
 * the time its data arrives draws nothing: the newer render has drawn, or
 * will, from the list as it is now. Keyed by the container itself, so the
 * favourites, the recently-played list and the stats each keep their own
 * count, and a render of one never cancels a render of another.
 */
const latestRender = new WeakMap();

function beginRender(container) {
  const ticket = (latestRender.get(container) || 0) + 1;

  latestRender.set(container, ticket);

  return () => latestRender.get(container) === ticket;
}

async function loadFavoriteGames() {
  const container = document.getElementById("favorite-games-container");

  if (!container) return;

  const isLatest = beginRender(container);
  const { entries, complete } = await hydrate(FAVORITES_KEY);

  // Superseded while it waited — see beginRender.
  if (!isLatest()) return;

  // Before the empty state, because a lookup that failed comes back empty
  // too. Not drawn half-full either when one batch of several failed: the
  // list would read as having lost the rest.
  if (!complete) {
    renderLoadFailure(
      container,
      "Your favourites couldn't be loaded just now. They're still saved in this browser.",
    );
    return;
  }

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

  replacePreservingFocus(container, list);
}

/**
 * Swaps a container's contents and puts keyboard focus back where it was.
 *
 * replaceChildren destroys the element that had focus, and the browser then
 * drops focus to <body> — so pressing the heart on a favourite removed it,
 * re-rendered the list, and left a keyboard visitor at the top of the document
 * with no idea where they had been. The next Tab started again from the navbar.
 *
 * The same problem public/js/carousel.js solves for its slides, from the other
 * end: there the fix is to leave the focused element in place, and here the
 * element is genuinely gone, so the answer is to name what had focus and find
 * it again. A button is matched by the game it belongs to.
 *
 * When that card is the one that was just removed, focus goes to the card
 * that took its place — the next one down, or the one above when the last
 * card went — and to the same control on it. It used to go to the container
 * every time: the match was on the removed game's own id, the one id certain
 * not to be in the new list, so "Remove" on the second of three left a
 * keyboard visitor on the list as a whole rather than on the card beneath.
 * The order the cards were in is read before the swap destroys it, which is
 * what makes "the next one down" answerable afterwards. Only when no card is
 * left at all does the container take focus, which carries tabindex="-1" for
 * the moment it has to.
 *
 * Any [data-game-id], not only .favorite-btn: the recently-played list is
 * rebuilt through here too and its per-card control is a "Remove" button with
 * no heart on it, so a selector naming the heart matched nothing there and
 * every removal fell through to the container.
 *
 * Only when focus was inside this container. A visitor who had tabbed away
 * while the fetch was in flight is not dragged back.
 */
function replacePreservingFocus(container, ...children) {
  const active = document.activeElement;
  const hadFocus = active && container.contains(active);
  const gameId = hadFocus ? active.dataset?.gameId : undefined;
  const retrying = hadFocus && active.hasAttribute?.("data-collection-retry");

  // The games in the order they were on screen, closest first: this one, then
  // everything below it, then everything above it working upwards.
  const onScreen = gameId === undefined ? [] : gameIdsIn(container);
  const at = onScreen.indexOf(gameId);
  const nearest =
    at === -1
      ? [gameId]
      : [gameId, ...onScreen.slice(at + 1), ...onScreen.slice(0, at).reverse()];

  container.replaceChildren(...children);

  if (!hadFocus) return;

  // Matched by reading the attribute rather than by building a selector out
  // of it: the id is data from storage, and an id with a quote in it would
  // make a selector that throws rather than one that misses.
  const controls = Array.from(container.querySelectorAll("[data-game-id]"));
  const next =
    gameId === undefined
      ? null
      : nearest
          .map((id) => controls.find((candidate) => candidate.dataset.gameId === id))
          .find(Boolean);

  if (next) {
    next.focus();
    return;
  }

  // "Try again" pressed on a list that failed to load again: the button that
  // had focus has just been redrawn, and the new one is where the visitor
  // can press it once more.
  const retry = retrying
    ? container.querySelector("[data-collection-retry]")
    : null;

  if (retry) {
    retry.focus();
    return;
  }

  // No card left to go to — the one that had focus was the last in the list.
  // The container takes it rather than <body>, so the next Tab carries on
  // from the list instead of from the top of the page.
  container.setAttribute("tabindex", "-1");
  container.focus();
}

/** The ids of the cards in a container, in the order they are drawn. */
function gameIdsIn(container) {
  return Array.from(container.querySelectorAll("[data-game-id]")).map(
    (control) => control.dataset.gameId,
  );
}

async function loadRecentlyPlayedGames() {
  const container = document.getElementById("recently-played-games-container");

  if (!container) return;

  const isLatest = beginRender(container);
  const { entries, complete } = await hydrate(RECENTLY_PLAYED_KEY);

  // The same race as the favourites above, from its "Remove" buttons.
  if (!isLatest()) return;

  // As for the favourites: a failed lookup is not an empty history.
  if (!complete) {
    renderLoadFailure(
      container,
      "Your recently played games couldn't be loaded just now. They're still saved in this browser.",
    );
    return;
  }

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

    // What replacePreservingFocus names this button by. Without it the
    // re-render below has nothing to match on, so focus went to the container
    // on every removal rather than to the card that took this one's place —
    // the button carries no other trace of which entry it belongs to.
    removeButton.dataset.gameId = entry.game.id;

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

  // Not replaceChildren: pressing "Remove" destroys the button that had focus
  // and the browser drops focus to <body>, which is the bug the favourites
  // list above was fixed for. The two lists are rebuilt the same way by the
  // same handler shape, so they lose focus the same way.
  replacePreservingFocus(container, list);
}

/**
 * The homepage strip of games in progress — the main reason a returning
 * visitor has something personal above the fold.
 */
async function loadContinuePlaying() {
  const section = document.getElementById("continue-playing");
  const container = document.getElementById("continue-playing-list");

  if (!section || !container) return;

  // A failed lookup is left to the empty case below. This strip is an extra
  // on the homepage rather than the collection itself: hidden, it claims
  // nothing about what is stored, where the profile's lists would.
  const entries = (await hydrate(RECENTLY_PLAYED_KEY)).entries.slice(
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
                // The documented wording, the same as every other cover on
                // the site (views/games/game-item.ejs reasons it out, and
                // gameThumbnail above already followed it). The bare title
                // made the card's only accessible name the game's name twice
                // over — the <span> beneath says it too — and told image
                // search nothing about what the file shows.
                alt: `${entry.game.title} – MS-DOS cover art`,
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

/**
 * utils/genre-label.ts, a second time, for the one place the browser writes a
 * genre.
 *
 * The server stopped writing "Rpg" once its rules moved into that module, and
 * this file was the copy left behind: the stats below title-cased the enum by
 * hand — "Rpg" as the favourite genre — and put "a" in front of whatever came
 * out, "a adventure game", "a action game", "a rpg game". A static script
 * cannot import the module, so the rules are written out again here, and
 * tests/js/favorites.test.ts holds the two copies to the same answers for
 * every value of the GAME_GENRE enum. Change one, change both.
 */
const GENRE_INITIALISMS = new Set(["RPG"]);

/** The genre as a heading writes it: "Action", "RPG". */
function genreLabel(genre) {
  const upper = String(genre).toUpperCase();

  if (GENRE_INITIALISMS.has(upper)) return upper;

  return upper.charAt(0) + upper.slice(1).toLowerCase();
}

/** The genre in the middle of a sentence: "action", "RPG". */
function genreInSentence(genre) {
  const upper = String(genre).toUpperCase();

  return GENRE_INITIALISMS.has(upper) ? upper : upper.toLowerCase();
}

/**
 * "an adventure", "a puzzle", "an RPG": the genre mid-sentence, with the
 * article English puts in front of it.
 *
 * The server has no copy of this to match — its sentences put "classic" in
 * front of a genre — so the test answers for every genre by hand instead. It
 * goes by the sound the word starts with: for an ordinary word that is its
 * first letter, since no genre in the enum opens on a silent h or a "you"
 * sound, and for an initialism it is the name of its first letter, which for
 * the R of RPG is "ar".
 */
function genreWithArticle(genre) {
  const word = genreInSentence(genre);
  const vowelSound = GENRE_INITIALISMS.has(word)
    ? /^[AEFHILMNORSX]/.test(word)
    : /^[aeiou]/.test(word);

  return `${vowelSound ? "an" : "a"} ${word}`;
}

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

  const isLatest = beginRender(container);
  const [playedAnswer, favoritesAnswer] = await Promise.all([
    hydrate(RECENTLY_PLAYED_KEY),
    hydrate(FAVORITES_KEY),
  ]);

  // Re-rendered by the same two removal handlers as the lists, so it races
  // the same way: an older answer landing last counted a favourite that had
  // already gone.
  if (!isLatest()) return;

  // Counted from an answer with games missing, every number here would be
  // wrong in the way the empty lists were — "0 in favourites" beside a badge
  // saying 3. The lists say what went wrong and offer to try again; the stats
  // wait, empty, for an answer they can count.
  if (!playedAnswer.complete || !favoritesAnswer.complete) {
    container.replaceChildren();
    return;
  }

  const played = playedAnswer.entries;
  const favorites = favoritesAnswer.entries;

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
    tiles.push(statTile(genreLabel(topGenre[0]), "favourite genre"));
  }

  const children = [element("div", { className: "stat-row", children: tiles })];

  // Nudge towards a genre they have never opened.
  const untried = ["ADVENTURE", "RPG", "STRATEGY", "PUZZLE", "ACTION"].find(
    (genre) => !genreCounts.has(genre),
  );

  if (untried && played.length > 0) {
    children.push(
      element("p", {
        className: "stat-nudge text-sm",
        children: [
          element("span", {
            text: `You haven't tried ${genreWithArticle(untried)} game yet — `,
          }),
          // Mid-sentence, so the sentence form: the same words as the
          // "Browse all adventure games" link views/games/similar-games.ejs
          // writes for the same page.
          element("a", {
            className: "color-primary underline",
            href: `/${untried.toLowerCase()}`,
            text: `browse ${genreInSentence(untried)} games`,
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

  // What the import sets out to add, and so what it has to be judged by.
  const wantedFavorites = countNew(favoritesBefore, mergedFavorites);
  const wantedPlayed = countNew(playedBefore, mergedPlayed);

  // Whether each list reached storage at all. `saved` on the result is what
  // the page redraws on: a list the browser refused has nothing new to show.
  const favoritesSaved = writeList(FAVORITES_KEY, mergedFavorites);
  const playedSaved = writeList(RECENTLY_PLAYED_KEY, mergedPlayed);

  // Nothing new is a real outcome and worth saying plainly. Reported as a
  // success because it is one — the file was read, and the collection already
  // contains everything in it — however the write-back went.
  if (wantedFavorites === 0 && wantedPlayed === 0) {
    return {
      ok: true,
      saved: favoritesSaved || playedSaved,
      message: "Every game in that export was already in your collection.",
    };
  }

  // Counted from what storage holds now, read back, rather than from what it
  // was asked to hold. With storage refusing — private browsing, blocked site
  // data, a full quota — the merged lists were counted anyway, and the reader
  // was told "Added 2 favourites and 0 played games." in green while the list
  // beneath re-rendered empty.
  const addedFavorites = countNew(favoritesBefore, getFavorites());
  const addedPlayed = countNew(playedBefore, getRecentlyPlayed());

  // A list the export had something for that storage did not keep: refused
  // outright, or accepted and then not there when read back. Only a list
  // with something to add can be lost — an export with no played games still
  // writes that list back unchanged, and that write failing loses nothing.
  const favoritesLost =
    wantedFavorites > 0 && (!favoritesSaved || addedFavorites < wantedFavorites);
  const playedLost =
    wantedPlayed > 0 && (!playedSaved || addedPlayed < wantedPlayed);

  if (!favoritesLost && !playedLost) {
    return {
      ok: true,
      saved: true,
      message: `Added ${plural(addedFavorites, "favourite")} and ${plural(
        addedPlayed,
        "played game",
      )}.`,
    };
  }

  if (addedFavorites === 0 && addedPlayed === 0) {
    return {
      ok: false,
      saved: false,
      message:
        "This browser wouldn't save the collection, so nothing was imported. " +
        "Private browsing, blocked site data or full storage can each do this.",
    };
  }

  // Half of it went in. Still an error — the reader asked for all of it — but
  // one that says what did arrive, since the page is about to show it.
  const why = "this browser's storage is full or blocked.";

  return {
    ok: false,
    saved: true,
    message: favoritesLost
      ? `Added ${plural(addedPlayed, "played game")}, but your favourites couldn't be saved — ${why}`
      : `Added ${plural(addedFavorites, "favourite")}, but your played games couldn't be saved — ${why}`,
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

      // On `saved` rather than `ok`: an import that was half refused is
      // reported as an error, and the half that did go in still has to show.
      if (result.saved) {
        updateFavoritesCount();
        reloadCollection();
      }
    });
  }
}

/** Every heart on the page, drawn from what storage says now. */
function syncFavoriteButtons() {
  document.querySelectorAll(".favorite-btn").forEach((btn) => {
    updateFavoriteButton(btn, isFavorite(btn.dataset.gameId));
  });
}

/**
 * Another tab changed the collection.
 *
 * localStorage is shared by every tab on the site and nothing here listened
 * for it, so a heart drawn before another tab favourited its game stayed
 * empty for as long as the page was open, and the navbar badge kept the old
 * count. The storage event is how the browser says so — it fires in every
 * tab but the one that wrote. toggleFavorite goes by what a heart shows, so a
 * heart this has not caught up with yet still does what it looks like it
 * will; this is what keeps it showing the truth.
 *
 * Registered once, when the script runs, rather than on DOMContentLoaded:
 * there is one window, and one listener is all it needs.
 */
window.addEventListener("storage", (event) => {
  // A null key is localStorage.clear() — in another tab, or the browser's own
  // "clear site data" — which takes both lists with it.
  if (
    event.key !== null &&
    event.key !== FAVORITES_KEY &&
    event.key !== RECENTLY_PLAYED_KEY
  ) {
    return;
  }

  // The hydrated copies were of the lists as they were.
  invalidateCollectionCache();

  syncFavoriteButtons();
  updateFavoritesCount();

  // The profile's hearts sit in cards drawn from the stored lists, so there
  // the lists are what has to follow: a card whose game the other tab removed
  // goes, rather than staying on with an empty heart.
  if (document.getElementById("favorite-games-container")) {
    reloadCollection();
  }
});

document.addEventListener("DOMContentLoaded", function () {
  updateFavoritesCount();
  syncFavoriteButtons();

  document.querySelectorAll(".favorite-btn").forEach((btn) => {
    btn.addEventListener("click", function (event) {
      event.preventDefault();
      toggleFavorite(btn);
    });
  });

  initCollectionTools();
  loadContinuePlaying();

  if (document.getElementById("favorite-games-container")) {
    reloadCollection();
  }
});

window.addGameToRecentlyPlayed = function (gameId) {
  addToRecentlyPlayed(gameId);
};
