import { describe, expect, it } from "vitest";
import {
  firstQueryValue,
  rawQuery,
  rawQueryWithout,
} from "../../utils/query.ts";

describe("firstQueryValue", () => {
  it("passes a single string through", () => {
    expect(firstQueryValue("action")).toBe("action");
    expect(firstQueryValue("")).toBe("");
  });

  // "?genre=a&genre=b" arrives as an array. Calling .toLowerCase() on it threw,
  // so a repeated key answered with a 500 instead of a page.
  it("takes the first entry of a repeated key", () => {
    expect(firstQueryValue(["a", "b"])).toBe("a");
  });

  it("returns undefined for anything that is not a string", () => {
    expect(firstQueryValue(undefined)).toBeUndefined();
    expect(firstQueryValue(null)).toBeUndefined();
    expect(firstQueryValue({ nested: "object" })).toBeUndefined();
    expect(firstQueryValue([])).toBeUndefined();
    expect(firstQueryValue([{ nested: "object" }])).toBeUndefined();
  });
});

describe("rawQuery", () => {
  it("hands back the query exactly as it arrived", () => {
    expect(rawQuery({ originalUrl: "/action?page=2&orderBy=title" })).toBe(
      "?page=2&orderBy=title",
    );
  });

  it("answers empty when there is no query", () => {
    expect(rawQuery({ originalUrl: "/action" })).toBe("");
    expect(rawQuery({ originalUrl: "/action?" })).toBe("");
  });

  /**
   * A "?" is legal inside a query string. split("?")[1] kept only the text
   * up to the second one, so "/Action?search=who?&page=2" was redirected to
   * "/action?search=who" — a silent rewrite of the visitor's query, which is
   * the one thing these redirects promise not to do.
   */
  it("keeps everything after the first question mark", () => {
    expect(rawQuery({ originalUrl: "/Action?search=who?&page=2" })).toBe(
      "?search=who?&page=2",
    );
  });
});

/**
 * The query a redirect carries over once the parameters the page it lands on
 * does not read are taken out — raw, so what survives is exactly what was
 * sent.
 */
describe("rawQueryWithout", () => {
  const req = (originalUrl: string) => ({ originalUrl });

  it.each([
    ["/action?search=doom", ""],
    ["/action?search=doom&page=2", "?page=2"],
    ["/action?page=2&search=a&search=b&orderBy=title", "?page=2&orderBy=title"],
    // Compared decoded, because that is what reached req.query.
    ["/action?%73earch=doom&page=2", "?page=2"],
    // Kept as it arrived: a key that will not decode is not a 500.
    ["/action?%C3%28=x&search=y", "?%C3%28=x"],
    // The survivors are not re-encoded.
    ["/action?search=x&q=a%20b+c", "?q=a%20b+c"],
    ["/action", ""],
  ])("takes the search out of %s, leaving %o", (url, expected) => {
    expect(rawQueryWithout(req(url), ["search"])).toBe(expected);
  });
});
