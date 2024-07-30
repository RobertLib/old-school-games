import Model, { type ModelData } from "./model.ts";
import db from "../db.ts";
import { parseId } from "../utils/ids.ts";
import { RESERVED_GAME_SLUGS } from "../utils/reserved-slugs.ts";
// The sitemap and the RSS feed are both cached, so every write below drops
// both. The feed used to be left out, and a game added or renamed here stayed
// missing from /feed.xml until its 15-minute TTL happened to expire.
//
// From utils, not from the three routers that serve those documents. Reaching
// into the routes closed a models -> routes -> models import cycle that ran
// only because every edge of it happened to be read at request time rather
// than while the modules were evaluating — see utils/page-cache.ts.
import {
  clearFeedCache,
  clearMostPlayedCache,
  clearSitemapCache,
} from "../utils/page-cache.ts";
import {
  FEATURED_POOL_KEY,
  GAME_OF_THE_WEEK_KEY,
  LATEST_COMMENTS_KEY,
  MOST_PLAYED_GAMES_KEY,
  RECENTLY_ADDED_KEY,
  TOP_RATED_GAMES_KEY,
  sidebarCache,
} from "../utils/sidebar-cache.ts";
import { sanitizeHtml } from "../utils/sanitize-html.ts";
import { slugSharesBase, slugify, withResolvedSlug } from "../utils/slug.ts";
import { bumpCacheEpoch } from "../utils/cache-epoch.ts";
import { htmlToPlainText, truncateAtWord } from "../utils/html-text.ts";

interface GameData extends ModelData {
  title: string;
  slug: string;
  description: string;
  genre: string;
  release: number | null;
  developer: string;
  publisher: string;
  images: string[];
  stream: string;
  manual: string;
}

const properties: Record<
  keyof Omit<GameData, "id" | "createdAt" | "updatedAt" | "deletedAt">,
  "string" | "number" | "string[]"
> = {
  title: "string",
  slug: "string",
  description: "string",
  genre: "string",
  release: "number",
  developer: "string",
  publisher: "string",
  images: "string[]",
  stream: "string",
  manual: "string",
};

function serialize(data: Partial<GameData>): Partial<GameData> {
  const obj: Partial<GameData> = {};

  Object.entries(properties).forEach(([prop, type]) => {
    const key = prop as keyof GameData;

    // Only what the caller actually sent is written. Copying every property
    // unconditionally turned a partial update into a wipe: any column the
    // request happened not to mention was overwritten with NULL.
    if (!(key in data)) return;

    // Any blank string, not only the empty one. A "release" of "   " cleared
    // neither test and reached the INTEGER column as whitespace, which
    // Postgres refuses with "invalid input syntax for type integer" — a 500
    // for a form field the admin simply left alone. validateGame now hands
    // over the trimmed value, so this is the second line of defence rather
    // than the only one: the model is exported and called directly too.
    if (
      type === "number" &&
      typeof data[key] === "string" &&
      !(data[key] as string).trim()
    ) {
      obj[key] = null as any;
    } else if (key === "description" && typeof data[key] === "string") {
      obj[key] = sanitizeHtml(data[key] as string) as any;
    } else {
      obj[key] = data[key] as any;
    }
  });

  return obj;
}

function validate(data: Partial<GameData>): void {
  if (!data.title || !data.genre) {
    throw new Error("Title and genre are required.");
  }
}

// Trigram score above which a title counts as a match even though the query
// is not a substring of it — this is what makes "moneky island" find
// "The Secret of Monkey Island".
const SEARCH_SIMILARITY_THRESHOLD = 0.28;

/**
 * How many votes' worth of doubt the "top rated" ranking applies to every
 * game — see findTopRated. Higher means more evidence is needed before a game
 * is allowed near the top; lower lets small vote counts swing the list.
 */
const RATING_CONFIDENCE_WEIGHT = 5;

/**
 * The score a rating-ordered listing sorts on: each game's average pulled
 * towards the site-wide mean in proportion to how few votes back it up.
 *
 * The same formula findTopRated documents, and for the same reason — a lone
 * five-star vote otherwise outranks a game with two hundred votes averaging
 * 4.9. The sidebar widget had the weighting and the curated lists did not, so
 * /top-dos-games rendered the two beside each other disagreeing about which
 * game was the best on the site.
 *
 * A game nobody has voted on scores 0 rather than the site mean, which leaves
 * it at the bottom of a descending sort exactly where the plain average did.
 * The prior is the better estimate of an unknown game, but a page titled "top
 * rated" is not the place to float one above a game fifty people rated badly.
 *
 * Reads "siteMean", which find() joins in only when the ordering needs it.
 */
const WEIGHTED_RATING = `CASE
      WHEN COUNT(r."rating") = 0 THEN 0
      ELSE (COUNT(r."rating") * AVG(r."rating")
            + ${RATING_CONFIDENCE_WEIGHT} * "siteMean"."value")
           / (COUNT(r."rating") + ${RATING_CONFIDENCE_WEIGHT})
    END`;

/**
 * How many games the featured carousel draws its slides from, and how long
 * that pool is held — see findFeatured.
 */
const FEATURED_POOL_SIZE = 40;
const FEATURED_POOL_TTL = 5 * 60 * 1000;

/** How long a play record is kept — see prunePlays. */
const PLAY_RETENTION_DAYS = 365;

/**
 * How long the IP address behind a vote is kept — see pruneRatingIps.
 *
 * Shorter than the play window on purpose. A play row is anonymous (a game id
 * and a time), so keeping a year of them costs nobody anything; the address
 * on a rating identifies a person and is held for one reason only, which is
 * investigating a burst of votes while it is still recent. Three months
 * outlives any such investigation and is a retention period the privacy
 * policy can state plainly.
 */
const RATING_IP_RETENTION_DAYS = 90;

/**
 * How much of a description a listing card shows — see the `summary` getter.
 * The card template and the /collection JSON that backs the favourites cards
 * each had this number written into them, and they agreed only by luck.
 */
const SUMMARY_LENGTH = 250;

/**
 * The unique constraints a save may lose a race on, and the only violations
 * withResolvedSlug is allowed to retry.
 *
 * "games_slug_key" is what Postgres named the constraint that
 * 0008_add_slug_to_game.sql created as a column-level UNIQUE.
 * "game_slugs_slug_key" is the history table's own, from 0021_slug_history.sql
 * — the writes below insert into it with ON CONFLICT DO NOTHING, so it should
 * never surface, and it is listed because a retry is the right answer if it
 * ever does.
 *
 * Named rather than matched on the SQLSTATE alone, so that a unique violation
 * on anything else is raised rather than retried five times and hidden.
 */
