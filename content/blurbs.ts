/**
 * The hand-written copy behind the filter pages: a paragraph per studio, per
 * year and per genre, plus the occasional <title> override for a studio whose
 * name collides with a modern brand.
 *
 * It lived at the top of routes/home.ts, where seven hundred lines of prose
 * sat above three hundred lines of routing and made the file look far more
 * complicated than it is. None of it is logic — a page reads its own entry and
 * falls back to a generated sentence when there is none — so it belongs
 * beside the content rather than in the router.
 */

// Per-studio metadata: blurb text shown on filter pages + optional title override
// (used when the studio name clashes with a modern brand or the default title performs poorly).
export const STUDIO_DATA: Record<string, { blurb: string; title: string }> = {
  "id Software": {
    title:
      "id Software DOS Games – Doom, Quake & More | OldSchoolGames",
    blurb:
      "id Software is the legendary Texas-based studio founded in 1991 by John Carmack and John Romero. They pioneered the first-person shooter genre with Wolfenstein 3D, Doom and Quake, and their game engine technology — including the Quake engine — shaped PC gaming throughout the 1990s. Doom in particular became a cultural phenomenon, defining multiplayer deathmatches and the modding community.",
  },
  LucasArts: {
    title:
      "LucasArts DOS Games – Monkey Island & More | OldSchoolGames",
    blurb:
      "LucasArts (originally Lucasfilm Games) was the games division of George Lucas's company, active from 1982 to 2013. During the late 1980s and 1990s they produced some of the greatest adventure games ever made: The Secret of Monkey Island, Grim Fandango, Day of the Tentacle, Sam & Max Hit the Road, Indiana Jones and the Fate of Atlantis, and the SCUMM-engine classics that defined point-and-click gaming.",
  },
  MicroProse: {
    title:
      "MicroProse DOS Games – Civilization & X-COM | OldSchoolGames",
    blurb:
      "MicroProse was founded in 1982 by Sid Meier and Bill Stealey. The studio became synonymous with deep simulation and strategy games — Civilization, Railroad Tycoon, X-COM: UFO Defense, Colonization, F-19 Stealth Fighter and Gunship. Their titles consistently rewarded patience and strategic thinking, making them cornerstones of MS-DOS gaming throughout the late 1980s and 1990s.",
  },
  "Westwood Studios": {
    title:
      "Westwood Studios DOS Games – Dune II & More | OldSchoolGames",
    blurb:
      "Westwood Studios, based in Las Vegas, was founded in 1985 and is best known for inventing the real-time strategy genre with Dune II: The Building of a Dynasty in 1992. They followed it with the Command & Conquer series and the Lands of Lore and Legend of Kyrandia RPG series. Electronic Arts acquired and eventually closed the studio in 2003.",
  },
  "Apogee Software": {
    title:
      "Apogee Software DOS Games – Commander Keen | OldSchoolGames",
    blurb:
      "Apogee Software (later 3D Realms) pioneered the shareware distribution model for PC games in the late 1980s and early 1990s. They published Commander Keen, Blake Stone, Duke Nukem, Wolfenstein 3D (with id Software), and Rise of the Triad. Their strategy of releasing the first episode for free and selling the rest helped establish PC gaming as a mainstream hobby.",
  },
  "3D Realms": {
    title:
      "3D Realms DOS Games – Duke Nukem 3D & More | OldSchoolGames",
    blurb:
      "3D Realms, the successor brand to Apogee Software, is best known for publishing and co-developing Duke Nukem 3D in 1996 — one of the most influential first-person shooters of its era. The studio also published Terminal Velocity, Shadow Warrior and many other classic DOS titles throughout the 1990s.",
  },
  "Sierra On-Line": {
    title:
      "Sierra On-Line DOS Games – King's Quest | OldSchoolGames",
    blurb:
      "Sierra On-Line was founded by Ken and Roberta Williams in 1979 and became one of the most prolific adventure game studios of all time. Their King's Quest, Space Quest, Police Quest, Leisure Suit Larry, Gabriel Knight and Quest for Glory series defined graphic adventure games for an entire generation of PC gamers.",
  },
  "Epic Games": {
    title:
      "Epic MegaGames DOS Games – Jazz Jackrabbit | OldSchoolGames",
    blurb:
      "Epic Games (originally Epic MegaGames) began as a shareware publisher in the early 1990s, distributing titles like Epic Pinball, Jill of the Jungle, Jazz Jackrabbit and One Must Fall: 2097. Jazz Jackrabbit in particular became hugely popular as a fast-paced DOS platformer. The studio later shifted to developing the Unreal engine and the Unreal Tournament series.",
  },
  "Virgin Interactive": {
    title:
      "Virgin Interactive DOS Games – Dune & More | OldSchoolGames",
    blurb:
      "Virgin Interactive Entertainment was the games label of Richard Branson's Virgin Group, active throughout the 1980s and 1990s. They published and co-developed a wide range of titles including The 7th Guest, Dune (the adventure game), Cool Spot, Aladdin (the Sega/PC version) and numerous licensed movie tie-in games.",
  },
  "Interplay Productions": {
    title:
      "Interplay Productions DOS Games – Fallout | OldSchoolGames",
    blurb:
      "Interplay Productions, founded by Brian Fargo in 1983, was responsible for some of the most celebrated RPGs and action games of the DOS era. Their catalogue includes Fallout, Wasteland, Baldur's Gate (published), Star Trek games, Battle Chess and the MDK series. Interplay was known for pushing narrative depth and production values in PC games.",
  },
  "Delphine Software": {
    title:
      "Delphine Software DOS Games – Flashback | OldSchoolGames",
    blurb:
      "Delphine Software was a French studio known for cinematic storytelling and fluid animation in their MS-DOS games. Their most iconic titles include Another World (Out of This World), Flashback: The Quest for Identity, and Operation Stealth. Another World in particular is considered one of the most artistically significant games of the early 1990s.",
  },
  Broderbund: {
    title:
      "Broderbund DOS Games – Prince of Persia | OldSchoolGames",
    blurb:
      "Broderbund Software was founded in 1980 and is best known for publishing Prince of Persia, Carmen Sandiego, Myst and Lode Runner. Prince of Persia, programmed by Jordan Mechner using rotoscoped animation, became an instant classic and one of the defining platform games of the MS-DOS era.",
  },
  Accolade: {
    title:
      "Accolade DOS Games – Test Drive & More | OldSchoolGames",
    blurb:
      "Accolade was an American game developer and publisher active from 1984 to 2004. They are best remembered for the Test Drive racing series, the Hardball! baseball series, Star Control and the Bubsy platform games. Their Test Drive series brought realistic car simulation to home computers in the late 1980s.",
  },
  "Blizzard Entertainment": {
    title:
      "Blizzard Entertainment DOS Games – Warcraft | OldSchoolGames",
    blurb:
      "Blizzard Entertainment (originally Silicon & Synapse) was founded in 1991 and became one of the most celebrated studios of the 1990s. Their DOS-era catalogue includes The Lost Vikings, Rock n' Roll Racing, Warcraft: Orcs & Humans, Warcraft II: Tides of Darkness and the original Diablo — a dungeon crawler that redefined the action-RPG genre and whose gothic atmosphere still resonates today.",
  },
  "Origin Systems": {
    title:
      "Origin Systems DOS Games – Ultima & More | OldSchoolGames",
    blurb:
      'Origin Systems was founded by Richard Garriott in 1983 and operated under the motto "We Create Worlds." They are best known for the Ultima series of role-playing games and the Wing Commander space combat series, both of which set benchmarks for storytelling and production values in PC gaming. Electronic Arts acquired the studio in 1992.',
  },
  "Electronic Arts": {
    title:
      "Electronic Arts DOS Games – FIFA & Bullfrog | OldSchoolGames",
    blurb:
      "Electronic Arts was founded by Trip Hawkins in 1982 and became one of the most influential publishers of the MS-DOS era. They released a wide range of sports simulations, action titles and strategy games, and published work from studios such as Bullfrog Productions, Origin Systems, Westwood Studios and Maxis. Their sports franchises — including FIFA, NBA Live and Madden — became staples of 1990s PC gaming.",
  },
  Psygnosis: {
    title:
      "Psygnosis DOS Games – Lemmings & More | OldSchoolGames",
    blurb:
      "Psygnosis was a British studio founded in 1984 and is best remembered for co-developing Lemmings — one of the most commercially successful and widely ported puzzle games of all time. They also produced Shadow of the Beast, Obliterator and many other Amiga and DOS titles known for pushing graphical limits. Sony acquired the studio in 1993.",
  },
  Maxis: {
    title:
      "Maxis DOS Games – SimCity, SimEarth & More | OldSchoolGames",
    blurb:
      "Maxis was founded by Will Wright and Jeff Braun in 1987 and is the studio behind SimCity — the game that established the city-builder genre and inspired a generation of simulation games. They followed it with SimEarth, SimAnt, SimCity 2000 and The Sims. Their games consistently encouraged creative problem-solving over win conditions.",
  },
  "New World Computing": {
    title:
      "New World Computing DOS Games | OldSchoolGames",
    blurb:
      "New World Computing was founded in 1984 and is best known for the Might and Magic RPG series and its spin-off Heroes of Might and Magic, a turn-based strategy series that became a cornerstone of the genre. The combination of deep exploration, dungeon crawling and tactical combat made their games enduringly popular throughout the MS-DOS era.",
  },
  "Core Design": {
    title:
      "Core Design DOS Games – Tomb Raider & More | OldSchoolGames",
    blurb:
      "Core Design was a British studio founded in 1988, best known for creating Tomb Raider in 1996 — a 3D action-adventure game that made Lara Croft one of gaming's most recognisable characters. Before Tomb Raider they produced Chuck Rock, Thunderhawk and several well-regarded Amiga and DOS titles.",
  },
  "DMA Design": {
    title:
      "DMA Design DOS Games – Lemmings & More | OldSchoolGames",
    blurb:
      "DMA Design was a Scottish studio founded by David Jones in 1987. They created Lemmings in 1991 — one of the best-selling and most ported games of all time — and went on to develop Body Harvest and the original Grand Theft Auto. Their ability to originate entirely new genres made them one of the most inventive studios of the DOS era.",
  },
  "Blue Byte": {
    title:
      "Blue Byte DOS Games – The Settlers & More | OldSchoolGames",
    blurb:
      "Blue Byte was a German studio founded in 1988, best known for The Settlers series — city-building strategy games with detailed resource chains and charming visuals that set the standard for the genre. They also developed the Battle Isle series of turn-based strategy games, building a loyal following throughout the 1990s.",
  },
  "Raven Software": {
    title:
      "Raven Software DOS Games – Heretic & Hexen | OldSchoolGames",
    blurb:
      "Raven Software was founded in 1990 and built their reputation developing games on id Software's engines. Using the Doom engine they created Heretic in 1994 and Hexen: Beyond Heretic in 1995 — dark fantasy shooters that significantly expanded what the engine could do. They later collaborated with id on Quake mission packs and developed Jedi Knight II.",
  },
  "Bethesda Softworks": {
    title:
      "Bethesda Softworks DOS Games – Daggerfall | OldSchoolGames",
    blurb:
      "Bethesda Softworks was founded in 1986 by Christopher Weaver and launched The Elder Scrolls series with Arena in 1994, followed by the vast open world of Daggerfall in 1996. These ambitious first-person RPGs let players explore enormous hand-crafted worlds with near-total freedom, establishing the template for the open-world RPG genre.",
  },

  // The studios below were the gap this file had: every name here fronts a
  // /developer or /publisher page holding three games or more, and each of
  // those pages was running on the generated fallback sentence in
  // routes/home.ts — one sentence shared between them, differing only in the
  // name it interpolated. That is exactly the near-duplicate description a
  // paginated set is guarded against elsewhere, and it was being served on
  // the deepest, most specific pages on the site.
  //
  // Three is where the line was drawn, and it is a judgement rather than a
  // rule: below it a page is a handful of covers, the fallback sentence says
  // as much as there is to say, and a paragraph written to fill the space
  // would be filler in the literal sense. The catalogue holds 202 distinct
  // studio pages; 159 of them have one or two games. If one of those grows,
  // it earns an entry here then.
  "U.S. Gold": {
    title:
      "U.S. Gold DOS Games – Strider & More | OldSchoolGames",
    blurb:
      "U.S. Gold was a British publisher founded in Birmingham in 1984 by Geoff Brown, named for its original business of bringing American games to European buyers. It grew into one of the largest publishers on the continent, handling arcade conversions such as Strider and Out Run alongside licensed tie-ins and its Indiana Jones and Street Fighter releases. Much of what European PC owners played in the late 1980s and early 1990s reached them through U.S. Gold.",
  },
  Dynamix: {
    title:
      "Dynamix DOS Games – Red Baron & More | OldSchoolGames",
    blurb:
      "Dynamix was an Oregon studio founded in 1984 by Jeff Tunnell and Damon Slye, and acquired by Sierra On-Line in 1990. It built its reputation on flight simulation — Red Baron, A-10 Tank Killer and Aces of the Pacific — while also producing the puzzle series The Incredible Machine and the acclaimed RPG Betrayal at Krondor. Few studios of the era moved so comfortably between simulation, puzzle design and storytelling.",
  },
  "Strategic Simulations": {
    title:
      "Strategic Simulations (SSI) DOS Games | OldSchoolGames",
    blurb:
      "Strategic Simulations, universally known as SSI, was founded in California in 1979 by Joel Billings and began as a publisher of serious computer wargames. Its Advanced Dungeons & Dragons licence produced the Gold Box RPGs — Pool of Radiance, Curse of the Azure Bonds and the Krynn series — which brought tabletop rules to the PC with unusual fidelity. SSI returned to its wargaming roots with Panzer General in 1994.",
  },
  "Ocean Software": {
    title:
      "Ocean Software DOS Games – RoboCop & More | OldSchoolGames",
    blurb:
      "Ocean Software was founded in Manchester in 1983 by David Ward and Jon Woods and grew into one of Europe's biggest publishers. It specialised in licensed adaptations — RoboCop, Batman, The Addams Family and Jurassic Park among them — and in arcade conversions, turning film and coin-op tie-ins around at a pace few rivals could match. For a generation of European players the Ocean logo was the most familiar sight on a game box.",
  },
  "Bullfrog Productions": {
    title:
      "Bullfrog DOS Games – Populous & Syndicate | OldSchoolGames",
    blurb:
      "Bullfrog Productions was founded in Guildford in 1987 by Peter Molyneux and Les Edgar, and was acquired by Electronic Arts in 1995. Populous invented the god game in 1989, and the studio kept on inventing: Powermonger, Syndicate, Theme Park, Magic Carpet and Dungeon Keeper each took a genre that did not previously exist and made it sell. Bullfrog's run of original ideas is among the most remarkable of the period.",
  },
  "GT Interactive": {
    title:
      "GT Interactive DOS Games – Doom II & More | OldSchoolGames",
    blurb:
      "GT Interactive was a New York publisher founded in 1993 out of the home-video business GoodTimes Entertainment. Its breakthrough was putting id Software's Doom II into American retail stores in 1994 — a shareware phenomenon sold in a box — and it went on to publish Hexen, the retail Duke Nukem 3D and Unreal. GT proved that the shareware shooters of the early 1990s had a mass-market audience waiting for them.",
  },
  "MPS Labs": {
    title:
      "MPS Labs DOS Games – Civilization & More | OldSchoolGames",
    blurb:
      "MPS Labs — MicroProse Software Labs — was the in-house development team of MicroProse, and the name credited on the games the company made itself rather than those it published for others. Sid Meier's Civilization, Railroad Tycoon and a long line of flight simulations carry it. A game credited to MPS Labs is MicroProse at its most characteristic: systems-heavy, deep, and built to be played again from the start.",
  },
  "The Bitmap Brothers": {
    title:
      "Bitmap Brothers DOS Games – Speedball 2 | OldSchoolGames",
    blurb:
      "The Bitmap Brothers were founded in London in 1987 by Mike Montgomery, Eric Matthews and Steve Kelly, and were among the first developers treated as personalities in their own right. Speedball 2: Brutal Deluxe, Xenon 2 Megablast, Gods and The Chaos Engine share a hard-edged metallic art style and a precision of control that made the studio instantly recognisable. Their presentation influenced European game design well beyond their own catalogue.",
  },
  "Coktel Vision": {
    title:
      "Coktel Vision DOS Games – Gobliiins | OldSchoolGames",
    blurb:
      "Coktel Vision was a French studio founded in 1984 by Roland Oskian and acquired by Sierra On-Line in 1992. It is best remembered for the Gobliiins puzzle-adventure trilogy, whose three-goblin party mechanic and surreal humour made it unlike anything else on the PC, and for adventures such as Ween: The Prophecy, Inca and Lost in Time. The studio also produced a substantial line of educational software in France.",
  },
  "Digital Image Design": {
    title:
      "Digital Image Design DOS Games – TFX | OldSchoolGames",
    blurb:
      "Digital Image Design was a British studio founded in 1989 by Martin Kenwright, specialising in flight simulation built on 3D technology it wrote itself. F29 Retaliator, Epic, TFX and EF2000 pushed polygon rendering further than most contemporaries managed on the same hardware. The studio's simulations were known for pairing a convincing flight model with visuals that were genuinely ahead of the curve.",
  },
  Infogrames: {
    title:
      "Infogrames DOS Games – Alone in the Dark | OldSchoolGames",
    blurb:
      "Infogrames was founded in Lyon in 1983 and became the largest French publisher of the era, eventually acquiring the Atari name outright. Its defining release was Alone in the Dark in 1992, which set polygonal characters against pre-rendered backdrops and effectively invented survival horror — the template Resident Evil followed four years later. The company published widely across adventure and action genres throughout the DOS years.",
  },
  Mindscape: {
    title:
      "Mindscape DOS Games – Captive & More | OldSchoolGames",
    blurb:
      "Mindscape was founded in Illinois in 1983 by Roger Buoy and published an unusually varied catalogue across the MS-DOS years. Its range ran from the strategic Balance of Power and the MacVenture adventures Déjà Vu and Shadowgate to the procedurally generated dungeon crawler Captive and the action game Moonstone. Mindscape was a publisher willing to back ideas that did not fit neatly onto an existing shelf.",
  },
  Silmarils: {
    title:
      "Silmarils DOS Games – Ishar & More | OldSchoolGames",
    blurb:
      "Silmarils was a French studio founded in 1987 and known for RPGs and adventures with a distinctly European sensibility. The Ishar trilogy grew out of its earlier Crystals of Arborea and gave the party-based RPG an unusual wrinkle — companions who could refuse an order, quarrel among themselves or desert outright. The studio also produced Transarctica, Robinson's Requiem and Deus, each built around an idea rather than a formula.",
  },
  Ubisoft: {
    title:
      "Ubisoft DOS Games – Rayman & More | OldSchoolGames",
    blurb:
      "Ubisoft was founded in Brittany in 1986 by the five Guillemot brothers, starting as a distributor before moving into publishing and development of its own. Its DOS-era catalogue is the foundation of what became one of the largest publishers in the world, and Rayman in 1995 gave it a character-led franchise to build on. The company's early growth came from reaching across a European market that was still deeply fragmented.",
  },
  Activision: {
    title:
      "Activision DOS Games – MechWarrior 2 | OldSchoolGames",
    blurb:
      "Activision was founded in California in 1979 by four Atari programmers who wanted credit for the games they wrote — the first third-party developer, and the reason developers are named on boxes at all. By the MS-DOS era it had absorbed Infocom and was publishing across genres, with MechWarrior 2 and Return to Zork among its better-known releases. Its founding argument about authorship reshaped the industry's economics permanently.",
  },
  "Distinctive Software": {
    title:
      "Distinctive Software DOS Games – Stunts | OldSchoolGames",
    blurb:
      "Distinctive Software was a Canadian studio founded in Burnaby, British Columbia in 1982, and was bought by Electronic Arts in 1991 to become EA Canada. It specialised in driving games — Test Drive, The Duel: Test Drive II, Grand Prix Circuit and the track-building Stunts, released in some territories as 4D Sports Driving. Stunts outlived its era entirely, sustained for decades by a community designing and sharing its own circuits.",
  },
  "Gremlin Interactive": {
    title:
      "Gremlin Interactive DOS Games – Zool | OldSchoolGames",
    blurb:
      "Gremlin was founded in Sheffield in 1984 as Gremlin Graphics by Ian Stewart and Kevin Norburn, taking the name Gremlin Interactive in the mid-1990s. Its catalogue ran from the platformer Zool and the Lotus racing series to the long-lived Premier Manager football management games and the strategy title Realms. It was among the most prolific British developers of the period, and published other studios' work alongside its own.",
  },
  "Image Works": {
    title:
      "Image Works DOS Games – Xenon 2 & More | OldSchoolGames",
    blurb:
      "Image Works was the label Mirrorsoft launched in 1988 for its more ambitious and adult-oriented releases, keeping them distinct from the family titles sold under the parent name. It carried several Bitmap Brothers games — Speedball, Xenon 2 Megablast and Cadaver — alongside Bombuzal and The Killing Game Show. The label did not survive Mirrorsoft's collapse in 1991, but its short catalogue is disproportionately well remembered.",
  },
  Taito: {
    title:
      "Taito DOS Games – Bubble Bobble & More | OldSchoolGames",
    blurb:
      "Taito is a Japanese company founded in Tokyo in 1953 and one of the defining forces of the arcade era. Space Invaders triggered a worldwide boom in 1978, and the catalogue that followed — Bubble Bobble, Arkanoid, Rainbow Islands and Operation Wolf — was ported to home computers throughout the 1980s and early 1990s. The DOS conversions here are how most PC owners met games that began life in a coin-op cabinet.",
  },
  Team17: {
    title:
      "Team17 DOS Games – Worms & Alien Breed | OldSchoolGames",
    blurb:
      "Team17 was formed in Wakefield in 1990 from the merger of the developer Team 7 and the publisher 17-Bit Software. It made its name on the Amiga with the Alien Breed shooters, Superfrog and Body Blows before Worms arrived in 1995 — a turn-based artillery game whose mix of tactics and slapstick became a franchise that is still running. It is one of the very few studios of the era still independent and active today.",
  },
};

// Per-year blurb text shown on /year/:year pages
export const YEAR_DATA: Record<number, { blurb: string }> = {
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
export const GENRE_DATA: Record<string, { blurb: string }> = {
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
