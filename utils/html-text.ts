/**
 * Plain text out of the HTML that descriptions are stored as.
 *
 * Game descriptions and news articles are run through DOMPurify before they
 * are stored, which serialises them as HTML: an ampersand the author typed is
 * kept as "&amp;". Rendering that back out with <%- %> is correct, but every
 * place that derives *plain* text from it — the meta description, og:
 * description, JSON-LD, the two RSS feeds, the collection JSON — used to
 * strip the tags and stop there, and then escaped the result a second time on
 * the way out. A description reading "Sam & Max" reached Google and every
 * feed reader as "Sam &amp; Max".
 *
 * The same flattening was written out by hand at five call sites, which is
 * how the gallery page came to slice raw markup straight into a meta
 * description without stripping anything at all.
 */

/**
 * The named entities HTML serialisation produces, plus numeric references.
 *
 * Nothing else needs a table: DOMPurify decodes named entities while it
 * parses and writes the character itself back out, so "&eacute;" never
 * survives into storage as an entity in the first place. An entity this does
 * not know is left exactly as written rather than guessed at.
 */
const NAMED_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
};

const ENTITY_PATTERN = /&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#[xX][0-9a-fA-F]+);/g;

/**
 * One pass, deliberately: "&amp;lt;" decodes to the text "&lt;" and not to
 * "<". Each match is consumed where it is found and the replacement is never
 * rescanned, which is what keeps an escaped entity escaped.
 */
export function decodeEntities(text: string): string {
  return text.replace(ENTITY_PATTERN, (entity) => {
    const named = NAMED_ENTITIES[entity];

    if (named !== undefined) return named;

    // "&#" and the trailing ";" are the only things left to strip; the
    // pattern above has already established the rest is digits.
    const body = entity.slice(2, -1);
    const isHex = body[0] === "x" || body[0] === "X";
    const code = parseInt(isHex ? body.slice(1) : body, isHex ? 16 : 10);

    // A reference past the end of Unicode, or naming half of a surrogate
    // pair, is not a character String.fromCodePoint can build — it throws,
    // and a malformed description is not worth a 500.
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return entity;
    if (code >= 0xd800 && code <= 0xdfff) return entity;

    return String.fromCodePoint(code);
  });
}

/**
 * Plain text made safe to be read as HTML — the way back from what
 * htmlToPlainText returns.
 *
 * For the one consumer that takes plain text and renders it as markup: an
 * RSS 2.0 <description>, which feed readers treat as HTML (see
 * routes/feed.ts). The text there has had its entities decoded, so an author's
 * escaped "&lt;Enter&gt;" is a live "<Enter>" by now; without this it is
 * handed to the reader as a tag, and the words vanish.
 *
 * All five characters, as EJS's <%= %> escapes them, so the result is safe in
 * an attribute as well as in element content. "&" goes first: escaping it
 * after the others would rewrite the ampersands they had just introduced.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The inside of a tag, read through its quoted attribute values rather than
 * up to the first ">". DOMPurify serialises a ">" inside an attribute as it
 * is — it escapes "&" and the quote there, not ">" — so `<img alt="Doom >
 * Quake">`, which sanitize-html.ts lets through untouched, ended the tag at
 * the ">" in the alt text and left `Quake">` in every meta and og
 * description, the JSON-LD, the RSS feed and the listing summaries built from
 * it. It keeps a "<" there as it is, too, which matters for MARKUP below.
 */
const TAG_BODY = `(?:[^>"']|"[^"]*"|'[^']*')*`;

/**
 * The elements whose content is never drawn as text, so a summary must not
 * print it either.
 *
 * Only the tags used to go, and the text between them stayed: a description
 * holding `<p>Hello <script>alert(2)</script> x</p><style>body{}</style>`
 * reached every listing card, the news excerpts on / and /news, and both RSS
 * feeds as "Hello alert(2) x body{}". Such rows exist — Game.findBySlug and
 * News.findBySlug sanitise on read because of the ones that bypassed the
 * model — and their own detail pages, sanitised, read "Hello x". Nothing was
 * executable (every one of those outputs is escaped); it was code shown to a
 * reader as the pitch for a game.
 *
 * The list is the part of DOMPurify's FORBID_CONTENTS that can stand in a
 * body, because what sanitize-html.ts renders is the page a summary has to
 * agree with: those are the elements it throws away *with* their content, so
 * the page shows none of it. <noscript> is on DOMPurify's list and not here,
 * deliberately — sanitising keeps its text, so the page shows it. <object>'s
 * fallback text is shown too, and <textarea>'s and <option>'s, so they stay
 * ordinary tags whose text is kept.
 */
