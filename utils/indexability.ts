import type { Request } from "express";

/**
 * Whether a page asks search engines to leave it out of the index.
 *
 * The decision used to live inside views/head.ejs, which is the only place
 * that needed it: one variable there drives both the robots tag and whether a
 * canonical and a breadcrumb are emitted at all, and the comment on it
 * reasons at length about why those three cannot be allowed to disagree.
 *
 * They have company now. Every listing view also writes a JSON-LD node of its
 * own — a WebPage wrapping an ItemList, a CollectionPage — and those were
 * emitted unconditionally, so a noindex search result still described itself
 * as a page worth understanding while the tag beside it said not to bother.
 * Nothing breaks from that, but it is bytes sent on every filtered request for
 * a consumer that has been told to go away, and more to the point it is the
 * same decision being made twice in two files.
 *
 * A view reads `locals` and `req` exactly as head.ejs does (app.ts puts the
 * request on res.locals), so both callers can ask the one question here.
 *
 * The three query parameters are what produce a near-duplicate of a page that
 * already exists: a search is a slice of the catalogue that no crawler should
 * file separately, and a sort is the same games in a different order. An empty
 * `?search=` stays indexable — it renders the unfiltered listing and
 * canonicalises to it.
 */
export function isNoindex(
  req: Pick<Request, "query"> | undefined,
  locals: { noindex?: unknown } | undefined,
): boolean {
  if (locals?.noindex) return true;

  const query = req?.query;

  if (!query) return false;

  return Boolean(query.search || query.orderBy || query.orderDir);
}
