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

export function needsSidebarData(req: Request): boolean {
  // Anything that answers with JSON renders no chrome. This used to be a
  // hand-kept list that overlapped expectsJson without matching it, so a
  // rating or a play POST — both JSON, both answering with an object — still
  // paid for six sidebar queries it had nothing to render with.
  if (expectsJson(req)) return false;

  if (SIDEBAR_FREE.includes(req.path)) return false;

  if (SITEMAP_CHUNK.test(req.path)) return false;

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
  ttlMs: number;
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
    ttlMs: HOUR,
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

  await Promise.all(
    ENTRIES.map(async (entry) => {
      try {
        res.locals[entry.local] = await cache.get(
          entry.local,
          entry.ttlMs,
          entry.load,
        );
      } catch (error) {
        logger.error(`Error loading ${entry.local}:`, error);
        res.locals[entry.local] = entry.fallback;
      }
    }),
  );

  next();
}