const NON_TEXT_ELEMENTS = [
  "audio",
  "iframe",
  "math",
  "noembed",
  "noframes",
  "script",
  "style",
  "svg",
  "template",
  "title",
  "video",
  "xmp",
];

/**
 * Everything that is markup rather than text, matched in one pass and in
 * document order: a comment, a non-text element together with its content,
 * or any other tag.
 *
 * One pattern rather than one after another, because the order a browser
 * reads things in is what decides which is which. `<a title="<script>">link</a>`
 * is a link — the "<script>" is inside a quoted value, which DOMPurify keeps
 * as written — and a script pattern run ahead of the tag pattern found it
 * there and ate the rest of the description looking for an end tag. Scanning
 * left to right, the <a> is matched whole before the quote is ever looked
 * inside; likewise a "<script>" inside a comment is part of the comment.
 *
 * - A comment runs to "-->" (or "--!>", which HTML also accepts), and "<!-->"
 *   and "<!--->" are complete empty ones. Unclosed, it runs to the end, as it
 *   does in a browser. The tag pattern used to stop at its first ">", so
 *   `<!-- <b>x</b> -->` left "x -->" in the text.
 * - An element runs to its end tag — `</script foo>` still ends a script —
 *   and, unclosed, to the end of the document: a browser reads everything
 *   after an unclosed <script> as script. `\b` after the name keeps <scripts>
 *   and <titles> ordinary tags.
 * - Case-insensitive, as HTML is; the backreference follows the flag, so
 *   <SCRIPT> is closed by </script>.
 */
const MARKUP = new RegExp(
  [
    "<!--(?:-?>|[\\s\\S]*?(?:--!?>|$))",
    `<(${NON_TEXT_ELEMENTS.join("|")})\\b${TAG_BODY}>[\\s\\S]*?(?:<\\/\\1(?:[\\s/][^>]*)?>|$)`,
    `<${TAG_BODY}>`,
  ].join("|"),
  "gi",
);

/**
 * Flattens stored description HTML to the plain text the meta tags, the feeds
 * and the JSON endpoints all want.
 *
 * A tag or a non-text element becomes a space rather than nothing, so
 * "<p>a</p><p>b</p>" does not come out as "ab". A comment becomes nothing,
 * because it never separates anything: "a<!-- x -->b" is drawn as "ab".
 * Entities are decoded afterwards and never before: the other order would
 * turn an author's literal "&lt;script&gt;" back into a tag and then strip
 * the text out of the middle of it.
 */
export function htmlToPlainText(html: string | null | undefined): string {
  if (!html) return "";

  return (
    decodeEntities(
      html.replace(MARKUP, (markup) => (markup.startsWith("<!--") ? "" : " ")),
    )
      .replace(/\s+/g, " ")
      // Tags are replaced by a space, which otherwise leaves gaps like
      // "shooter ." where an inline tag closed before the punctuation.
      .replace(/\s+([.,;:!?)])/g, "$1")
      .replace(/(\()\s+/g, "$1")
      .trim()
  );
}

/**
 * How much of a description a search engine will show, and so how far every
 * meta description on the site is cut.
 *
 * It lives beside truncateAtWord because every caller pairs the two.
 * routes/home.ts kept it as a constant of its own while routes/news.ts wrote
 * 160 into the single call it makes, so an article's description was cut five
 * characters further than a game's — a difference nobody had decided on, and
 * one that a comment in home.ts had already drifted out of step with.
 */
export const META_DESCRIPTION_MAX = 155;

