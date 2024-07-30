import { beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import pool from "../../db.ts";
import Game from "../../models/game.ts";

const create = (title: string) => Game.create({ title, genre: "ACTION" });

beforeEach(async () => {
  await pool.query('TRUNCATE "games" RESTART IDENTITY CASCADE');
});

async function sequenceStartsAt(id: number): Promise<void> {
  await pool.query("SELECT setval(pg_get_serial_sequence('games', 'id'), $1, false)", [id]);
}

async function insertByHand(id: number, slug: string): Promise<void> {
  await pool.query(
    `INSERT INTO "games" ("id", "title", "slug", "genre") VALUES ($1, $2, $3, 'ACTION')`,
    [id, slug, slug],
  );
}

describe("numeric game addresses", () => {
  it("skips a number already owned by a current slug when the sequence reaches it", async () => {
    const owner = await create("5");
    const later = [];
    for (let index = 0; index < 4; index++) later.push(await create(`Later ${index}`));

    expect(later.map((game) => game.id)).toEqual([2, 3, 4, 6]);
    expect((await Game.findBySlug("5"))?.id).toBe(owner.id);
    expect(await Game.findById(5)).toBeNull();
  });

  it("keeps skipping a numeric slug after its game has been renamed", async () => {
    const owner = await create("10");
    await Game.update(owner.id, { title: "Renamed", genre: "ACTION" });
    await sequenceStartsAt(10);

    expect((await create("Later")).id).toBe(11);
    expect(await Game.findCurrentSlug("10")).toBe("renamed");
  });

  it("skips consecutive reservations and ids left ahead of the sequence by an import", async () => {
    await create("10");
    await create("11");
    await insertByHand(12, "imported");
    await sequenceStartsAt(10);

    expect((await create("Later")).id).toBe(13);
  });

  it("refuses an explicit id that would shadow somebody else's numeric slug", async () => {
    const owner = await create("10");
    await expect(insertByHand(10, "other")).rejects.toMatchObject({
      code: "23505", constraint: "games_numeric_address_key",
    });
    expect((await Game.findBySlug("10"))?.id).toBe(owner.id);
    expect(await Game.findById(10)).toBeNull();
  });

  it("guards direct SQL numeric slugs and history against an existing legacy id", async () => {
    const first = await create("First");
    const second = await create("Second");
    await expect(insertByHand(10, String(first.id))).rejects.toMatchObject({
      code: "23505", constraint: "games_numeric_address_key",
    });
    await expect(pool.query('UPDATE "games" SET "slug" = $1 WHERE "id" = $2', [
      String(first.id), second.id,
    ])).rejects.toMatchObject({ code: "23505", constraint: "games_numeric_address_key" });
    await expect(pool.query('INSERT INTO "game_slugs" ("gameId", "slug") VALUES ($1, $2)', [
      second.id, String(first.id),
    ])).rejects.toMatchObject({ code: "23505", constraint: "games_numeric_address_key" });
  });

  it("allows a numeric slug to name its own game's id", async () => {
    await insertByHand(10, "10");
    expect((await Game.findBySlug("10"))?.id).toBe(10);
  });

  it.each(["007", "2147483648", "999999999999999999999999999999"])(
    "keeps %s as a slug without treating it as an int4 id",
    async (title) => {
      const owner = await create(title);
      await sequenceStartsAt(7);
      expect((await create("Later")).id).toBe(7);
      expect((await Game.findBySlug(title))?.id).toBe(owner.id);
    },
  );

  it("creates no orphan reservation for INSERT ON CONFLICT DO NOTHING", async () => {
    await create("Doom");
    await pool.query(`INSERT INTO "games" ("title", "slug", "genre")
      VALUES ('Duplicate', 'doom', 'ACTION') ON CONFLICT ("slug") DO NOTHING`);
    await insertByHand(2, "second");
    expect((await Game.findById(2))?.slug).toBe("second");
  });

  it("releases a historic numeric address when that history is explicitly removed", async () => {
    const owner = await create("10");
    await Game.update(owner.id, { title: "Renamed", genre: "ACTION" });
    await pool.query('DELETE FROM "game_slugs" WHERE "slug" = $1', ["10"]);
    await sequenceStartsAt(10);
    expect((await create("Later")).id).toBe(10);
  });

  it("retains the reservation when deleted history still names a current slug", async () => {
    await create("10");
    await pool.query('DELETE FROM "game_slugs" WHERE "slug" = $1', ["10"]);
    await sequenceStartsAt(10);
    expect((await create("Later")).id).toBe(11);
  });

  it("also releases retired numeric addresses when history is truncated directly", async () => {
    const retired = await create("10");
    await Game.update(retired.id, { title: "Renamed", genre: "ACTION" });
    const current = await create("11");
    await pool.query('TRUNCATE "game_slugs"');
    await sequenceStartsAt(10);
    expect((await create("Later")).id).toBe(10);
    expect((await create("Next")).id).toBe(12);
    expect((await Game.findBySlug("11"))?.id).toBe(current.id);
  });

  it("releases every reserved address when its owner is deleted", async () => {
    const owner = await create("10");
    await Game.update(owner.id, { title: "11", genre: "ACTION" });
    await Game.delete(owner.id);
    await sequenceStartsAt(10);
    expect((await create("Later")).id).toBe(10);
    expect((await create("Next")).id).toBe(11);
  });

  it("releases reservations when a game insert is rolled back", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO "games" ("id", "title", "slug", "genre")
        VALUES (80, 'Rolled back', '90', 'ACTION')`);
      await client.query("ROLLBACK");
      await insertByHand(90, "later");
      expect((await Game.findById((await create("80")).id))?.slug).toBe("80");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

/** Wait for the actual advisory-lock wait, so the race does not rely on sleep. */
async function waitForWriter(queryFragment: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE wait_event = 'advisory' AND query LIKE $1",
      [`%${queryFragment}%`],
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The competing writer did not reach the numeric-address lock");
}

/** Stage the reset only once the competing write waits for its history table. */
async function waitForHistoryWrite(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_locks WHERE "pid" = $1
         AND "relation" = 'game_slugs'::regclass
         AND "mode" = 'RowExclusiveLock' AND NOT "granted"`,
      [pid],
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The competing game write did not reach its history-table wait");
}

describe("concurrent numeric game addresses", () => {
  it("retries a reservation removed between its unique-index probe and owner check", async () => {
    const owner = await create("10");
    await Game.update(owner.id, { title: "Renamed", genre: "ACTION" });
    const blocker = await pool.connect();
    const writer = await pool.connect();
    let restoration: Promise<{ rowCount: number | null; error?: unknown }> | undefined;
    try {
      // AFTER STATEMENT runs even when ON CONFLICT inserts no rows. This gate
      // stages the reset after the index probe without changing the claim's SQL.
      await blocker.query(`
        CREATE FUNCTION "pause_numeric_address_probe_test"() RETURNS TRIGGER
        LANGUAGE plpgsql AS $$ BEGIN
          PERFORM pg_advisory_xact_lock(1869834094, -63);
          RETURN NULL;
        END; $$;
        CREATE TRIGGER "pause_numeric_address_probe_test"
        AFTER INSERT ON "game_numeric_addresses" FOR EACH STATEMENT
        EXECUTE FUNCTION "pause_numeric_address_probe_test"();
      `);
      await blocker.query("SELECT pg_advisory_lock(1869834094, -63)");
      restoration = writer.query('UPDATE "games" SET "slug" = \'10\' WHERE "id" = $1', [
        owner.id,
      ]).then(
        ({ rowCount }) => ({ rowCount }),
        (error: unknown) => ({ rowCount: null, error }),
      );
      await waitForWriter('UPDATE "games" SET "slug" = \'10\'');

      await blocker.query('TRUNCATE "game_slugs"');
      expect((await blocker.query(
        'SELECT "gameId" FROM "game_numeric_addresses" WHERE "address" = 10',
      )).rows).toEqual([]);
      await blocker.query("SELECT pg_advisory_unlock(1869834094, -63)");
      const result = await restoration;
      expect(result.error).toBeUndefined();
      expect(result.rowCount).toBe(1);
      expect((await pool.query(
        'SELECT "gameId" FROM "game_numeric_addresses" WHERE "address" = 10',
      )).rows).toEqual([{ gameId: owner.id }]);
      await sequenceStartsAt(10);
      expect((await create("Later")).id).toBe(11);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock(1869834094, -63)");
      await restoration;
      await blocker.query('DROP TRIGGER IF EXISTS "pause_numeric_address_probe_test" ON "game_numeric_addresses"');
      await blocker.query('DROP FUNCTION IF EXISTS "pause_numeric_address_probe_test"()');
      blocker.release();
      writer.release();
    }
  });

  it.each([
    { resetOutcome: "COMMIT", writerOutcome: "COMMIT" },
    { resetOutcome: "COMMIT", writerOutcome: "ROLLBACK" },
    { resetOutcome: "ROLLBACK", writerOutcome: "COMMIT" },
    { resetOutcome: "ROLLBACK", writerOutcome: "ROLLBACK" },
  ] as const)(
    "resets history while an old numeric slug is restored (reset $resetOutcome, writer $writerOutcome)",
    async ({ resetOutcome, writerOutcome }) => {
      const owner = await create("10");
      await Game.update(owner.id, { title: "Renamed", genre: "ACTION" });
      const reset = await pool.connect();
      const writer = await pool.connect();
      let restoration: Promise<{ rowCount: number | null; error?: unknown }> | undefined;
      try {
        const { rows } = await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await reset.query("BEGIN");
        await reset.query("SET LOCAL statement_timeout = '3s'");
        await reset.query('LOCK TABLE "game_slugs" IN ACCESS EXCLUSIVE MODE');
        await writer.query("BEGIN");
        restoration = writer.query('UPDATE "games" SET "slug" = $1 WHERE "id" = $2', [
          "10", owner.id,
        ]).then(
          ({ rowCount }) => ({ rowCount }),
          (error: unknown) => ({ rowCount: null, error }),
        );
        await waitForHistoryWrite(rows[0]!.pid);

        // The returning game has reached its history trigger. Claiming its
        // existing /10 must not hold a registry row lock that blocks this reset.
        await reset.query('TRUNCATE "game_slugs"');
        expect((await reset.query(
          'SELECT "gameId" FROM "game_numeric_addresses" WHERE "address" = 10',
        )).rows).toEqual([]);
        await reset.query(resetOutcome);
        const result = await restoration;
        expect(result.error).toBeUndefined();
        expect(result.rowCount).toBe(1);
        await writer.query(writerOutcome);

        const retainsAddress = writerOutcome === "COMMIT" || resetOutcome === "ROLLBACK";
        expect((await pool.query(
          'SELECT "gameId" FROM "game_numeric_addresses" WHERE "address" = 10',
        )).rows).toEqual(retainsAddress ? [{ gameId: owner.id }] : []);
        expect((await Game.findById(owner.id))?.slug)
          .toBe(writerOutcome === "COMMIT" ? "10" : "renamed");
        await sequenceStartsAt(10);
        expect((await create("Later")).id).toBe(retainsAddress ? 11 : 10);
      } finally {
        await reset.query("ROLLBACK");
        await restoration;
        await writer.query("ROLLBACK");
        reset.release();
        writer.release();
      }
    },
  );

  it("resets history while a game deletion waits without revalidating retained addresses", async () => {
    const owner = await create("10");
    await Game.update(owner.id, { title: "11", genre: "ACTION" });
    const reset = await pool.connect();
    const writer = await pool.connect();
    let deletion: Promise<{ rowCount: number | null; error?: unknown }> | undefined;
    try {
      const { rows } = await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await reset.query("BEGIN");
      await reset.query("SET LOCAL statement_timeout = '3s'");
      await reset.query('LOCK TABLE "game_slugs" IN ACCESS EXCLUSIVE MODE');
      deletion = writer.query('DELETE FROM "games" WHERE "id" = $1', [owner.id]).then(
        ({ rowCount }) => ({ rowCount }),
        (error: unknown) => ({ rowCount: null, error }),
      );
      await waitForHistoryWrite(rows[0]!.pid);

      await reset.query('TRUNCATE "game_slugs"');
      // Retired /10 is released, while the still-visible current slug and id
      // retain their reservations until the queued deletion can complete.
      expect((await reset.query(
        'SELECT "address" FROM "game_numeric_addresses" ORDER BY "address"',
      )).rows).toEqual([{ address: owner.id }, { address: 11 }]);
      await reset.query("COMMIT");

      const result = await deletion;
      expect(result.error).toBeUndefined();
      expect(result.rowCount).toBe(1);
      expect((await pool.query('SELECT * FROM "game_numeric_addresses"')).rows).toEqual([]);
      await sequenceStartsAt(10);
      expect((await create("Later")).id).toBe(10);
      expect((await create("Next")).id).toBe(11);
    } finally {
      await reset.query("ROLLBACK");
      await deletion;
      reset.release();
      writer.release();
    }
  });

  it.each(["COMMIT", "ROLLBACK"] as const)(
    "resets historical ownership while the newly exposed legacy game's deletion will %s",
    async (outcome) => {
      const reset = await pool.connect();
      const writer = await pool.connect();
      let deletion: Promise<{ rowCount: number | null; error?: unknown }> | undefined;
      try {
        await reset.query("BEGIN");
        await beforeNumericMigration(reset);
        await reset.query('DELETE FROM "games" WHERE "id" = 20');
        await reset.query("COMMIT");
        expect((await reset.query(
          'SELECT "gameId" FROM "game_numeric_addresses" WHERE "address" = 70',
        )).rows).toEqual([{ gameId: 10 }]);

        const { rows } = await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await reset.query("BEGIN");
        await reset.query("SET LOCAL statement_timeout = '3s'");
        await reset.query('LOCK TABLE "game_slugs" IN ACCESS EXCLUSIVE MODE');
        await writer.query("BEGIN");
        deletion = writer.query('DELETE FROM "games" WHERE "id" = 70').then(
          ({ rowCount }) => ({ rowCount }),
          (error: unknown) => ({ rowCount: null, error }),
        );
        await waitForHistoryWrite(rows[0]!.pid);

        await reset.query('TRUNCATE "game_slugs"');
        expect((await reset.query(
          'SELECT "gameId" FROM "game_numeric_addresses" WHERE "address" = 70',
        )).rows).toEqual([]);
        await reset.query("COMMIT");
        const result = await deletion;
        expect(result.error).toBeUndefined();
        expect(result.rowCount).toBe(1);
        await writer.query(outcome);

        await sequenceStartsAt(70);
        if (outcome === "COMMIT") {
          expect(await Game.findById(70)).toBeNull();
          expect((await create("Later")).id).toBe(70);
        } else {
          expect((await Game.findById(70))?.slug).toBe("legacy");
          await expect(insertByHand(80, "70")).rejects.toMatchObject({
            code: "23505", constraint: "games_numeric_address_key",
          });
          expect((await create("Later")).id).toBe(71);
          const numeric = await create("70");
          expect((await Game.findById(numeric.id))?.slug).toBe("70-2");
        }
      } finally {
        await reset.query("ROLLBACK");
        await deletion;
        await writer.query("ROLLBACK");
        reset.release();
        writer.release();
      }
    },
  );

  it("waits for a numeric slug's writer and then allocates the next free id", async () => {
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query("BEGIN");
      await first.query(`INSERT INTO "games" ("title", "slug", "genre") VALUES ('Owner', '80', 'ACTION')`);
      await sequenceStartsAt(80);
      const competing = second.query<{ id: number }>(
        `INSERT INTO "games" ("title", "slug", "genre") VALUES ('Later', 'later', 'ACTION') RETURNING "id"`,
      );
      // pg_stat_activity must be queried from a third connection: asking the
      // blocked client for its pid would queue behind the blocked INSERT.
      await waitForWriter("Later");
      await first.query("COMMIT");
      expect((await competing).rows[0]?.id).toBe(81);
      expect((await Game.findBySlug("80"))?.title).toBe("Owner");
    } finally {
      await first.query("ROLLBACK");
      first.release();
      second.release();
    }
  });

  it("re-resolves a numeric slug when a concurrent id wins after its first read", async () => {
    const first = await pool.connect();
    try {
      await first.query("BEGIN");
      await first.query(`INSERT INTO "games" ("id", "title", "slug", "genre") VALUES (80, 'Owner', 'owner', 'ACTION')`);
      const competing = create("80");
      await waitForWriter("WITH inserted AS");
      await first.query("COMMIT");
      expect((await Game.findById((await competing).id))?.slug).toBe("80-2");
      expect((await Game.findById(80))?.slug).toBe("owner");
    } finally {
      await first.query("ROLLBACK");
      first.release();
    }
  });

  it("rejects a stale REPEATABLE READ snapshot through the unique registry", async () => {
    const stale = await pool.connect();
    try {
      await stale.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await stale.query('SELECT COUNT(*) FROM "games"');
      await insertByHand(80, "owner");
      await expect(stale.query(`INSERT INTO "games" ("id", "title", "slug", "genre")
        VALUES (1, 'Stale', '80', 'ACTION')`)).rejects.toMatchObject({ code: "40001" });
      await stale.query("ROLLBACK");
      expect(await Game.findBySlug("80")).toBeNull();
      expect((await Game.findById(80))?.slug).toBe("owner");
    } finally {
      await stale.query("ROLLBACK");
      stale.release();
    }
  });

  it("rejects a stale same-owner reservation reassigned outside a REPEATABLE READ snapshot", async () => {
    const first = await create("10");
    await Game.update(first.id, { title: "Renamed", genre: "ACTION" });
    const second = await create("Second");
    const stale = await pool.connect();
    try {
      await stale.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      expect((await stale.query(
        'SELECT "gameId" FROM "game_numeric_addresses" WHERE "address" = 10',
      )).rows).toEqual([{ gameId: first.id }]);
      await pool.query('DELETE FROM "game_slugs" WHERE "slug" = $1', ["10"]);
      await pool.query('INSERT INTO "game_slugs" ("gameId", "slug") VALUES ($1, $2)', [
        second.id, "10",
      ]);

      // An early return for the snapshot's old same-owner row would allow
      // this current slug to take the address now owned by another history.
      await expect(stale.query('UPDATE "games" SET "slug" = $1 WHERE "id" = $2', [
        "10", first.id,
      ])).rejects.toMatchObject({ code: "40001" });
      await stale.query("ROLLBACK");
      expect((await Game.findById(first.id))?.slug).toBe("renamed");
      expect(await Game.findCurrentSlug("10")).toBe("second");
      expect((await pool.query(
        'SELECT "gameId" FROM "game_numeric_addresses" WHERE "address" = 10',
      )).rows).toEqual([{ gameId: second.id }]);
    } finally {
      await stale.query("ROLLBACK");
      stale.release();
    }
  });

  it.each(["current slug", "historical slug"] as const)(
    "refuses a stale %s claim after a history reset exposes a live legacy id",
    async (claim) => {
      const stale = await pool.connect();
      const reset = await pool.connect();
      const writer = await pool.connect();
      let deletion: Promise<{ rowCount: number | null; error?: unknown }> | undefined;
      try {
        await reset.query("BEGIN");
        await beforeNumericMigration(reset);
        await reset.query('DELETE FROM "games" WHERE "id" = 20');
        await reset.query("COMMIT");

        await stale.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        expect((await stale.query(
          'SELECT "gameId" FROM "game_numeric_addresses" WHERE "address" = 70',
        )).rows).toEqual([{ gameId: 10 }]);

        await reset.query("BEGIN");
        await reset.query("SET LOCAL statement_timeout = '3s'");
        await reset.query('LOCK TABLE "game_slugs" IN ACCESS EXCLUSIVE MODE');
        await writer.query("BEGIN");
        const { rows } = await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        deletion = writer.query('DELETE FROM "games" WHERE "id" = 70').then(
          ({ rowCount }) => ({ rowCount }),
          (error: unknown) => ({ rowCount: null, error }),
        );
        await waitForHistoryWrite(rows[0]!.pid);

        // The reset cannot lock the legacy parent while its deletion waits
        // for history. Its old reservation disappears, but the deletion can
        // roll back: /70 then names the live legacy id, not the stale owner.
        await reset.query('TRUNCATE "game_slugs"');
        expect((await reset.query(
          'SELECT "gameId" FROM "game_numeric_addresses" WHERE "address" = 70',
        )).rows).toEqual([]);
        await reset.query("COMMIT");
        const result = await deletion;
        expect(result.error).toBeUndefined();
        expect(result.rowCount).toBe(1);
        await writer.query("ROLLBACK");

        // The snapshot still sees its own old reservation. A fresh INSERT
        // must not treat that deleted row as permission to hide the legacy id.
        const restoration = claim === "current slug"
          ? stale.query('UPDATE "games" SET "slug" = $1 WHERE "id" = 10', ["70"])
          : stale.query('INSERT INTO "game_slugs" ("gameId", "slug") VALUES (10, $1)', ["70"]);
        await expect(restoration).rejects.toMatchObject({
          code: "23505", constraint: "games_numeric_address_key",
        });
        await stale.query("ROLLBACK");

        expect((await Game.findById(70))?.slug).toBe("legacy");
        expect(await Game.findBySlug("70")).toBeNull();
        expect(await Game.findCurrentSlug("70")).toBeNull();
        expect((await Game.findById(10))?.slug).toBe("alpha");
        expect((await pool.query(
          'SELECT "gameId" FROM "game_numeric_addresses" WHERE "address" = 70',
        )).rows).toEqual([]);
      } finally {
        await reset.query("ROLLBACK");
        await deletion;
        await writer.query("ROLLBACK");
        await stale.query("ROLLBACK");
        stale.release();
        reset.release();
        writer.release();
      }
    },
  );

  it("recreates a same-owner reservation removed outside a REPEATABLE READ snapshot", async () => {
    const owner = await create("10");
    await Game.update(owner.id, { title: "Renamed", genre: "ACTION" });
    const stale = await pool.connect();
    try {
      await stale.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      expect((await stale.query(
        'SELECT "gameId" FROM "game_numeric_addresses" WHERE "address" = 10',
      )).rows).toEqual([{ gameId: owner.id }]);
      await pool.query('DELETE FROM "game_slugs" WHERE "slug" = $1', ["10"]);
      await stale.query('UPDATE "games" SET "slug" = $1 WHERE "id" = $2', ["10", owner.id]);
      await stale.query("COMMIT");

      // The unique-index probe must recreate the deleted row even though the
      // snapshot still sees it, or allocation could reuse this current URL.
      expect((await pool.query(
        'SELECT "gameId" FROM "game_numeric_addresses" WHERE "address" = 10',
      )).rows).toEqual([{ gameId: owner.id }]);
      await sequenceStartsAt(10);
      expect((await create("Later")).id).toBe(11);
    } finally {
      await stale.query("ROLLBACK");
      stale.release();
    }
  });

  it("does not make voting wait for a catalogue address transaction", async () => {
    const game = await create("Rated");
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(1869834094, 60)");
      expect(await Promise.race([
        Game.rate(game.id, "numeric-address-test", 5),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Voting waited for the catalogue lock")), 1_000).unref();
        }),
      ])).toBe(true);
      expect((await Game.getRatingSummary(game.id)).ratingCount).toBe(1);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });
});

