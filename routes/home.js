import express from "express";
import Game from "../models/game.js";
import Comment from "../models/comment.js";

const router = express.Router();

router.get("/", async (req, res, next) => {
  const games = await Game.findAll();

  res.render("index", { games });
});

router.get("/:genre", async (req, res, next) => {
  const { genre } = req.params;

  const genres = await Game.getGenres();

  if (!genres.includes(genre.toUpperCase())) {
    return next();
  }

  const games = await Game.findByGenre(genre);

  res.render("index", { games });
});

router.get("/:id", async (req, res, next) => {
  const { id } = req.params;

  const game = await Game.findBySlug(id);

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
