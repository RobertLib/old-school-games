/**
 * Where this site lives.
 *
 * The canonical host was already configurable for the production redirect in
 * app.ts, but the address it redirects to was then written out by hand in a
 * hundred other places — every canonical tag, og:url, RSS link, sitemap entry
 * and JSON-LD url. Running the site anywhere else meant a deployment that
 * advertised somebody else's domain to search engines.
 *
 * The default keeps the behaviour of those hundred literals.
 */
export const SITE_HOST = process.env.CANONICAL_HOST ?? "oldschoolgames.eu";

/** Origin with no trailing slash, so `${SITE_URL}/news` composes cleanly. */
export const SITE_URL = `https://${SITE_HOST}`;

/**
 * The <title> and meta description a page falls back to when it names none of
 * its own.
 *
 * Both were written out by hand in five separate views — head.ejs twice, for
 * the Twitter card, and index.ejs, game-detail.ejs and the news views for the
 * title, description and Open Graph tags. Five copies of a sentence is five
 * chances for them to drift apart, and they are also the only titles no route
 * can reach: routes/home.ts needs this one to name the paged homepage, which
 * has no title of its own to number.
 *
 * app.ts puts them on app.locals as `siteTitle` and `siteDescription`, so the
 * views reach them the way they already reach `siteUrl`.
 */
export const SITE_TITLE = "OldSchoolGames - Play classic MS-DOS Games Online";

export const SITE_DESCRIPTION =
  // 158 characters as first written, against the 155 of META_DESCRIPTION_MAX
  // — and this is the description every page that names none of its own falls
  // back to, the home page included, so it was the most-served three
  // characters over the limit on the site.
  "Discover and play hundreds of classic MS-DOS games from the 80s and 90s " +
  "directly in your browser — retro gaming at its finest, with DOSBox " +
  "emulation.";

/**
 * Where game artwork and the js-dos bundles are served from.
 *
 * Hard-coded into the Content-Security-Policy in app.ts in two directives,
 * which made it the one deployment-specific address left in the source after
 * SITE_HOST was pulled out: pointing a fork at its own storage bucket meant
 * editing the policy, and getting it wrong fails silently — a blocked image or
 * bundle is reported nowhere but the browser console.
 *
 * The default is the current bucket, so nothing changes for this deployment.
 */
export const MEDIA_ORIGIN =
  process.env.MEDIA_ORIGIN ?? "https://trwglibsccninuamefls.supabase.co";

/**
 * The site's own name, as an entity rather than as a sentence.
 *
 * SITE_TITLE above is a <title> — brand plus tagline — and cannot be used
 * where a name is wanted on its own: `og:site_name`, the WebSite node and the
 * Organization node all need just the brand. Those three used to write it out
 * by hand, and two of them disagreed with the third: the Organization was
 * "OldSchoolGames.eu" on the home page and on /about while every other mention
 * on the site, `og:site_name` included, said "OldSchoolGames". A name is what
 * a search engine reconciles an entity by, so the two spellings described two
 * organisations. This is the one, and utils/organization.ts keeps the other
 * spelling as an alternateName rather than throwing it away.
 */
export const SITE_NAME = "OldSchoolGames";

/**
 * The image a shared link falls back to when the page has none of its own.
 *
 * This used to be /images/navbar.webp, which is 180x180 — and every consumer
 * of it has a floor above that. Facebook and LinkedIn want at least 200x200
 * and render no preview image at all below it; an X card declared
 * `summary_large_image` (views/head.ejs declares one on every page) wants at
 * least 300x157 and falls back to the small card without it; and Google asks
 * for 1200px of width before an image is eligible for an Article rich result,
 * which is what routes/news.ts hands this to. So the one image the site
 * advertised to every scraper was below every one of those thresholds, and
 * the failure is silent in all three places — nothing reports a preview that
 * simply came back blank.
 *
 * 1200x630 is the 1.91:1 that Open Graph, X and Google all document, and it
 * satisfies the Article floor at the same time. The artwork is the mascot from
 * navbar.webp — which is pixel art, so it is scaled by an integer factor with
 * nearest-neighbour sampling and stays crisp — set in the Norton Commander
 * palette this site is themed after, with the site name and tagline in VT323.
 *
 * The dimensions are exported beside it because og:image:width and
 * og:image:height let a scraper lay the card out on first sight instead of
 * fetching the file to measure it. They are declared only for *this* image:
 * see views/og-image.ejs for why a game's own cover gets no such pair.
 */
export const SITE_IMAGE = `${SITE_URL}/images/og-image.png`;
export const SITE_IMAGE_WIDTH = 1200;
export const SITE_IMAGE_HEIGHT = 630;

/**
 * The square mark, for the Organization node's `logo`.
 *
 * Not the favicon, which is what that node used to point at: favicon.png is
 * 32x32 and Google requires an Organization logo to be at least 112x112, so
 * the logo it named was too small to be used and the node lost its image
 * without saying so. Same mascot, same integer upscale, flattened onto the
 * site's background because a search result renders a logo against white and
 * the artwork is mostly light itself.
 */
export const SITE_LOGO = `${SITE_URL}/images/logo.png`;
export const SITE_LOGO_SIZE = 360;
