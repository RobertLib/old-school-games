import { beforeEach, describe, expect, it } from "vitest";
import pool from "../../db.ts";
import Game from "../../models/game.ts";

/**
 * Slug handling against a real database.
 *
 * The rest of the Game suite mocks the driver, so the statements that write a
 * game and its slug history together in one shot are never actually executed
 * there — and a CTE that does not parse would pass every one of those tests.
 */
describe("Game slugs", () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM "ratings"');
    await pool.query('DELETE FROM "comments"');
    await pool.query('DELETE FROM "game_of_the_week"');
    await pool.query('DELETE FROM "plays"');
    await pool.query('DELETE FROM "games"');
  });

  const create = (title: string) => Game.create({ title, genre: "ACTION" });

  /**
   * Two saves of the same title at the same moment.
   *
   * resolveSlug reads the history and the INSERT then claims a slug, and
   * nothing holds the gap between them — so both of these read "doom" as free
   * and the loser hit the UNIQUE constraint on "games"."slug". That surfaced
   * as the 500 page with the admin's entry thrown away, which is exactly the
   * failure the slug-history table was added to prevent for the sequential
   * case. withResolvedSlug re-resolves and retries, and by then the winner has
   * committed, so the second one takes "doom-2".
   *
   * Against a real database rather than a mocked driver, because what is being
   * tested is the constraint firing and the retry finding a different answer
   * the second time round — neither of which a stubbed pool would do.
   */
  it("gives both of two simultaneous saves of one title a slug", async () => {
    const results = await Promise.all([create("Doom"), create("Doom")]);

    const slugs = (
      await Promise.all(results.map(({ id }) => Game.findById(id)))
    ).map((game) => game?.slug);

    expect(new Set(slugs).size).toBe(2);
    expect([...slugs].sort()).toEqual(["doom", "doom-2"]);
  });

  // The same race on a rename, which takes the same path through update().
  it("gives both of two simultaneous renames to one title a slug", async () => {
    const [first, second] = await Promise.all([
      create("Quake"),
      create("Hexen"),
    ]);

    await Promise.all([
      Game.update(first!.id, { title: "Strife", genre: "ACTION" }),
      Game.update(second!.id, { title: "Strife", genre: "ACTION" }),
    ]);

    const slugs = (
      await Promise.all([Game.findById(first!.id), Game.findById(second!.id)])
    ).map((game) => game?.slug);

    expect(new Set(slugs).size).toBe(2);
    expect([...slugs].sort()).toEqual(["strife", "strife-2"]);
  });

  it("should slug a new game from its title", async () => {
    const { id } = await create("The Secret of Monkey Island");
    const game = await Game.findById(id);

    expect(game?.slug).toBe("the-secret-of-monkey-island");
  });

  // The fold lives in utils/slug.ts, which news shares. Without it the
  // [a-z0-9] filter dropped the accented letter along with its accent, so an
  // accented title lost characters out of the middle of its own words:
  // "Pokémon" was stored, advertised and linked as "pok-mon".
  it("should fold a diacritic instead of dropping the letter", async () => {
    const { id } = await create("Pokémon Café");

    expect((await Game.findById(id))?.slug).toBe("pokemon-cafe");
  });

  // Nothing ASCII-able is left, so resolveSlug falls back to its own base and
  // then numbers the collisions like any other repeated title.
  it("should fall back to a base when the title folds to nothing", async () => {
    const first = await create("日本語ゲーム");
    const second = await create("ゲームその二");

    expect((await Game.findById(first.id))?.slug).toBe("game");
    expect((await Game.findById(second.id))?.slug).toBe("game-2");
  });

  // Two games sharing a title used to collide on the UNIQUE constraint and
  // fail the second save with a 500.
  it("should give games with the same title distinct slugs", async () => {
    const first = await create("Prince of Persia");
    const second = await create("Prince of Persia");
    const third = await create("Prince of Persia");

    const slugs = await Promise.all(
      [first, second, third].map(async ({ id }) => (await Game.findById(id))!.slug),
    );

    expect(slugs).toEqual([
      "prince-of-persia",
      "prince-of-persia-2",
      "prince-of-persia-3",
    ]);
  });

  it("should record the slug in the history when a game is created", async () => {
    const { id } = await create("Doom");

    expect(await Game.findCurrentSlug("doom")).toBe("doom");

    const { rows } = await pool.query(
      'SELECT "slug" FROM "game_slugs" WHERE "gameId" = $1',
      [id],
    );
    expect(rows).toEqual([{ slug: "doom" }]);
  });

  // Renaming used to rewrite the slug in place: the published URL 404'd and
  // took its search ranking with it.
  it("should keep the old address pointing at a renamed game", async () => {
    const { id } = await create("Doom 2");

    await Game.update(id, { title: "Doom II", genre: "ACTION" });

    expect((await Game.findById(id))?.slug).toBe("doom-ii");
    expect(await Game.findBySlug("doom-2")).toBeNull();
    expect(await Game.findCurrentSlug("doom-2")).toBe("doom-ii");
  });

  it("should follow a chain of renames back to the current address", async () => {
    const { id } = await create("First");

    await Game.update(id, { title: "Second", genre: "ACTION" });
    await Game.update(id, { title: "Third", genre: "ACTION" });

    expect(await Game.findCurrentSlug("first")).toBe("third");
    expect(await Game.findCurrentSlug("second")).toBe("third");
  });

  it("should let a game take back a slug it used before", async () => {
    const { id } = await create("Original");

    await Game.update(id, { title: "Renamed", genre: "ACTION" });
    await Game.update(id, { title: "Original", genre: "ACTION" });

    expect((await Game.findById(id))?.slug).toBe("original");
  });

  it("should not hand a retired slug to a different game", async () => {
    const { id } = await create("Wolfenstein");
    await Game.update(id, { title: "Wolfenstein 3D", genre: "ACTION" });

    const other = await create("Wolfenstein");

    expect((await Game.findById(other.id))?.slug).toBe("wolfenstein-2");
    expect(await Game.findCurrentSlug("wolfenstein")).toBe("wolfenstein-3d");
  });

  it("should forget the history of a deleted game", async () => {
    const { id } = await create("Transient");

    await Game.delete(id);

    expect(await Game.findCurrentSlug("transient")).toBeNull();
  });

  it("should leave unmentioned columns alone on a partial update", async () => {
    const { id } = await create("Keeper");
    await Game.update(id, {
      title: "Keeper",
      genre: "ACTION",
      developer: "Bullfrog",
      description: "<p>A description</p>",
    });

    await Game.update(id, { title: "Keeper Renamed", genre: "ACTION" });

    const game = await Game.findById(id);
    expect(game?.developer).toBe("Bullfrog");
    expect(game?.description).toBe("<p>A description</p>");
  });

  // update() used to re-resolve the slug on every save. Once the game that
  // held the shorter address was gone, an edit to any field at all moved this
  // one onto it — and its canonical URL, sitemap entry and feed item with it.
  it("keeps its slug when an unrelated field is edited", async () => {
    const first = await create("Doom");
    const second = await create("Doom");

    expect((await Game.findById(second.id))?.slug).toBe("doom-2");

    await Game.delete(first.id);
    await Game.update(second.id, {
      title: "Doom",
      genre: "ACTION",
      description: "<p>Typo fixed.</p>",
    });

    expect((await Game.findById(second.id))?.slug).toBe("doom-2");
  });

  it("keeps its slug when only the title's case changes", async () => {
    await create("Doom");
    const { id } = await create("Doom");

    await Game.update(id, { title: "DOOM", genre: "ACTION" });

    expect((await Game.findById(id))?.slug).toBe("doom-2");
  });

  it("still moves to a new slug when the title really changes", async () => {
    const { id } = await create("Doom");

    await Game.update(id, { title: "Doom II", genre: "ACTION" });

    expect((await Game.findById(id))?.slug).toBe("doom-ii");
    expect(await Game.findCurrentSlug("doom")).toBe("doom-ii");
  });
});
