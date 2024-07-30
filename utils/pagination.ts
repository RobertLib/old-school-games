import { firstQueryValue } from "./query.ts";
import {
  META_DESCRIPTION_MAX,
  fitTitle,
  truncateAtWord,
} from "./html-text.ts";

const MAX_PAGE = 10000;

/**
 * Digits only, and nothing else.
 *
 * Number() is too forgiving to decide this: it read "1e3" as 1000 and " 5 " as
 * 5, so one page was reachable under endlessly many addresses — each a 200
 * serving identical content, all of them crawlable from a link somebody wrote
 * by hand. Every other id and index in this codebase is already tested this
 * way (parseId, the year route, the gallery index); this was the one spot
 * left over.
 *
 * A leading "+", a leading zero and a decimal point are all refused for the
 * same reason: "?page=01" and "?page=1" are the same page and should not be
 * two addresses.
 */
const CANONICAL_PAGE = /^[1-9]\d*$/;

export function parsePageParam(value: unknown): number {
  const rawValue = firstQueryValue(value);

  if (rawValue === undefined) {
    return 1;
  }

  if (!CANONICAL_PAGE.test(rawValue)) {
    return 1;
  }

  // Still checked: the pattern above admits a run of digits far longer than a
  // number can hold, and Number() answers Infinity for it.
  const page = Number(rawValue);

  if (!Number.isInteger(page) || page < 1) {
    return 1;
  }

  return Math.min(page, MAX_PAGE);
}

/**
 * The brand every title on the site ends with, in the two spellings the
 * routes use: "… | OldSchoolGames" and "… - OldSchoolGames.eu".
 */
const BRAND_SUFFIX = /\s+[|\u2013-]\s+OldSchoolGames(\.eu)?$/;

/**
 * Numbers a paged listing's <title>.
 *
 * Page 2 of a listing used to be served under exactly the title and meta
 * description of page 1 — every genre, letter, developer, publisher, year,
 * news and curated-list page, and the homepage — and routes/sitemap.ts submits
 * every one of those addresses. So the sitemap advertised several hundred URLs
 * whose only distinguishing feature, as far as a title is concerned, was that
 * they had none: duplicate titles across a paginated set are what a site audit
 * reports and what makes a crawler treat the deeper pages as near-copies of
 * the first.
 *
 * The number goes *before* the brand rather than after it, so the sentence
 * still ends where a reader expects it to — "Classic MS-DOS Action Games –
 * Play Free Online – Page 2 | OldSchoolGames", not "… | OldSchoolGames – Page
 * 2". A title that does not end in the brand (none do today) simply takes the
 * marker on the end, which is the same thing minus the tidiness.
 *
 * The marker costs nine characters, and a title written to sit just inside
 * TITLE_MAX on page 1 is over it on page 2 — which is how the genre listings
 * came to be 68 characters deep in their own pagination while their first
 * pages were a comfortable 59. The lead is what gives way, because it is the
 * only part here that can: the number is the whole point of the marker, and
 * the brand is what a result is recognised by.
 */
export function paginatedTitle(title: string, page: number): string {
  if (page <= 1) return title;

  const brand = BRAND_SUFFIX.exec(title);

  if (!brand) return fitTitle(title, [` \u2013 Page ${page}`]);

  const marker = ` \u2013 Page ${page}${brand[0]}`;

  return fitTitle(title.slice(0, brand.index), [marker]);
}

/**
 * The same for the meta description, where the marker leads instead.
 *
 * A description is cut to META_DESCRIPTION_MAX and several of the ones this is
 * handed already sit at that limit, so a marker appended to the end is the
 * first thing a re-truncation would take off again. At the front it survives,
 * and it is nine characters — the sentence it precedes keeps essentially all
 * of its room.
 *
 * Page 1 is cut to the same limit, which it used to be exempt from. That
 * exemption was invisible and backwards: the routes that compose a
 * description from a template — the genre pages, the letter pages, the
 * developer fallback — never passed it through truncateAtWord themselves, so
 * the *only* thing holding them to META_DESCRIPTION_MAX was this function, and
 * this function let page 1 through untouched. The result was that
 * "/letter/a?page=2" carried a correctly cut 114-character description while
 * "/letter/a" — the page that actually ranks — carried 207, and every genre
 * page sat around 175. Every literal those routes pass in has since been
 * rewritten to fit, so nothing is expected to be cut here; this is the
 * guarantee that a future edit cannot quietly go over again.
 */
