import { type Request, type Response, type NextFunction } from "express";
import { isJsonRequest } from "../utils/expects-json.ts";
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
 * page with the reason on it.
 *
 * isJsonRequest, not the bare req.is("json") this used to call. The two
 * disagree on a fetch() that sets `Accept: application/json` without sending a
 * JSON body — req.is() sees only the content type — and everything else that
 * answers a POST /comments already asks isJsonRequest: the route's own
 * refusals and its success path (routes/comments.ts), and the CSRF refusal
 * above them (middlewares/csrf.ts, through expectsJson). Two predicates for
 * one endpoint is how the halves drifted apart last time, and
 * utils/expects-json.ts already names this file as the one that got it right.
 */
function reject(req: Request, res: Response, message: string): void {
  if (!isJsonRequest(req)) {
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
 * Compared through normalizeNick below, which folds case, Unicode
 * compatibility forms, whitespace, punctuation and zero-width characters away
 * — so "Old  School   Games", " ADMIN ", "admin." and an "ADMIN" with a
 * trailing U+200B are all the same entry. Otherwise the list refuses exactly
 * one spelling of each and advertises the rest.
 *
 * What no folding can see is the order the characters are drawn in, so the
 * characters that change it are refused before the comparison is ever made —
 * see BIDI_CONTROL.
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

/**
 * A nick reduced to the letters and digits it is made of, for comparison only.
 *
 * Lower-casing and collapsing whitespace was the whole of this, and it refused
 * one spelling of each name while advertising the rest. Every one of these
 * walked straight past it and rendered as the site talking:
 *
 *   - "admin." / "-admin-" / "_admin_" — punctuation reads as nothing at all
 *     beside a name, so the list has to see through it.
 *   - "ADMIN" with a trailing U+200B — a zero-width space is not whitespace
 *     to /\s/ in JavaScript, so it survived the collapse *and* is invisible
 *     to a reader. Same for the zero-width non-joiner, joiner and word joiner.
 *   - "ADMIN" written with the fullwidth forms "ＡＤＭＩＮ", or with the
 *     ligature and compatibility characters Unicode is full of. NFKC folds
 *     those onto their ordinary equivalents; NFC, the usual choice, does not.
 *
 * Order matters: NFKC first, because it is what turns a compatibility
 * character into the letter the class below keeps, then the strip.
 *
 * What this deliberately does not do is confusable folding, and the limitation
 * is worth writing down rather than discovering: "аdmin" with a Cyrillic а
 * (U+0430) is a letter, so it survives normalisation and is not on the list.
 * Refusing it needs a script-mixing check or a confusables table (UTS #39),
 * which is a dependency and a much larger decision — and the denylist is a
 * deterrent against the obvious rather than a guarantee, because there is no
 * account behind a comment to check against at all. If impersonation by
 * homoglyph becomes a real problem here, the answer is a verified identity on
 * a comment, not a longer table.
 */
function normalizeNick(nick: string): string {
  return (
    nick
      .normalize("NFKC")
      .toLowerCase()
      // The characters Unicode itself says to render as nothing, dropped
      // before the letter test below — because some of them *are* letters.
      // The Hangul fillers (U+3164, U+FFA0, U+115F, U+1160) are category Lo,
      // so the class below kept them, and they draw as blank space:
      // "adminㅤ" and "RobertㅤLibsansky" were accepted and displayed as the
      // names this list exists to protect. Default_Ignorable_Code_Point covers
      // those along with the zero-width joiners and the soft hyphen. Dropping
      // them costs a real name nothing even where it does use one — the
      // non-joiner is part of Persian spelling — because this is only what a
      // nick is compared as, never what is stored.
      //
      // The text-direction controls are in this class as well, and dropping
      // them here is exactly what let "\u202enimda" through as "nimda" while
      // it was drawn as "admin". They never reach this any more: see
      // BIDI_CONTROL, which refuses them first.
      .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
      // Everything that is not a letter or a digit, which takes the spaces,
      // the punctuation and the zero-width characters in one pass. \p{L} and
      // \p{N} rather than [a-z0-9] so an accented or non-Latin name is not
      // flattened into something it is not — "Ölaf" must not become "laf" and
      // collide with a future entry.
      .replace(/[^\p{L}\p{N}]/gu, "")
  );
}

/**
 * The list, normalised the same way, so an entry written with a space in it
 * ("old school games") still matches what normalizeNick produces.
 */
const NORMALIZED_RESERVED_NICKS = new Set(
  [...RESERVED_NICKS].map(normalizeNick),
);

function isReservedNick(nick: string): boolean {
  return NORMALIZED_RESERVED_NICKS.has(normalizeNick(nick));
}

/**
 * The characters that change the order a line of text is drawn in: Unicode's
 * Bidi_Control property, which is exactly twelve — the embeddings and
 * overrides (U+202A–U+202E), the isolates (U+2066–U+2069) and the three
 * directional marks (U+200E, U+200F, U+061C).
 *
 * Refused outright rather than folded into normalizeNick, because folding is
 * how they got through. normalizeNick drops them with every other
 * default-ignorable, so "\u202enimda" was compared as "nimda" — nowhere on the
 * list — and stored as sent, and the browser then drew a right-to-left
 * override followed by "nimda", which reads "admin": in the h3 over the
 * comment, on /comments, and in the Latest comments sidebar on every page.
 * "\u202eyksnasbil trebor" read "robert libsansky". The spoof is in the order
 * the characters are drawn in rather than in any one of them, so no
 * comparison of the characters can see it; refusing the ones that reorder is
 * the whole of the fix.
 *
 * <bdi> around the nick would not have been one. An isolate stops the nick
 * reordering what is around it, but an override inside the isolate still
 * applies inside it — and inside is where the name is.
 *
 * All twelve, the marks included. A mark cannot reorder letters on its own,
 * but all it ever does in a nick is nudge digits and punctuation about, and
 * "no text-direction characters" is a rule that fits in the one sentence of a
 * refusal. No real name needs any of them: an Arabic or a Hebrew name takes
 * its direction from its own letters.
 */
const BIDI_CONTROL = /\p{Bidi_Control}/u;

/**
 * A character that draws something.
 *
 * Anything but a default-ignorable (the zero-width characters, the Hangul
 * fillers, the soft hyphen), whitespace of any kind, a control character, or
 * U+2800 — the blank Braille cell, a symbol rather than a space, and the
 * character a "blank" name is usually made of. \p{White_Space} rather than
 * \s, which leaves out U+0085; so does trim(), which is why the check cannot
 * lean on it.
 */
const VISIBLE = /[^\p{Default_Ignorable_Code_Point}\p{White_Space}\p{Cc}\u2800]/u;

export const validateComment = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const { nick, gameId, parentId } = req.body;

  // "nick[]=a&nick[]=b" arrives as an array, and reaching for .length or
  // .trim() on it threw — a 500 for what is only a malformed form post.
  if (nick !== undefined && nick !== null && typeof nick !== "string") {
    return reject(req, res, "Invalid nick");
  }

  if (
    typeof req.body.content !== "string" ||
    req.body.content.trim().length === 0
  ) {
    return reject(req, res, "Content is required");
  }

  // Line breaks as one character each, before anything is measured — and
  // stored that way too. The textarea's maxlength counts a line break as one,
  // which is what the writer sees, but a form submitted without JavaScript
  // sends it as CRLF: two. So a thousand characters with twenty line breaks
  // arrived as 1,020 and were refused as "too long" by a form that had just
  // let the writer type them. The fetch path sends the textarea's own value,
  // which is LF already, so this changes nothing for it.
  const content = req.body.content.replace(/\r\n?/g, "\n");

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
  //
  // Nor are the text-direction controls refused in the text, as they are in
  // the nick below. The body is drawn in a block of its own —
  // div.comment-content, on the game page and on /comments — and the bidi
  // algorithm ends every embedding, override and isolate at the end of its
  // paragraph: an override in the body reorders the body, which its writer
  // controls anyway, and cannot reach the nick above it or anything else on
  // the page. The only other place the text goes is the JSON-LD, which
  // nothing draws.
  const trimmedNick = (nick ?? "").trim();

  // First, before anything reads the nick — see BIDI_CONTROL. Said as what
  // to do about it: the characters are invisible, so "Invalid nick" would
  // leave the visitor looking at a name that seems perfectly fine.
  if (BIDI_CONTROL.test(trimmedNick)) {
    return reject(
      req,
      res,
      "That nick contains invisible text-direction characters — please type it again without them",
    );
  }

  // A nick with nothing visible in it is posted as no nick at all, which the
  // route stores as "anonymous". "\u3164", a Hangul filler, is a letter, so
  // it used to be stored as it was — and `comment.nick || "anonymous"` in the
  // views counts any stored nick as present: the h3 over the comment was
  // empty, the sidebar entry named nobody, and "Replying to" named no one.
  // Spaces were already treated this way, because the trim empties them;
  // what draws nothing now gets the same answer. Not a refusal: the field is
  // optional, and a visitor who pasted a blank-looking name has done nothing
  // a retry would fix.
  //
  // A nick with one visible character in it is kept exactly as typed, the
  // zero-width non-joiner and joiner included. They are how Persian keeps
  // two letters from joining — "Alireza" is written with a U+200C between
  // its halves — and how an emoji family is one glyph, so stripping them
  // would misspell a real name; and they cannot disguise one, because
  // normalizeNick compares through them.
  const storedNick = VISIBLE.test(trimmedNick) ? trimmedNick : "";

  if (storedNick.length > NICK_MAX_LENGTH) {
    return reject(req, res, "Nick is too long");
  }

  // Said plainly rather than as "Invalid nick": a visitor who happens to be
  // called Robert Libsansky deserves to know what the objection is.
  if (isReservedNick(storedNick)) {
    return reject(req, res, "That nick is reserved — please choose another");
  }

  // Content that is nothing but markup — "<iframe></iframe>" — clears the
  // checks above and would be stored as a comment with nothing in it. Tags
  // are dropped for this test only, never from what gets stored: doing it to
  // the stored value would eat the "< b >" out of an ordinary "a < b > c".
  if (content.replace(/<[^>]*>/g, "").trim().length === 0) {
    return reject(req, res, "Content is required");
  }

  req.body.nick = storedNick;
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
