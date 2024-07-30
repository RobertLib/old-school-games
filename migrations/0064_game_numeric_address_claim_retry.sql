-- A history reset can release a reservation after the lock-free unique-index
-- probe has seen it but before READ COMMITTED reads its owner. No owner means
-- the address may now be free: retry the claim instead of rejecting it.
CREATE OR REPLACE FUNCTION "claim_game_numeric_address"(requested_address INTEGER, requested_owner INTEGER)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  conflicting_owner INTEGER;
BEGIN
  IF requested_address IS NULL OR requested_address <= 0 THEN RETURN; END IF;

  LOOP
    -- Keep the legacy-id guard: a history reset may leave a live legacy id
    -- protected only by the games table while its deletion is queued or rolls
    -- back. A grandfathered owner may retain its existing reservation. Run
    -- the guard again on retries, since the reset can expose that legacy id.
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
    IF FOUND THEN RETURN; END IF;

    SELECT "gameId" INTO conflicting_owner FROM "game_numeric_addresses"
      WHERE "address" = requested_address;
    IF conflicting_owner = requested_owner THEN RETURN; END IF;

    -- TRUNCATE does not take the writers' advisory lock. Under READ COMMITTED
    -- it can remove the conflicting reservation between the index probe and
    -- this read; retry instead of reporting a collision on the now-free URL.
    IF conflicting_owner IS NULL THEN CONTINUE; END IF;

    RAISE EXCEPTION 'Numeric game address /% already belongs to another game', requested_address
      USING ERRCODE = '23505', CONSTRAINT = 'games_numeric_address_key';
  END LOOP;
END;
$$;
