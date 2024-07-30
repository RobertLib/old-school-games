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

    // Set canonical URL
    const newsUrl = "https://oldschoolgames.eu/news";
    const canonicalUrl = page > 1 ? `${newsUrl}?page=${page}` : newsUrl;
    const prevPageUrl =
      page > 1
        ? page > 2
          ? `${newsUrl}?page=${page - 1}`
          : newsUrl
        : undefined;
    const nextPageUrl =
      page < totalPages ? `${newsUrl}?page=${page + 1}` : undefined;

    res.render("news/news-list", {
      title: "News - OldSchoolGames",
      news,
      currentPage: page,
      totalPages,
      total,
      canonicalUrl,
      prevPageUrl,
      nextPageUrl,
    });
  } catch (error) {
    next(error);
  }
});

// Public route - single news item
router.get("/:id", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      return next();
    }

    const newsItem = await News.findById(id);
    if (!newsItem) {
      return next();
    }

    const plainContent = newsItem.content
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const description = plainContent.slice(0, 160);
    const canonicalUrl = `https://oldschoolgames.eu/news/${newsItem.id}`;
    const datePublished = new Date(newsItem.createdAt).toISOString();
    const dateModified = new Date(newsItem.updatedAt).toISOString();

    const ldJson = {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      headline: newsItem.title,
      description: plainContent.slice(0, 500),
      datePublished,
      dateModified,
      mainEntityOfPage: { "@type": "WebPage", "@id": canonicalUrl },
      publisher: {
        "@type": "Organization",
        name: "OldSchoolGames",
        url: "https://oldschoolgames.eu",
        logo: {
          "@type": "ImageObject",
          url: "https://oldschoolgames.eu/images/navbar.webp",
        },
      },
    };

    const breadcrumbLdJson = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "Home",
          item: "https://oldschoolgames.eu/",
        },
        {
          "@type": "ListItem",
          position: 2,
          name: "News",
          item: "https://oldschoolgames.eu/news",
        },
        { "@type": "ListItem", position: 3, name: newsItem.title },
      ],
    };

    res.render("news/news-detail", {
      title: `${newsItem.title} - OldSchoolGames`,
      description,
      canonicalUrl,
      datePublished,
      dateModified,
      newsItem,
      ldJson,
      breadcrumbLdJson,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
