import { type Request, type Response, type NextFunction } from "express";
import logger from "../utils/logger.ts";
import {
  FAILURE_TTL_MS,
  GAME_OF_THE_WEEK_KEY,
  LATEST_COMMENTS_KEY,
  MOST_PLAYED_GAMES_KEY,
  NON_EMPTY_LISTS_KEY,
  RECENTLY_ADDED_KEY,
  TOP_RATED_GAMES_KEY,
  sidebarCache,
} from "../utils/sidebar-cache.ts";
import Comment from "../models/comment.ts";
import Game from "../models/game.ts";
import GameOfTheWeek from "../models/game-of-the-week.ts";
import { ALL_LIST_SLUGS, listSlugsWithGames } from "../routes/lists.ts";
import { expectsJson } from "../utils/expects-json.ts";
import { LETTER_BUCKETS, letterBucketLabel } from "../utils/letter-buckets.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * How long a game-of-the-week pick may be held: the hour every other slow
 * widget gets, or the rest of the pick's own week if that is sooner.
 *
 * A flat hour outlives the thing it caches. The row carries an "endDate",
 * and a pick fetched at five to midnight on the last day of its week was
 * shown for another fifty-five minutes after it had stopped being the game
 * of the week — while getOrSelectCurrent, which is what chooses the next
 * one, was not asked because the entry was still warm.
 */
function gameOfTheWeekTtl(pick: unknown): number {
  const endDate = (pick as GameOfTheWeek | null)?.endDate;

  if (!endDate) return HOUR;

  const remaining = new Date(endDate).getTime() - Date.now();

  // An unparseable date is not a reason to stop caching; it is a reason to
  // fall back to the nominal lifetime.
  if (!Number.isFinite(remaining)) return HOUR;

  return Math.min(HOUR, remaining);
}

// Re-exported under its old name: the shutdown path and the suite both reach
// for it here.
export const cache = sidebarCache;

/** One button of the A–Z filter — see views/games/alphabet-filter.ejs. */
export interface LetterBucketLink {
  /** The page's address under /letter/: a letter, or "0-9". */
  bucket: string;
  /** What the button says: "A", or "0–9". */
  label: string;
  /** False for a page with nothing on it, which answers 404. */
  linked: boolean;
}

/**
 * Which listing pages have a game behind them, and how many — every question
 * the chrome asks before it links to one, answered off a single query.
 *
 * Each property is a local of its own; the entry that loads this spreads it
 * onto res.locals (see `spread` below), so the views read `nonEmptyGenres`
 * exactly as they read `gameGenres`.
 *
 * The chrome used to link every value it knew: the left sidebar every genre
 * in the GAME_GENRE enum on every page of the site, the error pages the first
 * eight of the same, the A–Z filter all twenty-six letters, the footer five
 * genres and six years written into it by hand. Each of those pages answers
 * 404 when the catalogue holds nothing for it — the genre route counts, the
 * letter route counts — and routes/sitemap.ts had long since stopped listing
 * the empty ones. So the site's own navigation was the one place still
 * sending every crawl to them.
 *
 * `null` for a question that could not be answered, which the views read as
 * "link everything", as they did before they knew: see UNKNOWN_LISTINGS.
 */
export interface NonEmptyListings {
  /** The curated lists — see listSlugsWithGames in routes/lists.ts. */
  nonEmptyListSlugs: ReadonlySet<string>;
  /** The GAME_GENRE values at least one game is filed under. */
  nonEmptyGenres: ReadonlySet<string> | null;
  /** The release years with a game in them. */
  nonEmptyYears: ReadonlySet<number> | null;
  /** The A–Z filter's row: every page of it, in order, and which link. */
  letterBuckets: readonly LetterBucketLink[];
  /**
   * The counts themselves, keyed as Game.getSitemapCounts keys them
   * ("developer:id Software") — for the "Popular" blocks on /developers and
   * /publishers, which rank by them rather than counting per request.
   */
  listingCounts: ReadonlyMap<string, number> | null;
}

/**
 * The values of one kind of key in getSitemapCounts' map — "genre:ACTION"
 * gives "ACTION". A key is only there when its group has a game, but the
 * count is checked anyway: the map is the sitemap's, and a zero in it is not
 * this function's to turn into a link.
 */
function valuesWithGames(
  counts: Map<string, number>,
  kind: string,
): string[] {
  const prefix = `${kind}:`;

  return [...counts]
    .filter(([key, count]) => key.startsWith(prefix) && count > 0)
    .map(([key]) => key.slice(prefix.length));
}

