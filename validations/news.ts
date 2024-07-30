import { sanitizeHtml } from "../utils/sanitize-html.ts";
import { htmlToPlainText } from "../utils/html-text.ts";

/**
 * Whether an article would be published blank: nothing left after the
 * sanitiser that a reader would see — no text, and no picture. An article that
 * is only an image is a real article, so an <img> surviving counts.
 */
function isEmptyOnceSanitized(content: string): boolean {
  const sanitized = sanitizeHtml(content);

  return htmlToPlainText(sanitized).length === 0 && !/<img\b/i.test(sanitized);
}

interface NewsValidationData {
  title?: string;
  content?: string;
}

interface ValidationError {
  field: string;
  message: string;
}

/** What the "title" column holds. */
const TITLE_MAX_LENGTH = 255;

/** What an article may run to once stored — the same bound games use. */
const CONTENT_MAX_LENGTH = 10000;

export function validateNews(data: NewsValidationData): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!data.title || typeof data.title !== "string") {
    errors.push({ field: "title", message: "Title is required" });
  } else if (data.title.trim().length === 0) {
    errors.push({ field: "title", message: "Title cannot be empty" });
  } else if (data.title.trim().length > TITLE_MAX_LENGTH) {
    errors.push({
      field: "title",
      message: `Title cannot be longer than ${TITLE_MAX_LENGTH} characters`,
    });
  }

  if (!data.content || typeof data.content !== "string") {
    errors.push({ field: "content", message: "Content is required" });
  } else if (data.content.trim().length === 0) {
    errors.push({ field: "content", message: "Content cannot be empty" });
  } else if (isEmptyOnceSanitized(data.content)) {
    // The raw text is not what gets stored. Content that is nothing but
    // markup the sanitiser removes — an <iframe>, a <script>, an empty
    // <p></p> — passed the test above and was published as an article with
    // no body at all. The comment form has had the equivalent check for a
    // while (see validations/comments.ts).
    errors.push({
      field: "content",
      message: "Content cannot be empty — nothing in it would be displayed",
    });
  } else if (sanitizeHtml(data.content).length > CONTENT_MAX_LENGTH) {
    // Measured on the sanitized form, which is what the column actually
    // receives: sanitizing *grows* a string — DOMPurify turns each "<" into
    // "&lt;" — so content measured raw could pass here and be stored several
    // times longer. Sanitized here for the measurement only; News.create and
    // News.update are the ones that decide what gets stored, exactly as
    // Game.serialize does for a game description.
    errors.push({
      field: "content",
      message: `Content cannot be longer than ${CONTENT_MAX_LENGTH} characters`,
    });
  }

  return errors;
}

/**
 * Trims what the form posted and guarantees both fields are strings.
 *
 * This used to sanitize as well, and was called sanitizeNews for that reason
 * — which meant an article went through DOMPurify twice on its way into the
 * database: once here, and once more in News.create/News.update, which
 * sanitize because a model should not depend on its caller having done so
 * (see the comment there, and serialize in models/game.ts). DOMPurify is
 * idempotent over its own output so nothing was corrupted by it, but it left
 * news as the odd one out: for a game description the validator measures the
 * sanitized length and stores the raw value, and the model is the single place
 * the transformation happens. News now works the same way, so there is one
 * answer to "where does markup get cleaned" rather than two.
 *
 * Typed rather than merely truthy: "title[]=a&title[]=b" arrives as an array,
 * and reaching for .trim() on it threw — a 500 for what is only a malformed
 * form post. validateNews then reports the empty string as a missing field.
 */
export function normalizeNews(data: NewsValidationData): {
  title: string;
  content: string;
} {
  return {
    title: typeof data.title === "string" ? data.title.trim() : "",
    content: typeof data.content === "string" ? data.content.trim() : "",
  };
}
