/**
 * Builds the application: middleware, routes, error handling.
 *
 * Separate from index.ts, which listens on a port and handles signals, so the
 * suite can exercise the assembled app. Every route test used to mount a
 * single router into a bare express() with a plain-text 404 of its own, which
 * left the middleware order, the real 404 and 500 views and the security
 * headers untested — and that is exactly where the sidebar locals the error
 * views read went missing.
 */
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { fileURLToPath } from "url";
import path from "path";
import logger from "./utils/logger.ts";
import { createAssetUrl } from "./utils/assets.ts";
import { firstQueryValue, rawQuery } from "./utils/query.ts";
import { breadcrumbLdJson, buildBreadcrumbs } from "./utils/breadcrumbs.ts";
import { isNoindex } from "./utils/indexability.ts";
import {
  MEDIA_ORIGIN,
  SITE_DESCRIPTION,
  SITE_HOST,
  SITE_IMAGE,
  SITE_IMAGE_HEIGHT,
  SITE_IMAGE_WIDTH,
  SITE_NAME,
  SITE_TITLE,
  SITE_URL,
} from "./utils/site.ts";
import {
  ORGANIZATION_REF,
  organizationNode,
} from "./utils/organization.ts";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import compression from "compression";
import session, { type SessionOptions } from "express-session";
import connectPg from "connect-pg-simple";
import pool from "./db.ts";
import { flash } from "./middlewares/flash.ts";
import { sidebarData } from "./middlewares/sidebar-data.ts";
import { cacheEpochSync } from "./utils/cache-epoch.ts";

import authRoutes from "./routes/auth.ts";
import sitemapRoutes, { robotsTxt } from "./routes/sitemap.ts";
import homeRoutes from "./routes/home.ts";
import gamesRoutes from "./routes/games.ts";
import commentsRoutes from "./routes/comments.ts";
import newsRoutes from "./routes/news.ts";
import listsRoutes from "./routes/lists.ts";
import feedRoutes from "./routes/feed.ts";
import { csrfToken, validateCsrf } from "./middlewares/csrf.ts";
import { voterId } from "./middlewares/voter-id.ts";
import { cspNonce, scriptNonce } from "./middlewares/csp-nonce.ts";
import { rateLimitLogger } from "./utils/rate-limit-store.ts";
import { expectsJson } from "./utils/expects-json.ts";
import { TtlCache } from "./utils/cache.ts";
import {
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
} from "./utils/session-cookie.ts";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Everything in production ends up here. The target used to be built from
// req.headers.host, so a forged Host header turned the site's own HTTPS
// redirect into an open redirect to anywhere. It comes from utils/site.ts,
// which is also what every canonical tag, feed link and sitemap entry is
// built from — they used to be a hundred hand-written copies of this string.
const CANONICAL_HOST = SITE_HOST;
const CANONICAL_ORIGIN = SITE_URL;

/**
 * Where the DOS emulator is served from — see the comment in
 * public/js-dos.html.
 *
 * js-dos used to be loaded from "https://v8.js-dos.com/latest/", a moving
 * target running with full privileges in this origin. It is pinned to one
 * immutable release on jsDelivr now, which is also what makes the integrity
 * hashes in that file possible.
 *
 * That old host was left on the allowlist below for a while after the pin, as
 * a safety net in case something still reached for it — a refused subresource
 * inside the player frame is reported nowhere but the browser console. It is
 * gone now, and nothing names it: the loader and the stylesheet in
 * public/js-dos.html and the emulator runtime (pathPrefix in
 * public/js/js-dos-player.js) all point at the pinned release, and
 * tests/app.test.ts asserts the policy no longer carries the host.
 *
 * Leaving it would have kept the pin half-applied. An origin in "script-src"
 * may run as this site, so a "/latest/" that changes under us — or a vendor
 * CDN that is compromised — is exactly the exposure pinning to an immutable,
 * hash-checked copy exists to close.
 */
//
// The whole path, not the bare origin. jsDelivr serves every npm package and
// every GitHub file there is, so "https://cdn.jsdelivr.net" in script-src
// would let anyone who ever found a way to inject markup load a script of
// their own choosing and the nonce would count for nothing. Pinned to the one
// release the player loads — the version has to agree with public/js-dos.html
// and public/js/js-dos-player.js, and the suite checks that it does. jsDelivr
// does not redirect an exact-version path, so the path survives CSP matching.
const JS_DOS_VERSION = "8.4.1";
const JS_DOS_SOURCE = `https://cdn.jsdelivr.net/npm/js-dos@${JS_DOS_VERSION}/dist/`;

