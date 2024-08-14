require("dotenv").config();

const express = require("express");
const path = require("path");
const compression = require("compression");
const cookieParser = require("cookie-parser");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const pool = require("./db");
const flash = require("connect-flash");

const app = express();

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
  },
};

if (app.get("env") === "production") {
  app.set("trust proxy", 1);
  sessionOptions.cookie.secure = true;
}

app.use(session(sessionOptions));

app.use(flash());

app.use(async (req, res, next) => {
  try {
    res.locals.query = req.query;
    res.locals.params = req.params;
    res.locals.session = req.session;
    res.locals.messages = req.flash();
    res.locals.gameGenres = await Game.getGenres();

    next();
  } catch (error) {
    next(error);
  }
});

app.use((req, res, next) => {
  console.log(`Request: ${req.method} ${req.url}`);
  next();
});

const authRoutes = require("./routes/auth");
const gamesRoutes = require("./routes/games");
const commentsRoutes = require("./routes/comments");

app.use("/", authRoutes);
app.use("/games", gamesRoutes);
app.use("/comments", commentsRoutes);

const Game = require("./models/game");

app.get("/", async (req, res, next) => {
  try {
    const { genre } = req.query;

    const games = await Game.findByGenre(genre);

    res.render("index", { games });
  } catch (error) {
    next(error);
  }
});

app.use((req, res, next) => {
  res.status(404).send("Page not found");
});

app.use((err, req, res, next) => {
  console.error(err.stack);

  res.status(500).send("Something broke!");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
