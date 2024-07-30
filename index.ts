import "dotenv/config";
import express from "express";
import { fileURLToPath } from "url";
import path from "path";
import winston from "winston";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import compression from "compression";
import cookieParser from "cookie-parser";
import session, { type SessionOptions } from "express-session";
import connectPg from "connect-pg-simple";
import pool from "./db.ts";
import flash from "connect-flash";
import Game from "./models/game.ts";
import GameOfTheWeek from "./models/game-of-the-week.ts";

import authRoutes from "./routes/auth.ts";
import sitemapRoutes from "./routes/sitemap.ts";
import homeRoutes from "./routes/home.ts";
import gamesRoutes from "./routes/games.ts";
import commentsRoutes from "./routes/comments.ts";
import newsRoutes from "./routes/news.ts";
import indexnowRoutes from "./routes/indexnow.ts";
// import analyticsMiddleware from "./middlewares/analytics.ts";
// import analyticsRoutes from "./routes/analytics.ts";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = winston.createLogger({
  level: "info",
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
  ],
});

if (process.env.NODE_ENV !== "production") {
  logger.add(
    new winston.transports.Console({
      format: winston.format.simple(),
    })
  );
}

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
  })
);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1000,
});

app.use(limiter);

app.use(compression());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(cookieParser());

if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

const pgSession = connectPg(session);

const sessionOptions: SessionOptions = {
  store: new pgSession({ pool }),
  secret: process.env.SESSION_SECRET ?? "secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 365 * 24 * 60 * 60 * 1000,
    sameSite: "strict",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
  },
};

app.use(session(sessionOptions));

app.use(flash());

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
    res.locals.topRatedGames = await Game.findTopRated();
    res.locals.gameOfTheWeek = await GameOfTheWeek.getOrSelectCurrent();
  } catch (error) {
    logger.error("Error loading common data:", error);
    res.locals.recentlyAddedGames = [];
    res.locals.topRatedGames = [];
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

      // Cache for 6 hours
      const timer = setTimeout(() => {
        cache.delete("popular-publishers");
        cache.delete("popular-developers");
      }, 21600000);
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

// app.use(analyticsMiddleware);

app.use("/", authRoutes);
app.use("/", sitemapRoutes);
app.use("/", homeRoutes);
app.use("/games", gamesRoutes);
app.use("/comments", commentsRoutes);
app.use("/news", newsRoutes);
app.use("/", indexnowRoutes);
// app.use("/", analyticsRoutes);

app.use((req, res, next) => {
  res.status(404).render("404");
});

app.use((err, req, res, next) => {
  logger.error(err.stack);

  res.status(500).render("500");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM received, clearing timers...");
  cacheTimers.forEach((timer) => clearTimeout(timer));
  cacheTimers.clear();
  cache.clear();
  process.exit(0);
});
