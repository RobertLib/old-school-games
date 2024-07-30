-- Moves any game or article whose slug is a route the site already answers at
-- off that address.
--
-- utils/reserved-slugs.ts explains what goes wrong: game slugs sit at the
-- root — "/doom" — beside every fixed page the site has, and express matches
-- in registration order, so "/about", "/action", "/most-played" and the
-- curated lists are all declared ahead of the "/:id" game lookup. A game
-- slugged "about" therefore disappears behind the About page while its
-- canonical tag, its sitemap entry and every internal link go on advertising
-- "/about" as its address. Article slugs live under "/news/" and collide with
-- one thing, the admin form at "/news/new".
--
-- resolveSlug has refused to *hand out* a reserved base since that file was
-- written, but nothing ever moved the rows that already had one — 0019
-- slugged every article straight off its title with no reserved check at all,
-- 0035 did the same for the games 0008 left NULL, and any row saved before
-- the guard existed kept whatever it was given. This is the backfill that
-- guard never had.
--
-- The suffixing is 0035's and resolveSlug's: the current slug is the base and
-- the lowest free "-2", "-3", ... is taken, checked against the live column,
-- against the whole slug history (an address something has given up still
-- redirects — see findCurrentSlug — so handing it to somebody else breaks a
-- redirect rather than merely duplicating a name) and against the reserved
-- list itself. Using the current slug as the base rather than re-deriving one
-- from the title is what makes this stable: slugSharesBase("about-2",
-- "about") is true, so the next ordinary save of the row keeps the address
-- this migration gave it instead of moving it again.
--
-- One row at a time, because each new slug has to be visible to the next
-- row's collision check — two games both slugged "about" must become
-- "about-2" and "about-3", and the UNIQUE constraints are checked row by row.
-- This is a repair on a handful of rows, not a pass over the catalogue, so
-- the loop costs nothing that matters; 0035 had to decide every row's slug in
-- one statement precisely because it touched all of them.
--
-- The new slug goes into the history table too. "game_slugs" and "news_slugs"
-- hold every slug an entity has ever answered at *including the current one*
-- (see 0021 and the INSERT at the end of 0035), so an entity missing from its
-- own history is invisible to resolveSlug's collision check and to
-- findCurrentSlug's redirect.
--
-- The old reserved slug stays in the history table. It is unreachable — the
-- route that shadowed the game shadows the redirect the same way, for the
-- same reason — and history is what actually happened; deleting it would only
-- free an address nothing is allowed to take anyway.
--
-- Soft-deleted articles are included. "news"."slug" is UNIQUE over every row,
-- deleted or not, so a hidden article still holds the address against a live
-- one.
--
-- The lists below are hard-copied from utils/reserved-slugs.ts as it stood on
-- 2026-09-21, because they exist only in TypeScript: RESERVED_ROOT_PATHS is
-- assembled there from the routers, the genre enum and what is served out of
-- public/, and tests/utils/reserved-slugs.test.ts is what keeps that copy
-- honest. A name added there later needs its own migration if any row has
-- already taken it.
DO $$
DECLARE
  "reservedGames" TEXT[] := ARRAY[
    'login', 'logout', 'about', 'dmca',
    'how-to-play', 'privacy-policy', 'profile', 'random',
    'developers', 'publishers', 'years', 'letter',
    'year', 'developer', 'publisher', 'most-played',
    'game-lists', 'top-dos-games', 'best-rpg-games', 'best-action-games',
    'best-adventure-games', 'best-strategy-games', 'best-simulation-games', 'best-sports-games',
    'best-puzzle-games', 'best-horror-games', 'best-platformer-games', 'best-racing-games',
    'best-fighting-games', 'best-shooter-games', 'dos-games-1990s', 'dos-games-1980s',
    'healthz', 'games', 'comments', 'news',
    'robots', 'robots-txt', 'feed-xml', 'sitemap-xml',
    'sitemap-index-xml', 'css', 'js', 'fonts',
    'images', 'favicon-png', 'js-dos-html', 'site-webmanifest',
    'action', 'adventure', 'rpg', 'strategy',
    'simulation', 'sports', 'puzzle', 'horror',
    'platformer', 'racing', 'fighting', 'shooter',
    'other'
  ];
  "reservedNews" TEXT[] := ARRAY['new'];
  "row" RECORD;
  "candidate" TEXT;
  "suffix" INTEGER;
BEGIN
  FOR "row" IN
    SELECT "id", "slug" FROM "games"
    WHERE "slug" = ANY("reservedGames")
    ORDER BY "id"
  LOOP
    "suffix" := 2;

    LOOP
      "candidate" := "row"."slug" || '-' || "suffix";

      EXIT WHEN NOT ("candidate" = ANY("reservedGames"))
        AND NOT EXISTS (SELECT 1 FROM "games" WHERE "slug" = "candidate")
        AND NOT EXISTS (SELECT 1 FROM "game_slugs" WHERE "slug" = "candidate");

      "suffix" := "suffix" + 1;
    END LOOP;

    UPDATE "games" SET "slug" = "candidate" WHERE "id" = "row"."id";

    INSERT INTO "game_slugs" ("gameId", "slug")
    VALUES ("row"."id", "candidate");

    RAISE NOTICE 'Game % moved off the reserved slug "%" to "%".',
      "row"."id", "row"."slug", "candidate";
  END LOOP;

  FOR "row" IN
    SELECT "id", "slug" FROM "news"
    WHERE "slug" = ANY("reservedNews")
    ORDER BY "id"
  LOOP
    "suffix" := 2;

    LOOP
      "candidate" := "row"."slug" || '-' || "suffix";

      EXIT WHEN NOT ("candidate" = ANY("reservedNews"))
        AND NOT EXISTS (SELECT 1 FROM "news" WHERE "slug" = "candidate")
        AND NOT EXISTS (SELECT 1 FROM "news_slugs" WHERE "slug" = "candidate");

      "suffix" := "suffix" + 1;
    END LOOP;

    UPDATE "news" SET "slug" = "candidate" WHERE "id" = "row"."id";

    INSERT INTO "news_slugs" ("newsId", "slug")
    VALUES ("row"."id", "candidate");

    RAISE NOTICE 'Article % moved off the reserved slug "%" to "%".',
      "row"."id", "row"."slug", "candidate";
  END LOOP;
END $$;
