import express from "express";
import Game from "../models/game.ts";
// The cache itself lives in utils, not here, so the models can drop it on a
// write without importing this router — see utils/page-cache.ts.
import {
  MOST_PLAYED_KEY,
  clearMostPlayedCache,
  mostPlayedCache,
} from "../utils/page-cache.ts";
import { SITE_URL } from "../utils/site.ts";
import { HOME_CRUMB, type Breadcrumb } from "../utils/breadcrumbs.ts";
import { META_DESCRIPTION_MAX, truncateAtWord } from "../utils/html-text.ts";

const router = express.Router();

/**
 * How many games a curated list holds.
 *
 * These lists used to be unbounded and paginated: `findParams` carried an
 * ordering and, for most of them, one filter, and the route then paged through
 * everything that matched. So "/top-dos-games" — whose countParams is `{}` —
 * walked the entire catalogue twenty-five at a time, and "/best-rpg-games"
 * walked every RPG in it.
 *
 * Which made them not merely similar to the plain listings but identical to
 * them. Every list here orders by "rating", and that is already the default
 * ordering Game.find applies to the homepage and to a genre page (see the
 * orderClause it builds: no orderBy, no letter/year/developer/publisher, and
 * it sorts on WEIGHTED_RATING). Same filter, same order, same page size — so
 * "/best-rpg-games?page=3" and "/rpg?page=3" were the same twenty-five games
 * in the same sequence, under a different <h1> and one intro paragraph.
 * That is a second set of indexable addresses aimed at the same queries as
 * the first, and two pages of one site competing for "classic MS-DOS RPG
 * games" is a trade with no winning side.
 *
 * A fixed hundred makes the two kinds of page different things rather than
 * rivals: the genre, letter, year, developer and publisher listings are the
 * exhaustive index of the catalogue, and these are the shortlist. Nothing
 * becomes unreachable — every game on a list is on its genre listing too, and
 * that listing is still paginated to the end.
 *
 * A hundred, matching /most-played below, which has been exactly this shape
 * all along: one page, capped, no pagination. It was the model for this.
 */
const LIST_SIZE = 100;

/**
 * The trail for these three pages, stated rather than derived.
 *
 * utils/breadcrumbs.ts builds a trail out of a page's locals, and it has
 * branches for the listings whose trail *is* a local — a genre, a letter, a
 * developer. These three have a fixed path instead, so there is nothing to
 * derive it from, and all three used to answer that by writing the trail out
 * in their own markup. That is the one thing views/breadcrumb.ejs exists to
 * stop: the visible trail and the BreadcrumbList schema in views/head.ejs are
 * meant to have one author, and with the markup written by hand they had none
 * in common — buildBreadcrumbs saw no branch it recognised, returned "Home"
 * alone, and breadcrumbLdJson drops a one-step trail. So every curated list,
 * the list index and /most-played showed a reader a path and told Google
 * nothing about it.
 *
 * `breadcrumbs` is the override both consumers already read, so passing it is
 * all either of them needs. The last step carries no path: it is the page the
 * visitor is already on. See utils/breadcrumbs.ts.
 *
 * HOME_CRUMB itself now lives beside buildBreadcrumbs rather than here: the
 * same six fixed pages in routes/home.ts and routes/news.ts state their trail
 * this way too, and a second copy of "Home" was one more thing to keep in
 * step.
 */
const LISTS_CRUMB: Breadcrumb = { name: "Game Lists", path: "/game-lists" };

/**
 * /most-played aggregates the whole "plays" table — which only ever grows,
 * and has no retention — so it was the one page that paid for a full GROUP BY
 * on every single request. It is also in the sitemap with changefreq "daily",
 * so crawlers ask for it regularly.
 *
 * Held for the same five minutes as the sidebar's top-five widget, which runs
 * the identical query. TtlCache stores the in-flight promise, so requests
 * arriving during a cold build share it rather than each starting their own.
 */
const MOST_PLAYED_TTL = 5 * 60 * 1000;

