import express from "express";
import isAuth from "../middlewares/is-auth.js";
import isAdmin from "../middlewares/is-admin.js";
import Game from "../models/game.js";
import rateLimit from "express-rate-limit";

const router = express.Router();

router.get("/new", isAuth, isAdmin, async (req, res) => {
  res.render("games/new-game", { game: null });
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

  res.render("games/edit-game", { game });
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

const ratingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  message: "Too many ratings from this IP, please try again later.",
});

router.post("/:id/rate", ratingLimiter, async (req, res) => {
  const { id } = req.params;
  const { rating } = req.body;
  const { ip } = req;

  try {
    await Game.rate(id, ip, rating);

    const avarageRating = await Game.getAverageRating(id);

    res.status(200).send({ avarageRating });
  } catch (error) {
    console.error("Error saving rating:", error);
    res.status(500).send("Error saving rating");
  }
});

router.get("/:id", async (req, res, next) => {
  res.redirect(`/${req.params.id}`);
});

export default router;
