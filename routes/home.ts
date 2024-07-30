import express from "express";
import Game from "../models/game.ts";
import Comment from "../models/comment.ts";
import News from "../models/news.ts";
import {
  isPageBeyondTotal,
  paginatedDescription,
  paginatedTitle,
  paginationUrls,
  parsePageParam,
} from "../utils/pagination.ts";
import { firstQueryValue, rawQuery } from "../utils/query.ts";
import { parseId } from "../utils/ids.ts";
import {
  SITE_DESCRIPTION,
  SITE_TITLE,
  SITE_URL,
  absoluteUrl,
} from "../utils/site.ts";
import {
  LD_TEXT_MAX,
  META_DESCRIPTION_MAX,
  fitTitle,
  htmlToPlainText,
  truncateAtWord,
} from "../utils/html-text.ts";
import { GENRE_DATA, STUDIO_DATA, YEAR_DATA } from "../content/blurbs.ts";
import { HOW_TO_PLAY_FAQ, faqLdJson } from "../utils/faq.ts";
import { HOME_CRUMB } from "../utils/breadcrumbs.ts";
import { genreInSentence, genreLabel } from "../utils/genre-label.ts";
import {
  DIGIT_BUCKET,
  isLetterBucket,
  letterBucketHeading,
  letterBucketInSentence,
} from "../utils/letter-buckets.ts";

const router = express.Router();

const VALID_ORDER_BY_FIELDS = ["createdAt", "release", "rating", "title"];

/**
 * The sort a listing was asked for, refused with a 400 when it is not one of
 * ours.
 *
 * Every listing below used to answer next() here, which is a 404 — and that is
 * the wrong thing to say twice over. The address exists: "/action" is a page
 * whether or not "?orderBy=nonsense" follows it, so a 404 told a crawler the
 * *page* was gone and invited it back later to see whether it had returned. A
 * 400 says the request was malformed, which is the same answer the over-long
 * search on "/" already gives (see the comment there) for the same kind of
 * mistake in the same query string.
 *
 * Returns true once it has answered, so the caller stops.
 */
function refusedOrdering(
  res: express.Response,
  orderBy?: string,
  orderDir?: string,
): boolean {
  const ok =
    (!orderBy || VALID_ORDER_BY_FIELDS.includes(orderBy)) &&
    (!orderDir || ["ASC", "DESC"].includes(orderDir));

  if (ok) return false;

  res.status(400).render("400", {
    noindex: true,
    message: "That sort order is not one this listing offers",
  });

  return true;
}

/**
 * How much of that a game's own title may take in the fallback sentence the
 * detail route builds when no description is stored.
 *
 * Only an unreasonable title reaches this — the catalogue's longest are far
 * short of it — but "title" is a 255-character column, and a title that long
 * would otherwise leave no room for the sentence around it.
 */
const FALLBACK_TITLE_MAX = 80;

/**
 * The query string a "?genre=" redirect carries over: everything except the
 * genre itself.
 *
 * rawQuery for the same reason every other redirect in this file uses it —
 * re-serialising req.query does not give back what was sent — but the genre
 * has to come out of it, because the address being redirected *to* is the
 * genre. Left in, "/?genre=action&page=2" would land on
 * "/action?genre=action&page=2", a second address for a page that already has
 * one, which is the duplicate the redirect exists to collapse.
 *
 * Split on the raw pairs rather than rebuilt through URLSearchParams, which
 * would re-encode every survivor and undo the point of taking the query raw.
 *
 * The key is compared decoded, because "%67enre=action" is what reaches
 * req.query.genre and is therefore what triggers the redirect — matched raw it
 * would be carried over and the duplicate would be back. decodeURIComponent
 * throws a URIError on a malformed percent sequence ("%C3%28" is one), and
 * turning a merely malformed URL into a 500 is precisely what firstQueryValue
 * and rawQuery exist to avoid, so a key that will not decode is kept as it
 * arrived. Repeated keys all go: "?genre=a&genre=b" leaves neither behind.
 */
function queryWithoutGenre(req: express.Request): string {
  const raw = rawQuery(req).slice(1);

  if (!raw) return "";

  const kept = raw.split("&").filter((pair) => {
    const rawKey = pair.split("=")[0] ?? "";

    try {
      return decodeURIComponent(rawKey) !== "genre";
    } catch {
      return true;
    }
  });

  return kept.length > 0 ? `?${kept.join("&")}` : "";
}