const GAME_SLUG_CONSTRAINTS = ["games_slug_key", "game_slugs_slug_key"];

/**
 * Everything that goes stale when a game is added, changed or removed: the
 * sitemap (cached for a day), the RSS feed (fifteen minutes), the pool the
 * featured carousel draws from (five) and the sidebar's "Recently added"
 * widget (five). They were three separate pairs of calls at the bottom of
 * create, update and delete, which is how the feed came to be left out of one
 * of them.
 *
 * "Recently added" was the one left over after that: a save dropped the
 * sitemap, the feed and the carousel pool, and then left the widget whose
 * entire job is to show the newest games holding a list without the game just
 * added. Comments already dropped their own widget on write — this is the
 * same rule applied to the side that had not got it yet.
 */
function clearGameCaches(): void {
  clearSitemapCache();
  clearFeedCache();
  // The two rankings and the page built from one of them. A deleted game used
  // to be offered by all three for up to five minutes after it stopped
  // existing, so every one of those links answered a 404 — while the same
  // save had already dropped everything above.
  clearMostPlayedCache();
  sidebarCache.delete(FEATURED_POOL_KEY);
  sidebarCache.delete(RECENTLY_ADDED_KEY);
  sidebarCache.delete(MOST_PLAYED_GAMES_KEY);
  sidebarCache.delete(TOP_RATED_GAMES_KEY);
  // And the widget with the longest memory of all of them — an hour, against
  // five minutes for the lists above. See GAME_OF_THE_WEEK_KEY.
  sidebarCache.delete(GAME_OF_THE_WEEK_KEY);
  // The comments widget embeds each game's title and slug. A deleted game's
  // comments cascade away with it, and a renamed one keeps its old title in
  // the widget until the two-minute TTL runs out; this was the one widget a
  // game write did not drop.
  sidebarCache.delete(LATEST_COMMENTS_KEY);
  // And the same on every other machine — see utils/cache-epoch.ts.
  void bumpCacheEpoch();
}

interface SearchCondition {
  sql: string;
  likeIndex: number;
  termIndex: number;
  /** Kept for the relevance ordering, which needs a pattern of its own. */
  escapedTerm: string;
}

/**
 * Takes the wildcards out of a term that is about to become an ILIKE pattern.
 * Searching for "100%" otherwise matched every title containing "100", and a
 * lone "_" matched the entire catalogue. Backslash is Postgres's default LIKE
 * escape, so it needs escaping first.
 */
function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, "\\$&");
}

// Matches the query against the title, developer and publisher, plus a fuzzy
// trigram match on the title. Pushes its parameters onto `values` and returns
// the placeholder indexes so the caller can reuse them for relevance ordering.
function buildSearchCondition(
  search: string,
  values: any[],
): SearchCondition | null {
  const term = search.trim();

  if (!term) return null;

  const escapedTerm = escapeLikePattern(term);

  values.push(`%${escapedTerm}%`);
  const likeIndex = values.length;
  // Raw, for similarity() and the exact-title comparison — neither reads its
  // argument as a pattern.
  values.push(term);
  const termIndex = values.length;

  return {
    sql: `(g."title" ILIKE $${likeIndex}
      OR g."developer" ILIKE $${likeIndex}
      OR g."publisher" ILIKE $${likeIndex}
      OR similarity(g."title", $${termIndex}) > ${SEARCH_SIMILARITY_THRESHOLD})`,
    likeIndex,
    termIndex,
    escapedTerm,
  };
}

/**
 * Exact title first, then prefix matches, then substring matches, then fuzzy
 * matches ordered by trigram score. Without this, searching "doom" buries
 * Doom under every game whose description happens to mention it.
 *
 * Pushes the prefix pattern itself rather than taking it from the condition:
 * only the queries that rank results have an ORDER BY, and count() supplies
 * the same condition with no ordering at all. A parameter added up front went
 * unreferenced there, and Postgres rejects the statement over it.
 */
function buildSearchRelevanceOrder(
  condition: SearchCondition,
  values: any[],
): string {
  values.push(condition.escapedTerm);
  const prefixIndex = values.length;

  return `CASE
      WHEN LOWER(g."title") = LOWER($${condition.termIndex}) THEN 4
      WHEN g."title" ILIKE $${prefixIndex} || '%' THEN 3
      WHEN g."title" ILIKE $${condition.likeIndex} THEN 2
      WHEN g."developer" ILIKE $${condition.likeIndex}
        OR g."publisher" ILIKE $${condition.likeIndex} THEN 1
      ELSE 0
    END DESC, similarity(g."title", $${condition.termIndex}) DESC`;
}

export default class Game extends Model {
  title!: string;
  slug!: string;
  description!: string;
  genre!: string;
  release!: number | null;
  developer!: string;
  publisher!: string;
  images!: string[];
  stream!: string;
  manual!: string;
  averageRating?: number;
  ratingCount?: number;

  constructor(data: GameData) {
    super(data);

    Object.entries(properties).forEach(([prop]) => {
      const key = prop as keyof GameData;
      (this as any)[key] = data[key];
    });
  }

  /**
   * The artwork a listing shows, or "" when the game has none.
   *
   * The templates reached for images[0] directly, which is undefined for a
   * game with nothing recorded — and <img src=""> makes the browser resolve
   * the empty address against the current document and fetch the whole page
   * again as if it were an image. The column is NOT NULL DEFAULT '{}' so this
   * is never a crash, just a wasted request and a broken-image icon.
   *
   * find(Boolean) rather than [0], because a game whose first slot was left
   * blank still has usable artwork further along.
   */
  get cover(): string {
    return this.images?.find(Boolean) ?? "";
  }

  /**
   * The blurb a listing card shows: the description as plain text, cut to a
   * card's worth on a word boundary.
   *
   * The card template did this itself, with
   * `description.replaceAll("<br />", "").slice(0, 250)`, and both halves were
   * wrong. DOMPurify serialises a line break as "<br>", so the replace matched
   * nothing that the admin form had ever saved — it only ever cleaned up the
   * older rows still holding the literal "<br />" — and the survivors were
   * then escaped by <%= %> and displayed to the reader as the text "<br>".
   * Any description carrying markup at all also had its "&" stored as "&amp;"
   * and escaped a second time, so a card read "Sam &amp; Max".
   *
   * htmlToPlainText is what the rest of the site already derives plain text
   * with — routes/games.ts built this very string for the /collection JSON
   * that backs the favourites cards, so the two renderings of one card
   * disagreed. The ellipsis comes from truncateAtWord, which adds it only when
   * something was actually dropped; the template appended "..." to every card
   * unconditionally, including the short descriptions it had not cut.
   */
  get summary(): string {
    return truncateAtWord(htmlToPlainText(this.description), SUMMARY_LENGTH);
  }

