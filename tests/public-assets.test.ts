import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, globSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  MEDIA_ORIGIN,
  PLAYER_PATHS,
  SITE_IMAGE_HEIGHT,
  SITE_IMAGE_WIDTH,
  SITE_LOGO_SIZE,
  SITE_NAME,
  SITE_URL,
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
   * Against the live value, not against the default: MEDIA_ORIGIN is
   * `process.env.MEDIA_ORIGIN ?? "https://trwglibsccninuamefls.supabase.co"`,
   * so this compares the player with whichever of the two the process is
   * actually going to use.
   *
   * That is deliberate, and it is the stricter of the two readings. On CI and
   * on a checkout with no MEDIA_ORIGIN exported it catches the ordinary case:
   * the default moving in utils/site.ts while the player goes on naming the
   * old bucket, which would refuse every bundle on the site. On a machine that
   * does export the variable it also fails — and that failure is the point
   * rather than noise, because the player is a static file that cannot read
   * the variable. Pointing the server at another bucket without editing
   * MEDIA_ORIGIN in public/js/js-dos-player.js gives a site whose pages link
   * at one host and whose player refuses everything from it, and the loud
   * version of that is a red test rather than a dead Play button.
   */
  it("allows bundles from the same media origin the policy does", () => {
    const declared = /MEDIA_ORIGIN\s*=\s*"([^"]+)"/.exec(playerJs)?.[1];

    expect(declared).toBeDefined();
    expect(declared).toBe(MEDIA_ORIGIN);
  });

  /**
   * The CRT toggle's shipped label, and the default the script reads.
   *
   * The button was served reading "CRT: OFF" while `crtOn` starts as
   * `readStored("osg-crt") !== "0"` — on. The script rewrote the label on
   * load, so the mismatch was one frame for most visitors and invisible in
   * every test that ran the script; but with the script blocked, still in
   * flight, or broken, the label is the only thing there is, and it said the
   * opposite of what the stylesheet was already drawing.
   *
   * Two copies of one fact, like MEDIA_ORIGIN above, so they are checked the
   * same way: the markup's label and aria-pressed against the default the
   * player computes.
   */
  it("ships the CRT button in the state the player defaults to", () => {
    const button = /<button\s+id="crt-btn"([^>]*)>([^<]*)<\/button>/.exec(html);

    expect(button, "no #crt-btn in public/js-dos.html").not.toBeNull();

    // `!== "0"` — anything other than a stored "0", a never-set preference
    // included, is on.
    const defaultsOn = /let crtOn = readStored\("osg-crt"\) !== "0";/.test(
      playerJs,
    );

    expect(defaultsOn, "the default in js-dos-player.js has moved").toBe(true);
    expect(button![2]!.trim()).toBe("CRT: ON");
    expect(button![1]!).toMatch(/\baria-pressed\s*=\s*"true"/);
  });
});

/**
 * The two things the player has to agree with the server about once it can
 * be served from an origin of its own (PLAYER_ORIGIN in utils/site.ts).
 */
describe("the player on an origin of its own", () => {
  const html = readFileSync(path.join(PUBLIC_DIR, "js-dos.html"), "utf-8");
  const playerJs = readFileSync(
    path.join(PUBLIC_DIR, "js/js-dos-player.js"),
    "utf-8",
  );

  /**
   * Which site the player belongs to. On a player origin its own origin says
   * nothing about that, and a static file cannot ask the server — so
   * SITE_ORIGIN is written down in the script, like MEDIA_ORIGIN above, and
   * held to SITE_URL the same way and for the same reason: against the live
   * value, so a CANONICAL_HOST that moves without the script is a red test
   * rather than a player that refuses every Alt+Enter and every game stored
   * on the site.
   */
  it("names the same site the server does", () => {
    const declared = /\bSITE_ORIGIN\s*=\s*"([^"]+)"/.exec(playerJs)?.[1];

    expect(declared).toBeDefined();
    expect(declared).toBe(SITE_URL);
  });

  /**
   * Everything js-dos.html asks its own origin for has to be something the
   * player origin answers — PLAYER_PATHS, the whole of what app.ts serves
   * there. A file added to the page and not to the list works on this
   * origin, where everything in public/ is served, and 404s on the one the
   * player is meant to run on.
   */
  it("asks its own origin only for what the player origin serves", () => {
    const own = [...html.matchAll(/\b(?:src|href)\s*=\s*"([^"]+)"/gi)]
      .map((match) => match[1]!)
      // Off-site addresses are the CDN's; a fragment is the page's own SVG.
      .filter((target) => target.startsWith("/") && !target.startsWith("//"))
      .map((target) => target.split(/[?#]/)[0]!);

    expect(own.length).toBeGreaterThan(0);
    expect(own.filter((target) => !PLAYER_PATHS.includes(target))).toEqual([]);
  });

  it("lists only files that exist", () => {
    for (const address of PLAYER_PATHS) {
      expect(existsSync(path.join(PUBLIC_DIR, address)), address).toBe(true);
    }
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
   * The 512x512 beside it is not a resampled copy, which the artwork could
   * not take: it is pixel art and utils/site.ts scales it by whole numbers on
   * purpose — 360 is 2x the 180x180 original, and 512 would be 2.84x and
   * would arrive blurred. /images/icon-512-maskable.png is the same 360 mark
   * padded out to 512 with the manifest's own background colour, so not a
   * pixel of it is resampled, and the padding is what the entry is for (see
   * the maskable check below).
   */
  it("carries an icon large enough for the install prompt", () => {
    const largest = Math.max(
      ...manifest.icons.map((icon: { sizes: string }) =>
        Number(icon.sizes.split("x")[0]),
      ),
    );

    expect(largest).toBeGreaterThanOrEqual(192);
  });

  /**
   * Android crops a launcher icon to whatever shape the device uses — a
   * circle, a squircle, a rounded square. An icon declared "any" is placed
   * inside that shape untouched, which leaves it floating in a white or grey
   * plate; one declared "maskable" is scaled to fill it and cropped, and the
   * platform guarantees only the middle 80% survives.
   *
   * So the two purposes want different artwork and the manifest has to offer
   * both. The maskable copy is the logo on its own background with the
   * remaining 20% as padding, so the crop takes padding rather than the mark.
   */
  it("offers a maskable icon as well as a plain one", () => {
    const purposes = manifest.icons.map(
      (icon: { purpose?: string }) => icon.purpose,
    );

    expect(purposes).toContain("any");
    expect(purposes).toContain("maskable");
  });

  it("gives the maskable icon room for the crop", () => {
    const maskable = manifest.icons.find(
      (icon: { purpose?: string }) => icon.purpose === "maskable",
    );

    expect(maskable).toBeDefined();

    // At least 512, because the safe area is 80% of the box: a maskable icon
    // smaller than this has no room to pad the mark and still be sharp.
    expect(Number(maskable.sizes.split("x")[0])).toBeGreaterThanOrEqual(512);
    // Its own file, not the "any" icon declared twice — an unpadded mark
    // declared maskable is the cropped-logo bug this is about.
    const plain = manifest.icons.filter(
      (icon: { purpose?: string }) => icon.purpose === "any",
    );

    expect(plain.map((icon: { src: string }) => icon.src)).not.toContain(
      maskable.src,
    );
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
