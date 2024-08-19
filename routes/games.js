const express = require("express");
const router = express.Router();
const { isAuth } = require("../middlewares/is-auth");
const { isAdmin } = require("../middlewares/is-admin");
const Game = require("../models/game");
const Comment = require("../models/comment");

router.get("/new", isAuth, isAdmin, (req, res) => {
  res.render("games/new-game", { game: null });
});

router.post("/", isAuth, isAdmin, async (req, res, next) => {
  try {
    await Game.create(req.body);

    req.flash("info", "Game created successfully.");

    res.redirect("/");
  } catch (error) {
    next(error);
  }
});

router.get("/:id/edit", isAuth, isAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;

    const game = await Game.findById(id);

    if (!game) {
      return next();
    }

    res.render("games/edit-game", { game });
  } catch (error) {
    next(error);
  }
});

router.post("/:id", isAuth, isAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;

    const game = await Game.update(id, req.body);

    if (!game) {
      return res.status(404).send("Game not found");
    }

    req.flash("info", "Game updated successfully.");

    res.redirect("/");
  } catch (error) {
    next(error);
  }
});

router.post("/:id/delete", isAuth, isAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;

    await Game.delete(id);

    req.flash("info", "Game deleted successfully.");

    res.redirect("/");
  } catch (error) {
    next(error);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const { genre } = req.query;

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