/**
 * Drops the cached /most-played page, for the game writes to call.
 *
 * Re-exported under the name it has always had, so the models and the suite
 * keep one address for it while the cache itself lives in utils. The cache
 * had no way in at all before it existed, so a game deleted from the
 * catalogue stayed on this page for up to five minutes and its link answered
 * a 404 — the same gap the sidebar's own "Most played" widget had.
 * routes/sitemap.ts and routes/feed.ts each expose one of these for the same
 * reason.
 */
export { clearMostPlayedCache };

export interface ListDefinition {
  slug: string;
  title: string;
  h1: string;
  description: string;
  intro: string;
  findParams: Parameters<typeof Game.find>[0];
  countParams: Parameters<typeof Game.count>[0];
  relatedSlugs: string[];
}

export const LISTS: ListDefinition[] = [
  {
    slug: "top-dos-games",
    title: "Top Classic MS-DOS Games of All Time | OldSchoolGames",
    h1: "Top Classic MS-DOS Games of All Time",
    description:
      "The highest-rated classic MS-DOS games as voted by players worldwide — from epic RPGs to action shooters, all playable free in your browser.",
    intro:
      "Looking for the best classic PC games to play right now? This list showcases the highest-rated MS-DOS titles as voted by our community — your ultimate starting point for retro gaming. All games run directly in your browser thanks to DOSBox emulation, no downloads or installation required. Whether you're a longtime fan of the 80s and 90s PC gaming scene or a newcomer curious about gaming history, this list has something for you.",
    findParams: { orderBy: "rating", orderDir: "DESC" },
    countParams: {},
    relatedSlugs: [
      "best-rpg-games",
      "best-action-games",
      "best-adventure-games",
      "dos-games-1990s",
    ],
  },
  {
    slug: "best-rpg-games",
    title: "Best Classic MS-DOS RPG Games | OldSchoolGames",
    h1: "Best Classic MS-DOS RPG Games",
    description:
      "The greatest RPG games of the DOS era — dungeon crawlers, open-world epics and more, all free to play in your browser.",
    intro:
      "The MS-DOS era was the golden age of role-playing games. Pioneering titles introduced deep character systems, branching stories, and sprawling worlds that still inspire game developers today. From the grid-based dungeon crawlers of Dungeon Master and Ultima Underworld, to the iconic Baldur's Gate series and classic Fallout — DOS RPGs defined what it means to get lost in a virtual world. This curated list brings together the best role-playing games from that legendary era, all playable for free directly in your browser.",
    findParams: { genre: "RPG", orderBy: "rating", orderDir: "DESC" },
    countParams: { genre: "RPG" },
    relatedSlugs: [
      "best-adventure-games",
      "best-strategy-games",
      "top-dos-games",
      "dos-games-1990s",
    ],
  },
  {
    slug: "best-action-games",
    title: "Best Classic MS-DOS Action Games | OldSchoolGames",
    h1: "Best Classic MS-DOS Action Games",
    description:
      "The best action games of the DOS era — fast-paced, adrenaline-pumping classics from the 80s and 90s, free in your browser.",
    intro:
      "MS-DOS action games were defined by speed, reflex, and pure fun. Long before modern consoles dominated living rooms, PC gamers were glued to their keyboards blasting through fast-paced side-scrollers, top-down shooters, and intense brawlers. Iconic games like Commander Keen, Duke Nukem, and Dangerous Dave set the standard for action-packed gameplay. This list collects the very best action games from the golden age of DOS gaming, ranked by our community.",
    findParams: { genre: "ACTION", orderBy: "rating", orderDir: "DESC" },
    countParams: { genre: "ACTION" },
    relatedSlugs: [
      "best-shooter-games",
      "best-platformer-games",
      "best-fighting-games",
      "top-dos-games",
    ],
  },
  {
    slug: "best-adventure-games",
    title: "Best Classic MS-DOS Adventure Games | OldSchoolGames",
    h1: "Best Classic MS-DOS Adventure Games",
    description:
      "The greatest point-and-click and text adventure games from the DOS era. Experience legendary titles from Sierra, LucasArts and more — free in your browser.",
    intro:
      "Adventure games were the heart and soul of MS-DOS gaming. LucasArts and Sierra On-Line defined the genre with unforgettable titles like Monkey Island, King's Quest, Leisure Suit Larry, and Gabriel Knight. These games told stories, challenged your wit, and transported you to fantasy worlds, space stations, and Victorian mysteries. This list gathers the most beloved adventure games from the golden age of DOS computing — perfect for fans of storytelling, puzzle-solving, and classic point-and-click gameplay.",
    findParams: { genre: "ADVENTURE", orderBy: "rating", orderDir: "DESC" },
    countParams: { genre: "ADVENTURE" },
    relatedSlugs: [
      "best-rpg-games",
      "best-puzzle-games",
      "top-dos-games",
      "dos-games-1990s",
    ],
  },
  {
    slug: "best-strategy-games",
    title: "Best Classic MS-DOS Strategy Games | OldSchoolGames",
    h1: "Best Classic MS-DOS Strategy Games",
    description:
      "The top strategy games of the DOS era — real-time classics and turn-based masterpieces. Build empires and command armies in your browser.",
    intro:
      "Strategy games on MS-DOS ranged from relaxed city builders to nail-biting real-time warfare. Titles like Civilization, Dune II, Command & Conquer, and Master of Orion created entire genres and inspired countless modern games. Whether you prefer the methodical depth of turn-based play or the urgent pressure of real-time strategy, DOS-era strategy games offer hundreds of hours of compelling gameplay. Explore our top picks from this legendary period below.",
    findParams: { genre: "STRATEGY", orderBy: "rating", orderDir: "DESC" },
    countParams: { genre: "STRATEGY" },
    relatedSlugs: [
      "best-simulation-games",
      "best-rpg-games",
      "top-dos-games",
      "dos-games-1990s",
    ],
  },
  {
    slug: "best-puzzle-games",
    title: "Best Classic MS-DOS Puzzle Games | OldSchoolGames",
    h1: "Best Classic MS-DOS Puzzle Games",
    description:
      "Brain-teasing puzzle games from the MS-DOS era. From Tetris to The Incredible Machine — the best classic DOS puzzlers, free in your browser.",
    intro:
      "Long before mobile gaming brought puzzle games to everyone's pocket, MS-DOS was home to some of the most creative and mind-bending puzzle experiences ever made. Games like The Incredible Machine, Lemmings, Sokoban, and various Tetris clones kept players glued to their monitors for hours. DOS puzzle games ranged from relaxing spatial challenges to fiendishly difficult brain-teasers. This list highlights the best of the genre from the classic DOS era.",
    findParams: { genre: "PUZZLE", orderBy: "rating", orderDir: "DESC" },
    countParams: { genre: "PUZZLE" },
    relatedSlugs: [
      "best-adventure-games",
      "best-platformer-games",
      "top-dos-games",
      "dos-games-1980s",
    ],
  },
  {
    slug: "best-platformer-games",
    title: "Best Classic MS-DOS Platformer Games | OldSchoolGames",
    h1: "Best Classic MS-DOS Platformer Games",
    description:
      "The best platformer games of the MS-DOS era — jump, run and explore classic side-scrolling adventures, free in your browser.",
    intro:
      "While consoles like the NES had Mario, DOS gamers had their own rich library of platformers. From the beloved Commander Keen and Jazz Jackrabbit by Epic Games, to the polished Prince of Persia and Shadow of the Beast, DOS platformers combined creative level design with memorable characters. Many of these games pushed the hardware to its limits with smooth scrolling and colorful graphics. Relive the best DOS platformers here — all playable straight in your browser.",
    findParams: { genre: "PLATFORMER", orderBy: "rating", orderDir: "DESC" },
    countParams: { genre: "PLATFORMER" },
    relatedSlugs: [
      "best-action-games",
      "best-puzzle-games",
      "top-dos-games",
      "dos-games-1990s",
    ],
  },
  {
    slug: "best-horror-games",
    title: "Best Classic MS-DOS Horror Games | OldSchoolGames",
    h1: "Best Classic MS-DOS Horror Games",
    description:
      "The scariest and most atmospheric horror games from the DOS era. From survival horror to dark adventures — experience classic terror in your browser.",
    intro:
      "Long before the modern horror renaissance, MS-DOS games were already mastering atmosphere, tension, and dread. Early pixel-art horrors could be surprisingly effective — games like Alone in the Dark, I Have No Mouth and I Must Scream, and Elvira: Mistress of the Dark delivered chills through clever storytelling and unsettling aesthetics. Whether you enjoy survival horror, dark narrative adventures, or occult-themed games, this collection of DOS horror games is sure to unsettle you in all the right ways.",
    findParams: { genre: "HORROR", orderBy: "rating", orderDir: "DESC" },
    countParams: { genre: "HORROR" },
    relatedSlugs: ["best-adventure-games", "best-rpg-games", "top-dos-games"],
  },
  {
    slug: "best-simulation-games",
    title: "Best Classic MS-DOS Simulation Games | OldSchoolGames",
    h1: "Best Classic MS-DOS Simulation Games",
    description:
      "The best simulation games of the DOS era — flight sims, city builders and life sims, from SimCity to Microsoft Flight Simulator.",
    intro:
      "Simulation games were a cornerstone of MS-DOS gaming culture. Flight simulators like Microsoft Flight Simulator and F-19 Stealth Fighter pushed hardware limits while offering realistic experiences. City builders like SimCity and Theme Park let players build virtual worlds. Transport and business simulations like Transport Tycoon offered deep strategic gameplay. These were games made for thinking players who wanted depth and realism. Explore the best DOS simulation games below.",
    findParams: { genre: "SIMULATION", orderBy: "rating", orderDir: "DESC" },
    countParams: { genre: "SIMULATION" },
    relatedSlugs: [
      "best-strategy-games",
      "best-sports-games",
      "top-dos-games",
      "dos-games-1990s",
    ],
  },
  {
    slug: "best-sports-games",
    title: "Best Classic MS-DOS Sports Games | OldSchoolGames",
    h1: "Best Classic MS-DOS Sports Games",
    description:
      "The greatest sports games of the DOS era — football, basketball, baseball and more, playable free in your browser.",
    intro:
      "Sports games on MS-DOS ranged from simple arcade action to surprisingly deep simulations. EA Sports began its empire during this era, and titles like Madden NFL, FIFA Soccer, Lakers vs. Celtics, and NHL Hockey were staples of PC gaming in the late 80s and early 90s. Beyond team sports, DOS also offered golf sims, boxing games, and even chess programs that drove players to compete against early AI. Relive the best sports titles from DOS gaming's golden age right here.",
    findParams: { genre: "SPORTS", orderBy: "rating", orderDir: "DESC" },
    countParams: { genre: "SPORTS" },
    relatedSlugs: [
      "best-racing-games",
      "best-simulation-games",
      "top-dos-games",
    ],
  },
  {
    slug: "best-racing-games",
    title: "Best Classic MS-DOS Racing Games | OldSchoolGames",
    h1: "Best Classic MS-DOS Racing Games",
    description:
      "The fastest racing games of the DOS era — from Need for Speed to Test Drive, race classic cars free in your browser.",
    intro:
      "Racing games on MS-DOS delivered speed, competition, and the thrill of the track long before 3D graphics became the norm. Early titles like Test Drive and Road Blasters set the stage, while later classics like Need for Speed, IndyCar Racing, and Stunts pushed VGA graphics to their limits. Whether you enjoy Formula 1 precision, street racing adrenaline, or over-the-top stunt tracks, DOS racing games offer a surprisingly rich catalog. Buckle up and explore the best below.",
    findParams: { genre: "RACING", orderBy: "rating", orderDir: "DESC" },
    countParams: { genre: "RACING" },
    relatedSlugs: ["best-sports-games", "best-action-games", "top-dos-games"],
  },
  {
    slug: "best-shooter-games",
    title: "Best Classic MS-DOS Shooter Games | OldSchoolGames",
    h1: "Best Classic MS-DOS Shooter Games",
    description:
      "The best shooter games from the DOS era — from DOOM and Quake to top-down shooters. Experience the origins of the FPS genre in your browser.",
    intro:
      "MS-DOS is where the first-person shooter genre was born. id Software's Wolfenstein 3D, DOOM, and Quake revolutionized gaming and still hold up as milestone experiences. But DOS shooters weren't just first-person — top-down shooters, isometric shoot-em-ups, and side-scrolling shooters all flourished on the platform. This list celebrates both the landmark FPS titles that changed gaming history and the beloved arcade-style shooters that defined a generation of PC gaming.",
    findParams: { genre: "SHOOTER", orderBy: "rating", orderDir: "DESC" },
    countParams: { genre: "SHOOTER" },
    relatedSlugs: [
      "best-action-games",
      "best-platformer-games",
      "top-dos-games",
      "dos-games-1990s",
    ],
  },
  {
    slug: "best-fighting-games",
    title: "Best Classic MS-DOS Fighting Games | OldSchoolGames",
    h1: "Best Classic MS-DOS Fighting Games",
    description:
      "The best fighting games from the DOS era. Street Fighter, Mortal Kombat, and more — relive classic one-on-one combat games from the 90s in your browser.",
    intro:
      "While consoles were the primary home of fighting games, MS-DOS received solid ports of many classic arcade fighters as well as unique PC exclusives. Mortal Kombat brought its gory fatalities to PC monitors, while Street Fighter II and One Must Fall: 2097 offered memorable one-on-one combat. DOS fighting games may have been a smaller slice of the library, but the best titles were genuinely excellent. This list collects the top fighting games from the classic DOS era.",
    findParams: { genre: "FIGHTING", orderBy: "rating", orderDir: "DESC" },
    countParams: { genre: "FIGHTING" },
    relatedSlugs: [
      "best-action-games",
      "best-platformer-games",
      "top-dos-games",
    ],
  },
  {
    slug: "dos-games-1990s",
    title: "Best Classic DOS Games from the 1990s | OldSchoolGames",
    h1: "Best Classic DOS Games from the 1990s",
    description:
      "The best MS-DOS games of the 1990s — from DOOM to Warcraft, the golden decade of PC gaming, free in your browser.",
    intro:
      "The 1990s were arguably the greatest decade in PC gaming history. MS-DOS games reached new heights of complexity, storytelling, and technical achievement. The early 90s saw the rise of the FPS with Wolfenstein 3D and DOOM, while mid-decade brought legendary RPGs like Ultima VII and Baldur's Gate. Real-time strategy boomed with Dune II, Warcraft, and StarCraft. By the late 90s, DOS was giving way to Windows — but the games from this era remain some of the most beloved in all of gaming. Explore the best of the decade below.",
    findParams: {
      releaseFrom: 1990,
      releaseTo: 1999,
      orderBy: "rating",
      orderDir: "DESC",
    },
    countParams: { releaseFrom: 1990, releaseTo: 1999 },
    relatedSlugs: [
      "dos-games-1980s",
      "best-shooter-games",
      "best-rpg-games",
      "top-dos-games",
    ],
  },
  {
    slug: "dos-games-1980s",
    title: "Best Classic DOS Games from the 1980s | OldSchoolGames",
    h1: "Best Classic DOS Games from the 1980s",
    description:
      "The best MS-DOS games of the 1980s — the pioneering classics from the birth of PC gaming, all free to play in your browser.",
    intro:
      "The 1980s were the pioneering years of MS-DOS gaming. Personal computers were new and exciting, and developers were discovering what this medium could do. Games like King's Quest, Zork, Ultima, Montezuma's Revenge, and Karateka laid the groundwork for the genres and conventions we still recognize today. Graphics were primitive by modern standards, but the creativity and ambition on display were remarkable. Rediscover the roots of PC gaming with this collection of the best DOS games from the 1980s.",
    findParams: {
      releaseFrom: 1980,
      releaseTo: 1989,
      orderBy: "rating",
      orderDir: "DESC",
    },
    countParams: { releaseFrom: 1980, releaseTo: 1989 },
    relatedSlugs: [
      "dos-games-1990s",
      "best-adventure-games",
      "best-rpg-games",
      "top-dos-games",
    ],
  },
];

