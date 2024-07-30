import express from "express";
import Game from "../models/game.ts";
import Comment from "../models/comment.ts";
import News from "../models/news.ts";

const router = express.Router();

const VALID_ORDER_BY_FIELDS = ["createdAt", "release", "rating", "title"];

// Per-studio metadata: blurb text shown on filter pages + optional title override
// (used when the studio name clashes with a modern brand or the default title performs poorly).
const STUDIO_DATA: Record<string, { blurb: string; title: string }> = {
  "id Software": {
    title:
      "id Software DOS Games – Doom, Wolfenstein 3D & Quake | OldSchoolGames",
    blurb:
      "id Software is the legendary Texas-based studio founded in 1991 by John Carmack and John Romero. They pioneered the first-person shooter genre with Wolfenstein 3D, Doom and Quake, and their game engine technology — including the Quake engine — shaped PC gaming throughout the 1990s. Doom in particular became a cultural phenomenon, defining multiplayer deathmatches and the modding community.",
  },
  LucasArts: {
    title:
      "LucasArts Classic DOS Games – Monkey Island, Day of the Tentacle & More | OldSchoolGames",
    blurb:
      "LucasArts (originally Lucasfilm Games) was the games division of George Lucas's company, active from 1982 to 2013. During the late 1980s and 1990s they produced some of the greatest adventure games ever made: The Secret of Monkey Island, Grim Fandango, Day of the Tentacle, Sam & Max Hit the Road, Indiana Jones and the Fate of Atlantis, and the SCUMM-engine classics that defined point-and-click gaming.",
  },
  MicroProse: {
    title:
      "MicroProse DOS Games – Civilization, X-COM, Colonization & More | OldSchoolGames",
    blurb:
      "MicroProse was founded in 1982 by Sid Meier and Bill Stealey. The studio became synonymous with deep simulation and strategy games — Civilization, Railroad Tycoon, X-COM: UFO Defense, Colonization, F-19 Stealth Fighter and Gunship. Their titles consistently rewarded patience and strategic thinking, making them cornerstones of MS-DOS gaming throughout the late 1980s and 1990s.",
  },
  "Westwood Studios": {
    title:
      "Westwood Studios DOS Games – Dune II, Command & Conquer & More | OldSchoolGames",
    blurb:
      "Westwood Studios, based in Las Vegas, was founded in 1985 and is best known for inventing the real-time strategy genre with Dune II: The Building of a Dynasty in 1992. They followed it with the Command & Conquer series and the Lands of Lore and Legend of Kyrandia RPG series. Electronic Arts acquired and eventually closed the studio in 2003.",
  },
  "Apogee Software": {
    title:
      "Apogee Software DOS Games – Commander Keen, Duke Nukem & More | OldSchoolGames",
    blurb:
      "Apogee Software (later 3D Realms) pioneered the shareware distribution model for PC games in the late 1980s and early 1990s. They published Commander Keen, Blake Stone, Duke Nukem, Wolfenstein 3D (with id Software), and Rise of the Triad. Their strategy of releasing the first episode for free and selling the rest helped establish PC gaming as a mainstream hobby.",
  },
  "3D Realms": {
    title:
      "3D Realms DOS Games – Duke Nukem 3D, Shadow Warrior & More | OldSchoolGames",
    blurb:
      "3D Realms, the successor brand to Apogee Software, is best known for publishing and co-developing Duke Nukem 3D in 1996 — one of the most influential first-person shooters of its era. The studio also published Terminal Velocity, Shadow Warrior and many other classic DOS titles throughout the 1990s.",
  },
  "Sierra On-Line": {
    title:
      "Sierra On-Line DOS Games – King's Quest, Space Quest, Leisure Suit Larry & More | OldSchoolGames",
    blurb:
      "Sierra On-Line was founded by Ken and Roberta Williams in 1979 and became one of the most prolific adventure game studios of all time. Their King's Quest, Space Quest, Police Quest, Leisure Suit Larry, Gabriel Knight and Quest for Glory series defined graphic adventure games for an entire generation of PC gamers.",
  },
  "Epic Games": {
    title:
      "Epic MegaGames Classic DOS Games – Jazz Jackrabbit, Jill of the Jungle & More | OldSchoolGames",
    blurb:
      "Epic Games (originally Epic MegaGames) began as a shareware publisher in the early 1990s, distributing titles like Epic Pinball, Jill of the Jungle, Jazz Jackrabbit and One Must Fall: 2097. Jazz Jackrabbit in particular became hugely popular as a fast-paced DOS platformer. The studio later shifted to developing the Unreal engine and the Unreal Tournament series.",
  },
  "Virgin Interactive": {
    title:
      "Virgin Interactive DOS Games – Dune, Cool Spot & More | OldSchoolGames",
    blurb:
      "Virgin Interactive Entertainment was the games label of Richard Branson's Virgin Group, active throughout the 1980s and 1990s. They published and co-developed a wide range of titles including The 7th Guest, Dune (the adventure game), Cool Spot, Aladdin (the Sega/PC version) and numerous licensed movie tie-in games.",
  },
  "Interplay Productions": {
    title:
      "Interplay Productions DOS Games – Fallout, Battle Chess & More | OldSchoolGames",
    blurb:
      "Interplay Productions, founded by Brian Fargo in 1983, was responsible for some of the most celebrated RPGs and action games of the DOS era. Their catalogue includes Fallout, Wasteland, Baldur's Gate (published), Star Trek games, Battle Chess and the MDK series. Interplay was known for pushing narrative depth and production values in PC games.",
  },
  "Delphine Software": {
    title:
      "Delphine Software DOS Games – Another World, Flashback & More | OldSchoolGames",
    blurb:
      "Delphine Software was a French studio known for cinematic storytelling and fluid animation in their MS-DOS games. Their most iconic titles include Another World (Out of This World), Flashback: The Quest for Identity, and Operation Stealth. Another World in particular is considered one of the most artistically significant games of the early 1990s.",
  },
  Broderbund: {
    title:
      "Broderbund DOS Games – Prince of Persia, Lode Runner & More | OldSchoolGames",
    blurb:
      "Broderbund Software was founded in 1980 and is best known for publishing Prince of Persia, Carmen Sandiego, Myst and Lode Runner. Prince of Persia, programmed by Jordan Mechner using rotoscoped animation, became an instant classic and one of the defining platform games of the MS-DOS era.",
  },
  Accolade: {
    title:
      "Accolade DOS Games – Test Drive, Star Control & More | OldSchoolGames",
    blurb:
      "Accolade was an American game developer and publisher active from 1984 to 2004. They are best remembered for the Test Drive racing series, the Hardball! baseball series, Star Control and the Bubsy platform games. Their Test Drive series brought realistic car simulation to home computers in the late 1980s.",
  },
  "Blizzard Entertainment": {
    title:
      "Blizzard Entertainment DOS Games – Warcraft, Diablo & More | OldSchoolGames",
    blurb:
      "Blizzard Entertainment (originally Silicon & Synapse) was founded in 1991 and became one of the most celebrated studios of the 1990s. Their DOS-era catalogue includes The Lost Vikings, Rock n' Roll Racing, Warcraft: Orcs & Humans, Warcraft II: Tides of Darkness and the original Diablo — a dungeon crawler that redefined the action-RPG genre and whose gothic atmosphere still resonates today.",
  },
  "Origin Systems": {
    title:
      "Origin Systems DOS Games – Ultima, Wing Commander & More | OldSchoolGames",
    blurb:
      'Origin Systems was founded by Richard Garriott in 1983 and operated under the motto "We Create Worlds." They are best known for the Ultima series of role-playing games and the Wing Commander space combat series, both of which set benchmarks for storytelling and production values in PC gaming. Electronic Arts acquired the studio in 1992.',
  },
  "Electronic Arts": {
    title:
      "Electronic Arts Classic DOS Games – FIFA, Bullfrog, Origin & More | OldSchoolGames",
    blurb:
      "Electronic Arts was founded by Trip Hawkins in 1982 and became one of the most influential publishers of the MS-DOS era. They released a wide range of sports simulations, action titles and strategy games, and published work from studios such as Bullfrog Productions, Origin Systems, Westwood Studios and Maxis. Their sports franchises — including FIFA, NBA Live and Madden — became staples of 1990s PC gaming.",
  },
  Psygnosis: {
    title:
      "Psygnosis DOS Games – Lemmings, Shadow of the Beast & More | OldSchoolGames",
    blurb:
      "Psygnosis was a British studio founded in 1984 and is best remembered for co-developing Lemmings — one of the most commercially successful and widely ported puzzle games of all time. They also produced Shadow of the Beast, Obliterator and many other Amiga and DOS titles known for pushing graphical limits. Sony acquired the studio in 1993.",
  },
  Maxis: {
    title:
      "Maxis DOS Games – SimCity, SimEarth, SimAnt & More | OldSchoolGames",
    blurb:
      "Maxis was founded by Will Wright and Jeff Braun in 1987 and is the studio behind SimCity — the game that established the city-builder genre and inspired a generation of simulation games. They followed it with SimEarth, SimAnt, SimCity 2000 and The Sims. Their games consistently encouraged creative problem-solving over win conditions.",
  },
  "New World Computing": {
    title:
      "New World Computing DOS Games – Might and Magic, Heroes of Might and Magic & More | OldSchoolGames",
    blurb:
      "New World Computing was founded in 1984 and is best known for the Might and Magic RPG series and its spin-off Heroes of Might and Magic, a turn-based strategy series that became a cornerstone of the genre. The combination of deep exploration, dungeon crawling and tactical combat made their games enduringly popular throughout the MS-DOS era.",
  },
  "Core Design": {
    title:
      "Core Design DOS Games – Tomb Raider, Chuck Rock & More | OldSchoolGames",
    blurb:
      "Core Design was a British studio founded in 1988, best known for creating Tomb Raider in 1996 — a 3D action-adventure game that made Lara Croft one of gaming's most recognisable characters. Before Tomb Raider they produced Chuck Rock, Thunderhawk and several well-regarded Amiga and DOS titles.",
  },
  "DMA Design": {
    title:
      "DMA Design DOS Games – Lemmings, Grand Theft Auto & More | OldSchoolGames",
    blurb:
      "DMA Design was a Scottish studio founded by David Jones in 1987. They created Lemmings in 1991 — one of the best-selling and most ported games of all time — and went on to develop Body Harvest and the original Grand Theft Auto. Their ability to originate entirely new genres made them one of the most inventive studios of the DOS era.",
  },
  "Blue Byte": {
    title:
      "Blue Byte DOS Games – The Settlers, Battle Isle & More | OldSchoolGames",
    blurb:
      "Blue Byte was a German studio founded in 1988, best known for The Settlers series — city-building strategy games with detailed resource chains and charming visuals that set the standard for the genre. They also developed the Battle Isle series of turn-based strategy games, building a loyal following throughout the 1990s.",
  },
  "Raven Software": {
    title: "Raven Software DOS Games – Heretic, Hexen & More | OldSchoolGames",
    blurb:
      "Raven Software was founded in 1990 and built their reputation developing games on id Software's engines. Using the Doom engine they created Heretic in 1994 and Hexen: Beyond Heretic in 1995 — dark fantasy shooters that significantly expanded what the engine could do. They later collaborated with id on Quake mission packs and developed Jedi Knight II.",
  },
  "Bethesda Softworks": {
    title:
      "Bethesda Softworks DOS Games – The Elder Scrolls Arena & Daggerfall | OldSchoolGames",
    blurb:
      "Bethesda Softworks was founded in 1986 by Christopher Weaver and launched The Elder Scrolls series with Arena in 1994, followed by the vast open world of Daggerfall in 1996. These ambitious first-person RPGs let players explore enormous hand-crafted worlds with near-total freedom, establishing the template for the open-world RPG genre.",
  },
};

