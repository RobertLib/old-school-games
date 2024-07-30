import { describe, expect, it } from "vitest";
import { firstQueryValue, rawQuery } from "../../utils/query.ts";

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