  static async getGenres(): Promise<string[]> {
    const { rows } = await db.query(
      "SELECT enum_range(NULL::GAME_GENRE) AS genres",
    );

    return rows[0].genres.slice(1, -1).split(",");
  }

  /**
   * Delegates to utils/slug.ts, which news shares. The two had a copy each
   * and neither folded diacritics, so "Pokémon" addressed itself as
   * "pok-mon". Kept as a static because the routes and the suite call it.
   */
  static createSlug(title: string): string {
    return slugify(title);
  }

  /**
   * A slug for `title` that no other game has ever used, suffixing "-2", "-3"
   * and so on when the plain one is taken. Two games sharing a title used to
   * collide on the UNIQUE constraint and fail the save with a 500.
   *
   * `gameId` excludes a game's own history, so renaming a game back to an
   * earlier title gives it its original address again.
   */
  static async resolveSlug(
    title: string,
    gameId?: number,
  ): Promise<string> {
    const base = Game.createSlug(title) || "game";

    const { rows } = await db.query(
      `SELECT "slug" FROM "game_slugs"
       WHERE ("slug" = $1 OR "slug" LIKE $2)
         AND ($3::int IS NULL OR "gameId" <> $3::int)`,
      [base, `${base}-%`, gameId ?? null],
    );

    const taken = new Set<string>(rows.map((row) => row.slug));

    // A reserved name is unavailable for the same reason a taken one is:
    // something already answers at that address. A game titled "About" used
    // to be handed the slug "about" and then vanish behind the About page —
    // see utils/reserved-slugs.ts. Only the base can collide; "about-2" is
    // nobody's route.
    if (RESERVED_GAME_SLUGS.has(base)) taken.add(base);

    if (!taken.has(base)) return base;

    let suffix = 2;
    while (taken.has(`${base}-${suffix}`)) suffix++;

    return `${base}-${suffix}`;
  }

  /**
   * The slug an existing game keeps, or moves to, when it is saved.
   *
   * update() used to call resolveSlug on every save, and resolveSlug hands
   * out the lowest free suffix. So a game created as "Doom" while another
   * owned "doom" got "doom-2" — and then, once the other game was deleted, an
   * admin fixing a typo in its description silently moved it to "doom": the
   * old address still redirected, but the canonical URL, the sitemap and the
   * feed all changed on an edit that had nothing to do with the title.
   *
   * The current slug is kept whenever it is the new title's base or that base
   * with a numeric suffix. Only a title whose base actually differs is
   * re-resolved, which is when the address is meant to move.
   */
  static async resolveSlugForUpdate(
    title: string,
    gameId: number,
  ): Promise<string> {
    const base = Game.createSlug(title) || "game";

    const { rows } = await db.query(
      'SELECT "slug" FROM "games" WHERE "id" = $1',
      [gameId],
    );

    const current: unknown = rows[0]?.slug;

    if (typeof current === "string" && slugSharesBase(current, base)) {
      return current;
    }

    return Game.resolveSlug(title, gameId);
  }

  /**
   * Where a game that once lived at `slug` can be found today, so a renamed
   * game's old URL redirects instead of 404ing.
   */
  static async findCurrentSlug(slug: string): Promise<string | null> {
    const { rows } = await db.query(
      `SELECT g."slug" FROM "game_slugs" gs
       JOIN "games" g ON g."id" = gs."gameId"
       WHERE gs."slug" = $1`,
      [slug],
    );

    return rows[0]?.slug ?? null;
  }

  static async find({
    genre,
    letter,
    developer,
    publisher,
    year,
    releaseFrom,
    releaseTo,
    limit,
    orderBy,
    orderDir,
    page,
    search,
  }: {
    genre?: string;
    letter?: string;
    developer?: string;
    publisher?: string;
    year?: number;
    releaseFrom?: number;
    releaseTo?: number;
    limit?: number;
    orderBy?: string;
    orderDir?: string;
    page?: number;
    search?: string;
  } = {}): Promise<Game[]> {
    const VALID_ORDER_BY_FIELDS = ["createdAt", "release", "title"];
    const VALID_ORDER_DIRS = ["ASC", "DESC"];

    if (
      orderBy &&
      orderBy !== "rating" &&
      !VALID_ORDER_BY_FIELDS.includes(orderBy)
    ) {
      throw new Error(`Invalid orderBy field: ${orderBy}`);
    }
    if (orderDir && !VALID_ORDER_DIRS.includes(orderDir)) {
      throw new Error(`Invalid orderDir: ${orderDir}`);
    }

    const values: any[] = [];
    const whereConditions: string[] = [];
    let searchCondition: SearchCondition | null = null;

    const direction =
      orderDir || (letter || year || developer || publisher ? "ASC" : "DESC");

    if (genre) {
      whereConditions.push(`g."genre" = $${values.length + 1}`);
      values.push(genre.toUpperCase());
    }

    if (letter) {
      // Escaped like every other ILIKE pattern here. The routes only ever
      // pass a single letter, but a model that builds a pattern out of its
      // argument cannot depend on its caller having checked: a "%" would
      // match the whole catalogue and a "_" any first character.
      whereConditions.push(`g."title" ILIKE $${values.length + 1}`);
      values.push(`${escapeLikePattern(letter)}%`);
    }

    if (year) {
      whereConditions.push(`g."release" = $${values.length + 1}`);
      values.push(year);
    }

    if (releaseFrom) {
      whereConditions.push(`g."release" >= $${values.length + 1}`);
      values.push(releaseFrom);
    }

    if (releaseTo) {
      whereConditions.push(`g."release" <= $${values.length + 1}`);
      values.push(releaseTo);
    }

    if (search) {
      searchCondition = buildSearchCondition(search, values);

      if (searchCondition) {
        whereConditions.push(searchCondition.sql);
      }
    }

    if (developer) {
      whereConditions.push(`g."developer" = $${values.length + 1}`);
      values.push(developer);
    }

    if (publisher) {
      whereConditions.push(
        `(g."publisher" = $${values.length + 1} OR (g."developer" = $${
          values.length + 1
        } AND (g."publisher" IS NULL OR g."publisher" = '')))`,
      );
      values.push(publisher);
    }

    // Built before the statement around it, because whether the ordering
    // sorts on the rating is what decides whether the query has to join the
    // site-wide mean in at all.
    let ranksByRating = false;
    let orderClause: string;

    if (orderBy === "rating") {
      ranksByRating = true;
      orderClause = `${WEIGHTED_RATING} ${direction}, g."id" ${direction}`;
    } else if (orderBy) {
      orderClause = `g."${orderBy}" ${direction}, g."id" ${direction}`;
    } else if (searchCondition) {
      // Unsorted search results are ranked by how well they match the query.
      // The average only separates equally relevant titles here — that is a
      // tie-break, not a "best games" claim, so it stays the plain one.
      orderClause = `${buildSearchRelevanceOrder(
        searchCondition,
        values,
      )}, "averageRating" DESC, g."id" DESC`;
    } else if (letter || year || developer || publisher) {
      // Default ordering for different page types
      orderClause = `g."title" ${direction}, g."id" ${direction}`;
    } else {
      ranksByRating = true;
      orderClause = `${WEIGHTED_RATING} ${direction}, g."id" ${direction}`;
    }

    // The mean is one row over the whole "ratings" table, so it is joined in
    // only for the orderings that read it — a listing sorted by title or by
    // date should not pay for an aggregate it never looks at.
    let query = `
      ${
        ranksByRating
          ? `WITH "siteMean" AS (SELECT AVG("rating") AS "value" FROM "ratings")`
          : ""
      }
      SELECT g.*, COALESCE(AVG(r.rating), 0) as "averageRating",
             COUNT(r."rating") as "ratingCount"
      FROM "games" g
      LEFT JOIN "ratings" r ON g.id = r."gameId"
      ${ranksByRating ? `CROSS JOIN "siteMean"` : ""}
    `;

    if (whereConditions.length > 0) {
      query += ` WHERE ${whereConditions.join(" AND ")}`;
    }

    // The mean joins the group as it does in findTopRated. It is a single-row
    // cross join, so this changes no grouping — it only lets the ORDER BY
    // above reference the column outside an aggregate.
    query += ranksByRating
      ? ` GROUP BY g.id, "siteMean"."value"`
      : ` GROUP BY g.id`;

    query += ` ORDER BY ${orderClause}`;

    if (limit) {
      query += ` LIMIT $${values.length + 1}`;
      values.push(limit);

      if (page) {
        const offset = (Math.max(1, page) - 1) * limit;
        query += ` OFFSET $${values.length + 1}`;
        values.push(offset);
      }
    }

    const { rows } = await db.query(query, values);

    const games = rows.map((row) => {
      const game = new Game(row);
      game.averageRating = parseFloat(row.averageRating) || 0;
      game.ratingCount = parseInt(row.ratingCount, 10) || 0;
      return game;
    });

    return games;
  }