// Per-year blurb text shown on /year/:year pages
const YEAR_DATA: Record<number, { blurb: string }> = {
  1984: {
    blurb:
      "1984 was among the earliest years for MS-DOS gaming. Personal computers were still expensive novelties, and the games of the era reflected both the limitations and the ambition of pioneer developers. Sierra On-Line's King's Quest introduced the graphic adventure to a wide audience, while Jordan Mechner's Karateka brought fluid rotoscoped animation to the PC. Despite primitive CGA graphics and PC speaker bleeps, the games of 1984 laid the conceptual groundwork for the genres that followed.",
  },
  1985: {
    blurb:
      "1985 saw MS-DOS gaming mature rapidly as EGA colour cards began appearing in homes. Electronic Arts published The Bard's Tale, one of the most influential early RPGs, while Richard Garriott continued the Ultima series with Ultima IV: Quest of the Avatar — a game that replaced the typical 'defeat the villain' objective with a nuanced virtue system. Sid Meier's Pirates! brought open-world swashbuckling to the PC. The year demonstrated that DOS games could have genuine depth and narrative ambition.",
  },
  1986: {
    blurb:
      "1986 was the year Sierra On-Line expanded its adventure game universe dramatically. Leisure Suit Larry in the Land of the Lounge Lizards launched Al Lowe's irreverent AGI series, while Space Quest introduced Roger Wilco, the hapless space janitor turned accidental hero. Might and Magic: The Secret of the Inner Sanctum debuted as one of the most complex RPGs on DOS. Developers were discovering that the PC could handle comedy, drama and exploration in ways no other platform could match.",
  },
  1987: {
    blurb:
      "1987 was a pivotal year for MS-DOS gaming. LucasArts (then Lucasfilm Games) released Maniac Mansion — the first game built on the SCUMM engine — introducing the point-and-click adventure genre to PC audiences. Beyond Zork blended the text parser with RPG elements. Space Quest II and King's Quest III continued Sierra's prolific adventure game output. The foundations of what would become the adventure game's golden age were firmly being laid.",
  },
  1988: {
    blurb:
      "By 1988, EGA had become the dominant display standard, and developers were pushing its 16-colour palette to its limits. King's Quest IV was the first Sierra game to star a female protagonist, while Leisure Suit Larry 2 continued Al Lowe's irreverent adventure series. The Ultima series kept refining its open-world RPG formula, and a growing range of sports simulations and early action games cemented MS-DOS as a serious gaming platform.",
  },
  1989: {
    blurb:
      "1989 was a landmark year. Jordan Mechner's Prince of Persia revolutionised platforming with rotoscoped animation and physics-based movement — a template that influenced developers for decades. Will Wright's SimCity invited players to build and manage entire cities, launching the city-builder and god-game genre. Bullfrog's Populous defined the deity simulation. Indiana Jones and the Last Crusade brought cinematic adventure storytelling to the PC in a way that had rarely been achieved before.",
  },
  1990: {
    blurb:
      "1990 was the year VGA became the new standard, and MS-DOS games grew dramatically more colourful and detailed overnight. Wing Commander from Origin Systems delivered cinematic space combat that felt like playing a science-fiction film. The Secret of Monkey Island — LucasArts' debut SCUMM masterpiece — reinvented the adventure game with perfect comic writing and clever puzzles. King's Quest V transitioned Sierra's flagship series to a fully point-and-click interface. The golden age of DOS gaming had definitively arrived.",
  },
  1991: {
    blurb:
      "1991 produced some of the most foundational MS-DOS games ever made. Sid Meier's Civilization at MicroProse created a turn-based empire-building game of such depth and 'one more turn' compulsion that it spawned a genre and a franchise still active today. Commander Keen from id Software and Apogee brought console-quality platforming to the PC and proved the shareware distribution model could work at scale. Duke Nukem made his original side-scrolling debut. The Ultima Underworld prototype established the template for the first-person RPG.",
  },
  1992: {
    blurb:
      "1992 may be the single most significant year in MS-DOS gaming history. id Software's Wolfenstein 3D launched the first-person shooter genre, setting the stage for everything from Doom to Half-Life. Alone in the Dark by Infogrames pioneered survival horror with fixed camera angles and genuine dread. Westwood Studios' Dune II invented the real-time strategy genre. LucasArts published Indiana Jones and the Fate of Atlantis — widely considered one of the greatest adventure games ever made. Few years in any medium have produced such a density of genre-defining work.",
  },
  1993: {
    blurb:
      "1993 was the year DOOM arrived and nothing was ever the same again. id Software's masterpiece became a cultural phenomenon, popularising networked multiplayer deathmatch and defining the first-person shooter for years to come. LucasArts responded with Day of the Tentacle and Sam & Max Hit the Road — two of the wittiest, most inventive adventure games ever written. Gabriel Knight: Sins of the Fathers brought mature storytelling to the genre. Master of Orion codified 4X strategy. The 7th Guest pushed CD-ROM multimedia. 1993 remains the gold standard year for MS-DOS gaming.",
  },
  1994: {
    blurb:
      "1994 saw MS-DOS gaming operating at its creative and commercial peak. X-COM: UFO Defense by MicroProse delivered a strategy masterpiece blending turn-based tactical combat with base management and a creeping sense of alien menace — it still appears on 'greatest games ever made' lists. System Shock from Looking Glass Technologies pioneered the immersive sim. Doom II expanded the id Software phenomenon. Magic Carpet and Theme Park showed Bullfrog at the height of their powers. DOS had never produced so many excellent games in a single year.",
  },
  1995: {
    blurb:
      "1995 represented the high-water mark of the point-and-click adventure game. LucasArts released Full Throttle, a biker adventure with outstanding voice acting and atmosphere, and The Dig, a cerebral science-fiction epic. Command & Conquer from Westwood Studios brought the real-time strategy genre to a mass mainstream audience. Crusader: No Remorse delivered isometric action with spectacular destructible environments. The year also marked the beginning of DOS gaming's twilight as Windows 95 and DirectX started drawing developers away from the platform.",
  },
  1996: {
    blurb:
      "1996 was MS-DOS gaming's glorious final chapter. id Software's Quake pushed into true 3D and demonstrated what the platform could still achieve. Duke Nukem 3D from 3D Realms became one of the most talked-about games of the decade. Tomb Raider launched a new genre and a new gaming icon. Diablo from Blizzard Entertainment created the action-RPG dungeon-crawler template that the genre still follows. Heroes of Might and Magic II cemented the turn-based strategy series as a modern classic. The games of 1996 were among the finest ever produced for DOS.",
  },
  1997: {
    blurb:
      "1997 marked the end of the MS-DOS era, but it went out with a remarkable final flourish. Fallout from Interplay reinvented the post-apocalyptic RPG with freedom, dark humour and genuine moral complexity — it remains one of the greatest games ever made. Dungeon Keeper from Bullfrog subverted the dungeon game by putting the player in charge of the monsters. Blood from Monolith Productions pushed the Build engine to its gory, atmospheric limits. Age of Empires established the history-themed RTS as a genre staple. By the end of 1997 Windows had taken over, and a remarkable era of PC gaming came to a close.",
  },
};

