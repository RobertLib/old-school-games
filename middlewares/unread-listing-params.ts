import { type Request, type Response, type NextFunction } from "express";
import { hasQueryParam, rawQueryWithout } from "../utils/query.ts";

/**
 * The parameters utils/indexability.ts judges every page by: a search and a
 * sort. Any page carrying one is marked noindex, and views/head.ejs drops the
 * canonical with it.
 */
export const LISTING_PARAMS: readonly string[] = [
  "search",
  "orderBy",
  "orderDir",
];

/**
 * A 301 onto `path` without the listing parameters, for a page that reads
 * none of them.
 *
 * The listings that ignore a search, the curated lists, /news and /comments
 * already answer this way (see NOT_READ_BY_A_LISTING in routes/home.ts and
 * IGNORED_LISTING_PARAMS in routes/lists.ts). The pages with no listing at
 * all did not: "/about?orderBy=title" served /about whole, as a noindex page
 * naming no canonical to consolidate onto. That is a near-duplicate of an
 * indexed page that a crawler can only find from an outside link, and the
 * answer is the one those routes give: a redirect says where the page is and
 * leaves nothing to judge.
 *
 * The path is the route's own, written by its caller, never req.path: a
 * Location built from what the request sent is how an open redirect starts
 * (a backslash survives encodeurl, and a browser reads "/\host" as "//host").
 * The rest of the query goes along as it arrived — see rawQueryWithout.
 */
export function redirectUnreadListingParams(path: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!hasQueryParam(req, LISTING_PARAMS)) return next();

    res.redirect(301, `${path}${rawQueryWithout(req, LISTING_PARAMS)}`);
  };
}