  // Hydrates the favourites / recently-played lists stored in the browser.
  // The browser keeps only ids, so titles, artwork and ratings are always
  // whatever the database says today.
  static async findByIds(ids: (string | number)[]): Promise<Game[]> {
    // parseId rather than parseInt: the list comes straight from localStorage,
    // so it is whatever the browser happens to be holding. parseInt read
    // "12abc" as 12, and accepted ids far past what an "integer" column can
    // store — which came back from Postgres as a range error, so one junk
    // entry in someone's favourites answered the whole request with a 500.
    const numericIds = ids
      .map((id) => parseId(id))
      .filter((id): id is number => id !== null)
      .slice(0, 100);

    if (numericIds.length === 0) return [];

    const { rows } = await db.query(
      `SELECT g.*, COALESCE(AVG(r.rating), 0) as "averageRating",
              COUNT(r."rating") as "ratingCount"
       FROM "games" g
       LEFT JOIN "ratings" r ON g.id = r."gameId"
       WHERE g."id" = ANY($1)
       GROUP BY g.id
       ORDER BY array_position($1, g."id")`,
      [numericIds],
    );

    return rows.map((row) => {
      const game = new Game(row);
      game.averageRating = parseFloat(row.averageRating) || 0;
      game.ratingCount = parseInt(row.ratingCount, 10) || 0;
      return game;
    });
  }

  // "Did you mean…" for searches that found nothing. Uses a much looser
  // trigram threshold than the search itself, because here a rough guess is
  // more useful than an empty page.
  static async findTitleSuggestions(
    search: string,
    limit: number = 5,
  ): Promise<Game[]> {
    const term = search.trim();

    if (!term) return [];

    const { rows } = await db.query(
      `SELECT * FROM "games"
       WHERE similarity("title", $1) > 0.1
       ORDER BY similarity("title", $1) DESC, "id" DESC
       LIMIT $2`,
      [term, limit],
    );

    return rows.map((row) => new Game(row));
  }

  // Backs the "Random game" button. Only playable games qualify — sending
  // someone to a game with no stream would make the button feel broken.
  static async findRandom(excludeId?: string | number): Promise<Game | null> {
    const values: any[] = [];
    let excludeClause = "";

    // parseId rather than a bare emptiness check, for the same reason
    // findByIds and the `letter` pattern below use it: this is exported and
    // the id ends up in an integer comparison, so a value Postgres cannot
    // cast comes back as "invalid input syntax for type integer" — a 500 for
    // a "?not=" that only ever says which game to skip. The single caller in
    // routes/home.ts happens to parse it first today; a model that builds a
    // query out of its argument cannot depend on that.
    const exclude = parseId(excludeId ?? null);

    if (exclude !== null) {
      values.push(exclude);
      excludeClause = ` AND g."id" <> $${values.length}`;
    }

    const { rows } = await db.query(
      `SELECT g.*, COALESCE(AVG(r.rating), 0) as "averageRating",
              COUNT(r."rating") as "ratingCount"
       FROM "games" g
       LEFT JOIN "ratings" r ON g.id = r."gameId"
       WHERE g."stream" IS NOT NULL AND g."stream" <> ''${excludeClause}
       GROUP BY g.id
       ORDER BY RANDOM()
       LIMIT 1`,
      values,
    );

    if (!rows[0]) return null;

    const game = new Game(rows[0]);
    game.averageRating = parseFloat(rows[0].averageRating) || 0;
    game.ratingCount = parseInt(rows[0].ratingCount, 10) || 0;

    return game;
  }

  /**
   * "images" comes along for the image sitemap routes/sitemap.ts builds from
   * this — the artwork is a real part of what a game page offers and none of
   * it was being submitted, so a catalogue of screenshots was invisible to
   * image search. It is the only column added: Google reads <image:loc> and
   * has ignored the caption, title and license tags since 2022.
   */
  static async findForSitemap(): Promise<
    { slug: string; updatedAt?: Date; images?: string[] }[]
  > {
    const { rows } = await db.query(
      'SELECT "slug", "updatedAt", "images" FROM "games" ORDER BY "id"',
    );

    return rows;
  }

