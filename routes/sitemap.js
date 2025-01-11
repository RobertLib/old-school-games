import express from "express";
import { SitemapStream, streamToPromise } from "sitemap";
import { createGzip } from "zlib";
import Game from "../models/game.js";

const router = express.Router();

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
    const orderByFields = ["title", "createdAt", "release", "rating"];
    const orderDirFields = ["ASC", "DESC"];

    gameGenres.forEach((genre) => {
      smStream.write({
        url: `/${genre.toLowerCase()}`,
        changefreq: "monthly",
        priority: 0.8,
      });

      orderByFields.forEach((orderBy) => {
        orderDirFields.forEach((orderDir) => {
          smStream.write({
            url: `/${genre.toLowerCase()}?orderBy=${orderBy}&orderDir=${orderDir}`,
            changefreq: "monthly",
            priority: 0.8,
          });
        });
      });

      orderDirFields.forEach((orderDir) => {
        smStream.write({
          url: `/${genre.toLowerCase()}?orderDir=${orderDir}`,
          changefreq: "monthly",
          priority: 0.8,
        });
      });
    });

    orderByFields.forEach((orderBy) => {
      orderDirFields.forEach((orderDir) => {
        smStream.write({
          url: `/?orderBy=${orderBy}&orderDir=${orderDir}`,
          changefreq: "monthly",
          priority: 0.8,
        });
      });
    });

    const games = await Game.find();

    games.forEach((game) => {
      smStream.write({
        url: `/${game.slug}`,
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

export default router;
