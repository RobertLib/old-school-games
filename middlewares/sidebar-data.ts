import { type Request, type Response, type NextFunction } from "express";
import logger from "../utils/logger.ts";
import {
  GAME_OF_THE_WEEK_KEY,
  LATEST_COMMENTS_KEY,
  MOST_PLAYED_GAMES_KEY,
  RECENTLY_ADDED_KEY,
  TOP_RATED_GAMES_KEY,
  sidebarCache,
} from "../utils/sidebar-cache.ts";
import Comment from "../models/comment.ts";
import Game from "../models/game.ts";
import GameOfTheWeek from "../models/game-of-the-week.ts";
import { expectsJson } from "../utils/expects-json.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * How long a *failed* widget load is remembered.
 *
 * TtlCache drops a rejection by default, which is right for a blip and
 * exactly wrong for an outage: with Postgres away every one of the six
 * entries below rejects on every request, each after waiting out the pool's
 * connection timeout, and nothing remembered that the last request had just
 * found the same thing. The page still renders its widgets blank — the
 * fallback below is untouched — but the cost of the outage is now paid once
 * every few seconds rather than six times per page view.
 */
const FAILURE_TTL_MS = 3 * 1000;

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

// The feeds and the sitemap render no sidebar, no footer and no navigation,
// yet they used to pay for all of it — seven queries on a cold cache before
// the route ever ran. The JSON endpoints are not listed here: expectsJson
// already knows every one of them, and keeping a second copy of that list is
// what let /games/:id/rate and /games/:id/play drift out of it.
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
  /** Name this ends up under in res.locals. Doubles as the cache key. */
  local: string;
  /** A function where the lifetime depends on the value — see TtlCache. */
  ttlMs: number | ((value: unknown) => number);
  /** What the page gets if the query fails, so a view never sees undefined. */
  fallback: unknown;
  load: () => Promise<unknown>;
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
      try {
        res.locals[entry.local] = await cache.get(
          entry.local,
          entry.ttlMs,
          entry.load,
          FAILURE_TTL_MS,
        );
      } catch (error) {
        logger.error(`Error loading ${entry.local}:`, error);
        res.locals[entry.local] = entry.fallback;
      }
    }),
  );
}