// Before helmet, so the directive below can read the nonce off res.locals.
app.use(cspNonce);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        "default-src": ["'self'"],
        "connect-src": [
          "'self'",
          // The emulator fetches wdosbox.wasm and the game bundle from here.
          JS_DOS_SOURCE,
          MEDIA_ORIGIN,
          "https://www.google-analytics.com",
          "https://analytics.google.com",
          "https://www.googletagmanager.com",
          "https://region1.google-analytics.com",
          "https://*.google-analytics.com",
        ],
        /**
         * What may run on a *page*, which is not what may run in the player.
         *
         * 'unsafe-eval', blob: and the js-dos CDN used to be here, so every
         * page on the site carried them — the home page, the listings, the
         * admin forms — although only one document needs any of them, and
         * that document is the emulator frame. 'unsafe-eval' in particular
         * undoes a good part of what the nonce buys: with it, an injected
         * string reaching any of the eval-alikes runs as this site, and the
         * nonce never enters into it.
         *
         * The relaxed set now applies to /js-dos.html alone — see
         * PLAYER_CSP further down, which replaces this header on that one
         * response. The frame is a separate document with its own policy,
         * which is the arrangement framing it was for in the first place.
         */
        "script-src": [
          "'self'",
          // Per-response nonce in place of 'unsafe-inline', which allowed any
          // inline script on the page — precisely what an injected payload
          // is. The views' inline blocks carry nonce="<%= cspNonce %>".
          scriptNonce,
          "https://www.googletagmanager.com",
          "https://www.google-analytics.com",
        ],
        // No inline handlers left: the confirm() prompts on the delete forms
        // are a delegated listener in ui.js reading data-confirm, so nothing
        // needs on*= attributes any more.
        "script-src-attr": ["'none'"],
        "img-src": [
          "'self'",
          // Naming this directive at all replaces helmet's default for it,
          // and the default was "'self' data:" — so listing the three hosts
          // below silently withdrew data:, which the emulator's own
          // stylesheet needs. js-dos.css draws its play button, its spinner
          // and the rest of the player chrome as url("data:image/svg+xml,…")
          // background images, and every one of them was refused inside the
          // player frame. Nothing reports that but the browser console.
          "data:",
          // Same stylesheet, same omission: it also pulls
          // "emulators-ui-loader.png" relative to itself, which resolves to
          // wherever the stylesheet came from rather than to this origin.
          JS_DOS_SOURCE,
          MEDIA_ORIGIN,
          "https://www.google-analytics.com",
          "https://www.googletagmanager.com",
        ],
        // Named so the blanket "https:" in helmet's default goes away. With
        // script-src pinned to a nonce, a stylesheet from anywhere on the web
        // was the loosest thing left in this policy: CSS is an exfiltration
        // channel — attribute selectors that fire a background request per
        // character read a token out of the page without running a line of
        // script. Everything here is self-hosted apart from the emulator's.
        //
        // 'unsafe-inline' is gone. It used to be here because four <style>
        // blocks needed it and only one of them could ever have carried a
        // nonce: the @font-face rules in views/head.ejs, the gallery overlay
        // in views/games/game-gallery.ejs, the player chrome in
        // public/js-dos.html — a static file, so there is no per-response
        // anything to stamp into it — and the shadow root built by
        // public/js/rating-stars.js, which is script-created markup. All four
        // are files now (public/css/{style,gallery,js-dos-player,
        // rating-stars}.css), which closes the directive and is the better
        // arrangement regardless: the rules are fetched once under a
        // content-hashed address instead of being re-sent inside every page.
        "style-src": ["'self'", JS_DOS_SOURCE],
        /**
         * The style="" attributes, which are a different thing from the
         * directive above and are deliberately still allowed.
         *
         * Undeclared, "style-src-attr" falls back to "style-src" — so closing
         * that one closed this too, and the layout carries some three hundred
         * style attributes across twenty-eight templates. Rewriting them into
         * classes is a visual refactor with no security argument behind it:
         * a style attribute holds declarations for one element and cannot
         * contain a selector, so it cannot mount the attribute-selector
         * exfiltration the comment above describes. That attack needs a
         * <style> element or a foreign stylesheet, and both are now refused.
         *
         * What is left for an attacker here needs HTML injection first, which
         * is what the escaping in the templates and DOMPurify are for — and
         * at that point a style attribute is the least of it.
         */
        "style-src-attr": ["'unsafe-inline'"],
        // Every face is served out of public/fonts, so the default's
        // "https:" bought nothing. data: is kept because it costs nothing to
        // allow and a blocked font is a silent fallback rather than an error.
        "font-src": ["'self'", "data:"],
        "frame-src": ["'self'"],
        /**
         * No "worker-src" here, deliberately.
         *
         * Undeclared it falls back to "child-src" and then to "default-src",
         * which is "'self'" alone — and no page on this site starts a worker
         * at all. The one thing that does is the emulator, and it does not
         * load its worker from an address on this origin: emulators.js
         * fetches wdosbox.js from the pinned release, turns the response
         * into a blob, and constructs the worker from the resulting "blob:"
         * address:
         *
         *   const d = URL.createObjectURL(await (await fetch(e)).blob());
         *   const h = new Worker(d);
         *
         * Whether "'self'" covers a blob: URL is exactly the point on which
         * browsers have differed, so the directive has to be named — in
         * PLAYER_CSP below, on the one response that runs the emulator,
         * rather than on every page of the site.
         */
      },
    },
  }),
);

/**
 * Features this site does not use, switched off for itself and for anything
 * it frames.
 *
 * helmet sets no Permissions-Policy at all, so every one of these was
 * available to any script running on the page — including the emulator, which
 * is third-party code with 'unsafe-eval', and the analytics tag. Naming them
 * costs one header and means a compromised or merely curious dependency
 * cannot reach for a camera, a location or a USB device without the browser
 * refusing first.
 *
 * The list is what the site demonstrably does not touch. Deliberately absent:
 * "fullscreen", which the DOS player uses (see setFullScreen in
 * public/js/js-dos-player.js); "autoplay" and "gamepad", which the emulator
 * needs for sound and controllers; and "clipboard-*", because a game bundle
 * may legitimately copy a save. Naming any of those would break something
 * quietly — a refused feature is reported nowhere but the browser console,
 * which is the failure mode the CSP comments above keep running into.
 *
 * Absent for a different reason: "ambient-light-sensor". The API it names
 * never shipped unflagged in any browser, so denying it protects nothing,
 * and every engine answers an unknown feature with an "Unrecognized feature"
 * warning on every page load. That noise is expensive precisely here — the
 * console is where a refused feature above would show up, and a console that
 * cries wolf once per navigation is one nobody reads.
 */
const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "bluetooth=()",
  // Google's ad-topics API. Nothing here advertises, and the analytics tag is
  // configured with every ad signal denied — see views/head.ejs.
  "browsing-topics=()",
  "camera=()",
  "display-capture=()",
  "encrypted-media=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "idle-detection=()",
  "local-fonts=()",
  "magnetometer=()",
  "microphone=()",
  // Web MIDI, not the MIDI music a DOS game plays — that is synthesised
  // inside the emulator and needs no browser feature.
  "midi=()",
  "payment=()",
  "serial=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

// With helmet rather than after the redirects below, so a 301 onto HTTPS
// carries it too — the same reasoning the redirect's own comment gives for
// running helmet first.
app.use((req, res, next) => {
  res.setHeader("Permissions-Policy", PERMISSIONS_POLICY);
  next();
});

/**
 * How long the database is given to answer the probe below.
 *
 * The pool itself gives up on a connection after two seconds (see db.ts), so
 * this is a belt-and-braces bound on the whole probe: a health check that
 * hangs is a failed one — the single outcome this endpoint is written to
 * avoid while the database is away.
 */
const HEALTH_DB_TIMEOUT_MS = 2_000;