// Per-genre blurb text shown on genre filter pages
const GENRE_DATA: Record<string, { blurb: string }> = {
  ACTION: {
    blurb:
      "Action games were one of the most popular genres in the MS-DOS era, offering fast-paced, adrenaline-fuelled gameplay that pushed early PC hardware to its limits. From side-scrolling platform shooters to top-down brawlers, DOS action games demanded quick reflexes and sharp timing. Iconic titles like Commander Keen, Duke Nukem, Dangerous Dave and Cosmo's Cosmic Adventure were staples of the shareware scene, often distributed on floppy disks through Apogee Software. If you like your games immediate, kinetic and challenging, DOS action titles deliver.",
  },
  ADVENTURE: {
    blurb:
      "Adventure games defined MS-DOS gaming for an entire generation. LucasArts and Sierra On-Line turned the genre into an art form with classics like The Secret of Monkey Island, King's Quest, Space Quest, Leisure Suit Larry and Gabriel Knight. These point-and-click (and often text-parser) experiences placed storytelling, puzzle-solving and atmosphere above everything else. Many of the best DOS adventure games remain unsurpassed for their wit, writing and world-building — a true golden age for interactive fiction on the PC.",
  },
  RPG: {
    blurb:
      "The MS-DOS era was a golden age for role-playing games. Computer RPGs on DOS ranged from grid-based dungeon crawlers like Wizardry and Might & Magic, to open-world epics like Ultima VII and the early Fallout games. Developers like Origin Systems, New World Computing and Interplay Productions pushed the boundaries of character systems, branching narratives and persistent worlds. Many foundational RPG conventions — experience points, party management, inventory systems — were refined and popularised on DOS machines in the late 1980s and 1990s.",
  },
  STRATEGY: {
    blurb:
      "Strategy games thrived on MS-DOS, benefiting from the keyboard and mouse interface that PCs offered over consoles. Turn-based games like Civilization and Master of Orion offered deep empire-building and diplomacy, while Dune II and Command & Conquer invented and popularised the real-time strategy genre. City-builders like SimCity and Theme Park gave players creative control over virtual worlds. DOS strategy games rewarded patience, planning and long-term thinking — and many of them still feel remarkably modern to play today.",
  },
  SIMULATION: {
    blurb:
      "Simulation games were a cornerstone of MS-DOS gaming culture, attracting players who wanted depth and realism over instant gratification. Flight simulators like Microsoft Flight Simulator and F-19 Stealth Fighter pushed early PC hardware to the limits, while city-builders like SimCity let players shape entire metropolises. Transport and business simulations including Transport Tycoon and Theme Hospital offered complex systems to master. The DOS era proved that a home computer could simulate almost anything — planes, cities, roller coasters, even ant colonies.",
  },
  SPORTS: {
    blurb:
      "Sports games on MS-DOS ranged from arcade-style fun to surprisingly sophisticated simulations. EA Sports built its empire during this era, producing Madden NFL, FIFA Soccer, NHL Hockey and Lakers vs. Celtics — titles that established franchises still running today. Beyond team sports, DOS offered golf sims, boxing games, wrestling titles and even competitive chess programs. Many early DOS sports games translated the feel of their real-world counterparts remarkably well given the hardware constraints of the time.",
  },
  PUZZLE: {
    blurb:
      "Puzzle games on MS-DOS ranged from zen-like spatial challenges to fiendishly clever brain-teasers. The Incredible Machine used Rube Goldberg contraptions to create endlessly creative puzzles, Lemmings tasked players with guiding hapless creatures to safety, and various Tetris clones and Sokoban ports kept players glued to their monitors for hours. DOS puzzle games are some of the most timeless titles in the catalogue — clean mechanics that still feel fresh decades later, with none of the complexity or processing power of modern games needed.",
  },
  HORROR: {
    blurb:
      "Horror games on MS-DOS proved that pixel art and limited sound hardware could still produce genuine dread. Alone in the Dark — widely regarded as the first survival horror game — delivered tension and atmosphere in 1992 that modern horror titles still aspire to. I Have No Mouth and I Must Scream adapted Harlan Ellison's disturbing short story into an unforgettable adventure. Elvira: Mistress of the Dark, Sanitarium and the early Resident Evil precursors showed that horror could be a legitimate genre on PC. DOS horror games rewarded patience and punished recklessness.",
  },
  PLATFORMER: {
    blurb:
      "While consoles had Mario and Sonic, DOS gamers enjoyed a rich library of platform games uniquely suited to the keyboard. Commander Keen by id Software and Jazz Jackrabbit by Epic MegaGames were beloved mascots of the shareware era. Prince of Persia introduced rotoscoped animation and fluid physics that felt revolutionary in 1989. Jill of the Jungle, Hocus Pocus and Cosmo's Cosmic Adventure rounded out a genre packed with creative level design and memorable characters. DOS platformers are a fascinating slice of gaming history that often gets overlooked next to console equivalents.",
  },
  RACING: {
    blurb:
      "Racing games on MS-DOS delivered speed and competition long before 3D graphics became standard. Test Drive put exotic supercars in players' hands in 1987, while Need for Speed arrived in 1994 with stunning (for the time) VGA visuals and licensed cars. IndyCar Racing, Grand Prix Circuit and Stunts offered variety ranging from simulation to arcade chaos. DOS racing games often had to be creative with limited hardware — top-down views, Mode 7-style scaling and clever sprite tricks were all used to convey the sensation of speed on machines measured in megahertz.",
  },
  FIGHTING: {
    blurb:
      "Fighting games were primarily a console genre during the MS-DOS era, but the PC received many notable ports and a handful of excellent exclusives. Mortal Kombat brought its notorious gore and fatalities to PC monitors, Street Fighter II arrived with its iconic cast of world warriors, and One Must Fall: 2097 became a beloved PC-exclusive fighting game that showcased what DOS hardware could do. The genre never reached the same heights on DOS as it did in arcades or on the SNES and Genesis, but the best titles were genuinely great one-on-one combat experiences.",
  },
  SHOOTER: {
    blurb:
      "MS-DOS is where the first-person shooter genre was born. id Software's Wolfenstein 3D in 1992 introduced the world to fast-paced corridor combat, and DOOM in 1993 became a phenomenon that defined PC gaming for years. Quake pushed into true 3D in 1996 while Heretic, Hexen and Blood offered atmospheric alternatives. But DOS shooters were not only first-person — top-down shooters like Tyrian, isometric shooters and side-scrolling shoot-em-ups all flourished on the platform. The shooter genre owes its existence to MS-DOS, and playing the originals remains an essential gaming experience.",
  },
  OTHER: {
    blurb:
      "Not every great MS-DOS game fits neatly into a single genre. The 'Other' category covers the creative outliers — educational software that was secretly a joy to play, early sandbox experiments, strategy-RPG hybrids, pinball simulations, card and board game adaptations, and titles that simply defy easy classification. The DOS era was a time when small teams of developers could take unusual risks, and many of the most interesting games from the 80s and 90s ended up in the gaps between conventional genres. If you enjoy discovering the unexpected corners of gaming history, this is the category for you.",
  },
};