/**
 * Loads NonEmptyListings from the one GROUP BY behind the sitemap.
 *
 * Game.getSitemapCounts already counts every letter, genre, developer,
 * publisher and year in a single statement, and this entry was already
 * running it to decide the curated lists. Asking it for the genres and the
 * letters as well costs nothing more; a second entry, or a query per page,
 * would. Game.count() is the unfiltered list, which the map does not carry.
 */
export async function loadNonEmptyListings(): Promise<NonEmptyListings> {
  const [{ counts }, totalGames] = await Promise.all([
    Game.getSitemapCounts(),
    Game.count(),
  ]);

  return {
    nonEmptyListSlugs: listSlugsWithGames(counts, totalGames),
    nonEmptyGenres: new Set(valuesWithGames(counts, "genre")),
    nonEmptyYears: new Set(valuesWithGames(counts, "year").map(Number)),
    letterBuckets: LETTER_BUCKETS.map((bucket) => ({
      bucket,
      label: letterBucketLabel(bucket),
      linked: (counts.get(`letter:${bucket}`) ?? 0) > 0,
    })),
    listingCounts: counts,
  };
}

/**
 * What the page gets when that query fails: every list, every genre, every
 * letter and every year linked, exactly as before any of this was known.
 *
 * A blanked database is not a reason to decide the catalogue is empty and
 * take the navigation off every page. The worst case of guessing wrong is the
 * link that was always there, and the page behind it still answers 404 for
 * itself. The one thing left out is the ranking on /developers and
 * /publishers, which has nothing honest to fall back to.
 */
const UNKNOWN_LISTINGS: NonEmptyListings = {
  nonEmptyListSlugs: ALL_LIST_SLUGS,
  nonEmptyGenres: null,
  nonEmptyYears: null,
  letterBuckets: LETTER_BUCKETS.map((bucket) => ({
    bucket,
    label: letterBucketLabel(bucket),
    linked: true,
  })),
  listingCounts: null,
};

// The feeds and the sitemap render no sidebar, no footer and no navigation,
// yet they used to pay for all of it — seven queries on a cold cache before
// the route ever ran. The JSON endpoints are not listed here: expectsJson
// already knows every one of them, and keeping a second copy of that list is
// what let /games/:id/rate and /games/:id/play drift out of it.
//
// These three paths no longer reach this middleware at all: app.ts mounts
// sitemapRoutes and feedRoutes above sidebarData, so all three are answered
// before it runs. Kept anyway, because needsSidebarData is an exported
// predicate about a request rather than a description of one mount order —
// the suite asks it directly, and a route moved below this middleware would
// otherwise start paying for chrome it does not render, which is the exact
// regression the numbered sitemap chunks below already demonstrate.
const SIDEBAR_FREE = ["/sitemap-index.xml", "/feed.xml", "/news/feed.xml"];

// The index is named, but the chunks it points at are numbered, so they never
// matched the list above — every /sitemap-N.xml paid for eight sidebar queries
// to render a document that has no sidebar.
const SITEMAP_CHUNK = /^\/sitemap-\d+\.xml$/;

// The admin form posts. Every one of them answers with a redirect — created,
// updated, deleted — so the six queries behind the chrome were loaded to
// render nothing at all, on the requests that are already the slowest on the
// site because they write. The one path here that does render is a 422 from
// a rejected form, and that one asks for the data itself: see
// loadSidebarData and the re-render in routes/games.ts and routes/news.ts.
//
// Scoped to these two prefixes rather than to POST in general, because
// routes/auth.ts re-renders the login form on a failure without doing
// anything of the kind, and the JSON endpoints under /games are already
// excluded by expectsJson above.
const ADMIN_FORM_POST = /^\/(games|news)(\/|$)/;

export function needsSidebarData(req: Request): boolean {
  // Anything that answers with JSON renders no chrome. This used to be a
  // hand-kept list that overlapped expectsJson without matching it, so a
  // rating or a play POST — both JSON, both answering with an object — still
  // paid for six sidebar queries it had nothing to render with.
  if (expectsJson(req)) return false;

  if (SIDEBAR_FREE.includes(req.path)) return false;

  if (SITEMAP_CHUNK.test(req.path)) return false;

  if (req.method === "POST" && ADMIN_FORM_POST.test(req.path)) return false;

  // GET /comments is the site-wide overview and needs the full chrome. The
  // other comment endpoints render a single comment or a batch of them, never
  // a whole page: POST /comments returns the comment just created, and
  // /comments/:gameId returns a JSON batch.
  if (req.path === "/comments") return req.method === "GET";

  return !req.path.startsWith("/comments/");
}

