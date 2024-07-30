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

  res.render("index", { games, genre, limit, page });
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

  res.render("index", { games, developer, limit, page });
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

  res.render("index", { games, publisher, limit, page });
});

router.get("/years", async (req, res) => {
  const years = await Game.getYears();

  const title = "Game Years - Browse by Release Year | OldSchoolGames";
  const description =
    "Explore classic MS-DOS games by release year. Find games from specific years in retro gaming history.";

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
    description: `Browse MS-DOS games released in ${yearNum}. Play classic retro games from this year online.`,
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

  const title = `${game.title} - Play Retro MS-DOS Games on OldSchoolGames`;
  const description = `Relive the excitement of ${game.title}, a classic MS-DOS game, available on OldSchoolGames.`;
  const image = game.images[0];

  res.render("games/game-detail", {
    game,
    comments,
    title,
    description,
    image,
  });
});

router.get("/profile", async (req, res) => {
  res.render("profile");
});

export default router;
