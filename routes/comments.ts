import express from "express";
import Comment, {
  OVERVIEW_PAGE_SIZE,
  SOURCE_IPV6_SUBNET,
  SOURCE_RETENTION_DAYS,
} from "../models/comment.ts";
import Game from "../models/game.ts";
import isAdmin from "../middlewares/is-admin.ts";
import isAuth from "../middlewares/is-auth.ts";
import rateLimit from "express-rate-limit";
import {
  isPageBeyondTotal,
  paginatedDescription,
  paginatedTitle,
  paginationUrls,
  parsePageParam,
  totalPages,
} from "../utils/pagination.ts";
import { parseId } from "../utils/ids.ts";
import {
  isMissingGameError,
  isMissingParentCommentError,
} from "../utils/pg-errors.ts";
import { firstQueryValue } from "../utils/query.ts";
import { isJsonRequest } from "../utils/expects-json.ts";
import { validateComment } from "../validations/comments.ts";
import { SITE_URL } from "../utils/site.ts";
import { HOME_CRUMB } from "../utils/breadcrumbs.ts";
import {
  PostgresRateLimitStore,
  rateLimitLogger,
} from "../utils/rate-limit-store.ts";
import { loadSidebarData } from "../middlewares/sidebar-data.ts";
import { truncateAtWord } from "../utils/html-text.ts";

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
    // The count first, and the listing only if the page it would serve is in
    // range — the same order routes/home.ts and the other listings use, for
    // the reason written out on isPageBeyondTotal. parsePageParam admits
    // anything up to MAX_PAGE, so "/comments?page=9999" made Postgres join
    // every comment to its game and then walk past 299 940 of them to find
    // out the address does not exist. Ten thousand such addresses, each one a
    // link somebody can write by hand.
    const total = await Comment.countSitewide();

    if (isPageBeyondTotal({ page, limit: OVERVIEW_PAGE_SIZE, total })) {
      return next();
    }

    const [comments, mostDiscussed] = await Promise.all([
      Comment.findRecent({
        limit: OVERVIEW_PAGE_SIZE,
        offset: (page - 1) * OVERVIEW_PAGE_SIZE,
      }),
      // Only worth asking for on the page anyone actually lands on. It is
      // cached now (see MOST_DISCUSSED_KEY), so this is about the deeper
      // pages not filling the entry rather than about the GROUP BY.
      page === 1 ? Comment.findMostDiscussed() : Promise.resolve([]),
    ]);

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
      totalPages: totalPages(total, OVERVIEW_PAGE_SIZE),
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
 * What an admin is told when a comment has no source to act on. It was posted
 * before sources were recorded, or longer ago than they are kept.
 */
const NO_SOURCE_MESSAGE = `No source is recorded for that comment — sources are kept for ${SOURCE_RETENTION_DAYS} days.`;

/**
 * The comment an admin clicked, when there is a source to group by; otherwise
 * the refusal is already sent and the answer is null.
 *
 * Shared by the two routes below, which must agree about when there is
 * nothing to do. Both answer with a flash and a redirect to the overview, like
 * the single delete above, and for its reason: the 404 view renders the
 * sidebars, and these paths skip loading their data.
 */
async function findSourcedComment(
  req: express.Request,
  res: express.Response,
): Promise<Comment | null> {
  // parseId, not parseInt — see the single delete above.
  const id = parseId(req.params.id);

  if (id === null) {
    req.flash("error", "Invalid comment.");
    res.redirect("/comments");
    return null;
  }

  const comment = await Comment.findById(id);

  if (!comment) {
    req.flash("error", "Comment not found.");
    res.redirect("/comments");
    return null;
  }

  if (!comment.hasSource) {
    req.flash("error", NO_SOURCE_MESSAGE);
    res.redirect("/comments");
    return null;
  }

  return comment;
}

/**
 * Moderation for a flood: every comment posted from the same source as this
 * one, shown before any of it is deleted.
 *
 * The single delete above is one click per comment, and nothing tied a
 * comment to the others its author had posted — so a flood (an IPv6 /48 is
 * 256 budgets of the limiter below, some 2,560 comments in five minutes; see
 * 0056_comments_source_hash.sql) was thousands of clicks, with no way even
 * to find the rest. A source is now
 * recorded with every comment, and this is where an admin sees what it
 * groups: how many comments, how many replies from elsewhere would go with
 * them, and the newest of them. The delete is a second, deliberate step.
 *
 * A POST, though it changes nothing. utils/expects-json.ts answers every GET
 * under /comments/ in JSON — GET /comments/:gameId is the batch endpoint — so
 * a page here would have had its errors rendered as objects. The form that
 * reaches it carries the CSRF token like every other admin control, and
 * reloading it only asks the same question again.
 */
