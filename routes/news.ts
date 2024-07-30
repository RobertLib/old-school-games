import express from "express";
import News from "../models/news.ts";
import isAuth from "../middlewares/is-auth.ts";
import isAdmin from "../middlewares/is-admin.ts";
import { validateNews, normalizeNews } from "../validations/news.ts";
import {
  paginatedDescription,
  paginatedTitle,
  paginationUrls,
  parsePageParam,
} from "../utils/pagination.ts";
// parseId, not parseInt: the latter reads "5abc" as 5, so a junk id used to
// act on whichever article happened to be numbered 5.
import { parseId } from "../utils/ids.ts";
import {
  SITE_IMAGE,
  SITE_IMAGE_HEIGHT,
  SITE_IMAGE_WIDTH,
  SITE_URL,
} from "../utils/site.ts";
import { HOME_CRUMB } from "../utils/breadcrumbs.ts";
import { loadSidebarData } from "../middlewares/sidebar-data.ts";
import { ORGANIZATION_REF, organizationNode } from "../utils/organization.ts";
import {
  HEADLINE_MAX,
  LD_TEXT_MAX,
  META_DESCRIPTION_MAX,
  fitTitle,
  htmlToPlainText,
  truncateAtWord,
} from "../utils/html-text.ts";

const router = express.Router();

/**
 * Kept out of the index, on every render of either admin form. The reasoning
 * is written out on ADMIN_FORM_META in routes/games.ts, which these two forms
 * share the situation with exactly.
 */
const ADMIN_FORM_META = { noindex: true };

// Admin route - display form for new news
router.get("/new", isAuth, isAdmin, async (req, res) => {
  res.render("news/new-news", {
    ...ADMIN_FORM_META,
    // The brand suffix every other title on the site carries, which this one
    // alone did not — see utils/pagination.ts, whose BRAND_SUFFIX is the
    // pattern the rest of them are written to.
    title: "Add New News - OldSchoolGames",
  });
});

// Admin route - display edit form
router.get("/:id/edit", isAuth, isAdmin, async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return next();
  }

  const newsItem = await News.findById(id);
  if (!newsItem) {
    return next();
  }

  res.render("news/edit-news", {
    ...ADMIN_FORM_META,
    title: "Edit News - OldSchoolGames",
    newsItem,
  });
});

// Admin route - update news
router.post("/:id", isAuth, isAdmin, async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return next();
  }

  // Trim, then validate, then let the model sanitize on the way in — the
  // same order a game description goes through. validateNews measures the
  // *sanitized* length, so the limit applies to what the column actually
  // receives rather than to the shorter text it came from, without this
  // route having to transform the article to find out. The form is refilled
  // from req.body either way, so the writer gets their own markup back.
  const newsData = normalizeNews(req.body);
  const errors = validateNews(newsData);

  if (errors.length > 0) {
    const newsItem = await News.findById(id);
    if (!newsItem) {
      return next();
    }
    // The chrome, which needsSidebarData skipped for this post: every other
    // outcome here is a redirect, and this is the one path that renders.
    await loadSidebarData(res);

    // 422, matching the game forms — a form that came back covered in
    // errors did not succeed, and the 200 this used to send says it did.
    // See the comment on the create route in routes/games.ts.
    return res.status(422).render("news/edit-news", {
      ...ADMIN_FORM_META,
      title: "Edit News - OldSchoolGames",
      newsItem,
      errors,
      formData: req.body,
    });
  }

  const updated = await News.update(id, newsData);

  if (!updated) {
    return next();
  }

  req.flash("success", "News updated successfully!");
  res.redirect(`/news/${updated.slug}`);
});

// Admin route - delete news
router.post("/:id/delete", isAuth, isAdmin, async (req, res, next) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return next();
  }

  // As in the game delete route: an id with nothing behind it means the
  // admin is acting on a stale page, and saying so beats reporting a
  // deletion that never happened.
  if (!(await News.delete(id))) {
    req.flash("error", "News not found.");
    res.redirect("/news");
    return;
  }

  req.flash("success", "News deleted successfully!");
  res.redirect("/news");
});

// Admin route - create new news
router.post("/", isAuth, isAdmin, async (req, res) => {
  const newsData = normalizeNews(req.body);
  const errors = validateNews(newsData);

  if (errors.length > 0) {
    // The chrome, as on the edit route above.
    await loadSidebarData(res);

    // 422, as on the edit route above.
    return res.status(422).render("news/new-news", {
      ...ADMIN_FORM_META,
      title: "Add New News - OldSchoolGames",
      errors,
      formData: req.body,
    });
  }

  await News.create({
    ...newsData,
    userId: req.session!.user!.id,
  });

  req.flash("success", "News added successfully!");
  res.redirect("/news");
});