/**
 * How long one probe's answer is reused, and the cache holding it.
 *
 * Sitting above the rate limiter is what keeps this endpoint answerable while
 * the site is shedding load — and it is also what leaves it the one route
 * nothing throttles. That was not free: every call took a connection out of
 * the pool db.ts caps at ten, which is the same pool the session store and
 * every page's own queries come out of. Anything asking for /healthz in a
 * loop could make the site slow by asking politely.
 *
 * A cache rather than a limiter, because a limiter has to refuse somebody and
 * the one caller that must never be refused is the platform's own check.
 * Caching refuses nobody: every request is still answered, and the database is
 * asked at most once per window however many arrive.
 *
 * TtlCache holds the in-flight promise rather than the settled value, so a
 * burst landing on a cold entry shares one query instead of each starting
 * another — which is the case that actually mattered here, because a probe
 * being slow is exactly when the pool is worth protecting. It also means a
 * hanging probe is waited on rather than multiplied; pool and statement
 * timeouts settle it either way.
 *
 * Five seconds, against the 30s interval in fly.toml: every real check still
 * runs a probe of its own, so the platform never reads a cached answer. It is
 * local to this file rather than in utils/page-cache.ts because no model
 * invalidates it — that file exists to keep the models from importing the
 * routes, and no model has an opinion about whether Postgres is up.
 *
 * Exported only so the suite can drop the entry between cases, the way
 * middlewares/sidebar-data.ts exports its own cache and for the same reason.
 * Without it the test that asserts an unreachable database reports "down"
 * would instead be handed the "up" the case before it had just cached — the
 * whole file runs well inside one TTL.
 */
const HEALTH_CACHE_TTL_MS = 5_000;
const HEALTH_CACHE_KEY = "db";
export const healthCache = new TtlCache();

/**
 * Liveness, for the platform's health check.
 *
 * Above the canonical-host redirect on purpose: the check arrives addressed to
 * the machine rather than to the site's own hostname, so anywhere below that
 * redirect it would be answered with a 301 and read as a failure. It is above
 * the rate limiter, the request log, the session and the sidebar data for the
 * same reasons robots.txt is — a check every half minute should not spend the
 * request budget, take a session row, or run six queries to answer with two
 * words.
 *
 * What this adds over the TCP check it replaces is the one thing a socket
 * cannot say: that the process is still answering HTTP rather than merely
 * holding the port open.
 *
 * The database is reported and does not decide the answer. This app is built
 * to outlive Postgres being unreachable — every sidebar widget has a fallback,
 * both limiters pass `passOnStoreError`, and db.ts logs an idle client error
 * rather than exiting — so a page with blank widgets is what a database outage
 * is meant to look like here. Failing the check would instead pull the last
 * machine out of the proxy's rotation and turn that into a 503 for the whole
 * site. A *release* that cannot reach the database is already stopped earlier,
 * by the migrations in fly.toml's release_command.
 */
app.get("/healthz", async (req, res) => {
  const probe = healthCache.get(HEALTH_CACHE_KEY, HEALTH_CACHE_TTL_MS, () =>
    pool
      .query("SELECT 1")
      .then(() => "up")
      // Inside the loader, not on what get() returns: the catch has to be part
      // of the promise the cache stores, so that a rejection arriving after
      // the timeout below has been answered is not an unhandled one — and so
      // that every request sharing this entry gets "down" rather than a throw.
      .catch(() => "down"),
  );

  const database = await Promise.race([
    probe,
    new Promise<string>((resolve) => {
      // unref'd so a pending probe cannot by itself hold the process open
      // while it is draining.
      setTimeout(() => resolve("timeout"), HEALTH_DB_TIMEOUT_MS).unref();
    }),
  ]);

  // Never cached, by anything. The whole value of this endpoint is that it
  // answers for *this* machine at *this* moment: a proxy or a browser holding
  // the JSON for even a few seconds reports a machine that has since gone away
  // as up. The probe inside the process is cached deliberately and separately
  // — see healthCache — which is the caching this endpoint wants.
  res.setHeader("Cache-Control", "no-store");
  res.json({ status: "ok", database });
});

// After helmet, not before it. These redirects are the first thing a request
// arriving on plain HTTP or under the wrong host meets, and answered above
// they went out bare: no Strict-Transport-Security, no nosniff, no
// frame-ancestors — on the one response whose whole job is to move a browser
// onto HTTPS, which is exactly where an HSTS header earns its keep. Helmet
// only sets headers, so running it first costs the redirect nothing.
app.use((req, res, next) => {
  if (process.env.NODE_ENV !== "production") {
    return next();
  }

  // req.path and the raw query, not req.originalUrl — the same construction
  // the trailing-slash redirect below uses, and for the same reason it gives
  // there: req.originalUrl is the request target as it arrived, and Node
  // accepts the absolute form ("GET http://evil.example/ HTTP/1.1"). Appending
  // that to this site's own origin produced a Location of
  // "https://oldschoolgames.euhttp://evil.example/", which is a redirect off
  // the site that every browser on plain HTTP or the wrong host would follow.
  // req.path is the parsed path, so it always begins with a slash.
  const target = `${req.path}${rawQuery(req)}`;

  if (req.headers.host !== CANONICAL_HOST) {
    return res.redirect(301, `${CANONICAL_ORIGIN}${target}`);
  }

  // The first value, not the raw header. Node joins a header that arrives
  // twice into "https, http", which never equals "https" — so a second proxy
  // in front of this one turned the check into a redirect loop, and the loop
  // is the whole site rather than one page. This is what express's own
  // req.protocol does with the header; it is spelled out here because
  // req.protocol only consults it when "trust proxy" is set, and that is set
  // further down and only in production — a coupling this redirect should not
  // depend on to avoid looping.
  //
  // 301, matching the host redirect above. Moving a visitor onto HTTPS is not
  // a temporary arrangement, and the 302 this used to send asked every
  // browser and crawler to come back over plain HTTP next time to be told
  // again. force_https in fly.toml means production is HTTPS permanently.
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]!
    .trim();

  if (forwardedProto !== "https") {
    return res.redirect(301, `${CANONICAL_ORIGIN}${target}`);
  }

  next();
});