router.get("/", async (req, res, next) => {
  const { genre, search, orderBy, orderDir } = req.query as Record<
    string,
    string
  >;

  if (genre) {
    return res.redirect(`/${genre.toLowerCase()}`);
  }

  if (search && search.length > 100) {
    return next();
  }

  if (orderBy && !VALID_ORDER_BY_FIELDS.includes(orderBy)) {
    return next();
  }

  if (orderDir && !["ASC", "DESC"].includes(orderDir)) {
    return next();
  }

  const page = parseInt(req.query.page as string, 10) || 1;
  const limit = 25;

  const [games, recentNews, featuredGames] = await Promise.all([
    Game.find({ search, page, limit, orderBy, orderDir }),
    News.findRecent(3), // Load recent news only for homepage
    Game.findFeatured(10), // Load 10 random featured games for carousel
  ]);

  // Set canonical URL (without orderBy/orderDir params)
  const canonicalUrl =
    page > 1
      ? `https://oldschoolgames.eu/?page=${page}`
      : "https://oldschoolgames.eu/";
  const prevPageUrl =
    page > 1
      ? page > 2
        ? `https://oldschoolgames.eu/?page=${page - 1}`
        : "https://oldschoolgames.eu/"
      : undefined;
  const nextPageUrl =
    games.length === limit
      ? `https://oldschoolgames.eu/?page=${page + 1}`
      : undefined;

  res.render("index", {
    games,
    limit,
    page,
    recentNews,
    featuredGames,
    canonicalUrl,
    prevPageUrl,
    nextPageUrl,
  });
});

