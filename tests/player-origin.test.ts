import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { JSDOM } from "jsdom";
import http from "http";
import type { AddressInfo } from "net";

/**
 * The DOS player on an origin of its own — PLAYER_ORIGIN in utils/site.ts.
 *
 * By default the player is /js-dos.html on this site, framed same-origin,
 * and its sandbox is no boundary: the frame can lift it, or reach into the
 * page it sits in. With PLAYER_ORIGIN set the same frame is cross-origin,
 * which is what makes it one. This file is the whole of that arrangement,
 * end to end through the assembled app: what the game page frames, what the
 * player origin answers, and what this origin stops answering. The default
 * arrangement is held in place by tests/app.test.ts.
 *
 * A file of its own because the setting is read once, when utils/site.ts is
 * imported, and every file in the suite gets a fresh module graph — so the
 * app below is booted with a player origin and every other file's is not.
 */
const PLAYER = "https://play.example.test";
const PLAYER_HOST = "play.example.test";
const SITE = "https://oldschoolgames.eu";
const JS_DOS_SOURCE = "https://cdn.jsdelivr.net/npm/js-dos@8.4.1/dist/";

// Set before app.ts is imported, and put back once it has been: nothing else
// reads it after import, and the next file in this worker must not see it.
const previousPlayerOrigin = process.env.PLAYER_ORIGIN;
process.env.PLAYER_ORIGIN = PLAYER;

const { default: app } = await import("../app.ts");
const { default: pool } = await import("../db.ts");

if (previousPlayerOrigin === undefined) delete process.env.PLAYER_ORIGIN;
else process.env.PLAYER_ORIGIN = previousPlayerOrigin;

// One listening server for the file, for the reason tests/app.test.ts gives.
const server = app.listen(0);

afterAll(() => {
  server.close();
});

/** The named directive's sources, from whichever policy a response carries. */
function directive(csp: string | undefined, name: string): string[] {
  return (new RegExp(`(?:^|;)\\s*${name} ([^;]*)`).exec(csp ?? "")?.[1] ?? "")
    .split(" ")
    .filter(Boolean);
}

/** Runs one request as production, where the host redirects apply. */
async function asProduction<T>(send: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    return await send();
  } finally {
    process.env.NODE_ENV = previous;
  }
}

describe("the game page, with a player origin", () => {
  beforeAll(async () => {
    // One game stored with a path on this site, which is the case the page
    // has to resolve, and one on the media bucket, which it leaves alone.
    await pool.query(
      `INSERT INTO "games" ("title", "slug", "description", "genre", "developer", "stream")
       VALUES ($1, $2, $3, $4, $5, $6), ($7, $8, $9, $10, $11, $12)`,
      [
        "Doom",
        "doom",
        "<p>Classic FPS.</p>",
        "ACTION",
        "id Software",
        "/bundles/doom.jsdos",
        "Heretic",
        "heretic",
        "<p>Fantasy FPS.</p>",
        "ACTION",
        "Raven Software",
        "https://trwglibsccninuamefls.supabase.co/storage/v1/object/public/games/heretic.jsdos",
      ],
    );
  });

  async function framesOf(slug: string) {
    const response = await request(server).get(`/${slug}`);

    expect(response.status).toBe(200);

    const { document } = new JSDOM(response.text).window;
    const scripted = document
      .querySelector(".game-detail-player")!
      .getAttribute("data-player-src")!;
    const noscript = document.querySelector(".game-detail-player noscript")!;
    const fallback = new JSDOM(noscript.innerHTML).window.document
      .querySelector("iframe.game-detail-stream")!
      .getAttribute("src")!;

    return { response, scripted, fallback };
  }

  it("frames the player from its own origin, in both frames", async () => {
    const { scripted, fallback } = await framesOf("doom");

    expect(scripted.startsWith(`${PLAYER}/js-dos.html?v=`)).toBe(true);
    expect(fallback).toBe(scripted);
  });

  /**
   * Resolved against the player's origin, a path on this site would name a
   * file the player origin does not serve, and the game would 404.
   */
  it("hands the player a path on this site as an address on this site", async () => {
    const { scripted } = await framesOf("doom");

    expect(new URL(scripted).searchParams.get("stream")).toBe(
      `${SITE}/bundles/doom.jsdos`,
    );
  });

  it("hands over a bundle from the media bucket as it is", async () => {
    const { scripted } = await framesOf("heretic");

    expect(new URL(scripted).searchParams.get("stream")).toBe(
      "https://trwglibsccninuamefls.supabase.co/storage/v1/object/public/games/heretic.jsdos",
    );
  });

  /**
   * The player origin instead of 'self', not as well as it: a page that
   * could still frame this origin's /js-dos.html could put the emulator
   * back beside the page it was moved away from.
   */
  it("lets the page frame the player origin and nothing else", async () => {
    const { response } = await framesOf("doom");

    expect(
      directive(response.headers["content-security-policy"], "frame-src"),
    ).toEqual([PLAYER]);
  });
});

