const express = require("express");
const router = express.Router();
const { SitemapStream, streamToPromise } = require("sitemap");
const { createGzip } = require("zlib");
const Game = require("../models/game");

let sitemap;

router.get("/sitemap.xml", async (req, res) => {
  res.header("Content-Type", "application/xml");
  res.header("Content-Encoding", "gzip");

  if (sitemap) {
    res.send(sitemap);
    return;
  }

  try {
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

    streamToPromise(pipeline).then((sm) => (sitemap = sm));

    smStream.end();

    pipeline.pipe(res).on("error", (error) => {
      throw error;
    });
  } catch (error) {
    console.error(error);
    res.status(500).end();
  }
});

module.exports = router;