router.get("/", async (req, res, next) => {
  const genre = firstQueryValue(req.query.genre);
  // Trimmed here as well as in the model. Game.find trims the term it
  // searches for, and this route did not, so "?search=%20%20" was half a
  // search: titled 'Search results for "  "' and marked noindex, above the
  // whole unfiltered catalogue. What is left once the whitespace goes is what
  // the page is about — nothing, in that case, so it is the listing.
  // utils/indexability.ts trims the same way, so the robots tag agrees.
  const search = firstQueryValue(req.query.search)?.trim() || undefined;
  const orderBy = firstQueryValue(req.query.orderBy);
  const orderDir = firstQueryValue(req.query.orderDir);

  if (genre) {
    // 301 and not the 302 this used to answer. "/?genre=action" is not a page
    // that might come back one day — the listing lives at "/action" and always
    // will — and a temporary redirect tells a crawler to keep the query URL in
    // its index and to ask again every time, which is the duplicate the
    // redirect exists to collapse. The same permanent answer the case-fold and
    // renamed-slug redirects below give, for the same reason.
    //
    // And the rest of the query comes with it. Dropping it sent
    // "/?genre=action&page=3&orderBy=rating" to "/action" — page one, default
    // sort — so a link somebody wrote by hand, or an old bookmark, silently
    // landed somewhere else. See queryWithoutGenre above for why the genre
    // itself is the one parameter that does not travel.
    //
    // Encoded, because this lands in the Location header. A genre of
    // "/evil.example.com" produced "//evil.example.com", which a browser reads
    // as a protocol-relative URL — the site's own address redirecting to
    // someone else's. Real genres are plain words, so this changes nothing
    // for them. The query is re-attached raw and after the encoded segment, so
    // nothing in it can reach the path.
    return res.redirect(
      301,
      `/${encodeURIComponent(genre.toLowerCase())}${queryWithoutGenre(req)}`,
    );
  }

  // A 400, not the 404 this used to fall through to: the page exists, the
  // request for it was malformed. The navbar caps the field at 100
  // characters, so only a hand-edited address gets here.
  if (search && search.length > 100) {
    return res.status(400).render("400", { noindex: true });
  }

  if (refusedOrdering(res, orderBy, orderDir)) return;

  const page = parsePageParam(req.query.page);
  const limit = 25;

  // Whether this request is the homepage proper — the H1, the ticker, the
  // widgets and the WebSite/Organization JSON-LD in views/index.ejs — rather
  // than a search, a re-sort or a later page of the same listing.
  //
  // Decided from what the request asks for, never from the address. The view
  // used to compare req.originalUrl with "/", so a query string that changes
  // nothing about the page (?fbclid=, ?utm_source=, ?gclid=, ?page=1) served
  // the plain listing under the homepage's canonical. Parameters this route
  // does not read are, by definition, not part of what it serves.
  const isHomepage = !search && page === 1 && !orderBy && !orderDir;

  // The count comes first, and the listing query only runs if the page it
  // would serve is in range — see isPageBeyondTotal. It costs an extra round
  // trip on a page that exists and saves the whole aggregate on one that does
  // not, of which parsePageParam admits ten thousand per address. The two
  // queries that have nothing to do with the page still go in parallel with
  // it — and only on the homepage, which is the one page that shows them.
  // They used to run for every search and every later page too, the news one
  // uncached, for widgets the view then declined to draw.
  const [total, recentNews, featuredGames] = await Promise.all([
    Game.count({ search }),
    // Recent news for the homepage, as plain-text excerpts rather than three
    // whole articles: views/news/news-preview.ejs used to render the stored
    // HTML in full and clamp it to three lines in CSS, which shipped every
    // byte and read every word out to a screen reader. 240 characters is
    // roughly what the three-line clamp shows at the widths the card is
    // rendered at, so the cut lands just past what is visible rather than
    // inside it.
    isHomepage
      ? News.findRecent(3).then((items) =>
          items.map((item) => ({
            ...item,
            excerpt: truncateAtWord(htmlToPlainText(item.content), 240),
          })),
        )
      : [],
    isHomepage ? Game.findFeatured(10) : [], // 10 random games for the carousel
  ]);

  // An out-of-range page is a 404, not an empty list, and it is refused before
  // the listing query rather than after it.
  if (isPageBeyondTotal({ page, limit, total })) {
    return next();
  }

  const games = await Game.find({ search, page, limit, orderBy, orderDir });

  // A search that found nothing gets close-title suggestions instead of a
  // dead end.
  const suggestions =
    search && total === 0 ? await Game.findTitleSuggestions(search, 5) : [];

  // The count and the listing agree on which rows match (see buildGameFilters),
  // so this can only be page 1 of a listing with nothing in it — which the
  // homepage serves rather than refuses.
  if (page > 1 && games.length === 0) {
    return next();
  }

  // Without orderBy/orderDir: a sort is noindex (see views/head.ejs) and its
  // canonical names the unsorted page.
  const { canonicalUrl, prevPageUrl, nextPageUrl } = paginationUrls({
    baseUrl: `${SITE_URL}/`,
    page,
    total,
    limit,
  });

  // og:url, for the one case where the canonical above deliberately names a
  // different page.
  //
  // `search` is left out of paginationUrls on purpose — a results page is
  // "noindex, follow" and canonicalises to the unfiltered listing it is a
  // slice of — and views/index.ejs falls back to that same canonical for
  // og:url. So a search link pasted into Slack, Facebook or Discord unfurled
  // as the *homepage*: its title, its description, its address. The one tag
  // whose whole job is to name what was shared named something else.
  //
  // The same escape hatch the gallery route uses further down, and for the
  // same reason: a page whose canonical points elsewhere still has an address
  // of its own, and og:url is where that belongs. Nothing here makes the page
  // indexable — the robots tag is untouched.
  //
  // Not `req.originalUrl`: that carries orderBy, orderDir and any other
  // parameter a visitor arrived with, and those produce a different address
  // for one shared page. Composed from the two values that identify it.
  const ogUrl = search
    ? `${SITE_URL}/?search=${encodeURIComponent(search)}` +
      (page > 1 ? `&page=${page}` : "")
    : undefined;

  // Left undefined on page 1 of an unsearched homepage, which is the one page
  // the site-wide default was written for. Page 2 has to name itself: it is in
  // the sitemap, and without a title of its own it was submitted under the
  // homepage's — see paginatedTitle.
  const baseTitle = search
    ? `Search results for "${search}" | OldSchoolGames`
    : page > 1
      ? SITE_TITLE
      : undefined;
  const baseDescription = search
    ? `Classic MS-DOS games matching "${search}" — play them free in your browser, no downloads required.`
    : page > 1
      ? SITE_DESCRIPTION
      : undefined;

  res.render("index", {
    games,
    total,
    search,
    suggestions,
    limit,
    page,
    isHomepage,
    recentNews,
    featuredGames,
    canonicalUrl,
    ogUrl,
    prevPageUrl,
    nextPageUrl,
    title: baseTitle && paginatedTitle(baseTitle, page),
    description: baseDescription && paginatedDescription(baseDescription, page),
  });
});

// "Surprise me" — the retro-catalogue browsing mode where the visitor has no
// particular game in mind.
router.get("/random", async (req, res, next) => {
  // "?not=" only ever says which game to skip, so anything unusable is
  // simply no exclusion. parseInt let an id past what an "integer" column
  // holds through, and the range error Postgres answered with turned the
  // Random button into a 500.
  const excludeId = parseId(firstQueryValue(req.query.not));

  const game = await Game.findRandom(excludeId ?? undefined);

  if (!game) {
    return next();
  }

  res.redirect(`/${game.slug}`);
});

router.get("/about", (req, res) => {
  res.render("about", {
    // Stated rather than derived. buildBreadcrumbs has a branch for every
    // listing whose trail is a local — a genre, a year, a developer — and none
    // for a page whose path is simply fixed, so it returned "Home" alone here
    // and views/breadcrumb.ejs drew nothing. The page was indexed, in the
    // sitemap, and the only thing on the site telling a crawler where it sits
    // was its URL. Same override routes/lists.ts uses; see utils/breadcrumbs.ts.
    breadcrumbs: [HOME_CRUMB, { name: "About" }],
    title: "About - OldSchoolGames.eu",
    description:
      "A hobby project preserving and celebrating classic MS-DOS games from the 80s and 90s — all of them playable free, directly in your browser.",
    canonicalUrl: `${SITE_URL}/about`,
  });
});

