import { type Request, type Response, type NextFunction } from "express";
import { parseId } from "../utils/ids.ts";
// The same sanitizer Game.serialize stores descriptions through, used here
// only to measure what the column will receive — see DESCRIPTION_MAX_LENGTH.
import { sanitizeHtml } from "../utils/sanitize-html.ts";

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
 * Rejects an address whose scheme is neither http nor https — a
 * "javascript:" or "data:" value would be written straight into an href or
 * src. A relative path carries no scheme and is fine: the artwork is served
 * either from this origin or from MEDIA_ORIGIN (see utils/site.ts), and
 * img-src allows exactly those two.
 */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/**
 * A protocol-relative address: "//example.com/x.png", which a browser
 * resolves against the *page's* scheme and fetches from example.com.
 *
 * It carries no scheme for SCHEME above to find, so it used to be waved
 * through as a relative path — and it is not one. What that cost differed by
 * field: for "images" the CSP's img-src refuses the foreign origin, so the
 * artwork silently did not load; for "manual" it is an ordinary href and the
 * link simply went to somebody else's site; "stream" is fetched by the player
 * under connect-src, which refuses it too. None of them is what an admin
 * typing a path meant, and a check that accepts an address it cannot fetch is
 * worse than one that says so.
 *
 * Checked separately from SCHEME rather than folded into it, because the two
 * refuse different things and the messages below name a path on this site as
 * the alternative — which is what the author of a "//host/…" value wanted.
 */
const PROTOCOL_RELATIVE = /^\/\//;

function hasSafeScheme(value: string): boolean {
  if (PROTOCOL_RELATIVE.test(value)) return false;

  const match = SCHEME.exec(value);

  if (!match) return true;

  const scheme = match[1]!.toLowerCase();

  return scheme === "http" || scheme === "https";
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

  // Four inputs share the name, so express gives an array. A single filled
  // input would arrive as a bare string, which the TEXT[] column rejects.
  const rawImages = Array.isArray(data.images)
    ? data.images
    : data.images === undefined
      ? []
      : [data.images];

  if (rawImages.some((image) => typeof image !== "string")) {
    errors.push({ field: "images", message: "Invalid image address" });
  } else {
    // Trimmed before the scheme check, not merely for the emptiness test
    // beside it. hasSafeScheme reads the scheme off the front of the string,
    // so a value led by whitespace — "\njavascript:alert(1)" — carried no
    // scheme it could see and was waved through as a relative path. A browser
    // strips exactly that whitespace before resolving the address, which is
    // what made the check skippable. "manual" below was always trimmed first;
    // only the images were not.
    const images = (rawImages as string[]).map((image) => image.trim());

    if (images.some((image) => image !== "" && !hasSafeScheme(image))) {
      errors.push({
        field: "images",
        message: "Image addresses must be http(s) or a path on this site",
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

  if (manual && !hasSafeScheme(manual)) {
    errors.push({
      field: "manual",
      message: "Manual must be an http(s) address or a path on this site",
    });
  }

  normalized.manual = manual;

  // Checked like the addresses above, which it was not: "stream" is written
  // into the player's src as "/js-dos.html?stream=…" and fetched from there,
  // so it is the same kind of value and deserves the same refusal.
  const stream = asString(data.stream).trim();

  if (stream && !hasSafeScheme(stream)) {
    errors.push({
      field: "stream",
      message: "Stream must be an http(s) address or a path on this site",
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
