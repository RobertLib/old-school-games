import { type Request, type Response, type NextFunction } from "express";
import { parseId } from "../utils/ids.ts";

/**
 * The comment form posts over fetch and expects either the rendered comment
 * or a reason it was rejected. Redirecting a failed validation, as this used
 * to, handed the browser a whole HTML page — fetch followed the redirect and
 * the client pasted the entire document into the thread as if it were the
 * new comment.
 */
function reject(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

/** What the "nick" column holds — see 0010_add_nick_to_comment.sql. */
const NICK_MAX_LENGTH = 255;

/** What the form asks the writer to stay under. */
const CONTENT_MAX_LENGTH = 1000;

export const validateComment = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const { nick, content, gameId, parentId } = req.body;

  // "nick[]=a&nick[]=b" arrives as an array, and reaching for .length or
  // .trim() on it threw — a 500 for what is only a malformed form post.
  if (nick !== undefined && nick !== null && typeof nick !== "string") {
    return reject(res, "Invalid nick");
  }

  if (typeof content !== "string" || content.trim().length === 0) {
    return reject(res, "Content is required");
  }

  // Measured on what the writer actually typed, which is what the form's own
  // counter shows them.
  if (content.length > CONTENT_MAX_LENGTH) {
    return reject(res, "Content is too long");
  }

  // Markup and script URLs, not the bare words. The previous pattern matched
  // "data:" anywhere, so an ordinary sentence — "no data: found" — was
  // rejected as an attack. DOMPurify strips whatever survives this anyway;
  // the check exists to refuse the obvious cases outright.
  if (/<\s*script\b|javascript\s*:|data\s*:\s*text\/html/i.test(content)) {
    return reject(res, "Invalid content detected");
  }

  // Stored exactly as it was typed. Every view renders a comment through
  // EJS's escaping <%= %>, which is what makes it safe to display, so running
  // it through DOMPurify first — as this used to — escaped it a second time:
  // someone writing "<3" had "&lt;3" stored, and the page then showed them
  // the literal text "&lt;3". See 0023_unescape_comment_entities.sql for the
  // rows that were written while that was happening.
  const trimmedNick = (nick ?? "").trim();

  if (trimmedNick.length > NICK_MAX_LENGTH) {
    return reject(res, "Nick is too long");
  }

  // Content that is nothing but markup — "<iframe></iframe>" — clears the
  // checks above and would be stored as a comment with nothing in it. Tags
  // are dropped for this test only, never from what gets stored: doing it to
  // the stored value would eat the "< b >" out of an ordinary "a < b > c".
  if (content.replace(/<[^>]*>/g, "").trim().length === 0) {
    return reject(res, "Content is required");
  }

  req.body.nick = trimmedNick;
  req.body.content = content;

  // Written back as numbers. parseInt used to accept "5abc" as 5 and then let
  // the original string travel on to Postgres, which rejected it as a bad
  // integer — a 500 where the request deserved this 400.
  const numericGameId = parseId(gameId);

  if (numericGameId === null) {
    return reject(res, "Invalid game ID");
  }

  req.body.gameId = numericGameId;

  if (parentId !== undefined && parentId !== null && parentId !== "") {
    const numericParentId = parseId(parentId);

    if (numericParentId === null) {
      return reject(res, "Invalid parent comment");
    }

    req.body.parentId = numericParentId;
  } else {
    req.body.parentId = null;
  }

  next();
};