/**
 * The two legal pages, and why they are indexable where they used to be
 * "noindex, follow".
 *
 * The case for the tag was that both are boilerplate, and that /about and
 * /how-to-play are the pages with content worth ranking. Both halves are true
 * and neither is the question. Nobody is trying to rank a privacy policy: the
 * reason to leave it in the index is that it is one of the pages a rater —
 * and the systems built to approximate one — looks for when deciding whether
 * a site is what it says it is. A catalogue that publishes an Organization
 * node with a contact address, a DMCA route and a GDPR statement, and then
 * tells search engines not to keep two of the three, is withholding its own
 * evidence.
 *
 * It cost something concrete as well. A `noindex` is not free of risk on a
 * page linked from every footer on the site: Google follows those links, sees
 * the tag, and a URL that is repeatedly crawled and repeatedly refused is
 * eventually treated as `nofollow` too. That is a documented behaviour, and
 * on a site this size the footer is a meaningful share of internal linking.
 *
 * `canonicalUrl` is stated rather than left to views/head.ejs's fallback.
 * The fallback composes siteUrl + req.path, which is correct for both of
 * these — but head.ejs only emits a canonical at all on a page that asks to
 * be indexed, so these two had never exercised it. Naming the address here is
 * the same thing every other indexable route does.
 */
router.get("/privacy-policy", (req, res) => {
  res.render("privacy-policy", {
    breadcrumbs: [HOME_CRUMB, { name: "Privacy Policy" }],
    title: "Privacy Policy - OldSchoolGames.eu",
    description:
      "Privacy Policy for OldSchoolGames.eu — learn how we collect and process your personal data in accordance with GDPR.",
    canonicalUrl: `${SITE_URL}/privacy-policy`,
  });
});

router.get("/dmca", (req, res) => {
  res.render("dmca", {
    breadcrumbs: [HOME_CRUMB, { name: "DMCA Policy" }],
    title: "DMCA Policy - OldSchoolGames.eu",
    description:
      "DMCA takedown policy for OldSchoolGames.eu. Learn how to submit a copyright infringement notice and how we respond to takedown requests.",
    canonicalUrl: `${SITE_URL}/dmca`,
  });
});

router.get("/how-to-play", (req, res) => {
  res.render("how-to-play", {
    breadcrumbs: [HOME_CRUMB, { name: "How to Play" }],
    title: "How to Play MS-DOS Games - OldSchoolGames.eu",
    description:
      "New to MS-DOS games? Learn how to play, save and control them in your browser — keyboard shortcuts, saving progress and common controls by genre.",
    canonicalUrl: `${SITE_URL}/how-to-play`,
    // Both the visible FAQ section and the FAQPage schema, from the one
    // array — the view renders the questions from `faq` and the markup from
    // `faqLdJson`, so the two cannot describe different pages. utils/faq.ts
    // says what this does and does not buy in Google specifically.
    faq: HOW_TO_PLAY_FAQ,
    faqLdJson: faqLdJson(HOW_TO_PLAY_FAQ),
  });
});

/**
 * How many names the "Popular Developers" and "Popular Publishers" blocks show.
 */
const POPULAR_STUDIOS = 8;

/**
 * The studios on /developers or /publishers with the most games behind them,
 * for the "Popular" block on each.
 *
 * It was `developers.slice(0, 8)` in the view, and the list is ORDER BY name,
 * so the eight studios presented as popular were whichever eight came first in
 * the alphabet. How many games each has in the catalogue is the one measure of
 * that the page can stand behind, so that is the ranking. Ties keep the order
 * `names` arrives in, which is that same alphabetical one — sort() is stable
 * — so equals read in the order the full list below them does.
 *
 * The counts are the ones every page already has: getSitemapCounts' own
 * "developer:" and "publisher:" keys, which middlewares/sidebar-data.ts holds
 * for the chrome and hands on as `listingCounts`. The same number the studio's
 * own page counts its listing by, and no GROUP BY per request to get it. When
 * that load failed there is nothing to rank by, and the block is left out
 * rather than filled from the alphabet under a heading that says "popular".
 */
function mostGames(
  names: string[],
  counts: unknown,
  kind: "developer" | "publisher",
): string[] {
  if (!(counts instanceof Map)) return [];

  return names
    .map((name) => ({ name, games: Number(counts.get(`${kind}:${name}`)) || 0 }))
    .filter(({ games }) => games > 0)
    .sort((a, b) => b.games - a.games)
    .slice(0, POPULAR_STUDIOS)
    .map(({ name }) => name);
}

/**
 * The fixed single-segment pages, all of them above "/:genre" below.
 *
 * They are pages in their own right, not names the catalogue could ever
 * answer for, and "/:genre" is a catch-all that matches every one of them
 * first. It does hand them on — a name that is not a genre falls through to
 * next() — but not before deciding that, and deciding it can cost a query:
 * the genre list comes from res.locals.gameGenres, and when sidebarData has
 * not filled that in (its own query failed, or the request does not carry it)
 * the handler falls back to Game.getGenres(). So every visit to one of these
 * four risked a lookup asking whether "profile" is a genre.
 *
 * The comment on /profile already claimed this — "registered before the /:id
 * game lookup, which would otherwise run a pointless query" — and it was true
 * of "/:id" and not of "/:genre", which sat above it. Grouping them here with
 * /about and the rest is what makes the claim hold for both.
 *
 * utils/reserved-slugs.ts keeps the catalogue off these names from the other
 * side, so a game titled "Years" cannot generate a slug that lands here.
 */
// These three were also the only indexable pages on the site left without an
// explicit canonicalUrl, so views/head.ejs fell back to `siteUrl + req.path`.
// Express does not run in strict-routing mode, so "/developers/" answers 200
// like "/developers" does — and with req.path as the canonical, the page with
// the trailing slash pointed at itself rather than at the one address that
// should hold it. Every other page already names its own canonical.
//
// Titles passed from here rather than declared inside the view, which is
// where these two used to keep theirs. head.ejs builds the Twitter card from
// `locals.title` and `locals.description`, and a title the view invents after
// the include is not in locals — so both pages advertised themselves on
// Twitter and Slack under the site-wide default while their <title> and Open
// Graph tags said something else. Every other page on the site already names
// itself from its route; /years next door always has.
router.get("/developers", async (req, res) => {
  const developers = await Game.getDevelopers();

  res.render("games/developers", {
    developers,
    popularDevelopers: mostGames(
      developers,
      res.locals.listingCounts,
      "developer",
    ),
    breadcrumbs: [HOME_CRUMB, { name: "Developers" }],
    canonicalUrl: `${SITE_URL}/developers`,
    // 64 characters, and the two clauses said the same thing twice. This is
    // the page's own <h1>, which is what the page is called.
    title: "Classic MS-DOS Game Developers | OldSchoolGames",
    description:
      "Explore classic MS-DOS games by developer. Find your favorite game studios and check out their games.",
  });
});

