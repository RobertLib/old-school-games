import { type Request, type Response, type NextFunction } from "express";
import { parseId } from "../utils/ids.ts";
// The same sanitizer Game.serialize stores descriptions through, used here
// only to measure what the column will receive — see DESCRIPTION_MAX_LENGTH.
import { sanitizeHtml } from "../utils/sanitize-html.ts";
// The two origins the page loads artwork and game bundles from — the same
// constants the Content-Security-Policy in app.ts is built out of. See
// LOADABLE_ORIGINS.
import { MEDIA_ORIGIN, SITE_URL } from "../utils/site.ts";

export const validateGameRating = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  // parseId, not parseInt: the latter reads "5abc" as 5, so the check passed
  // and the raw string went on to Postgres as a bad integer — a 500 for a
  // request that should simply have been refused here.
  if (parseId(req.params.id) === null) {
    res.status(400).json({ error: "Invalid game ID" });
    return;
  }

  // Strict for the same reason the id above is: parseInt reads whatever
  // prefix looks numeric and ignores the rest, so it coerced "3.9" to 3 and
  // — because it stringifies its argument first — took "rating[]=3&rating[]=4"
  // as 3 as well. A vote is a whole number or it is not a vote.
  const { rating } = req.body;

  const numericRating =
    typeof rating === "number"
      ? rating
      : typeof rating === "string" && /^\d+$/.test(rating)
        ? Number(rating)
        : NaN;

  if (
    !Number.isInteger(numericRating) ||
    numericRating < 1 ||
    numericRating > 5
  ) {
    res.status(400).json({ error: "Rating must be between 1 and 5" });
    return;
  }

  // Hand the route a number, so the value it stores and echoes back is not a
  // string like "5".
  req.body.rating = numericRating;

  next();
};

export interface ValidationError {
  field: string;
  message: string;
}

/** What the "title", "developer" and "publisher" columns hold. */
const TEXT_MAX_LENGTH = 255;

/**
 * What a game description may run to once stored, matching the limit news
 * content has had all along.
 *
 * "description" was the one field this function checked nothing about: no
 * length, no trim, and — unlike every other field — it was never written back
 * either. The column is TEXT, so nothing downstream refused a paste of any
 * size: it went through DOMPurify on every save and into the detail page in
 * full.
 *
 * Measured on the sanitized value for the same reason validations/news.ts
 * does it: sanitizing *grows* a string, so a description measured raw could
 * pass here and be stored several times longer.
 */
const DESCRIPTION_MAX_LENGTH = 10000;

// The catalogue is MS-DOS, which did not exist before this and stopped
// getting new releases long before the upper bound. Wide enough not to argue
// with a genuine entry, narrow enough to catch a typo like 19993.
const RELEASE_MIN = 1970;
const RELEASE_MAX = new Date().getFullYear() + 1;

/**
 * The scheme an absolute address opens with. Only http and https are
 * addresses here — a "javascript:" or "data:" value would be written straight
 * into an href or src.
 */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/**
 * C0 controls and DEL. A browser's URL parser strips tab and newline from
 * anywhere in the string and leading C0 controls from the front before it
 * looks for a scheme, so "java\nscript:alert(1)" — which SCHEME above does
 * not match, the scheme having a newline in it — is "javascript:alert(1)" by
 * the time an href is followed. No real address carries one.
 */
// eslint-disable-next-line no-control-regex -- the control characters are the point
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * A backslash, anywhere.
 *
 * The URL parser in every browser — and the one absoluteUrl() in
 * utils/site.ts uses — reads a backslash in an http(s) address as a slash. So
 * "\\host/x", "/\host/x" and "\/host/x" were each a *protocol-relative*
 * address by the time anything followed them, https://host/x, while this file
 * waved them through as paths on this site because none of them starts with
 * "//". They were stored and rendered as an off-site href and an off-site
 * og:image. A real address never needs one — RFC 3986 has no place for it
 * unescaped, and a path that contains one is written %5C.
 */
const BACKSLASH = /\\/;

/**
 * A path on this site, written from the root: exactly one leading "/".
 *
 * Two are a protocol-relative address — "//example.com/x.png", resolved
 * against the page's scheme and fetched from example.com — which used to be
 * accepted as a path for having no scheme to refuse. None is a path relative
 * to *whichever page prints it*: "images/doom.png" resolved to
 * /doom/gallery/images/doom.png on the gallery, and the sitemap, which built
 * <image:loc> by concatenation, published "https://oldschoolgames.euimages/…".
 * Backslashes are refused before this is asked; see BACKSLASH.
 */
function isSitePath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//");
}

/**
 * The value as an absolute http(s) URL, or null when it is not one.
 *
 * Parsed with the same WHATWG parser a browser uses, which is the point: the
 * origin read off the result is the origin a browser would fetch from, however
 * the value spells it — "https://media.example.com@evil.example/" is
 * evil.example, and a check on the string's prefix would have said otherwise.
 */
