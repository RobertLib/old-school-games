import { describe, expect, it } from "vitest";
import {
  SITE_URL,
  absoluteUrl,
  parseCanonicalHost,
  parseMediaOrigin,
} from "../../utils/site.ts";

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

/**
 * CANONICAL_HOST, which every canonical, sitemap entry and the production
 * host redirect are built from. Taken as written, a capital in it looped the
 * redirect forever — a browser sends the Host in lower case — and an empty
 * value made the site's own address "https://".
 */
describe("parseCanonicalHost", () => {
  it.each([undefined, "", "   "])("reads %o as the default", (value) => {
    expect(parseCanonicalHost(value)).toBe("oldschoolgames.eu");
  });

  it.each([
    ["oldschoolgames.eu", "oldschoolgames.eu"],
    ["OldSchoolGames.EU", "oldschoolgames.eu"],
    [" old-school-games.fly.dev ", "old-school-games.fly.dev"],
    ["localhost:3000", "localhost:3000"],
  ])("reads %o as the host a browser sends, %o", (value, host) => {
    expect(parseCanonicalHost(value)).toBe(host);
  });

  it.each([
    "https://oldschoolgames.eu",
    "oldschoolgames.eu/",
    "oldschoolgames.eu/games",
    "oldschoolgames.eu?x=1",
    "admin@oldschoolgames.eu",
    "old school games.eu",
  ])("refuses %o at boot", (value) => {
    expect(() => parseCanonicalHost(value)).toThrow(/CANONICAL_HOST/);
  });
});

/**
 * MEDIA_ORIGIN, which the policy's img-src and connect-src name and every
 * artwork and bundle address is checked against. An empty one left both
 * directives with nothing after 'self', so every cover and game was refused
 * in the browser and nowhere else.
 */
describe("parseMediaOrigin", () => {
  it.each([undefined, "", "   "])("reads %o as the default bucket", (value) => {
    expect(parseMediaOrigin(value)).toBe(
      "https://trwglibsccninuamefls.supabase.co",
    );
  });

  it.each([
    ["https://media.example.com", "https://media.example.com"],
    // The origin a browser compares against, whatever the variable spelled.
    ["https://Media.Example.com/", "https://media.example.com"],
    [" http://localhost:9000 ", "http://localhost:9000"],
  ])("reads %o as the origin %o", (value, origin) => {
    expect(parseMediaOrigin(value)).toBe(origin);
  });

  it.each([
    "media.example.com",
    "ftp://media.example.com",
    "https://media.example.com/assets",
    "https://media.example.com?x=1",
    "https://user:pw@media.example.com",
    "https://media.example.com/#top",
  ])("refuses %o at boot", (value) => {
    expect(() => parseMediaOrigin(value)).toThrow(/MEDIA_ORIGIN/);
  });
});