/** Replay the forward migrations against an ambiguous state an older DB permits. */
async function beforeNumericMigration(client: PoolClient): Promise<void> {
  await client.query(`
    DROP TRIGGER "games_numeric_addresses_lock" ON "games";
    DROP TRIGGER "games_record_numeric_addresses" ON "games";
    DROP TRIGGER "game_slugs_numeric_addresses_lock" ON "game_slugs";
    DROP TRIGGER "game_slugs_record_numeric_address" ON "game_slugs";
    DROP TRIGGER "game_slugs_truncated_numeric_addresses" ON "game_slugs";
    ALTER TABLE "games" ALTER COLUMN "id" SET DEFAULT nextval('games_id_seq');
    DROP TABLE "game_numeric_addresses";
    DROP FUNCTION "game_numeric_address"(TEXT);
    DROP FUNCTION "lock_game_numeric_addresses"();
    DROP FUNCTION "claim_game_numeric_address"(INTEGER, INTEGER);
    DROP FUNCTION "refresh_game_numeric_address"(INTEGER);
    DROP FUNCTION "record_game_numeric_addresses"();
    DROP FUNCTION "record_game_slug_numeric_address"();
    DROP FUNCTION "refresh_truncated_game_numeric_addresses"();
    DROP FUNCTION "next_available_game_id"();
    INSERT INTO "games" ("id", "title", "slug", "genre")
      VALUES (10, 'Historic', 'alpha', 'ACTION'), (20, 'Current', '70', 'ACTION'),
             (70, 'Legacy', 'legacy', 'ACTION');
    DELETE FROM "game_slugs" WHERE "slug" = '70';
    INSERT INTO "game_slugs" ("gameId", "slug") VALUES (10, '70');
  `);
  await client.query(await readFile(
    new URL("../../migrations/0060_games_numeric_addresses.sql", import.meta.url), "utf8",
  ));
  await client.query(await readFile(
    new URL("../../migrations/0061_game_numeric_address_refresh.sql", import.meta.url), "utf8",
  ));
  await client.query(await readFile(
    new URL("../../migrations/0062_game_numeric_address_legacy_refresh.sql", import.meta.url), "utf8",
  ));
  await client.query(await readFile(
    new URL("../../migrations/0063_game_numeric_address_claim.sql", import.meta.url), "utf8",
  ));
  await client.query(await readFile(
    new URL("../../migrations/0064_game_numeric_address_claim_retry.sql", import.meta.url), "utf8",
  ));
  await client.query(await readFile(
    new URL("../../migrations/0065_game_numeric_address_recreated_claim.sql", import.meta.url), "utf8",
  ));
}

