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
    const LIMIT = 25; // Same limit as used in routes

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

    // Add paginated pages for main index
    const totalGamesCount = await Game.count();
    const totalPages = Math.ceil(totalGamesCount / LIMIT);

    for (let page = 2; page <= totalPages; page++) {
      smStream.write({
        url: `/?page=${page}`,
        changefreq: "daily",
        priority: 0.8,
      });
    }

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
    for (const letter of alphabet) {
      smStream.write({
        url: `/letter/${letter}`,
        changefreq: "weekly",
        priority: 0.8,
      });

      // Add paginated pages for letter
      const letterCount = await Game.count({ letter });
      const letterPages = Math.ceil(letterCount / LIMIT);

      for (let page = 2; page <= letterPages; page++) {
        smStream.write({
          url: `/letter/${letter}?page=${page}`,
          changefreq: "weekly",
          priority: 0.7,
        });
      }
    }

    const [gameGenres, developers, publishers, years, games] =
      await Promise.all([
        Game.getGenres(),
        Game.getDevelopers(),
        Game.getPublishers(),
        Game.getYears(),
        Game.find(),
      ]);

    for (const genre of gameGenres) {
      smStream.write({
        url: `/${genre.toLowerCase()}`,
        changefreq: "weekly",
        priority: 0.8,
      });

      // Add paginated pages for genre
      const genreCount = await Game.count({ genre: genre.toLowerCase() });
      const genrePages = Math.ceil(genreCount / LIMIT);

      for (let page = 2; page <= genrePages; page++) {
        smStream.write({
          url: `/${genre.toLowerCase()}?page=${page}`,
          changefreq: "weekly",
          priority: 0.7,
        });
      }
    }

    for (const developer of developers) {
      smStream.write({
        url: `/developer/${encodeURIComponent(developer)}`,
        changefreq: "weekly",
        priority: 0.7,
      });

      // Add paginated pages for developer
      const developerCount = await Game.count({ developer });
      const developerPages = Math.ceil(developerCount / LIMIT);

      for (let page = 2; page <= developerPages; page++) {
        smStream.write({
          url: `/developer/${encodeURIComponent(developer)}?page=${page}`,
          changefreq: "weekly",
          priority: 0.6,
        });
      }
    }

    for (const publisher of publishers) {
      smStream.write({
        url: `/publisher/${encodeURIComponent(publisher)}`,
        changefreq: "weekly",
        priority: 0.7,
      });

      // Add paginated pages for publisher
      const publisherCount = await Game.count({ publisher });
      const publisherPages = Math.ceil(publisherCount / LIMIT);

      for (let page = 2; page <= publisherPages; page++) {
        smStream.write({
          url: `/publisher/${encodeURIComponent(publisher)}?page=${page}`,
          changefreq: "weekly",
          priority: 0.6,
        });
      }
    }

    for (const year of years) {
      smStream.write({
        url: `/year/${year}`,
        changefreq: "weekly",
        priority: 0.7,
      });

      // Add paginated pages for year
      const yearCount = await Game.count({ year });
      const yearPages = Math.ceil(yearCount / LIMIT);

      for (let page = 2; page <= yearPages; page++) {
        smStream.write({
          url: `/year/${year}?page=${page}`,
          changefreq: "weekly",
          priority: 0.6,
        });
      }
    }

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