/**
 * One address per page, with no trailing slash on any of them.
 *
 * Express does not run in strict-routing mode, so "/doom/" matched "/:slug"
 * and answered 200 with the very same page as "/doom" — as did "/developers/",
 * "/action/", "/news/" and every other path on the site. Two addresses serving
 * one page is the duplicate-content trap that utils/pagination.ts refuses
 * "?page=01" for, and that routes/sitemap.ts gives its own reasoning for when
 * it redirects /sitemap.xml onto the one sitemap.
 *
 * It was not doing real damage: every indexable page names an explicit
 * canonicalUrl built from SITE_URL and a path written without the slash, so a
 * crawler that reached the slashed form was told where the page really lives.
 * But a canonical is a hint that costs a crawl to read, and the redirect is
 * the half that does not depend on being believed. Turning on strict routing
 * instead would answer 404, which is worse: these are real addresses people
 * paste and link, and the page they mean plainly exists.
 *
 * GET and HEAD only. A 301 is not a method-preserving redirect — a browser
 * re-issues it as a GET — so applying this to the comment, rating and admin
 * form posts would silently drop their bodies. Nothing on the site posts to a
 * slashed address anyway; if something ever does, it should fail loudly at the
 * route rather than quietly here.
 *
 * The Location is relative, like the breadcrumb paths and for the same reason
 * utils/breadcrumbs.ts gives: the canonical-host redirect above is
 * production-only, so an absolute address here would bounce anyone browsing a
 * development or staging build out to the live site.
 */
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return next();
  }

  // req.path is the parsed path, not the raw request target. Built from
  // req.originalUrl this answered an absolute-form target — "GET
  // http://evil.example/ HTTP/1.1", which Node accepts — with a Location of
  // "http://evil.example", an address off this site. The two guards below
  // never saw it, because it does not begin with a slash at all.
  const pathname = req.path;
  const query = rawQuery(req);

  // "/" is the one path that keeps its slash, and the only one shorter than
  // two characters.
  if (pathname.length < 2 || !pathname.endsWith("/")) {
    return next();
  }

  // Left alone deliberately. "//evil.com/" trims to "//evil.com", and a
  // Location beginning with two slashes is a protocol-relative URL — a browser
  // reads it as another origin entirely, which would make this an open
  // redirect out of the site. Nothing links to such an address; it falls
  // through to the 404 it already answers.
  //
  // A backslash counts as well: "/\evil.com/" trimmed to "/\evil.com", which
  // is not two slashes, yet a browser following the WHATWG URL parser reads
  // "/\" the same as "//" and lands on evil.com all the same.
  if (/^\/[/\\]/.test(pathname) || pathname.includes("\\")) {
    return next();
  }

  // Every trailing slash, not just the last: "/doom///" is the same page too,
  // and it 404s today rather than resolving.
  const target = pathname.replace(/\/+$/, "");

  return res.redirect(301, `${target}${query}`);
});

app.use(compression());

const PUBLIC_DIR = path.join(__dirname, "public");

// On app.locals, so every view reaches them as bare `asset` and `siteUrl`
// without each route having to pass them along.
// asset("/js/ui.js") -> "/js/ui.js?v=<content hash>".
app.locals.asset = createAssetUrl(PUBLIC_DIR);
app.locals.siteUrl = SITE_URL;

// Where the game artwork comes from, for the preconnect in views/head.ejs.
// Already named twice in the Content-Security-Policy above; this is the same
// constant rather than a third copy of the address — see MEDIA_ORIGIN in
// utils/site.ts for why it stopped being a literal.
app.locals.mediaOrigin = MEDIA_ORIGIN;

// The breadcrumb trail, derived from whatever locals a page was rendered with.
// Here rather than passed by each route, because views/head.ejs needs it on
// every page to emit the BreadcrumbList schema and no route should have to
// remember that. See utils/breadcrumbs.ts for what it replaced.
app.locals.buildBreadcrumbs = buildBreadcrumbs;
app.locals.breadcrumbLdJson = breadcrumbLdJson;

// Whether a page wants to be indexed — the one answer views/head.ejs turns
// into the robots tag, the canonical and the breadcrumb schema, and that the
// listing views now gate their own JSON-LD on. Here rather than worked out
// again in each template, so the page cannot say two different things about
// itself; see utils/indexability.ts.
app.locals.isNoindex = isNoindex;

// The title and description a page falls back to when it names none of its
// own. They used to be written out by hand in every view that needed them —
// see the comment on SITE_TITLE in utils/site.ts.
app.locals.siteTitle = SITE_TITLE;
app.locals.siteDescription = SITE_DESCRIPTION;

// The same treatment for the brand name and the fallback share image, which
// were the next two strings written out by hand in every view — the image in
// twenty-three of them. views/og-image.ejs is what reads these now; see the
// comments on SITE_IMAGE and SITE_NAME in utils/site.ts for what the old
// literal cost.
app.locals.siteName = SITE_NAME;
app.locals.siteImage = SITE_IMAGE;
app.locals.siteImageWidth = SITE_IMAGE_WIDTH;
app.locals.siteImageHeight = SITE_IMAGE_HEIGHT;

// The publisher of everything on the site, for the two views that put it in a
// JSON-LD graph. One description of one entity — see utils/organization.ts for
// the three that this replaced.
app.locals.organizationNode = organizationNode;

// How to point at it from another node without describing it twice — the
// home page's WebSite names its publisher this way.
app.locals.organizationRef = ORGANIZATION_REF;

