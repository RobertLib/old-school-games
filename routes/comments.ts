import express from "express";
import logger from "../utils/logger.ts";
import Comment, { OVERVIEW_PAGE_SIZE } from "../models/comment.ts";
import Game from "../models/game.ts";
import isAdmin from "../middlewares/is-admin.ts";
import isAuth from "../middlewares/is-auth.ts";
import rateLimit from "express-rate-limit";
import {
  paginatedDescription,
  paginatedTitle,
  paginationUrls,
  parsePageParam,
} from "../utils/pagination.ts";
import { parseId } from "../utils/ids.ts";
import { isMissingGameError } from "../utils/pg-errors.ts";
import { firstQueryValue } from "../utils/query.ts";
import { validateComment } from "../validations/comments.ts";
import { SITE_URL } from "../utils/site.ts";
import { HOME_CRUMB } from "../utils/breadcrumbs.ts";
import {
  PostgresRateLimitStore,
  rateLimitLogger,
} from "../utils/rate-limit-store.ts";

const router = express.Router();

const HOSTNAME = SITE_URL;

/**
 * Site-wide comment overview. Comments used to live only on the game they were
 * posted on, so a visitor had no way of telling whether anyone was talking at
 * all. This is the one page that answers that.
 *
 * Declared before "/:gameId" below, which would otherwise never match "/" but
 * reads confusingly the other way round.
 */
