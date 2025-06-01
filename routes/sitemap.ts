import express from "express";
import { SitemapStream, streamToPromise } from "sitemap";
import { createGzip } from "zlib";
import Game from "../models/game.ts";

const router = express.Router();

let sitemap;
let sitemapGeneratedAt;
const SITEMAP_TTL = 24 * 60 * 60 * 1000; // 24 hours

router.get("/sitemap.xml", async (req, res) => {
  res.header("Content-Type", "application/xml");
  res.header("Content-Encoding", "gzip");

  const now = Date.now();

  if (sitemap && sitemapGeneratedAt && now - sitemapGeneratedAt < SITEMAP_TTL) {
    res.send(sitemap);
    return;
  }

  try {
    const smStream = new SitemapStream({
      hostname: "https://oldschoolgames.eu/",
    });
    const pipeline = smStream.pipe(createGzip());

    smStream.write({ url: "/", changefreq: "daily", priority: 1.0 });

    smStream.write({
      url: `/developers`,
      changefreq: "weekly",
      priority: 0.8,
    });

    smStream.write({
      url: `/publishers`,
      changefreq: "weekly",
      priority: 0.8,
    });

    smStream.write({
      url: `/years`,
      changefreq: "weekly",
      priority: 0.8,
    });

    const alphabet = "abcdefghijklmnopqrstuvwxyz".split("");
    alphabet.forEach((letter) => {
      smStream.write({
        url: `/letter/${letter}`,
        changefreq: "weekly",
        priority: 0.8,
      });
    });

    const gameGenres = await Game.getGenres();
    gameGenres.forEach((genre) => {
      smStream.write({
        url: `/${genre.toLowerCase()}`,
        changefreq: "weekly",
        priority: 0.8,
      });
    });

    const developers = await Game.getDevelopers();
    developers.forEach((developer) => {
      smStream.write({
        url: `/developer/${encodeURIComponent(developer)}`,
        changefreq: "weekly",
        priority: 0.7,
      });
    });

    const publishers = await Game.getPublishers();
    publishers.forEach((publisher) => {
      smStream.write({
        url: `/publisher/${encodeURIComponent(publisher)}`,
        changefreq: "weekly",
        priority: 0.7,
      });
    });

    const years = await Game.getYears();
    years.forEach((year) => {
      smStream.write({
        url: `/year/${year}`,
        changefreq: "weekly",
        priority: 0.7,
      });
    });

    const games = await Game.find();
    games.forEach((game) => {
      smStream.write({
        url: `/${game.slug}`,
        changefreq: "monthly",
        priority: 0.7,
        lastmod: new Date(game.updatedAt).toISOString().split("T")[0],
      });
    });

    streamToPromise(pipeline).then((sm) => (sitemap = sm));

    smStream.end();

    sitemapGeneratedAt = now;

    pipeline.pipe(res).on("error", (error) => {
      throw error;
    });
  } catch (error) {
    console.error(error);
    res.status(500).end();
  }
});

export default router;