// Static files are served before the limiter counts anything. One page view
// pulls in a dozen scripts, fonts and stylesheets, so with assets included the
// budget below was really about a hundred page views — enough to lock out a
// school or an office behind a single NAT.
/**
 * The two files the DOS player is made of, which are the one pair in public/
 * that the fingerprinting above cannot reach.
 *
 * app.locals.asset stamps a content hash into every address a *template*
 * writes, and that is what makes a fix reach a browser that already has the
 * old copy. Neither of these was reachable that way. js-dos.html is framed
 * from views/games/game-detail.ejs, which called it by its bare name; and
 * js-dos.html is itself a static file, so the <script> tag inside it names
 * /js/js-dos-player.js by *its* bare name in turn, with no template anywhere
 * in the chain to stamp anything. So neither address ever changed, and both
 * were served with the modest lifetime below.
 *
 * Half of that is closed now — the frame goes through asset() (see the
 * comment beside the <iframe> in game-detail.ejs, and the test that holds it
 * there), so it carries a hash like everything else a template writes. The
 * script inside it still cannot: it is named from a static file, and what it
 * carries is the fixed "?retired-v8" marker rather than a content hash. That
 * is why the rule below is keyed on the file and not on whether the address
 * has a version in it — see the setHeaders branch below.
 *
 * A day of it is a day of the previous player, which is not a cosmetic
 * difference: pinning the emulator to jsDelivr (see JS_DOS_SOURCE) moved
 * pathPrefix into js-dos-player.js at the same time as it dropped
 * v8.js-dos.com from "script-src". A browser holding yesterday's script ran
 * the old default — "https://v8.js-dos.com/latest/emulators/" — against
 * today's policy, which no longer allows that host, and the emulator was
 * refused before it could load: "Unable to init emulators.js", no game, and a
 * console message as the only sign of it. Reloading fixed it, because that is
 * what revalidates a stale copy.
 *
 * Revalidating is what these should have been doing all along. "no-cache"
 * does not mean "do not store" — the copy is kept, and the browser asks
 * whether it is still current, which the ETag answers with a 304 and no body.
 * The cost is two conditional requests per game page; the alternative is a
 * deploy that lands on some visitors up to a day late.
 */
const PLAYER_FRAME = path.join(PUBLIC_DIR, "js-dos.html");
const PLAYER_SCRIPT = path.join(PUBLIC_DIR, "js", "js-dos-player.js");

/**
 * The two stylesheets that are named by their bare addresses for the same
 * reason the player files above are, and so need the same treatment.
 *
 * js-dos-player.css is linked from public/js-dos.html, a static file that
 * cannot call app.locals.asset; rating-stars.css is linked from inside a
 * shadow root by public/js/rating-stars.js, which is script and cannot
 * either. Both exist because style-src no longer allows 'unsafe-inline' — see
 * the policy above — so a copy of either going stale is a page rendered
 * unstyled, with nothing but the browser console to say so.
 */
const PLAYER_STYLESHEET = path.join(PUBLIC_DIR, "css", "js-dos-player.css");
const STARS_STYLESHEET = path.join(PUBLIC_DIR, "css", "rating-stars.css");

const REVALIDATED_FILES = new Set([
  PLAYER_FRAME,
  PLAYER_SCRIPT,
  PLAYER_STYLESHEET,
  STARS_STYLESHEET,
]);

/**
 * The emulator's own Content-Security-Policy, which is not the site's.
 *
 * js-dos compiles DOSBox at runtime and cannot start without 'unsafe-eval';
 * it builds its worker out of a blob: URL; and it loads a script, a
 * stylesheet, a wasm module and a loader image from the pinned jsDelivr
 * release. All four of those used to be granted to every page on the site,
 * because helmet writes one policy for the whole app — so the home page, the
 * listings and the admin forms carried a script-src an injected payload
 * could eval its way through, to support one document that nothing else
 * shares an origin's worth of risk with.
 *
 * Framing the player is what makes the split possible: /js-dos.html is a
 * document of its own, so it can be served a policy of its own, and the page
 * around it keeps the strict one. What the frame is allowed to do is also
 * bounded from the other side, by the sandbox attribute on the <iframe> —
 * see views/games/game-detail.ejs.
 *
 * Written by hand rather than through a second helmet instance: helmet would
 * have to be mounted per-path with a full directive set anyway, and the
 * point of this list is that a reader can see the whole policy the emulator
 * runs under without cross-referencing the one above.
 *
 * Two directives are here for reasons that are easy to miss:
 *
 *   - "style-src-attr", because js-dos.html sizes #dos and hides the SVG
 *     filter with style="" attributes, and an undeclared style-src-attr
 *     falls back to the style-src above it.
 *   - "connect-src" naming MEDIA_ORIGIN, because the game bundle is fetched
 *     from there by the emulator itself. The parent page never fetches it.
 *
 * Nothing analytics-related is here. The frame runs no tag, and a policy is
 * the one place where "it does no harm" is not a reason to list something.
 */
const PLAYER_CSP = [
  "default-src 'self'",
  // 'unsafe-eval' is the emulator, blob: is its worker script, and the CDN
  // path is js-dos.js itself — pinned to one release and hash-checked, see
  // JS_DOS_SOURCE and public/js-dos.html.
  `script-src 'self' 'unsafe-eval' blob: ${JS_DOS_SOURCE}`,
  // No inline handlers in the frame either.
  "script-src-attr 'none'",
  `worker-src 'self' blob: ${JS_DOS_SOURCE}`,
  `connect-src 'self' ${JS_DOS_SOURCE} ${MEDIA_ORIGIN}`,
  // data: for the chrome js-dos.css draws as inline SVG backgrounds, the CDN
  // for its loader PNG, MEDIA_ORIGIN because a bundle may carry artwork.
  `img-src 'self' data: ${JS_DOS_SOURCE} ${MEDIA_ORIGIN}`,
  `style-src 'self' ${JS_DOS_SOURCE}`,
  "style-src-attr 'unsafe-inline'",
  "font-src 'self' data:",
  "base-uri 'self'",
  "form-action 'self'",
  // The frame belongs on this site's own game pages and nowhere else.
  "frame-ancestors 'self'",
  "object-src 'none'",
].join("; ");

/**
 * Swaps helmet's policy for the player's on the one response that needs it.
 *
 * Order is the whole mechanism here: helmet is mounted at the top of the
 * file and has already written its own header by the time a request reaches
 * this point, so this must overwrite rather than append — setHeader, not
 * appendHeader, and after helmet rather than before it. Two
 * Content-Security-Policy headers on one response are not a choice between
 * policies: the browser enforces the intersection, which would refuse the
 * emulator exactly as the strict policy does.
 *
 * Above express.static so it is set before the file is written, and keyed on
 * req.path so the "?v=" the template stamps in and the "?stream=" the player
 * reads are both matched. A request for anything else falls through
 * untouched and keeps helmet's header.
 *
 * express.static answers /js-dos.html "no-cache" (see REVALIDATED_FILES
 * below), which matters more now than it did: a copy of the frame frozen in
 * a browser would be a copy of this policy frozen with it, and the next
 * change here would reach the player inside the frame immediately and the
 * frame itself a year late.
 */
app.use((req, res, next) => {
  if (req.path === "/js-dos.html") {
    res.setHeader("Content-Security-Policy", PLAYER_CSP);
  }

  next();
});