describe("the player origin", () => {
  function get(path: string) {
    return request(server).get(path).set("Host", PLAYER_HOST);
  }

  it.each(["/js-dos.html", "/js/js-dos-player.js", "/css/js-dos-player.css"])(
    "serves the player's own %s",
    async (path) => {
      const response = await get(path);

      expect(response.status).toBe(200);
      // Revalidated, as on this origin — see REVALIDATED_FILES in app.ts.
      expect(response.headers["cache-control"]).toBe("public, no-cache");
      expect(response.headers["etag"]).toBeDefined();
    },
  );

  // The addresses the page and the frame really ask for, query and all.
  it.each([
    "/js-dos.html?v=0123456789&stream=https%3A%2F%2Foldschoolgames.eu%2Fdoom.jsdos",
    "/js/js-dos-player.js?retired-v8",
  ])("serves %s", async (path) => {
    expect((await get(path)).status).toBe(200);
  });

  describe("the player's policy there", () => {
    async function playerCsp(): Promise<string> {
      const response = await get("/js-dos.html");

      return response.headers["content-security-policy"] as string;
    }

    it("still gives the emulator what it runs on", async () => {
      const scriptSrc = directive(await playerCsp(), "script-src");

      expect(scriptSrc).toContain("'unsafe-eval'");
      expect(scriptSrc).toContain("blob:");
      expect(scriptSrc).toContain(JS_DOS_SOURCE);
    });

    /**
     * 'self' there would be the player origin framing itself. The pages that
     * frame it are on this site, so that is who may — and nobody else.
     */
    it("may be framed by this site and by nothing else", async () => {
      expect(directive(await playerCsp(), "frame-ancestors")).toEqual([SITE]);
    });

    // A game stored as a path on this site is fetched from it — 'self' is
    // the player's origin by now, which has no games.
    it("may fetch a game from this site as well as from the bucket", async () => {
      expect(directive(await playerCsp(), "connect-src")).toEqual([
        "'self'",
        JS_DOS_SOURCE,
        "https://trwglibsccninuamefls.supabase.co",
        SITE,
      ]);
    });

    it("reports to its own origin", async () => {
      const csp = await playerCsp();

      expect(directive(csp, "report-to")).toEqual(["csp-endpoint"]);
      expect(directive(csp, "report-uri")).toEqual(["/csp-report"]);
    });

    /**
     * helmet's X-Frame-Options says SAMEORIGIN, and the player's parent is
     * never same-origin there — a browser that knew only that header would
     * refuse the frame outright.
     */
    it("drops the same-origin frame header helmet sends", async () => {
      const response = await get("/js-dos.html");

      expect(response.headers["x-frame-options"]).toBeUndefined();
    });
  });

  /**
   * Everything else is a 404, and a bare one: the player origin must not
   * become a mirror of the site — its pages, its login, its sitemap, or even
   * its layout on an error page — under a hostname linked from every game.
   */
  describe("answers nothing else", () => {
    it.each([
      "/",
      "/doom",
      "/about",
      "/login",
      "/news",
      "/robots.txt",
      "/sitemap-index.xml",
      "/feed.xml",
      "/favicon.ico",
      "/js/ui.js",
      "/js/game-player.js",
      "/css/style.css",
      "/images/og-image.png",
      "/site.webmanifest",
      // Other spellings of a player file, which express.static would decode
      // or fold to the same file: matched on the address as it arrived.
      "/%6As-dos.html",
      "/JS-DOS.HTML",
    ])("GET %s", async (path) => {
      const response = await get(path);

      expect(response.status).toBe(404);
      expect(response.headers["content-type"]).toMatch(/^text\/plain/);
      expect(response.text).toBe("Not found");
      // Nothing of the site's: no session, no CSRF cookie, no voter id.
      expect(response.headers["set-cookie"]).toBeUndefined();
    });

    /**
     * Dot segments, sent exactly as written. A browser — and supertest,
     * which resolves its address the same way — folds these before they
     * leave, so they only ever arrive from something writing raw requests;
     * that is who this is for.
     */
    it.each(["/js/../css/style.css", "/css/%2E%2E/js/ui.js", "/js/../js-dos.html"])(
      "a raw GET %s",
      async (path) => {
        const address = server.address() as AddressInfo;

        const status = await new Promise<number>((resolve, reject) => {
          const req = http.request(
            {
              host: "127.0.0.1",
              port: address.port,
              path,
              method: "GET",
              headers: { Host: PLAYER_HOST },
            },
            (res) => {
              res.resume();
              resolve(res.statusCode ?? 0);
            },
          );
          req.on("error", reject);
          req.end();
        });

        expect(status).toBe(404);
      },
    );

    it.each(["/login", "/comments", "/games/1/play", "/games/1/rate", "/js-dos.html"])(
      "POST %s",
      async (path) => {
        const response = await request(server)
          .post(path)
          .set("Host", PLAYER_HOST)
          .send({ email: "a@example.org", password: "x" });

        expect(response.status).toBe(404);
        expect(response.headers["set-cookie"]).toBeUndefined();
      },
    );
  });

  // The one other thing it answers: the player's own violation reports,
  // which its relative report-uri sends back to it.
  it("takes the player's violation reports", async () => {
    const response = await request(server)
      .post("/csp-report")
      .set("Host", PLAYER_HOST)
      .set("Content-Type", "application/csp-report")
      .send(
        JSON.stringify({
          "csp-report": {
            "document-uri": `${PLAYER}/js-dos.html?stream=x`,
            "effective-directive": "connect-src",
            "blocked-uri": "https://tracker.example/perf/set",
            disposition: "enforce",
          },
        }),
      );

    expect(response.status).toBe(204);
  });

  // A health check is addressed to the machine; it must never depend on
  // which host it named.
  it("still answers the health check", async () => {
    expect((await get("/healthz")).status).toBe(200);
  });

  describe("in production", () => {
    /**
     * The canonical-host redirect sends every other host to the site. Sent
     * there, the frame's address would land on this origin's /js-dos.html,
     * which frame-src no longer allows — a player that never loads.
     */
    it("is not redirected to the canonical host", async () => {
      const response = await asProduction(() =>
        get("/js-dos.html").set("x-forwarded-proto", "https"),
      );

      expect(response.status).toBe(200);
    });

    it("is moved onto HTTPS on its own origin, not the site's", async () => {
      const response = await asProduction(() =>
        get("/js-dos.html?v=1").set("x-forwarded-proto", "http"),
      );

      expect(response.status).toBe(301);
      expect(response.headers.location).toBe(`${PLAYER}/js-dos.html?v=1`);
    });

    it("leaves every other host redirected as before", async () => {
      const response = await asProduction(() =>
        request(server).get("/doom").set("Host", "evil.example"),
      );

      expect(response.status).toBe(301);
      expect(response.headers.location).toBe(`${SITE}/doom`);
    });
  });
});