interface SidebarEntry {
  /**
   * Name this ends up under in res.locals. Doubles as the cache key — and is
   * only the cache key for an entry that sets `spread`.
   */
  local: string;
  /** A function where the lifetime depends on the value — see TtlCache. */
  ttlMs: number | ((value: unknown) => number);
  /** What the page gets if the query fails, so a view never sees undefined. */
  fallback: unknown;
  load: () => Promise<unknown>;
  /**
   * Set for an entry whose value is several locals at once, one per property.
   *
   * For the one entry that answers several questions off a single query —
   * NonEmptyListings. Split into one entry per question, each would either
   * run that GROUP BY again or need its own key for the game writes to drop,
   * which is the drift NON_EMPTY_LISTS_KEY was named to end.
   */
  spread?: boolean;
}

const ENTRIES: SidebarEntry[] = [
  {
    local: "gameGenres",
    ttlMs: HOUR,
    fallback: [],
    load: () => Game.getGenres(),
  },
  {
    // Named by the shared constant rather than written out here, because the
    // game writes drop this entry — see clearGameCaches in models/game.ts.
    local: RECENTLY_ADDED_KEY,
    ttlMs: 5 * MINUTE,
    fallback: [],
    load: () => Game.findRecentlyAdded(),
  },
  {
    // By the shared constant, like the entry above: the game writes drop this
    // one too, and a literal here could drift from the key they delete.
    local: TOP_RATED_GAMES_KEY,
    ttlMs: 5 * MINUTE,
    fallback: [],
    load: () => Game.findTopRated(),
  },
  {
    local: MOST_PLAYED_GAMES_KEY,
    ttlMs: 5 * MINUTE,
    fallback: [],
    load: () => Game.findMostPlayed(),
  },
  {
    // Held for two minutes rather than the five the lists above use. A comment
    // is the one thing on the sidebar someone might have just written, and
    // seeing it appear is the point of the widget.
    local: LATEST_COMMENTS_KEY,
    ttlMs: 2 * MINUTE,
    fallback: [],
    load: () => Comment.findRecent({ limit: 5 }),
  },
  {
    // Which listing pages are worth linking to — the curated lists, the
    // genres, the years and the pages of the A–Z filter — and how many games
    // each holds. See NonEmptyListings above for why the chrome has to know.
    // It is here rather than queried per page because views/left-sidebar.ejs
    // renders on every response on the site, and this is one GROUP BY.
    //
    // Five minutes, like the game lists above: a listing becomes non-empty
    // when a game is added to it, which is the same event those widgets go
    // stale on. The fallback links everything, so a failed query leaves the
    // chrome exactly as it was before this entry existed.
    //
    // By the shared constant, like the game lists above. Written out here as
    // a literal, it was the one entry clearGameCaches did not drop — see
    // NON_EMPTY_LISTS_KEY. Spread, so each answer is a local of its own.
    local: NON_EMPTY_LISTS_KEY,
    ttlMs: 5 * MINUTE,
    fallback: UNKNOWN_LISTINGS,
    load: () => loadNonEmptyListings(),
    spread: true,
  },
  {
    // By the shared constant, like the game lists above: the game writes drop
    // this one too, and a literal here could drift from the key they delete.
    local: GAME_OF_THE_WEEK_KEY,
    ttlMs: gameOfTheWeekTtl,
    fallback: null,
    load: () => GameOfTheWeek.getOrSelectCurrent(),
  },
];

/**
 * Loads everything the chrome around a page needs — the genre list, the
 * sidebar widgets and the footer links.
 *
 * These used to be three middlewares of sequential awaits, so a cold cache
 * cost seven round-trips one after another before the route was even reached;
 * they are asked for together now. Each entry also stands on its own: one
 * failing query blanks only itself, where a shared try/catch used to take the
 * four lists that happened to sit after it in the same block down with it.
 */
export async function sidebarData(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!needsSidebarData(req)) return next();

  await loadSidebarData(res);

  next();
}

/**
 * The loading half of the middleware above, on its own.
 *
 * Exported for the one path that renders a page without having passed
 * through it: an admin form post that fails validation is skipped by
 * needsSidebarData — every other outcome of those routes is a redirect —
 * and then re-renders the form with the errors on it. Asking here costs the
 * queries only on the rare request that needs them, which is the whole
 * point of the skip.
 */
export async function loadSidebarData(res: Response): Promise<void> {
  await Promise.all(
    ENTRIES.map(async (entry) => {
      let value: unknown;

      try {
        value = await cache.get(
          entry.local,
          entry.ttlMs,
          entry.load,
          FAILURE_TTL_MS,
        );
      } catch (error) {
        logger.error(`Error loading ${entry.local}:`, error);
        value = entry.fallback;
      }

      // Copied onto the locals property by property, not merged into the
      // cached object: every request shares that one value, and a view or a
      // route writing a local must not be writing into the cache.
      if (entry.spread) {
        Object.assign(res.locals, value as Record<string, unknown>);
      } else {
        res.locals[entry.local] = value;
      }
    }),
  );
}
