import type { Request } from "express";
import { firstQueryValue } from "./query.ts";

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
 * canonicalises to it — and so does one that is only whitespace, because
 * routes/home.ts trims the term before deciding what to render: "?search=%20"
 * is that same unfiltered listing, and answering "noindex" for it would have
 * the tag disagree with the page.
 *
 * Each value is read through firstQueryValue, which is how every route reads
 * it. A repeated key arrives as an array, and this used to test the raw value:
 * "/?search=&search=doom" is an array, and so truthy, while the route searches
 * for its first value — the empty one — and renders the plain homepage. The
 * page said one thing and the robots tag another, and with the tag saying
 * noindex head.ejs dropped the canonical too. "?orderBy=&orderBy=title" did
 * the same to an unsorted listing. Whatever the route will act on is what this
 * has to judge, so it reads the same value the same way.
 */
export function isNoindex(
  req: Pick<Request, "query"> | undefined,
  locals: { noindex?: unknown } | undefined,
): boolean {
  if (locals?.noindex) return true;

  const query = req?.query;

  if (!query) return false;

  const search = firstQueryValue(query.search)?.trim();
  const orderBy = firstQueryValue(query.orderBy);
  const orderDir = firstQueryValue(query.orderDir);

  return Boolean(search || orderBy || orderDir);
}