const LIST_BY_SLUG = new Map(LISTS.map((l) => [l.slug, l]));

/**
 * How many games a curated list holds, read off the counts routes/sitemap.ts
 * already has rather than counted per list.
 *
 * The route below answers 404 for a list with nothing in it, so the sitemap
 * must not name one — the same way it skips a letter or a genre no game is
 * filed under. Calling Game.count() once per list would be fifteen more
 * queries on a document deliberately reduced to a single GROUP BY (see
 * Game.getSitemapCounts), and it does not need them: every `countParams`
 * above is either one genre, a release range, or the whole catalogue, and all
 * three are already in that result.
 *
 * It lives here rather than in the sitemap because the shape of `countParams`
 * is this file's business. A list whose filters outgrow those three cases
 * belongs in Game.count() and in this function together, and the suite checks
 * the two agree for every list rather than trusting that they do.
 */
export function countListGames(
  list: ListDefinition,
  counts: Map<string, number>,
  totalGames: number,
): number {
  const { genre, releaseFrom, releaseTo } = list.countParams ?? {};

  if (genre) {
    // Upper-cased as Game.count() does before it compares, so the key matches
    // the enum value getSitemapCounts groups by.
    return counts.get(`genre:${genre.toUpperCase()}`) ?? 0;
  }

  if (releaseFrom !== undefined || releaseTo !== undefined) {
    // The year buckets come from "release" IS NOT NULL, and the ">= AND <="
    // Game.count() builds excludes a null release too — so summing the
    // buckets inside the range is the same number.
    const from = releaseFrom ?? -Infinity;
    const to = releaseTo ?? Infinity;

    let total = 0;

    for (const [key, count] of counts) {
      if (!key.startsWith("year:")) continue;

      const year = Number(key.slice("year:".length));

      if (Number.isFinite(year) && year >= from && year <= to) total += count;
    }

    return total;
  }

  // No filters — the list is the whole catalogue ordered differently.
  return totalGames;
}