app.use(
  express.static(PUBLIC_DIR, {
    maxAge: "1d",
    setHeaders(res, filePath) {
      if (REVALIDATED_FILES.has(filePath)) {
        // Ahead of the ?v= rule below, and not an "else" to it. Two of
        // the four files in this set carry a version in their address —
        // the frame from asset(), the script from its "?retired-v8" marker
        // — so the rule below would otherwise catch them, and "immutable"
        // is the one lifetime the player frame must never be given. Its
        // Content-Security-Policy is not part of the file — the middleware
        // just above writes PLAYER_CSP onto the response — so a frozen copy
        // freezes a header that lives in app.ts, and the next change to that
        // policy would reach those browsers a year late while reaching the
        // player inside the frame immediately. Revalidating answers with a
        // 304 that carries today's header, which is exactly what is wanted.
        res.setHeader("Cache-Control", "public, no-cache");
      } else if (res.req?.query?.v) {
        // A request carrying ?v= came from a template that stamped the
        // file's own content hash into the address, so that copy can never
        // go stale and is worth keeping for a year. Anything asked for by
        // its bare name keeps the modest lifetime above.
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  }),
);

// Alongside the static files, and for the same reason: it used to be one.
// It moved into a route so the Sitemap line could name the host the site is
// actually running on, and it stays here rather than with the other routes so
// that the only thing that ever asks for it — a crawler — is not handed a
// session, a CSRF token and a voter id it will never send back.
app.get("/robots.txt", robotsTxt);

/**
 * The coarse global budget, counted in this process's memory — the library's
 * default store — and not in Postgres like every other limiter here.
 *
 * Per-machine counting is the correct semantics for this one, and that is the
 * point rather than a concession. The limits that guard logins and comment
 * posting are about a *person's* behaviour, so they have to be shared across
 * machines or they double with every one added; this one exists to keep a
 * single machine's ten-connection pool and event loop from being flooded, and
 * a flood arrives at a machine, not at the app.
 *
 * The cost of having it in Postgres was that this limiter sits above every
 * route, so every request on the site — including the ones answered from a
 * cache, and the static assets — began with a write to the database, in series,
 * before anything else could happen. A 1000-per-15-minutes ceiling is not worth
 * an upsert per request, and it was the one limiter whose store could make the
 * database the bottleneck for requests that would otherwise never touch it.
 *
 * With no store of its own the library needs no passOnStoreError either: an
 * in-memory Map does not fail.
 */
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1000,
  // ...and says so through utils/logger.ts rather than the library's
  // own console fallback — see rateLimitLogger.
  logger: rateLimitLogger,
});

app.use(limiter);

// Ahead of the session, so a request that fails anywhere below still leaves a
// line. It used to sit under the whole middleware stack, which meant the
// requests worth knowing about — the ones rejected before they reached a route
// — were the ones that went unlogged. Static assets stay out of it: they are
// served above, and one page view pulls in a dozen.
app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();

  // The path as it arrived, not as it looks later: a router that mounts on a
  // prefix rewrites req.url while it is inside, and this listener runs after
  // all of them. req.path in particular is derived from req.url.
  const { method } = req;
  const requestPath = req.path;

  /**
   * On "finish" rather than before next(), and with fields rather than a
   * sentence.
   *
   * Logging on the way in meant the line said nothing about what happened:
   * no status, no duration, and one line whether the request was answered,
   * refused or took thirty seconds. The status is the single most useful
   * thing to filter a log by and it was the one thing missing.
   *
   * Structured, because a log collector can count 500s per path or sort by
   * durationMs, and cannot do either with a substring of a message — see the
   * field handling in utils/logger.ts.
   *
   * The query string is left out on purpose. It carries what a visitor typed
   * into the search box, which is the most personal thing this site ever
   * receives, and it is the part of a URL with the least diagnostic value:
   * "/search" with a 200 says what happened. The timestamp is gone from the
   * message for a duller reason — every line already carries one.
   *
   * "finish" fires when the response has been handed to the socket. A
   * connection dropped halfway emits "close" and not "finish", so such a
   * request goes unlogged; that is the same silence as before and not worth
   * a second line per request to close.
   */
  res.on("finish", () => {
    logger.info("request", {
      method,
      path: requestPath,
      status: res.statusCode,
      // Whole milliseconds are too coarse for a cached page and a bigint
      // does not survive JSON.stringify, so: a number, to one decimal.
      durationMs:
        Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10,
    });
  });

  next();
});

// Above the sitemap and the feeds, not below the session where it used to sit.
// Those two routers hold the longest-lived caches in the app (24h for the
// sitemap), and mounted beneath this check they could be filled by a crawler
// on a freshly started machine before the process had ever read the epoch —
// after which the first read simply adopted the current value and the stale
// sitemap survived its whole TTL. Every cached answer now sits under the
// check. It costs one tiny query per process per interval, and nothing at all
// on the requests in between.
app.use(cacheEpochSync);

// With robots.txt above rather than with the routers below, and for the same
// reason: the sitemap and the two feeds are asked for by crawlers and by
// nothing else, they render no view and they read no session — yet going
// through the full stack handed every crawler a session row, a CSRF token and
// a voter id it would never send back. A sitemap chunk that names no real page
// still falls through to the 404 view, which defaults its own sidebar locals.
app.use("/", sitemapRoutes);
app.use("/", feedRoutes);

// Everything below is rendered per request and can carry a session, a CSRF
// token or an admin's view of a page, so nothing but the browser that asked
// for it may store the answer. With no Cache-Control header at all — which is
// what these responses used to send — a shared cache is free to apply a
// heuristic of its own, and that is not a decision to leave to a proxy or to
// a CDN somebody puts in front of this later.
//
// Placed here rather than at the top of the stack so it covers only those:
// the assets above keep their long lifetimes (express.static answers them and
// never reaches this), and robots.txt, the sitemap and the two feeds are
// public documents that should stay cacheable.
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "private, no-cache");
  next();
});

