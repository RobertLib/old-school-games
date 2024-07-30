import { SITE_URL } from "./site.ts";

/**
 * One step of a breadcrumb trail.
 *
 * `path` is site-relative and is omitted on the last item: the page a visitor
 * is already on is not a link, and schema.org's BreadcrumbList says the same —
 * the final ListItem carries a name and no `item`.
 *
 * Relative rather than absolute, because these are rendered as real hrefs. The
 * canonical-host redirect in app.ts is production-only, so an absolute address
 * here would send anyone browsing a development or staging build back out to
 * the live site. breadcrumbLdJson below absolutises them, which is the one
 * place schema.org requires it.
 */
export interface Breadcrumb {
  name: string;
  path?: string;
}

/**
 * The step every trail on the site starts from.
 *
 * Shared, because two kinds of page build a trail and both begin here:
 * buildBreadcrumbs below derives one from a page's locals, and the pages whose
 * path is fixed rather than derived — the curated lists, /most-played,
 * /developers, /publishers, /years, /news, /about, /how-to-play — state theirs
 * in their route. routes/lists.ts declared a private copy of this for the
 * first three of those, which is one literal per group of callers and one
 * chance each for a trail to start at "Homepage", or to link somewhere that
 * is not "/".
 *
 * Copy it before putting it in a trail (`{ ...HOME_CRUMB }`) anywhere the
 * array may be handed to buildBreadcrumbs' own last-step handling, which
 * deletes the `path` of whatever ends up last.
 */
export const HOME_CRUMB: Breadcrumb = { name: "Home", path: "/" };

/**
 * "ACTION" and "action" both become "Action".
 *
 * The genre reaches this from two directions and in two spellings: the detail
 * page has `game.genre`, which is the enum as stored and so upper case, while
 * a listing page has `req.params.genre`, which is whatever the visitor typed
 * in the address bar — /action, /Action and /ACTION all answer 200 (see the
 * case-insensitive check in routes/home.ts). Neither is a label.
 */
function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

/**
 * The trail for whatever page is being rendered, derived from its locals.
 *
 * One function rather than two descriptions of the same trail, which is what
 * this replaces. The visible breadcrumb lived in views/breadcrumb.ejs and the
 * BreadcrumbList schema was built by hand in routes/home.ts and routes/news.ts,
 * and the two did not agree: the markup rendered `game.genre` raw, so a
 * visitor read "Home › ACTION › Doom" while the JSON-LD beside it claimed
 * "Home › Action Games › Doom". Google asks that structured data describe what
 * is actually on the page, and two authors of one sentence is how that drifts.
 *
 * It also closes the other half of that gap. views/breadcrumb.ejs carried
 * branches for the genre, letter, developer, publisher and year listings —
 * written, and then included by nothing but the game detail view, so those
 * pages showed no trail at all and emitted no schema for one. They render both
 * now, from here.
 *
 * Every branch is independent and additive, because the listings do not nest:
 * a page is a genre listing or a year listing, never both.
 */
export function buildBreadcrumbs(
  locals: Record<string, unknown>,
): Breadcrumb[] {
  // A copy of HOME_CRUMB, not the constant itself: the last step of a trail
  // has its `path` deleted further down, and on a page with no branch to add
  // — every page that reaches this without a trail of its own — "Home" is
  // that last step. Sharing the object would have unlinked the crumb for
  // every page rendered afterwards in the same process.
  const crumbs: Breadcrumb[] = [{ ...HOME_CRUMB }];

  const str = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;

  const genre = str(locals.genre);
  const letter = str(locals.letter);
  const developer = str(locals.developer);
  const publisher = str(locals.publisher);
  // The year route renders a number, so this one is not a string.
  const year =
    typeof locals.year === "number" || typeof locals.year === "string"
      ? String(locals.year)
      : undefined;

  if (genre) {
    crumbs.push({
      name: `${titleCase(genre)} Games`,
      path: `/${genre.toLowerCase()}`,
    });
  }

  if (letter) {
    crumbs.push({
      name: `Games starting with '${letter.toUpperCase()}'`,
      path: `/letter/${letter.toLowerCase()}`,
    });
  }

  if (developer) {
    crumbs.push({ name: "Developers", path: "/developers" });
    crumbs.push({
      name: developer,
      path: `/developer/${encodeURIComponent(developer)}`,
    });
  }

  if (publisher) {
    crumbs.push({ name: "Publishers", path: "/publishers" });
    crumbs.push({
      name: publisher,
      path: `/publisher/${encodeURIComponent(publisher)}`,
    });
  }

  if (year) {
    crumbs.push({ name: "Years", path: "/years" });
    crumbs.push({ name: year, path: `/year/${year}` });
  }

  const game = locals.game as { title?: string; genre?: string } | undefined;

  if (game?.title) {
    // The genre step above is keyed off a `genre` local, which the detail
    // route does not pass — it passes the game, and the genre is on that.
    if (game.genre) {
      crumbs.push({
        name: `${titleCase(game.genre)} Games`,
        path: `/${game.genre.toLowerCase()}`,
      });
    }

    crumbs.push({ name: game.title });
  }

  const newsItem = locals.newsItem as { title?: string } | undefined;

  if (newsItem?.title) {
    crumbs.push({ name: "News", path: "/news" });
    crumbs.push({ name: newsItem.title });
  }

  // Whatever the last step is, it is the current page and so not a link. The
  // branches above cannot all know whether they are last.
  const last = crumbs[crumbs.length - 1];

  if (last) delete last.path;

  return crumbs;
}

/**
 * The same trail as schema.org BreadcrumbList.
 *
 * Returns null for a trail that is nothing but "Home": a one-item breadcrumb
 * describes no path and Google ignores it, so there is no reason to ship it on
 * every page on the site.
 */
export function breadcrumbLdJson(
  crumbs: Breadcrumb[],
): Record<string, unknown> | null {
  if (crumbs.length < 2) return null;

  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      // Absolute here and only here: `item` is an address a crawler resolves
      // without a document to resolve it against.
      ...(crumb.path ? { item: `${SITE_URL}${crumb.path}` } : {}),
    })),
  };
}
