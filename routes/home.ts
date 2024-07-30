import express from "express";
import Game from "../models/game.ts";
import Comment from "../models/comment.ts";
import GameOfTheWeek from "../models/game-of-the-week.ts";

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

  const games = await Game.find({ search, page, limit, orderBy, orderDir });

  res.render("index", { games, limit, page });
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

  res.render("index", { games, genre, limit, page, title, description });
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
  const canonicalUrl = `https://oldschoolgames.eu/letter/${letter.toLowerCase()}`;

  res.render("index", {
    games,
    letter,
    limit,
    page,
    title: `Games starting with '${letter.toUpperCase()}' - OldSchoolGames`,
    canonicalUrl,
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

  res.render("index", { games, developer, limit, page, title, description });
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

  res.render("index", { games, publisher, limit, page, title, description });
});

router.get("/years", async (req, res) => {
  const years = await Game.getYears();

  const title = "Game Years - Browse by Release Year | OldSchoolGames";
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

  res.render("index", {
    games,
    year: yearNum,
    limit,
    page,
    title: `Games from ${yearNum} - OldSchoolGames`,
    description: `Discover classic MS-DOS games released in ${yearNum}. Play authentic retro games from this year directly in your browser with DOSBox.`,
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

  const comments = await Comment.findByGameId(game.id);
  const similarGames = await Game.findSimilar(game.id, game.genre, 6);

  const title = `${game.title.slice(0, 29)} - Play Online | OldSchoolGames`;

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

  res.render("games/game-detail", {
    game,
    comments,
    similarGames,
    title,
    description,
    image,
  });
});

router.get("/profile", async (req, res) => {
  res.render("profile");
});

export default router;