router.post("/:id/source", isAuth, isAdmin, async (req, res, next) => {
  try {
    const comment = await findSourcedComment(req, res);

    if (!comment) return;

    const source = await Comment.findSameSource(comment.id);

    // Pruned, or deleted, between the two reads.
    if (!source) {
      req.flash("error", NO_SOURCE_MESSAGE);
      res.redirect("/comments");
      return;
    }

    // The chrome, which needsSidebarData skips for everything under
    // /comments/ — this is the one path there that renders a whole page.
    await loadSidebarData(res);

    res.render("comments/comment-source", {
      noindex: true,
      title: "Comments from one source - OldSchoolGames",
      breadcrumbs: [
        HOME_CRUMB,
        { name: "Latest Comments", path: "/comments" },
        { name: "Comments from one source" },
      ],
      commentId: comment.id,
      total: source.total,
      otherReplies: source.otherReplies,
      // Cut the way the overview cuts them: this is for recognising a
      // flood, not for reading it.
      comments: source.comments.map((item) => ({
        ...item,
        snippet: truncateAtWord(item.content, 240),
      })),
      retentionDays: SOURCE_RETENTION_DAYS,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Deletes every comment from the same source as this one — what the page
 * above has just shown.
 *
 * The same semantics as the single delete, only wider (see
 * Comment.deleteSameSource): replies go with the comments they answer, and
 * the caches the single delete drops are dropped here, on this machine and
 * through the epoch on every other. Everything the source has posted by now
 * goes, including anything that arrived after the page was drawn — which, for
 * a flood still in progress, is the point.
 */
router.post("/:id/source/delete", isAuth, isAdmin, async (req, res, next) => {
  try {
    const comment = await findSourcedComment(req, res);

    if (!comment) return;

    const deleted = await Comment.deleteSameSource(comment.id);

    req.flash(
      "success",
      `Deleted ${deleted} comment${deleted === 1 ? "" : "s"} from that source, and the replies to them.`,
    );

    res.redirect("/comments");
  } catch (error) {
    next(error);
  }
});

/**
 * The brake on the "load earlier comments" button.
 *
 * Every other endpoint that costs a query per request has one — see the
 * limiters in routes/games.ts and routes/auth.ts — and this was the read that
 * did not. It is not free: a batch is two queries, one of them a recursive
 * walk of up to twenty whole threads (see Comment.findByGameId), and the
 * cursor is in the query string, so replaying it is a loop anyone can write.
 *
 * Generous, because a reader clicking through a long thread is the ordinary
 * case and each click is one request: sixty a minute is far more than a
 * person produces and far less than a script does. Backed by the shared
 * Postgres store under its own name, like every other limiter here, so the
 * budget is per address across every machine rather than per process.
 *
 * passOnStoreError, like the other read-side limiters: a database that cannot
 * answer the limiter must not be what takes the button down. routes/auth.ts
 * is the one that fails closed, and it says why.
 */
const commentsReadRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  // An object, not a string: comments.js reads the reason off `error` in a
  // JSON body, and a plain-text one made it fall through to a generic
  // message that does not say why. An object is right here and only here,
  // because this endpoint answers nothing but that script's fetch — the
  // posting limiter below also answers ordinary form posts, and needs a
  // handler instead.
  message: { error: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
  store: new PostgresRateLimitStore("comments-read"),
  passOnStoreError: true,
  // ...and says so through utils/logger.ts rather than the library's
  // own console fallback — see rateLimitLogger.
  logger: rateLimitLogger,
});

/**
 * Next batch of older top-level comments, rendered ready to prepend.
 * Threads can run to thousands of comments, so the page ships one batch and
 * fetches the rest only if the reader asks for them.
 */
router.get("/:gameId", commentsReadRateLimit, async (req, res, next) => {
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
      // Nothing to send back, and two quite different reasons for it: the
      // reader has reached the end of a real thread, or the id names no game
      // at all. They used to be answered identically — 200 with an empty
      // batch — so "/comments/999999" was a success, and a crawler walking
      // made-up ids was told every one of them exists. The lookup is paid
      // only here, on the request that has already found nothing, rather than
      // on every click of the button.
      if (!(await Game.findById(gameId))) {
        res.status(404).json({ error: "Game not found" });
        return;
      }

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
    // next(error), not a 500 of this route's own. The handler in app.ts logs
    // it once, with the request attached, and answers in JSON here because
    // utils/expects-json.ts knows GET /comments/:gameId is a JSON endpoint —
    // so the client still reads the reason off `error`, and the log line
    // gains the method, the path and the stack this catch was throwing away.
    // Every other route in this file already hands its errors over.
    next(error);
  }
});

/**
 * Refuses a comment post the way the client that sent it can read.
 *
 * Every refusal below used to be `res.status(n).json({ error })`, whichever
 * client had asked. public/js/comments.js reads exactly that, so for it
 * nothing changes — but views/comments/comment-form.ejs also submits as an
 * ordinary form when scripts are off, and that visitor was shown the raw text
 * `{"error":"Invalid parent comment"}` as a whole document, with no way back
 * and the browser offering to re-post it on reload. The success path had
 * already been taught to tell the two apart; the four failure paths had not.
 *
 * The limiter's refusal comes through here too, and was the last one that
 * did not: it had an object `message` and no handler, so express-rate-limit
 * sent that object as the body of every 429 — the same raw JSON page, for the
 * eleventh comment in five minutes. See commentRateLimit.
 *
 * The page is views/400.ejs with the reason on it — the same answer
 * validations/comments.ts gives a rejected form, so a visitor with scripts off
 * gets one consistent refusal whichever check turns them away. The status is
 * the caller's, not fixed at 400: a 404, a 409 or a 429 still says what
 * happened, and the view reads as a bad request either way.
 *
 * A flash and a redirect would be the other shape, and it is the wrong one
 * here: middlewares/flash.ts only renders for a logged-in admin, and the
 * people posting comments are neither.
 */
function refuseComment(
  req: express.Request,
  res: express.Response,
  status: number,
  message: string,
): void {
  if (isJsonRequest(req)) {
    res.status(status).json({ error: message });
    return;
  }

  res.status(status).render("400", { noindex: true, message });
}

const commentRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 10,
  /**
   * A handler rather than a `message`, so the refusal is negotiated like
   * every other one this POST can give — see refuseComment.
   *
   * The object `message` this replaces was right for comments.js, which
   * reads the reason off `error`, and wrong for the same form submitted
   * without JavaScript: express-rate-limit sends a message as it is, so that
   * visitor was shown `{"error":"Too many comments, please try again
   * later."}` as a page.
   *
   * The status is the limiter's own (429), and the RateLimit-* and
   * Retry-After headers are already on the response by the time this runs —
   * the library sets them before it calls a handler — so answering here
   * changes the body and nothing else.
   */
  handler: (req, res, _next, options) => {
    refuseComment(
      req,
      res,
      options.statusCode,
      "Too many comments, please try again later.",
    );
  },
  standardHeaders: true,
  legacyHeaders: false,
  // The library's default, stated rather than inherited: it is also the
  // unit a comment's source is recorded at, so that one source is exactly
  // one budget — see SOURCE_IPV6_SUBNET. Changing one without the other
  // would let a single budget spread its comments over several sources.
  ipv6Subnet: SOURCE_IPV6_SUBNET,
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
        refuseComment(req, res, 400, "Invalid parent comment");
        return;
      }

      resolvedParentId = parent.id;
    }

    // The address goes to the model, which records a hash of it and nothing
    // more — see commentSource in models/comment.ts, and the moderation
    // routes above that use it.
    const comment = await Comment.create({
      nick: nick || "anonymous",
      content,
      gameId,
      parentId: resolvedParentId,
      ip: req.ip,
    });

    // The form works without JavaScript, and the two paths want different
    // answers to the same POST.
    //
    // public/js/comments.js sends a JSON body and pastes the response
    // straight into the thread, so it gets the rendered fragment it has
    // always got. A browser submitting views/comments/comment-form.ejs on
    // its own sends the form encoding — and handing *that* a bare <article>
    // leaves the visitor staring at one unstyled comment on a blank page,
    // with no way back and the browser offering to re-post it on reload.
    //
    // isJsonRequest rather than a bare req.is("json"), so this and the
    // refusals above agree about who sent the request — the two used to
    // disagree, and a form post got a redirect on success and a JSON body on
    // every failure. It is the same predicate utils/expects-json.ts now
    // answers POST /comments with, which is what makes a refused CSRF check
    // land on the 403 page rather than on a line of JSON.
    //
    // Redirect rather than flash: middlewares/flash.ts only renders for a
    // logged-in admin, and the people posting comments are neither. The
    // fragment identifier does the work instead — the new comment is on the
    // page the visitor lands on, and #comments puts them at the thread.
    if (!isJsonRequest(req)) {
      const game = await Game.findById(gameId);

      // #comments and not #comment-<id>: the thread is paged, so a new
      // comment is not necessarily in the batch the game page renders, and a
      // fragment that matches nothing lands the visitor back at the top.
      //
      // A game that vanished between the insert and this lookup is not worth
      // a 500 on a comment that was stored successfully.
      res.redirect(303, game ? `/${game.slug}#comments` : "/");
      return;
    }

    res.render("comments/comment-item", {
      comment,
      isReply: !!resolvedParentId,
    });
  } catch (error) {
    // The parent first, because it is the narrower claim. The check above
    // confirms the parent exists and belongs to this game, and a moderator
    // deleting it between that read and the insert makes Postgres refuse the
    // row — on "comments_parentId_fkey", which used to be reported as "Game
    // not found" because both violations share one SQLSTATE. The game is
    // perfectly fine in that case; the comment being answered is not.
    //
    // 409 rather than 404: the address the reply was posted to still exists,
    // and the client's own remedy is to reload the thread, not to conclude
    // the page has gone.
    if (isMissingParentCommentError(error)) {
      refuseComment(
        req,
        res,
        409,
        "That comment was removed — please reload and try again",
      );
      return;
    }

    if (isMissingGameError(error)) {
      refuseComment(req, res, 404, "Game not found");
      return;
    }

    // Handed over rather than answered here, like every other route in this
    // file: app.ts logs it with the request attached and picks the page or
    // the JSON body from utils/expects-json.ts, which now negotiates this
    // path — so a form post gets the 500 page and comments.js still gets an
    // object. This catch used to do both jobs itself and got the second one
    // wrong for half its callers.
    next(error);
  }
});

export default router;