router.get("/publishers", async (req, res) => {
  const publishers = await Game.getPublishers();

  res.render("games/publishers", {
    publishers,
    // By the publisher count, which credits a game with no publisher to its
    // developer — the same rule the list and each publisher's page follow.
    popularPublishers: mostGames(
      publishers,
      res.locals.listingCounts,
      "publisher",
    ),
    breadcrumbs: [HOME_CRUMB, { name: "Publishers" }],
    canonicalUrl: `${SITE_URL}/publishers`,
    // 65 characters, same duplication as /developers above.
    title: "Classic MS-DOS Game Publishers | OldSchoolGames",
    description:
      "Explore classic MS-DOS games by publisher. Find games from your favorite publishing companies from the retro era.",
  });
});

router.get("/years", async (req, res) => {
  const years = await Game.getYears();

  const title = "Game Years - Browse by Release Year - OldSchoolGames";
  const description =
    "Browse classic MS-DOS games by release year from the golden age of PC gaming. Discover retro games from the 80s through the 90s era.";

  res.render("games/years", {
    years,
    breadcrumbs: [HOME_CRUMB, { name: "Years" }],
    canonicalUrl: `${SITE_URL}/years`,
    title,
    description,
  });
});

router.get("/profile", async (req, res) => {
  // One visitor's own page, and nothing a crawler should hold. The noindex
  // was already in the view; what is new is that robots.txt no longer blocks
  // the URL as well — a block is what stopped the tag from ever being read.
  // See routes/sitemap.ts.
  res.render("profile", { noindex: true });
});

router.get("/:genre", async (req, res, next) => {
  const { genre } = req.params;
  const orderBy = firstQueryValue(req.query.orderBy);
  const orderDir = firstQueryValue(req.query.orderDir);

  // An emptiness check, not "??": sidebarData answers a failed genre query
  // with [] rather than undefined, so "??" never fell back and every genre
  // page 404ed for as long as the blip lasted. routes/games.ts has the same
  // expression for the same reason.
  const cachedGenres = res.locals.gameGenres as string[] | undefined;
  const genres: string[] = cachedGenres?.length
    ? cachedGenres
    : await Game.getGenres();

  if (!genres.includes(genre.toUpperCase())) {
    return next();
  }

  // One address per listing, and the lower-case one is it.
  //
  // The check above is deliberately case-insensitive — it has to be, since
  // the enum it reads is upper case and the URLs the site writes are not —
  // but that also let "/ACTION" and "/Action" through, and each answered 200
  // with the whole listing. The canonical named the lower-case form, so a
  // crawler that reached one was told where the page really lives; that is a
  // hint costing a crawl to read, where a redirect is the half that does not
  // depend on being believed. Exactly the argument app.ts makes for the
  // trailing slash, applied to the other spelling of the same duplicate.
  //
  // Relative Location, also as there: the canonical-host redirect is
  // production-only, so an absolute address would bounce anyone browsing a
  // development or staging build out to the live site.
  //
  // Encoded like the genre redirect on "/" above, and for the reason given
  // there. A value that has just matched the enum is a plain word, so this
  // changes nothing for a real genre.
  //
  // Game slugs need no rule of their own: Game.findBySlug matches exactly, so
  // "/DOOM" names no game and 404s already rather than serving a second copy
  // of "/doom". Developer and publisher filter on "=" for the same effect.
  //
  // The address is the *enum's* lower case, not the request's. The two used
  // to be assumed equal, and Unicode case mapping is not a round trip: the
  // Turkish dotless "ı" upper-cases to "I", the long "ſ" to "S", the "ﬁ"
  // ligature to "FI" — so "/actıon", "/ſports" and "/ﬁghting" matched the
  // enum above, were already "lower case" by their own lights, and each
  // answered 200 with a canonical naming itself: a duplicate of the genre
  // page, and "/Actıon" 301'd to it rather than to "/action".
  const canonicalGenre = genre.toUpperCase().toLowerCase();

  if (genre !== canonicalGenre) {
    return res.redirect(
      301,
      `/${encodeURIComponent(canonicalGenre)}${rawQuery(req)}`,
    );
  }

  const page = parsePageParam(req.query.page);
  const limit = 25;

  if (refusedOrdering(res, orderBy, orderDir)) return;

  const total = await Game.count({ genre });

  // A page with nothing on it does not exist — whether that is a genre no
  // game is filed under or a ?page= past the end of one that has games.
  // parsePageParam allows anything up to 10000, and the check used to cover
  // only the second case, so a genre holding no games still answered 200
  // with its own <title>, canonical and blurb around an empty list. The
  // developer, publisher and year pages below have always refused both.
  //
  // Both cases are settled from the count, ahead of the listing query — see
  // isPageBeyondTotal.
  if (total === 0 || isPageBeyondTotal({ page, limit, total })) {
    return next();
  }

  const games = await Game.find({ genre, page, limit, orderBy, orderDir });

  if (games.length === 0) {
    return next();
  }

  // See utils/genre-label.ts: title-cased by hand, "RPG" was "Rpg" here.
  const genreTitle = genreLabel(genre);
  // "Classic MS-DOS <genre> Games – Play Free Online | OldSchoolGames" was 63
  // characters for the shortest genre and 67 for the longest, so every one of
  // these ran past TITLE_MAX and had its tail cut by Google. Dropping the
  // leading "Classic" — which "MS-DOS" already implies, and which the
  // description below still says — brings the longest genre to 59.
  const title = `MS-DOS ${genreTitle} Games – Play Free Online | OldSchoolGames`;
  // Likewise 169–183 characters against a 155 limit, and the genre name was
  // repeated twice inside it for no benefit. This says the same thing in 140.
  const description = `Discover the best classic MS-DOS ${genreInSentence(genre)} games from the 80s and 90s — play these retro classics free in your browser, no download needed.`;

  // Set canonical URL (without orderBy/orderDir params)
  const { canonicalUrl, prevPageUrl, nextPageUrl } = paginationUrls({
    baseUrl: `${SITE_URL}/${genre.toLowerCase()}`,
    page,
    total,
    limit,
  });

  const genreBlurb = GENRE_DATA[genre.toUpperCase()]?.blurb;

  res.render("index", {
    games,
    total,
    genre,
    genreBlurb,
    limit,
    page,
    title: paginatedTitle(title, page),
    description: paginatedDescription(description, page),
    canonicalUrl,
    prevPageUrl,
    nextPageUrl,
  });
});

