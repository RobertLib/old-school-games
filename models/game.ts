import Model, { type ModelData } from "./model.ts";
import db, { SEARCH_SIMILARITY_THRESHOLD } from "../db.ts";
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
  CATALOGUE_FACETS_TTL_MS,
  DEVELOPERS_KEY,
  FAILURE_TTL_MS,
  FEATURED_POOL_KEY,
  GAME_OF_THE_WEEK_KEY,
  LATEST_COMMENTS_KEY,
  MOST_DISCUSSED_KEY,
  MOST_PLAYED_GAMES_KEY,
  NON_EMPTY_LISTS_KEY,
  PUBLISHERS_KEY,
  RECENTLY_ADDED_KEY,
  TOP_RATED_GAMES_KEY,
  YEARS_KEY,
  sidebarCache,
} from "../utils/sidebar-cache.ts";
import { sanitizeHtml } from "../utils/sanitize-html.ts";
import {
  type SlugConfig,
  findFirstSlugs,
  resolveSlug,
  resolveSlugForUpdate,
  slugify,
  withResolvedSlug,
} from "../utils/slug.ts";
// The A–Z browse's one bucket that is not a letter — see the `letter` filter
// in buildGameFilters and utils/letter-buckets.ts.
import { DIGIT_BUCKET } from "../utils/letter-buckets.ts";
import { bumpCacheEpoch } from "../utils/cache-epoch.ts";
import { htmlToPlainText, truncateAtWord } from "../utils/html-text.ts";

/**
 * Five of these are nullable in the schema and were declared as plain
 * strings, which is a promise the database never made: "description" and
 * "stream" have been NULL-able since 0001, "manual" since 0007, "publisher"
 * since 0005 and "developer" since 0009, and serialize() below deliberately
 * writes NULL into them. Every consumer therefore had to be written as though
 * a null could arrive — buildGameFilters already tests `"publisher" IS NULL`,
 * findRandom already tests `"stream" IS NOT NULL` — while the type said it
 * could not, so nothing checked the ones that were not.
 */
interface GameData extends ModelData {
  title: string;
  slug: string;
  description: string | null;
  genre: string;
  release: number | null;
  developer: string | null;
  publisher: string | null;
  images: string[];
  stream: string | null;
  manual: string | null;
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
    // unconditionally turned a *sparse* payload into a wipe: any column the
    // request happened not to mention was overwritten with NULL.
    //
    // This is not the same as supporting partial updates, and the comment
    // here used to imply it was. Both callers below run validate() over the
    // result, which insists on a title and a genre, and update() then reads
    // `gameData.title!` to work out the game's slug — so an update that omits
    // either is refused, and one that omits any other column still blanks
    // nothing but is otherwise a full save. What this line actually buys is
    // that a payload carrying only the columns a form has is written as
    // itself: the admin form omits nothing today, and a caller that adds a
    // field to GameData without adding it to the form does not thereby erase
    // it from every game that is saved.
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

/**
 * Refuses a save that cannot produce a complete game.
 *
 * Applied to updates as well as creates, and deliberately: update() derives
 * the game's slug from `data.title` and Game.find groups by `genre`, so
 * neither is a column a save may leave to whatever happened to be there. A
 * caller holding one field it wants to change therefore has to send the title
 * and the genre with it — the routes read the game first and post the whole
 * form, which is what makes that the ordinary case rather than a burden.
 *
 * `Partial<GameData>` in the signature describes what serialize() hands over,
 * which is only the keys the caller sent; it is not a promise that a partial
 * payload is accepted.
 */
function validate(data: Partial<GameData>): void {
  if (!data.title || !data.genre) {
    throw new Error("Title and genre are required.");
  }
}

/**
 * The looser threshold behind the "did you mean…" suggestions — see
 * findTitleSuggestions. A rough guess beats an empty page there, so it is a
 * long way below the one the search itself applies.
 *
 * Clamped against that one rather than merely documented beside it. The two
 * numbers live in different files — this one here, the default every
 * connection carries in db.ts — and the whole point of the suggestions is to
 * answer a search that found nothing: matching at least as strictly as the
 * search did would make them either empty or a repeat of the results the page
 * has just said do not exist. Min() makes that relationship the code rather
 * than a comment, so lowering SEARCH_SIMILARITY_THRESHOLD below 0.1 takes
 * this with it instead of silently inverting the two.
 */
const SUGGESTION_SIMILARITY_THRESHOLD = Math.min(
  0.1,
  SEARCH_SIMILARITY_THRESHOLD,
);

/**
 * Runs one statement with pg_trgm's similarity threshold set to something
 * other than the site-wide default, for the length of a transaction.
 *
 * The fuzzy matches below used to be written `similarity(g."title", $n) >
 * 0.28`, which is correct and unindexable: the GIN trigram index from 0020
 * serves the `%` operator, and nothing at all serves a call to similarity() in
 * a WHERE clause. So every search — including the one behind every empty result
 * page, which then runs a second fuzzy query for suggestions — was a sequential
 * scan of the whole catalogue with a trigram score computed per row.
 *
 * `%` is the indexable form, and it compares against a session setting rather
 * than taking a threshold of its own, which is why this exists at all.
 *
 * It used to wrap *every* search. That made the hottest read on the site five
 * round trips — checkout, BEGIN, set_config, the query, COMMIT — and held a
 * connection out of a ten-strong pool for all of them, to set the same number
 * every time. db.ts now sends that number as a startup parameter, so every
 * connection is already at SEARCH_SIMILARITY_THRESHOLD and the search itself
 * is a plain pool.query again; what is left here is the one caller that wants
 * a *different* threshold. SET LOCAL still scopes it to the transaction, so a
 * pooled connection cannot carry the suggestion threshold back into the
 * ordinary searches that follow it. set_config with `is_local` is SET LOCAL as
 * a function call — SET itself takes no parameters, and interpolating a number
 * into SQL text is the one thing this file does not do anywhere else.
 *
 * `%` is ">=" where the old expression was ">", so a title scoring exactly the
 * threshold now matches. That is the only behavioural difference, and 0.28 is
 * not a score any real title lands on precisely.
 */
async function queryWithSimilarityThreshold(
  threshold: number,
  text: string,
  values: any[] = [],
): Promise<{ rows: any[] }> {
  const client = await db.connect();

  // A rollback that fails itself, kept so the release below can be told about
  // it. The failure was swallowed and the client handed back to the pool
  // anyway — and a client whose ROLLBACK did not go through is one whose
  // transaction state is unknown: still in a failed transaction, or holding
  // the SET LOCAL threshold this function exists to scope, or simply gone.
  // The next request to check it out inherits all of that. release(err) makes
  // pg destroy the client instead of pooling it, which is exactly what an
  // unknown state deserves.
  let rollbackError: Error | undefined;

  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('pg_trgm.similarity_threshold', $1, true)",
      [String(threshold)],
    );

    const result = await client.query(text, values);

    await client.query("COMMIT");

    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (failure) {
      rollbackError =
        failure instanceof Error ? failure : new Error(String(failure));
    }

    // The original error, not the rollback's: the rollback failing is a fact
    // about the connection, and the caller asked about the query.
    throw error;
  } finally {
    client.release(rollbackError);
  }
}

