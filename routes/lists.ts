import express from "express";
import Game from "../models/game.ts";

const router = express.Router();

const LIMIT = 25;

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
      "Discover the highest-rated classic MS-DOS games as voted by players worldwide. From epic RPGs to action shooters — these are the best DOS games ever made, all playable free in your browser.",
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
      "Explore the greatest RPG games from the DOS era. From dungeon crawlers to open-world adventures — these are the top role-playing games for MS-DOS, all free to play in your browser.",
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
      "The best action games from the DOS era — fast-paced, adrenaline-pumping classics from the 80s and 90s. Play them free in your browser with DOSBox emulation.",
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
      "The top strategy games from the DOS era — from real-time classics to turn-based masterpieces. Build empires, command armies, and outsmart opponents in these timeless strategy games.",
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
      "Brain-teasing puzzle games from the MS-DOS era. From Tetris to The Incredible Machine — challenge your mind with the best classic DOS puzzle games, all free in your browser.",
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
      "The best platformer games from the MS-DOS era. Jump, run, and explore classic side-scrolling adventures from the 80s and 90s — playable free in your browser.",
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
      "The best simulation games from the DOS era — flight sims, city builders, and life simulators. Experience legendary classics like SimCity and Microsoft Flight Simulator in your browser.",
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
      "The greatest sports games from the DOS era. Football, basketball, baseball, and more — relive classic sports simulations from the 80s and 90s in your browser.",
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
      "The fastest and most thrilling racing games from the DOS era. From Need for Speed to Test Drive — race classic cars in your browser with no downloads required.",
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
      "The best MS-DOS games released in the 1990s. From DOOM to Warcraft — explore the golden decade of PC gaming and play these 90s classics free in your browser.",
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
      "The best MS-DOS games released in the 1980s. Discover the pioneering games that started it all — early classics from the birth of PC gaming, free in your browser.",
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

router.get("/game-lists", (req, res) => {
  res.render("lists/lists-index", {
    title: "Classic DOS Game Lists & Top Picks | OldSchoolGames",
    description:
      "Browse curated lists of the best classic MS-DOS games — top rated games, best by genre, best by decade, and more. Find your next retro gaming obsession.",
    canonicalUrl: "https://oldschoolgames.eu/game-lists",
    lists: LISTS,
  });
});

router.get("/:slug", async (req, res, next) => {
  const list = LIST_BY_SLUG.get(req.params.slug);

  if (!list) {
    return next();
  }

  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);

  const [games, totalCount] = await Promise.all([
    Game.find({ ...list.findParams, limit: LIMIT, page }),
    Game.count(list.countParams),
  ]);

  const totalPages = Math.ceil(totalCount / LIMIT);

  const baseUrl = `https://oldschoolgames.eu/${list.slug}`;
  const canonicalUrl = page > 1 ? `${baseUrl}?page=${page}` : baseUrl;
  const prevPageUrl =
    page > 1 ? (page > 2 ? `${baseUrl}?page=${page - 1}` : baseUrl) : undefined;
  const nextPageUrl =
    games.length === LIMIT ? `${baseUrl}?page=${page + 1}` : undefined;

  const relatedLists = list.relatedSlugs
    .map((slug) => LIST_BY_SLUG.get(slug))
    .filter(Boolean) as ListDefinition[];

  res.render("lists/list", {
    list,
    games,
    page,
    limit: LIMIT,
    totalCount,
    totalPages,
    relatedLists,
    title: list.title,
    description: list.description,
    canonicalUrl,
    prevPageUrl,
    nextPageUrl,
  });
});

export default router;
