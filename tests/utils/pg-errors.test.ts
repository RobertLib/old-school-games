import { describe, expect, it } from "vitest";
import {
  COMMENT_CONSTRAINTS,
  isMissingGameError,
  isMissingParentCommentError,
  isUnstorableTextError,
} from "../../utils/pg-errors.ts";

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

  /**
   * The two violations a comment insert can lose a race on share one
   * SQLSTATE, so the constraint name is the only thing that tells them apart —
   * and a reply whose parent a moderator had just deleted was being reported
   * as "Game not found", sending the visitor to look for a page that is fine.
   */
  it("does not claim the game is gone for a vanished parent comment", () => {
    expect(
      isMissingGameError({
        code: "23503",
        constraint: COMMENT_CONSTRAINTS.parent,
      }),
    ).toBe(false);
  });

  it("still recognises the comment's own game key", () => {
    expect(
      isMissingGameError({
        code: "23503",
        constraint: COMMENT_CONSTRAINTS.game,
      }),
    ).toBe(true);
  });

  /**
   * An unnamed violation is read as a missing game, which is what every
   * caller got before constraint names were looked at at all: the other keys
   * reachable from here — "ratings" and "plays" — both point at "games".
   */
  it("reads an unnamed foreign-key violation as a missing game", () => {
    expect(isMissingGameError({ code: "23503" })).toBe(true);
  });
});

describe("isMissingParentCommentError", () => {
  it("recognises the parent key by name", () => {
    expect(
      isMissingParentCommentError({
        code: "23503",
        constraint: COMMENT_CONSTRAINTS.parent,
      }),
    ).toBe(true);
  });

  it.each([
    ["the game key", COMMENT_CONSTRAINTS.game],
    ["no constraint at all", undefined],
  ])("refuses a violation naming %s", (_label, constraint) => {
    expect(isMissingParentCommentError({ code: "23503", constraint })).toBe(
      false,
    );
  });

  it("refuses anything that is not a foreign-key violation", () => {
    expect(
      isMissingParentCommentError({
        code: "23505",
        constraint: COMMENT_CONSTRAINTS.parent,
      }),
    ).toBe(false);
    expect(isMissingParentCommentError(null)).toBe(false);
  });
});

/**
 * A NUL byte, sent as "%00" in a path, a search, a login e-mail or a comment,
 * reaches a bound parameter and Postgres refuses it with 22021. The error has
 * no HTTP status of its own, so app.ts answered 500 and logged a stack trace
 * for a request any anonymous client can repeat — it is the client's input.
 */
describe("isUnstorableTextError", () => {
  it("recognises Postgres refusing a string it cannot store", () => {
    expect(
      isUnstorableTextError({
        code: "22021",
        message: 'invalid byte sequence for encoding "UTF8": 0x00',
      }),
    ).toBe(true);
  });

  it.each([
    ["a foreign-key violation", { code: "23503" }],
    ["an error with no code", new Error("boom")],
    ["nothing at all", null],
    ["a string", "22021"],
  ])("refuses %s", (_label, error) => {
    expect(isUnstorableTextError(error)).toBe(false);
  });
});
