const express = require("express");
const router = express.Router();
const Game = require("../models/game");
const Comment = require("../models/comment");

router.get("/new", (req, res) => {
  res.render("games/new-game");
});

router.post("/", async (req, res, next) => {
  try {
    const { title, description, stream } = req.body;

    await Game.create({ title, description, stream });

    res.redirect("/");
  } catch (error) {
    next(error);
  }
});

router.get("/:id/edit", async (req, res, next) => {
  try {
    const { id } = req.params;

    const game = await Game.findById(id);

    if (game) {
      res.render("games/edit-game", { game });
    } else {
      res.status(404).send("Game not found");
    }
  } catch (error) {
    next(error);
  }
});

router.post("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, description, stream } = req.body;

    const game = await Game.update(id, { title, description, stream });

    if (game) {
      res.redirect("/");
    } else {
      res.status(404).send("Game not found");
    }
  } catch (error) {
    next(error);
  }
});

router.post("/:id/delete", async (req, res, next) => {
  try {
    const { id } = req.params;

    await Game.delete(id);

    res.redirect("/");
  } catch (error) {
    next(error);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const games = await Game.all();

    res.render("index", { games });
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
      res.render("games/game-detail", { game, comments });
    } else {
      res.status(404).send("Game not found");
    }
  } catch (error) {
    next(error);
  }
});

module.exports = router;
