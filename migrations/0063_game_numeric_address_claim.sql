-- A history reset already holds ACCESS EXCLUSIVE on game_slugs. Returning to
-- an owned numeric slug used to UPDATE the unchanged registry row before the
-- slug-history trigger waited for that table. The reset then needed that row
-- to release the retired address, completing a deadlock. A unique-index probe
-- can validate an existing reservation without taking its row lock.
CREATE OR REPLACE FUNCTION "claim_game_numeric_address"(requested_address INTEGER, requested_owner INTEGER)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF requested_address IS NULL OR requested_address <= 0 THEN RETURN; END IF;

  -- Keep the legacy-id guard: a history reset may leave a live legacy id
  -- protected only by the games table while its deletion is queued or rolls
  -- back. A grandfathered owner may retain its existing reservation.
  IF EXISTS (SELECT 1 FROM "games" WHERE "id" = requested_address AND "id" <> requested_owner)
     AND NOT EXISTS (SELECT 1 FROM "game_numeric_addresses"
       WHERE "address" = requested_address AND "gameId" = requested_owner) THEN
    RAISE EXCEPTION 'Numeric game address /% already belongs to another game', requested_address
      USING ERRCODE = '23505', CONSTRAINT = 'games_numeric_address_key';
  END IF;

  -- DO NOTHING neither locks nor rewrites the conflicting row. Unlike an
  -- early SELECT/return, it still checks the live unique index: REPEATABLE
  -- READ rejects a conflicting replacement outside its snapshot with 40001,
  -- and a reservation removed since that snapshot is safely recreated.
  INSERT INTO "game_numeric_addresses" ("address", "gameId")
  VALUES (requested_address, requested_owner)
  ON CONFLICT ("address") DO NOTHING;

  IF NOT FOUND AND NOT EXISTS (SELECT 1 FROM "game_numeric_addresses"
    WHERE "address" = requested_address AND "gameId" = requested_owner) THEN
    RAISE EXCEPTION 'Numeric game address /% already belongs to another game', requested_address
      USING ERRCODE = '23505', CONSTRAINT = 'games_numeric_address_key';
  END IF;
END;
$$;