/**
 * How far a prose field of a JSON-LD node is cut — a `description` on the
 * VideoGame and NewsArticle nodes, a `text` on the Comment ones.
 *
 * Not the same budget as META_DESCRIPTION_MAX above, and deliberately so: a
 * meta description is cut to what a search result will show, while this one
 * feeds a consumer that reads the whole field — so there is room for a real
 * paragraph, and 500 characters is the length the three call sites had already
 * settled on independently.
 *
 * Written down here because that agreement was a coincidence rather than a
 * decision. routes/home.ts spelled 500 twice and routes/news.ts once, each as
 * a bare literal, and two of the three reached it by `slice` — which cuts
 * mid-word, the very thing truncateAtWord below exists to stop and which the
 * comment on META_DESCRIPTION_MAX argues against for the visible half of the
 * same pair. The Comment node was the one that already cut on a word
 * boundary, so it is the shape the other two were brought into line with.
 */
export const LD_TEXT_MAX = 500;

/**
 * Cuts `text` to at most `maxLength` characters on a word boundary, adding an
 * ellipsis when anything was dropped.
 *
 * A bare slice reads as a typo in a search result — "…the best classic st" —
 * and the several copies of this that grew up around the routes did not agree
 * on whether to add the ellipsis at all.
 */
export function truncateAtWord(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");

  // No space to break on means one very long word; a hard cut is all that is
  // left, and it still beats returning the whole thing.
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

/**
 * How much of a <title> a search engine will show.
 *
 * The counterpart to META_DESCRIPTION_MAX above, and it was the half that had
 * no constant: the game page reasoned out a budget in a comment ("target ~60
 * chars total") and then set a cap that allowed 75, the news page applied no
 * cap at all — an article title of 109 characters reached Google whole — and
 * the listing titles were hand-written literals nobody measured. So the one
 * number every one of them was aiming at was written down nowhere.
 *
 * Google's limit is a pixel width rather than a character count, and 60 is
 * the usual approximation of it. Erring on the low side is deliberate: a
 * title cut by Google is cut mid-word with no ellipsis, while one cut here
 * keeps its brand suffix and reads as a finished sentence.
 */
export const TITLE_MAX = 60;

/**
 * How long an Article `headline` may be before Google starts cutting it.
 *
 * Longer than TITLE_MAX above because the two are measured by different
 * consumers: a <title> is cut to the width of a blue link, while a headline
 * feeds the Article rich result, which has more room. 110 is the ceiling
 * Google has documented for the field, and it still asks for a concise one on
 * the grounds that long headlines are truncated on small screens.
 *
 * The news page had a cap on one half of that pair and not the other.
 * routes/news.ts passes every article title through fitTitle for the <title>
 * — its comment works through a 109-character example and why the brand has
 * to survive the cut — and then handed the same untouched title straight to
 * `headline`, where nothing measured it at all. The titles on the site run to
 * 90 characters and more, so the field was one ordinary editorial decision
 * away from costing the rich result it exists to earn.
 */
export const HEADLINE_MAX = 110;

/**
 * A page title that fits, preferring to drop decoration before it drops the
 * name of the thing the page is about.
 *
 * `suffixes` are tried in order, richest first: a game page offers
 * " - Play Online - OldSchoolGames" and then the bare " - OldSchoolGames", so
 * a short name keeps the whole phrase and a long one gives up the marketing
 * clause rather than its own title. Only when even the shortest suffix does
 * not fit is `name` itself cut — which is the last thing worth losing, since
 * it is what a searcher typed.
 *
 * The suffix is never truncated, so every title still ends in the brand.
 */
export function fitTitle(name: string, suffixes: [string, ...string[]]): string {
  for (const suffix of suffixes) {
    if (name.length + suffix.length <= TITLE_MAX) return name + suffix;
  }

  const shortest = suffixes[suffixes.length - 1];

  // One character short of the budget, because truncateAtWord appends an
  // ellipsis and so returns up to maxLength + 1. Asking it for the whole
  // budget would put every cut title one character over the limit this
  // function exists to keep.
  return truncateAtWord(name, TITLE_MAX - shortest.length - 1) + shortest;
}