  static async findRecentlyAdded(): Promise<Game[]> {
    const result = await Game.find({
      limit: 5,
      orderBy: "createdAt",
      orderDir: "DESC",
    });

    return result;
  }

  /**
   * The five best-rated games, ranked by a vote-weighted average rather than
   * the raw one.
   *
   * A plain AVG let a single five-star vote top the list over a game with a
   * hundred votes averaging 4.9 — and, because the join was a LEFT one, a
   * game with no votes at all could sit in a list titled "top rated". Each
   * game's average is pulled towards the site-wide mean in proportion to how
   * few votes back it up:
   *
   *   (count * avg + m * siteMean) / (count + m)
   *
   * At m = 5 a lone vote barely moves a game and fifty votes leave it
   * essentially untouched. Unlike a "HAVING COUNT >= n" cutoff this needs no
   * arbitrary threshold and cannot empty the widget.
   *
   * The inner join is what keeps unrated games out, and it also guarantees
   * COUNT >= 1 per row, so the divisor is never zero.
   */
  static async findTopRated(): Promise<Game[]> {
    const { rows } = await db.query(
      `WITH "siteMean" AS (SELECT AVG("rating") AS "value" FROM "ratings")
       SELECT g.*, AVG(r."rating") as "averageRating",
              COUNT(r."rating") as "ratingCount"
       FROM "games" g
       JOIN "ratings" r ON g."id" = r."gameId"
       CROSS JOIN "siteMean" m
       GROUP BY g."id", m."value"
       ORDER BY (COUNT(r."rating") * AVG(r."rating") + $1 * m."value")
                / (COUNT(r."rating") + $1) DESC, g."id" DESC
       LIMIT 5`,
      [RATING_CONFIDENCE_WEIGHT],
    );

    return rows.map((row) => {
      const game = new Game(row);
      game.averageRating = parseFloat(row.averageRating) || 0;
      game.ratingCount = parseInt(row.ratingCount, 10) || 0;
      return game;
    });
  }

  /** A random draw of well-rated games, straight from the database. */
  private static async loadFeaturedPool(size: number): Promise<Game[]> {
    const { rows } = await db.query(
      // INNER, not LEFT. A game with no ratings joins to a single NULL row,
      // so AVG(r.rating) is NULL and the HAVING below already discarded it —
      // the outer join was doing no work but saying the opposite of what the
      // query means. Written as an inner join, the filter reads as the
      // eligibility rule it is (a game needs votes averaging 3.5 to be
      // featured) rather than as a null quirk, and it matches findTopRated,
      // which makes the same requirement the same way.
      `SELECT g.*, AVG(r.rating) as "averageRating",
              COUNT(r."rating") as "ratingCount"
       FROM "games" g
       JOIN "ratings" r ON g.id = r."gameId"
       GROUP BY g.id
       HAVING AVG(r.rating) >= 3.5
       ORDER BY RANDOM()
       LIMIT $1`,
      [size],
    );

    return rows.map((row) => {
      const game = new Game(row);
      game.averageRating = parseFloat(row.averageRating) || 0;
      game.ratingCount = parseInt(row.ratingCount, 10) || 0;
      return game;
    });
  }

  /**
   * Slides for the homepage carousel.
   *
   * The query behind this groups and sorts the whole catalogue at random, and
   * it was the one thing on the homepage with no cache in front of it — every
   * single view paid for it, crawlers included. A pool several times the
   * carousel's size is held for a few minutes instead and the slides are
   * drawn from it per request, so each visitor still gets a different
   * carousel while the scan happens once per TTL rather than once per view.
   *
   * The writes below drop the pool, so a newly added game can appear in it
   * without waiting out the TTL.
   */
  static async findFeatured(limit: number = 8): Promise<Game[]> {
    // Asking for more than the pool holds would quietly narrow the draw, so
    // that case goes straight to the database instead.
    if (limit >= FEATURED_POOL_SIZE) {
      return Game.loadFeaturedPool(limit);
    }

    const pool = await sidebarCache.get(
      FEATURED_POOL_KEY,
      FEATURED_POOL_TTL,
      () => Game.loadFeaturedPool(FEATURED_POOL_SIZE),
    );

    // Fisher-Yates over a copy: every request holding this cache entry shares
    // the same array, so it must not be reordered in place.
    const draw = [...pool];

    for (let i = draw.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [draw[i], draw[j]] = [draw[j]!, draw[i]!];
    }

    return draw.slice(0, limit);
  }

  static async findById(id: number): Promise<Game | null> {
    const { rows } = await db.query(
      `SELECT g.*, COALESCE(AVG(r."rating"), 0) as "averageRating", COUNT(r."rating") as "ratingCount"
       FROM "games" g
       LEFT JOIN "ratings" r ON g."id" = r."gameId"
       WHERE g."id" = $1
       GROUP BY g.id`,
      [id],
    );

    if (!rows[0]) return null;

    const game = new Game(rows[0]);
    game.averageRating = parseFloat(rows[0].averageRating) || 0;
    game.ratingCount = parseInt(rows[0].ratingCount, 10) || 0;

    return game;
  }

  static async findBySlug(slug: string): Promise<Game | null> {
    const { rows } = await db.query(
      `SELECT g.*, COALESCE(AVG(r."rating"), 0) as "averageRating", COUNT(r."rating") as "ratingCount"
       FROM "games" g
       LEFT JOIN "ratings" r ON g."id" = r."gameId"
       WHERE g."slug" = $1
       GROUP BY g.id`,
      [slug],
    );

    if (!rows[0]) return null;

    const game = new Game(rows[0]);
    game.averageRating = parseFloat(rows[0].averageRating) || 0;
    game.ratingCount = parseInt(rows[0].ratingCount, 10) || 0;

    return game;
  }

