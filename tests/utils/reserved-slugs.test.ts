import { describe, expect, it } from "vitest";
import { readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { slugify } from "../../utils/slug.ts";
import {
  RESERVED_GAME_SLUGS,
  RESERVED_NEWS_SLUGS,
} from "../../utils/reserved-slugs.ts";
import { LISTS } from "../../routes/lists.ts";
import Game from "../../models/game.ts";
import News from "../../models/news.ts";

/**
 * The reserved list is a copy of names that live in the routers, kept separate
 * so the models and the routes are not in an import cycle. Nothing keeps a
 * copy honest on its own, so these tests are what does: add a curated list or
 * a genre without reserving its slug and one of them fails.
 */
describe("reserved slugs", () => {
  it("covers every curated list slug", () => {
    for (const list of LISTS) {
      expect(
        RESERVED_GAME_SLUGS.has(list.slug),
        `"${list.slug}" is a route in routes/lists.ts but is not reserved`,
      ).toBe(true);
    }
  });

  it("covers every genre page", async () => {
    const genres = await Game.getGenres();

    expect(genres.length).toBeGreaterThan(0);

    for (const genre of genres) {
      const slug = genre.toLowerCase();

      expect(
        RESERVED_GAME_SLUGS.has(slug),
        `"/${slug}" is a genre page but "${slug}" is not reserved`,
      ).toBe(true);
    }
  });

  it("covers the fixed pages declared ahead of the game lookup", () => {
    for (const slug of [
      "about",
      "dmca",
      "how-to-play",
      "privacy-policy",
      "profile",
      "random",
      "developers",
      "publishers",
      "years",
      "most-played",
      "game-lists",
      // The prefixes of the two-segment filter routes. A game can never
      // collide with "/developer/id-Software" itself, but the segment is
      // reserved so the catalogue cannot shadow it — the same rule "letter"
      // and "year" have always had, and these two were left out of it.
      "letter",
      "year",
      "developer",
      "publisher",
      // Answered in app.ts above every router, so a game slugging to it would
      // be unreachable while its own canonical tag went on advertising it.
      "healthz",
      "login",
      "logout",
      "games",
      "comments",
      "news",
    ]) {
      expect(RESERVED_GAME_SLUGS.has(slug), `"${slug}" is not reserved`).toBe(
        true,
      );
    }
  });

  it("leaves ordinary game titles alone", () => {
    for (const title of ["Doom", "The Secret of Monkey Island", "X-COM"]) {
      expect(RESERVED_GAME_SLUGS.has(Game.createSlug(title))).toBe(false);
    }
  });
});

describe("Game.resolveSlug", () => {
  it("suffixes a title that would land on an existing route", async () => {
    // "About" slugs to "about", where routes/home.ts already answers with the
    // About page — the game would have been unreachable at its own address.
    await expect(Game.resolveSlug("About")).resolves.toBe("about-2");
    await expect(Game.resolveSlug("Most Played")).resolves.toBe(
      "most-played-2",
    );
    await expect(Game.resolveSlug("Action")).resolves.toBe("action-2");
    await expect(Game.resolveSlug("Top DOS Games")).resolves.toBe(
      "top-dos-games-2",
    );
  });

  it("still gives an unreserved title its plain slug", async () => {
    await expect(Game.resolveSlug("Doom")).resolves.toBe("doom");
  });
});

describe("News.resolveSlug", () => {
  it("suffixes an article that would land on the admin form", async () => {
    // "/news/new" is declared ahead of "/news/:slug".
    await expect(News.resolveSlug("New")).resolves.toBe("new-2");
  });

  it("still gives an unreserved title its plain slug", async () => {
    await expect(News.resolveSlug("Site update")).resolves.toBe("site-update");
  });

  it("does not reserve the game route names, which live at the root", async () => {
    await expect(News.resolveSlug("About")).resolves.toBe("about");
  });
});

describe("RESERVED_NEWS_SLUGS", () => {
  it("reserves the admin form", () => {
    expect(RESERVED_NEWS_SLUGS.has("new")).toBe(true);
  });
});

/**
 * utils/reserved-slugs.ts says this set is checked "against the directories
 * actually served out of public/". It was not — the list above is typed by
 * hand — so a new top-level file or folder there could shadow a game slug
 * without anything noticing. "site.webmanifest" was already missing.
 */
describe("reserved slugs cover what express.static serves at the root", () => {
  const PUBLIC_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../public",
  );

  const entries = readdirSync(PUBLIC_DIR).filter(
    (name) => !name.startsWith("."),
  );

  it("has entries to check", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)("reserves the address of public/%s", (name) => {
    const slug = slugify(name);

    expect(
      RESERVED_GAME_SLUGS.has(slug),
      `public/${name} is served at "/${name}" but "${slug}" is not reserved`,
    ).toBe(true);
  });
});