router.get("/about", (req, res) => {
  res.render("about", {
    title: "About - OldSchoolGames.eu",
    description:
      "OldSchoolGames.eu is a hobby project dedicated to preserving and celebrating classic MS-DOS games from the 80s and 90s. Play retro games directly in your browser.",
    canonicalUrl: "https://oldschoolgames.eu/about",
  });
});

router.get("/privacy-policy", (req, res) => {
  res.render("privacy-policy", {
    title: "Privacy Policy - OldSchoolGames.eu",
    description:
      "Privacy Policy for OldSchoolGames.eu — learn how we collect and process your personal data in accordance with GDPR.",
    canonicalUrl: "https://oldschoolgames.eu/privacy-policy",
  });
});

router.get("/dmca", (req, res) => {
  res.render("dmca", {
    title: "DMCA Policy - OldSchoolGames.eu",
    description:
      "DMCA takedown policy for OldSchoolGames.eu. Learn how to submit a copyright infringement notice and how we respond to takedown requests.",
    canonicalUrl: "https://oldschoolgames.eu/dmca",
  });
});

router.get("/how-to-play", (req, res) => {
  res.render("how-to-play", {
    title: "How to Play MS-DOS Games - OldSchoolGames.eu",
    description:
      "New to MS-DOS games? Learn how to play, save, and control classic DOS games in your browser. Tips on keyboard shortcuts, saving progress, and common controls by genre.",
    canonicalUrl: "https://oldschoolgames.eu/how-to-play",
  });
});

