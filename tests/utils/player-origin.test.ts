import { describe, expect, it } from "vitest";
import { parsePlayerOrigin } from "../../utils/site.ts";

/**
 * PLAYER_ORIGIN, which moves the DOS player onto an origin of its own — see
 * utils/site.ts for why that is the one arrangement in which the frame's
 * sandbox is a boundary.
 *
 * Tested through the parser rather than by re-importing the module under a
 * different environment: the module reads the variable once, and every other
 * file in this project relies on that.
 */
describe("parsePlayerOrigin", () => {
  const SITE_HOST = "oldschoolgames.eu";

  /**
   * Unset is today's behaviour exactly, and it is the default. An empty value
   * is the same thing said badly — "PLAYER_ORIGIN=" in a .env file, a secret
   * that resolved to nothing — and must not be read as an origin.
   */
  it.each([undefined, "", "   "])("reads %o as no player origin", (value) => {
    expect(parsePlayerOrigin(value, SITE_HOST, true)).toBeNull();
  });

  it("keeps an https origin as it is", () => {
    expect(
      parsePlayerOrigin("https://play.oldschoolgames.eu", SITE_HOST, true),
    ).toBe("https://play.oldschoolgames.eu");
  });

  // What a browser sends and what CSP matches against: lower case, no
  // trailing slash, no default port.
  it("normalises it to the origin a browser would send", () => {
    expect(
      parsePlayerOrigin("HTTPS://Old-School-Games.fly.dev:443/", SITE_HOST, true),
    ).toBe("https://old-school-games.fly.dev");
  });

  it("accepts plain HTTP outside production, for a local second host", () => {
    expect(parsePlayerOrigin("http://127.0.0.1:3000", "localhost:3000", false)).toBe(
      "http://127.0.0.1:3000",
    );
  });

  /**
   * A browser refuses an http: frame inside an https: page as mixed content,
   * so a production player on plain HTTP would simply never load — which is
   * better refused at boot than found by a visitor.
   */
  it("refuses plain HTTP in production", () => {
    expect(() =>
      parsePlayerOrigin("http://play.oldschoolgames.eu", SITE_HOST, true),
    ).toThrow(/https in production/);
  });

  /**
   * The value names where the player's own files are served from and is
   * compared against the Host header; a path, a query or credentials in it
   * would be silently dropped, and the operator would have meant something
   * the app is not doing.
   */
  it.each([
    "https://play.example.com/player",
    "https://play.example.com/?x=1",
    "https://play.example.com/#top",
    "https://user:secret@play.example.com",
  ])("refuses %s, which is more than an origin", (value) => {
    expect(() => parsePlayerOrigin(value, SITE_HOST, true)).toThrow(
      /origin alone/,
    );
  });

  it.each(["play.example.com", "not a url"])(
    "refuses %o, which is not an absolute URL",
    (value) => {
      expect(() => parsePlayerOrigin(value, SITE_HOST, true)).toThrow(
        /absolute URL/,
      );
    },
  );

  it.each(["ftp://play.example.com", "javascript:alert(1)"])(
    "refuses %s, which is not http(s)",
    (value) => {
      expect(() => parsePlayerOrigin(value, SITE_HOST, true)).toThrow(
        /http\(s\)/,
      );
    },
  );

  /**
   * The failure that takes the whole site down: app.ts answers a request
   * addressed to the player's host with the player's files or a 404, so
   * naming the site's own host here would do that to every page on it.
   */
  it.each([
    ["https://oldschoolgames.eu", "oldschoolgames.eu"],
    ["https://OldSchoolGames.eu", "oldschoolgames.eu"],
    ["https://oldschoolgames.eu", "OldSchoolGames.eu"],
    ["http://localhost:3000", "localhost:3000"],
  ])("refuses %s when the site itself is %s", (value, siteHost) => {
    expect(() => parsePlayerOrigin(value, siteHost, false)).toThrow(
      /own host/,
    );
  });
});