router.get("/letter/:letter", async (req, res, next) => {
  const { letter } = req.params;
  const orderBy = firstQueryValue(req.query.orderBy);
  const orderDir = firstQueryValue(req.query.orderDir);

  // One address per page of the A–Z browse: a lower-case letter, or "0-9" for
  // every game whose slug begins with a digit — see utils/letter-buckets.ts.
  // There were only the twenty-six letters, so a game titled "1942" was on no
  // page and "/letter/1" was a 404.
  if (!isLetterBucket(letter)) {
    // "/letter/A" is "/letter/a", and only the second is an address — see the
    // genre route above, which this is the other half of. The alphabet filter
    // and the heading both show the letter in upper case, so this is where
    // the two spellings collapse into one.
    //
    // No encodeURIComponent here or below: the tests have just established
    // that the value is a single ASCII letter or digit, and the target is a
    // bucket's own address, all of which encode to themselves.
    if (/^[A-Z]$/.test(letter)) {
      return res.redirect(
        301,
        `/letter/${letter.toLowerCase()}${rawQuery(req)}`,
      );
    }

    // And "/letter/7" is the digits' page, for the same reason: it is the
    // obvious guess at that page's address, and a second spelling of a page
    // is answered with a redirect rather than a duplicate or a 404.
    if (/^[0-9]$/.test(letter)) {
      return res.redirect(301, `/letter/${DIGIT_BUCKET}${rawQuery(req)}`);
    }

    return next();
  }

  if (refusedOrdering(res, orderBy, orderDir)) return;

  const page = parsePageParam(req.query.page);
  const limit = 25;

  const total = await Game.count({ letter });

  // As with the genre page above: a page no slug falls into is a 404, not an
  // empty page. The alphabet filter and the sitemap both leave an empty one
  // out now, but the address is still one anybody can type or link, and it
  // used to answer with an indexable page of nothing.
  if (total === 0 || isPageBeyondTotal({ page, limit, total })) {
    return next();
  }

  const games = await Game.find({ letter, page, limit, orderBy, orderDir });

  if (games.length === 0) {
    return next();
  }

  // Set canonical URL (without orderBy/orderDir params)
  const { canonicalUrl, prevPageUrl, nextPageUrl } = paginationUrls({
    baseUrl: `${SITE_URL}/letter/${letter.toLowerCase()}`,
    page,
    total,
    limit,
  });

  // What the page is called: "'A'" for a letter, and for the digits' page
  // "a Number" in a heading and "a number" mid-sentence — a quoted "'0-9'"
  // reads as a range of characters, not as the titles it stands for. The
  // breadcrumb says the same through utils/breadcrumbs.ts, and the <h1> is
  // handed `letterHeading` rather than working it out in the template.
  const heading = letterBucketHeading(letter);
  const inSentence = letterBucketInSentence(letter);

  // As many whole game titles as the budget allows, rather than a fixed four.
  //
  // Four ran this description to between 187 and 213 characters against a 155
  // limit — /letter/s was the worst of them — and simply handing the result to
  // truncateAtWord is not the fix here: the cut lands inside whichever game
  // happened to be fourth, so the snippet advertises a title that does not
  // exist ("Al-Qadim: The Genie…"). Packing whole names means the sentence
  // always ends where it says it does, and a letter whose games have short
  // names now gets more of them named rather than fewer.
  const lead = `Classic MS-DOS games starting with ${inSentence}: `;
  const tail = " and more — play them free in your browser.";
  const titleBudget = META_DESCRIPTION_MAX - lead.length - tail.length;

  const named: string[] = [];
  let used = 0;

  for (const game of games) {
    // The ", " that joins this name to the one before it, which the first
    // name does not pay for.
    const cost = (named.length > 0 ? 2 : 0) + game.title.length;

    if (used + cost > titleBudget) break;

    named.push(game.title);
    used += cost;
  }

  // `games` is never empty here — the guard above answers 404 for that — so
  // this fallback is for the one case that survives it: a first game whose
  // title alone is longer than the budget, which would otherwise leave the
  // colon in the lead introducing nothing.
  const letterDescription =
    named.length > 0
      ? lead + named.join(", ") + tail
      : `Browse classic MS-DOS games starting with ${inSentence} — retro games from the 80s and 90s, free in your browser.`;

  res.render("index", {
    games,
    total,
    letter,
    letterHeading: heading,
    // For the sentence-case <h2> in views/games/game-filters.ejs, which used
    // to upper-case the parameter itself and printed "'0-9'".
    letterInSentence: inSentence,
    limit,
    page,
    // "– Browse & Play Online" used to sit before the brand and took this to
    // 70 characters, the longest title on the site after the news articles.
    // What it added, a listing page says by existing.
    title: paginatedTitle(
      `MS-DOS Games Starting with ${heading} | OldSchoolGames`,
      page,
    ),
    description: paginatedDescription(letterDescription, page),
    canonicalUrl,
    prevPageUrl,
    nextPageUrl,
  });
});

router.get("/developer/:developer", async (req, res, next) => {
  const { developer } = req.params;
  const orderBy = firstQueryValue(req.query.orderBy);
  const orderDir = firstQueryValue(req.query.orderDir);

  if (refusedOrdering(res, orderBy, orderDir)) return;

  const page = parsePageParam(req.query.page);
  const limit = 25;

  const total = await Game.count({ developer });

  // No games under that name — or a page past the end of the list — means the
  // page does not exist. It used to render a complete 200 with its own
  // <title>, canonical and blurb around an empty list, so every misspelling,
  // stale link and out-of-range ?page= was an indexable page of nothing.
  if (total === 0 || isPageBeyondTotal({ page, limit, total })) {
    return next();
  }

  const games = await Game.find({ developer, page, limit, orderBy, orderDir });

  // The developer page is the one that keeps the curated STUDIO_DATA title and
  // blurb as written. Its publisher twin below no longer does — see the
  // comment there for why the two had to be told apart at all.
  const studioEntry = STUDIO_DATA[developer] ?? null;
  const studioBlurb = studioEntry?.blurb ?? null;
  const title =
    studioEntry?.title ??
    // Through fitTitle rather than composed raw: developer names run to 35
    // characters in this catalogue ("Playmates Interactive Entertainment"),
    // which put the bare fallback over the limit on its own.
    fitTitle(`Games by ${developer}`, [" - OldSchoolGames"]);
  const description = studioBlurb
    ? truncateAtWord(studioBlurb, META_DESCRIPTION_MAX)
    : // 179 characters for an ordinary studio name against a 155 limit, so the
      // closing clause was cut off every developer page that had no blurb —
      // which is 155 of the 169 developers in the catalogue. "Legendary" also
      // went whether the studio was one or not; a page describing every
      // developer in superlatives describes none of them.
      `Classic MS-DOS games developed by ${developer} — browse the studio's catalogue and play it free in your browser.`;

  // Set canonical URL (without orderBy/orderDir params)
  const { canonicalUrl, prevPageUrl, nextPageUrl } = paginationUrls({
    baseUrl: `${SITE_URL}/developer/${encodeURIComponent(developer)}`,
    page,
    total,
    limit,
  });

  res.render("index", {
    games,
    total,
    developer,
    studioBlurb,
    limit,
    page,
    title: paginatedTitle(title, page),
    description: paginatedDescription(description, page),
    canonicalUrl,
    prevPageUrl,
    nextPageUrl,
  });
});