export function paginatedDescription(
  description: string,
  page: number,
): string {
  if (page <= 1) return truncateAtWord(description, META_DESCRIPTION_MAX);

  return truncateAtWord(`Page ${page}: ${description}`, META_DESCRIPTION_MAX);
}

/**
 * Whether `page` is past the end of a listing that holds `total` rows.
 *
 * The listing routes all answer a page with nothing on it with a 404, and they
 * used to work that out from the page itself: run the query, see no rows, call
 * next(). parsePageParam admits anything up to MAX_PAGE, so "?page=9999" made
 * every one of them aggregate the whole filtered set and OFFSET 249950 rows
 * into it before deciding the address does not exist — ten thousand such
 * addresses per listing, each one a query a crawler can ask for by following a
 * link somebody wrote by hand.
 *
 * The row count is cheap and the routes already have it, so the guard can come
 * first and the listing query can be skipped altogether. Page 1 is never out
 * of range: an empty first page is a listing with nothing in it, which each
 * route decides about for itself — some of them are a 404 and some are not.
 */
export function isPageBeyondTotal({
  page,
  limit,
  total,
}: {
  page: number;
  limit: number;
  total: number;
}): boolean {
  return page > 1 && (page - 1) * limit >= total;
}

/**
 * How many pages a listing of `total` rows runs to at `limit` per page.
 *
 * At least one page even when nothing matched, so an empty listing reports
 * "page 1 of 1" rather than "page 1 of 0" — views/pagination.ejs would
 * otherwise have a current page number above its own total to reason about.
 *
 * There were three copies of `Math.max(1, Math.ceil(total / limit))` — here,
 * in News.findAll and in the comments overview — which is exactly the shape a
 * fix reaches one of and leaves the other two behind.
 *
 * A limit of zero or less is treated as one rather than allowed to produce
 * Infinity or a negative count. Nothing passes such a limit today; this is so
 * that a caller which computes one cannot turn a bad page size into a
 * pagination widget offering an unbounded number of pages.
 */
export function totalPages(total: number, limit: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, limit)));
}

/** The three paging links a listing page puts in its <head>. */
export interface PaginationUrls {
  canonicalUrl: string;
  prevPageUrl: string | undefined;
  nextPageUrl: string | undefined;
}

/**
 * Builds the canonical, prev and next addresses for a paged listing.
 *
 * `nextPageUrl` is derived from the row count rather than from whether the
 * current page came back full, which is the distinction the nine copies of
 * this that grew up around the routes all got wrong: "this page holds `limit`
 * games" and "another page follows" are the same thing only when the total is
 * not an exact multiple of the page size. With 25 games and 25 to a page,
 * every one of those routes emitted <link rel="next"> pointing at ?page=2 —
 * which every one of them then answered with a 404, because a page with
 * nothing on it is not a page. views/pagination.ejs had already been taught to
 * count; the <head> hint the crawlers actually follow had not.
 *
 * Page 1 is addressed as the bare `baseUrl`, never as "?page=1": the two would
 * otherwise be two addresses for one page, which is the same duplicate-content
 * trap parsePageParam above refuses "?page=01" for.
 */
export function paginationUrls({
  baseUrl,
  page,
  total,
  limit,
}: {
  baseUrl: string;
  page: number;
  total: number;
  limit: number;
}): PaginationUrls {
  const pageUrl = (target: number): string =>
    target === 1 ? baseUrl : `${baseUrl}?page=${target}`;

  // At least one page even when nothing matched, so an empty listing
  // advertises no next page — see totalPages above, which the routes and
  // News.findAll now share with this.
  const pages = totalPages(total, limit);

  return {
    canonicalUrl: pageUrl(page),
    prevPageUrl: page > 1 ? pageUrl(page - 1) : undefined,
    nextPageUrl: page < pages ? pageUrl(page + 1) : undefined,
  };
}