describe("this origin, with a player origin", () => {
  /**
   * The file is still here and still served, but under the site's own
   * policy: the relaxed one, on this origin, would put the emulator one link
   * away from an admin's session whether or not anything frames it. Keyed on
   * the file, so every spelling that reaches it is covered.
   */
  it.each(["/js-dos.html", "/js-dos.html?v=1&stream=x", "/%6As-dos.html"])(
    "no longer runs the emulator at %s",
    async (path) => {
      const response = await request(server).get(path);
      const csp = response.headers["content-security-policy"] as string;

      expect(response.status).toBe(200);
      expect(directive(csp, "script-src")).not.toContain("'unsafe-eval'");
      expect(directive(csp, "script-src")).not.toContain(JS_DOS_SOURCE);
      expect(directive(csp, "frame-ancestors")).toEqual(["'self'"]);
    },
  );

  /**
   * A game stored as a path on this site is fetched by the player on its own
   * origin, with fetch() — a CORS request — so the site's static files name
   * the player origin. One fixed origin and no credentials.
   */
  it("lets the player origin fetch its files", async () => {
    const response = await request(server).get("/js/ui.js");

    expect(response.headers["access-control-allow-origin"]).toBe(PLAYER);
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("still answers its own pages as before", async () => {
    const response = await request(server).get("/about");

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
