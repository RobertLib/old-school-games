import express from "express";
import { SitemapStream, streamToPromise } from "sitemap";
import Game from "../models/game.ts";

const router = express.Router();

let sitemap;
let sitemapGeneratedAt;
const SITEMAP_TTL = 24 * 60 * 60 * 1000; // 24 hours

export function clearSitemapCache() {
  sitemap = undefined;
  sitemapGeneratedAt = undefined;
}

router.get("/sitemap-index.xml", async (req, res) => {
  res.header("Content-Type", "application/xml; charset=utf-8");

  const now = Date.now();

  if (sitemap && sitemapGeneratedAt && now - sitemapGeneratedAt < SITEMAP_TTL) {
    res.send(sitemap);
    return;
  }

  try {
    const smStream = new SitemapStream({
      hostname: "https://oldschoolgames.eu",
      xmlns: {
        news: false,
        xhtml: false,
        image: false,
        video: false,
      },
    });

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

    smStream.write({
      url: `/profile`,
      changefreq: "monthly",
      priority: 0.5,
    });

    const alphabet = "abcdefghijklmnopqrstuvwxyz".split("");
    alphabet.forEach((letter) => {
      smStream.write({
        url: `/letter/${letter}`,
        changefreq: "weekly",
        priority: 0.8,
      });
    });

    const [gameGenres, developers, publishers, years, games] =
      await Promise.all([
        Game.getGenres(),
        Game.getDevelopers(),
        Game.getPublishers(),
        Game.getYears(),
        Game.find(),
      ]);

    gameGenres.forEach((genre) => {
      smStream.write({
        url: `/${genre.toLowerCase()}`,
        changefreq: "weekly",
        priority: 0.8,
      });
    });

    developers.forEach((developer) => {
      smStream.write({
        url: `/developer/${encodeURIComponent(developer)}`,
        changefreq: "weekly",
        priority: 0.7,
      });
    });

    publishers.forEach((publisher) => {
      smStream.write({
        url: `/publisher/${encodeURIComponent(publisher)}`,
        changefreq: "weekly",
        priority: 0.7,
      });
    });

    years.forEach((year) => {
      smStream.write({
        url: `/year/${year}`,
        changefreq: "weekly",
        priority: 0.7,
      });
    });

    games.forEach((game) => {
      const lastmod = game.updatedAt
        ? new Date(game.updatedAt).toISOString().split("T")[0]
        : new Date().toISOString().split("T")[0];

      smStream.write({
        url: `/${game.slug}`,
        changefreq: "monthly",
        priority: 0.7,
        lastmod,
      });
    });

    smStream.end();

    const generatedSitemap = await streamToPromise(smStream);
    sitemap = generatedSitemap;
    sitemapGeneratedAt = now;

    res.send(sitemap);
  } catch (error) {
    console.error("Sitemap generation error:", error);
    res
      .status(500)
      .header("Content-Type", "text/plain")
      .send("Sitemap temporarily unavailable");
  }
});

export default router;
