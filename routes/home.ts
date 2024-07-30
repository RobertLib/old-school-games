import express from "express";
import Game from "../models/game.ts";
import Comment from "../models/comment.ts";
import GameOfTheWeek from "../models/game-of-the-week.ts";
import News from "../models/news.ts";

const router = express.Router();

const VALID_ORDER_BY_FIELDS = ["createdAt", "release", "rating", "title"];

router.get("/", async (req, res, next) => {
  const gameOfTheWeek = await GameOfTheWeek.getCurrent();
  if (!gameOfTheWeek) {
    await GameOfTheWeek.selectNewGameOfTheWeek();
  }

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

router.get("/:genre", async (req, res, next) => {
  const { genre } = req.params;
  const { orderBy, orderDir } = req.query as Record<string, string>;

  const page = parseInt(req.query.page as string, 10) || 1;
  const limit = 25;

  const genres = await Game.getGenres();

  if (!genres.includes(genre.toUpperCase())) {
    return next();
  }

  if (orderBy && !VALID_ORDER_BY_FIELDS.includes(orderBy)) {
    return next();
  }

  if (orderDir && !["ASC", "DESC"].includes(orderDir)) {
    return next();
  }

  const games = await Game.find({ genre, page, limit, orderBy, orderDir });

  const title = `Games in ${genre} - OldSchoolGames`;
  const description = `Discover classic MS-DOS ${genre.toLowerCase()} games from the 80s and 90s. Play authentic retro games directly in your browser with DOSBox emulation - no downloads required`;

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

  res.render("index", {
    games,
    genre,
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

  res.render("index", {
    games,
    letter,
    limit,
    page,
    title: `Games starting with '${letter.toUpperCase()}' - OldSchoolGames`,
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

  const title = `Games by ${developer} - OldSchoolGames`;
  const description = `Explore classic MS-DOS games developed by ${developer}. Play authentic retro games from this legendary developer in your browser with DOSBox.`;

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

  const title = `Games published by ${publisher} - OldSchoolGames`;
  const description = `Discover classic MS-DOS games published by ${publisher}. Browse retro games from this publisher, all playable online with DOSBox emulation.`;

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

  const games = await Game.find({
    year: yearNum,
    page,
    limit,
    orderBy,
    orderDir,
  });

  // Set canonical URL (without orderBy/orderDir params)
  const yearUrl = `https://oldschoolgames.eu/year/${yearNum}`;
  const canonicalUrl = page > 1 ? `${yearUrl}?page=${page}` : yearUrl;
  const prevPageUrl =
    page > 1 ? (page > 2 ? `${yearUrl}?page=${page - 1}` : yearUrl) : undefined;
  const nextPageUrl =
    games.length === limit ? `${yearUrl}?page=${page + 1}` : undefined;

  res.render("index", {
    games,
    year: yearNum,
    limit,
    page,
    title: `Games from ${yearNum} - OldSchoolGames`,
    description: `Discover classic MS-DOS games released in ${yearNum}. Play authentic retro games from this year directly in your browser with DOSBox.`,
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

  res.render("games/game-gallery", {
    game,
    currentIndex,
  });
});

router.get("/:id", async (req, res, next) => {
  const { id } = req.params;

  const game = await (isNaN(id as unknown as number)
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

  const title = `${game.title.slice(0, 29)} - Play Online - OldSchoolGames`;

  // Create description with 150-160 characters for optimal SEO
  const baseText = "Play ";
  const freeText = " online for free! Classic ";
  const gameText = game.genre
    ? `${game.genre.toLowerCase()} game`
    : "MS-DOS game";
  const yearText = game.release ? ` from ${game.release}` : "";
  const devText = game.developer ? ` by ${game.developer}` : "";
  const ending = " in your browser. No downloads required!";

  // Calculate available space for title
  const fixedPartsLength =
    baseText.length +
    freeText.length +
    gameText.length +
    yearText.length +
    devText.length +
    ending.length;
  const maxTitleLength = 160 - fixedPartsLength;

  // Truncate title if necessary
  let gameTitle = game.title;
  if (gameTitle.length > maxTitleLength) {
    gameTitle = gameTitle.substring(0, maxTitleLength - 3) + "...";
  }

  let description = `${baseText}${gameTitle}${freeText}${gameText}${yearText}${devText}${ending}`;

  // If still too short (under 150), try to expand
  if (description.length < 150) {
    // Try longer ending
    const longerEnding = " in your browser. Authentic retro gaming experience!";
    const testDesc = `${baseText}${gameTitle}${freeText}${gameText}${yearText}${devText}${longerEnding}`;
    if (testDesc.length <= 160) {
      description = testDesc;
    }
  }

  const image = game.images[0];
  const canonicalUrl = `https://oldschoolgames.eu/${game.slug}`;

  res.render("games/game-detail", {
    game,
    comments,
    similarGames,
    prevGame,
    nextGame,
    title,
    description,
    image,
    canonicalUrl,
  });
});

router.get("/profile", async (req, res) => {
  res.render("profile");
});

export default router;
