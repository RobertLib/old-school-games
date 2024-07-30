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

/**
 * Focus indicators that were removed and never replaced.
 *
 * `outline: none` is the single most common way a site becomes unusable from
 * a keyboard: the rule is written to tidy up a mouse click and it takes the
 * only "you are here" marker with it. Three of them were doing exactly that
 * — the heart on every game card, the form fields, and the stars in
 * public/css/rating-stars.css, which also dropped its scale-up under
 * prefers-reduced-motion and so left nothing at all.
 *
 * Suppressing the outline is still allowed; suppressing it with nothing in
 * its place is not, so each rule that does it has to put back a ring of its
 * own.
 */
describe("focus indicators", () => {
  const ratingStars = readFileSync(
    path.resolve(__dirname, "../public/css/rating-stars.css"),
    "utf-8",
  );

  function ruleFor(source: string, selector: string) {
    const match = source.match(
      new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^{}]*\\{([^}]*)\\}`),
    );

    return match?.[1];
  }

  it("draws a ring on the favourite button instead of hiding one", () => {
    expect(stylesheet).not.toMatch(/\.favorite-btn:focus\s*\{[^}]*outline:\s*none/);

    const rule = ruleFor(stylesheet, ".favorite-btn:focus-visible");

    expect(rule).toBeDefined();
    expect(rule).toMatch(/outline:\s*\d+px\s+solid/);
  });

  it("replaces the form field's outline with a visible ring", () => {
    const rule = ruleFor(stylesheet, ".form-control:focus-visible");

    expect(rule).toBeDefined();
    expect(rule).toMatch(/box-shadow:\s*0 0 0 2px/);
  });

  it("keeps a real outline on a star", () => {
    const rule = ruleFor(ratingStars, ".star:focus-visible");

    expect(rule).toMatch(/outline:\s*\d+px\s+solid/);
    expect(rule).not.toMatch(/outline:\s*none/);
  });

  // The scale-up is motion and goes; the ring is not and stays. Dropping
  // both left a keyboard visitor with no indication at all.
  it("keeps it under reduced motion, where it is the only one left", () => {
    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\}/.exec(
      ratingStars,
    )?.[1];

    expect(block).toBeDefined();
    expect(block).toMatch(/outline:\s*\d+px\s+solid/);
    expect(block).not.toMatch(/outline:\s*none/);
  });

  it("gives the skip link a ring of its own once it is on screen", () => {
    const rule = ruleFor(stylesheet, ".skip-link:focus,\n.skip-link:focus-visible");

    expect(rule).toBeDefined();
    expect(rule).toMatch(/outline:\s*\d+px\s+solid/);
  });
});

/**
 * The link is only useful if it is out of the way until it is wanted, and
 * only reachable if "out of the way" is not `display: none` — which takes it
 * out of the tab order, which is the one thing it has to stay in.
 */
describe("style.css — the skip link", () => {
  const rule = stylesheet.match(/\n\.skip-link \{([^}]*)\}/)?.[1];

  it("exists", () => {
    expect(rule).toBeDefined();
  });

  it("is moved off screen rather than hidden", () => {
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/top:\s*-\d+px/);
    expect(rule).not.toMatch(/display:\s*none/);
    expect(rule).not.toMatch(/visibility:\s*hidden/);
  });

  it("comes back on focus", () => {
    const focused = stylesheet.match(
      /\.skip-link:focus,\n\.skip-link:focus-visible \{([^}]*)\}/,
    )?.[1];

    expect(focused).toMatch(/top:\s*\d+px/);
  });
});

/**
 * `line-clamp` on its own clamps nothing in any shipping browser — the
 * property that does the work is still the -webkit- prefixed one, and it was
 * missing, so the homepage's news teasers were not truncated at all. The
 * rule was also written twice, which is how one copy came to be missing it.
 */
describe("style.css — the news teaser clamp", () => {
  const rules = [
    ...stylesheet.matchAll(/\n\.news-content-preview \{([^}]*)\}/g),
  ];

  it("is declared exactly once", () => {
    expect(rules).toHaveLength(1);
  });

  it("clamps with the property that works, and the standard one too", () => {
    expect(rules[0][1]).toMatch(/-webkit-line-clamp:\s*3;/);
    expect(rules[0][1]).toMatch(/[^-]line-clamp:\s*3;/);
    expect(rules[0][1]).toMatch(/-webkit-box-orient:\s*vertical/);
  });
});

/**
 * WCAG 2.5.8: a target smaller than 24 x 24 CSS pixels is one most people
 * cannot hit on a phone. The carousel dots were 10px squares, which is also
 * why the dot itself is now drawn by ::before — the target grew, the dot did
 * not.
 */
describe("style.css — target sizes", () => {
  function sizeOf(selector: string) {
    const body = stylesheet.match(
      new RegExp(`\\${selector} \\{([^}]*)\\}`),
    )?.[1];

    const number = (property: string) =>
      Number(new RegExp(`${property}:\\s*(\\d+)px`).exec(body ?? "")?.[1]);

    return { width: number("width"), height: number("height"), body };
  }

  it("gives the carousel dot a 24px box", () => {
    const { width, height, body } = sizeOf(".carousel-indicator");

    expect(width).toBeGreaterThanOrEqual(24);
    expect(height).toBeGreaterThanOrEqual(24);
    expect(body).toMatch(/padding:\s*\d+px/);
  });

  it("keeps the dot itself the size it always was", () => {
    const { width, height } = sizeOf(".carousel-indicator::before");

    expect(width).toBe(10);
    expect(height).toBe(10);
  });
});

/**
 * The three animations that had no reduced-motion guard: the flash message
 * sliding in, the heart bursting, and the description box animating its own
 * height open.
 */
describe("style.css — motion the visitor has asked not to see", () => {
  const guarded = [
    ...stylesheet.matchAll(
      /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g,
    ),
  ]
    .map((match) => match[1])
    .join("\n");

  it.each([".alert", ".favorite-btn.animate"])(
    "turns off the animation on %s",
    (selector) => {
      expect(guarded).toContain(selector);
    },
  );

  it("turns off the description's height transition", () => {
    expect(guarded).toMatch(/\.description \.description-content \{\s*transition:\s*none/);
  });
});

describe("gallery.css and rating-stars.css — the two sheets served on their own", () => {
  const gallery = readFileSync(
    path.resolve(__dirname, "../public/css/gallery.css"),
    "utf-8",
  );
  const ratingStars = readFileSync(
    path.resolve(__dirname, "../public/css/rating-stars.css"),
    "utf-8",
  );

  /**
   * 100vh is the viewport with a phone's toolbars hidden, which is not the
   * box on screen while they are showing — so the bottom of a full-height
   * overlay sits behind the URL bar, and on this page that bottom strip is
   * the Previous/Next row.
   */
  it("sizes the gallery overlay by the dynamic viewport, with a fallback", () => {
    const rule = gallery.match(/\.gallery-container \{([^}]*)\}/)?.[1];

    expect(rule).toMatch(/height:\s*100vh;/);
    expect(rule).toMatch(/height:\s*100dvh;/);
    // The fallback first, or it wins in the browsers that understand both.
    expect(rule!.indexOf("100vh")).toBeLessThan(rule!.indexOf("100dvh"));
  });

  /**
   * Custom properties cross a shadow boundary — inheritance does not stop at
   * one — so the component can follow the site's palette instead of freezing
   * one colour. It was `gold`, which sat in the phosphor-green theme looking
   * like a bug.
   */
  it("takes the star colour from the theme", () => {
    const rule = ratingStars.match(/\.stars \{([^}]*)\}/)?.[1];

    expect(rule).toMatch(/color:\s*var\(--nc-title/);
    expect(stylesheet).toMatch(/--nc-title:/);
  });
});