router.get("/publisher/:publisher", async (req, res, next) => {
  const { publisher } = req.params;
  const orderBy = firstQueryValue(req.query.orderBy);
  const orderDir = firstQueryValue(req.query.orderDir);

  if (refusedOrdering(res, orderBy, orderDir)) return;

  const page = parsePageParam(req.query.page);
  const limit = 25;

  const total = await Game.count({ publisher });

  // As with developers above: an unknown name is a 404, not an empty page.
  if (total === 0 || isPageBeyondTotal({ page, limit, total })) {
    return next();
  }

  const games = await Game.find({ publisher, page, limit, orderBy, orderDir });

  /**
   * Why this page does not reuse the curated STUDIO_DATA title and blurb the
   * way the developer page above does.
   *
   * STUDIO_DATA is keyed by name alone, and 65 names in the catalogue are both
   * a developer and a publisher — a studio that published its own games. For
   * the 14 of those that have an entry, "/developer/<name>" and
   * "/publisher/<name>" were emitting a byte-identical <title> and meta
   * description: id Software, Sierra On-Line, Origin Systems, LucasArts,
   * Electronic Arts and nine more. Both are real pages with different content
   * — different <h1>, and different game lists, since a studio rarely
   * published everything it developed and never developed everything it
   * published — but nothing in what a search engine displays said so, and two
   * results with the same title and the same snippet compete with each other
   * for the same query.
   *
   * The blurb still earns its place here: it is about the company, which is
   * what both pages are about. It just cannot be the whole description, so it
   * follows a clause naming this page's half of the relationship. That makes
   * the first words — the part a SERP shows and a deduplicator compares —
   * different, while the page keeps the editorial copy that makes it worth
   * reading. `studioBlurb` itself is unchanged, so the prose in the body of
   * the page is the same on both.
   */
  const studioEntry = STUDIO_DATA[publisher] ?? null;
  const studioBlurb = studioEntry?.blurb ?? null;
  const title = studioEntry
    ? fitTitle(`Games Published by ${publisher}`, [" | OldSchoolGames"])
    : fitTitle(`Games published by ${publisher}`, [" - OldSchoolGames"]);
  const description = studioBlurb
    ? truncateAtWord(
        `Classic MS-DOS games published by ${publisher}. ${studioBlurb}`,
        META_DESCRIPTION_MAX,
      )
    : `Classic MS-DOS games published by ${publisher} — browse the catalogue and play it free in your browser, no download needed.`;

  // Set canonical URL (without orderBy/orderDir params)
  const { canonicalUrl, prevPageUrl, nextPageUrl } = paginationUrls({
    baseUrl: `${SITE_URL}/publisher/${encodeURIComponent(publisher)}`,
    page,
    total,
    limit,
  });

  res.render("index", {
    games,
    total,
    publisher,
    studioBlurb,
    limit,
    page,
    title: paginatedTitle(title, page),
    description: paginatedDescription(description, page),
    canonicalUrl,
    prevPageUrl,
    nextPageUrl,
  });
});

router.get("/year/:year", async (req, res, next) => {
  const { year } = req.params;

  // Four digits exactly. parseInt was too forgiving to stand in for this: it
  // read "1990abc" as 1990 and "1e5" as 1, so a single year was reachable
  // under endlessly many addresses, each a 200 with the same content.
  //
  // And no leading zero. "/year/0000" passed a bare \d{4}, became year 0, and
  // Game.find's filter builder skipped a year of 0 as though none had been
  // given — so it answered 200 with the entire catalogue as an indexable page
  // titled "Games from 0", whose canonical and rel=next both 404ed. A leading
  // zero is never how a release year is written, so what passes this is also
  // exactly the form the canonical below spells.
  if (!/^[1-9]\d{3}$/.test(year)) {
    return next();
  }

  const yearNum = Number(year);

  const orderBy = firstQueryValue(req.query.orderBy);
  const orderDir = firstQueryValue(req.query.orderDir);

  if (refusedOrdering(res, orderBy, orderDir)) return;

  const page = parsePageParam(req.query.page);
  const limit = 25;

  const [total, allYears] = await Promise.all([
    Game.count({ year: yearNum }),
    Game.getYears(),
  ]);

  // A year nothing was released in — or a page past the end of one that has
  // games — is a 404 rather than an empty page.
  if (total === 0 || isPageBeyondTotal({ page, limit, total })) {
    return next();
  }

  const games = await Game.find({
    year: yearNum,
    page,
    limit,
    orderBy,
    orderDir,
  });

  // Set canonical URL (without orderBy/orderDir params)
  const { canonicalUrl, prevPageUrl, nextPageUrl } = paginationUrls({
    baseUrl: `${SITE_URL}/year/${yearNum}`,
    page,
    total,
    limit,
  });

  const yearBlurb = YEAR_DATA[yearNum]?.blurb ?? null;
  const description = yearBlurb
    ? truncateAtWord(yearBlurb, META_DESCRIPTION_MAX)
    : `Discover classic MS-DOS games released in ${yearNum}. Play authentic retro games from this year directly in your browser with DOSBox.`;

  res.render("index", {
    games,
    total,
    year: yearNum,
    allYears,
    yearBlurb,
    limit,
    page,
    title: paginatedTitle(`Games from ${yearNum} - OldSchoolGames`, page),
    description: paginatedDescription(description, page),
    canonicalUrl,
    prevPageUrl,
    nextPageUrl,
  });
});