router.get("/:genre", async (req, res, next) => {
  const { genre } = req.params;
  const { orderBy, orderDir } = req.query as Record<string, string>;

  const genres: string[] = res.locals.gameGenres ?? (await Game.getGenres());

  if (!genres.includes(genre.toUpperCase())) {
    return next();
  }

  const page = parseInt(req.query.page as string, 10) || 1;
  const limit = 25;

  if (orderBy && !VALID_ORDER_BY_FIELDS.includes(orderBy)) {
    return next();
  }

  if (orderDir && !["ASC", "DESC"].includes(orderDir)) {
    return next();
  }

  const games = await Game.find({ genre, page, limit, orderBy, orderDir });

  const genreTitle =
    genre.charAt(0).toUpperCase() + genre.slice(1).toLowerCase();
  const title = `Classic MS-DOS ${genreTitle} Games – Play Free Online | OldSchoolGames`;
  const description = `Discover the best classic MS-DOS ${genre.toLowerCase()} games from the 80s and 90s. Play authentic retro ${genre.toLowerCase()} games free in your browser with DOSBox — no downloads or installation required.`;

  // Set canonical URL (without orderBy/orderDir params)
  const genreUrl = `https://oldschoolgames.eu/${genre.toLowerCase()}`;
  const canonicalUrl = page > 1 ? `${genreUrl}?page=${page}` : genreUrl;
  const prevPageUrl =
    page > 1
      ? page > 2
        ? `${genreUrl}?page=${page - 1}`
        : genreUrl
      : undefined;
  const nextPageUrl =
    games.length === limit ? `${genreUrl}?page=${page + 1}` : undefined;

  const genreBlurb = GENRE_DATA[genre.toUpperCase()]?.blurb;

  res.render("index", {
    games,
    genre,
    genreBlurb,
    limit,
    page,
    title,
    description,
    canonicalUrl,
    prevPageUrl,
    nextPageUrl,
  });
});

router.get("/letter/:letter", async (req, res, next) => {
  const { letter } = req.params;
  const { orderBy, orderDir } = req.query as Record<string, string>;

  if (!/^[A-Za-z]$/.test(letter)) {
    return next();
  }

  if (orderBy && !VALID_ORDER_BY_FIELDS.includes(orderBy)) {
    return next();
  }

  if (orderDir && !["ASC", "DESC"].includes(orderDir)) {
    return next();
  }

  const page = parseInt(req.query.page as string, 10) || 1;
  const limit = 25;

  const games = await Game.find({ letter, page, limit, orderBy, orderDir });

  // Set canonical URL (without orderBy/orderDir params)
  const letterUrl = `https://oldschoolgames.eu/letter/${letter.toLowerCase()}`;
  const canonicalUrl = page > 1 ? `${letterUrl}?page=${page}` : letterUrl;
  const prevPageUrl =
    page > 1
      ? page > 2
        ? `${letterUrl}?page=${page - 1}`
        : letterUrl
      : undefined;
  const nextPageUrl =
    games.length === limit ? `${letterUrl}?page=${page + 1}` : undefined;

  const L = letter.toUpperCase();
  const topTitles = games
    .slice(0, 4)
    .map((g) => g.title)
    .join(", ");
  const letterDescription =
    topTitles.length > 0
      ? `Classic MS-DOS games starting with '${L}': ${topTitles} and more. Play retro DOS games from the 80s and 90s free in your browser — no downloads required.`
      : `Browse classic MS-DOS games starting with '${L}' from the golden age of PC gaming. Play retro games from the 80s and 90s free in your browser.`;

  res.render("index", {
    games,
    letter,
    limit,
    page,
    title: `MS-DOS Games Starting with '${L}' – Browse & Play Online | OldSchoolGames`,
    description: letterDescription,
    canonicalUrl,
    prevPageUrl,
    nextPageUrl,
  });
});

router.get("/developers", async (req, res) => {
  const developers = await Game.getDevelopers();
  res.render("games/developers", { developers });
});

router.get("/publishers", async (req, res) => {
  const publishers = await Game.getPublishers();
  res.render("games/publishers", { publishers });
});

router.get("/developer/:developer", async (req, res, next) => {
  const { developer } = req.params;
  const { orderBy, orderDir } = req.query as Record<string, string>;

  if (orderBy && !VALID_ORDER_BY_FIELDS.includes(orderBy)) {
    return next();
  }

  if (orderDir && !["ASC", "DESC"].includes(orderDir)) {
    return next();
  }

  const page = parseInt(req.query.page as string, 10) || 1;
  const limit = 25;

  const games = await Game.find({ developer, page, limit, orderBy, orderDir });

  const studioEntry = STUDIO_DATA[developer] ?? null;
  const studioBlurb = studioEntry?.blurb ?? null;
  const title = studioEntry?.title ?? `Games by ${developer} - OldSchoolGames`;
  const description = studioBlurb
    ? studioBlurb.substring(0, 155) + (studioBlurb.length > 155 ? "…" : "")
    : `Explore classic MS-DOS games developed by ${developer}. Play authentic retro games from this legendary developer directly in your browser with DOSBox emulation - no downloads required.`;

  // Set canonical URL (without orderBy/orderDir params)
  const developerUrl = `https://oldschoolgames.eu/developer/${encodeURIComponent(
    developer,
  )}`;
  const canonicalUrl = page > 1 ? `${developerUrl}?page=${page}` : developerUrl;
  const prevPageUrl =
    page > 1
      ? page > 2
        ? `${developerUrl}?page=${page - 1}`
        : developerUrl
      : undefined;
  const nextPageUrl =
    games.length === limit ? `${developerUrl}?page=${page + 1}` : undefined;

  res.render("index", {
    games,
    developer,
    studioBlurb,
    limit,
    page,
    title,
    description,
    canonicalUrl,
    prevPageUrl,
    nextPageUrl,
  });
});