  static async count({
    genre,
    letter,
    developer,
    publisher,
    year,
    releaseFrom,
    releaseTo,
    search,
  }: {
    genre?: string;
    letter?: string;
    developer?: string;
    publisher?: string;
    year?: number;
    releaseFrom?: number;
    releaseTo?: number;
    search?: string;
  } = {}): Promise<number> {
    let query = 'SELECT COUNT(*) as total FROM "games" g';
    const values: any[] = [];
    const whereConditions: string[] = [];

    if (genre) {
      whereConditions.push(`g."genre" = $${values.length + 1}`);
      values.push(genre.toUpperCase());
    }

    if (letter) {
      // Escaped like every other ILIKE pattern here. The routes only ever
      // pass a single letter, but a model that builds a pattern out of its
      // argument cannot depend on its caller having checked: a "%" would
      // match the whole catalogue and a "_" any first character.
      whereConditions.push(`g."title" ILIKE $${values.length + 1}`);
      values.push(`${escapeLikePattern(letter)}%`);
    }

    if (year) {
      whereConditions.push(`g."release" = $${values.length + 1}`);
      values.push(year);
    }

    if (releaseFrom) {
      whereConditions.push(`g."release" >= $${values.length + 1}`);
      values.push(releaseFrom);
    }

    if (releaseTo) {
      whereConditions.push(`g."release" <= $${values.length + 1}`);
      values.push(releaseTo);
    }

    // Built in the same order find() builds them, which it was not: search
    // sat below the two studio filters here and above them there. The WHERE
    // clause means the same thing either way — these are all ANDed — but the
    // two methods have to be read side by side whenever a filter is added,
    // and a difference that turns out to be cosmetic still costs the reading.
    if (search) {
      const searchCondition = buildSearchCondition(search, values);

      if (searchCondition) {
        whereConditions.push(searchCondition.sql);
      }
    }

    if (developer) {
      whereConditions.push(`g."developer" = $${values.length + 1}`);
      values.push(developer);
    }

    if (publisher) {
      whereConditions.push(
        `(g."publisher" = $${values.length + 1} OR (g."developer" = $${
          values.length + 1
        } AND (g."publisher" IS NULL OR g."publisher" = '')))`,
      );
      values.push(publisher);
    }

    if (whereConditions.length > 0) {
      query += ` WHERE ${whereConditions.join(" AND ")}`;
    }

    const { rows } = await db.query(query, values);
    return parseInt(rows[0].total, 10);
  }

  /**
   * How many games sit behind every letter, genre, developer, publisher and
   * year page, and when each of those pages last changed — both keyed
   * "<kind>:<value>", the shape the sitemap indexes by.
   *
   * The sitemap used to ask count() once per value: 26 letters plus every
   * genre, every developer, every publisher and every year, fired at once
   * through a ten-connection pool. On a catalogue of any size that is several
   * hundred queries for one page, and clearing the cache on every save meant
   * paying it again. They are all the same GROUP BY over "games", so this
   * asks once.
   *
   * `lastmods` rides along on that one GROUP BY rather than in a query of its
   * own, and that is the whole reason it is here instead of in a method
   * beside this one: the five branches below each restate the WHERE clause
   * count() builds for that filter, and a second query would be a sixth,
   * seventh and eighth copy of them to keep in step. A listing page is as
   * fresh as the newest game on it, which is what MAX("updatedAt") per group
   * says. The column is NOT NULL, so a group that exists always has one.
   *
   * Each branch mirrors the WHERE clause count() builds for that filter —
   * including the publisher one, which credits a game to its developer when
   * no publisher is recorded.
   */
  static async getSitemapCounts(): Promise<{
    counts: Map<string, number>;
    lastmods: Map<string, string>;
  }> {
    const { rows } = await db.query(
      `SELECT 'letter' AS kind, LOWER(LEFT("title", 1)) AS name,
              COUNT(*)::int AS count, MAX("updatedAt") AS lastmod
         FROM "games" WHERE "title" IS NOT NULL AND "title" <> '' GROUP BY 2
       UNION ALL
       SELECT 'genre', "genre"::text, COUNT(*)::int, MAX("updatedAt")
         FROM "games" WHERE "genre" IS NOT NULL GROUP BY 2
       UNION ALL
       SELECT 'developer', "developer", COUNT(*)::int, MAX("updatedAt")
         FROM "games"
         WHERE "developer" IS NOT NULL AND "developer" <> '' GROUP BY 2
       UNION ALL
       SELECT 'publisher', COALESCE(NULLIF("publisher", ''), "developer"),
              COUNT(*)::int, MAX("updatedAt")
         FROM "games"
         WHERE COALESCE(NULLIF("publisher", ''), "developer") IS NOT NULL
           AND COALESCE(NULLIF("publisher", ''), "developer") <> ''
         GROUP BY 2
       UNION ALL
       SELECT 'year', "release"::text, COUNT(*)::int, MAX("updatedAt")
         FROM "games" WHERE "release" IS NOT NULL GROUP BY 2`,
    );

    const counts = new Map<string, number>();
    const lastmods = new Map<string, string>();

    for (const row of rows) {
      const key = `${row.kind}:${row.name}`;

      counts.set(key, Number(row.count) || 0);

      // Guarded even though the column is NOT NULL: node-postgres hands back
      // whatever the driver parsed, and a row this method invented (an empty
      // group can't occur, but a future branch over a LEFT JOIN could) would
      // otherwise put "Invalid Date" into the sitemap.
      const lastmod = row.lastmod ? new Date(row.lastmod) : null;

      if (lastmod && !Number.isNaN(lastmod.getTime())) {
        lastmods.set(key, lastmod.toISOString());
      }
    }

    return { counts, lastmods };
  }

  static async create(data: Partial<GameData>): Promise<{ id: number }> {
    const gameData = serialize(data);

    validate(gameData);

    // Inside the retry, not before it: resolveSlug reads which slugs are
    // taken and the INSERT below claims one, and a save that lost that race
    // has to ask again to get the next free suffix. See withResolvedSlug.
    const { rows } = await withResolvedSlug(GAME_SLUG_CONSTRAINTS, async () => {
      gameData.slug = await Game.resolveSlug(gameData.title!);

      const fields = Object.keys(gameData);
      const values = Object.values(gameData);

      const quotedFields = fields.map((field) => `"${field}"`).join(", ");
      const placeholders = fields.map((_, index) => `$${index + 1}`).join(", ");

      // One statement, so the game and its slug-history row can never
      // disagree.
      return db.query(
        `WITH inserted AS (
         INSERT INTO "games" (${quotedFields}) VALUES (${placeholders})
         RETURNING "id", "slug"
       ), history AS (
         INSERT INTO "game_slugs" ("gameId", "slug")
         SELECT "id", "slug" FROM inserted
         ON CONFLICT ("slug") DO NOTHING
       )
       SELECT "id" FROM inserted`,
        values,
      );
    });

    clearGameCaches();

    return rows[0];
  }