router.get("/:slug/gallery/:index", async (req, res, next) => {
  const { slug, index } = req.params;

  // One spelling per slide, for the same reason as the year above: parseInt
  // accepted "0abc" as slide 0, giving one picture an unlimited supply of
  // addresses.
  //
  // A plain /^\d+$/ was still the wrong test, and said so in its own comment:
  // "00", "007" and "0000000" all passed and all rendered slide 0 or slide 7
  // under a 200, which is the supply of duplicate addresses this exists to
  // close, only shorter. The alternation admits "0" — slide indexes start
  // there, unlike the ids in utils/ids.ts and the pages in
  // utils/pagination.ts — and nothing else with a leading zero.
  if (!/^(0|[1-9]\d*)$/.test(index)) {
    return next();
  }

  // The slug half of the address is held to the shape every slug has, for
  // the reasons given on the game route below: no query for what cannot be
  // one, and no "%00" handed to Postgres.
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return next();
  }

  const currentIndex = Number(index);

  const game = await Game.findBySlug(slug);

  if (!game) {
    const currentSlug = await Game.findCurrentSlug(slug);

    if (currentSlug) {
      return res.redirect(301, `/${currentSlug}/gallery/${currentIndex}`);
    }

    return next();
  }

  const validImages = game.images.filter(Boolean);

  if (currentIndex < 0 || currentIndex >= validImages.length) {
    return next();
  }

  // Flattened before it is cut, not after. This used to slice the stored
  // description straight through, so a game whose text opens with a tag put
  // "<p>" — or half of one, and half an "&amp;" — into the meta description.
  // The old cut also dropped the final word even when nothing was truncated.
  //
  // No ellipsis: the snippet lands in the middle of a sentence below, so one
  // would sit immediately before a full stop.
  const galleryPlain = htmlToPlainText(game.description);
  const descSnippet = galleryPlain
    ? // Trailing punctuation goes with the ellipsis: the sentence below
      // supplies its own full stop, so a description ending in one read
      // "hit the road.. Browse all screenshots". The old cut hid this by
      // throwing the last word away, full stop and all.
      truncateAtWord(galleryPlain, 100).replace(/[.…!?]+$/, "")
    : // "by" only when there is somebody to name. A game with neither a
      // description nor a developer — both columns are nullable, and a new
      // entry often starts with just a title — put "…a classic action MS-DOS
      // game by null." into its og:description and Twitter card, or "by ."
      // for a developer left as an empty string. The detail route guards the
      // same sentence the same way.
      `a classic ${genreInSentence(game.genre)} MS-DOS game` +
      (game.developer ? ` by ${game.developer}` : "");
  const description = `${game.title} screenshot gallery - ${descSnippet}. Browse all screenshots and play ${game.title} for free online on OldSchoolGames.`;

  const image = validImages[currentIndex];

  res.render("games/game-gallery", {
    game,
    currentIndex,
    // Passed from here rather than composed in the view, which is where this
    // one was: head.ejs builds the Twitter card from `locals.title`, so a
    // shared slide advertised itself under the site-wide default while the
    // <title> above it named the game.
    title: `${game.title} - Gallery - OldSchoolGames`,
    description,
    image,
    // A gallery slide should not compete with the game page in search
    // results. That used to be said twice and the two said different things:
    // the view carried a noindex, and this named the game page as the slide's
    // canonical — a canonical pointing away says "index that one instead"
    // while the noindex says "index nothing", which is the single pairing
    // Google calls conflicting (views/head.ejs reasons it out where the tag
    // is written). The noindex is the half that is reliable, so it is the
    // half that stays, and it lives here now rather than in the view.
    //
    // og:url still carries the slide's own address, for anyone sharing the
    // picture.
    noindex: true,
    ogUrl: `${SITE_URL}/${game.slug}/gallery/${currentIndex}`,
  });
});

