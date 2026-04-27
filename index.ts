import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { fileURLToPath } from "url";
import path from "path";
import logger from "./utils/logger.ts";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import compression from "compression";
import session, { type SessionOptions } from "express-session";
import connectPg from "connect-pg-simple";
import pool from "./db.ts";
import { flash } from "./middlewares/flash.ts";
import Game from "./models/game.ts";
import GameOfTheWeek from "./models/game-of-the-week.ts";

import authRoutes from "./routes/auth.ts";
import sitemapRoutes from "./routes/sitemap.ts";
import homeRoutes from "./routes/home.ts";
import gamesRoutes from "./routes/games.ts";
import commentsRoutes from "./routes/comments.ts";
import newsRoutes from "./routes/news.ts";
import indexnowRoutes from "./routes/indexnow.ts";
import listsRoutes from "./routes/lists.ts";
import { csrfToken, validateCsrf } from "./middlewares/csrf.ts";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use((req, res, next) => {
  if (process.env.NODE_ENV === "production") {
    if (req.headers["x-forwarded-proto"] !== "https") {
      return res.redirect(`https://${req.headers.host}${req.url}`);
    }

    if (req.headers.host === "old-school-games.fly.dev") {
      return res.redirect(301, `https://oldschoolgames.eu${req.originalUrl}`);
    }
  }

  next();
});

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        "default-src": ["'self'"],
        "connect-src": [
          "'self'",
          "https://v8.js-dos.com",
          "https://trwglibsccninuamefls.supabase.co",
          "https://www.google-analytics.com",
          "https://analytics.google.com",
          "https://www.googletagmanager.com",
          "https://region1.google-analytics.com",
          "https://*.google-analytics.com",
        ],
        "script-src": [
          "'self'",
          "'unsafe-inline'",
          "'unsafe-eval'",
          "https://v8.js-dos.com",
          "https://www.googletagmanager.com",
          "https://www.google-analytics.com",
          "blob:",
        ],
        "script-src-attr": ["'self'", "'unsafe-inline'"],
        "img-src": [
          "'self'",
          "https://trwglibsccninuamefls.supabase.co",
          "https://www.google-analytics.com",
          "https://www.googletagmanager.com",
        ],
        "frame-src": ["'self'"],
      },
    },
  }),
);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1000,
});

app.use(limiter);

app.use(compression());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1d" }));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  throw new Error(
    "SESSION_SECRET environment variable is required in production",
  );
}

const pgSession = connectPg(session);

const sessionOptions: SessionOptions = {
  store: new pgSession({ pool }),
  secret: process.env.SESSION_SECRET ?? "secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: "strict",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
  },
};

app.use(session(sessionOptions));

app.use(flash);

app.use(csrfToken);
app.use(validateCsrf);

const cache = new Map();
const cacheTimers = new Map();

app.use(async (req, res, next) => {
  try {
    const cacheKey = "game-genres";
    let gameGenres = cache.get(cacheKey);

    if (!gameGenres) {
      gameGenres = await Game.getGenres();
      cache.set(cacheKey, gameGenres);

      if (cacheTimers.has(cacheKey)) {
        clearTimeout(cacheTimers.get(cacheKey));
      }

      const timer = setTimeout(() => {
        cache.delete(cacheKey);
        cacheTimers.delete(cacheKey);
      }, 3600000);

      cacheTimers.set(cacheKey, timer);
    }

    res.locals.gameGenres = gameGenres;
  } catch (error) {
    logger.error("Error loading genres:", error);
    res.locals.gameGenres = [];
  }

  next();
});