/**
 * When a curated list last changed, for routes/sitemap.ts to stamp on it.
 *
 * The mirror of countListGames above, reading the lastmod half of the same
 * GROUP BY (see Game.getSitemapCounts), and it splits on `countParams` in the
 * same three ways for the same reason — so that a list whose filters outgrow
 * them is a change both functions have to be taught, rather than one that
 * quietly falls through to the catalogue-wide branch in each.
 *
 * `undefined` rather than a guess when nothing is known: a sitemap entry may
 * carry no lastmod at all, and a wrong one is worse than none — Google only
 * leans on the value while it is consistently accurate, and a date that never
 * matches what the page actually shows teaches it to ignore the element.
 */
export function listLastmod(
  list: ListDefinition,
  lastmods: Map<string, string>,
  catalogueLastmod?: string,
): string | undefined {
  const { genre, releaseFrom, releaseTo } = list.countParams ?? {};

  if (genre) {
    return lastmods.get(`genre:${genre.toUpperCase()}`);
  }

  if (releaseFrom !== undefined || releaseTo !== undefined) {
    const from = releaseFrom ?? -Infinity;
    const to = releaseTo ?? Infinity;

    let latest: string | undefined;

    for (const [key, value] of lastmods) {
      if (!key.startsWith("year:")) continue;

      const year = Number(key.slice("year:".length));

      if (!Number.isFinite(year) || year < from || year > to) continue;

      // ISO-8601 in a fixed zone sorts lexically, which is what
      // Game.getSitemapCounts stores and what the sitemap prints.
      if (latest === undefined || value > latest) latest = value;
    }

    return latest;
  }

  return catalogueLastmod;
}