/**
 * How many votes' worth of doubt the "top rated" ranking applies to every
 * game — see findTopRated. Higher means more evidence is needed before a game
 * is allowed near the top; lower lets small vote counts swing the list.
 */
const RATING_CONFIDENCE_WEIGHT = 5;

/**
 * The site-wide mean the weighting below pulls every game towards, as a CTE
 * the queries that need it cross join in.
 *
 * Summed over "games" rather than averaged over "ratings", and the two are
 * the same number: SUM("ratingSum") is every vote on the site added up and
 * SUM("ratingCount") is how many there were, so the quotient is AVG over
 * "ratings" exactly. What it buys is the scan — one pass over the narrow
 * "games" rows instead of one over every vote ever cast, on a table that only
 * ever grows. Both columns come from 0042_games_rating_totals.sql, whose
 * trigger maintains them on every insert, update and delete against
 * "ratings", so they are not a cached approximation of the aggregate: they
 * are the aggregate.
 *
 * NULLIF, because a catalogue nobody has rated yet would otherwise divide by
 * zero. It answers NULL there, which is precisely what AVG over an empty
 * "ratings" answered, and the CASE below never reads the mean for a game with
 * no votes — so a site with no ratings at all still ranks every game rather
 * than dropping the lot. The aggregate has no GROUP BY, so it is always one
 * row: a CROSS JOIN against it cannot make a listing empty.
 */
const SITE_MEAN_CTE = `WITH "siteMean" AS (
      SELECT SUM("ratingSum")::numeric / NULLIF(SUM("ratingCount"), 0)
               AS "value"
      FROM "games"
    )`;

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
 * Read off the game's own row rather than aggregated out of "ratings". The
 * formula is unchanged — it was written `COUNT * AVG`, and count × average
 * *is* the sum, so g."ratingSum" is that product with the aggregate taken out
 * of it — but the query around it no longer needs a join to "ratings" or a
 * GROUP BY at all. That was the expensive half: the default ordering (the
 * homepage, every genre page, the curated lists) grouped the whole ratings
 * table per request and spilled the HashAggregate to disk, ~68ms against
 * 0.15ms for the index-only letter page beside it. See 0042, whose trigger is
 * what makes the two columns exact rather than a cache.
 *
 * Reads "siteMean", which the queries below cross join in only when the
 * ordering needs it.
 */
const WEIGHTED_RATING = `CASE
      WHEN g."ratingCount" = 0 THEN 0
      ELSE (g."ratingSum" + ${RATING_CONFIDENCE_WEIGHT} * "siteMean"."value")
           / (g."ratingCount" + ${RATING_CONFIDENCE_WEIGHT})
    END`;

/**
 * A game's plain average — what every listing selects as "averageRating" for
 * the star bars, and what the unsorted search ordering breaks ties on.
 *
 * This used to be two expressions: a joined COALESCE(AVG(r."rating"), 0) for
 * the listings, and a correlated subquery over "ratings" for the search
 * tie-break, which needed one because find() paged its results before the
 * aggregates were attached and the inner query had nothing to aggregate. Both
 * are now the same division of two columns on the row itself, so there is
 * nothing to correlate and nothing to group — see 0042 and SITE_MEAN_CTE
 * above for why the columns can be trusted to the last vote.
 *
 * The CASE, rather than a bare division, is what keeps an unrated game out of
 * a division by zero; it answers 0, which is where the old COALESCE(..., 0)
 * put it and what the views already render as "unrated". The ::numeric is on
 * the sum because both columns are INTEGER, and integer division would report
 * a game averaging 4.8 as 4.
 */
