import express from "express";
import isAuth from "../middlewares/is-auth.js";
import isAdmin from "../middlewares/is-admin.js";
import Game from "../models/game.js";

const router = express.Router();

router.get("/new", isAuth, isAdmin, async (req, res) => {
  const recentlyAddedGames = await Game.findRecentlyAdded();

  res.render("games/new-game", { game: null, recentlyAddedGames });
});

router.post("/", isAuth, isAdmin, async (req, res, next) => {
  await Game.create(req.body);

  req.flash("info", "Game created successfully.");

  res.redirect("/");
});

router.get("/:id/edit", isAuth, isAdmin, async (req, res, next) => {
  const { id } = req.params;

  const game = await Game.findById(id);

  if (!game) {
    return next();
  }

  const recentlyAddedGames = await Game.findRecentlyAdded();

  res.render("games/edit-game", { game, recentlyAddedGames });
});

router.post("/:id", isAuth, isAdmin, async (req, res, next) => {
  const { id } = req.params;

  const game = await Game.update(id, req.body);

  if (!game) {
    return res.status(404).send("Game not found");
  }

  req.flash("info", "Game updated successfully.");

  res.redirect("/");
});

router.post("/:id/delete", isAuth, isAdmin, async (req, res, next) => {
  const { id } = req.params;

  await Game.delete(id);

  req.flash("info", "Game deleted successfully.");

  res.redirect("/");
});

router.get("/:id", async (req, res, next) => {
  res.redirect(`/${req.params.id}`);
});

export default router;
