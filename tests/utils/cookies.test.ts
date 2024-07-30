import { describe, expect, it } from "vitest";
import { readCookie, readCookies } from "../../utils/cookies.ts";

describe("readCookie", () => {
  it("reads a named cookie out of the header", () => {
    expect(readCookie("osg_vid=abc; other=1", "osg_vid")).toBe("abc");
    expect(readCookie("other=1; osg_vid=abc", "osg_vid")).toBe("abc");
  });

  it("decodes percent-encoded values", () => {
    expect(readCookie("name=a%20b", "name")).toBe("a b");
  });

  // decodeURIComponent throws on a stray "%". Both callers run on every
  // request, so one mangled cookie used to answer every page with a 500 —
  // and the cookie stayed put, leaving the visitor stuck there.
  it("returns null for a value it cannot decode, rather than throwing", () => {
    expect(readCookie("osg_csrf=%ZZ", "osg_csrf")).toBeNull();
    expect(readCookie("osg_csrf=%", "osg_csrf")).toBeNull();
    expect(readCookie("osg_csrf=%E0%A4%A", "osg_csrf")).toBeNull();
  });

  it("keeps reading later cookies when an earlier one is undecodable", () => {
    expect(readCookie("bad=%ZZ; good=fine", "good")).toBe("fine");
  });

  it("returns null when the header or the cookie is absent", () => {
    expect(readCookie(undefined, "osg_vid")).toBeNull();
    expect(readCookie("other=1", "osg_vid")).toBeNull();
    expect(readCookie("", "osg_vid")).toBeNull();
    expect(readCookie("novalue", "novalue")).toBeNull();
  });
});

/**
 * Two cookies of one name arrive when they were set with different Domain or
 * Path attributes — which code on a sibling subdomain can do for any name
 * that is not "__Host-" prefixed. The callers that care need every value,
 * not whichever one the browser happened to put first.
 */
describe("readCookies", () => {
  it("returns every value under the name, in the order sent", () => {
    expect(readCookies("a=1; osg_vid=x; b=2; osg_vid=y", "osg_vid")).toEqual([
      "x",
      "y",
    ]);
  });

  it("skips a value it cannot decode and keeps the rest", () => {
    expect(readCookies("name=%ZZ; name=a%20b", "name")).toEqual(["a b"]);
  });

  it("returns nothing when the header or the cookie is absent", () => {
    expect(readCookies(undefined, "osg_vid")).toEqual([]);
    expect(readCookies("", "osg_vid")).toEqual([]);
    expect(readCookies("other=1", "osg_vid")).toEqual([]);
  });

  it("does not match a name that only starts the same", () => {
    expect(readCookies("osg_vid2=x; xosg_vid=y", "osg_vid")).toEqual([]);
  });
});
