import { describe, expect, it } from "vitest";
import { isNoindex } from "../../utils/indexability.ts";

describe("isNoindex", () => {
  it("keeps a search, a sort and a direction out of the index", () => {
    expect(isNoindex({ query: { search: "doom" } }, {})).toBe(true);
    expect(isNoindex({ query: { orderBy: "title" } }, {})).toBe(true);
    expect(isNoindex({ query: { orderDir: "ASC" } }, {})).toBe(true);
  });

  it("leaves the unfiltered listing indexable", () => {
    expect(isNoindex({ query: {} }, {})).toBe(false);
    expect(isNoindex({ query: { search: "" } }, {})).toBe(false);
  });

  /**
   * routes/home.ts trims the term before deciding what to render, so
   * "?search=%20%20" is the unfiltered listing — and the robots tag has to
   * say what the page says. It used to answer noindex for the whitespace.
   */
  it("treats a search that is only whitespace as no search", () => {
    expect(isNoindex({ query: { search: "   " } }, {})).toBe(false);
  });

  it("answers for a page that asks for noindex whatever its query", () => {
    expect(isNoindex({ query: {} }, { noindex: true })).toBe(true);
  });

  /**
   * A repeated key arrives as an array, and every route reads the first value
   * of it (firstQueryValue in utils/query.ts). This read the raw value, so
   * "/?search=&search=doom" rendered the plain homepage — the route's search
   * is that empty first value — under "noindex, follow" and with no canonical,
   * and "?orderBy=&orderBy=title" did the same for an unsorted listing.
   */
  it("reads a repeated key the way the routes do, by its first value", () => {
    expect(isNoindex({ query: { search: ["", "doom"] } }, {})).toBe(false);
    expect(isNoindex({ query: { search: ["  ", "doom"] } }, {})).toBe(false);
    expect(isNoindex({ query: { orderBy: ["", "title"] } }, {})).toBe(false);
    expect(isNoindex({ query: { orderDir: ["", "ASC"] } }, {})).toBe(false);
  });

  it("still keeps a repeated key out when its first value is real", () => {
    expect(isNoindex({ query: { search: ["doom", ""] } }, {})).toBe(true);
    expect(isNoindex({ query: { orderBy: ["title", ""] } }, {})).toBe(true);
    expect(isNoindex({ query: { orderDir: ["DESC", "ASC"] } }, {})).toBe(true);
  });
});