router.get("/most-played", async (req, res) => {
  const games = await mostPlayedCache.get(
    MOST_PLAYED_KEY,
    MOST_PLAYED_TTL,
    () => Game.findMostPlayed(100),
  );

  res.render("lists/most-played", {
    breadcrumbs: [HOME_CRUMB, { name: "100 Most Played Games" }],
    title: "100 Most Played Classic MS-DOS Games | OldSchoolGames",
    description:
      "Discover the 100 most played classic MS-DOS games on OldSchoolGames.eu — ranked by total plays. Find out which retro DOS games are most popular right now.",
    canonicalUrl: `${SITE_URL}/most-played`,
    games,
  });
});

router.get("/game-lists", (req, res) => {
  res.render("lists/lists-index", {
    breadcrumbs: [HOME_CRUMB, { name: "Game Lists" }],
    title: "Classic DOS Game Lists & Top Picks | OldSchoolGames",
    description:
      "Browse curated lists of the best classic MS-DOS games — top rated games, best by genre, best by decade, and more. Find your next retro gaming obsession.",
    canonicalUrl: `${SITE_URL}/game-lists`,
    lists: LISTS,
  });
});

router.get("/:slug", async (req, res, next) => {
  const list = LIST_BY_SLUG.get(req.params.slug);

  if (!list) {
    return next();
  }

  // These lists were paginated until LIST_SIZE was introduced, and every page
  // of every one of them was a real address that answered 200 — linked from
  // the pagination control, crawled, and quite possibly still in an index or
  // somebody's bookmarks. A 301 onto the list itself is what those addresses
  // mean now: the same list, all of it, on one page.
  //
  // Any `page` at all, not only page 2 and up. "?page=1" was never a canonical
  // address here either (see paginationUrls, which addresses page 1 as the
  // bare URL for exactly this reason), so it redirects with the rest rather
  // than serving a second copy of this page under a query string.
  if (req.query.page !== undefined) {
    return res.redirect(301, `/${list.slug}`);
  }

  // No Game.count() beside this any more: it counted rows only to work out how
  // many pages there were, and the schema's `numberOfItems` should describe
  // what is on the page rather than what the filter would have matched.
  const games = await Game.find({ ...list.findParams, limit: LIST_SIZE });

  // A list with nothing in it does not exist. Every "best-<genre>-games" list
  // above is one genre, so a genre the catalogue holds nothing for used to
  // serve a complete 200 — its own <title>, canonical and intro around an
  // empty list — while "/<genre>" itself answered 404 (see routes/home.ts).
  // routes/sitemap.ts advertised the list either way, so that 200 was handed
  // to crawlers rather than merely reachable.
  if (games.length === 0) {
    return next();
  }

  const relatedLists = list.relatedSlugs
    .map((slug) => LIST_BY_SLUG.get(slug))
    .filter(Boolean) as ListDefinition[];

  res.render("lists/list", {
    breadcrumbs: [HOME_CRUMB, LISTS_CRUMB, { name: list.h1 }],
    list,
    games,
    relatedLists,
    title: list.title,
    // The one route in this file whose description is data rather than a
    // literal written beside the render. Six of the fifteen ran between 162
    // and 189 characters against a 155 limit and nothing here noticed, because
    // this file — unlike every listing route in routes/home.ts — never passed
    // a description through truncateAtWord at all. All six have been rewritten
    // to fit; this keeps a seventh from being added over the limit.
    description: truncateAtWord(list.description, META_DESCRIPTION_MAX),
    canonicalUrl: `${SITE_URL}/${list.slug}`,
  });
});

export default router;
