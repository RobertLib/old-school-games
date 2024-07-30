import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const stylesheet = readFileSync(
  path.resolve(__dirname, "../public/css/style.css"),
  "utf-8",
);

describe("style.css — translucent colours", () => {
  it("never mixes space-separated channels with the legacy rgba() comma form", () => {
    // The theme keeps its channels space separated (--border-rgb: 85 255 255),
    // so rgba(var(--border-rgb), 0.12) expands to rgba(85 255 255, 0.12) —
    // invalid syntax, and the browser silently drops the whole declaration.
    // The modern slash form is the one that works: rgb(var(--x) / 0.12).
    const offenders = stylesheet
      .split("\n")
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => /rgba\(\s*var\(/.test(line));

    expect(offenders).toEqual([]);
  });

  it("declares the channel variables without commas, as the slash form needs", () => {
    const match = stylesheet.match(/--border-rgb:\s*([^;]+);/);

    expect(match).not.toBeNull();
    expect(match![1]).not.toContain(",");
  });
});

/**
 * How long the site is willing to show nothing while a font loads.
 *
 * VT323 is the body font, so `font-display: block` — which is what these
 * carried — hid every word on the page for up to three seconds and then fell
 * back. That is the Lighthouse audit "Ensure text remains visible during
 * webfont load", and where the largest element is text it is a Largest
 * Contentful Paint delay outright.
 *
 * `optional` is the setting, and the long comment above the @font-face rules
 * reasons out the choice against `swap` and `fallback`. What this guards is
 * narrower and worth stating on its own: whatever the descriptor says, it must
 * not be one that hides text indefinitely, and it must be stated at all — the
 * initial value if the descriptor is simply dropped is `auto`, which browsers
 * implement as `block`. So deleting the line is the same regression as writing
 * it back.
 */
describe("style.css — webfont loading", () => {
  const faces = [...stylesheet.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(
    (match) => match[1]!,
  );

  it("declares the faces this is about", () => {
    expect(faces.length).toBeGreaterThanOrEqual(2);
  });

  it.each(faces.map((body, i) => [i, body] as const))(
    "@font-face #%i states a font-display",
    (_index, body) => {
      expect(body).toMatch(/font-display:\s*[a-z]+;/);
    },
  );

  it.each(faces.map((body, i) => [i, body] as const))(
    "@font-face #%i does not block on the font",
    (_index, body) => {
      const display = /font-display:\s*([a-z]+);/.exec(body)?.[1];

      expect(display).toBeDefined();
      expect(["optional", "swap", "fallback"]).toContain(display);
    },
  );

  /**
   * `optional` is only defensible because the files are requested at the top
   * of <head> — it gives the font about 100ms and then commits to whatever
   * won, so a face that is not preloaded would simply lose that race on most
   * first visits and render in the fallback.
   */
  it("preloads every face it declares as optional", () => {
    const head = readFileSync(
      path.resolve(__dirname, "../views/head.ejs"),
      "utf-8",
    );

    const optional = faces
      .filter((body) => /font-display:\s*optional;/.test(body))
      .map((body) => /url\(([^)]+)\)/.exec(body)?.[1]?.replace(/["']/g, ""))
      .filter((url): url is string => Boolean(url));

    expect(optional.length).toBeGreaterThan(0);

    for (const url of optional) {
      expect(head, `${url} is not preloaded`).toContain(
        `rel="preload" href="${url}"`,
      );
    }
  });
});

describe("style.css — cropped cover art", () => {
  // Box art is portrait with the title at the top, so every cover-cropped
  // thumbnail has to anchor there; the default centre crop beheads the logo.
  const croppedSelectors = [".continue-playing-image", ".similar-game-image"];

  it.each(croppedSelectors)("%s anchors its crop to the top", (selector) => {
    const rule = stylesheet.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`));

    expect(rule).not.toBeNull();
    expect(rule![1]).toContain("object-fit: cover");
    expect(rule![1]).toMatch(/object-position:\s*top/);
  });

  it("has no cover-cropped rule left without an object-position", () => {
    const offenders = stylesheet
      .split(/(?=^\S[^{]*\{)/m)
      .filter(
        (block) =>
          /object-fit:\s*cover/.test(block) && !/object-position/.test(block),
      )
      .map((block) => block.split("{")[0].trim());

    expect(offenders).toEqual([]);
  });
});

describe("section tints", () => {
  const templates = [...globSync("views/**/*.ejs")];

  it("routes every section fill through the single --panel-tint knob", () => {
    // Otherwise the site drifts back to three dozen slightly different
    // alphas and "make them all quieter" becomes a 30-file edit again.
    const allowed = new Set([
      "views/games/game-gallery.ejs", // button fill, must stay readable
    ]);

    const offenders = templates
      .filter((file) => !allowed.has(file))
      .flatMap((file) =>
        readFileSync(file, "utf-8")
          .split("\n")
          .map((line, i) => ({ file, line: i + 1, text: line }))
          .filter(({ text }) => /background:\s*rgb\(var\(/.test(text)),
      )
      .map(({ file, line }) => `${file}:${line}`);

    expect(offenders).toEqual([]);
  });

  it("defines the knob once, with the tint resolved where themes apply", () => {
    expect(stylesheet).toMatch(/--panel-tint-alpha:\s*[\d.]+;/);
    // On body, which inherits --border-rgb from whichever theme class is on
    // <html>, so the tint follows the active palette rather than freezing the
    // default one.
    const bodyRule = stylesheet.match(/\nbody \{([^}]*)\}/);
    expect(bodyRule![1]).toContain("--panel-tint:");
  });
});

/**
 * Where the theme classes are selected from, which is load-bearing and easy to
 * "tidy" back into a bug.
 *
 * theme-switcher.js is loaded synchronously in <head>, so <body> does not
 * exist when it runs. It therefore writes the theme class to the root element,
 * and these rules have to match that — as "html.theme-…", which also beats the
 * ":root" the default palette is declared on, same element and one class more
 * specific. Selecting them off "body" again would send the class back to an
 * element that cannot be written to until DOMContentLoaded, and every visitor
 * on a non-default theme would see the default palette flash first.
 */
describe("style.css — theme scoping", () => {
  const THEME_CLASSES = ["theme-retro-green", "theme-sunset"];

  it.each(THEME_CLASSES)("scopes .%s to the root element", (themeClass) => {
    expect(stylesheet).toContain(`html.${themeClass} {`);
    expect(stylesheet).not.toContain(`body.${themeClass}`);
  });

  it("declares the default palette on :root so a theme can override it", () => {
    expect(stylesheet).toMatch(/:root \{/);
  });
});

/**
 * What keeps the Content-Security-Policy closed.
 *
 * style-src dropped 'unsafe-inline' once the last four <style> blocks became
 * files (see the directive in app.ts). Nothing about that is self-enforcing:
 * the next <style> somebody writes into a template, a static page or a
 * component's shadow root is refused by the browser and reported nowhere but
 * its console — the page simply renders unstyled, which is precisely the
 * failure mode the inline-<script> check in tests/public-assets.test.ts
 * exists to catch for the other half of the policy.
 *
 * Script is included because the shadow root in rating-stars.js was one of
 * the four: markup built in JavaScript is governed by style-src exactly like
 * markup in a template, and it is the case that looks least like one.
 */
describe("no inline <style> anywhere the policy governs", () => {
  const sources = [
    ...globSync("views/**/*.ejs"),
    ...globSync("public/**/*.html"),
    ...globSync("public/js/*.js"),
  ];

  it("has sources to check", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it.each(sources)("%s opens no <style> element", (file) => {
    const source = readFileSync(file, "utf-8");

    // The closing tag as well, so a block assembled across a template's own
    // conditionals is still caught.
    expect(source).not.toMatch(/<style[\s>]/i);
    expect(source).not.toMatch(/<\/style\s*>/i);
  });
});
