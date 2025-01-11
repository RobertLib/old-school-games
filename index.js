import "dotenv/config";
import express from "express";
import { fileURLToPath } from "url";
import path from "path";
import winston from "winston";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import compression from "compression";
import cookieParser from "cookie-parser";
import session from "express-session";
import connectPg from "connect-pg-simple";
import pool from "./db.js";
import flash from "connect-flash";
import Game from "./models/game.js";

import authRoutes from "./routes/auth.js";
import sitemapRoutes from "./routes/sitemap.js";
import homeRoutes from "./routes/home.js";
import gamesRoutes from "./routes/games.js";
import commentsRoutes from "./routes/comments.js";

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
          "https://*.google-analytics.com",
          "https://*.analytics.google.com",
          "https://*.googletagmanager.com",
          "https://v8.js-dos.com",
          "https://trwglibsccninuamefls.supabase.co",
        ],
        "script-src": [
          "'self'",
          "'unsafe-inline'",
          "'unsafe-eval'",
          "https://*.googletagmanager.com",
          "https://v8.js-dos.com",
          "blob:",
        ],
        "script-src-attr": ["'self'", "'unsafe-inline'"],
        "img-src": [
          "'self'",
          "https://*.google-analytics.com",
          "https://*.googletagmanager.com",
          "https://trwglibsccninuamefls.supabase.co",
        ],
        "frame-src": ["'self'"],
      },
    },
  })
);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 500,
});

app.use(limiter);

app.use(compression());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(cookieParser());

const pgSession = connectPg(session);

const sessionOptions = {
  store: new pgSession({ pool }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 365 * 24 * 60 * 60 * 1000,
    sameSite: "strict",
    httpOnly: true,
    secure: app.get("env") === "production",
  },
};

if (app.get("env") === "production") {
  app.set("trust proxy", 1);
}

app.use(session(sessionOptions));

app.use(flash());

app.use(async (req, res, next) => {
  res.locals.req = req;
  res.locals.gameGenres = await Game.getGenres();
  res.locals.recentlyAddedGames = await Game.findRecentlyAdded();

  next();
});

app.use((req, res, next) => {
  const currentTime = new Date().toISOString();
  logger.info(`[${currentTime}] Request: ${req.method} ${req.url}`);
  next();
});

app.use("/", authRoutes);
app.use("/", sitemapRoutes);
app.use("/", homeRoutes);
app.use("/games", gamesRoutes);
app.use("/comments", commentsRoutes);

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
