-- Slugs and legacy numeric ids share the same /123 address. Checking the
-- ids that exist when a slug is chosen covers only half of that collision:
-- a game can own /1942 years before the sequence reaches id 1942. Keep every
-- published slug and history row, and skip such numbers when allocating ids.
-- Explicit ids and direct SQL slug/history writes must respect the same owner.
--
-- The registry makes that ownership unique in the database, including under
-- REPEATABLE READ, where a SELECT after an advisory-lock wait still sees an old
-- snapshot. The lock keeps normal READ COMMITTED writers from choosing an id
-- that a concurrent slug claims, and is taken before row locks to avoid lock
-- inversion between a game write and its history/FK triggers. Rating-total
-- updates do not touch id or slug and deliberately take no such lock.
--
-- Existing ambiguous addresses retain the router's current priority: current
-- slug, historical slug, then numeric id. There is no way for one URL to name
-- both existing games; this migration neither renumbers them nor changes who
-- the URL currently opens. Unchanged rows are therefore grandfathered below.
LOCK TABLE "games", "game_slugs" IN SHARE ROW EXCLUSIVE MODE;

CREATE FUNCTION "game_numeric_address"(slug TEXT) RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  -- parseId rejects zero, leading zeros and anything outside int4. Bound the
  -- length before casting so even a long all-digit slug cannot overflow.
  IF slug !~ '^[1-9][0-9]{0,9}$' THEN RETURN NULL; END IF;
  IF slug::BIGINT > 2147483647 THEN RETURN NULL; END IF;
  RETURN slug::INTEGER;
END;
$$;

CREATE TABLE "game_numeric_addresses" (
  "address" INTEGER CONSTRAINT "games_numeric_address_key" PRIMARY KEY,
  "gameId" INTEGER NOT NULL REFERENCES "games" ("id") ON DELETE CASCADE,
  CONSTRAINT "game_numeric_addresses_positive" CHECK ("address" > 0)
);

CREATE INDEX "idx_game_numeric_addresses_gameId"
ON "game_numeric_addresses" ("gameId");

INSERT INTO "game_numeric_addresses" ("address", "gameId")
SELECT "game_numeric_address"("slug"), "id" FROM "games"
WHERE "game_numeric_address"("slug") IS NOT NULL;

INSERT INTO "game_numeric_addresses" ("address", "gameId")
SELECT "game_numeric_address"("slug"), "gameId" FROM "game_slugs"
WHERE "game_numeric_address"("slug") IS NOT NULL
ON CONFLICT ("address") DO NOTHING;

INSERT INTO "game_numeric_addresses" ("address", "gameId")
SELECT "id", "id" FROM "games" WHERE "id" > 0
ON CONFLICT ("address") DO NOTHING;

CREATE FUNCTION "lock_game_numeric_addresses"() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  -- A separate two-integer key, not the migration runner's single-key lock.
  PERFORM pg_advisory_xact_lock(1869834094, 60);
  RETURN NULL;
END;
$$;

CREATE TRIGGER "games_numeric_addresses_lock"
BEFORE INSERT OR DELETE OR UPDATE OF "id", "slug" ON "games"
FOR EACH STATEMENT EXECUTE FUNCTION "lock_game_numeric_addresses"();

CREATE TRIGGER "game_slugs_numeric_addresses_lock"
BEFORE INSERT OR DELETE OR UPDATE OF "gameId", "slug" ON "game_slugs"
FOR EACH STATEMENT EXECUTE FUNCTION "lock_game_numeric_addresses"();

CREATE FUNCTION "claim_game_numeric_address"(requested_address INTEGER, requested_owner INTEGER)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF requested_address IS NULL OR requested_address <= 0 THEN RETURN; END IF;

  -- An already ambiguous legacy id may not have its own registry row. Once
  -- its former shadowing game is deleted, the id is reachable again, and a
  -- new numeric slug must not take it over just because that row was absent.
  IF EXISTS (SELECT 1 FROM "games" WHERE "id" = requested_address AND "id" <> requested_owner)
     AND NOT EXISTS (SELECT 1 FROM "game_numeric_addresses"
       WHERE "address" = requested_address AND "gameId" = requested_owner) THEN
    RAISE EXCEPTION 'Numeric game address /% already belongs to another game', requested_address
      USING ERRCODE = '23505', CONSTRAINT = 'games_numeric_address_key';
  END IF;

  INSERT INTO "game_numeric_addresses" ("address", "gameId")
  VALUES (requested_address, requested_owner)
  ON CONFLICT ("address") DO UPDATE SET "gameId" = EXCLUDED."gameId"
  WHERE "game_numeric_addresses"."gameId" = EXCLUDED."gameId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Numeric game address /% already belongs to another game', requested_address
      USING ERRCODE = '23505', CONSTRAINT = 'games_numeric_address_key';
  END IF;