router.get("/publisher/:publisher", async (req, res, next) => {
  const { publisher } = req.params;
  const { orderBy, orderDir } = req.query as Record<string, string>;

  if (orderBy && !VALID_ORDER_BY_FIELDS.includes(orderBy)) {
    return next();
  }

  if (orderDir && !["ASC", "DESC"].includes(orderDir)) {
    return next();
  }

  const page = parseInt(req.query.page as string, 10) || 1;
  const limit = 25;

  const games = await Game.find({ publisher, page, limit, orderBy, orderDir });

  const studioEntry = STUDIO_DATA[publisher] ?? null;
  const studioBlurb = studioEntry?.blurb ?? null;
  const title =
    studioEntry?.title ?? `Games published by ${publisher} - OldSchoolGames`;
  const description = studioBlurb
    ? studioBlurb.substring(0, 155) + (studioBlurb.length > 155 ? "…" : "")
    : `Discover classic MS-DOS games published by ${publisher}. Browse retro games from this publisher, all playable online with DOSBox emulation.`;

  // Set canonical URL (without orderBy/orderDir params)
  const publisherUrl = `https://oldschoolgames.eu/publisher/${encodeURIComponent(
    publisher,
  )}`;
  const canonicalUrl = page > 1 ? `${publisherUrl}?page=${page}` : publisherUrl;
  const prevPageUrl =
    page > 1
      ? page > 2
        ? `${publisherUrl}?page=${page - 1}`
        : publisherUrl
      : undefined;
  const nextPageUrl =
    games.length === limit ? `${publisherUrl}?page=${page + 1}` : undefined;

  res.render("index", {
    games,
    publisher,
    studioBlurb,
    limit,
    page,
    title,
    description,
    canonicalUrl,
    prevPageUrl,
    nextPageUrl,
  });
});

router.get("/years", async (req, res) => {
  const years = await Game.getYears();

  const title = "Game Years - Browse by Release Year - OldSchoolGames";
  const description =
    "Browse classic MS-DOS games by release year from the golden age of PC gaming. Discover retro games from the 80s through the 90s era.";

  res.render("games/years", {
    years,
    title,
    description,
  });
});

router.get("/year/:year", async (req, res, next) => {
  const { year } = req.params;
  const yearNum = parseInt(year, 10);

  if (isNaN(yearNum)) {
    return next();
  }

  const { orderBy, orderDir } = req.query as Record<string, string>;

  const VALID_ORDER_BY_FIELDS = ["title", "rating", "createdAt", "release"];

  if (orderBy && !VALID_ORDER_BY_FIELDS.includes(orderBy)) {
    return next();
  }

  if (orderDir && !["ASC", "DESC"].includes(orderDir)) {
    return next();
  }

  const page = parseInt(req.query.page as string, 10) || 1;
  const limit = 25;

  const [games, allYears] = await Promise.all([
    Game.find({ year: yearNum, page, limit, orderBy, orderDir }),
    Game.getYears(),
  ]);

  // Set canonical URL (without orderBy/orderDir params)
  const yearUrl = `https://oldschoolgames.eu/year/${yearNum}`;
  const canonicalUrl = page > 1 ? `${yearUrl}?page=${page}` : yearUrl;
  const prevPageUrl =
    page > 1 ? (page > 2 ? `${yearUrl}?page=${page - 1}` : yearUrl) : undefined;
  const nextPageUrl =
    games.length === limit ? `${yearUrl}?page=${page + 1}` : undefined;

  const yearBlurb = YEAR_DATA[yearNum]?.blurb ?? null;
  const description = yearBlurb
    ? yearBlurb.substring(0, 155) + (yearBlurb.length > 155 ? "…" : "")
    : `Discover classic MS-DOS games released in ${yearNum}. Play authentic retro games from this year directly in your browser with DOSBox.`;

  res.render("index", {
    games,
    year: yearNum,
    allYears,
    yearBlurb,
    limit,
    page,
    title: `Games from ${yearNum} - OldSchoolGames`,
    description,
    canonicalUrl,
    prevPageUrl,
    nextPageUrl,
  });
});

router.get("/:slug/gallery/:index", async (req, res, next) => {
  const { slug, index } = req.params;
  const currentIndex = parseInt(index, 10);

  if (isNaN(currentIndex)) {
    return next();
  }

  const game = await Game.findBySlug(slug);

  if (!game) {
    return next();
  }

  const validImages = game.images.filter(Boolean);

  if (currentIndex < 0 || currentIndex >= validImages.length) {
    return next();
  }

  const descSnippet = game.description
    ? game.description
        .slice(0, 100)
        .replace(/\s+\S*$/, "")
        .trim()
    : `a classic ${game.genre.toLowerCase()} MS-DOS game by ${game.developer}`;
  const description = `${game.title} screenshot gallery - ${descSnippet}. Browse all screenshots and play ${game.title} for free online on OldSchoolGames.`;

  const image = validImages[currentIndex];

  res.render("games/game-gallery", {
    game,
    currentIndex,
    description,
    image,
    canonicalUrl: `https://oldschoolgames.eu/${game.slug}`,
  });
});