router.get("/", async (req, res, next) => {
  const page = parsePageParam(req.query.page);

  try {
    const [comments, total, mostDiscussed] = await Promise.all([
      Comment.findRecent({
        limit: OVERVIEW_PAGE_SIZE,
        offset: (page - 1) * OVERVIEW_PAGE_SIZE,
      }),
      Comment.countSitewide(),
      // Only worth the GROUP BY on the page anyone actually lands on.
      page === 1 ? Comment.findMostDiscussed(10) : Promise.resolve([]),
    ]);

    // An out-of-range page is a 404, not an empty list.
    if (page > 1 && comments.length === 0) {
      return next();
    }

    const totalPages = Math.max(1, Math.ceil(total / OVERVIEW_PAGE_SIZE));

    const { canonicalUrl, prevPageUrl, nextPageUrl } = paginationUrls({
      baseUrl: `${HOSTNAME}/comments`,
      page,
      total,
      limit: OVERVIEW_PAGE_SIZE,
    });

    res.render("comments/comments-index", {
      // Stated rather than derived, and rendered by views/breadcrumb.ejs like
      // every other trail on the site. The markup used to carry its own copy,
      // which meant views/head.ejs emitted no BreadcrumbList for a page that
      // was showing the reader a path — see the note in routes/lists.ts, which
      // had the same three pages' worth of it.
      breadcrumbs: [
        HOME_CRUMB,
        { name: "Latest Comments" },
      ],
      title: paginatedTitle(
        "Latest Comments from the Community | OldSchoolGames",
        page,
      ),
      description: paginatedDescription(
        "See what players are saying about classic MS-DOS games right now — the latest comments from the OldSchoolGames community and the games being discussed most.",
        page,
      ),
      canonicalUrl,
      // Page 1 is the page worth ranking; the rest is an archive that would
      // only compete with the game pages the comments were posted on. Decided
      // here rather than in the view so head.ejs drops the canonical with it.
      noindex: page > 1,
      prevPageUrl,
      nextPageUrl,
      comments,
      mostDiscussed,
      page,
      limit: OVERVIEW_PAGE_SIZE,
      total,
      totalPages,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Moderation. Anonymous comments were tolerable while they sat on one game's
 * page; the overview and the sidebar widget put them in front of everyone, so
 * there has to be a way to take one down.
 */
router.post("/:id/delete", isAuth, isAdmin, async (req, res, next) => {
  // parseId, not parseInt: the latter reads "5abc" as 5 and would moderate
  // whichever comment happened to be numbered 5.
  const id = parseId(req.params.id);

  // Back to the overview rather than next() — the 404 view renders the
  // sidebars, and this path deliberately skips loading their data.
  if (id === null) {
    req.flash("error", "Invalid comment.");
    res.redirect("/comments");
    return;
  }

  try {
    const comment = await Comment.findById(id);

    if (!comment) {
      req.flash("error", "Comment not found.");
      res.redirect("/comments");
      return;
    }

    await Comment.delete(id);

    req.flash("success", "Comment deleted.");

    // The form states where it was submitted from rather than passing a URL.
    // A Referer header or a hidden "next" field would be an open redirect to
    // maintain; this is two fixed destinations.
    if (req.body?.from === "game") {
      const game = await Game.findById(comment.gameId);

      if (game?.slug) {
        res.redirect(`/${game.slug}#comments`);
        return;
      }
    }

    res.redirect("/comments");
  } catch (error) {
    next(error);
  }
});

/**
 * Next batch of older top-level comments, rendered ready to prepend.
 * Threads can run to thousands of comments, so the page ships one batch and
 * fetches the rest only if the reader asks for them.
 */
router.get("/:gameId", async (req, res) => {
  const gameId = parseId(req.params.gameId);
  const rawBefore = firstQueryValue(req.query.before);

  if (gameId === null) {
    res.status(400).json({ error: "Invalid game ID" });
    return;
  }

  // No cursor means the newest batch, which is what Comment.findByGameId
  // does with a null "before". Insisting on one made the endpoint unable to
  // serve the first batch at all — it answered 400 — and left it working
  // only because the page happens to render that batch itself and the button
  // always carries a cursor by the time anyone clicks it.
  let before: number | null = null;

  if (rawBefore !== undefined) {
    before = parseId(rawBefore);

    if (before === null) {
      res.status(400).json({ error: "Invalid cursor" });
      return;
    }
  }

  try {
    const comments = await Comment.findByGameId(gameId, { before });

    if (comments.length === 0) {
      res.json({ html: "", oldestId: null, remaining: 0 });
      return;
    }

    const oldestId = comments[0]!.id;

    const [html, remaining] = await Promise.all([
      new Promise<string>((resolve, reject) => {
        res.render("comments/comment-batch", { comments }, (error, rendered) =>
          error ? reject(error) : resolve(rendered),
        );
      }),
      Comment.countOlderThan(gameId, oldestId),
    ]);

    res.json({ html, oldestId, remaining });
  } catch (error) {
    logger.error("Error loading comments:", error);
    res.status(500).json({ error: "Failed to load comments" });
  }
});

const commentRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 10,
  // An object, not a string: comments.js reads the reason off `error` in a
  // JSON body, and a plain-text body made it fall through to its generic
  // "Could not post the comment" — the one message that does not say why.
  message: { error: "Too many comments, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
  store: new PostgresRateLimitStore("comment"),
  passOnStoreError: true,
  // ...and says so through utils/logger.ts rather than the library's
  // own console fallback — see rateLimitLogger.
  logger: rateLimitLogger,
});

// validateComment ahead of the limiter, as in routes/games.ts and for the
// same reason: refusing a malformed post costs no database access, so a
// broken client looping on one should not spend the budget that real
// comments come out of — a budget shared by everyone behind the same address.
router.post("/", validateComment, commentRateLimit, async (req, res, next) => {
  try {
    // validateComment has already sanitized the text and turned both ids into
    // numbers, so what arrives here is what gets stored.
    const { nick, content, gameId, parentId } = req.body;

    // A reply must belong to the same game, otherwise it would surface under
    // an unrelated thread. Both ids arrive as numbers — validateComment parses
    // them and writes them back.
    let resolvedParentId: number | null = null;

    if (parentId !== null) {
      const parent = await Comment.findById(parentId);

      if (!parent || parent.gameId !== gameId) {
        res.status(400).json({ error: "Invalid parent comment" });
        return;
      }

      resolvedParentId = parent.id;
    }

    const comment = await Comment.create({
      nick: nick || "anonymous",
      content,
      gameId,
      parentId: resolvedParentId,
    });

    res.render("comments/comment-item", {
      comment,
      isReply: !!resolvedParentId,
    });
  } catch (error) {
    if (isMissingGameError(error)) {
      res.status(404).json({ error: "Game not found" });
      return;
    }

    logger.error("Error creating comment:", error);
    res.status(500).json({ error: "Failed to create comment" });
  }
});

export default router;
