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

describe("Game slugs — fixes from the review", () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM "ratings"');
    await pool.query('DELETE FROM "comments"');
    await pool.query('DELETE FROM "game_of_the_week"');
    await pool.query('DELETE FROM "plays"');
    await pool.query('DELETE FROM "games"');
  });

  const create = (title: string) => Game.create({ title, genre: "ACTION" });

  /**
   * A row that did not arrive through create(): what a hand-written INSERT or
   * a SQL import leaves.
   *
   * That used to be a slug and no history row for it. 0054's trigger records
   * the slug as the row goes in, so it is a slug *and* its history row now —
   * which is the point of the trigger, and what the cases below that used to
   * depend on the gap now check is closed. A row that predates the trigger
   * still has no history, and 0054's backfill is what covers it: see
   * tests/migrations-data.test.ts.
   */
  async function insertByHand(title: string, slug: string): Promise<number> {
    const { rows } = await pool.query(
      `INSERT INTO "games" ("title", "slug", "genre") VALUES ($1, $2, 'ACTION')
       RETURNING "id"`,
      [title, slug],
    );

    return rows[0].id as number;
  }

  /**
   * "/5" still redirects to game 5 (the legacy id address), and a slug is
   * looked up before an id — so a new game titled "5" slugged "5" used to take
   * that address over and silently open a different game from old links.
   */
  it("does not give a new game a bare number another game answers to", async () => {
    const { id: existing } = await create("Commander Keen");
    const { id } = await create(String(existing));

    expect((await Game.findById(id))?.slug).toBe(`${existing}-2`);
  });

  it("still gives a bare number when no game has that id", async () => {
    const { id } = await create("1942");

    expect((await Game.findById(id))?.slug).toBe("1942");
  });

  /**
   * A slug made by an older algorithm — "pok-mon" for "Pokémon", where
   * slugify() now makes "pokemon" — shares no base with its own title, so
   * any save at all used to move it. An unchanged title keeps the address.
   */
  it("keeps an old-style slug when the title has not changed", async () => {
    const id = await insertByHand("Pokémon", "pok-mon");

    await Game.update(id, {
      title: "Pokémon",
      genre: "ACTION",
      description: "<p>A typo, fixed.</p>",
    });

    expect((await Game.findById(id))?.slug).toBe("pok-mon");
  });

  /**
   * The outgoing slug of a row with no history used to be lost on its first
   * rename: only the new slug was recorded, so the old address — published,
   * linked, indexed — went to a 404 instead of a 301.
   *
   * Game.update recorded the outgoing slug itself for a while; 0054's trigger
   * is what keeps the address now, by having recorded it when the row went in.
   */
  it("keeps the old address of a hand-inserted game working after a rename", async () => {
    const id = await insertByHand("Doom", "doom");

    await Game.update(id, { title: "Doom II", genre: "ACTION" });

    expect(await Game.findCurrentSlug("doom")).toBe("doom-ii");
  });

  /**
   * resolveSlug asks the history which slugs are taken, never the live
   * column, so a live slug that was not in the history was invisible to it:
   * creating "Quake" beside a hand-inserted "quake" resolved "quake" as free,
   * the INSERT hit games_slug_key, and withResolvedSlug re-resolved the same
   * answer four more times before giving up — the 500 page, with the admin's
   * form gone.
   */
  it("creates a game whose slug a hand-inserted row already holds", async () => {
    await insertByHand("Quake", "quake");

    const { id } = await create("Quake");

    expect((await Game.findById(id))?.slug).toBe("quake-2");
  });

  it("renames a game onto a title whose slug a hand-inserted row holds", async () => {
    await insertByHand("Quake", "quake");
    const { id } = await create("Doom");

    await Game.update(id, { title: "Quake", genre: "ACTION" });

    expect((await Game.findById(id))?.slug).toBe("quake-2");
  });

  // The database keeps the rule itself now, on every path that writes a slug.
  it("records a hand-inserted row's slug the moment it goes in", async () => {
    const id = await insertByHand("Quake", "quake");

    const { rows } = await pool.query(
      'SELECT "slug" FROM "game_slugs" WHERE "gameId" = $1',
      [id],
    );

    expect(rows).toEqual([{ slug: "quake" }]);
  });

  it("records a slug changed by hand, and keeps the one it replaced", async () => {
    const { id } = await create("Doom");

    await pool.query(`UPDATE "games" SET "slug" = 'doom-by-hand' WHERE "id" = $1`, [
      id,
    ]);

    expect(await Game.findCurrentSlug("doom")).toBe("doom-by-hand");
    expect(await Game.findCurrentSlug("doom-by-hand")).toBe("doom-by-hand");
    // And the next save through the model cannot hand either to another game.
    expect((await Game.findById((await create("Doom")).id))?.slug).toBe(
      "doom-2",
    );
  });

  /**
   * The first rename of a row with no history used to write the new slug and
   * the outgoing one in one INSERT … SELECT … UNION, and the UNION's output
   * order decided which got the lower id. A new slug sorting first
   * alphabetically took it, so findFirstSlugs named the new address the
   * game's first — and the feed, which uses that as the item's permanent
   * guid, announced the renamed game to every subscriber again.
   */
  it("keeps the address a hand-inserted game was published at as its first", async () => {
    const id = await insertByHand("Zeta Game", "zeta-game-hand");

    await Game.update(id, { title: "Alpha Game", genre: "ACTION" });

    expect((await Game.findFirstSlugs([id])).get(id)).toBe("zeta-game-hand");
  });

  /**
   * create() and update() still write the slug themselves, in the statement
   * that makes it current, and the trigger records it again when that
   * statement ends — AFTER triggers on a WITH statement fire once the whole of
   * it has run. The trigger's ON CONFLICT is what makes the second write
   * nothing, and this is what would notice if it stopped: a history with two
   * rows for one slug is impossible (the column is UNIQUE), but one with the
   * wrong row first is not.
   */
  it("writes one history row per slug, in the order the slugs were taken", async () => {
    const { id } = await create("Doom");

    await Game.update(id, { title: "Doom II", genre: "ACTION" });
    await Game.update(id, { title: "Doom II", genre: "RPG" });

    const { rows } = await pool.query(
      'SELECT "slug" FROM "game_slugs" WHERE "gameId" = $1 ORDER BY "id"',
      [id],
    );

    expect(rows.map((row) => row.slug)).toEqual(["doom", "doom-ii"]);
    expect((await Game.findFirstSlugs([id])).get(id)).toBe("doom");
  });

  // What the feed names an item by for good — see routes/feed.ts.
  it("reports the first slug each game ever had", async () => {
    const { id: renamed } = await create("Doom");
    const { id: untouched } = await create("Quake");

    await Game.update(renamed, { title: "Doom II", genre: "ACTION" });

    const first = await Game.findFirstSlugs([renamed, untouched]);

    expect(first.get(renamed)).toBe("doom");
    expect(first.get(untouched)).toBe("quake");
    expect(await Game.findFirstSlugs([])).toEqual(new Map());
  });

  /**
   * The game page prints the description with <%- %>. The model sanitises
   * what it writes, but a row that did not come through it went to the page
   * as stored — so the lookup the page renders from cleans it too.
   */
  it("sanitises a description on the way out of the lookup the page uses", async () => {
    await pool.query(
      `INSERT INTO "games" ("title", "slug", "genre", "description")
       VALUES ('Evil', 'evil', 'ACTION', $1)`,
      ['<p>ok</p><script>alert(1)</script><img src=x onerror="alert(2)">'],
    );

    const game = await Game.findBySlug("evil");

    expect(game?.description).toContain("<p>ok</p>");
    expect(game?.description).not.toContain("<script");
    expect(game?.description).not.toContain("onerror");
  });
});
