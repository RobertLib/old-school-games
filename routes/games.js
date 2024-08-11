const express = require("express");
const router = express.Router();
const { isAuth } = require("../middlewares/is-auth");
const { isAdmin } = require("../middlewares/is-admin");
const Game = require("../models/game");
const Comment = require("../models/comment");

router.get("/new", isAuth, isAdmin, (req, res) => {
  res.render("games/new-game", {
    game: null,
    genres: Game.GENRES,
    session: req.session,
  });
});

router.post("/", isAuth, isAdmin, async (req, res, next) => {
  try {
    const { title, description, genre, images, stream } = req.body;

    await Game.create({ title, description, genre, images, stream });

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

    if (game) {
      res.render("games/edit-game", {
        game,
        genres: Game.GENRES,
        session: req.session,
      });
    } else {
      res.status(404).send("Game not found");
    }
  } catch (error) {
    next(error);
  }
});

router.post("/:id", isAuth, isAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, description, genre, images, stream } = req.body;

    const game = await Game.update(id, {
      title,
      description,
      genre,
      images,
      stream,
    });

    if (game) {
      req.flash("info", "Game updated successfully.");

      res.redirect("/");
    } else {
      res.status(404).send("Game not found");
    }
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

    res.render("index", {
      games,
      genre,
      genres: Game.GENRES,
      message: req.flash("info"),
      session: req.session,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;

    const game = await Game.findById(id);
    const comments = await Comment.findByGameId(id);

    if (game) {
      res.render("games/game-detail", {
        game,
        genres: Game.GENRES,
        comments,
        session: req.session,
      });
    } else {
      res.status(404).send("Game not found");
    }
  } catch (error) {
    next(error);
  }
});

module.exports = router;