  static async update(
    id: number,
    data: Partial<GameData>,
  ): Promise<{ id: number } | null> {
    const gameData = serialize(data);

    validate(gameData);

    gameData.updatedAt = new Date();

    // Retried on a slug collision, as in create() above.
    const { rows } = await withResolvedSlug(GAME_SLUG_CONSTRAINTS, async () => {
      gameData.slug = await Game.resolveSlugForUpdate(gameData.title!, id);

      const fields = Object.keys(gameData);
      const values = Object.values(gameData);

      const updateFields = fields
        .map((field, index) => `"${field}" = $${index + 1}`)
        .join(", ");

      values.push(id);

      // The new slug is recorded before the old one stops being current, so
      // the previous address keeps resolving to this game.
      return db.query(
        `WITH updated AS (
         UPDATE "games" SET ${updateFields} WHERE "id" = $${values.length}
         RETURNING "id", "slug"
       ), history AS (
         INSERT INTO "game_slugs" ("gameId", "slug")
         SELECT "id", "slug" FROM updated
         ON CONFLICT ("slug") DO NOTHING
       )
       SELECT "id" FROM updated`,
        values,
      );
    });

    // No row matched that id. The route turns this into a 404; the signature
    // used to promise a game either way.
    if (!rows[0]) return null;

    clearGameCaches();

    return rows[0];
  }

  /**
   * Removes a game, reporting whether there was one to remove.
   *
   * The signature used to promise nothing either way, so the route could not
   * tell a real deletion from a no-op and flashed "Game deleted successfully"
   * for an id that never existed — an admin acting on a stale page was told
   * the thing they were looking at had just been taken down.
   */
  static async delete(id: number): Promise<boolean> {
    const { rowCount } = await db.query(
      'DELETE FROM "games" WHERE "id" = $1',
      [id],
    );

    const deleted = (rowCount ?? 0) > 0;

    // Only when a row actually went. Clearing unconditionally threw away the
    // sitemap, both feeds and five widgets on behalf of a delete that changed
    // nothing — an admin double-clicking a stale button, or a crawler
    // replaying an old form post — and the sitemap is the better part of the
    // catalogue to rebuild.
    if (deleted) clearGameCaches();

    return deleted;
  }

  static async rate(
    id: number,
    voterId: string,
    rating: number,
    ip?: string,
  ): Promise<void> {
    await db.query(
      `INSERT INTO "ratings" ("gameId", "voterId", "ipAddress", "rating")
       VALUES ($1, $2, $3, $4)
       ON CONFLICT ("gameId", "voterId")
       DO UPDATE SET "rating" = $4, "ipAddress" = $3, "createdAt" = NOW()`,
      [id, voterId, ip ?? null, rating],
    );
  }

  static async getRatingSummary(
    id: number,
  ): Promise<{ averageRating: number; ratingCount: number }> {
    const { rows } = await db.query(
      `SELECT COALESCE(AVG("rating"), 0) as "averageRating",
              COUNT("rating") as "ratingCount"
       FROM "ratings" WHERE "gameId" = $1`,
      [id],
    );

    return {
      averageRating: parseFloat(rows[0]?.averageRating) || 0,
      ratingCount: parseInt(rows[0]?.ratingCount, 10) || 0,
    };
  }

  // Lets the stars show "you rated this 4" when a visitor comes back.
  static async getVoterRating(
    id: number,
    voterId: string,
  ): Promise<number | null> {
    const { rows } = await db.query(
      'SELECT "rating" FROM "ratings" WHERE "gameId" = $1 AND "voterId" = $2',
      [id, voterId],
    );

    return rows[0] ? parseInt(rows[0].rating, 10) : null;
  }

  // Every rating this browser has cast, so any page can highlight the stars
  // the visitor already picked with a single request.
  static async getVoterRatings(
    voterId: string,
  ): Promise<Record<number, number>> {
    // Ordered, so the 1000 the cap keeps are the 1000 most recently cast.
    // Without it Postgres returned whichever rows the scan reached first,
    // which it is free to vary between runs: a voter past the cap saw their
    // own stars lit on one page load and dark on the next.
    const { rows } = await db.query(
      `SELECT "gameId", "rating" FROM "ratings"
       WHERE "voterId" = $1
       ORDER BY "id" DESC
       LIMIT 1000`,
      [voterId],
    );

    const ratings: Record<number, number> = {};

    for (const row of rows) {
      ratings[row.gameId] = parseInt(row.rating, 10);
    }

    return ratings;
  }

  static async getDevelopers(): Promise<string[]> {
    const { rows } = await db.query(
      'SELECT DISTINCT "developer" FROM "games" WHERE "developer" IS NOT NULL AND "developer" != \'\' ORDER BY "developer" ASC',
    );

    return rows.map((row) => row.developer);
  }

  static async getPublishers(): Promise<string[]> {
    const { rows } = await db.query(`
      SELECT DISTINCT name FROM (
        SELECT "publisher" as name FROM "games"
        WHERE "publisher" IS NOT NULL AND "publisher" != ''
        UNION
        SELECT "developer" as name FROM "games"
        WHERE "developer" IS NOT NULL AND "developer" != ''
        AND ("publisher" IS NULL OR "publisher" = '')
      ) AS publishers
      ORDER BY name ASC
    `);

    return rows.map((row) => row.name);
  }

  static async getYears(): Promise<number[]> {
    const { rows } = await db.query(`
      SELECT DISTINCT "release"
      FROM "games"
      WHERE "release" IS NOT NULL
      ORDER BY "release" DESC
    `);

    return rows.map((row) => row.release);
  }

  /**
   * Other games in the same genre, best first — the "Similar games" strip on
   * every game's page.
   *
   * Ranked by WEIGHTED_RATING, like every other rating-ordered listing here.
   * It used to order on the raw `AVG(r."rating")`, which is the exact failure
   * the weighting was introduced to fix and which is written down twice
   * already: a single five-star vote outranked a game with two hundred votes
   * averaging 4.9. This was the one ranking left on the plain average, so a
   * reader on a game's page was shown a "similar games" strip led by
   * whichever obscure entry one person had rated once — beside a sidebar that
   * had the weighting and disagreed with it, which is the same visible
   * contradiction findTopRated's comment describes for /top-dos-games.
   *
   * The join stays LEFT: a genre-mate with no votes yet still belongs in the
   * strip, and WEIGHTED_RATING scores it 0, which puts it last in a
   * descending sort exactly where "NULLS LAST" used to. "createdAt" and "id"
   * break ties, so the strip cannot reshuffle between requests.
   */
  static async findSimilar(
    gameId: number,
    genre: string,
    limit: number = 6,
  ): Promise<Game[]> {
    const query = `
      WITH "siteMean" AS (SELECT AVG("rating") AS "value" FROM "ratings")
      SELECT g.*, COALESCE(AVG(r."rating"), 0) as "averageRating",
             COUNT(r."rating") as "ratingCount"
      FROM "games" g
      LEFT JOIN "ratings" r ON g."id" = r."gameId"
      CROSS JOIN "siteMean"
      WHERE g."genre" = $1 AND g."id" != $2
      GROUP BY g.id, "siteMean"."value"
      ORDER BY ${WEIGHTED_RATING} DESC, g."createdAt" DESC, g."id" DESC
      LIMIT $3
    `;

    const { rows } = await db.query(query, [genre, gameId, limit]);

    const games = rows.map((row) => {
      const game = new Game(row);
      game.averageRating = parseFloat(row.averageRating) || 0;
      game.ratingCount = parseInt(row.ratingCount, 10) || 0;
      return game;
    });

    return games;
  }

