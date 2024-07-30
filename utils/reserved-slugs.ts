/**
 * Addresses a generated slug must not take, because something else already
 * answers there.
 *
 * Game slugs sit at the root — "/doom" — alongside every fixed page the site
 * has, and express matches in the order routes are registered. "/about",
 * "/most-played", "/action" and the curated list pages are all declared
 * before the "/:id" game lookup, so a game titled "About" resolved to the
 * slug "about", disappeared behind the About page, and could only be reached
 * by its numeric id — while the sitemap and its own canonical tag went on
 * advertising "/about" as the game's address.
 *
 * Nothing failed loudly when that happened, which is why this list exists:
 * resolveSlug treats a reserved base as a taken one and moves to "about-2".
 *
 * The names are duplicated here rather than imported from the routers, which
 * would put the models and the routes in an import cycle. Nothing keeps a
 * copy honest by itself, so tests/utils/reserved-slugs.test.ts checks this
 * set against the live genre enum, the curated list definitions and the
 * directories actually served out of public/.
 */
const RESERVED_ROOT_PATHS = [
  // routes/auth.ts
  "login",
  "logout",

  // routes/home.ts — fixed pages, declared ahead of "/:genre" and "/:id"
  "about",
  "dmca",
  "how-to-play",
  "privacy-policy",
  "profile",
  "random",
  "developers",
  "publishers",
  "years",

  // routes/home.ts — prefixes of the two-segment filter routes. A game can
  // never collide with "/letter/a" itself, but these are worth refusing so
  // the catalogue cannot shadow the segment either. "developer" and
  // "publisher" belong here for exactly the reason "letter" and "year" do,
  // and were the two the rule was not applied to.
  "letter",
  "year",
  "developer",
  "publisher",

  // routes/lists.ts
  "most-played",
  "game-lists",

  // routes/lists.ts — the curated lists, one route each
  "top-dos-games",
  "best-rpg-games",
  "best-action-games",
  "best-adventure-games",
  "best-strategy-games",
  "best-simulation-games",
  "best-sports-games",
  "best-puzzle-games",
  "best-horror-games",
  "best-platformer-games",
  "best-racing-games",
  "best-fighting-games",
  "best-shooter-games",
  "dos-games-1990s",
  "dos-games-1980s",

  // app.ts — the platform's health check, answered above every router
  "healthz",

  // Routers mounted on a path of their own
  "games",
  "comments",
  "news",

  // routes/sitemap.ts and routes/feed.ts. createSlug turns a dot into a dash,
  // so "feed.xml" is not reachable as a slug — the dashed forms are.
  "robots",
  "robots-txt",
  "feed-xml",
  "sitemap-xml",
  "sitemap-index-xml",

  // Directories and files served straight out of public/, which express.static
  // answers before any router runs.
  "css",
  "js",
  "fonts",
  "images",
  "favicon-png",
  "js-dos-html",
  "site-webmanifest",

  // The genre pages, which are "/:genre" lowercased off the GAME_GENRE enum.
  "action",
  "adventure",
  "rpg",
  "strategy",
  "simulation",
  "sports",
  "puzzle",
  "horror",
  "platformer",
  "racing",
  "fighting",
  "shooter",
  "other",
];

export const RESERVED_GAME_SLUGS: ReadonlySet<string> = new Set(
  RESERVED_ROOT_PATHS,
);

/**
 * Article slugs live under "/news/", so they collide with far less: only
 * "/news/new", the admin form, is declared ahead of "/news/:slug".
 */
export const RESERVED_NEWS_SLUGS: ReadonlySet<string> = new Set(["new"]);
