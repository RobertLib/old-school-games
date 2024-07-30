import express from "express";
import Game from "../models/game.ts";
import Comment from "../models/comment.ts";
import News from "../models/news.ts";
import {
  paginatedDescription,
  paginatedTitle,
  paginationUrls,
  parsePageParam,
} from "../utils/pagination.ts";
import { firstQueryValue } from "../utils/query.ts";
import { parseId } from "../utils/ids.ts";
import { SITE_DESCRIPTION, SITE_TITLE, SITE_URL } from "../utils/site.ts";
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

const router = express.Router();

const VALID_ORDER_BY_FIELDS = ["createdAt", "release", "rating", "title"];

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
 * The query string exactly as it arrived, ready to re-attach to a redirect.
 *
 * Taken off req.originalUrl rather than rebuilt from req.query, which is the
 * parsed form: re-serialising it does not give back what was sent, because
 * repeated keys, arrays and the percent-encoding all shift on the way through.
 * app.ts splits the raw URL for the trailing-slash redirect for the same
 * reason, and a redirect that quietly rewrites the caller's query string is
 * the one thing these are not allowed to do.
 */
function rawQuery(req: express.Request): string {
  const query = req.originalUrl.split("?")[1];

  return query ? `?${query}` : "";
}

router.get("/", async (req, res, next) => {
  const genre = firstQueryValue(req.query.genre);
  const search = firstQueryValue(req.query.search);
  const orderBy = firstQueryValue(req.query.orderBy);
  const orderDir = firstQueryValue(req.query.orderDir);

  if (genre) {
    // Encoded, because this lands in the Location header. A genre of
    // "/evil.example.com" produced "//evil.example.com", which a browser reads
    // as a protocol-relative URL — the site's own address redirecting to
    // someone else's. Real genres are plain words, so this changes nothing
    // for them.
    return res.redirect(`/${encodeURIComponent(genre.toLowerCase())}`);
  }

  // A 400, not the 404 this used to fall through to: the page exists, the
  // request for it was malformed. The navbar caps the field at 100
  // characters, so only a hand-edited address gets here.
  if (search && search.length > 100) {
    return res.status(400).render("400", { noindex: true });
  }

  if (orderBy && !VALID_ORDER_BY_FIELDS.includes(orderBy)) {
    return next();
  }

  if (orderDir && !["ASC", "DESC"].includes(orderDir)) {
    return next();
  }

  const page = parsePageParam(req.query.page);
  const limit = 25;

  const [games, total, recentNews, featuredGames] = await Promise.all([
    Game.find({ search, page, limit, orderBy, orderDir }),
    Game.count({ search }),
    // Recent news for the homepage, as plain-text excerpts rather than three
    // whole articles: views/news/news-preview.ejs used to render the stored
    // HTML in full and clamp it to three lines in CSS, which shipped every
    // byte and read every word out to a screen reader. 240 characters is
    // roughly what the three-line clamp shows at the widths the card is
    // rendered at, so the cut lands just past what is visible rather than
    // inside it.
    News.findRecent(3).then((items) =>
      items.map((item) => ({
        ...item,
        excerpt: truncateAtWord(htmlToPlainText(item.content), 240),
      })),
    ),
    Game.findFeatured(10), // Load 10 random featured games for carousel
  ]);

  // A search that found nothing gets close-title suggestions instead of a
  // dead end.
  const suggestions =
    search && total === 0 ? await Game.findTitleSuggestions(search, 5) : [];

  // An out-of-range page is a 404, not an empty list. parsePageParam allows
  // anything up to 10000, so without this every filter page above had ten
  // thousand indexable addresses rendering the same nothing.
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
  if (genre !== genre.toLowerCase()) {
    return res.redirect(
      301,
      `/${encodeURIComponent(genre.toLowerCase())}${rawQuery(req)}`,
    );
  }

  const page = parsePageParam(req.query.page);
  const limit = 25;

  if (orderBy && !VALID_ORDER_BY_FIELDS.includes(orderBy)) {
    return next();
  }

  if (orderDir && !["ASC", "DESC"].includes(orderDir)) {
    return next();
  }

  const [games, total] = await Promise.all([
    Game.find({ genre, page, limit, orderBy, orderDir }),
    Game.count({ genre }),
  ]);

  // A page with nothing on it does not exist — whether that is a genre no
  // game is filed under or a ?page= past the end of one that has games.
  // parsePageParam allows anything up to 10000, and the check used to cover
  // only the second case, so a genre holding no games still answered 200
  // with its own <title>, canonical and blurb around an empty list. The
  // developer, publisher and year pages below have always refused both.
  if (games.length === 0) {
    return next();
  }

  const genreTitle =
    genre.charAt(0).toUpperCase() + genre.slice(1).toLowerCase();
  // "Classic MS-DOS <genre> Games – Play Free Online | OldSchoolGames" was 63
  // characters for the shortest genre and 67 for the longest, so every one of
  // these ran past TITLE_MAX and had its tail cut by Google. Dropping the
  // leading "Classic" — which "MS-DOS" already implies, and which the
  // description below still says — brings the longest genre to 59.
  const title = `MS-DOS ${genreTitle} Games – Play Free Online | OldSchoolGames`;
  // Likewise 169–183 characters against a 155 limit, and the genre name was
  // repeated twice inside it for no benefit. This says the same thing in 140.
  const description = `Discover the best classic MS-DOS ${genre.toLowerCase()} games from the 80s and 90s — play these retro classics free in your browser, no download needed.`;

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

  if (!/^[A-Za-z]$/.test(letter)) {
    return next();
  }

  // "/letter/A" is "/letter/a", and only the second is an address — see the
  // genre route above, which this is the other half of. The pattern that just
  // matched admits both cases on purpose (the alphabet filter and the heading
  // both work in upper case), so this is where the two collapse into one.
  //
  // No encodeURIComponent: the test above has already established that this
  // is a single ASCII letter, which encodes to itself.
  if (letter !== letter.toLowerCase()) {
    return res.redirect(301, `/letter/${letter.toLowerCase()}${rawQuery(req)}`);
  }

  if (orderBy && !VALID_ORDER_BY_FIELDS.includes(orderBy)) {
    return next();
  }

  if (orderDir && !["ASC", "DESC"].includes(orderDir)) {
    return next();
  }

  const page = parsePageParam(req.query.page);
  const limit = 25;

  const [games, total] = await Promise.all([
    Game.find({ letter, page, limit, orderBy, orderDir }),
    Game.count({ letter }),
  ]);

  // As with the genre page above: a letter no title starts with is a 404,
  // not an empty page. All 26 are linked from the alphabet filter and listed
  // in the sitemap, so on a catalogue with gaps this was a standing supply of
  // indexable pages of nothing.
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

  const L = letter.toUpperCase();

  // As many whole game titles as the budget allows, rather than a fixed four.
  //
  // Four ran this description to between 187 and 213 characters against a 155
  // limit — /letter/s was the worst of them — and simply handing the result to
  // truncateAtWord is not the fix here: the cut lands inside whichever game
  // happened to be fourth, so the snippet advertises a title that does not
  // exist ("Al-Qadim: The Genie…"). Packing whole names means the sentence
  // always ends where it says it does, and a letter whose games have short
  // names now gets more of them named rather than fewer.
  const lead = `Classic MS-DOS games starting with '${L}': `;
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
      : `Browse classic MS-DOS games starting with '${L}' — retro games from the 80s and 90s, free in your browser.`;

  res.render("index", {
    games,
    total,
    letter,
    limit,
    page,
    // "– Browse & Play Online" used to sit before the brand and took this to
    // 70 characters, the longest title on the site after the news articles.
    // What it added, a listing page says by existing.
    title: paginatedTitle(
      `MS-DOS Games Starting with '${L}' | OldSchoolGames`,
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

  if (orderBy && !VALID_ORDER_BY_FIELDS.includes(orderBy)) {
    return next();
  }

  if (orderDir && !["ASC", "DESC"].includes(orderDir)) {
    return next();
  }

  const page = parsePageParam(req.query.page);
  const limit = 25;

  const [games, total] = await Promise.all([
    Game.find({ developer, page, limit, orderBy, orderDir }),
    Game.count({ developer }),
  ]);

  // No games under that name — or a page past the end of the list — means the
  // page does not exist. It used to render a complete 200 with its own
  // <title>, canonical and blurb around an empty list, so every misspelling,
  // stale link and out-of-range ?page= was an indexable page of nothing.
  if (total === 0 || (page > 1 && games.length === 0)) {
    return next();
  }

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

  if (orderBy && !VALID_ORDER_BY_FIELDS.includes(orderBy)) {
    return next();
  }

  if (orderDir && !["ASC", "DESC"].includes(orderDir)) {
    return next();
  }

  const page = parsePageParam(req.query.page);
  const limit = 25;

  const [games, total] = await Promise.all([
    Game.find({ publisher, page, limit, orderBy, orderDir }),
    Game.count({ publisher }),
  ]);

  // As with developers above: an unknown name is a 404, not an empty page.
  if (total === 0 || (page > 1 && games.length === 0)) {
    return next();
  }

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
  if (!/^\d{4}$/.test(year)) {
    return next();
  }

  const yearNum = Number(year);

  const orderBy = firstQueryValue(req.query.orderBy);
  const orderDir = firstQueryValue(req.query.orderDir);

  if (orderBy && !VALID_ORDER_BY_FIELDS.includes(orderBy)) {
    return next();
  }

  if (orderDir && !["ASC", "DESC"].includes(orderDir)) {
    return next();
  }

  const page = parsePageParam(req.query.page);
  const limit = 25;

  const [games, total, allYears] = await Promise.all([
    Game.find({ year: yearNum, page, limit, orderBy, orderDir }),
    Game.count({ year: yearNum }),
    Game.getYears(),
  ]);

  // A year nothing was released in — or a page past the end of one that has
  // games — is a 404 rather than an empty page.
  if (total === 0 || (page > 1 && games.length === 0)) {
    return next();
  }

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

  // Digits only, for the same reason as the year above: parseInt accepted
  // "0abc" as slide 0, giving one picture an unlimited supply of addresses.
  if (!/^\d+$/.test(index)) {
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
    : `a classic ${game.genre.toLowerCase()} MS-DOS game by ${game.developer}`;
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

  // Slug first. Deciding by Number(id) sent anything numeric-looking down the
  // id path, which broke two things: a game titled "1942" has the slug "1942"
  // and was never found, and "/1.5" reached Postgres as an integer comparison
  // and came back a 500 instead of a 404.
  const game = await Game.findBySlug(id);

  // parseId, not a bare digit test: "/9999999999" is all digits and reached
  // Postgres as an integer comparison it cannot make, which came back a 500
  // where the address simply names no game.
  const numericId = parseId(id);

  if (!game && numericId !== null) {
    const byId = await Game.findById(numericId);

    // Redirected, not rendered. Every game has had a slug since 0035 made
    // the column NOT NULL, and the slug is the address the sitemap, the
    // feeds, the canonical link and every link on the site use — so serving
    // the same page under "/123" as well left a second, duplicate address
    // for every game in the catalogue, crawlable from any old link that
    // still names the id. A permanent redirect says which of the two is the
    // page while keeping the old address working, which is exactly what the
    // renamed-slug branch below already does.
    if (byId) {
      return res.redirect(301, `/${byId.slug}`);
    }
  }

  if (!game) {
    const currentSlug = await Game.findCurrentSlug(id);

    // The game was renamed; its old address still belongs to it.
    if (currentSlug) {
      return res.redirect(301, `/${currentSlug}`);
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
    // Fallback template when no description is stored in the database
    const gameText = game.genre
      ? `${game.genre.toLowerCase()} game`
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
    applicationCategory: "Game",
    playMode: "SinglePlayer",
    url: canonicalUrl,
    image: game.images.filter(Boolean),
    screenshot: game.images.filter(Boolean).map((url) => ({
      "@type": "ImageObject",
      url,
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
      // Stored as sanitized HTML, so it needs the same treatment the
      // description got further up — otherwise an entity that DOMPurify left
      // behind is published here as "&amp;".
      text: truncateAtWord(htmlToPlainText(comment.content), LD_TEXT_MAX),
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
