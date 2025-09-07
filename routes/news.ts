import express from "express";
import News from "../models/news.ts";
import isAuth from "../middlewares/is-auth.ts";
import isAdmin from "../middlewares/is-admin.ts";
import { validateNews, sanitizeNews } from "../validations/news.ts";

const router = express.Router();

// Admin route - display form for new news
router.get("/new", isAuth, isAdmin, async (req, res) => {
  res.render("news/new-news", { title: "Add New News" });
});

// Admin route - create new news
router.post("/", isAuth, isAdmin, async (req, res, next) => {
  try {
    const errors = validateNews(req.body);

    if (errors.length > 0) {
      return res.render("news/new-news", {
        title: "Add New News",
        errors,
        formData: req.body,
      });
    }

    const sanitizedData = sanitizeNews(req.body);
    await News.create({
      ...sanitizedData,
      userId: req.session!.user!.id,
    });

    req.flash("success", "News added successfully!");
    res.redirect("/news");
  } catch (error) {
    next(error);
  }
});

// Public route - list all news
router.get("/", async (req, res, next) => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = 10;

    const { news, total, totalPages } = await News.findAll({ page, limit });

    res.render("news/news-list", {
      title: "News - OldSchoolGames",
      news,
      currentPage: page,
      totalPages,
      total,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
