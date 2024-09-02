const express = require("express");
const router = express.Router();
const Game = require("../models/game");
const Comment = require("../models/comment");

router.get("/", async (req, res, next) => {
  try {
    const games = await Game.findAll();

    res.render("index", { games });
  } catch (error) {
    next(error);
  }
});

router.get("/:genre", async (req, res, next) => {
  try {
    const { genre } = req.params;

    const genres = await Game.getGenres();

    if (!genres.includes(genre.toUpperCase())) {
      return next();
    }

    const games = await Game.findByGenre(genre);

    res.render("index", { games });
  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
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
  } catch (error) {
    next(error);
  }
});

module.exports = router;