// Public route - list all news
router.get("/", async (req, res, next) => {
  const page = parsePageParam(req.query.page);
  const limit = 10;

  const { news, total, totalPages } = await News.findAll({ page, limit });

  // An out-of-range page is a 404, not an empty list. findAll settles that
  // from the count before it runs the listing query — see isPageBeyondTotal —
  // so this is the same condition seen from the outside rather than a second
  // check: a page past the end comes back empty without Postgres having been
  // asked to OFFSET its way there.
  if (page > 1 && news.length === 0) {
    return next();
  }

  const { canonicalUrl, prevPageUrl, nextPageUrl } = paginationUrls({
    baseUrl: `${SITE_URL}/news`,
    page,
    total,
    limit,
  });

  res.render("news/news-list", {
    // Stated, not derived: buildBreadcrumbs grows a "News" step off a
    // `newsItem` local, which only the detail page below passes. So the
    // article showed "Home › News › Title" while the index it points back
    // to showed nothing at all. See utils/breadcrumbs.ts.
    breadcrumbs: [HOME_CRUMB, { name: "News" }],
    title: paginatedTitle("News - OldSchoolGames", page),
    description: paginatedDescription(
      "The latest news, additions and updates from OldSchoolGames.eu — new classic MS-DOS games in the catalogue and what is happening on the site.",
      page,
    ),
    // Excerpts, not the articles. views/news/news-list.ejs used to render
    // every item's stored HTML in full, so /news shipped ten whole articles
    // — the same thing the homepage teaser was doing before routes/home.ts
    // started cutting them. 240 characters for the same reason it uses that
    // figure: it is about what the card shows, so the cut lands just past
    // what is visible rather than inside it.
    news: news.map((item) => ({
      ...item,
      excerpt: truncateAtWord(htmlToPlainText(item.content), 240),
    })),
    currentPage: page,
    totalPages,
    total,
    canonicalUrl,
    prevPageUrl,
    nextPageUrl,
  });
});

// Public route - single news item
router.get("/:slug", async (req, res, next) => {
  const { slug } = req.params;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return next();
  }

  const newsItem = await News.findBySlug(slug);
  if (!newsItem) {
    const currentSlug = await News.findCurrentSlug(slug);

    // The article was renamed; its old address still belongs to it.
    if (currentSlug) {
      return res.redirect(301, `/news/${currentSlug}`);
    }

    return next();
  }

  // Entities are decoded here rather than left as stored: the content goes
  // through DOMPurify on the way in, so an ampersand is held as "&amp;",
  // and EJS escaped it a second time into the meta tag below — the reader
  // saw "&amp;" where the article says "&".
  const plainContent = htmlToPlainText(newsItem.content);

  // On a word boundary. A bare slice cut mid-word, which is what a search
  // result then showed.
  const description = truncateAtWord(plainContent, META_DESCRIPTION_MAX);
  const canonicalUrl = `${SITE_URL}/news/${newsItem.slug}`;
  const datePublished = new Date(newsItem.createdAt).toISOString();
  const dateModified = new Date(newsItem.updatedAt).toISOString();

  const ldJson = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    // Cut, where this used to be the stored title verbatim. The <title>
    // below has been measured since fitTitle was introduced; this field was
    // the half of the same pair that nothing measured, and the articles on
    // the site are long-titled enough to reach the limit. See HEADLINE_MAX.
    headline: truncateAtWord(newsItem.title, HEADLINE_MAX),
    description: truncateAtWord(plainContent, LD_TEXT_MAX),
    datePublished,
    dateModified,
    mainEntityOfPage: { "@type": "WebPage", "@id": canonicalUrl },
    url: canonicalUrl,
    // Required by Google for an Article rich result: Search Console reports
    // a NewsArticle without one as "Missing field 'author'" and withholds
    // the result entirely. The site publishes under its own name rather
    // than per-writer bylines — the news table has no author column — so
    // the Organization is the author.
    //
    // A bare `@id` rather than a second copy of the node. The comment here
    // used to claim this *was* "the same node as the publisher below", but
    // it was not: two objects with the same fields and no `@id` between
    // them are two entities, so every article declared an author and a
    // publisher that a consumer had no way to recognise as one organisation
    // — nor as the one the home page describes. This is a reference to that
    // one, which the `publisher` below puts on the page.
    author: ORGANIZATION_REF,
    // Recommended alongside it, and the same reasoning applies: an article
    // with no image is ineligible for the image half of the result. There is
    // no per-article artwork to point at (again, no column for one), so this
    // is the site image the Open Graph tags already advertise for this page.
    //
    // It used to be /images/navbar.webp, which is 180x180 — and Google asks
    // for at least 1200px of width before an image qualifies for an Article
    // result, so the field was present and doing nothing. SITE_IMAGE is
    // 1200x630. Stated as an ImageObject with its dimensions rather than a
    // bare URL, which saves Google fetching the file to find them out.
    image: {
      "@type": "ImageObject",
      url: SITE_IMAGE,
      width: SITE_IMAGE_WIDTH,
      height: SITE_IMAGE_HEIGHT,
    },
    publisher: organizationNode(),
  };

  res.render("news/news-detail", {
    // An article headline is written to be read on the page, not to fit a
    // SERP: the ones on the site run to 90 characters and more, and this
    // used to append the brand to whatever was stored and send it. "The
    // Secret of Monkey Island (1990) Turns 35 — Celebrate Lucasfilm's
    // Classic MS-DOS Adventure - OldSchoolGames" is 109 characters, so
    // Google cut it mid-word and the brand — the half that says whose result
    // this is — never appeared at all. Cut here, the suffix survives.
    title: fitTitle(newsItem.title, [" - OldSchoolGames"]),
    description,
    canonicalUrl,
    datePublished,
    dateModified,
    newsItem,
    ldJson,
  });
});

export default router;
