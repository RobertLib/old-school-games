import { describe, expect, it } from "vitest";
import { parseId } from "../../utils/ids.ts";

describe("parseId", () => {
  it("accepts a plain positive integer string", () => {
    expect(parseId("1")).toBe(1);
    expect(parseId("123")).toBe(123);
  });

  it("accepts a positive integer number", () => {
    expect(parseId(42)).toBe(42);
  });

  // parseInt("5abc") is 5, which is how a malformed id used to clear
  // validation and then reach Postgres as a broken integer literal.
  it("rejects a number with trailing rubbish rather than truncating it", () => {
    expect(parseId("5abc")).toBeNull();
    expect(parseId("1 OR 1=1")).toBeNull();
    expect(parseId("1.5")).toBeNull();
    expect(parseId("1e3")).toBeNull();
    expect(parseId(" 1")).toBeNull();
    expect(parseId("+1")).toBeNull();
  });

  it("rejects zero and negatives", () => {
    expect(parseId("0")).toBeNull();
    expect(parseId("-1")).toBeNull();
    expect(parseId(0)).toBeNull();
    expect(parseId(-1)).toBeNull();
  });

  it("rejects anything that is not a string or number", () => {
    expect(parseId(undefined)).toBeNull();
    expect(parseId(null)).toBeNull();
    expect(parseId(["1", "2"])).toBeNull();
    expect(parseId({})).toBeNull();
    expect(parseId("")).toBeNull();
  });

  it("rejects values past the safe integer range", () => {
    expect(parseId("9007199254740993")).toBeNull();
    expect(parseId(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
    expect(parseId(1.5)).toBeNull();
  });

  // The safe-integer range is far wider than an "integer" column. Every id
  // between the two used to pass here and come back from Postgres as "value
  // out of range for type integer" — a 500 where the address simply names no
  // row. "/9999999999" was a 500 on the game page, the comment batch, the
  // rating and play endpoints, /random?not= and the collection JSON.
  it("rejects values past what a Postgres integer column holds", () => {
    expect(parseId("2147483647")).toBe(2147483647);
    expect(parseId(2147483647)).toBe(2147483647);
    expect(parseId("2147483648")).toBeNull();
    expect(parseId(2147483648)).toBeNull();
    expect(parseId("9999999999")).toBeNull();
  });
});
