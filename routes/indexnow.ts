import express from "express";
import isAuth from "../middlewares/is-auth.ts";
import isAdmin from "../middlewares/is-admin.ts";
import IndexNow from "../utils/indexnow.ts";
import Game from "../models/game.ts";

const router = express.Router();

// Route for manual submission of all games to IndexNow
router.post("/indexnow/submit-all", isAuth, isAdmin, async (req, res) => {
  try {
    const games = await Game.find({ limit: 1000 }); // Get all games (max 1000)

    if (!games.length) {
      req.flash("info", "No games found to submit.");
      return res.redirect("/");
    }

    // Create a list of all URLs
    const urls = [
      "/", // Homepage
      "/sitemap-index.xml", // Sitemap
      "/developers",
      "/publishers",
      "/years",
    ];

    // Add URL for each game
    games.forEach((game) => {
      urls.push(`/${game.slug}`);

      if (game.genre) {
        urls.push(`/${game.genre.toLowerCase()}`);
      }

      if (game.developer) {
        urls.push(`/developer/${encodeURIComponent(game.developer)}`);
      }

      if (game.publisher) {
        urls.push(`/publisher/${encodeURIComponent(game.publisher)}`);
      }

      if (game.release) {
        urls.push(`/year/${game.release}`);
      }
    });

    // Add alphabet pages
    const alphabet = "abcdefghijklmnopqrstuvwxyz".split("");
    alphabet.forEach((letter) => {
      urls.push(`/letter/${letter}`);
    });

    // Add genre pages
    const genres = await Game.getGenres();
    genres.forEach((genre) => {
      urls.push(`/${genre.toLowerCase()}`);
    });

    // Submit to IndexNow (in batches of 100 URLs)
    const batchSize = 100;
    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < urls.length; i += batchSize) {
      const batch = urls.slice(i, i + batchSize);
      const result = await IndexNow.submitUrls(batch);

      if (result.success) {
        successCount += batch.length;
      } else {
        errorCount += batch.length;
        console.error(`IndexNow batch failed:`, result.error);
      }
    }

    if (errorCount === 0) {
      req.flash(
        "success",
        `Successfully submitted ${successCount} URLs to IndexNow.`
      );
    } else {
      req.flash(
        "warning",
        `Submitted ${successCount} URLs successfully, ${errorCount} failed.`
      );
    }
  } catch (error) {
    console.error("IndexNow manual submission error:", error);
    req.flash("error", "Failed to submit URLs to IndexNow.");
  }

  res.redirect("/");
});

// Route for submitting specific game to IndexNow
router.post("/indexnow/submit-game/:id", isAuth, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const game = await Game.findById(id);

    if (!game) {
      req.flash("error", "Game not found.");
      return res.redirect("/");
    }

    const result = await IndexNow.submitGameUrls(
      game.slug,
      game.genre,
      game.developer,
      game.publisher,
      game.release || undefined
    );

    if (result.success) {
      req.flash(
        "success",
        `Game "${game.title}" submitted to IndexNow successfully.`
      );
    } else {
      req.flash("error", `Failed to submit game to IndexNow: ${result.error}`);
    }
  } catch (error) {
    console.error("IndexNow game submission error:", error);
    req.flash("error", "Failed to submit game to IndexNow.");
  }

  res.redirect("/");
});

// Route for testing IndexNow configuration
router.post("/indexnow/test", isAuth, isAdmin, async (req, res) => {
  try {
    const result = await IndexNow.submitUrl("/");

    if (result.success) {
      req.flash("success", "IndexNow test successful - homepage submitted.");
    } else {
      req.flash("error", `IndexNow test failed: ${result.error}`);
    }
  } catch (error) {
    console.error("IndexNow test error:", error);
    req.flash("error", "IndexNow test failed.");
  }

  res.redirect("/");
});

export default router;
