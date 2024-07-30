-- A history reset holds ACCESS EXCLUSIVE on game_slugs. A concurrent game
-- deletion can already hold its parent row while waiting to cascade into
-- that table. Rebuilding an unchanged reservation then waits for the parent
-- through its foreign key, completing a deadlock. Keep those rows in place;
-- only an address whose owner changed or disappeared needs a write.
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

  -- Do not lock or revalidate an unchanged row: its FK already protects the
  -- owner, and the waiting deletion will cascade it after the reset commits.
  IF EXISTS (SELECT 1 FROM "game_numeric_addresses"
    WHERE "address" = released_address AND "gameId" = remaining_owner) THEN
    RETURN;
  END IF;

  DELETE FROM "game_numeric_addresses" WHERE "address" = released_address;
  IF remaining_owner IS NOT NULL THEN
    INSERT INTO "game_numeric_addresses" ("address", "gameId")
    VALUES (released_address, remaining_owner);
  END IF;
END;
$$;
