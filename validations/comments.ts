import { type Request, type Response, type NextFunction } from "express";
import { parseId } from "../utils/ids.ts";

/**
 * The comment form posts over fetch and expects either the rendered comment
 * or a reason it was rejected. Redirecting a failed validation, as this used
 * to, handed the browser a whole HTML page — fetch followed the redirect and
 * the client pasted the entire document into the thread as if it were the
 * new comment.
 *
 * The same form also submits as an ordinary POST when scripts are off (see
 * views/comments/comment-form.ejs), and a browser shown `{"error":...}` as a
 * page is no better than one shown a pasted document. That path gets the 400
 * page with the reason on it; the content type tells the two apart, the same
 * test routes/comments.ts uses to choose between fragment and redirect.
 */
function reject(req: Request, res: Response, message: string): void {
  if (!req.is("json")) {
    res.status(400).render("400", { noindex: true, message });
    return;
  }

  res.status(400).json({ error: message });
}

/** What the "nick" column holds — see 0010_add_nick_to_comment.sql. */
const NICK_MAX_LENGTH = 255;

/** What the form asks the writer to stay under. */
const CONTENT_MAX_LENGTH = 1000;

/**
 * Names nobody may post under.
 *
 * The field is free text and nothing anywhere marks a comment as official, so
 * "admin" or "Robert Libsansky" beside a comment reads as the site saying it —
 * which is the whole value of impersonating one. There is no account behind a
 * comment to check against, so a denylist is all that is available; it is
 * deliberately short, because every name on it is a name a real visitor cannot
 * use either.
 *
 * Compared lower-cased and with internal whitespace collapsed, so
 * "Old  School   Games" and " ADMIN " are the same entries — otherwise the
 * list refuses exactly one spelling of each and advertises the rest.
 */
const RESERVED_NICKS = new Set([
  "admin",
  "administrator",
  "moderator",
  "staff",
  "oldschoolgames",
  "old school games",
  "robert libsansky",
]);

function isReservedNick(nick: string): boolean {
  return RESERVED_NICKS.has(nick.toLowerCase().replace(/\s+/g, " "));
}

export const validateComment = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const { nick, content, gameId, parentId } = req.body;

  // "nick[]=a&nick[]=b" arrives as an array, and reaching for .length or
  // .trim() on it threw — a 500 for what is only a malformed form post.
  if (nick !== undefined && nick !== null && typeof nick !== "string") {
    return reject(req, res, "Invalid nick");
  }

  if (typeof content !== "string" || content.trim().length === 0) {
    return reject(req, res, "Content is required");
  }

  // Measured on what the writer actually typed, which is what the form's own
  // counter shows them.
  if (content.length > CONTENT_MAX_LENGTH) {
    return reject(req, res, "Content is too long");
  }

  // No pattern check on the text. One used to refuse anything matching
  // "<script", "javascript:" or "data:text/html", and so turned away a reader
  // recommending "JavaScript: The Good Parts" with "Invalid content
  // detected". It bought nothing: the content is rendered through <%= %>
  // only (below), which escapes the markup a script tag would need, and a
  // "javascript:" in plain text is just text. A check that a comment must
  // pass and cannot be told the reason for is a bug report waiting to happen.
  //
  // Stored exactly as it was typed. Every view renders a comment through
  // EJS's escaping <%= %>, which is what makes it safe to display, so running
  // it through DOMPurify first — as this used to — escaped it a second time:
  // someone writing "<3" had "&lt;3" stored, and the page then showed them
  // the literal text "&lt;3". See 0023_unescape_comment_entities.sql for the
  // rows that were written while that was happening.
  const trimmedNick = (nick ?? "").trim();

  if (trimmedNick.length > NICK_MAX_LENGTH) {
    return reject(req, res, "Nick is too long");
  }

  // Said plainly rather than as "Invalid nick": a visitor who happens to be
  // called Robert Libsansky deserves to know what the objection is.
  if (isReservedNick(trimmedNick)) {
    return reject(req, res, "That nick is reserved — please choose another");
  }

  // Content that is nothing but markup — "<iframe></iframe>" — clears the
  // checks above and would be stored as a comment with nothing in it. Tags
  // are dropped for this test only, never from what gets stored: doing it to
  // the stored value would eat the "< b >" out of an ordinary "a < b > c".
  if (content.replace(/<[^>]*>/g, "").trim().length === 0) {
    return reject(req, res, "Content is required");
  }

  req.body.nick = trimmedNick;
  req.body.content = content;

  // Written back as numbers. parseInt used to accept "5abc" as 5 and then let
  // the original string travel on to Postgres, which rejected it as a bad
  // integer — a 500 where the request deserved this 400.
  const numericGameId = parseId(gameId);

  if (numericGameId === null) {
    return reject(req, res, "Invalid game ID");
  }

  req.body.gameId = numericGameId;

  if (parentId !== undefined && parentId !== null && parentId !== "") {
    const numericParentId = parseId(parentId);

    if (numericParentId === null) {
      return reject(req, res, "Invalid parent comment");
    }

    req.body.parentId = numericParentId;
  } else {
    req.body.parentId = null;
  }

  next();
};