router.get("/:id", async (req, res, next) => {
  const { id } = req.params;

  // Nothing that could be a slug or an id costs a query. Every slug this site
  // has ever generated — slugify() and the SQL backfills in 0019 and 0035
  // alike — is built by replacing everything outside [a-z0-9] with "-", and
  // routes/news.ts has always refused anything else the same way. This route
  // did not, so each probe a crawler or a scanner sends ("/wp-login.php",
  // "/.env", "/xmlrpc.php") was looked up as a slug and then again in the slug
  // history before it got its 404: two queries for nothing, on the most-hit
  // address pattern a public site has. It also keeps a "%00" from reaching
  // Postgres here at all (see isUnstorableTextError in utils/pg-errors.ts).
  if (!/^[a-z0-9-]+$/.test(id)) {
    return next();
  }

  // Slug first. Deciding by Number(id) sent anything numeric-looking down the
  // id path, which broke two things: a game titled "1942" has the slug "1942"
  // and was never found, and "/1.5" reached Postgres as an integer comparison
  // and came back a 500 instead of a 404.
  const game = await Game.findBySlug(id);

  if (!game) {
    // Then the slug history, and only then the legacy numeric id. The id used
    // to be tried first, which is wrong for exactly the addresses that are
    // both: rename the game at "/1942" and its old slug "1942" joins the
    // history — but "/1942" then 301'd to whichever game happens to have id
    // 1942 instead of to the game that had lived there. A slug the site once
    // served is a more recent meaning of the address than an id from before
    // slugs existed.
    const currentSlug = await Game.findCurrentSlug(id);

    // The game was renamed; its old address still belongs to it.
    if (currentSlug) {
      return res.redirect(301, `/${currentSlug}`);
    }

    // parseId, not a bare digit test: "/9999999999" is all digits and reached
    // Postgres as an integer comparison it cannot make, which came back a 500
    // where the address simply names no game.
    const numericId = parseId(id);

    if (numericId !== null) {
      const byId = await Game.findById(numericId);

      // Redirected, not rendered. Every game has had a slug since 0035 made
      // the column NOT NULL, and the slug is the address the sitemap, the
      // feeds, the canonical link and every link on the site use — so serving
      // the same page under "/123" as well left a second, duplicate address
      // for every game in the catalogue, crawlable from any old link that
      // still names the id. A permanent redirect says which of the two is the
      // page while keeping the old address working, which is exactly what the
      // renamed-slug branch above already does.
      if (byId) {
        return res.redirect(301, `/${byId.slug}`);
      }
    }

    return next();
  }

  const [
    comments,
    commentCount,
    rootCommentCount,
    similarGames,
    { prevGame, nextGame },
    userRating,
  ] = await Promise.all([
    Comment.findByGameId(game.id),
    Comment.countAll(game.id),
    Comment.countRoots(game.id),
    Game.findSimilar(game.id, game.genre, 6),
    Game.findAdjacentGames(game.title, game.id),
    req.voterId ? Game.getVoterRating(game.id, req.voterId) : null,
  ]);

  // Only the newest batch is rendered; the rest is a click away.
  const remainingComments = Math.max(0, rootCommentCount - comments.length);

  // The arithmetic this replaces did not add up: it aimed, in its own words,
  // at "~60 chars total", then allowed 44 characters of game title in front of
  // a 31-character suffix — 75. So the long names it was written for were
  // exactly the ones it let through over the limit, and "Indiana Jones and the
  // Last Crusade" reached Google at 65 characters to be cut there instead.
  //
  // fitTitle gives up the " - Play Online" clause before it gives up any of
  // the game's name, which is the right order: the name is what somebody
  // searched for, and the clause is a phrase the page proves by existing. A
  // name too long even for the bare brand suffix is still cut, but it is now
  // the last resort rather than the first.
  const title = fitTitle(game.title, [
    " - Play Online - OldSchoolGames",
    " - OldSchoolGames",
  ]);

  // Plain-text game description – used for the meta description and LD+JSON.
  // htmlToPlainText also decodes the entities DOMPurify left behind: EJS
  // escapes whatever it is handed, so a stored "&amp;" used to reach the
  // meta tag as "&amp;amp;" and search results showed the entity.
  const rawPlain = htmlToPlainText(game.description);

  // Build meta description – prefer real game text for unique content per page
  let description: string;

  if (rawPlain.length > 30) {
    description = truncateAtWord(rawPlain, META_DESCRIPTION_MAX);
  } else {
    // Fallback template when no description is stored in the database.
    //
    // genreInSentence rather than a bare toLowerCase(), which made "Classic
    // rpg game" of every RPG with no description — in the meta description,
    // both social cards and the JSON-LD, all of which are built from this.
    // The gallery route above already writes its own copy of the phrase so.
    const gameText = game.genre
      ? `${genreInSentence(game.genre)} game`
      : "MS-DOS game";
    const yearText = game.release ? ` from ${game.release}` : "";
    const devText = game.developer ? ` by ${game.developer}` : "";
    const ending =
      " – play it now in your browser for free. No downloads or installation required!";

    // Composed whole and cut once, rather than the title being squeezed into
    // whatever the fixed text leaves over. That is what the arithmetic here
    // used to do, and the budget does not stretch: the closing clause alone is
    // 79 of the 155 characters, so a game with an ordinary developer name was
    // left about sixteen for its own name — "Play The Secret of M… online.
    // Classic adventure game from 1990 by Lucasfilm Games". A developer name
    // of 29 characters or more ("Interplay Entertainment Corp.") drove the
    // budget negative, substring() returned "", and the game disappeared from
    // its own description altogether: "Play … online."
    //
    // The title is the one part of this sentence worth keeping, so it is the
    // boilerplate tail that gives way now. It is also cut on a word boundary
    // rather than mid-word, which is what truncateAtWord is for and what the
    // three other snippets in this file have always done.
    const sentence = `Play ${truncateAtWord(
      game.title,
      FALLBACK_TITLE_MAX,
    )} online. Classic ${gameText}${yearText}${devText}${ending}`;

    description = truncateAtWord(sentence, META_DESCRIPTION_MAX);
  }

  const plainDescription = rawPlain || description;

  // game.cover, not images[0]: a game whose first slot was left blank has
  // "" there, and og:image is rendered without a fallback — so the card a
  // shared link produced advertised an empty address rather than the artwork
  // sitting in the next slot.
  const image = game.cover;
  const canonicalUrl = `${SITE_URL}/${game.slug}`;

  // Build LD+JSON safely (JSON.stringify handles escaping)
  const ldJson: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "VideoGame",
    name: game.title,
    description: truncateAtWord(plainDescription, LD_TEXT_MAX),
    genre: game.genre,
    gamePlatform: ["MS-DOS", "Web browser"],
    operatingSystem: "MS-DOS",
    // "GameApplication", not "Game". schema.org leaves the property as free
    // text, but Google matches it against a fixed list for software apps and
    // "Game" is not on that list, so the value was read as nothing at all.
    applicationCategory: "GameApplication",
    playMode: "SinglePlayer",
    url: canonicalUrl,
    // Absolute, because a relative cover is valid on the page and useless
    // here: nothing that reads JSON-LD resolves it. See absoluteUrl.
    image: game.images.filter(Boolean).map(absoluteUrl),
    screenshot: game.images.filter(Boolean).map((url) => ({
      "@type": "ImageObject",
      url: absoluteUrl(url),
    })),
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
    },
  };
  if (game.release) ldJson.datePublished = String(game.release);
  if (game.updatedAt)
    ldJson.dateModified = new Date(game.updatedAt).toISOString();
  if (game.publisher || game.developer) {
    ldJson.publisher = {
      "@type": "Organization",
      name: game.publisher || game.developer,
    };
  }
  if (game.developer) {
    ldJson.author = { "@type": "Organization", name: game.developer };
  }
  if (
    game.averageRating &&
    game.averageRating > 0 &&
    game.ratingCount &&
    game.ratingCount > 0
  ) {
    ldJson.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: game.averageRating.toFixed(1),
      ratingCount: game.ratingCount,
      bestRating: "5",
      worstRating: "1",
    };
  }

  // The conversation on the page, which the node described none of — a game
  // with a hundred comments and one with none looked identical here, and the
  // rating above was the only sign that anybody had ever visited either.
  //
  // Only when there is something to report. A CommentCount of 0 is not a
  // fact worth stating, and `comment: []` is a claim of emptiness rather than
  // an absence of a claim.
  if (commentCount > 0) {
    ldJson.interactionStatistic = {
      "@type": "InteractionCounter",
      interactionType: "https://schema.org/CommentAction",
      userInteractionCount: commentCount,
    };

    ldJson.discussionUrl = `${canonicalUrl}#comments`;

    // Top-level comments only, and only the ones actually rendered into the
    // page — structured data describes what is on the page, so the batch the
    // view draws is exactly the right set to take. The replies nested under
    // them are left out: schema.org can express a reply, but it would double
    // the size of this node to describe a thread that is already fully
    // readable in the markup below it.
    const LD_COMMENT_MAX = 10;

    const ldComments = comments.slice(0, LD_COMMENT_MAX).map((comment) => ({
      "@type": "Comment",
      // Plain text already, unlike the description further up: a comment is
      // stored exactly as it was typed (see validations/comments.ts) and
      // rendered with <%= %>, so there is no markup and no entity in it.
      // Running it through htmlToPlainText was not merely redundant, it was
      // lossy — it reads a visitor's literal "<3" or "a < b" as a tag and
      // deletes everything up to the next ">", and turns a typed "&amp;" into
      // an ampersand nobody wrote.
      text: truncateAtWord(comment.content, LD_TEXT_MAX),
      dateCreated: new Date(comment.createdAt).toISOString(),
      author: { "@type": "Person", name: comment.nick },
    }));

    if (ldComments.length > 0) ldJson.comment = ldComments;
  }

  // No "keywords" here any more. Google has ignored the meta tag since 2009
  // and the other engines followed; it was built per game, sent on every page
  // view, and read by nothing.
  res.render("games/game-detail", {
    game,
    comments,
    commentCount,
    remainingComments,
    similarGames,
    prevGame,
    nextGame,
    userRating,
    title,
    description,
    image,
    canonicalUrl,
    ldJson,
  });
});

export default router;
