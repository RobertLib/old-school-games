const express = require("express");
const router = express.Router();
const { SitemapStream, streamToPromise } = require("sitemap");
const { createGzip } = require("zlib");
const Game = require("../models/game");

router.get("/sitemap.xml", async (req, res, next) => {
  try {
    res.header("Content-Type", "application/xml");
    res.header("Content-Encoding", "gzip");

    const smStream = new SitemapStream({
      hostname: "https://oldschoolgames.eu/",
    });
    const pipeline = smStream.pipe(createGzip());

    smStream.write({ url: "/", changefreq: "monthly", priority: 1.0 });

    const gameGenres = await Game.getGenres();

    gameGenres.forEach((genre) => {
      smStream.write({
        url: `/?genre=${genre}`,
        changefreq: "monthly",
        priority: 0.8,
      });
    });

    const games = await Game.findAll();

    games.forEach((game) => {
      smStream.write({
        url: `/games/${game.slug}`,
        changefreq: "weekly",
        priority: 0.7,
      });
    });

    smStream.end();

    streamToPromise(pipeline)
      .then((sm) => {
        res.send(sm);
      })
      .catch(next);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
