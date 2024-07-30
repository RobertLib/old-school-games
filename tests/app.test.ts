import { describe, expect, it, vi, afterAll, beforeEach } from "vitest";
import request from "supertest";
import app, { healthCache } from "../app.ts";
import Game from "../models/game.ts";
import User from "../models/user.ts";
import pool from "../db.ts";
import { clearSitemapCache } from "../routes/sitemap.ts";
import { resetCacheEpochForTests } from "../utils/cache-epoch.ts";
import logger from "../utils/logger.ts";
import { glob, readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import type { AddressInfo } from "net";

/**
 * One listening server for the whole file, handed to supertest directly.
 *
 * `request(app)` opens a fresh server on an ephemeral port for every single
 * call and closes it again when the response arrives — this suite did that a
 * few hundred times a run. Ports come back round: a request could be answered
 * by whatever had taken the port since, which showed up as an assertion
 * failing against a status the routes under test cannot even produce (a 401,
 * from an app with no authentication in it at all). Intermittent, unrelated to
 * the code being tested, and impossible to read.
 *
 * Passing the server instead means supertest opens and closes nothing.
 */
const server = app.listen(0);

/**
 * The one js-dos release the policy allows — the path, not the CDN. jsDelivr
 * serves every npm package there is, so the bare origin in script-src would
 * have let any injected markup load a script of the attacker's choosing.
 */
const JS_DOS_SOURCE = "https://cdn.jsdelivr.net/npm/js-dos@8.4.1/dist/";

afterAll(() => {
  server.close();
});

/**
 * The assembled application, as opposed to one router mounted on its own.
 *
 * Every other route test builds a bare express() and gives it a plain-text
 * 404 of its own, so nothing exercised the middleware order, the real 404 and
 * 500 views or the security headers. The sidebar locals those views read went
 * missing on exactly the paths that skip loading them, and no test could see
 * it: /sitemap-9999.xml answered 500 in production while the suite was green.
 */
describe("the assembled app", () => {
  /**
   * The platform's health check. What it adds over the TCP check it replaces
   * is that the process is answering HTTP rather than merely holding the port.
   */
  describe("GET /healthz", () => {
    // The probe is cached for a few seconds, so that an endpoint deliberately
    // mounted above the rate limiter cannot be made to take a pool connection
    // per request — see HEALTH_CACHE_TTL_MS in app.ts. Every case below wants
    // a probe of its own, and the whole file runs inside one TTL, so the
    // entry goes first: otherwise the outage case is answered by the "up" the
    // case before it cached.
    beforeEach(() => {
      healthCache.clear();
    });

    it("answers 200 with the database's state", async () => {
      const response = await request(server).get("/healthz");

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("ok");
      expect(["up", "down", "timeout"]).toContain(response.body.database);
    });

    /**
     * The check arrives addressed to the machine, not to the site's hostname,
     * so answered below the canonical-host redirect it would be a 301 — which
     * the platform reads as a failed check and the machine as unhealthy.
     */
    it("is not redirected in production", async () => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      try {
        const response = await request(server)
          .get("/healthz")
          .set("Host", "some-machine.internal");

        expect(response.status).toBe(200);
      } finally {
        process.env.NODE_ENV = previous;
      }
    });

    /**
     * A database outage is meant to look like blank sidebar widgets here, not
     * a 503: every widget has a fallback and both limiters pass
     * passOnStoreError. Failing this check would pull the last machine out of
     * the proxy's rotation and take the site down instead.
     */
    it("stays 200 when the database cannot be reached", async () => {
      const pool = (await import("../db.ts")).default;
      const query = vi
        .spyOn(pool, "query")
        .mockRejectedValue(new Error("no route to host") as never);

      try {
        const response = await request(server).get("/healthz");

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ status: "ok", database: "down" });
      } finally {
        query.mockRestore();
      }
    });

    /**
     * The endpoint is mounted above the rate limiter on purpose, so that a
     * check arriving while the site sheds load is still answered — which also
     * leaves it the one route nothing throttles. What keeps that off the
     * ten-connection pool is the cached probe: a second request inside the
     * window is answered without asking Postgres again.
     *
     * Counted by statement rather than by call, so an incidental query from
     * anything else cannot make this pass or fail for the wrong reason.
     */
    it("asks the database once for requests inside the cache window", async () => {
      const pool = (await import("../db.ts")).default;
      const query = vi.spyOn(pool, "query");

      const probes = (): number =>
        query.mock.calls.filter((call) => call[0] === "SELECT 1").length;

      try {
        await request(server).get("/healthz");
        await request(server).get("/healthz");

        expect(probes()).toBe(1);

        // And the entry going away is what lets the next one through, rather
        // than the endpoint having simply stopped probing.
        healthCache.clear();
        await request(server).get("/healthz");

        expect(probes()).toBe(2);
      } finally {
        query.mockRestore();
      }
    });
  });

  describe("404 handling", () => {
    it("renders the 404 view for an unknown page", async () => {
      const response = await request(server).get("/no-such-page");

      expect(response.status).toBe(404);
      expect(response.headers["content-type"]).toMatch(/text\/html/);
      expect(response.text).toContain("Page not found");
    });

    /**
     * The end-to-end half of what tests/views/meta-tags.test.ts holds
     * statically, and the reason it is worth having both.
     *
     * That suite reads the templates as text and can prove the view declares
     * its title above the line that pulls views/head.ejs in and hands it down.
     * It cannot prove EJS then merges it over the parent's data, which is the
     * step the whole arrangement depends on — so this asks the rendered page.
     *
     * The 404 is the one of the eight that any request can reach.
     */
    it("gives that 404 its own Twitter card, not the site's", async () => {
      const response = await request(server).get("/no-such-page");

      expect(response.text).toContain(
        '<meta name="twitter:title" content="404 - Page Not Found - OldSchoolGames" />',
      );
      expect(response.text).toMatch(
        /<meta name="twitter:description" content="The page you are looking for was not found/,
      );
    });

    // The regression. sidebarData deliberately loads nothing for sitemap
    // chunks, so rendering the 404 view there threw on a local that was never
    // set — the 500 view then threw on the same one, and the request ended as
    // a bare 500 from Express's own handler.
    it("renders the 404 view on a path that loads no sidebar data", async () => {
      const response = await request(server).get("/sitemap-9999.xml");

      expect(response.status).toBe(404);
      expect(response.text).toContain("Page not found");
    });

    // The XML content type used to be set before the chunk was looked up, so
    // even once the view rendered, the HTML 404 went out labelled as XML.
    it("does not label that 404 as XML", async () => {
      const response = await request(server).get("/sitemap-9999.xml");

      expect(response.headers["content-type"]).toMatch(/text\/html/);
    });

    // A fetch() handed the 404 page reports "Unexpected token '<'", which
    // says nothing about what actually went wrong.
    it("answers a JSON endpoint's 404 in JSON", async () => {
      const response = await request(server).get("/comments/1/no-such-thing");

      expect(response.status).toBe(404);
      expect(response.headers["content-type"]).toMatch(/application\/json/);
      expect(response.body).toEqual({ error: "Not found" });
    });

    // The other side of the same decision: the overview is a page.
    it("still renders the 404 view for a page under the same prefix", async () => {
      const response = await request(server).get("/no-such-page");

      expect(response.headers["content-type"]).toMatch(/text\/html/);
    });

    /**
     * The epoch check sits above the sitemap and the feeds, which hold the
     * longest-lived caches here. Mounted beneath it, a crawler's request on a
     * freshly started machine filled the sitemap cache before the process had
     * ever read the epoch — and the first read only adopts what it finds, so
     * a bump from another machine went unnoticed for the whole 24h TTL.
     */
    it("reads the cache epoch on a sitemap request", async () => {
      resetCacheEpochForTests();
      clearSitemapCache();
      const query = vi.spyOn(pool, "query");

      try {
        await request(server).get("/sitemap-index.xml");

        expect(
          query.mock.calls.some(
            (call) =>
              typeof call[0] === "string" && call[0].includes('"cache_epochs"'),
          ),
        ).toBe(true);
      } finally {
        query.mockRestore();
      }
    });

    it("still serves a real sitemap chunk as XML", async () => {
      const response = await request(server).get("/sitemap-1.xml");

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toMatch(/application\/xml/);
    });

    /**
     * The page a visitor actually lands on, as opposed to the status code.
     *
     * All four error views used to render one bare sentence into an otherwise
     * empty <main> — no heading, and not a link in the content area. The
     * sidebars and footer were the only way out, and on a narrow viewport
     * they sit below the whole page. See views/error-nav.ejs.
     */
    it("gives the 404 page a heading", async () => {
      const response = await request(server).get("/no-such-page");

      expect(response.text).toMatch(/<h1[^>]*>[^<]*Page not found/);
    });

    it("gives the 404 page somewhere to go next", async () => {
      const response = await request(server).get("/no-such-page");

      expect(response.text).toContain("Where to next?");

      for (const href of ["/", "/game-lists", "/most-played", "/how-to-play"]) {
        expect(response.text).toContain(`href="${href}"`);
      }
    });

    // The one link in that block that must not invite a crawler: /random
    // answers every request with a redirect to a different game, which is why
    // robots.txt disallows it and views/left-sidebar.ejs marks its own copy.
    it("does not invite a crawler onto /random from there", async () => {
      const response = await request(server).get("/no-such-page");

      expect(response.text).toContain('href="/random" rel="nofollow"');
    });
  });

  /**
   * One address per page.
   *
   * Express does not run strict routing, so every path on the site answered
   * 200 under a second address with a slash on the end. See the middleware in
   * app.ts for why this is a redirect rather than strict routing (which would
   * answer 404) or a canonical tag alone (which every page already carries).
   */
  describe("trailing slashes", () => {
    it("sends a slashed path to the one without", async () => {
      const response = await request(server).get("/developers/").redirects(0);

      expect(response.status).toBe(301);
      expect(response.headers.location).toBe("/developers");
    });

    it("keeps the query string", async () => {
      const response = await request(server)
        .get("/action/?page=2")
        .redirects(0);

      expect(response.status).toBe(301);
      expect(response.headers.location).toBe("/action?page=2");
    });

    it("collapses a run of them", async () => {
      const response = await request(server).get("/no-such/////").redirects(0);

      expect(response.status).toBe(301);
      expect(response.headers.location).toBe("/no-such");
    });

    it("leaves the root alone", async () => {
      const response = await request(server).get("/").redirects(0);

      expect(response.status).toBe(200);
    });

    it("leaves a path that already has no slash alone", async () => {
      const response = await request(server).get("/developers").redirects(0);

      expect(response.status).toBe(200);
    });

    // A 301 is not method-preserving: a browser re-issues it as a GET, so
    // redirecting a form post would drop its body on the floor.
    it("does not redirect a POST", async () => {
      const response = await request(server).post("/login/").redirects(0);

      expect(response.status).not.toBe(301);
    });

    /**
     * The reason the middleware refuses one shape of path outright.
     *
     * "//evil.com/" trims to "//evil.com", and a Location beginning with two
     * slashes is protocol-relative — a browser reads it as another origin, so
     * emitting it would turn this into an open redirect off the site.
     */
    it("never answers with a protocol-relative Location", async () => {
      const response = await request(server).get("//evil.com/").redirects(0);

      expect(response.status).not.toBe(301);
      expect(response.headers.location).toBeUndefined();
    });

    /**
     * The same escape spelled with a backslash. "/\evil.com/" is not two
     * slashes, so the guard above let it through and answered
     * "Location: /\evil.com" — which a browser following the WHATWG URL
     * parser reads as "//evil.com".
     */
    it.each(["/\\evil.com/", "/\\\\evil.com/", "/doom\\/"])(
      "never answers %s with a Location that could leave the site",
      async (target) => {
        // Raw, not through supertest: the WHATWG URL parser it builds the
        // request with already turns "\\" into "/", which is exactly the
        // normalisation this guard exists to anticipate. Only a client that
        // sends the byte as typed reaches the branch.
        const address = server.address() as AddressInfo;

        const response = await new Promise<{
          status: number;
          location: string | undefined;
        }>((resolve, reject) => {
          const req = http.request(
            { host: "127.0.0.1", port: address.port, path: target, method: "GET" },
            (res) => {
              res.resume();
              resolve({ status: res.statusCode ?? 0, location: res.headers.location });
            },
          );
          req.on("error", reject);
          req.end();
        });

        expect(response.status).not.toBe(301);
        expect(response.location).toBeUndefined();
      },
    );

    /**
     * An absolute-form target — "GET http://evil.example/ HTTP/1.1", which
     * Node accepts. The redirect used to build its Location from the raw
     * target, so this answered "Location: http://evil.example", an address
     * off the site that neither guard above could see. The path is read
     * parsed now, and "/" keeps its slash.
     */
    it("never redirects to the host of an absolute-form request target", async () => {
      const address = server.address() as AddressInfo;

      const response = await new Promise<{
        status: number;
        location: string | undefined;
      }>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: address.port,
            path: "http://evil.example/doom/",
            method: "GET",
          },
          (res) => {
            res.resume();
            resolve({ status: res.statusCode ?? 0, location: res.headers.location });
          },
        );
        req.on("error", reject);
        req.end();
      });

      if (response.status === 301) {
        expect(response.location).toBe("/doom");
      } else {
        expect(response.location).toBeUndefined();
      }
    });
  });

  /**
   * The canonical-host and HTTPS redirects, which only run in production.
   *
   * NODE_ENV is flipped per request rather than at import: the middleware
   * reads it on every request, while the cookie flags and "trust proxy" are
   * settled when the module loads and are not what this is about.
   */
  describe("production redirects", () => {
    async function asProduction(get: () => Promise<any>) {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      try {
        return await get();
      } finally {
        process.env.NODE_ENV = previous;
      }
    }

    it("sends a forged Host to the canonical origin, not back to itself", async () => {
      const response = await asProduction(() =>
        request(server).get("/doom").set("Host", "evil.example"),
      );

      expect(response.status).toBe(301);
      expect(response.headers.location).toBe(
        "https://oldschoolgames.eu/doom",
      );
    });

    it("sends plain HTTP to HTTPS", async () => {
      const response = await asProduction(() =>
        request(server)
          .get("/doom")
          .set("Host", "oldschoolgames.eu")
          .set("x-forwarded-proto", "http"),
      );

      // 301, like the host redirect: HTTPS is not a temporary arrangement,
      // and a 302 asks every visitor back over plain HTTP next time.
      expect(response.status).toBe(301);
      expect(response.headers.location).toBe(
        "https://oldschoolgames.eu/doom",
      );
    });

    /**
     * Node joins a header that arrives twice, so two proxies each adding one
     * produce "https, http" — which is not "https", and the redirect this
     * middleware answered with then arrived back here to be answered again.
     * A loop takes the whole site down, not one page.
     */
    it("reads the first value of a repeated x-forwarded-proto", async () => {
      const response = await asProduction(() =>
        request(server)
          .get("/doom")
          .set("Host", "oldschoolgames.eu")
          .set("x-forwarded-proto", "https, http"),
      );

      expect(response.status).not.toBe(301);
      expect(response.status).not.toBe(302);
    });

    /**
     * The regression. Both redirects used to be answered above helmet, so
     * they went out bare — no HSTS on the one response whose entire job is to
     * move a browser onto HTTPS, and no nosniff or frame-ancestors either.
     */
    it.each([
      ["a wrong host", { Host: "evil.example" }],
      [
        "plain HTTP",
        { Host: "oldschoolgames.eu", "x-forwarded-proto": "http" },
      ],
    ])("carries the security headers when redirecting %s", async (_l, headers) => {
      const response = await asProduction(() => {
        const pending = request(server).get("/doom");

        for (const [name, value] of Object.entries(headers)) {
          pending.set(name, value);
        }

        return pending;
      });

      expect(response.status).toBeGreaterThanOrEqual(301);
      expect(response.headers["strict-transport-security"]).toMatch(
        /max-age=\d+/,
      );
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["content-security-policy"]).toContain(
        "frame-ancestors 'self'",
      );
      // Registered with helmet rather than below the redirects, for the same
      // reason as everything above it: the one response whose whole job is to
      // move a browser somewhere else should not be the bare one.
      expect(response.headers["permissions-policy"]).toContain("camera=()");
    });
  });

  describe("security headers", () => {
    describe("Permissions-Policy", () => {
      it("switches off the features this site does not use", async () => {
        const response = await request(server).get("/");
        const policy = response.headers["permissions-policy"] ?? "";

        for (const feature of [
          "camera",
          "microphone",
          "geolocation",
          "usb",
          "serial",
          "payment",
          "display-capture",
          "browsing-topics",
        ]) {
          expect(policy).toContain(`${feature}=()`);
        }
      });

      it("leaves the features the DOS player needs alone", async () => {
        const response = await request(server).get("/");
        const policy = response.headers["permissions-policy"] ?? "";

        // Naming any of these would break the emulator quietly: a refused
        // feature is reported nowhere but the browser console. Fullscreen is
        // setFullScreen in public/js/js-dos-player.js; the other two are
        // sound and controllers.
        expect(policy).not.toContain("fullscreen");
        expect(policy).not.toContain("autoplay");
        expect(policy).not.toContain("gamepad");
      });

      it("names no feature the browsers do not recognise", async () => {
        const response = await request(server).get("/");
        const policy = response.headers["permissions-policy"] ?? "";

        // An unknown feature is not a stricter policy, it is a per-navigation
        // "Unrecognized feature" warning — in the one console where a refused
        // feature above would otherwise be visible. ambient-light-sensor is
        // the one that was here; the API never shipped unflagged anywhere.
        expect(policy).not.toContain("ambient-light-sensor");
      });

    });

    it("allows inline scripts by nonce rather than wholesale", async () => {
      const response = await request(server).get("/");
      const csp = response.headers["content-security-policy"];

      const scriptSrc = /(?:^|;)script-src ([^;]*)/.exec(csp)?.[1] ?? "";

      expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
      // The directive that matters: 'unsafe-inline' here would allow exactly
      // what an injected payload is. style-src keeps it, for the inline
      // style attributes the views use.
      expect(scriptSrc).not.toContain("'unsafe-inline'");
      expect(csp).toContain("script-src-attr 'none'");
    });

    it("gives each response its own nonce", async () => {
      const [first, second] = await Promise.all([
        request(server).get("/"),
        request(server).get("/"),
      ]);

      const nonce = (headers: Record<string, string>) =>
        /'nonce-([A-Za-z0-9+/=]+)'/.exec(
          headers["content-security-policy"] ?? "",
        )?.[1];

      expect(nonce(first.headers)).toBeTruthy();
      expect(nonce(first.headers)).not.toBe(nonce(second.headers));
    });

    /**
     * Naming a directive replaces helmet's default for it rather than adding
     * to it, which is easy to forget and silent when you do. Listing three
     * image hosts withdrew the "data:" the default had carried, and the
     * emulator's own stylesheet draws the whole player chrome — play button,
     * spinner, the rest — as url("data:image/svg+xml,…") backgrounds, plus a
     * loader PNG from its own host. Every one of them was refused inside the
     * player frame, reported nowhere but the browser console.
     */
    describe("img-src covers what the player actually loads", () => {
      it.each([
        ["data: URIs, for the js-dos chrome", "data:"],
        ["the js-dos host, for its loader PNG", JS_DOS_SOURCE],
        ["this origin", "'self'"],
        [
          "the bucket the artwork is served from",
          "https://trwglibsccninuamefls.supabase.co",
        ],
      ])("allows %s", async (_label, source) => {
        const response = await request(server).get("/");
        const imgSrc =
          /(?:^|;)img-src ([^;]*)/.exec(
            response.headers["content-security-policy"],
          )?.[1] ?? "";

        expect(imgSrc.split(" ")).toContain(source);
      });
    });

    /**
     * With script-src pinned to a nonce, a stylesheet from anywhere on the
     * web was the loosest thing left in the policy — CSS is an exfiltration
     * channel, no script required. helmet's defaults for both of these carry
     * a blanket "https:".
     */
    it("does not accept a stylesheet or font from anywhere on the web", async () => {
      const response = await request(server).get("/");
      const csp = response.headers["content-security-policy"];

      const styleSrc = /(?:^|;)style-src ([^;]*)/.exec(csp)?.[1] ?? "";
      const fontSrc = /(?:^|;)font-src ([^;]*)/.exec(csp)?.[1] ?? "";

      expect(styleSrc.split(" ")).not.toContain("https:");
      expect(fontSrc.split(" ")).not.toContain("https:");

      // Still allowed: this origin, and the emulator's own stylesheet.
      expect(styleSrc.split(" ")).toContain("'self'");
      expect(styleSrc).toContain(JS_DOS_SOURCE);
      expect(fontSrc).toContain("'self'");
    });

    /**
     * The directive that carries the exfiltration risk, and the one that does
     * not.
     *
     * An attribute selector firing a background request per character reads a
     * token out of a page without running a line of script — but mounting one
     * needs a <style> element or a foreign stylesheet, because a style=""
     * attribute holds declarations for a single element and cannot contain a
     * selector at all. So the two halves are set apart: "style-src" refuses
     * inline blocks outright, while "style-src-attr" keeps the roughly three
     * hundred style attributes the layout is built from working.
     *
     * Both are asserted because the fallback makes them easy to conflate: an
     * undeclared "style-src-attr" inherits "style-src", so dropping it would
     * silently strip every inline style off the site — and putting
     * 'unsafe-inline' back on "style-src" would just as silently re-open the
     * blocks. Neither failure is visible in a response body.
     */
    it("refuses inline <style> while still allowing style attributes", async () => {
      const response = await request(server).get("/");
      const csp = response.headers["content-security-policy"];

      const styleSrc = /(?:^|;)style-src ([^;]*)/.exec(csp)?.[1] ?? "";
      const styleSrcAttr = /(?:^|;)style-src-attr ([^;]*)/.exec(csp)?.[1] ?? "";

      expect(styleSrc.split(" ")).not.toContain("'unsafe-inline'");
      expect(styleSrcAttr.split(" ")).toContain("'unsafe-inline'");
    });

    /**
     * The vendor's "/latest/" host, which the pin to an immutable jsDelivr
     * release replaced. It stayed on the allowlist for a while afterwards as
     * a safety net, which left the pin half-applied: an origin named in
     * "script-src" may run as this site, so a moving target there is exactly
     * the exposure pinning and the integrity hashes exist to close.
     *
     * Asserted across the whole policy rather than one directive, because it
     * was listed in four of them.
     */
    it("no longer allows the unpinned js-dos host anywhere", async () => {
      const response = await request(server).get("/");

      expect(response.headers["content-security-policy"]).not.toContain(
        "v8.js-dos.com",
      );
    });

    /**
     * js-dos is pinned to one immutable release rather than loaded from the
     * vendor's "/latest/", which was a moving target with full script
     * privileges in this origin — see the comment in public/js-dos.html.
     *
     * The policy has to allow the host it is pinned on, in every directive
     * the player reaches through. A blocked subresource inside the player
     * frame is reported nowhere but the browser console, so nothing else
     * would say the emulator had stopped loading.
     */
    it("allows the pinned js-dos CDN everywhere the player needs it", async () => {
      const response = await request(server).get("/js-dos.html");
      const csp = response.headers["content-security-policy"];

      for (const directive of [
        "script-src",
        "style-src",
        "img-src",
        "connect-src",
        "worker-src",
      ]) {
        const value =
          new RegExp(`(?:^|;)\\s*${directive} ([^;]*)`).exec(csp)?.[1] ?? "";

        expect(value.split(" "), `${directive} is missing the pinned CDN`).toContain(
          JS_DOS_SOURCE,
        );
      }
    });

    it("allows nothing from the CDN outside that one release", async () => {
      const response = await request(server).get("/");
      const csp = response.headers["content-security-policy"];

      for (const directive of csp.split(";")) {
        const sources = directive.trim().split(" ").slice(1);

        for (const source of sources) {
          if (!source.includes("cdn.jsdelivr.net")) continue;

          expect(source, `${directive.trim()} names the bare CDN`).toBe(
            JS_DOS_SOURCE,
          );
        }
      }
    });

    /**
     * The emulator's worker, which is the part that actually runs the game.
     *
     * "worker-src" has to be named: undeclared it falls back to "child-src",
     * and undeclared that falls back to "default-src" — "'self'" alone.
     * js-dos does not load the worker from an address on this origin.
     * emulators.js fetches wdosbox.js from the pinned release, turns the
     * response into a blob and constructs the worker from the resulting
     * "blob:" URL, and whether "'self'" covers a blob: address is the very
     * point browsers have differed on — which is why "script-src" already
     * carries an explicit blob: for the same kind of URL.
     *
     * A refused worker is reported nowhere but the browser console, so
     * nothing else here would say the emulator had stopped starting.
     */
    it.each([
      ["the blob: URL js-dos builds the worker from", "blob:"],
      ["this origin", "'self'"],
    ])("allows %s as a worker source", async (_label, source) => {
      const response = await request(server).get("/js-dos.html");
      const workerSrc =
        /(?:^|;)\s*worker-src ([^;]*)/.exec(
          response.headers["content-security-policy"],
        )?.[1] ?? "";

      expect(workerSrc.split(" ")).toContain(source);
    });

    /**
     * The emulator's policy is the player's, and the player's is not the
     * site's.
     *
     * 'unsafe-eval', blob: and the js-dos CDN used to be in the one policy
     * helmet writes for every response, so the home page, the listings and
     * the admin forms all carried them to support a single framed document.
     * 'unsafe-eval' is the expensive one: with it on a page, an injected
     * string that reaches eval, new Function or setTimeout("…") runs as this
     * site and the nonce on script-src counts for nothing.
     *
     * Splitting it is only possible because the player is framed — a
     * document of its own can be served a policy of its own. What it may do
     * rather than load is bounded from the other side by the sandbox on the
     * <iframe>; see views/games/game-detail.ejs.
     */
    describe("the player's policy, and only the player's", () => {
      /** The named directive, from whichever policy the response carries. */
      async function directive(path: string, name: string): Promise<string[]> {
        const response = await request(server).get(path);
        const csp = response.headers["content-security-policy"] ?? "";

        const value =
          new RegExp(`(?:^|;)\\s*${name} ([^;]*)`).exec(csp)?.[1] ?? "";

        return value.split(" ").filter(Boolean);
      }

      it.each([
        ["/", "the home page"],
        ["/doom", "a game page"],
        ["/news", "a listing"],
      ])("keeps %s (%s) free of 'unsafe-eval' and blob:", async (path) => {
        const scriptSrc = await directive(path, "script-src");

        expect(scriptSrc).not.toContain("'unsafe-eval'");
        expect(scriptSrc).not.toContain("blob:");
        // Nothing outside the frame loads a script from the CDN either: the
        // loader tag is in public/js-dos.html and nowhere else.
        expect(scriptSrc).not.toContain(JS_DOS_SOURCE);
      });

      it("declares no worker source on an ordinary page", async () => {
        // Undeclared it falls back to default-src, which is "'self'" — and
        // no page on this site starts a worker at all.
        expect(await directive("/", "worker-src")).toEqual([]);
      });

      it.each([
        ["'unsafe-eval'", "js-dos compiles DOSBox at runtime"],
        ["blob:", "the worker is built from a blob"],
        ["'self'", "the player script is served from here"],
      ])("gives the player frame %s (%s)", async (source) => {
        expect(await directive("/js-dos.html", "script-src")).toContain(source);
      });

      it("lets the player frame reach the bucket the bundles come from", async () => {
        expect(await directive("/js-dos.html", "connect-src")).toContain(
          "https://trwglibsccninuamefls.supabase.co",
        );
      });

      /**
       * js-dos.html sizes #dos and hides the SVG filter with style=""
       * attributes, and an undeclared style-src-attr falls back to style-src
       * — which would refuse every one of them, silently, inside a frame
       * whose console nobody is watching.
       */
      it("keeps the frame's own style attributes working", async () => {
        expect(await directive("/js-dos.html", "style-src-attr")).toContain(
          "'unsafe-inline'",
        );
      });

      it("still refuses an inline handler inside the frame", async () => {
        expect(await directive("/js-dos.html", "script-src-attr")).toContain(
          "'none'",
        );
      });

      it("frames the player nowhere but this site", async () => {
        expect(await directive("/js-dos.html", "frame-ancestors")).toContain(
          "'self'",
        );
      });

      /**
       * One header, not two. helmet writes its own on the way in and this
       * replaces it; appended instead, the browser would enforce both — and
       * the intersection of the two refuses the emulator exactly as the
       * strict policy does, which is the bug this arrangement is one
       * setHeader away from.
       */
      it("sends the player exactly one policy", async () => {
        const response = await request(server).get("/js-dos.html");
        const header = response.headers["content-security-policy"];

        expect(Array.isArray(header)).toBe(false);
        expect(header).not.toContain(",");
      });

      // Keyed on the path, so the "?v=" the template stamps in and the
      // "?stream=" the player reads both still land on the player's policy.
      it.each([
        "/js-dos.html?v=abc123",
        "/js-dos.html?v=abc123&stream=https%3A%2F%2Fexample.test%2Fa.jsdos",
      ])("serves %s the player's policy too", async (path) => {
        expect(await directive(path, "script-src")).toContain("'unsafe-eval'");
      });

      // The player script is an ordinary asset and gets the site's policy;
      // only the document that runs the emulator is special-cased.
      it("does not relax anything for the player script itself", async () => {
        expect(
          await directive("/js/js-dos-player.js", "script-src"),
        ).not.toContain("'unsafe-eval'");
      });
    });
  });

  describe("CSRF", () => {
    it("refuses an unsafe request carrying no token", async () => {
      const response = await request(server)
        .post("/comments")
        .send({ content: "hi", gameId: 1 });

      expect(response.status).toBe(403);
    });

    /**
     * The refusal has to arrive in the shape the caller reads. comments.js
     * and rating-stars.js both take the reason off `error` in a JSON body, so
     * the plain-text 403 this used to send made response.json() throw and the
     * visitor was shown the generic "Could not post the comment" — no hint
     * that reloading is what fixes it. The token cookie outlives a month, so
     * the request that lands here is usually one sent from a page older than
     * the cookie backing it.
     */
    it.each(["/comments", "/games/1/rate", "/games/1/play"])(
      "refuses %s with a JSON reason, which is what its client reads",
      async (path) => {
        const response = await request(server).post(path).send({ rating: 5 });

        expect(response.status).toBe(403);
        expect(response.headers["content-type"]).toMatch(/application\/json/);
        expect(response.body.error).toMatch(/reload/i);
      },
    );

    // A form post, which would have been answered with a page — so a JSON
    // body would be raw JSON in front of the visitor.
    //
    // The site's own 403 page, and rendered rather than merely labelled
    // text/html: validateCsrf runs above sidebarData and used to run above the
    // middleware that puts `req` on res.locals too, so a template reaching for
    // req.query or req.session would have thrown a ReferenceError here and
    // answered 500. Asserting a local the layout renders — the navbar's search
    // box — is what makes that regression visible rather than a silent 403.
    it("refuses a form post with the rendered 403 page", async () => {
      const response = await request(server).post("/games/1/delete").send({});

      expect(response.status).toBe(403);
      expect(response.headers["content-type"]).not.toMatch(/application\/json/);
      expect(response.headers["content-type"]).toMatch(/text\/html/);
      expect(response.text).toContain("please reload the page");
      expect(response.text).toContain('<aside class="left-sidebar"');
      expect(response.text).toContain('name="search"');
    });

    it("hands the page a token in a cookie and in a meta tag", async () => {
      const response = await request(server).get("/");
      // supertest types every header as a string; set-cookie is the one
      // that actually arrives as an array.
      const cookies = (
        response.headers["set-cookie"] as unknown as string[]
      ).join(";");

      expect(cookies).toMatch(/osg_csrf=[0-9a-f]{64}/);
      // Masked, so it is twice the length of the secret and different on
      // every response — see maskToken in middlewares/csrf.ts.
      expect(response.text).toMatch(
        /<meta name="csrf-token" content="[0-9a-f]{128}"/,
      );
    });

    /**
     * The secret used to be rendered as-is into a <meta> tag on every page,
     * beside the visitor's own reflected "?search=" value, over a compressed
     * body — the BREACH setup, where an attacker reads the secret out of the
     * response lengths a guess produces. Two pages sharing one cookie must not
     * share the bytes that stand for it.
     */
    it("renders a different token on every response for one cookie", async () => {
      const first = await request(server).get("/");
      const cookie = (first.headers["set-cookie"] as unknown as string[])
        .map((value) => value.split(";")[0])
        .join("; ");

      const tokenOf = (html: string) =>
        /<meta name="csrf-token" content="([0-9a-f]{128})"/.exec(html)?.[1];

      const second = await request(server).get("/").set("Cookie", cookie);
      const third = await request(server).get("/").set("Cookie", cookie);

      // The secret this response's cookie carries, or undefined if it sent no
      // csrf cookie at all.
      const secretOf = (response: { headers: Record<string, unknown> }) =>
        /osg_csrf=([0-9a-f]{64})/.exec(
          ((response.headers["set-cookie"] as string[] | undefined) ?? []).join(
            ";",
          ),
        )?.[1];

      // The cookie *is* reissued on every response, so its month-long expiry
      // slides and a visitor who keeps coming back never loses it underneath
      // an open page — see csrfToken. What must not change is the secret
      // inside it: rotating that would invalidate every token already
      // rendered, which is the failure the sliding expiry exists to prevent.
      expect(secretOf(second)).toBeDefined();
      expect(secretOf(second)).toBe(secretOf(first));
      expect(secretOf(third)).toBe(secretOf(first));

      // One secret, but different bytes standing for it on each page.
      expect(tokenOf(second.text)).toBeDefined();
      expect(tokenOf(second.text)).not.toBe(tokenOf(third.text));
    });

    // Both masks stand for the same secret, so both have to be accepted: a
    // visitor may submit a form from a page older than their latest request.
    it("accepts a token masked on an earlier response", async () => {
      const page = await request(server).get("/");
      const cookie = (page.headers["set-cookie"] as unknown as string[])
        .map((value) => value.split(";")[0])
        .join("; ");
      const token = /<meta name="csrf-token" content="([0-9a-f]{128})"/.exec(
        page.text,
      )?.[1];

      // Renders again on the same cookie, producing a different mask, before
      // the first one is used.
      await request(server).get("/").set("Cookie", cookie);

      const response = await request(server)
        .post("/games/1/rate")
        .set("Cookie", cookie)
        .set("x-csrf-token", token!)
        .send({ rating: 3 });

      // Past the CSRF gate, whatever the route then makes of the request.
      expect(response.status).not.toBe(403);
    });
  });

  /**
   * A request the client got wrong must not be reported as a fault of the
   * server's. Every case below used to answer 500 — with a stack trace in
   * error.log, which is the noise that hides a real fault.
   *
   * All of them need a valid CSRF token to reach anything, because
   * validateCsrf sits above every route here. That is also what makes the
   * bodyless cases reachable in the first place: the token may travel in the
   * "x-csrf-token" header, so a POST with no body at all clears the gate.
   */
  describe("malformed requests", () => {
    /** A masked token and the cookie backing it, as a browser would hold them. */
    async function csrfPair(): Promise<{ token: string; cookie: string }> {
      const page = await request(server).get("/login");
      const cookie = (page.headers["set-cookie"] as unknown as string[])
        .map((value) => value.split(";")[0])
        .join("; ");
      const token = /<meta name="csrf-token" content="([0-9a-f]{128})"/.exec(
        page.text,
      )?.[1];

      expect(token).toBeDefined();

      return { token: token!, cookie };
    }

    /**
     * body-parser 2 leaves req.body undefined for a request that carries no
     * body, where express 4 set {}. Every one of these destructures it —
     * routes/auth.ts directly, the other two inside their validator — so the
     * throw was a 500 for a POST that simply arrived empty.
     */
    it.each(["/login", "/comments", "/games/1/rate"])(
      "does not answer 500 to a bodyless POST %s",
      async (path) => {
        const { token, cookie } = await csrfPair();

        const response = await request(server)
          .post(path)
          .set("Cookie", cookie)
          .set("x-csrf-token", token);

        expect(response.status).toBeLessThan(500);
      },
    );

    // The endpoint whose client reads the reason off `error` — see
    // readError in public/js/comments.js.
    it("answers unreadable JSON with a 400 the client can parse", async () => {
      const { token, cookie } = await csrfPair();

      const response = await request(server)
        .post("/comments")
        .set("Cookie", cookie)
        .set("x-csrf-token", token)
        .set("Content-Type", "application/json")
        .send('{"nick":');

      expect(response.status).toBe(400);
      expect(response.headers["content-type"]).toMatch(/application\/json/);
      expect(response.body.error).toBeTruthy();
    });

    /**
     * The parser's size limit fires before validateComment does, so its own
     * "Content is too long" never gets the chance to explain an oversized
     * paste. 413 at least says what went wrong.
     */
    it("answers an oversized body with 413, not 500", async () => {
      const { token, cookie } = await csrfPair();

      const response = await request(server)
        .post("/comments")
        .set("Cookie", cookie)
        .set("x-csrf-token", token)
        .set("Content-Type", "application/json")
        .send(JSON.stringify({ content: "x".repeat(200 * 1024) }));

      expect(response.status).toBe(413);
      expect(response.body.error).toMatch(/large/i);
    });

    // A form post, so the refusal is a page rather than an object — and the
    // 400 view, not the 500 one, which claims the server broke.
    it("renders a page for a form post it could not read", async () => {
      const { token, cookie } = await csrfPair();

      const response = await request(server)
        .post("/login")
        .set("Cookie", cookie)
        .set("x-csrf-token", token)
        .set("Content-Type", "application/json")
        .send("{oops");

      expect(response.status).toBe(400);
      expect(response.headers["content-type"]).toMatch(/text\/html/);

      // The rendered view, asserted through its <title>. A bare
      // toContain("400 - Bad Request") is what this used to say, and it was
      // satisfied by something else entirely: the page never rendered at all.
      // res.locals.req was set below the body parsers, so head.ejs threw a
      // ReferenceError on the first `req` it touched, and express answered
      // with its own error page — whose stack trace quotes the line of
      // 400.ejs that sets this very title. The assertion matched the trace.
      //
      // So the checks below are the point: a <title> element, which only the
      // real view produces, and nothing that belongs to a stack trace. A
      // malformed body is something anyone can send, and what it was being
      // answered with was absolute filesystem paths and template source.
      expect(response.text).toContain(
        "<title>400 - Bad Request - OldSchoolGames</title>",
      );
      expect(response.text).not.toContain("ReferenceError");
      expect(response.text).not.toContain("views/400.ejs");
    });

    /**
     * The other half of the change: only a 4xx is taken from the error. A
     * server fault still answers 500 and still gets logged with its stack,
     * and an error carrying a 5xx of its own cannot buy itself a quieter
     * status either.
     */
    it("still answers 500 when the fault is the server's", async () => {
      const pool = (await import("../db.ts")).default;
      const query = vi
        .spyOn(pool, "query")
        .mockRejectedValue(new Error("no route to host") as never);

      try {
        const response = await request(server).get("/most-played");

        expect(response.status).toBe(500);
      } finally {
        query.mockRestore();
      }
    });
  });

  /**
   * A rendered page can carry a session, a CSRF token or an admin's view of
   * itself. These used to send no Cache-Control at all, which leaves a shared
   * cache free to apply a heuristic of its own — not a decision to leave to a
   * proxy, or to a CDN somebody puts in front of this later.
   */
  describe("cache headers", () => {
    it.each(["/", "/about", "/no-such-page"])(
      "keeps %s out of any cache but the browser's",
      async (path) => {
        const response = await request(server).get(path);

        expect(response.headers["cache-control"]).toBe("private, no-cache");
      },
    );

    /**
     * Public documents asked for by crawlers, and already cached server-side.
     * They are mounted ahead of the header above, deliberately, so they stay
     * cacheable — but "cacheable" used to mean no header at all, which leaves
     * the decision to whatever proxy or CDN sits in front of this. Each now
     * says what it wants.
     */
    it.each([
      ["/robots.txt", "public, max-age=86400"],
      ["/sitemap-index.xml", "public, max-age=3600"],
      ["/sitemap-1.xml", "public, max-age=3600"],
      ["/feed.xml", "public, max-age=900"],
      ["/news/feed.xml", "public, max-age=900"],
    ])("lets a shared cache hold %s", async (path, expected) => {
      const response = await request(server).get(path);

      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe(expected);
    });

    // A build that failed is not a document worth holding on to, and it used
    // to inherit the content type of the one it could not produce.
    it("does not let a cache hold a sitemap that could not be built", async () => {
      const failure = vi
        .spyOn(Game, "count")
        .mockRejectedValue(new Error("db down"));

      clearSitemapCache();

      try {
        const response = await request(server).get("/sitemap-index.xml");

        expect(response.status).toBe(500);
        expect(response.headers["cache-control"]).toBeUndefined();
        expect(response.headers["content-type"]).toMatch(/text\/plain/);
      } finally {
        failure.mockRestore();
        clearSitemapCache();
      }
    });

    // express.static answers these itself and never reaches the header, so
    // the long lifetimes below are untouched by it.
    it("leaves the asset lifetimes alone", async () => {
      const response = await request(server).get("/js/ui.js?v=abc123");

      expect(response.headers["cache-control"]).toBe(
        "public, max-age=31536000, immutable",
      );
    });
  });

  describe("static assets", () => {
    it("stamps a content hash into the addresses the page requests", async () => {
      const response = await request(server).get("/");

      expect(response.text).toMatch(
        /<script defer src="\/js\/ui\.js\?v=[0-9a-f]{10}">/,
      );
      expect(response.text).toMatch(
        /<link rel="stylesheet" href="\/css\/style\.css\?v=[0-9a-f]{10}"/,
      );
    });

    it("keeps a versioned asset for a year and a bare one for a day", async () => {
      const versioned = await request(server).get("/js/ui.js?v=abc123");
      const bare = await request(server).get("/js/ui.js");

      expect(versioned.status).toBe(200);
      expect(versioned.headers["cache-control"]).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(bare.headers["cache-control"]).toBe("public, max-age=86400");
    });

    /**
     * The day the two of these could go stale for was a day of a player that
     * no longer matches the policy serving it. Pinning the emulator to
     * jsDelivr dropped v8.js-dos.com from "script-src" and moved pathPrefix
     * into js-dos-player.js in the same change; a browser still holding the
     * previous script asked for the old default host, was refused by the new
     * policy, and started no game at all until the copy happened to expire.
     *
     * Nothing else can catch that. Neither file is written by a template, so
     * app.locals.asset never sees either address, and the fingerprint that
     * invalidates every other asset here does not apply to them.
     */
    it.each(["/js-dos.html", "/js/js-dos-player.js"])(
      "makes the browser revalidate %s rather than hold it for a day",
      async (path) => {
        const response = await request(server).get(path);

        expect(response.status).toBe(200);
        expect(response.headers["cache-control"]).toBe("public, no-cache");
        // "no-cache" is worth nothing without something to revalidate
        // against: with no validator the browser has no way to ask, and
        // express.static would have to send the whole file every time.
        expect(response.headers["etag"]).toBeDefined();
      },
    );

    /**
     * Both of these carry a version in their address now — the frame from
     * app.locals.asset, the script from a literal in js-dos.html — and the
     * ?v= rule above hands a versioned address a year of "immutable".
     *
     * That lifetime is right for a script and wrong for this frame, because
     * the frame's Content-Security-Policy is not in the file. app.ts writes
     * it onto the response — PLAYER_CSP, the policy the emulator alone runs
     * under — so an immutable copy pins a header that lives somewhere else
     * entirely: the next change
     * to the policy would reach those browsers a year late, and reach the
     * player inside the frame immediately. That gap is the whole bug — a
     * frame allowing v8.js-dos.com around a player asking jsDelivr for
     * emulators.js, refused with nothing but a console line to show for it.
     *
     * Revalidating costs a conditional request and answers with a 304
     * carrying today's header, so the two can never be a deploy apart.
     */
    it.each([
      "/js-dos.html?v=abc123",
      "/js-dos.html?v=abc123&stream=https%3A%2F%2Fexample.test%2Fa.jsdos",
      "/js/js-dos-player.js?v=abc123",
      "/js/js-dos-player.js?retired-v8",
    ])("refuses to freeze %s the way it freezes an ordinary asset", async (
      path,
    ) => {
      const response = await request(server).get(path);

      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("public, no-cache");
    });

    /**
     * The address the frame is asked for, which is the only thing a browser
     * already holding a copy of the old one will act on. "no-cache" fixes
     * every copy stored from here on and reaches none of those: they are
     * fresh for a day by their own terms, so nothing asks about them, and
     * they were stored per ?stream= — which is why this failed on the games
     * a visitor had opened before and on no others.
     */
    /**
     * Every script this site serves itself is deferred, bar the one that
     * cannot be.
     *
     * All of them used to be bare, which put some 30 KB of render-blocking
     * script in the <head> of every page — favorites.js and ui.js site-wide,
     * plus rating-stars.js and carousel.js on the listings and the game
     * page. None of them needs the parser to wait: they work off
     * DOMContentLoaded, off a delegated listener on the document, or off a
     * custom-element definition, all of which a deferred script still
     * reaches in time.
     *
     * theme-switcher.js is the exception and has to stay blocking: it puts
     * the stored theme's class on <html> before anything is painted, and
     * deferred it would let every page render in the default palette and
     * repaint. That is why it is the smallest of them.
     *
     * Asserted here because the cost of getting it wrong is invisible —
     * nothing fails, no test goes red, the page just renders later — so a
     * new <script> tag copied from an old one is exactly how this comes
     * back.
     */
    it("defers every script it serves except the theme switcher", async () => {
      const viewsDir = fileURLToPath(new URL("../views", import.meta.url));

      const offenders: string[] = [];

      for await (const view of glob("**/*.ejs", { cwd: viewsDir })) {
        const markup = await readFile(path.join(viewsDir, view), "utf-8");

        for (const [tag] of markup.matchAll(/<script\b[^>]*>/gi)) {
          // Inline blocks carry a nonce and no src; the analytics tag is
          // third-party and already async.
          if (!/\bsrc\s*=/.test(tag)) continue;
          if (/\bsrc\s*=\s*"https?:/.test(tag)) continue;
          if (tag.includes("theme-switcher.js")) continue;

          if (!/\bdefer\b/.test(tag)) {
            offenders.push(`${view}: ${tag}`);
          }
        }
      }

      expect(offenders).toEqual([]);
    });

    it("frames the player at a versioned address, not a bare one", async () => {
      const detail = await readFile(
        new URL("../views/games/game-detail.ejs", import.meta.url),
        "utf-8",
      );

      expect(detail).toContain("asset('/js-dos.html')");
      expect(detail).not.toContain('src="/js-dos.html');
    });

    /**
     * The frame the visitor without JavaScript gets, which is the one a
     * template writes and therefore the one that can go stale in a review.
     * public/js/game-player.js builds the same pair of attributes for
     * everybody else, and tests/js/game-player.test.ts holds it to them.
     *
     * The player is the one place on this site where third-party code runs,
     * and it runs with 'unsafe-eval'. The CSP says what it may load; the
     * sandbox says what it may do — navigate the top-level page, open
     * windows, read this origin's cookies — and no policy covers that.
     */
    describe("the player frame is sandboxed", () => {
      async function noscriptFrame(): Promise<string> {
        const detail = await readFile(
          new URL("../views/games/game-detail.ejs", import.meta.url),
          "utf-8",
        );

        // Up to the closing tag rather than to the first ">": the title
        // attribute holds an EJS tag, and its "%>" ends a [^>]* match three
        // attributes too early — which is how the first version of this
        // passed while asserting nothing.
        const frame = /<iframe class="game-detail-stream"[\s\S]*?><\/iframe>/.exec(
          detail,
        );

        expect(frame, "no player frame in the view").not.toBeNull();

        return frame![0];
      }

      it("gives it only what a DOS game uses", async () => {
        const frame = await noscriptFrame();

        expect(frame).toContain(
          'sandbox="allow-scripts allow-same-origin allow-pointer-lock"',
        );
      });

      /**
       * Kept on purpose: without it the frame is an opaque origin, where
       * js-dos cannot save a game or reach its own cache, and where
       * Cross-Origin-Resource-Policy refuses the player's own stylesheet and
       * script. The sandbox still withholds navigation and popups; see the
       * comment beside the frame.
       */
      it("keeps it on this origin", async () => {
        expect(await noscriptFrame()).toContain("allow-same-origin");
      });

      it("withholds navigation and popups", async () => {
        const frame = await noscriptFrame();

        expect(frame).not.toContain("allow-top-navigation");
        expect(frame).not.toContain("allow-popups");
        expect(frame).not.toContain("allow-forms");
      });

      /**
       * sandbox and allow are not alternatives. sandbox governs the frame,
       * the permissions policy governs the feature, and a feature allowed
       * site-wide is still not inherited by a frame that does not name it —
       * so fullscreen has to be said in both, and gamepad and autoplay
       * (controllers and sound) in the second.
       */
      it("passes through the features the emulator needs", async () => {
        expect(await noscriptFrame()).toContain(
          'allow="fullscreen; gamepad; autoplay"',
        );
      });
    });

    /**
     * Alt+Enter, forwarded from the page into the frame — and addressed to
     * this origin, which the frame's "allow-same-origin" makes possible. The
     * receiving end checks source and origin too; that half is covered in
     * tests/js/js-dos-player.test.ts.
     */
    it("addresses the fullscreen relay to this origin", async () => {
      const detail = await readFile(
        new URL("../views/games/game-detail.ejs", import.meta.url),
        "utf-8",
      );

      expect(detail).toContain(
        "postMessage({ action: 'clickFullscreen' }, window.location.origin)",
      );
      expect(detail).not.toContain("postMessage({ action: 'clickFullscreen' }, '*')");
    });

    /**
     * The access log, which is one line per *answered* request rather than
     * one per arriving one.
     *
     * Logging on the way in said nothing about what happened — no status, no
     * duration, the same line whether the request was served, refused or
     * timed out — and it wrote the full URL, query string included. That
     * string is what a visitor typed into the search box, which is the most
     * personal thing this site ever receives and the part of the address
     * with the least to say about a failure.
     *
     * The logger writes nothing at all under test (see utils/logger.ts), so
     * this watches the call rather than the output.
     */
    describe("the access log", () => {
      it("records method, path, status and duration as fields", async () => {
        const info = vi.spyOn(logger, "info").mockImplementation(() => {});

        try {
          // /login rather than /healthz: the health check, robots.txt, the
          // sitemap and the feeds are all mounted above this middleware on
          // purpose, so none of them is logged.
          await request(server).get("/login");

          const call = info.mock.calls.find(
            ([, fields]) =>
              typeof fields === "object" &&
              (fields as { path?: string })?.path === "/login",
          );

          expect(call, "no line for the request").toBeDefined();
          expect(call![1]).toMatchObject({
            method: "GET",
            path: "/login",
            status: 200,
          });
          expect(typeof (call![1] as { durationMs: number }).durationMs).toBe(
            "number",
          );
        } finally {
          info.mockRestore();
        }
      });

      it("keeps the query string out of the line", async () => {
        const info = vi.spyOn(logger, "info").mockImplementation(() => {});

        try {
          await request(server).get("/?search=something+private");

          const logged = JSON.stringify(info.mock.calls);

          expect(logged).not.toContain("something");
          // The path itself is still there — the line has to be worth
          // having.
          expect(logged).toContain('"path":"/"');
        } finally {
          info.mockRestore();
        }
      });

      it("reports the status of a request that was refused", async () => {
        const info = vi.spyOn(logger, "info").mockImplementation(() => {});

        try {
          // No CSRF token, so this is a 403 — the kind of request the log
          // exists for, and the kind the old line said nothing about.
          await request(server).post("/comments").send({ content: "hi" });

          const call = info.mock.calls.find(
            ([, fields]) =>
              (fields as { path?: string })?.path === "/comments",
          );

          expect(call).toBeDefined();
          expect(call![1]).toMatchObject({ method: "POST", status: 403 });
        } finally {
          info.mockRestore();
        }
      });
    });
  });

  /**
   * robots.txt was mounted ahead of the session, CSRF and voter-id middleware
   * on purpose, with a comment saying why: a crawler is the only thing that
   * asks for it and will never send a cookie back. The sitemap and the two
   * feeds are asked for by exactly the same clients and were left behind the
   * full stack, so every crawler hit still cost a session row and went home
   * with two cookies.
   */
  describe("crawler endpoints", () => {
    const CRAWLER_PATHS = [
      "/robots.txt",
      "/sitemap-index.xml",
      "/feed.xml",
      "/news/feed.xml",
    ];

    for (const path of CRAWLER_PATHS) {
      it(`hands out no cookies on ${path}`, async () => {
        const response = await request(server).get(path);

        expect(response.status).toBe(200);
        expect(response.headers["set-cookie"]).toBeUndefined();
      });
    }

    it("still answers a page with cookies, so the check above means something", async () => {
      const response = await request(server).get("/");

      expect(response.headers["set-cookie"]).toBeDefined();
    });
  });

  /**
   * The rendered proof of what tests/views/meta-tags.test.ts checks in the
   * source: that `locals.noindex` actually reaches views/head.ejs, and that
   * the canonical tag stands down when it does.
   *
   * /login is the case worth pinning. It carried no robots tag at all and was
   * kept out of the index by "Disallow: /login" in robots.txt instead, which
   * cannot work for a URL views/footer.ejs links from every page on the site:
   * Google indexes blocked-but-linked URLs from the links alone, and the
   * block is what stops it from ever reading the tag that would say no. The
   * block is gone and the tag is real, so this asserts the tag is there — and
   * asserts it the way a crawler sees it, through the whole stack, because
   * the signal travels on res.locals from routes/auth.ts and a render() call
   * mocked in a unit test would not show whether that arrives.
   */
  /**
   * The trail, on the pages whose path is fixed rather than derived.
   *
   * utils/breadcrumbs.ts grows a trail out of a page's locals and has a branch
   * for every listing whose trail *is* a local — a genre, a year, a developer.
   * These six have nothing to derive one from, so buildBreadcrumbs returned
   * "Home" alone, views/breadcrumb.ejs drew nothing and breadcrumbLdJson
   * dropped the one-step trail. All six are indexed and in the sitemap, and
   * the only thing telling a crawler where they sat was the URL.
   *
   * Both halves are asserted together on purpose: the visible trail and the
   * BreadcrumbList are built from one array precisely so that a page cannot
   * have one without the other.
   */
  describe("breadcrumb trails", () => {
    const fixedPages: [string, string][] = [
      ["/developers", "Developers"],
      ["/publishers", "Publishers"],
      ["/years", "Years"],
      ["/news", "News"],
      ["/about", "About"],
      ["/how-to-play", "How to Play"],
    ];

    it.each(fixedPages)("%s shows a trail ending in %s", async (path, name) => {
      const response = await request(server).get(path);

      expect(response.status).toBe(200);
      expect(response.text).toContain('aria-label="Breadcrumb"');
      expect(response.text).toContain(`<span aria-current="page">${name}</span>`);
    });

    it.each(fixedPages)("%s describes that trail as %s", async (path, name) => {
      const response = await request(server).get(path);

      expect(response.text).toContain('"@type":"BreadcrumbList"');
      expect(response.text).toContain(
        `{"@type":"ListItem","position":1,"name":"Home","item":"https://oldschoolgames.eu/"}`,
      );
      expect(response.text).toContain(
        `{"@type":"ListItem","position":2,"name":"${name}"}`,
      );
    });
  });

  describe("noindex pages", () => {
    it("serves /login a robots tag and no canonical", async () => {
      const response = await request(server).get("/login");

      expect(response.status).toBe(200);
      expect(response.text).toContain(
        '<meta name="robots" content="noindex, follow" />',
      );
      expect(response.text).not.toContain('rel="canonical"');
    });

    /**
     * The other branch, rendered through the whole stack.
     *
     * This used to assert that an indexable page carried no robots tag at
     * all, which was true and was the thing worth changing: "no tag" is not a
     * neutral position but an acceptance of whatever defaults a crawler
     * applies, and in the EU that means thumbnail-sized image previews on a
     * site whose content is very largely images. So the assertion is now that
     * the page states its preferences — and, still, that it does not contain
     * a noindex, which is the half that must never appear beside a canonical.
     */
    it("serves an indexable page a canonical and a preview opt-in", async () => {
      const response = await request(server).get("/about");

      expect(response.status).toBe(200);
      expect(response.text).toContain(
        '<link rel="canonical" href="https://oldschoolgames.eu/about" />',
      );
      expect(response.text).toContain(
        '<meta name="robots" content="max-image-preview:large, max-snippet:-1" />',
      );
      // The tag, not the word: the HTML comment head.ejs ships beside the
      // canonical explains at length what "noindex" does to it, so a bare
      // substring check here fails on the prose rather than on any tag.
      expect(response.text).not.toContain('content="noindex');
    });
  });
});

