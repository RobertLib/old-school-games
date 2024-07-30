import { beforeEach, describe, expect, it } from "vitest";
import pool from "../../db.ts";
import Game from "../../models/game.ts";

/**
 * The values that used to clear validateGame and then be refused by the
 * column behind it, against a real database.
 *
 * The rest of the Game suite mocks the driver, so a value Postgres will not
 * accept passes every one of those tests — which is exactly how a "release"
 * of "   " reached the INTEGER column and answered the admin with the 500
 * page, their entry gone. validateGame now hands over the value it checked
 * and serialize() blanks anything that is only whitespace; this is what
 * proves the two agree with the schema.
 */
describe("blank values reaching the columns", () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM "ratings"');
    await pool.query('DELETE FROM "comments"');
    await pool.query('DELETE FROM "game_of_the_week"');
    await pool.query('DELETE FROM "plays"');
    await pool.query('DELETE FROM "games"');
  });

  describe("release", () => {
    it("stores a whitespace-only value as NULL", async () => {
      const { id } = await Game.create({
        title: "Blank Release",
        genre: "ACTION",
        release: "   " as unknown as number,
      });

      expect((await Game.findById(id))!.release).toBeNull();
    });

    it("stores an empty value as NULL", async () => {
      const { id } = await Game.create({
        title: "Empty Release",
        genre: "ACTION",
        release: "" as unknown as number,
      });

      expect((await Game.findById(id))!.release).toBeNull();
    });

    it("still stores a real year", async () => {
      const { id } = await Game.create({
        title: "Real Release",
        genre: "ACTION",
        release: "1993" as unknown as number,
      });

      expect((await Game.findById(id))!.release).toBe(1993);
    });

    // The point of the blank case: an edit form that clears the year has to
    // clear the column, not leave the old value behind.
    it("clears a year that was there before", async () => {
      const { id } = await Game.create({
        title: "Cleared Release",
        genre: "ACTION",
        release: "1993" as unknown as number,
      });

      await Game.update(id, {
        title: "Cleared Release",
        genre: "ACTION",
        release: "  " as unknown as number,
      });

      expect((await Game.findById(id))!.release).toBeNull();
    });
  });

  /**
   * GAME_GENRE holds the enum values in upper case, and validateGame accepts
   * a genre by uppercasing it — so "action" passed there and then came back
   * from Postgres as "invalid input value for enum game_genre". The validator
   * writes the uppercased value back now, which is what this checks end to
   * end: the string the form posts is the string the column takes.
   */
  it("takes the genre the validator hands over", async () => {
    const genres = await Game.getGenres();

    expect(genres).toContain("ACTION");

    const { id } = await Game.create({
      title: "Genre Case",
      genre: "ACTION",
    });

    expect((await Game.findById(id))!.genre).toBe("ACTION");
  });
});
