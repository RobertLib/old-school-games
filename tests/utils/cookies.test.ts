import { describe, expect, it } from "vitest";
import { readCookie } from "../../utils/cookies.ts";

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