/**
 * Every view reaches for the request, including the ones rendered from a
 * middleware or an error handler that skips most of the stack.
 *
 * Above the body parsers, which is further up than it looks like it needs to
 * be. Every template here reads `req` directly — head.ejs for "?search=",
 * navbar.ejs and footer.ejs for the session, left-sidebar.ejs and
 * right-sidebar.ejs for the current path — so anything that renders a view
 * before this has run gets a ReferenceError out of EJS rather than the page
 * it asked for. Express answers that with its own default error page, which
 * carries a stack trace, absolute paths and the offending template's source.
 *
 * Two things render before the routes do, and both used to hit it:
 *
 *   - validateCsrf, whose refusal is a rendered 403. That is what first moved
 *     this above the CSRF middleware.
 *   - express.json() and express.urlencoded(), which reject a body they
 *     cannot read by handing on an error — and the handler at the foot of
 *     this file answers a form post with the 400 view. That path never got a
 *     page at all: it threw in head.ejs on the first `req` it touched, every
 *     time, and shipped the stack trace instead. tests/app.test.ts asserted
 *     the response contained "400 - Bad Request" and passed while this was
 *     broken, because the trace it was shown quotes the line of 400.ejs that
 *     sets that very title.
 *
 * Nothing above needs to move with it: this sets two locals and touches no
 * I/O, so running it a few middlewares earlier costs nothing. It reads
 * req.query, which express parses itself — no body parser involved — and the
 * session it does not have yet is only ever read through `?.` in the
 * templates.
 */
