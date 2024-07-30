/**
 * The one place a stored string becomes XML.
 *
 * routes/feed.ts and routes/sitemap.ts each carried an escapeXml of its own,
 * and neither did more than swap the five markup characters — which is not
 * enough to guarantee a well-formed document. XML 1.0 *forbids* the C0
 * control characters outright: unlike "&" or "<" they cannot be escaped into
 * legality, not even as a numeric reference, so the only correct handling is
 * to drop them.
 *
 * Nothing upstream does. DOMPurify keeps them (they are text, not markup),
 * htmlToPlainText keeps them, and validateGame only trims the ends of a
 * title — so a control character pasted into one game's title travelled all
 * the way into /feed.xml and every sitemap chunk that named it. The result is
 * not a malformed entry but a malformed *document*: a parser stops at the
 * disallowed byte, so one bad title cost the whole feed and every subscriber
 * and crawler reading it, not the one item.
 */

/**
 * Characters XML 1.0 has no representation for.
 *
 * Tab, newline and carriage return are the three C0 characters that are
 * legal, so they are deliberately absent here. U+FFFE and U+FFFF are
 * permanently unassigned non-characters and are refused for the same reason.
 */
const ILLEGAL_XML_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g;

/**
 * A surrogate code unit that is not part of a pair.
 *
 * A matched pair is one astral character and perfectly valid, so it must
 * survive; a half left on its own is not a character at all and cannot be
 * serialised. This is reachable from a stored value that was truncated
 * mid-pair somewhere upstream.
 */
const LONE_SURROGATES =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Drops what XML cannot carry, leaving everything it can. */
export function stripInvalidXmlChars(value: string): string {
  return value.replace(ILLEGAL_XML_CHARS, "").replace(LONE_SURROGATES, "");
}

/**
 * Makes `value` safe to place in element content or in an attribute.
 *
 * All five markup characters are escaped, not only the three element content
 * strictly needs, so the same function serves the attributes in the feed's
 * <atom:link> and anything added later without a second one growing beside
 * it. "&" goes first: escaping it after the others would rewrite the
 * ampersands they had just introduced.
 */
export function escapeXml(value: string): string {
  return stripInvalidXmlChars(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
