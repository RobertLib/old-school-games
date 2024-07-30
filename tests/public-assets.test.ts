import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, globSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  MEDIA_ORIGIN,
  SITE_IMAGE_HEIGHT,
  SITE_IMAGE_WIDTH,
  SITE_LOGO_SIZE,
  SITE_NAME,
} from "../utils/site.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../public");

const htmlFiles = globSync("public/**/*.html");

/**
 * The Content-Security-Policy in app.ts allows inline script only by nonce,
 * and the nonce is minted per response and stamped into the EJS templates. A
 * file served by express.static has nowhere to carry one, so any inline
 * <script> in public/ is refused by the browser outright — silently, as far
 * as the server is concerned.
 *
 * That is exactly what happened to the DOS player: both of js-dos.html's
 * inline blocks were blocked, Dos() was never called, and no game on the site
 * would start. Nothing caught it because a static file passes through none of
 * the route tests, and eslint ignores js-dos.html.
 */
describe("static HTML in public/ under the script-src nonce", () => {
  it("has HTML files to check", () => {
    expect(htmlFiles.length).toBeGreaterThan(0);
  });

  it.each(htmlFiles)("%s carries no inline <script>", (file) => {
    const html = readFileSync(file, "utf-8");

    const inline = [...html.matchAll(/<script\b([^>]*)>/gi)]
      .map((match) => match[1] ?? "")
      .filter((attrs) => !/\bsrc\s*=/i.test(attrs));

    expect(inline).toEqual([]);
  });

  it.each(htmlFiles)("%s only references scripts that exist", (file) => {
    const html = readFileSync(file, "utf-8");

    const missing = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*"([^"]+)"/gi)]
      .map((match) => match[1]!)
      // Off-site scripts are the CDN's problem; the allowlist in app.ts is
      // what governs those.
      .filter((src) => src.startsWith("/"))
      // A query string names no directory on disk. express.static routes on
      // the path alone, so the file this resolves to is the one the browser
      // is served — "/js/js-dos-player.js?retired-v8" included, which exists
      // only to walk away from copies stored under the bare name.
      .map((src) => src.split(/[?#]/)[0]!)
      .filter((src) => !existsSync(path.join(PUBLIC_DIR, src)));

    expect(missing).toEqual([]);
  });
});

/**
 * js-dos runs with full privileges in this origin — it is the emulator, so it
 * has to — and it used to be loaded from the vendor's "/latest/", a URL whose
 * contents can change under the site at any time. It is pinned to one
 * immutable release now, hash-checked, and the emulator runtime is pinned
 * alongside it (see public/js-dos.html and public/js/js-dos-player.js).
 *
 * These keep the pin honest. Every one of them is something that would
 * silently give back the exposure: an unpinned URL creeping in, a hash left
 * off, or the loader and the emulator runtime drifting onto different
 * releases — a combination nobody upstream tests.
 */
describe("the DOS emulator is pinned rather than tracking /latest/", () => {
  const PLAYER_HTML = path.join(PUBLIC_DIR, "js-dos.html");
  const PLAYER_JS = path.join(PUBLIC_DIR, "js/js-dos-player.js");

  const html = readFileSync(PLAYER_HTML, "utf-8");
  const playerJs = readFileSync(PLAYER_JS, "utf-8");

  /** Every off-site script and stylesheet the player page pulls in. */
  const offSiteTags = [...html.matchAll(/<(script|link)\b([^>]*)>/gi)]
    .map((match) => ({ tag: match[1]!, attrs: match[2]! }))
    .filter(({ attrs }) => /\b(?:src|href)\s*=\s*"https?:/i.test(attrs));

  it("pulls something off-site, so the checks below are not vacuous", () => {
    expect(offSiteTags.length).toBeGreaterThan(0);
  });

  // The attribute values, not the file text: both files carry comments that
  // quote the old "/latest/" URLs to explain what they were pinned away from,
  // and prose about a URL is not a request for one.
  it.each(htmlFiles)("%s loads nothing from an unpinned /latest/", (file) => {
    const targets = [
      ...readFileSync(file, "utf-8").matchAll(
        /\b(?:src|href)\s*=\s*"([^"]+)"/gi,
      ),
    ].map((match) => match[1]!);

    expect(targets.filter((url) => url.includes("/latest/"))).toEqual([]);
  });

  it("pins the emulator runtime too, not only the loader", () => {
    // Without this js-dos defaults pathPrefix to the vendor's
    // "/latest/emulators/", which is where wdosbox.wasm — the part that
    // actually runs the game — would still have come from.
    const pathPrefix = /pathPrefix:\s*`([^`]+)`/.exec(playerJs)?.[1];

    expect(pathPrefix).toBeDefined();
    expect(pathPrefix).not.toContain("/latest/");
    expect(pathPrefix).toContain("js-dos@");
  });

  it("hash-checks every off-site script and stylesheet", () => {
    for (const { tag, attrs } of offSiteTags) {
      expect(attrs, `<${tag}> is missing integrity`).toMatch(
        /\bintegrity\s*=\s*"sha(?:256|384|512)-/,
      );
      // Required for integrity to be enforced on a cross-origin load.
      expect(attrs, `<${tag}> is missing crossorigin`).toMatch(
        /\bcrossorigin\s*=/,
      );
    }
  });

  it("names one js-dos release across the page and the player", () => {
    const versions = new Set(
      [
        ...html.matchAll(/js-dos@(\d+\.\d+\.\d+)/g),
        ...playerJs.matchAll(/JS_DOS_VERSION\s*=\s*"(\d+\.\d+\.\d+)"/g),
      ].map((match) => match[1]!),
    );

    expect(versions.size, `found ${[...versions].join(", ")}`).toBe(1);
  });

  /**
   * The player refuses a "?stream=" from anywhere but this origin and the
   * media bucket, and it cannot ask the server which bucket that is — it is a
   * static file. So the address is written down twice, and this is what keeps
   * the two copies honest, exactly as the release check above does for
   * js-dos.
   *
   * Against the default rather than the live value: MEDIA_ORIGIN reads an
   * environment variable, and a deployment that sets it is expected to change
   * the player with it. What this catches is the other case — the default
   * moving in utils/site.ts while the player goes on naming the old bucket,
   * which would refuse every game on the site.
   */
  it("allows bundles from the same media origin the policy does", () => {
    const declared = /MEDIA_ORIGIN\s*=\s*"([^"]+)"/.exec(playerJs)?.[1];

    expect(declared).toBeDefined();
    expect(declared).toBe(MEDIA_ORIGIN);
  });
});

/**
 * The two images every scraper is pointed at, and the floors they have to
 * clear.
 *
 * Both were one undersized file — /images/navbar.webp at 180x180 — serving as
 * og:image, twitter:image, the NewsArticle image and, via /favicon.png at
 * 32x32, the Organization logo. Every consumer of those has a minimum and
 * that file was under all of them, which is a failure nothing reports: a
 * preview card simply comes back without a picture. See SITE_IMAGE and
 * SITE_LOGO in utils/site.ts.
 *
 * Asserted against the files rather than against the constants, because the
 * constants are only addresses — it is the pixels behind them that any of
 * this depends on.
 */
describe("the images shared links and rich results are pointed at", () => {
  /** Width and height out of a PNG's IHDR, which is always the first chunk. */
  function pngSize(file: string): { width: number; height: number } {
    const bytes = readFileSync(file);

    expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");

    return {
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  }

  it("ships an og:image of at least 1200x630", () => {
    const file = path.join(PUBLIC_DIR, "images/og-image.png");

    expect(existsSync(file)).toBe(true);

    const { width, height } = pngSize(file);

    // 1200 is Google's floor for an Article rich result and the width both
    // Open Graph and X document for a large card; 630 is the 1.91:1 that goes
    // with it. Facebook and LinkedIn refuse to render anything under 200x200
    // at all, so this clears that several times over.
    expect(width).toBeGreaterThanOrEqual(1200);
    expect(height).toBeGreaterThanOrEqual(630);
  });

  it("declares the og:image dimensions it actually has", () => {
    const { width, height } = pngSize(
      path.join(PUBLIC_DIR, "images/og-image.png"),
    );

    // A wrong pair is worse than none — a scraper that believes it lays out
    // the wrong box — so the constants views/og-image.ejs emits have to be
    // the file's own size.
    expect(width).toBe(SITE_IMAGE_WIDTH);
    expect(height).toBe(SITE_IMAGE_HEIGHT);
  });

  it("ships a square Organization logo of at least 112x112", () => {
    const file = path.join(PUBLIC_DIR, "images/logo.png");

    expect(existsSync(file)).toBe(true);

    const { width, height } = pngSize(file);

    // Google's documented minimum for Organization.logo. /favicon.png, which
    // this node used to name, is 32x32 — so the logo was declared and unusable.
    expect(width).toBeGreaterThanOrEqual(112);
    expect(height).toBeGreaterThanOrEqual(112);
    expect(width).toBe(height);
    expect(width).toBe(SITE_LOGO_SIZE);
  });
});

/**
 * The web manifest, and the two things about it that can rot quietly.
 *
 * It is a static file rather than a route — unlike robots.txt, which had to
 * become one so its Sitemap line could name the canonical host. Nothing in a
 * manifest depends on where the site is deployed: every address in it resolves
 * relative to the manifest itself. The price of being static is that it is
 * JSON, so it can carry neither a comment nor an import, and the name and the
 * icons in it are copies of things that live somewhere else.
 *
 * That is the same bargain public/js-dos.html strikes over MEDIA_ORIGIN above,
 * and this is the same way of keeping it honest.
 */
describe("the web manifest", () => {
  const MANIFEST = path.join(PUBLIC_DIR, "site.webmanifest");

  it("is shipped", () => {
    expect(existsSync(MANIFEST)).toBe(true);
  });

  const manifest = JSON.parse(readFileSync(MANIFEST, "utf-8"));

  it("calls the site what the rest of the site calls it", () => {
    // SITE_NAME is the brand on its own — the same value og:site_name and the
    // Organization node are built from. utils/site.ts records what it cost
    // when two spellings of it were in circulation.
    expect(manifest.name).toBe(SITE_NAME);
    expect(manifest.short_name).toBe(SITE_NAME);
  });

  it("stays inside the site", () => {
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
  });

  it("names only icons that exist, at the sizes it claims", () => {
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons.length).toBeGreaterThan(0);

    for (const icon of manifest.icons) {
      const file = path.join(PUBLIC_DIR, icon.src);

      expect(existsSync(file), `${icon.src} is missing`).toBe(true);

      const bytes = readFileSync(file);

      expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");

      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);

      expect(`${width}x${height}`, `${icon.src} is not ${icon.sizes}`).toBe(
        icon.sizes,
      );
    }
  });

  /**
   * A browser will not offer to install a site whose manifest has no icon of
   * at least 192x192, and it does not say why — the option is simply absent.
   * /images/logo.png is the 360x360 mark utils/site.ts already keeps for the
   * Organization node, which clears it.
   *
   * There is deliberately no 512x512, which is the size a splash screen would
   * prefer. The artwork is pixel art and utils/site.ts scales it by whole
   * numbers on purpose — 360 is 2x the 180x180 original — so a 512 would have
   * to be resampled at 2.84x and would arrive blurred. A browser scales the
   * 360 down cleanly enough; a blurred source it cannot fix.
   */
  it("carries an icon large enough for the install prompt", () => {
    const largest = Math.max(
      ...manifest.icons.map((icon: { sizes: string }) =>
        Number(icon.sizes.split("x")[0]),
      ),
    );

    expect(largest).toBeGreaterThanOrEqual(192);
  });

  it("opens in a window with a way back", () => {
    // This is a catalogue people browse rather than an app they enter, so
    // "standalone" — no back button at all — is the wrong shape for it.
    expect(manifest.display).toBe("minimal-ui");
  });
});

/**
 * app.ts scopes the Content-Security-Policy to one js-dos release on
 * jsDelivr rather than to the whole CDN, which serves every npm package there
 * is. That only holds if the release in the policy is the release the player
 * loads — a version bumped in one place and not the other blocks the emulator
 * with nothing but a console message to show for it.
 */
describe("the CSP names the js-dos release the player loads", () => {
  it("pins the same version in app.ts, the player page and the player script", () => {
    const appTs = readFileSync(path.join(PUBLIC_DIR, "../app.ts"), "utf-8");
    const html = readFileSync(path.join(PUBLIC_DIR, "js-dos.html"), "utf-8");
    const playerJs = readFileSync(
      path.join(PUBLIC_DIR, "js/js-dos-player.js"),
      "utf-8",
    );

    const inApp = /JS_DOS_VERSION\s*=\s*"(\d+\.\d+\.\d+)"/.exec(appTs)?.[1];
    const inHtml = /js-dos@(\d+\.\d+\.\d+)/.exec(html)?.[1];
    const inPlayer = /JS_DOS_VERSION\s*=\s*"(\d+\.\d+\.\d+)"/.exec(playerJs)?.[1];

    expect(inApp).toBeDefined();
    expect(inHtml).toBe(inApp);
    expect(inPlayer).toBe(inApp);
  });

  it("scopes the source to a path, not the bare CDN origin", () => {
    const appTs = readFileSync(path.join(PUBLIC_DIR, "../app.ts"), "utf-8");
    const source = /const JS_DOS_SOURCE = `([^`]+)`/.exec(appTs)?.[1];

    expect(source).toBeDefined();
    expect(source).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/npm\/js-dos@\$\{JS_DOS_VERSION\}\/dist\/$/);
  });
});