const AVERAGE_RATING = `CASE
      WHEN g."ratingCount" = 0 THEN 0
      ELSE g."ratingSum"::numeric / g."ratingCount"
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
 * How many rows one pruning statement may touch.
 *
 * Each sweep used to be a single statement over everything eligible, and
 * statements run under the pool's 15-second statement_timeout (db.ts). That
 * is fine for the trickle a daily sweep normally finds and not for a backlog —
 * and there is one waiting: 0031 gave every vote that existed then the same
 * "createdAt", so ninety days after that deploy the whole backlog of IP
 * addresses became eligible at once, for one UPDATE that fires the ratings
 * trigger per row. On a large enough table that statement times out, and being
 * all-or-nothing it then fails the same way on every boot and every day after:
 * nothing is ever scrubbed, the retention the privacy policy states is never
 * met, and each attempt holds those rows locked for fifteen seconds first.
 * Batches that each finish in milliseconds make progress whatever the backlog.
 */
const PRUNE_BATCH_SIZE = 5_000;

/**
 * Runs a pruning statement until a batch comes back short, returning the
 * rows touched in total. `sql` takes the retention in days as $1 and the batch
 * size as $2, and must pick its rows with a LIMIT so that one run touches at
 * most one batch.
 */
async function pruneInBatches(
  sql: string,
  days: number,
  batchSize: number,
): Promise<number> {
  let total = 0;

  for (;;) {
    const { rowCount } = await db.query(sql, [days, batchSize]);
    const touched = rowCount ?? 0;

    total += touched;

    // A short batch means nothing eligible is left. A full one might be the
    // last, and one more query that finds nothing is how that is learned.
    if (touched < batchSize) return total;
  }
}

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
 * — the writes below insert into it with ON CONFLICT DO NOTHING, and so does
 * the trigger 0054 puts on "games", so it should never surface, and it is
 * listed because a retry is the right answer if it ever does.
 *
 * "games_slug_key" is the one that does surface, and only on a lost race now.
 * It used to fire every time for a slug that was live but missing from the
 * history — a row inserted by hand — because resolveSlug asks the history
 * alone and called that slug free, so every retry resolved the same answer
 * and collided again. 0054's trigger keeps every live slug in the history, so
 * a retry here always has a different answer to find.
 *
 * Named rather than matched on the SQLSTATE alone, so that a unique violation
 * on anything else is raised rather than retried five times and hidden.
 */
const GAME_SLUG_CONSTRAINTS = ["games_slug_key", "game_slugs_slug_key"];

/**
 * What tells utils/slug.ts which table it is resolving a slug for. The whole
 * of the difference between a game's slug and an article's — see SlugConfig.
 *
 * No `liveFilter`: 0022_drop_unused_deleted_at.sql took "deletedAt" off
 * "games", so a game row that exists is a live one. "news" still has the
 * column and passes one.
 */
const GAME_SLUGS: SlugConfig = {
  table: "games",
  historyTable: "game_slugs",
  foreignKey: "gameId",
  reserved: RESERVED_GAME_SLUGS,
  fallbackBase: "game",
  // "/123" still answers with a 301 to game 123 — see numericIdsAreAddresses.
  numericIdsAreAddresses: true,
};

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
  // And the panel beside /comments, which embeds a title and a slug per game
  // for exactly the same reason — see MOST_DISCUSSED_KEY.
  sidebarCache.delete(MOST_DISCUSSED_KEY);
  // The facet lists: a save can add a developer, a publisher or a year that
  // was not in the catalogue before, and a delete can take the last game
  // behind one away — leaving the footer and the sitemap advertising a
  // listing page that now 404s. See DEVELOPERS_KEY.
  sidebarCache.delete(DEVELOPERS_KEY);
  sidebarCache.delete(PUBLISHERS_KEY);
  sidebarCache.delete(YEARS_KEY);
  // And which curated lists still have a game behind them. This was the last
  // sidebar entry a game write did not drop: deleting the last game of a
  // genre left views/left-sidebar.ejs offering a list whose page answers 404,
  // for up to the five minutes of its TTL — and only on the machine that did
  // the writing, because every other one was already dropping it on the epoch
  // bump below. See NON_EMPTY_LISTS_KEY.
  sidebarCache.delete(NON_EMPTY_LISTS_KEY);
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
  // Raw, for the trigram match, the relevance score and the exact-title
  // comparison — none of them reads its argument as a pattern.
  values.push(term);
  const termIndex = values.length;

  return {
    // `%` rather than `similarity(...) > 0.28`: same match, but it is the form
    // the trigram index can answer. The threshold is a session setting, and
    // db.ts puts it on every connection at startup — see
    // SEARCH_SIMILARITY_THRESHOLD there.
    sql: `(g."title" ILIKE $${likeIndex}
      OR g."developer" ILIKE $${likeIndex}
      OR g."publisher" ILIKE $${likeIndex}
      OR g."title" % $${termIndex})`,
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

/**
 * The filters a listing and its row count both understand.
 *
 * find() and count() have to agree exactly: the page says "showing 1-25 of
 * 312" and the pagination decides how many pages exist, so a filter one of
 * them applies and the other does not is a listing that advertises pages it
 * then answers with a 404. They were two copies of these eight branches —
 * identical apart from the order search sat in, which a comment in count()
 * had already had to apologise for — and getSitemapCounts is a third
 * rendering of the same rules in SQL, which is why the publisher branch
 * below and the publisher UNION arm there have to be read together.
 *
 * Pushes its parameters onto `values` and returns the fragments to AND, plus
 * the search condition, which find() also needs for its relevance ordering.
 */
interface GameFilters {
  genre?: string;
  letter?: string;
  developer?: string;
  publisher?: string;
  year?: number;
  releaseFrom?: number;
  releaseTo?: number;
  search?: string;
}

function buildGameFilters(
  {
    genre,
    letter,
    year,
    releaseFrom,
    releaseTo,
    search,
    developer,
    publisher,
  }: GameFilters,
  values: any[],
): { conditions: string[]; searchCondition: SearchCondition | null } {
  const conditions: string[] = [];
  let searchCondition: SearchCondition | null = null;

  if (genre) {
    conditions.push(`g."genre" = $${values.length + 1}`);
    values.push(genre.toUpperCase());
  }

  if (letter) {
    // By the first character of the slug, not of the title. A title is
    // whatever the admin typed, so "1942", "688 Attack Sub" and "Über Racer"
    // began with a character none of the twenty-six letter pages matched and
    // were listed on none of them. slugify() has folded every slug onto
    // [a-z0-9-], so every game falls into exactly one of the buckets
    // utils/letter-buckets.ts defines: a letter, or the digits.
    // getSitemapCounts groups its "letter" keys by these same two predicates,
    // and the two must not drift.
    //
    // Both are served by "idx_games_slug_pattern" (0055) — "slug"
    // text_pattern_ops, because a prefix match needs the column indexed in
    // byte order under any collation but C, the reasoning 0049 wrote out for
    // the title. The unique index on "slug" is collated and answers equality
    // alone. The letter pages used to be served by 0049's LOWER("title")
    // pattern index; nothing reads that one now, and 0055 drops it.
    const bucket = letter.toLowerCase();

    if (bucket === DIGIT_BUCKET) {
      // A range rather than ten LIKEs: every slug from "0" up to, and not
      // including, ":", which is the character after "9" in byte order — the
      // order ~>=~ and ~<~ compare in and the pattern index is kept in. A
      // literal, not a parameter, because it is a constant of the bucket.
      conditions.push(`(g."slug" ~>=~ '0' AND g."slug" ~<~ ':')`);
    } else {
      // Escaped like every other LIKE pattern here. The routes only ever pass
      // a single letter, but a model that builds a pattern out of its argument
      // cannot depend on its caller having checked: a "%" would match the
      // whole catalogue and a "_" any first character. Lowercased — every
      // slug is — before the escaping rather than after, so the backslash the
      // escaping adds is not touched.
      conditions.push(`g."slug" LIKE $${values.length + 1}`);
      values.push(`${escapeLikePattern(bucket)}%`);
    }
  }

  // `!== undefined` rather than truthiness, for all three. A year of 0 is not
  // "no year": asked for games from year 0, the answer is none, and the old
  // `if (year)` answered with the whole catalogue instead — which is how
  // "/year/0000" served every game as an indexable listing. routes/home.ts no
  // longer lets that address through at all; this makes the filter honest for
  // whatever else asks.
  if (year !== undefined) {
    conditions.push(`g."release" = $${values.length + 1}`);
    values.push(year);
  }

  if (releaseFrom !== undefined) {
    conditions.push(`g."release" >= $${values.length + 1}`);
    values.push(releaseFrom);
  }

  if (releaseTo !== undefined) {
    conditions.push(`g."release" <= $${values.length + 1}`);
    values.push(releaseTo);
  }

  if (search) {
    searchCondition = buildSearchCondition(search, values);

    if (searchCondition) {
      conditions.push(searchCondition.sql);
    }
  }

  if (developer) {
    conditions.push(`g."developer" = $${values.length + 1}`);
    values.push(developer);
  }

  if (publisher) {
    // A game with no publisher recorded is credited to its developer, so a
    // studio's page lists what it published as well as what it made.
    // getSitemapCounts counts the same way — COALESCE(NULLIF(...)) — and the
    // two must not drift.
    conditions.push(
      `(g."publisher" = $${values.length + 1} OR (g."developer" = $${
        values.length + 1
      } AND (g."publisher" IS NULL OR g."publisher" = '')))`,
    );
    values.push(publisher);
  }

  return { conditions, searchCondition };
}

/**
 * One row from a query that carries the rating totals, as a Game.
 *
 * Every listing here selects the average alongside the game's own columns,
 * and node-postgres hands a numeric back as a string — it has no lossless
 * JavaScript equivalent, so the driver does not guess. Eleven methods each
 * repeated the same lines to turn it back into a number, and the cost of that
 * was not the repetition: a query that grew the columns and a call site that
 * forgot one of the parses is a rating rendered as "NaN" or a star bar stuck
 * at zero, and nothing says so.
 *
 * "ratingCount" arrives as a real INTEGER column now (see 0042), so the
 * driver has already parsed it; parseInt is kept because the mocked suite and
 * any older caller still hand it over as the string COUNT(*) used to be, and
 * because this is the one place that decides what shape a Game's aggregates
 * have.
 */
function hydrate(row: any): Game {
  const game = new Game(row);

  game.averageRating = parseFloat(row.averageRating) || 0;
  game.ratingCount = parseInt(row.ratingCount, 10) || 0;

  return game;
}

/**
 * A game from a query that selected no rating aggregates at all.
 *
 * Three methods — findTitleSuggestions, findAdjacentGames and
 * findRecentForFeed — build their rows with `new Game(row)` because their
 * queries are `SELECT * FROM "games"` and have no averages to parse. That
 * left `averageRating` and `ratingCount` genuinely `undefined` on the
 * objects they returned, while every other method on this class hands back a
 * Game whose aggregates are numbers. The two fields are declared optional, so
 * nothing in the type system said which of the two kinds of Game a caller had
 * — and a template reaching for `game.ratingCount.toFixed(1)` on the wrong
 * one is a 500 nothing warns about.
 *
 * Zeroed rather than left out, because zero is what hydrate() produces for a
 * game with no votes and is what every view already renders as "unrated". A
 * game that does have votes is shown as unrated in these three places, which
 * it already was — the difference is that it is now a number rather than a
 * hole. The suggestion list, the prev/next links and the RSS feed render no
 * star bar, which is why none of them selects the average in the first place.
 *
 * Still zeroed after 0042, even though `SELECT *` now brings "ratingCount"
 * along as a column of its own: the average is the half that would have to be
 * computed, and a Game claiming twelve votes beside an average of 0 is a
 * worse answer than one that plainly says "unrated".
 */
function withoutRatings(row: any): Game {
  const game = new Game(row);

  game.averageRating = 0;
  game.ratingCount = 0;

  return game;
}

export default class Game extends Model {
  title!: string;
  slug!: string;
  // Nullable, as the columns are — see GameData.
  description!: string | null;
  genre!: string;
  release!: number | null;
  developer!: string | null;
  publisher!: string | null;
  images!: string[];
  stream!: string | null;
  manual!: string | null;
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
    // htmlToPlainText answers "" for a null, which is a real row here: the
    // column is nullable and the admin form leaves it empty often enough. The
    // card renders nothing rather than the string "null".
    return truncateAtWord(htmlToPlainText(this.description), SUMMARY_LENGTH);
  }

  /**
   * The genre enum's labels, one row each.
   *
   * unnest rather than the array literal this used to slice apart by hand.
   * enum_range comes back as the text "{ACTION,RPG,...}", and trimming the
   * braces and splitting on commas is not a parser: a label containing a
   * comma, a space or a quote is quoted in that literal, and the pieces
   * would have arrived with the quotes still on them and split down the
   * middle. Postgres already knows how to hand back one label per row.
   */
  static async getGenres(): Promise<string[]> {
    const { rows } = await db.query(
      "SELECT unnest(enum_range(NULL::GAME_GENRE))::text AS genre",
    );

    return rows.map((row) => row.genre as string);
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
   * and so on when the plain one is taken.
   *
   * The loop itself is in utils/slug.ts, which news shares — the two models
   * carried a copy each of this and of resolveSlugForUpdate below, and they
   * had already begun to differ. Kept as a static because the routes and the
   * suite call it by this name.
   */
  static async resolveSlug(title: string, gameId?: number): Promise<string> {
    return resolveSlug(db, GAME_SLUGS, title, gameId);
  }

  /**
   * The slug an existing game keeps, or moves to, when it is saved — see
   * resolveSlugForUpdate in utils/slug.ts for the rename that made this
   * necessary.
   */
  static async resolveSlugForUpdate(
    title: string,
    gameId: number,
  ): Promise<string> {
    return resolveSlugForUpdate(db, GAME_SLUGS, title, gameId);
  }

  /**
   * Where a game that once lived at `slug` can be found today, so a renamed
   * game's old URL redirects instead of 404ing.
   */
  /**
   * The first slug each of these games ever had — what the feed names them
   * by for good. See findFirstSlugs in utils/slug.ts.
   */
  static async findFirstSlugs(ids: number[]): Promise<Map<number, string>> {
    return findFirstSlugs(db, GAME_SLUGS, ids);
  }

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

    // The rejected value is deliberately not in the message. These strings
    // reach a log, and the routes above call this with whatever "?orderBy="
    // carried — so echoing it wrote an arbitrary visitor-supplied string into
    // error.log, where nothing escapes it and a log viewer may well render it.
    // Which field was refused is not the useful half anyway: the caller is the
    // one line of code that passed it.
    if (
      orderBy &&
      orderBy !== "rating" &&
      !VALID_ORDER_BY_FIELDS.includes(orderBy)
    ) {
      throw new Error("Invalid orderBy field");
    }
    if (orderDir && !VALID_ORDER_DIRS.includes(orderDir)) {
      throw new Error("Invalid orderDir");
    }

    // A page with no page size to measure it against used to be dropped in
    // silence: OFFSET is only applied inside the `limit` branch below, so
    // find({ page: 7 }) quietly answered with page 1 — the whole catalogue, in
    // fact, since there is no LIMIT either. Every caller on the site passes
    // both; this is for the next one that does not.
    if (page !== undefined && page > 1 && !limit) {
      throw new Error("Game.find needs a limit before it can offset a page");
    }

    const values: any[] = [];

    const direction =
      orderDir || (letter || year || developer || publisher ? "ASC" : "DESC");

    // Shared with count(), which has to select exactly this set of rows for
    // the page numbering to mean anything. See buildGameFilters.
    const { conditions: whereConditions, searchCondition } = buildGameFilters(
      {
        genre,
        letter,
        year,
        releaseFrom,
        releaseTo,
        search,
        developer,
        publisher,
      },
      values,
    );

    // Built before the statement around it, because whether the ordering
    // sorts on the rating aggregate is what decides the shape of the whole
    // query: an ordering that reads it has to aggregate before it can page,
    // and an ordering that does not must page first.
    let ranksByRating = false;
    let orderClause: string;

    if (orderBy === "rating") {
      ranksByRating = true;
      orderClause = `${WEIGHTED_RATING} ${direction}, g."id" ${direction}`;
    } else if (orderBy === "release") {
      /**
       * NULLS LAST in both directions, because a game with no year recorded
       * belongs after the dated ones whichever way they run. Postgres puts
       * NULLs *first* in a descending sort, so "Year ▼" — and /?orderBy=release,
       * which defaults to DESC off the filtered pages — led with every
       * undated game: with a tenth of the catalogue undated, the whole first
       * page had no year on it at all. ASC already put them last; saying so
       * keeps the two directions one rule rather than one rule and a default.
       *
       * No index for it, deliberately. idx_games_release (0014) is ASC NULLS
       * LAST, so the ascending sort still walks it (0.3ms on 20k games), but
       * nothing serves DESC NULLS LAST: the descending sort is a sequential
       * scan and a top-N sort, 10.6ms against the 1.2ms it cost when it
       * could walk the index backwards. That is the floor the default rating
       * ordering already pays on every homepage and genre view (0042 says
       * why that one cannot be indexed at all), for a sort a visitor has to
       * choose and whose pages are noindex; a filtered listing — a genre, a
       * letter, a studio — reaches its rows through its own index and sorts a
       * few hundred of them either way. An index on ("release" DESC NULLS
       * LAST, "id" DESC) would buy those ten milliseconds back for this one
       * listing and be one more thing to write on every save.
       */
      orderClause = `g."release" ${direction} NULLS LAST, g."id" ${direction}`;
    } else if (orderBy) {
      orderClause = `g."${orderBy}" ${direction}, g."id" ${direction}`;
    } else if (searchCondition) {
      // Unsorted search results are ranked by how well they match the query.
      // The average only separates equally relevant titles here — that is a
      // tie-break, not a "best games" claim, so it stays the plain one.
      orderClause = `${buildSearchRelevanceOrder(
        searchCondition,
        values,
      )}, ${AVERAGE_RATING} DESC, g."id" DESC`;
    } else if (letter || year || developer || publisher) {
      // Default ordering for different page types
      orderClause = `g."title" ${direction}, g."id" ${direction}`;
    } else {
      ranksByRating = true;
      orderClause = `${WEIGHTED_RATING} ${direction}, g."id" ${direction}`;
    }

    const whereClause =
      whereConditions.length > 0
        ? ` WHERE ${whereConditions.join(" AND ")}`
        : "";

    let paging = "";

    if (limit) {
      paging += ` LIMIT $${values.length + 1}`;
      values.push(limit);

      if (page) {
        const offset = (Math.max(1, page) - 1) * limit;
        paging += ` OFFSET $${values.length + 1}`;
        values.push(offset);
      }
    }

    let query: string;

    /**
     * Both shapes are now one scan of "games" with no join to "ratings", no
     * GROUP BY and no per-row subquery: "ratingSum" and "ratingCount" are
     * columns on the game, kept exact by the trigger 0042 installs. The
     * difference between them is only the site-wide mean, which is one extra
     * aggregate and is joined in solely for the orderings that rank on it.
     *
     * This is what the shapes used to be, and why. The rating ordering
     * grouped the whole "ratings" table per request — the ordering *was* the
     * aggregate, so there was no prefix of the catalogue a page could be
     * taken from first — which on 20k games was a disk-spilling HashAggregate
     * of ~68ms against 0.15ms for the index-only letter page rendered beside
     * it, on the homepage and every genre page and every curated list. Every
     * other ordering had already been rescued from that by paging over
     * "games" alone in a subquery and attaching a LATERAL aggregate to just
     * the twenty-five rows that survived. Neither dance is needed once the
     * totals are on the row: the ranking sorts on an expression over two
     * columns of "games", so it pages like any other ordering, and the
     * "averageRating" the views print is a division rather than an AVG.
     *
     * "ratingCount" is not re-aliased in either SELECT. It is a real column
     * now, so `g.*` already carries it under exactly the name hydrate() reads
     * and the views render — and selecting a second expression by that name
     * would leave two columns called "ratingCount" in the row, with the
     * driver's last-one-wins deciding which the page showed.
     */
    if (ranksByRating) {
      /**
       * The mean cross joins in, as it does in findTopRated: it is a
       * single-row aggregate, so this multiplies nothing — it only lets the
       * ORDER BY reference the value.
       */
      query = `
        ${SITE_MEAN_CTE}
        SELECT g.*, ${AVERAGE_RATING} as "averageRating"
        FROM "games" g
        CROSS JOIN "siteMean"
        ${whereClause}
        ORDER BY ${orderClause}${paging}`;
    } else if (letter) {
      /**
       * A letter page filters first and sorts what is left, and the CTE is
       * what makes it: MATERIALIZED is a fence the planner cannot see through.
       *
       * Left to itself it chose the other plan. ORDER BY title with LIMIT 25
       * looks cheapest walked straight off "idx_games_title_id" (0037), on the
       * assumption that matching titles are spread evenly through that order
       * and 25 of them will turn up early — but the ones starting with "y" are
       * all at the far end, so the walk read every title sorting before them
       * and discarded each one: /letter/y threw away 18,476 rows (~37k
       * buffers) on a 20k catalogue, while the same filter through the
       * pattern index 0049 built for it costs about 630. Collecting a letter's
       * games first and sorting a few hundred of them is cheap for any letter
       * and any ordering here, which is not true of the walk.
       *
       * The filter is on the slug now rather than the title (see the `letter`
       * branch of buildGameFilters), through "idx_games_slug_pattern" (0055)
       * rather than 0049's title index, and the fence is needed exactly as
       * much: a slug sorts the way its title does, so without it /letter/y
       * again walked "idx_games_title_id" and discarded 19,329 rows (19,429
       * buffers) on 20k games, against 203 through the pattern index. The
       * digits' page is a range over the same index: even seeded at 2,384 of
       * those 20k games, far more than a real catalogue opens with a digit,
       * collecting and sorting them took 1.6ms.
       */
      query = `
        WITH "letterGames" AS MATERIALIZED (
          SELECT g.* FROM "games" g
          ${whereClause}
        )
        SELECT g.*, ${AVERAGE_RATING} as "averageRating"
        FROM "letterGames" g
        ORDER BY ${orderClause}${paging}`;
    } else {
      /**
       * No mean at all. One aggregate over the whole catalogue is not worth
       * running for a listing sorted alphabetically, by year or by date, and
       * the ordering columns here are the game's own — so the LIMIT/OFFSET is
       * served straight from an index (see 0038 for "createdAt" and 0037 for
       * the title ordering).
       */
      query = `
        SELECT g.*, ${AVERAGE_RATING} as "averageRating"
        FROM "games" g
        ${whereClause}
        ORDER BY ${orderClause}${paging}`;
    }

    // A search matches with pg_trgm's "%", which reads its threshold from the
    // session — and db.ts sets that on every connection at startup, so this is
    // one plain query on the pool like every other listing here. See
    // SEARCH_SIMILARITY_THRESHOLD.
    const { rows } = await db.query(query, values);

    return rows.map(hydrate);
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
      // No join and no GROUP BY: the totals are columns on the game, kept
      // exact by the trigger from 0042 — see AVERAGE_RATING.
      `SELECT g.*, ${AVERAGE_RATING} as "averageRating"
       FROM "games" g
       WHERE g."id" = ANY($1)
       ORDER BY array_position($1, g."id")`,
      [numericIds],
    );

    return rows.map(hydrate);
  }

  // "Did you mean…" for searches that found nothing. Uses a much looser
  // trigram threshold than the search itself, because here a rough guess is
  // more useful than an empty page.
  //
  // Matched with "%" and scored with similarity(), which is the split that
  // makes this indexable: the operator picks the candidates through the GIN
  // index from 0020, and the score then only has to be computed for those.
  // Written as similarity() > 0.1 in the WHERE clause, it was a sequential
  // scan — and this runs on exactly the requests that already found nothing,
  // which is where a crawler walking made-up query strings ends up.
  static async findTitleSuggestions(
    search: string,
    limit: number = 5,
  ): Promise<Game[]> {
    const term = search.trim();

    if (!term) return [];

    const { rows } = await queryWithSimilarityThreshold(
      SUGGESTION_SIMILARITY_THRESHOLD,
      `SELECT * FROM "games"
       WHERE "title" % $1
       ORDER BY similarity("title", $1) DESC, "id" DESC
       LIMIT $2`,
      [term, limit],
    );

    // No aggregates in that SELECT, so they are stated rather than left
    // undefined — see withoutRatings.
    return rows.map(withoutRatings);
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
      // Only the id. ORDER BY RANDOM() cannot be served by an index, so this
      // reads every playable game whatever it selects — but it used to read
      // every playable game *and* every rating on the site, aggregate the
      // lot, sort the result at random and then throw all but one row away,
      // on a button a visitor can hold down. Narrowed to the one column the
      // draw needs, the scan carries no rating aggregate at all; the winner
      // is then fetched by primary key.
      `SELECT g."id"
       FROM "games" g
       WHERE g."stream" IS NOT NULL AND g."stream" <> ''${excludeClause}
       ORDER BY RANDOM()
       LIMIT 1`,
      values,
    );

    if (!rows[0]) return null;

    // Through findById rather than by selecting the row here, so the game
    // arrives shaped exactly as every other single-game lookup shapes it —
    // one place deciding what a Game carries instead of two that must agree.
    return Game.findById(rows[0].id);
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
   * `count` and `count * avg` are read off the game's own row now — see
   * AVERAGE_RATING and 0042 — so the inner join that used to keep unrated
   * games out is the WHERE below. Nothing about the arithmetic needs it: the
   * divisor is count + m, which is 5 at its smallest. It is the editorial
   * rule, that a game nobody has voted on cannot be one of the five
   * best-rated.
   */
  static async findTopRated(): Promise<Game[]> {
    const { rows } = await db.query(
      // `"ratingCount" > 0` is what the inner join to "ratings" used to be:
      // the rule that a game with no votes cannot sit in a list titled "top
      // rated". Written as a filter on the game's own row it needs no join at
      // all — see AVERAGE_RATING and 0042.
      //
      // The formula is the one WEIGHTED_RATING carries, spelled out here
      // because the weight arrives as a parameter rather than interpolated;
      // g."ratingSum" is the COUNT × AVG this used to compute.
      `${SITE_MEAN_CTE}
       SELECT g.*, ${AVERAGE_RATING} as "averageRating"
       FROM "games" g
       CROSS JOIN "siteMean" m
       WHERE g."ratingCount" > 0
       ORDER BY (g."ratingSum" + $1 * m."value")
                / (g."ratingCount" + $1) DESC, g."id" DESC
       LIMIT 5`,
      [RATING_CONFIDENCE_WEIGHT],
    );

    return rows.map(hydrate);
  }

  /** A random draw of well-rated games, straight from the database. */
  private static async loadFeaturedPool(size: number): Promise<Game[]> {
    const { rows } = await db.query(
      // `"ratingCount" > 0` is the eligibility rule the inner join to
      // "ratings" used to express — a game needs votes to be featured —
      // stated as a filter on the game's own row now that 0042 keeps the
      // totals there. Written out rather than left to the bar below, which
      // would not enforce it: an unrated game scores (0 + 5 * siteMean) / 5,
      // i.e. the site mean itself, and on a site whose mean is above 3.5 that
      // is every unrated game in the carousel.
      //
      // The bar is the weighted rating, not the plain average. A plain
      // AVG >= 3.5 let a single five-star vote put a game into the homepage
      // carousel — the exact failure findTopRated and findSimilar describe
      // fixing — while every other rating-ordered listing here pulls a game
      // towards the site mean until it has a few votes behind it. A WHERE
      // rather than the HAVING it used to be, because there is no grouping
      // left for a HAVING to apply to.
      `${SITE_MEAN_CTE}
       SELECT g.*, ${AVERAGE_RATING} as "averageRating"
       FROM "games" g
       CROSS JOIN "siteMean" m
       WHERE g."ratingCount" > 0
         AND (g."ratingSum" + $2 * m."value")
             / (g."ratingCount" + $2) >= 3.5
       ORDER BY RANDOM()
       LIMIT $1`,
      [size, RATING_CONFIDENCE_WEIGHT],
    );

    return rows.map(hydrate);
  }

  /**
   * Slides for the homepage carousel.
   *
   * The query behind this scans and randomly sorts the whole catalogue, and
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
      // A failure is remembered for a few seconds, as it is for every entry
      // the sidebar middleware loads. Left at the default, a rejection is
      // dropped from the cache — so with Postgres away every homepage view
      // ran this scan-and-sort again and waited out the pool's two-second
      // connection timeout to find out what the last one had just found. See
      // FAILURE_TTL_MS.
      FAILURE_TTL_MS,
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
      // A primary-key lookup and nothing else: the aggregate that used to
      // hang off it is two columns on the row — see AVERAGE_RATING and 0042.
      `SELECT g.*, ${AVERAGE_RATING} as "averageRating"
       FROM "games" g
       WHERE g."id" = $1`,
      [id],
    );

    if (!rows[0]) return null;

    const game = hydrate(rows[0]);

    return game;
  }

  static async findBySlug(slug: string): Promise<Game | null> {
    const { rows } = await db.query(
      // As findById: the unique index on "slug" answers the lookup, and the
      // rating totals ride along on the row 0042 put them on.
      `SELECT g.*, ${AVERAGE_RATING} as "averageRating"
       FROM "games" g
       WHERE g."slug" = $1`,
      [slug],
    );

    if (!rows[0]) return null;

    const game = hydrate(rows[0]);

    // Sanitized on the way out as well as on the way in, here and only here.
    // This is the lookup the game page renders from, and it prints the
    // description with <%- %> — the one place in views/games/ that does.
    // serialize() cleans every description the model writes, but a row that
    // did not arrive through it (inserted by hand, imported with SQL, stored
    // under an older and looser sanitizer config) went to the page exactly as
    // stored. DOMPurify is idempotent over its own output, so a clean
    // description comes back unchanged, for well under a millisecond on one
    // row; the listings, which never print the markup, are not charged for it.
    if (typeof game.description === "string") {
      game.description = sanitizeHtml(game.description);
    }

    return game;
  }

  // Takes GameFilters whole rather than naming each field again: the
  // argument list *is* find()'s filter set, and spelling it out twice is how
  // the two came to be kept in step by hand.
  static async count(filters: GameFilters = {}): Promise<number> {
    let query = 'SELECT COUNT(*) as total FROM "games" g';
    const values: any[] = [];

    // The very same builder find() uses — not a second copy of it kept in
    // step by hand, which is what these two were. See buildGameFilters.
    const { conditions: whereConditions } = buildGameFilters(filters, values);

    if (whereConditions.length > 0) {
      query += ` WHERE ${whereConditions.join(" AND ")}`;
    }

    // A plain query, like find(): the "%" in the search condition reads its
    // threshold from the session, and db.ts puts the same value on every
    // connection the pool hands out — which is also what guarantees these two
    // agree on which rows match. They must, or the page numbering describes a
    // different listing from the one served.
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
      `-- The letter pages' buckets, decided exactly as buildGameFilters
       -- decides them: the first character of the slug, with every leading
       -- digit sharing the one "0-9" page (see utils/letter-buckets.ts). It
       -- used to group on LOWER(LEFT("title", 1)), which counted "letter:1"
       -- and "letter:ü" for pages no route served while the games behind
       -- them were on none. "slug" is NOT NULL (0035), so nothing is left out.
       -- The digits' key is DIGIT_BUCKET, passed rather than spelled here so
       -- the key cannot drift from the address the route answers at.
       SELECT 'letter' AS kind,
              CASE WHEN "slug" ~>=~ '0' AND "slug" ~<~ ':' THEN $1
                   ELSE LEFT("slug", 1) END AS name,
              COUNT(*)::int AS count, MAX("updatedAt") AS lastmod
         FROM "games" GROUP BY 2
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
      [DIGIT_BUCKET],
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
      //
      // 0054's trigger records the same row again, and that is not a second
      // copy to keep in step: the trigger is what covers a row written by
      // anything other than this model, and here it finds its work done. It
      // fires only once the whole statement has run — AFTER triggers on a WITH
      // statement wait for every part of it — so the "history" row below is
      // already there, the trigger's ON CONFLICT writes nothing, and the first
      // slug in the history is this one.
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

    // Retried on a slug collision, as in create() above.
    const { rows } = await withResolvedSlug(GAME_SLUG_CONSTRAINTS, async () => {
      gameData.slug = await Game.resolveSlugForUpdate(gameData.title!, id);

      const fields = Object.keys(gameData);
      const values = Object.values(gameData);

      // NOW() on the database's clock, as News.update stamps it and as
      // "createdAt" defaults. This used to be `new Date()` from the app's
      // clock, and the sitemap derives <lastmod> from MAX("updatedAt"), so any
      // skew between the two machines put a game's last change in the future
      // or before its own creation.
      const updateFields = [
        ...fields.map((field, index) => `"${field}" = $${index + 1}`),
        '"updatedAt" = NOW()',
      ].join(", ");

      values.push(id);

      // The new slug is recorded before the old one stops being current, so
      // the previous address keeps resolving to this game. 0054's trigger
      // records it too, at the end of this statement, and finds it here — see
      // the same note in create().
      //
      // The *outgoing* slug is not written here, because it is in the history
      // already: the trigger recorded it the moment it became live, however
      // it got there, and 0054 backfilled every row that had none. This
      // statement used to record it as well — a `previous` CTE, UNIONed with
      // `updated` into one INSERT — for a row that had not come through
      // create() and so had no history at all: renaming one recorded only the
      // new slug, and the address it had been published at went straight to a
      // 404. That arm had a fault of its own. Both of its rows were new, so
      // the UNION's output order decided which took the lower id, and a new
      // slug sorting first alphabetically took it: findFirstSlugs then named
      // the new address the game's first, and the feed, whose guid is that
      // first slug, announced the renamed game to every subscriber again.
      // With the outgoing slug recorded before this statement runs, the one
      // row below is the only one that can be new, so there is no order left
      // to get wrong.
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
      // Off the game's own row rather than out of "ratings". The trigger from
      // 0042 updates both columns in the same transaction as the vote, so the
      // answer this hands back to the browser that has just rated is as fresh
      // as the aggregate was — and it is one primary-key lookup instead of a
      // scan of that game's votes, on the one request every rating makes.
      //
      // A game that does not exist returns no row at all where the aggregate
      // returned one row of zeroes; the parses below turn both into the same
      // { 0, 0 }.
      `SELECT ${AVERAGE_RATING} as "averageRating", g."ratingCount"
       FROM "games" g WHERE g."id" = $1`,
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
    //
    // By "createdAt", not by "id", which is what this said while ordering by
    // the other thing. rate() upserts — a voter changing their mind on a game
    // they rated long ago refreshes "createdAt" and keeps the original "id" —
    // so a row's id says when the voter *first* rated that game and its
    // "createdAt" says when the vote it holds was cast. Past the cap the two
    // select different thousands, and the one the comment promises is the
    // second. "id" stays as the tie-break, for the votes that share a moment.
    const { rows } = await db.query(
      `SELECT "gameId", "rating" FROM "ratings"
       WHERE "voterId" = $1
       ORDER BY "createdAt" DESC, "id" DESC
       LIMIT 1000`,
      [voterId],
    );

    const ratings: Record<number, number> = {};

    for (const row of rows) {
      ratings[row.gameId] = parseInt(row.rating, 10);
    }

    return ratings;
  }

  /**
   * Every developer with a game behind it.
   *
   * Cached, like the two below it. A DISTINCT over the whole "games" table is
   * a sequential scan and a sort — there is no index that answers it — and
   * this ran on every request that needed it: routes/sitemap.ts asks for all
   * three to build the index, and the developer, publisher and year listings
   * ask on every page view. They describe the catalogue rather than list it,
   * so they change only when a game is saved, which is exactly when
   * clearGameCaches drops them. See DEVELOPERS_KEY.
   */
  static async getDevelopers(): Promise<string[]> {
    return sidebarCache.get(
      DEVELOPERS_KEY,
      CATALOGUE_FACETS_TTL_MS,
      async () => {
        const { rows } = await db.query(
          'SELECT DISTINCT "developer" FROM "games" WHERE "developer" IS NOT NULL AND "developer" != \'\' ORDER BY "developer" ASC',
        );

        return rows.map((row) => row.developer as string);
      },
      // As with the three widgets the sidebar middleware loads: a rejection
      // is dropped by default, so during an outage views/footer.ejs — which
      // renders on every page on the site — fired this sequential scan again
      // on every request, each one first waiting out the pool's two-second
      // connection timeout. See FAILURE_TTL_MS.
      FAILURE_TTL_MS,
    );
  }

  /** Every publisher, falling back to the developer where none is recorded. */
  static async getPublishers(): Promise<string[]> {
    return sidebarCache.get(
      PUBLISHERS_KEY,
      CATALOGUE_FACETS_TTL_MS,
      async () => {
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

        return rows.map((row) => row.name as string);
      },
      // See getDevelopers: this is the same scan twice over, and the same
      // doomed-query-per-request during an outage without it.
      FAILURE_TTL_MS,
    );
  }

  /** Every release year with a game in it, newest first. */
  static async getYears(): Promise<number[]> {
    return sidebarCache.get(
      YEARS_KEY,
      CATALOGUE_FACETS_TTL_MS,
      async () => {
        const { rows } = await db.query(`
        SELECT DISTINCT "release"
        FROM "games"
        WHERE "release" IS NOT NULL
        ORDER BY "release" DESC
      `);

        return rows.map((row) => row.release as number);
      },
      // See getDevelopers.
      FAILURE_TTL_MS,
    );
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
   * Every genre-mate is offered, voted on or not: there is no filter on the
   * rating totals here, and WEIGHTED_RATING scores an unrated game 0, which
   * puts it last in a descending sort exactly where the old LEFT JOIN and
   * "NULLS LAST" put it. "createdAt" and "id" break ties, so the strip cannot
   * reshuffle between requests.
   */
  static async findSimilar(
    gameId: number,
    genre: string,
    limit: number = 6,
  ): Promise<Game[]> {
    const query = `
      ${SITE_MEAN_CTE}
      SELECT g.*, ${AVERAGE_RATING} as "averageRating"
      FROM "games" g
      CROSS JOIN "siteMean"
      WHERE g."genre" = $1 AND g."id" != $2
      ORDER BY ${WEIGHTED_RATING} DESC, g."createdAt" DESC, g."id" DESC
      LIMIT $3
    `;

    const { rows } = await db.query(query, [genre, gameId, limit]);

    return rows.map(hydrate);
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
    //
    // As a row comparison, over the (LOWER("title"), "id") index 0051 builds
    // for exactly this. It used to be spelled out as an OR, on the belief that
    // the single-column index from 0027 would then serve the first branch — it
    // did not: an OR of two ranges is not an index condition, so the scan
    // started at the far end of the index and filtered its way to the
    // neighbour, about half the catalogue per query (~17k buffers on 20k
    // games), twice on every uncached game page. A row comparison whose
    // columns match an index's leading columns *is* an index condition, and
    // the neighbour is then the first entry either side: three buffers.
    const prevQuery = `
      SELECT * FROM "games"
      WHERE (LOWER("title"), "id") < (LOWER($1), $2)
      ORDER BY LOWER("title") DESC, "id" DESC
      LIMIT 1
    `;

    const nextQuery = `
      SELECT * FROM "games"
      WHERE (LOWER("title"), "id") > (LOWER($1), $2)
      ORDER BY LOWER("title") ASC, "id" ASC
      LIMIT 1
    `;

    const [prevResult, nextResult] = await Promise.all([
      db.query(prevQuery, [title, id]),
      db.query(nextQuery, [title, id]),
    ]);

    // withoutRatings rather than `new Game(row)`: neither query selects the
    // rating aggregates, and a Game carrying them as `undefined` is the one
    // shape nothing else on this class produces. See withoutRatings.
    const prevGame = prevResult.rows[0]
      ? withoutRatings(prevResult.rows[0])
      : null;
    const nextGame = nextResult.rows[0]
      ? withoutRatings(nextResult.rows[0])
      : null;

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
   *
   * It keeps the plain IN (subquery) that pruneRatingIps below had to give
   * up, because it never had that one's problem, and it was checked rather
   * than assumed. Its only predicate is the one the index is on, estimated
   * off that column's own histogram, and a pruned play is deleted rather than
   * blanked — so once a backlog is cleared the statistics say so, and there
   * is no second, correlated predicate for the planner to multiply against.
   * With 3M plays it walked the index in both states: 4 eligible rows cost
   * 24 buffers, and a batch of 5,000 from a backlog was an index walk plus
   * 5,000 primary-key probes (~4ms).
   */
  static async prunePlays(
    days: number = PLAY_RETENTION_DAYS,
    batchSize: number = PRUNE_BATCH_SIZE,
  ): Promise<number> {
    // In batches — see PRUNE_BATCH_SIZE.
    return pruneInBatches(
      `DELETE FROM "plays"
       WHERE "id" IN (
         SELECT "id" FROM "plays"
         WHERE "createdAt" < NOW() - make_interval(days => $1::int)
         LIMIT $2
       )`,
      days,
      batchSize,
    );
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
   * nothing — which is most of them — costs almost nothing. That is a claim
   * the statement below has to be written to keep; see there.
   */
  static async pruneRatingIps(
    days: number = RATING_IP_RETENTION_DAYS,
    batchSize: number = PRUNE_BATCH_SIZE,
  ): Promise<number> {
    // In batches — see PRUNE_BATCH_SIZE.
    //
    // The shape is what keeps the partial index in use, and the obvious one
    // did not. The two predicates are perfectly correlated — once the
    // backlog is gone, every vote past the window has already been scrubbed
    // — but the planner treats them as independent and multiplies their
    // selectivities, so on a table where half the votes are old and half
    // still carry an address it expected a quarter of the table to qualify.
    // Believing that, it chose a LIMITed sequential scan to collect the ids
    // (a quarter of the rows match, so the LIMIT should be reached early) and
    // a hash semi join that scanned the table a second time to apply them.
    // The LIMIT was never reached — next to nothing qualified — so the first
    // scan read the whole of "ratings" looking for rows that were not there,
    // and the join read it again. With 325k votes and 4 eligible that was
    // ~38ms and ~5.6k buffers, on every boot of every machine that
    // auto-starts and daily after that.
    //
    // Each half of this fixes one of the two scans, and neither is enough on
    // its own — measured, each alone still read the table once (~15-18ms):
    //
    //   - ORDER BY "createdAt" is the order the partial index is already in,
    //     so the id lookup walks the index and stops at the LIMIT instead of
    //     scanning for rows the planner thinks are everywhere. The oldest
    //     votes go first, which is the order the window expires them in.
    //   - = ANY(ARRAY(...)) makes that lookup a one-off InitPlan whose result
    //     is an array, which the outer UPDATE matches by primary key. As an
    //     IN (subquery) it is a join, and the join was the second scan.
    //
    // Together: 0.04ms and under a hundred buffers for the same four rows,
    // and a full batch of a backlog is a primary-key update of 5,000 rows.
    return pruneInBatches(
      `UPDATE "ratings" SET "ipAddress" = NULL
       WHERE "id" = ANY(ARRAY(
         SELECT "id" FROM "ratings"
         WHERE "ipAddress" IS NOT NULL
           AND "createdAt" < NOW() - make_interval(days => $1::int)
         ORDER BY "createdAt"
         LIMIT $2
       ))`,
      days,
      batchSize,
    );
  }

  static async findMostPlayed(
    limit: number = 5,
  ): Promise<(Game & { playCount: number })[]> {
    const { rows } = await db.query(
      // Plays are aggregated on their own before they meet the game, and the
      // ratings are not aggregated at all any more. Joined to "games"
      // directly, the two one-to-many joins multiplied out — every play row
      // against every rating row of the same game — and COUNT(DISTINCT …)
      // then counted its way back out of a set of plays × ratings rows. The
      // numbers were right; the work was not: a game with twenty thousand
      // plays and two hundred votes alone put four million rows through the
      // aggregate. Pre-aggregating each side fixed that, and 0042 removes the
      // ratings half of it outright: the totals are columns on the game, so
      // the second GROUP BY over the whole "ratings" table is gone and only
      // the plays one remains. /most-played runs this over the whole
      // catalogue on every cache refill and every admin write.
      `SELECT g.*, ${AVERAGE_RATING} as "averageRating",
              p."playCount"
       FROM "games" g
       INNER JOIN (
         SELECT "gameId", COUNT(*) as "playCount"
         FROM "plays"
         GROUP BY "gameId"
       ) p ON p."gameId" = g.id
       -- g."id" breaks ties, as everywhere else here. Without it Postgres
       -- returns games on the same play count in whatever order the scan
       -- reached them, which it is free to vary between runs: /most-played
       -- renders a hundred rows, and the long tail of games sharing a count
       -- reshuffled every time the five-minute cache refilled.
       ORDER BY p."playCount" DESC, g."id" DESC
       LIMIT $1`,
      [limit],
    );

    return rows.map((row) => {
      // The one listing with a third aggregate of its own; the two shared
      // ones still go through hydrate.
      const game = hydrate(row) as Game & { playCount: number };
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

    // As in findTitleSuggestions: the feed renders no star bar, so this
    // selects no aggregates — see withoutRatings.
    return rows.map(withoutRatings);
  }
}
