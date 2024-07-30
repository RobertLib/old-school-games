-- After a history reset, an ambiguous old address may fall back to its
-- legacy game id. That game can already be queued for deletion behind the
-- reset's history-table lock. Do not wait on its row to build a new FK: live
-- ids are also checked directly by the allocator and address-claim guard.
CREATE OR REPLACE FUNCTION "refresh_game_numeric_address"(released_address INTEGER)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  remaining_owner INTEGER;
BEGIN
  IF released_address IS NULL OR released_address <= 0 THEN RETURN; END IF;

  SELECT candidate."gameId" INTO remaining_owner FROM (
    SELECT "id" AS "gameId", 1 AS priority FROM "games"
      WHERE "slug" = released_address::TEXT
    UNION ALL
    SELECT h."gameId", 2 FROM "game_slugs" h JOIN "games" g ON g."id" = h."gameId"
      WHERE h."slug" = released_address::TEXT
    UNION ALL
    SELECT "id", 3 FROM "games" WHERE "id" = released_address
  ) candidate ORDER BY candidate.priority LIMIT 1;

  IF EXISTS (SELECT 1 FROM "game_numeric_addresses"
    WHERE "address" = released_address AND "gameId" = remaining_owner) THEN
    RETURN;
  END IF;

  IF remaining_owner = released_address THEN
    -- Taking KEY SHARE now prevents a deletion from starting between this
    -- check and the FK insert. A skipped row needs no registry entry: even
    -- if its deletion rolls back, the live-id guards still reserve its URL.
    PERFORM 1 FROM "games" WHERE "id" = remaining_owner
      FOR KEY SHARE SKIP LOCKED;
    IF NOT FOUND THEN remaining_owner := NULL; END IF;
  END IF;

  DELETE FROM "game_numeric_addresses" WHERE "address" = released_address;
  IF remaining_owner IS NOT NULL THEN
    INSERT INTO "game_numeric_addresses" ("address", "gameId")
    VALUES (released_address, remaining_owner);
  END IF;
END;
$$;
