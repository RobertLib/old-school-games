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
 * Where the DOS player is served from, when that is not this site: an origin
 * of its own, or null for the arrangement the site has always had.
 *
 * The player is the one document here that runs third-party code, and it runs
 * it with 'unsafe-eval', blob: and a CDN in script-src (PLAYER_CSP in app.ts).
 * Framed from this site's own origin, the sandbox on its <iframe> is not a
 * boundary around any of that. It carries allow-scripts and allow-same-origin
 * — js-dos needs both — and the HTML standard itself warns that together, on
 * a same-origin document, they let the frame remove its own sandbox attribute
 * and reload itself unsandboxed. It does not even have to: it can reach
 * parent.document directly, and with it the page's links and forms, the CSRF
 * token in the <meta> tag, and the page's nonce off any of its <script>
 * elements. So a foothold inside the frame — a js-dos bug, or a tampered
 * emulators.js or wdosbox.js, which js-dos loads from jsDelivr with no
 * integrity check — runs as this site, an admin's session included, and the
 * player's relaxed policy is in practice the policy of the whole origin.
 *
 * Serving the player from another origin is what turns the frame into a
 * boundary: the same sandbox tokens then keep the *player's* origin, which
 * holds nothing but the player, and the page around it is out of reach. What
 * that asks for is a hostname — a subdomain with a certificate, or the app's
 * own *.fly.dev address — and it moves js-dos's storage, saved games
 * included, to that origin. Both are the owner's call, so this is a setting;
 * see "The player origin" in README.md for the rollout.
 *
 * Unset — the default — is exactly the behaviour from before the setting
 * existed: the player is /js-dos.html on this origin and nothing about a
 * deployment changes.
 *
 * Read strictly, and refused at boot rather than interpreted, because both
 * ways of being lenient fail somewhere nobody is looking. A value that is not
 * a bare http(s) origin would be framed and fetched from an address that is
 * not the one the operator meant; and a value naming this site's own host
 * would make every request to the site look like a request for the player,
 * which app.ts answers with the player's files or a 404 — the whole site gone,
 * from one environment variable. Plain HTTP is refused in production for the
 * duller reason that a browser refuses an http: frame inside an https: page,
 * so such a player would never load at all.
 *
 * Exported as a function as well as read below, so the rules can be tested
 * without re-importing this module under a different environment.
 */
export function parsePlayerOrigin(
  value: string | undefined,
  siteHost: string,
  production: boolean,
): string | null {
  // Empty is unset, not an origin: "PLAYER_ORIGIN=" in a .env file, or a
  // secret that resolved to nothing, means the operator has not chosen one.
  if (value === undefined || value.trim() === "") return null;

  let url: URL;

  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(
      `PLAYER_ORIGIN="${value}" is not an absolute URL. It names the origin ` +
        `the DOS player is served from, e.g. https://play.example.com.`,
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`PLAYER_ORIGIN="${value}" must be an http(s) origin.`);
  }

  if (production && url.protocol !== "https:") {
    throw new Error(
      `PLAYER_ORIGIN="${value}" must be https in production: a browser ` +
        `refuses a plain-HTTP frame inside an HTTPS page.`,
    );
  }

  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      `PLAYER_ORIGIN="${value}" must be an origin alone — a scheme and a ` +
        `host, with no path, query or credentials.`,
    );
  }

  if (url.host === siteHost.toLowerCase()) {
    throw new Error(
      `PLAYER_ORIGIN="${value}" is this site's own host. The player origin ` +
        `answers for the player's files and nothing else, so naming the site ` +
        `here would take every page off it.`,
    );
  }

  return url.origin;
}

export const PLAYER_ORIGIN = parsePlayerOrigin(
  process.env.PLAYER_ORIGIN,
  SITE_HOST,
  process.env.NODE_ENV === "production",
);

/**
 * The Host header a request for the player arrives with, when the player has
 * an origin of its own — the value app.ts compares against, the same way it
 * compares against SITE_HOST. The default port is already dropped by URL,
 * which is what a browser sends too.
 */
export const PLAYER_HOST =
  PLAYER_ORIGIN === null ? null : new URL(PLAYER_ORIGIN).host;

/**
 * Everything the player origin answers for — the frame, the script it loads
 * and its stylesheet, which is all public/js-dos.html asks its own origin for.
 * Everything else about the player comes from jsDelivr and the media bucket.
 *
 * A list rather than a directory, because the point is that the player origin
 * is not a second copy of this site: public/ is the site's scripts, styles,
 * fonts and images, and none of them has any business being served, cached or
 * indexed under the player's hostname. tests/public-assets.test.ts holds
 * js-dos.html to this list, so a new file the player needs cannot be added to
 * the page and forgotten here — which would be a player that works on this
 * origin and 404s its own script on the one it is meant to run on.
 */
export const PLAYER_PATHS: readonly string[] = [
  "/js-dos.html",
  "/js/js-dos-player.js",
  "/css/js-dos-player.css",
];

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

/**
 * An address anything can fetch without knowing which page it was found on.
 *
 * validations/games.ts accepts a cover or a screenshot as a path on this site
 * ("/images/doom.png") as well as a full URL, which is right for an <img> —
 * the browser resolves it against the page — and wrong everywhere the value
 * leaves the page: og:image, twitter:image and the JSON-LD `image` are read by
 * scrapers and search engines that do not resolve a relative address, so a
 * game with such a cover was shared with no picture at all. Resolved against
 * the canonical origin rather than the request's, because these tags describe
 * the canonical page.
 *
 * A value URL cannot parse is handed back unchanged rather than throwing: the
 * caller is rendering a page, and a malformed artwork address is not worth a
 * 500 on it.
 */
export function absoluteUrl(value: string): string {
  try {
    return new URL(value, `${SITE_URL}/`).href;
  } catch {
    return value;
  }
}
