import { describe, expect, it } from "vitest";
import { firstQueryValue } from "../../utils/query.ts";

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
