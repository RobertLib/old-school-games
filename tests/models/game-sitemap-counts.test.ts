import { beforeEach, describe, expect, it } from "vitest";
import pool from "../../db.ts";
import Game from "../../models/game.ts";

/**
 * getSitemapCounts replaces several hundred count() calls with one GROUP BY,
 * so the only thing worth testing is that it still answers the same numbers.
 * Each case seeds a catalogue and compares the aggregate against the count()
 * the sitemap used to make for that exact filter — against a real Postgres,
 * because the mocked Game suite can only inspect the SQL it built.
 */
describe("Game.getSitemapCounts", () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM "ratings"');
    await pool.query('DELETE FROM "comments"');
    await pool.query('DELETE FROM "game_of_the_week"');
    await pool.query('DELETE FROM "plays"');
    await pool.query('DELETE FROM "games"');
  });

  const create = (title: string, extra: Record<string, unknown> = {}) =>
    Game.create({ title, genre: "ACTION", ...extra });

  it("agrees with count() for every letter, genre, developer, publisher and year", async () => {
    await create("Doom", {
      developer: "id Software",
      publisher: "GT Interactive",
      release: 1993,
    });
    await create("Doom II", {
      developer: "id Software",
      publisher: "GT Interactive",
      release: 1994,
    });
    // No publisher recorded, so this one is credited to its developer — the
    // OR branch count() builds for a publisher filter.
    await create("Quake", { developer: "id Software", release: 1996 });
    await create("Alone in the Dark", {
      developer: "Infogrames",
      publisher: "Infogrames",
      release: 1992,
    });

    const { counts } = await Game.getSitemapCounts();

    for (const letter of ["a", "d", "q", "z"]) {
      expect(counts.get(`letter:${letter}`) ?? 0).toBe(
        await Game.count({ letter }),
      );
    }

    expect(counts.get("genre:ACTION") ?? 0).toBe(
      await Game.count({ genre: "action" }),
    );

    for (const developer of ["id Software", "Infogrames"]) {
      expect(counts.get(`developer:${developer}`) ?? 0).toBe(
        await Game.count({ developer }),
      );
    }

    // "id Software" published nothing, but Quake has no publisher of its own,
    // so the publisher page for the studio has to list it.
    for (const publisher of ["GT Interactive", "Infogrames", "id Software"]) {
      expect(counts.get(`publisher:${publisher}`) ?? 0).toBe(
        await Game.count({ publisher }),
      );
    }

    for (const year of [1992, 1993, 1994, 1996]) {
      expect(counts.get(`year:${year}`) ?? 0).toBe(await Game.count({ year }));
    }
  });

  it("reports nothing for an empty catalogue", async () => {
    await expect(Game.getSitemapCounts()).resolves.toEqual({
      counts: new Map(),
      lastmods: new Map(),
    });
  });

  it("leaves out games with no developer, publisher or release year", async () => {
    await create("Nameless");

    const { counts } = await Game.getSitemapCounts();

    expect(counts.get("letter:n")).toBe(1);
    expect(counts.get("genre:ACTION")).toBe(1);
    expect([...counts.keys()].filter((k) => k.startsWith("year:"))).toEqual([]);
    expect(
      [...counts.keys()].filter((k) => k.startsWith("publisher:")),
    ).toEqual([]);
  });
});