router.get("/:id", async (req, res, next) => {
  const { id } = req.params;

  const game = await (Number.isNaN(Number(id))
    ? Game.findBySlug(id)
    : Game.findById(id));

  if (!game) {
    return next();
  }

  const [comments, similarGames, { prevGame, nextGame }] = await Promise.all([
    Comment.findByGameId(game.id),
    Game.findSimilar(game.id, game.genre, 6),
    Game.findAdjacentGames(game.title),
  ]);

  // Truncate title at word boundary for <title> tag (target ~60 chars total)
  // " - Play Online - OldSchoolGames" = 31 chars, so aim for ~44 chars of game title
  const TITLE_GAME_MAX = 44;
  let shortTitle = game.title;
  if (shortTitle.length > TITLE_GAME_MAX) {
    const cut = shortTitle.substring(0, TITLE_GAME_MAX);
    const lastSpace = cut.lastIndexOf(" ");
    shortTitle = (lastSpace > 10 ? cut.substring(0, lastSpace) : cut) + "…";
  }
  const title = `${shortTitle} - Play Online - OldSchoolGames`;

  // Plain-text game description (strip HTML tags) – used for meta description and LD+JSON
  const rawPlain = game.description
    ? game.description
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";

  // Build meta description – prefer real game text for unique content per page
  let description: string;
  if (rawPlain.length > 30) {
    const maxLen = 155;
    if (rawPlain.length <= maxLen) {
      description = rawPlain;
    } else {
      const cut = rawPlain.substring(0, maxLen);
      const lastSpace = cut.lastIndexOf(" ");
      description = (lastSpace > 50 ? cut.substring(0, lastSpace) : cut) + "…";
    }
  } else {
    // Fallback template when no description is stored in the database
    const gameText = game.genre
      ? `${game.genre.toLowerCase()} game`
      : "MS-DOS game";
    const yearText = game.release ? ` from ${game.release}` : "";
    const devText = game.developer ? ` by ${game.developer}` : "";
    const ending =
      " – play it now in your browser for free. No downloads or installation required!";
    const fixedLen =
      "Play ".length +
      " online. Classic ".length +
      gameText.length +
      yearText.length +
      devText.length +
      ending.length;
    let gameTitle = game.title;
    if (gameTitle.length > 160 - fixedLen) {
      gameTitle = gameTitle.substring(0, 160 - fixedLen - 1) + "…";
    }
    description = `Play ${gameTitle} online. Classic ${gameText}${yearText}${devText}${ending}`;
  }

  const plainDescription = rawPlain || description;

  const image = game.images[0];
  const canonicalUrl = `https://oldschoolgames.eu/${game.slug}`;

  // Build LD+JSON safely (JSON.stringify handles escaping)
  const ldJson: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "VideoGame",
    name: game.title,
    description: plainDescription.slice(0, 500),
    genre: game.genre,
    gamePlatform: ["MS-DOS", "Web browser"],
    operatingSystem: "MS-DOS",
    applicationCategory: "Game",
    playMode: "SinglePlayer",
    url: canonicalUrl,
    image: game.images.filter(Boolean),
    screenshot: game.images.filter(Boolean).map((url) => ({
      "@type": "ImageObject",
      url,
    })),
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
    },
  };
  if (game.release) ldJson.datePublished = String(game.release);
  if (game.updatedAt)
    ldJson.dateModified = new Date(game.updatedAt).toISOString();
  if (game.publisher || game.developer) {
    ldJson.publisher = {
      "@type": "Organization",
      name: game.publisher || game.developer,
    };
  }
  if (game.developer) {
    ldJson.author = { "@type": "Organization", name: game.developer };
  }
  if (
    game.averageRating &&
    game.averageRating > 0 &&
    game.ratingCount &&
    game.ratingCount > 0
  ) {
    ldJson.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: game.averageRating.toFixed(1),
      ratingCount: game.ratingCount,
      bestRating: "5",
      worstRating: "1",
    };
  }

  // BreadcrumbList schema
  const breadcrumbItems: {
    "@type": string;
    position: number;
    name: string;
    item?: string;
  }[] = [
    {
      "@type": "ListItem",
      position: 1,
      name: "Home",
      item: "https://oldschoolgames.eu/",
    },
  ];
  if (game.genre) {
    breadcrumbItems.push({
      "@type": "ListItem",
      position: 2,
      name: `${game.genre.charAt(0) + game.genre.slice(1).toLowerCase()} Games`,
      item: `https://oldschoolgames.eu/${game.genre.toLowerCase()}`,
    });
    breadcrumbItems.push({
      "@type": "ListItem",
      position: 3,
      name: game.title,
    });
  } else {
    breadcrumbItems.push({
      "@type": "ListItem",
      position: 2,
      name: game.title,
    });
  }
  const breadcrumbLdJson = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: breadcrumbItems,
  };

  const keywordParts = [
    game.title,
    "play online",
    "MS-DOS",
    "retro game",
    "old school game",
  ];
  if (game.genre) keywordParts.push(`${game.genre.toLowerCase()} game`);
  if (game.developer) keywordParts.push(game.developer);
  if (game.publisher && game.publisher !== game.developer)
    keywordParts.push(game.publisher);
  if (game.release) keywordParts.push(`${game.release}s games`);
  const keywords = keywordParts.join(", ");

  res.render("games/game-detail", {
    game,
    comments,
    similarGames,
    prevGame,
    nextGame,
    title,
    description,
    keywords,
    image,
    canonicalUrl,
    ldJson,
    breadcrumbLdJson,
  });
});

router.get("/profile", async (req, res) => {
  res.render("profile");
});

export default router;
