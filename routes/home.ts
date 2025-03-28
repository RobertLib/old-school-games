import express from "express";
import Game from "../models/game.ts";
import Comment from "../models/comment.ts";

const router = express.Router();

const VALID_ORDER_BY_FIELDS = ["createdAt", "release", "rating", "title"];

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

export default router;