  static async findAdjacentGames(
    title: string,
    id: number,
  ): Promise<{ prevGame: Game | null; nextGame: Game | null }> {
    // Ordered by LOWER("title"), the same expression the filter compares on.
    // Ordering by the raw "title" while filtering on the lowercased one meant
    // the two disagreed: under the "C" collation every uppercase letter sorts
    // before every lowercase one, so the neighbour of "Doom" came back as
    // "alpha" rather than "Civilization". The functional index in
    // 0027_games_title_lower_index.sql serves both the filter and the sort.
    //
    // "id" breaks ties, in the filter as well as in the sort. Sorting on it
    // alone was not enough: a strict comparison on the title excluded every
    // game sharing this one's title, so two games called the same thing were
    // never each other's neighbour and one of them vanished from the chain.
    // Spelled out rather than as a row comparison, so the functional index on
    // LOWER("title") still serves the first branch.
    const prevQuery = `
      SELECT * FROM "games"
      WHERE LOWER("title") < LOWER($1)
         OR (LOWER("title") = LOWER($1) AND "id" < $2)
      ORDER BY LOWER("title") DESC, "id" DESC
      LIMIT 1
    `;

    const nextQuery = `
      SELECT * FROM "games"
      WHERE LOWER("title") > LOWER($1)
         OR (LOWER("title") = LOWER($1) AND "id" > $2)
      ORDER BY LOWER("title") ASC, "id" ASC
      LIMIT 1
    `;

    const [prevResult, nextResult] = await Promise.all([
      db.query(prevQuery, [title, id]),
      db.query(nextQuery, [title, id]),
    ]);

    const prevGame = prevResult.rows[0] ? new Game(prevResult.rows[0]) : null;
    const nextGame = nextResult.rows[0] ? new Game(nextResult.rows[0]) : null;

    return { prevGame, nextGame };
  }

  static async recordPlay(gameId: number): Promise<void> {
    await db.query('INSERT INTO "plays" ("gameId") VALUES ($1)', [gameId]);
  }

  /**
   * Drops play records past the retention window, returning how many went.
   *
   * "plays" is one row per game started and nothing ever removed them, so it
   * only grew — while findMostPlayed and /most-played aggregate the whole
   * table. A year is long enough for "most played" to still mean something
   * and short enough that the table stops being the largest thing in the
   * database.
   *
   * The scan is served by "idx_plays_createdAt", so a run that matches
   * nothing — which is most of them — costs almost nothing.
   */
  static async prunePlays(days: number = PLAY_RETENTION_DAYS): Promise<number> {
    const { rowCount } = await db.query(
      `DELETE FROM "plays"
       WHERE "createdAt" < NOW() - make_interval(days => $1::int)`,
      [days],
    );

    return rowCount ?? 0;
  }

  /**
   * Clears the IP address off votes past the retention window, returning how
   * many were scrubbed.
   *
   * The vote itself stays — the rating, the game and the voter id are what
   * every listing aggregates, and dropping the row would silently rewrite the
   * site's averages. Only the address goes, which is the part that is
   * personal data and the part nothing reads: "ipAddress" is written by
   * rate() and never appears in a WHERE clause or a SELECT anywhere in this
   * codebase.
   *
   * Served by the partial "idx_ratings_ip_retention", so a run that finds
   * nothing — which is most of them — costs almost nothing.
   */
  static async pruneRatingIps(
    days: number = RATING_IP_RETENTION_DAYS,
  ): Promise<number> {
    const { rowCount } = await db.query(
      `UPDATE "ratings" SET "ipAddress" = NULL
       WHERE "ipAddress" IS NOT NULL
         AND "createdAt" < NOW() - make_interval(days => $1::int)`,
      [days],
    );

    return rowCount ?? 0;
  }

  static async findMostPlayed(
    limit: number = 5,
  ): Promise<(Game & { playCount: number })[]> {
    const { rows } = await db.query(
      // DISTINCT matters: the ratings join multiplies the play rows, so a
      // plain COUNT(p.id) reported plays × ratings instead of plays.
      `SELECT g.*, COALESCE(AVG(r.rating), 0) as "averageRating",
              COUNT(DISTINCT p.id) as "playCount",
              COUNT(DISTINCT r.id) as "ratingCount"
       FROM "games" g
       INNER JOIN "plays" p ON g.id = p."gameId"
       LEFT JOIN "ratings" r ON g.id = r."gameId"
       GROUP BY g.id
       -- g."id" breaks ties, as everywhere else here. Without it Postgres
       -- returns games on the same play count in whatever order the scan
       -- reached them, which it is free to vary between runs: /most-played
       -- renders a hundred rows, and the long tail of games sharing a count
       -- reshuffled every time the five-minute cache refilled.
       ORDER BY "playCount" DESC, g."id" DESC
       LIMIT $1`,
      [limit],
    );

    return rows.map((row) => {
      const game = new Game(row) as Game & { playCount: number };
      game.averageRating = parseFloat(row.averageRating) || 0;
      game.ratingCount = parseInt(row.ratingCount, 10) || 0;
      game.playCount = parseInt(row.playCount, 10) || 0;
      return game;
    });
  }

  // Newest additions for the RSS feed — full rows so the feed can carry
  // descriptions and artwork.
  static async findRecentForFeed(limit: number = 20): Promise<Game[]> {
    const { rows } = await db.query(
      // Tie broken on "id", like the news queries: games imported in one
      // batch share a "createdAt", and without it the order among them is
      // undefined — so the feed could reshuffle its own items between builds
      // and readers would see the same games arrive twice.
      `SELECT * FROM "games" ORDER BY "createdAt" DESC, "id" DESC LIMIT $1`,
      [limit],
    );

    return rows.map((row) => new Game(row));
  }
}