describe("numeric-address migration compatibility", () => {
  it("lets the grandfathered current owner restore its numeric history", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await beforeNumericMigration(client);
      await client.query('DELETE FROM "game_slugs" WHERE "slug" = $1', ["70"]);
      await client.query('INSERT INTO "game_slugs" ("gameId", "slug") VALUES (20, $1)', ["70"]);
      expect((await client.query('SELECT "gameId" FROM "game_numeric_addresses" WHERE "address" = 70')).rows)
        .toEqual([{ gameId: 20 }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("keeps the old winner, then restores history and legacy ownership as games are deleted", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await beforeNumericMigration(client);
      const addressOwner = async () => (await client.query(
        'SELECT "gameId" FROM "game_numeric_addresses" WHERE "address" = 70',
      )).rows[0]?.gameId;
      expect(await addressOwner()).toBe(20);
      // Saving unchanged grandfathered rows must still work, even when an
      // existing numeric slug/history has already hidden their legacy id.
      await client.query('UPDATE "games" SET "slug" = "slug"');
      await client.query('DELETE FROM "games" WHERE "id" = 20');
      expect(await addressOwner()).toBe(10);
      await client.query('DELETE FROM "games" WHERE "id" = 10');
      expect(await addressOwner()).toBe(70);
      await expect(client.query(`INSERT INTO "games" ("id", "title", "slug", "genre")
        VALUES (80, 'Other', '70', 'ACTION')`)).rejects.toMatchObject({
        code: "23505", constraint: "games_numeric_address_key",
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("deletes all grandfathered owners together without reserving an already deleted parent", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await beforeNumericMigration(client);
      await client.query('DELETE FROM "games" WHERE "id" IN (10, 20, 70)');
      expect((await client.query('SELECT * FROM "game_numeric_addresses"')).rows).toEqual([]);
      await client.query("SELECT setval('games_id_seq', 70, false)");
      expect((await client.query(`INSERT INTO "games" ("title", "slug", "genre")
        VALUES ('Later', 'later', 'ACTION') RETURNING "id"`)).rows[0]?.id).toBe(70);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
