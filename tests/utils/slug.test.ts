import { describe, expect, it, vi } from "vitest";
import { slugSharesBase, slugify, withResolvedSlug } from "../../utils/slug";

/**
 * models/game.ts and models/news.ts each carried a copy of this, and neither
 * folded diacritics: the [a-z0-9] filter dropped the accented letter along
 * with the accent, so a title lost characters out of the middle of its own
 * words on the way to becoming an address.
 */
describe("slugify", () => {
  it("keeps the behaviour the two copies already had", () => {
    expect(slugify("Test Game")).toBe("test-game");
    expect(slugify("Super Mario Bros.")).toBe("super-mario-bros");
    expect(slugify("Game with Special Characters!@#")).toBe(
      "game-with-special-characters",
    );
    expect(slugify("Multiple   Spaces")).toBe("multiple-spaces");
    expect(slugify("-Leading and Trailing-")).toBe("leading-and-trailing");
    expect(slugify("Zork I: The Great Underground Empire")).toBe(
      "zork-i-the-great-underground-empire",
    );
  });

  // "Pokémon" used to slug to "pok-mon" and "Café" to "caf" — an address that
  // names neither the game nor anything a reader would type or link to.
  it("folds a diacritic onto the letter it decorates", () => {
    expect(slugify("Pokémon Café")).toBe("pokemon-cafe");
    expect(slugify("Où est Carmen")).toBe("ou-est-carmen");
    expect(slugify("Ñu")).toBe("nu");
    expect(slugify("Łódź Rally")).toBe("lodz-rally");
  });

  // NFD cannot take these apart: they are letters in their own right rather
  // than a base letter plus a combining mark, so a table is the only way.
  it("transliterates the letters decomposition cannot reach", () => {
    expect(slugify("Große Reise")).toBe("grosse-reise");
    expect(slugify("Ærø")).toBe("aero");
    expect(slugify("Þing")).toBe("thing");
  });

  // The callers supply their own base ("game", "news") for this, and
  // resolveSlug then numbers the collisions.
  it("returns an empty string when nothing ASCII-able is left", () => {
    expect(slugify("日本語ゲーム")).toBe("");
    expect(slugify("   ")).toBe("");
    expect(slugify("")).toBe("");
  });

  // One pass over the marks, so a letter carrying two of them still folds.
  it("folds a letter carrying more than one mark", () => {
    expect(slugify("Ệ")).toBe("e");
  });
});

/**
 * resolveSlug asks which slugs are taken and the write then claims one, with
 * nothing holding the gap. Two saves of the same title arriving together both
 * read "doom" as free, and Postgres refused the second on the UNIQUE
 * constraint — the 500 page, with the admin's entry gone. The losing save
 * re-resolves and tries again, which works because by the time it hears about
 * the collision the winner has committed and its slug is in the history table.
 */
describe("withResolvedSlug", () => {
  const collision = (constraint: string) =>
    Object.assign(new Error("duplicate key value"), {
      code: "23505",
      constraint,
    });

  it("returns the value when the write succeeds first time", async () => {
    const write = vi.fn().mockResolvedValue("ok");

    await expect(withResolvedSlug(["games_slug_key"], write)).resolves.toBe(
      "ok",
    );
    expect(write).toHaveBeenCalledTimes(1);
  });

  // The point of the retry: the second attempt re-resolves and gets the next
  // free suffix, so the save that lost the race still completes.
  it("retries a collision on a named constraint until it succeeds", async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(collision("games_slug_key"))
      .mockResolvedValue("doom-2");

    await expect(withResolvedSlug(["games_slug_key"], write)).resolves.toBe(
      "doom-2",
    );
    expect(write).toHaveBeenCalledTimes(2);
  });

  /**
   * A unique violation on anything else is a real error. Retrying on the
   * SQLSTATE alone would have run the same failing write five times and then
   * reported it, which turns one clear error into a slower, stranger one.
   */
  it("rethrows a unique violation on a constraint it was not given", async () => {
    const error = collision("ratings_gameId_voterId_key");
    const write = vi.fn().mockRejectedValue(error);

    await expect(withResolvedSlug(["games_slug_key"], write)).rejects.toBe(
      error,
    );
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("rethrows an error that is not a unique violation", async () => {
    const error = Object.assign(new Error("connection terminated"), {
      code: "57P01",
    });
    const write = vi.fn().mockRejectedValue(error);

    await expect(withResolvedSlug(["games_slug_key"], write)).rejects.toBe(
      error,
    );
    expect(write).toHaveBeenCalledTimes(1);
  });

  // The bound exists to stop an infinite loop, not to give up on real work:
  // a save that loses five races in a row is not a race any more.
  it("gives up rather than looping forever", async () => {
    const error = collision("games_slug_key");
    const write = vi.fn().mockRejectedValue(error);

    await expect(withResolvedSlug(["games_slug_key"], write)).rejects.toBe(
      error,
    );
    expect(write).toHaveBeenCalledTimes(5);
  });

  // Nothing here inspects a thrown string or null, and a model that manages
  // to throw one should not have that turned into five attempts.
  it("rethrows a non-object rejection", async () => {
    const write = vi.fn().mockRejectedValue("nope");

    await expect(withResolvedSlug(["games_slug_key"], write)).rejects.toBe(
      "nope",
    );
    expect(write).toHaveBeenCalledTimes(1);
  });
});

/**
 * Whether a saved game keeps its address — see Game.resolveSlugForUpdate.
 * An edit that leaves the title alone used to re-resolve the slug and could
 * move the game to a shorter one that had freed up in the meantime.
 */
describe("slugSharesBase", () => {
  it("matches the base itself", () => {
    expect(slugSharesBase("doom", "doom")).toBe(true);
  });

  it("matches the base with a collision suffix", () => {
    expect(slugSharesBase("doom-2", "doom")).toBe(true);
    expect(slugSharesBase("doom-17", "doom")).toBe(true);
  });

  it("does not treat a different word as a suffix", () => {
    expect(slugSharesBase("doom-ii", "doom")).toBe(false);
    expect(slugSharesBase("doom-2-hell", "doom")).toBe(false);
  });

  it("does not match a base that merely starts the same", () => {
    expect(slugSharesBase("doomsday", "doom")).toBe(false);
    expect(slugSharesBase("doom", "doom-2")).toBe(false);
  });

  it("refuses a zero or zero-padded suffix, which resolveSlug never issues", () => {
    expect(slugSharesBase("doom-0", "doom")).toBe(false);
    expect(slugSharesBase("doom-02", "doom")).toBe(false);
  });
});
