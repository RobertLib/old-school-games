import { describe, expect, it } from "vitest";
import { SITE_URL, absoluteUrl } from "../../utils/site.ts";

/**
 * A cover may be stored as a path on this site (validations/games.ts accepts
 * one). That is fine for an <img> and useless for og:image, twitter:image and
 * the JSON-LD, which are read by consumers that do not resolve it.
 */
describe("absoluteUrl", () => {
  it("resolves a path on this site against the canonical origin", () => {
    expect(absoluteUrl("/images/doom.png")).toBe(`${SITE_URL}/images/doom.png`);
  });

  it("leaves an absolute address as it is", () => {
    const cover = "https://media.example/doom%20cover.png";

    expect(absoluteUrl(cover)).toBe(cover);
  });

  // A page render is not the place to fail over a malformed artwork address.
  it("hands back a value it cannot parse rather than throwing", () => {
    expect(absoluteUrl("https://exa mple.com/x.png")).toBe(
      "https://exa mple.com/x.png",
    );
  });
});