function parseHttpUrl(value: string): URL | null {
  const scheme = SCHEME.exec(value)?.[1]?.toLowerCase();

  if (scheme !== "http" && scheme !== "https") return null;

  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** An origin as the URL parser normalises it, or null for a malformed one. */
function originOf(address: string): string | null {
  try {
    return new URL(address).origin;
  } catch {
    return null;
  }
}

/**
 * Where the page will actually load artwork and a game bundle from, besides a
 * path on this site.
 *
 * MEDIA_ORIGIN, because it is the other source the page's img-src and the
 * player's connect-src both allow — and public/js/js-dos-player.js refuses a
 * bundle from any origin but its own and that one before it hands anything to
 * the emulator. And SITE_URL, because every page in production is served from
 * that origin (app.ts redirects every other host to it), so a full address on
 * it is exactly the same file as the path: 'self' in img-src, and the
 * player's own origin. An admin pasting one out of the address bar should not
 * be told it is somewhere else.
 *
 * Normalised through the parser, so a trailing slash or an upper-case host in
 * the environment variable compares equal to what an address resolves to.
 */
const LOADABLE_ORIGINS = new Set(
  [originOf(MEDIA_ORIGIN), originOf(SITE_URL)].filter(
    (origin): origin is string => origin !== null,
  ),
);

/**
 * An address a link may point at: a path on this site, or http(s) anywhere.
 * What "manual" is — an href, which the page never loads itself.
 */
function isLinkAddress(value: string): boolean {
  if (CONTROL_CHARS.test(value) || BACKSLASH.test(value)) return false;

  return isSitePath(value) || parseHttpUrl(value) !== null;
}

/**
 * An address the page itself will load: a path on this site, or an absolute
 * one on one of LOADABLE_ORIGINS.
 *
 * "images" and "stream" used to take any http(s) host, as a link does, and
 * neither is a link. The artwork is an <img>, and img-src refused a foreign
 * host — a broken image, reported nowhere but the browser console. The stream
 * is fetched by the player, which refused it and left a blank emulator. Both
 * were accepted here and failed on the page, which is the worst place for an
 * address to be found wrong; this refuses them where the admin can see why.
 *
 * Credentials are refused too: a browser will not send a subresource request
 * whose address carries a username or password, whichever host it names.
 */
function isLoadableAddress(value: string): boolean {
  if (CONTROL_CHARS.test(value) || BACKSLASH.test(value)) return false;

  if (isSitePath(value)) return true;

  const url = parseHttpUrl(value);

  if (!url || url.username || url.password) return false;

  return LOADABLE_ORIGINS.has(url.origin);
}

/** A form field that should be a single string, whatever the request claims. */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Checks what the admin form posts before it reaches the model.
 *
 * Game.create and Game.update used to be handed req.body directly, so the
 * only thing standing between a typo and a stack trace was Postgres: a
 * missing genre threw out of validate() and a title over 255 characters was
 * refused by the column, both arriving as the 500 page with the admin's work
 * gone. News has had this for a while; games did not.
 *
 * `genres` is the live enum, so a value outside it is caught here instead of
 * reaching the database as a failed cast.
 *
 * Every field is checked on its trimmed value and then *written back* in that
 * form, so what the model stores is what this approved. Only `images` used to
 * be written back, which left two ways for a value this function had already
 * passed to reach Postgres and fail there anyway:
 *
 *   - a "release" of "   " cleared the emptiness test below, because that
 *     test trims, and then reached the INTEGER column as whitespace;
 *   - a "genre" of "action" cleared the enum test, because that test
 *     uppercases, and then reached GAME_GENRE in lower case.
 *
 * Both came back as "invalid input syntax" — the 500 page, with the admin's
 * entry gone, which is the exact failure this function exists to prevent.
 */
export function validateGame(
  data: Record<string, unknown>,
  genres: string[],
): ValidationError[] {
  const errors: ValidationError[] = [];

  /**
   * What each field will be stored as. Applied in one place at the end rather
   * than as each check passes, so a value cannot be written back over the
   * admin's own input on a request that is going to be refused anyway — the
   * form is re-rendered from req.body.
   */
  const normalized: Record<string, unknown> = {};

  const title = asString(data.title).trim();

  // The leading whitespace used to survive into the column: Postgres trims
  // only the *trailing* spaces when it casts to varchar. A title stored as
  // "  Doom" renders with the gap and sorts before the whole catalogue in
  // findAdjacentGames, which orders on LOWER("title").
  normalized.title = title;

  if (!title) {
    errors.push({ field: "title", message: "Title is required" });
  } else if (title.length > TEXT_MAX_LENGTH) {
    errors.push({
      field: "title",
      message: `Title cannot be longer than ${TEXT_MAX_LENGTH} characters`,
    });
  }

  // Trimmed and written back like every other field. A description is
  // optional — plenty of entries have none — so only its length is checked.
  // The bound applies to the sanitized form, which is what the column
  // actually receives; sanitizeHtml is called here for the measurement only,
  // because Game.serialize sanitizes on the way in and is the one place that
  // should decide what gets stored.
  const description = asString(data.description).trim();

  normalized.description = description;

  if (sanitizeHtml(description).length > DESCRIPTION_MAX_LENGTH) {
    errors.push({
      field: "description",
      message: `Description cannot be longer than ${DESCRIPTION_MAX_LENGTH} characters`,
    });
  }

  const genre = asString(data.genre).trim();

  if (!genre) {
    errors.push({ field: "genre", message: "Genre is required" });
  } else if (!genres.includes(genre.toUpperCase())) {
    errors.push({ field: "genre", message: "Unknown genre" });
  }

  // Upper case, which is the form the check above accepts it in and the form
  // the GAME_GENRE enum holds. The form posts the enum values as they come
  // off getGenres(), so this changes nothing for it — it is the hand-made
  // request that used to pass here and then be refused by the column.
  normalized.genre = genre.toUpperCase();

  // An empty release is allowed — plenty of entries have no year recorded —
  // and the model turns a blank one into NULL.
  const release = asString(data.release).trim();

  normalized.release = release;

  if (release) {
    if (!/^\d+$/.test(release)) {
      errors.push({ field: "release", message: "Release must be a year" });
    } else {
      const year = Number(release);

      if (year < RELEASE_MIN || year > RELEASE_MAX) {
        errors.push({
          field: "release",
          message: `Release must be between ${RELEASE_MIN} and ${RELEASE_MAX}`,
        });
      }
    }
  }

  for (const field of ["developer", "publisher"] as const) {
    const value = asString(data[field]).trim();

    if (value.length > TEXT_MAX_LENGTH) {
      errors.push({
        field,
        message: `Cannot be longer than ${TEXT_MAX_LENGTH} characters`,
      });
    }

    // Trimmed on the way in, because these two are matched with "=" by the
    // developer and publisher pages: a stored " id Software" is a studio of
    // its own as far as getDevelopers() and every link built from it are
    // concerned, sitting beside the real one in the list.
    normalized[field] = value;
  }

  // Several inputs share the name — one per stored image, plus a spare, and
  // never fewer than four (see views/games/game-form.ejs) — so express gives
  // an array. A single filled input would arrive as a bare string, which the
  // TEXT[] column rejects.
  const rawImages = Array.isArray(data.images)
    ? data.images
    : data.images === undefined
      ? []
      : [data.images];

  if (rawImages.some((image) => typeof image !== "string")) {
    errors.push({ field: "images", message: "Invalid image address" });
  } else {
    // Trimmed before the address check, not merely for the emptiness test
    // beside it. The check reads the scheme off the front of the string, so
    // a value led by whitespace — "\njavascript:alert(1)" — carried no scheme
    // it could see and was waved through as a relative path. A browser strips
    // exactly that whitespace before resolving the address, which is what
    // made the check skippable. "manual" below was always trimmed first; only
    // the images were not.
    const images = (rawImages as string[]).map((image) => image.trim());

    // Loadable, not merely http(s): each of these becomes an <img> — see
    // isLoadableAddress.
    if (images.some((image) => image !== "" && !isLoadableAddress(image))) {
      errors.push({
        field: "images",
        message: `Image addresses must be a path on this site or an address on ${MEDIA_ORIGIN}`,
      });
    } else {
      // Written back, so the model stores the array this just validated rather
      // than the shape the request happened to use: a lone "images=..." —
      // which express hands over as a bare string — used to be approved here
      // and then reach the TEXT[] column as a string, coming back as
      // "malformed array literal". The trimmed values go back too, so what is
      // stored is what was checked.
      normalized.images = images;
    }
  }

  const manual = asString(data.manual).trim();

  // Any http(s) host, which the artwork and the bundle may not have: the
  // manual is an ordinary link, and the page never loads it. A path still has
  // to be a path on this site — see isSitePath.
  if (manual && !isLinkAddress(manual)) {
    errors.push({
      field: "manual",
      message: "Manual must be an http(s) address or a path on this site",
    });
  }

  normalized.manual = manual;

  // Checked like the images above, which it once was not at all: "stream" is
  // written into the player's src as "/js-dos.html?stream=…" and fetched from
  // there, so it is a value the page loads and deserves the same refusal —
  // the player refuses every other origin, and an address accepted here
  // became a game that never starts.
  const stream = asString(data.stream).trim();

  if (stream && !isLoadableAddress(stream)) {
    errors.push({
      field: "stream",
      message: `Stream must be a path on this site or an address on ${MEDIA_ORIGIN}`,
    });
  }

  normalized.stream = stream;

  if (errors.length === 0) {
    for (const [field, value] of Object.entries(normalized)) {
      // Only the fields the request actually sent. serialize() writes just the
      // columns it finds on the object, so inventing a key here would clear
      // that column on any update whose form did not carry the field — an
      // edit form posting no "images" would wipe the artwork.
      if (field in data) data[field] = value;
    }
  }

  return errors;
}