/**
 * The admin interface, end to end: a real password, a real login, a real
 * session cookie, a real form post. Every route test simulates the admin by
 * writing req.session.user directly, and isAuth/isAdmin are covered on their
 * own, so nothing exercised the join between them until now — the login
 * setting the session, the session reaching the guards, the guards letting
 * the form through and the flash surviving the redirect.
 */
describe("the admin flow through the assembled app", () => {
  const email = "e2e-admin@example.com";
  const password = "a long enough password for the suite";

  /** A masked token and the cookie backing it, as a browser would hold them. */
  async function csrfPair(): Promise<{ token: string; cookies: string[] }> {
    const page = await request(server).get("/login");
    const cookies = (page.headers["set-cookie"] as unknown as string[]).map(
      (value) => value.split(";")[0]!,
    );
    const token = /<meta name="csrf-token" content="([0-9a-f]{128})"/.exec(
      page.text,
    )?.[1];

    expect(token).toBeDefined();

    return { token: token!, cookies };
  }

  /** Signs the admin in and returns everything a browser would carry on. */
  async function signIn(): Promise<{ token: string; cookie: string }> {
    const { token, cookies } = await csrfPair();

    const login = await request(server)
      .post("/login")
      .set("Cookie", cookies.join("; "))
      .set("x-csrf-token", token)
      .type("form")
      .send({ email, password })
      .redirects(0);

    expect(login.status).toBe(302);
    expect(login.headers.location).toBe("/");

    const sessionCookies = (
      (login.headers["set-cookie"] as unknown as string[] | undefined) ?? []
    ).map((value) => value.split(";")[0]!);

    expect(sessionCookies.length).toBeGreaterThan(0);

    // Later cookies win, the way a browser jar would treat them.
    const jar = new Map<string, string>();

    for (const pair of [...cookies, ...sessionCookies]) {
      const [name, ...rest] = pair.split("=");
      jar.set(name!, rest.join("="));
    }

    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

    /**
     * A token minted *after* the login, not the one that authorised it.
     *
     * routes/auth.ts rotates the CSRF secret inside session.regenerate, for
     * the same reason express-session rotates the session id there: a secret
     * fixed onto the browser before the login must not still be good after
     * it. So the token this suite carried into the login is dead the moment
     * it succeeds, exactly as a token on a page rendered before signing in
     * is — and a browser never reuses one, because it reads a fresh one out
     * of the next page it loads. This does the same.
     */
    const page = await request(server).get("/").set("Cookie", cookie);
    const fresh = /<meta name="csrf-token" content="([0-9a-f]{128})"/.exec(
      page.text,
    )?.[1];

    expect(fresh, "no token on the page after signing in").toBeDefined();

    return { token: fresh!, cookie };
  }

  beforeEach(async () => {
    await User.upsertAdmin({ email, password });
    await pool.query('DELETE FROM "games" WHERE "title" = $1', ["E2E Game"]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM "games" WHERE "title" = $1', ["E2E Game"]);
    await pool.query('DELETE FROM "users" WHERE "email" = $1', [email]);
  });

  it("keeps the admin form away from a visitor", async () => {
    const response = await request(server).get("/games/new").redirects(0);

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/login");
  });

  /**
   * Every admin route, through the real isAuth/isAdmin chain.
   *
   * The route suites mount each router on an app whose fake session is
   * always an ADMIN, so a guard dropped from one route in routes/games.ts
   * left every test green: isAdmin was unit-tested, the routes were tested,
   * and nothing checked that each route actually called it. The list below
   * is the contract — a new admin route belongs on it.
   */
  const ADMIN_ROUTES: [string, string][] = [
    ["GET", "/games/new"],
    ["POST", "/games"],
    ["GET", "/games/1/edit"],
    ["POST", "/games/1"],
    ["POST", "/games/1/delete"],
    ["GET", "/news/new"],
    ["POST", "/news"],
    ["GET", "/news/1/edit"],
    ["POST", "/news/1"],
    ["POST", "/news/1/delete"],
    ["POST", "/comments/1/delete"],
  ];

  describe("every admin route", () => {
    it.each(ADMIN_ROUTES)(
      "sends an anonymous %s %s to the login page",
      async (method, route) => {
        // A POST carries a valid CSRF pair so the refusal, if any, is the
        // guard's and not the CSRF middleware's.
        const { token, cookies } = await csrfPair();

        const response = await (
          method === "GET" ? request(server).get(route) : request(server).post(route)
        )
          .set("Cookie", cookies.join("; "))
          .set("x-csrf-token", token)
          .redirects(0);

        expect(response.status).toBe(302);
        expect(response.headers.location).toBe("/login");
      },
    );

    it.each(ADMIN_ROUTES)(
      "refuses a signed-in visitor without the admin role a %s %s",
      async (method, route) => {
        const userEmail = "e2e-user@example.com";

        await pool.query('DELETE FROM "users" WHERE "email" = $1', [userEmail]);
        await User.create({ email: userEmail, password });

        try {
          const { token, cookies } = await csrfPair();

          const login = await request(server)
            .post("/login")
            .set("Cookie", cookies.join("; "))
            .set("x-csrf-token", token)
            .type("form")
            .send({ email: userEmail, password })
            .redirects(0);

          expect(login.status).toBe(302);

          const jar = new Map<string, string>();

          for (const pair of [
            ...cookies,
            ...((login.headers["set-cookie"] as unknown as string[]) ?? []).map(
              (value) => value.split(";")[0]!,
            ),
          ]) {
            const [name, ...rest] = pair.split("=");
            jar.set(name!, rest.join("="));
          }

          const cookie = [...jar]
            .map(([name, value]) => `${name}=${value}`)
            .join("; ");

          const response = await (
            method === "GET" ? request(server).get(route) : request(server).post(route)
          )
            .set("Cookie", cookie)
            .set("x-csrf-token", token)
            .redirects(0);

          expect(response.status).toBe(403);
        } finally {
          await pool.query('DELETE FROM "users" WHERE "email" = $1', [userEmail]);
        }
      },
    );
  });

  it("refuses a wrong password without a session", async () => {
    const { token, cookies } = await csrfPair();

    const login = await request(server)
      .post("/login")
      .set("Cookie", cookies.join("; "))
      .set("x-csrf-token", token)
      .type("form")
      .send({ email, password: "not it" });

    expect(login.status).toBe(401);
    expect(
      ((login.headers["set-cookie"] as unknown as string[] | undefined) ?? [])
        .join(" "),
    ).not.toMatch(/connect\.sid/);
  });

  it("signs the admin in, serves the form, saves a game and shows the flash", async () => {
    const { token, cookie } = await signIn();

    const form = await request(server).get("/games/new").set("Cookie", cookie);

    expect(form.status).toBe(200);
    expect(form.text).toContain('name="title"');

    const saved = await request(server)
      .post("/games")
      .set("Cookie", cookie)
      .set("x-csrf-token", token)
      .type("form")
      .send({
        title: "E2E Game",
        genre: "ACTION",
        release: "1993",
        description: "Written by the suite.",
      })
      .redirects(0);

    expect(saved.status, saved.text).toBe(302);
    expect(saved.headers.location).toBe("/");

    const game = await Game.findBySlug("e2e-game");

    expect(game).not.toBeNull();
    expect(game!.title).toBe("E2E Game");

    // The flash is rendered on the next page the admin sees, and only for a
    // signed-in visitor — see views/flash.ejs.
    const next = await request(server).get(saved.headers.location!).set("Cookie", cookie);

    expect(next.status).toBe(200);
    expect(next.text).toContain('class="alert alert-success"');
    expect(next.text).toContain("Game created successfully.");

    // Shown once: a reload does not repeat it.
    const reload = await request(server).get(saved.headers.location!).set("Cookie", cookie);

    expect(reload.text).not.toContain("Game created successfully.");
  });

  it("signs the admin out and closes the form again", async () => {
    const { token, cookie } = await signIn();

    const logout = await request(server)
      .post("/logout")
      .set("Cookie", cookie)
      .set("x-csrf-token", token)
      .redirects(0);

    expect(logout.status).toBe(302);

    const response = await request(server)
      .get("/games/new")
      .set("Cookie", cookie)
      .redirects(0);

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/login");
  });
});