END;
$$;

CREATE FUNCTION "refresh_game_numeric_address"(released_address INTEGER)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  remaining_owner INTEGER;
BEGIN
  IF released_address IS NULL OR released_address <= 0 THEN RETURN; END IF;

  -- Direct history deletion is supported, not a permanent reservation. Keep
  -- the address only while the router can still resolve it, in its own order.
  SELECT candidate."gameId" INTO remaining_owner FROM (
    SELECT "id" AS "gameId", 1 AS priority FROM "games"
      WHERE "slug" = released_address::TEXT
    UNION ALL
    SELECT h."gameId", 2 FROM "game_slugs" h JOIN "games" g ON g."id" = h."gameId"
      WHERE h."slug" = released_address::TEXT
    UNION ALL
    SELECT "id", 3 FROM "games" WHERE "id" = released_address
  ) candidate ORDER BY candidate.priority LIMIT 1;

  DELETE FROM "game_numeric_addresses" WHERE "address" = released_address;
  IF remaining_owner IS NOT NULL THEN
    INSERT INTO "game_numeric_addresses" ("address", "gameId")
    VALUES (released_address, remaining_owner);
  END IF;
END;
$$;

CREATE FUNCTION "record_game_numeric_addresses"() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "refresh_game_numeric_address"(OLD."id");
    PERFORM "refresh_game_numeric_address"("game_numeric_address"(OLD."slug"));
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' OR NEW."id" IS DISTINCT FROM OLD."id" THEN
    PERFORM "claim_game_numeric_address"(NEW."id", NEW."id");
  END IF;
  IF TG_OP = 'INSERT' OR NEW."slug" IS DISTINCT FROM OLD."slug" THEN
    PERFORM "claim_game_numeric_address"("game_numeric_address"(NEW."slug"), NEW."id");
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id" THEN
      PERFORM "refresh_game_numeric_address"(OLD."id");
    END IF;
    IF NEW."slug" IS DISTINCT FROM OLD."slug" THEN
      PERFORM "refresh_game_numeric_address"("game_numeric_address"(OLD."slug"));
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- AFTER rather than BEFORE: an INSERT ON CONFLICT DO NOTHING that writes no
-- game must not leave a reservation referencing a game that was never made.
CREATE TRIGGER "games_record_numeric_addresses"
AFTER INSERT OR DELETE OR UPDATE OF "id", "slug" ON "games"
FOR EACH ROW EXECUTE FUNCTION "record_game_numeric_addresses"();

CREATE FUNCTION "record_game_slug_numeric_address"() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "refresh_game_numeric_address"("game_numeric_address"(OLD."slug"));
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' OR NEW."gameId" IS DISTINCT FROM OLD."gameId"
     OR NEW."slug" IS DISTINCT FROM OLD."slug" THEN
    PERFORM "claim_game_numeric_address"("game_numeric_address"(NEW."slug"), NEW."gameId");
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."gameId" IS DISTINCT FROM OLD."gameId"
     OR NEW."slug" IS DISTINCT FROM OLD."slug") THEN
    PERFORM "refresh_game_numeric_address"("game_numeric_address"(OLD."slug"));
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "game_slugs_record_numeric_address"
AFTER INSERT OR DELETE OR UPDATE OF "gameId", "slug" ON "game_slugs"
FOR EACH ROW EXECUTE FUNCTION "record_game_slug_numeric_address"();

CREATE FUNCTION "refresh_truncated_game_numeric_addresses"() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  released_address INTEGER;
BEGIN
  -- TRUNCATE does not fire DELETE triggers. A deliberate history reset must
  -- release retired numeric slugs too, while retaining current slugs and ids.
  FOR released_address IN SELECT "address" FROM "game_numeric_addresses" LOOP
    PERFORM "refresh_game_numeric_address"(released_address);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "game_slugs_truncated_numeric_addresses"
AFTER TRUNCATE ON "game_slugs"
FOR EACH STATEMENT EXECUTE FUNCTION "refresh_truncated_game_numeric_addresses"();

CREATE FUNCTION "next_available_game_id"() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  candidate INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(1869834094, 60);
  LOOP
    candidate := nextval(pg_get_serial_sequence('games', 'id'));
    -- Checking live ids as well handles a sequence left behind by an import
    -- that supplied explicit ids, without resetting it backwards or reusing
    -- a number another concurrent writer has already allocated.
    IF NOT EXISTS (SELECT 1 FROM "games" WHERE "id" = candidate)
       AND NOT EXISTS (SELECT 1 FROM "game_numeric_addresses" WHERE "address" = candidate)
    THEN RETURN candidate;
    END IF;
  END LOOP;
END;
$$;

ALTER TABLE "games" ALTER COLUMN "id" SET DEFAULT "next_available_game_id"();
