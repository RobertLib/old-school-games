require("dotenv").config();

const express = require("express");
const path = require("path");
const winston = require("winston");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const compression = require("compression");
const cookieParser = require("cookie-parser");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const pool = require("./db");
const flash = require("connect-flash");

const app = express();

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
  if (req.headers.host === "old-school-games.fly.dev") {
    return res.redirect(301, `https://oldschoolgames.eu${req.originalUrl}`);
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
        ],
        "script-src": [
          "'self'",
          "'unsafe-inline'",
          "https://*.googletagmanager.com",
        ],
        "script-src-attr": ["'self'", "'unsafe-inline'"],
        "img-src": [
          "'self'",
          "https://upload.wikimedia.org",
          "https://*.google-analytics.com",
          "https://*.googletagmanager.com",
        ],
        "frame-src": ["https://archive.org"],
      },
    },
  })
);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
});

app.use(limiter);

app.use(compression());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(cookieParser());

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

const Game = require("./models/game");

app.use(async (req, res, next) => {
  try {
    res.locals.req = req;
    res.locals.gameGenres = await Game.getGenres();

    next();
  } catch (error) {
    next(error);
  }
});

app.use((req, res, next) => {
  const currentTime = new Date().toISOString();
  logger.info(`[${currentTime}] Request: ${req.method} ${req.url}`);
  next();
});

const authRoutes = require("./routes/auth");
const sitemapRoutes = require("./routes/sitemap");
const homeRoutes = require("./routes/home");
const gamesRoutes = require("./routes/games");
const commentsRoutes = require("./routes/comments");

app.use("/", authRoutes);
app.use("/", sitemapRoutes);
app.use("/", homeRoutes);
app.use("/games", gamesRoutes);
app.use("/comments", commentsRoutes);

app.use((req, res, next) => {
  res.status(404).send("Page not found");
});

app.use((err, req, res, next) => {
  logger.error(err.stack);

  res.status(500).send("Something broke!");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
});
