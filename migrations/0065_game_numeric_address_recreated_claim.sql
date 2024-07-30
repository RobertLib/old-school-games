-- A history reset can remove a grandfathered reservation while the newly
-- exposed legacy game's deletion waits for history, then rolls back. A stale
-- REPEATABLE READ snapshot still sees its old reservation, so the pre-insert
-- guard alone lets that former owner hide the live legacy id again. A new
-- reservation cannot inherit the exception given to an existing one.
CREATE OR REPLACE FUNCTION "claim_game_numeric_address"(requested_address INTEGER, requested_owner INTEGER)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  conflicting_owner INTEGER;
BEGIN
  IF requested_address IS NULL OR requested_address <= 0 THEN RETURN; END IF;

  LOOP
    IF EXISTS (SELECT 1 FROM "games" WHERE "id" = requested_address AND "id" <> requested_owner)
       AND NOT EXISTS (SELECT 1 FROM "game_numeric_addresses"
         WHERE "address" = requested_address AND "gameId" = requested_owner) THEN
      RAISE EXCEPTION 'Numeric game address /% already belongs to another game', requested_address
        USING ERRCODE = '23505', CONSTRAINT = 'games_numeric_address_key';
    END IF;

    -- Keep the unique-index probe lock-free for existing reservations: an
    -- UPDATE or locking read here would deadlock with a history reset waiting
    -- to release this row while its owner waits for the history-table lock.
    INSERT INTO "game_numeric_addresses" ("address", "gameId")
    VALUES (requested_address, requested_owner)
    ON CONFLICT ("address") DO NOTHING;
    IF FOUND THEN
      -- INSERT proves the reservation had to be created in the live index.
      -- Do not use the snapshot's old same-owner row as a grandfathered
      -- exception now. This plain read adds no parent or registry row lock.
      IF EXISTS (SELECT 1 FROM "games" WHERE "id" = requested_address AND "id" <> requested_owner) THEN
        RAISE EXCEPTION 'Numeric game address /% already belongs to another game', requested_address
          USING ERRCODE = '23505', CONSTRAINT = 'games_numeric_address_key';
      END IF;
      RETURN;
    END IF;

    SELECT "gameId" INTO conflicting_owner FROM "game_numeric_addresses"
      WHERE "address" = requested_address;
    IF conflicting_owner = requested_owner THEN RETURN; END IF;

    -- READ COMMITTED can see a reset release the reservation after the probe.
    -- Retry the claim and its live-id guard rather than rejecting a free URL.
    IF conflicting_owner IS NULL THEN CONTINUE; END IF;

    RAISE EXCEPTION 'Numeric game address /% already belongs to another game', requested_address
      USING ERRCODE = '23505', CONSTRAINT = 'games_numeric_address_key';
  END LOOP;
END;
$$;
