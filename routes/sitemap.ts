import express from "express";
import { SitemapStream, streamToPromise } from "sitemap";
import Game from "../models/game.ts";
import News from "../models/news.ts";

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

    // Add news pages
    smStream.write({
      url: `/news`,
      changefreq: "daily",
      priority: 0.8,
    });

    // Add paginated pages for news
    const newsCount = await News.count();
    const newsPages = Math.ceil(newsCount / 10); // News uses limit of 10

    for (let page = 2; page <= newsPages; page++) {
      smStream.write({
        url: `/news?page=${page}`,
        changefreq: "daily",
        priority: 0.7,
      });
    }

    const alphabet = "abcdefghijklmnopqrstuvwxyz".split("");
    // Get basic data in parallel
    const [gameGenres, developers, publishers, years] = await Promise.all([
      Game.getGenres(),
      Game.getDevelopers(),
      Game.getPublishers(),
      Game.getYears(),
    ]);

    // Prepare count promises for parallel execution
    const countPromises: Promise<{
      type: string;
      key: string;
      count: number;
    }>[] = [];

    // Add letter count promises
    for (const letter of alphabet) {
      countPromises.push(
        Game.count({ letter }).then((count) => ({
          type: "letter",
          key: letter,
          count,
        }))
      );
    }

    // Add genre count promises
    for (const genre of gameGenres) {
      countPromises.push(
        Game.count({ genre: genre.toLowerCase() }).then((count) => ({
          type: "genre",
          key: genre,
          count,
        }))
      );
    }

    // Add developer count promises
    for (const developer of developers) {
      countPromises.push(
        Game.count({ developer }).then((count) => ({
          type: "developer",
          key: developer,
          count,
        }))
      );
    }

    // Add publisher count promises
    for (const publisher of publishers) {
      countPromises.push(
        Game.count({ publisher }).then((count) => ({
          type: "publisher",
          key: publisher,
          count,
        }))
      );
    }

    // Add year count promises
    for (const year of years) {
      countPromises.push(
        Game.count({ year }).then((count) => ({
          type: "year",
          key: year.toString(),
          count,
        }))
      );
    }

    // Execute all count queries in parallel
    const counts = await Promise.all(countPromises);

    // Create lookup maps for quick access
    const countMap = new Map<string, number>();
    counts.forEach(({ type, key, count }) => {
      countMap.set(`${type}:${key}`, count);
    });

    // Add letter pages
    for (const letter of alphabet) {
      smStream.write({
        url: `/letter/${letter}`,
        changefreq: "weekly",
        priority: 0.8,
      });

      const letterCount = countMap.get(`letter:${letter}`) || 0;
      const letterPages = Math.ceil(letterCount / LIMIT);

      for (let page = 2; page <= letterPages; page++) {
        smStream.write({
          url: `/letter/${letter}?page=${page}`,
          changefreq: "weekly",
          priority: 0.7,
        });
      }
    }

    // Add genre pages
    for (const genre of gameGenres) {
      smStream.write({
        url: `/${genre.toLowerCase()}`,
        changefreq: "weekly",
        priority: 0.8,
      });

      const genreCount = countMap.get(`genre:${genre}`) || 0;
      const genrePages = Math.ceil(genreCount / LIMIT);

      for (let page = 2; page <= genrePages; page++) {
        smStream.write({
          url: `/${genre.toLowerCase()}?page=${page}`,
          changefreq: "weekly",
          priority: 0.7,
        });
      }
    }

    // Add developer pages
    for (const developer of developers) {
      smStream.write({
        url: `/developer/${encodeURIComponent(developer)}`,
        changefreq: "weekly",
        priority: 0.7,
      });

      const developerCount = countMap.get(`developer:${developer}`) || 0;
      const developerPages = Math.ceil(developerCount / LIMIT);

      for (let page = 2; page <= developerPages; page++) {
        smStream.write({
          url: `/developer/${encodeURIComponent(developer)}?page=${page}`,
          changefreq: "weekly",
          priority: 0.6,
        });
      }
    }

    // Add publisher pages
    for (const publisher of publishers) {
      smStream.write({
        url: `/publisher/${encodeURIComponent(publisher)}`,
        changefreq: "weekly",
        priority: 0.7,
      });

      const publisherCount = countMap.get(`publisher:${publisher}`) || 0;
      const publisherPages = Math.ceil(publisherCount / LIMIT);

      for (let page = 2; page <= publisherPages; page++) {
        smStream.write({
          url: `/publisher/${encodeURIComponent(publisher)}?page=${page}`,
          changefreq: "weekly",
          priority: 0.6,
        });
      }
    }

    // Add year pages
    for (const year of years) {
      smStream.write({
        url: `/year/${year}`,
        changefreq: "weekly",
        priority: 0.7,
      });

      const yearCount = countMap.get(`year:${year}`) || 0;
      const yearPages = Math.ceil(yearCount / LIMIT);

      for (let page = 2; page <= yearPages; page++) {
        smStream.write({
          url: `/year/${year}?page=${page}`,
          changefreq: "weekly",
          priority: 0.6,
        });
      }
    }

    // Get games with minimal data for sitemap
    const games = await Game.findForSitemap();

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
