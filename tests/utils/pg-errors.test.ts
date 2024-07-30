import { describe, expect, it } from "vitest";
import { isMissingGameError } from "../../utils/pg-errors.ts";

/**
 * A game can be deleted while someone still has its page open, so the row a
 * comment, a rating or a play points at may be gone by the time the insert
 * runs. Postgres reports that as a foreign-key violation, which is a 404
 * rather than a server fault — routes/games.ts and routes/comments.ts both
 * decide it here rather than each carrying a copy of the SQLSTATE.
 */
describe("isMissingGameError", () => {
  it("recognises a foreign-key violation", () => {
    expect(isMissingGameError({ code: "23503" })).toBe(true);
    expect(isMissingGameError(Object.assign(new Error("fk"), { code: "23503" })))
      .toBe(true);
  });

  // Anything else is a fault, and answering it with a 404 would hide it.
  it("refuses any other error", () => {
    expect(isMissingGameError({ code: "42P01" })).toBe(false);
    expect(isMissingGameError(new Error("connection refused"))).toBe(false);
  });

  // A rejection need not be an object at all, and null is the value that
  // makes a `typeof === "object"` check on its own throw.
  it("copes with a thrown value that is not an error object", () => {
    expect(isMissingGameError(null)).toBe(false);
    expect(isMissingGameError(undefined)).toBe(false);
    expect(isMissingGameError("23503")).toBe(false);
  });
});