app.use((req, res, next) => {
  res.locals.req = req;

  // The navbar's search box is on every page, so it cannot read the value the
  // routes parse for themselves. Reaching for req.query.search directly meant
  // "?search=a&search=b" — which express hands over as an array — searched for
  // "a" but showed "a,b" in the box.
  res.locals.searchQuery = firstQueryValue(req.query.search) ?? "";

  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/**
 * Restores the invariant everything below was written against: that a request
 * has a body object, even an empty one.
 *
 * body-parser 2 — what express 5 ships — leaves `req.body` as `undefined`
 * when a request carries no body, or one whose content type neither parser
 * claims. express 4 set `{}`, and the routes and validators here read it the
 * way they always did: `const { email, password } = req.body` in
 * routes/auth.ts, and the same destructuring at the top of validateComment
 * and validateGameRating. Against `undefined` that throws, and the throw is a
 * 500 — for a POST that simply arrived without a body.
 *
 * That is reachable, not theoretical: validateCsrf accepts the token in the
 * "x-csrf-token" header as well as the form field, so a bodyless POST clears
 * the CSRF gate and lands in the route. /login, /comments and /games/:id/rate
 * all answered 500 to one.
 *
 * Here rather than as a guard at each of those sites, because the guards are
 * the sort of thing a new route forgets: one line restores the shape the whole
 * app expects. It runs after both parsers so it cannot mask what they parsed,
 * and before validateCsrf, whose own optional chaining is now belt and braces.
 */
app.use((req, res, next) => {
  req.body ??= {};
  next();
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

/**
 * What .env.example carries in the SESSION_SECRET slot, and the shortest
 * secret production will start with.
 *
 * Presence was the whole of this check, and presence is the easy half. The
 * placeholder is published in this repository, so a deploy that copied the
 * example file has a SESSION_SECRET that is set, passes the guard, and signs
 * every session cookie with a value anyone can read off GitHub — which is a
 * forgeable admin session, not a configuration wrinkle. A short secret is the
 * same failure by a slower route: 32 bytes of hex is what the README tells you
 * to generate, and anything under it is worth refusing at boot rather than
 * trusting.
 */
const SESSION_SECRET_PLACEHOLDER = "change-me-to-a-long-random-secret";
const SESSION_SECRET_MIN_LENGTH = 32;

if (process.env.NODE_ENV === "production") {
  const secret = process.env.SESSION_SECRET;

  if (!secret) {
    throw new Error(
      "SESSION_SECRET environment variable is required in production",
    );
  }

  if (secret === SESSION_SECRET_PLACEHOLDER) {
    throw new Error(
      "SESSION_SECRET is still the .env.example placeholder; generate a real one",
    );
  }

  if (secret.length < SESSION_SECRET_MIN_LENGTH) {
    throw new Error(
      `SESSION_SECRET must be at least ${SESSION_SECRET_MIN_LENGTH} characters in production`,
    );
  }
}

const pgSession = connectPg(session);

const sessionOptions: SessionOptions = {
  // errorLog, for the same reason the limiters pass rateLimitLogger: the
  // store's own fallback is console.error, a plain line beside the JSON ones
  // and absent from error.log, which is where a failed session prune or read
  // needs to be seen.
  store: new pgSession({
    pool,
    errorLog: (...args: unknown[]) => logger.error(args.map(String).join(" ")),
  }),
  secret: process.env.SESSION_SECRET ?? "secret",
  resave: false,
  saveUninitialized: false,
  // Named explicitly, and the attributes come from the same constant the
  // logout route clears the cookie with — see utils/session-cookie.ts.
  name: SESSION_COOKIE,
  /**
   * Re-sent on every response, so the week below is a week of inactivity
   * rather than a week from signing in.
   *
   * Without this the cookie expired at a fixed moment whatever the admin was
   * doing, which is the wrong shape for both halves of the trade: an admin
   * halfway through editing a game was logged out mid-form, and a cookie
   * left behind on a shared machine stayed valid for its full term however
   * long nobody touched it. Rolling makes the expiry mean "idle since", and
   * that is what lets the term below be short enough to matter.
   *
   * It costs a Set-Cookie on the responses that carry a session and a
   * store.touch to slide the row's expiry with it. saveUninitialized is
   * false, so a visitor who never logs in still gets neither.
   */
  rolling: true,
  cookie: {
    ...SESSION_COOKIE_OPTIONS,
    /**
     * Seven days of inactivity, not thirty.
     *
     * The only thing a session holds on this site is an administrator — see
     * routes/auth.ts, which is the one place anything is written to it — so
     * this is the lifetime of a stolen or simply forgotten admin cookie.
     * A month of it was chosen when the session was also carrying the CSRF
     * token for every anonymous visitor; that moved to a cookie of its own
     * (middlewares/csrf.ts) and nothing is left in here for a visitor at
     * all, so the long term now buys nobody any convenience.
     *
     * With rolling above, a week is a week of not touching the site. An
     * admin who uses it is never logged out by this.
     */
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
};

app.use(session(sessionOptions));

app.use(flash);

app.use(voterId);

app.use(csrfToken);
app.use(validateCsrf);

// cacheEpochSync is mounted far above, ahead of the sitemap and the feeds, so
// a request that falls on a check boundary reads its widgets from caches
// another machine's write has already emptied.
app.use(sidebarData);

// sitemapRoutes and feedRoutes are mounted far above, ahead of the session —
// see the comment there.
app.use("/", authRoutes);
app.use("/", listsRoutes);

/**
 * The three routers with a path of their own, above homeRoutes rather than
 * below it.
 *
 * homeRoutes ends in two catch-alls — "/:genre" and "/:id" — and both match
 * any single-segment path, so every request for "/comments" and "/news" used
 * to be offered to them first. Neither can ever answer one: "comments" is not
 * a genre, and utils/reserved-slugs.ts keeps the catalogue off all three names
 * precisely so no game can live there. But "/:id" does not know that before it
 * asks, and asking is two queries — Game.findBySlug, then
 * Game.findCurrentSlug against the slug history — after which it hands the
 * request on to the router that was always going to answer it.
 *
 * Measured on the comment overview and the news index: 2 wasted queries each,
 * which on a warm sidebar cache is 40% of what "/news" spends. The 404 path
 * still pays them, and should — there the question is real.
 *
 * Nothing changes about which handler answers what. A router mounted on a path
 * only ever sees requests under it, and calls next() when it has no match, so
 * everything these three decline still falls through to homeRoutes exactly as
 * before.
 */
app.use("/games", gamesRoutes);
app.use("/comments", commentsRoutes);
app.use("/news", newsRoutes);

app.use("/", homeRoutes);

app.use((req, res) => {
  if (expectsJson(req)) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  // noindex, which head.ejs turns into the one robots tag on the page *and*
  // uses to drop the canonical. Without it an error page emitted
  // <link rel="canonical"> naming the address that had just answered 404 —
  // harmless, since nothing indexes a non-200, but it is a page asking to be
  // indexed under a URL that does not exist. The views say more about why
  // there is no second robots tag of their own.
  res.status(404).render("404", { noindex: true });
});

/**
 * The status a refused request deserves, when the error names one itself.
 *
 * express.json() and express.urlencoded() reject a body they cannot read by
 * handing on an error carrying the right status — 400 for malformed JSON, 413
 * for a body over the size limit or a form with too many fields. This handler
 * ignored that and answered 500 for every one of them, which reported the
 * client's mistake as a fault of the server's. It cost two real things: an
 * oversized paste into the comment box was answered "Internal server error"
 * rather than the form's own "Content is too long" (the parser refuses it
 * before validateComment ever runs), and error.log collected a stack trace
 * per malformed request, which is exactly the noise that hides a real fault.
 *
 * Only a 4xx is taken. An error carrying a 5xx — or a "status" that is not a
 * status at all — is a server fault and must not be able to talk this handler
 * out of logging it with its stack.
 */
function clientErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;

  const { status, statusCode } = error as {
    status?: unknown;
    statusCode?: unknown;
  };

  const raw = typeof status === "number" ? status : statusCode;

  return typeof raw === "number" && raw >= 400 && raw < 500 ? raw : null;
}

/**
 * What a refused request is told.
 *
 * The wording is chosen here rather than taken from the error, for two
 * reasons. The fetch-based clients render `error` straight into the page (see
 * readError in public/js/comments.js), and a parser's own phrasing —
 * "Unexpected token o in JSON at position 1" — is not something to put in
 * front of a reader. And passing err.message through would let any future
 * error that happens to carry a 4xx put its own text on screen.
 */
const CLIENT_ERROR_MESSAGES: Record<number, string> = {
  400: "The request could not be read. Please reload the page and retry.",
  413: "That is too large to send — please shorten it and retry.",
};

const CLIENT_ERROR_FALLBACK = "The request was refused.";

/** A loggable rendering of a thrown value that is not an Error. */
function describeThrown(value: unknown): string {
  if (typeof value === "string") return value;

  try {
    return `Non-Error thrown: ${JSON.stringify(value)}`;
  } catch {
    return `Non-Error thrown: ${String(value)}`;
  }
}

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  const clientStatus = clientErrorStatus(err);

  if (clientStatus === null) {
    // Anything can be thrown, not only an Error. A string or a plain object
    // has neither .stack nor .message, and the line in error.log used to read
    // "undefined" — the one word that says nothing about what happened.
    logger.error(
      err instanceof Error ? (err.stack ?? err.message) : describeThrown(err),
    );
  } else {
    // Warn, and no stack: a request somebody sent wrong is not something to
    // investigate. The line is still worth keeping — a sudden run of them
    // says a client is broken — but it does not belong in error.log.
    //
    // Fields rather than a sentence, and the path rather than the URL. The
    // access log above deliberately leaves the query string out — it carries
    // what a visitor typed into the search box — and this line put the whole
    // of req.url in, so the one request the site wrote a search term about was
    // the one it had refused. The path is taken the way the access log takes
    // it, off `req` before any mounted router has rewritten req.url; see the
    // comment there.
    logger.warn("client error", {
      status: clientStatus,
      method: req.method,
      path: req.path,
      reason: err.message,
    });
  }

  // Nothing useful is left to do once the response is on the wire: a
  // half-sent body cannot be replaced with an error page, and render() would
  // only throw a second error on top of the first. Handing it back to express
  // closes the connection, which is the honest outcome.
  if (res.headersSent) {
    return next(err);
  }

  if (expectsJson(req)) {
    res.status(clientStatus ?? 500).json({
      error:
        clientStatus === null
          ? "Internal server error"
          : (CLIENT_ERROR_MESSAGES[clientStatus] ?? CLIENT_ERROR_FALLBACK),
    });
    return;
  }

  // A refused request gets its own page rather than the 500 one. Both views
  // default every sidebar local they read, which matters here: a parser
  // rejects the body long before sidebarData runs, so nothing has filled them
  // in. `req` is the one local a partial cannot default, and it is in reach
  // because the middleware that sets it is mounted above the body parsers —
  // see the comment there for what this path was answering before it was.
  //
  // noindex so views/head.ejs does not hand a refused request a canonical
  // link naming the address that was just refused.
  res.status(clientStatus ?? 500).render(clientStatus === null ? "500" : "400", {
    noindex: true,
  });
});

export default app;