app.use(async (req, res, next) => {
  try {
    res.locals.req = req;

    let recentGames = cache.get("recent-games");
    if (!recentGames) {
      recentGames = await Game.findRecentlyAdded();
      cache.set("recent-games", recentGames);

      if (cacheTimers.has("recent-games")) {
        clearTimeout(cacheTimers.get("recent-games"));
      }

      const timer = setTimeout(() => {
        cache.delete("recent-games");
        cacheTimers.delete("recent-games");
      }, 300000);

      cacheTimers.set("recent-games", timer);
    }

    res.locals.recentlyAddedGames = recentGames;

    let topRatedGames = cache.get("top-rated-games");
    if (!topRatedGames) {
      topRatedGames = await Game.findTopRated();
      cache.set("top-rated-games", topRatedGames);

      if (cacheTimers.has("top-rated-games")) {
        clearTimeout(cacheTimers.get("top-rated-games"));
      }

      const topRatedTimer = setTimeout(() => {
        cache.delete("top-rated-games");
        cacheTimers.delete("top-rated-games");
      }, 300000);

      cacheTimers.set("top-rated-games", topRatedTimer);
    }

    res.locals.topRatedGames = topRatedGames;

    let mostPlayedGames = cache.get("most-played-games");
    if (!mostPlayedGames) {
      mostPlayedGames = await Game.findMostPlayed();
      cache.set("most-played-games", mostPlayedGames);

      if (cacheTimers.has("most-played-games")) {
        clearTimeout(cacheTimers.get("most-played-games"));
      }

      const mostPlayedTimer = setTimeout(() => {
        cache.delete("most-played-games");
        cacheTimers.delete("most-played-games");
      }, 300000);

      cacheTimers.set("most-played-games", mostPlayedTimer);
    }

    res.locals.mostPlayedGames = mostPlayedGames;

    let gameOfTheWeek;
    if (!cache.has("game-of-the-week")) {
      gameOfTheWeek = await GameOfTheWeek.getOrSelectCurrent();
      cache.set("game-of-the-week", gameOfTheWeek);

      if (cacheTimers.has("game-of-the-week")) {
        clearTimeout(cacheTimers.get("game-of-the-week"));
      }

      const gameOfTheWeekTimer = setTimeout(() => {
        cache.delete("game-of-the-week");
        cacheTimers.delete("game-of-the-week");
      }, 3600000);

      cacheTimers.set("game-of-the-week", gameOfTheWeekTimer);
    } else {
      gameOfTheWeek = cache.get("game-of-the-week");
    }

    res.locals.gameOfTheWeek = gameOfTheWeek;
  } catch (error) {
    logger.error("Error loading common data:", error);
    res.locals.recentlyAddedGames = [];
    res.locals.topRatedGames = [];
    res.locals.mostPlayedGames = [];
    res.locals.gameOfTheWeek = null;
  }

  next();
});

// Add contextual links middleware
app.use(async (req, res, next) => {
  try {
    // Add popular publishers and developers for footer links
    let popularPublishers = cache.get("popular-publishers");
    let popularDevelopers = cache.get("popular-developers");

    if (!popularPublishers || !popularDevelopers) {
      const [publishers, developers] = await Promise.all([
        Game.getPublishers(),
        Game.getDevelopers(),
      ]);

      popularPublishers = publishers.slice(0, 10);
      popularDevelopers = developers.slice(0, 10);

      cache.set("popular-publishers", popularPublishers);
      cache.set("popular-developers", popularDevelopers);

      if (cacheTimers.has("popular-publishers")) {
        clearTimeout(cacheTimers.get("popular-publishers"));
      }

      // Cache for 6 hours
      const timer = setTimeout(() => {
        cache.delete("popular-publishers");
        cache.delete("popular-developers");
        cacheTimers.delete("popular-publishers");
        cacheTimers.delete("popular-developers");
      }, 21600000);

      cacheTimers.set("popular-publishers", timer);
      cacheTimers.set("popular-developers", timer);
    }

    res.locals.popularPublishers = popularPublishers;
    res.locals.popularDevelopers = popularDevelopers;
  } catch (error) {
    logger.error("Error loading contextual data:", error);
    res.locals.popularPublishers = [];
    res.locals.popularDevelopers = [];
  }

  next();
});

app.use((req, res, next) => {
  const currentTime = new Date().toISOString();
  logger.info(`[${currentTime}] Request: ${req.method} ${req.url}`);
  next();
});

app.use("/", authRoutes);
app.use("/", sitemapRoutes);
app.use("/", listsRoutes);
app.use("/", homeRoutes);
app.use("/games", gamesRoutes);
app.use("/comments", commentsRoutes);
app.use("/news", newsRoutes);
app.use("/", indexnowRoutes);

app.use((req, res, next) => {
  res.status(404).render("404");
});

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error(err.stack ?? err.message);

  res.status(500).render("500");
});

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down gracefully...");
  server.close(() => {
    cacheTimers.forEach((timer) => clearTimeout(timer));
    cacheTimers.clear();
    cache.clear();
    pool.end(() => {
      logger.info("Database pool closed.");
      process.exit(0);
    });
  });
});
