/**
 * The one place a title becomes an address.
 *
 * models/game.ts and models/news.ts each carried a byte-identical copy of
 * this, so a fix to one silently left the other behind — and the two are the
 * only slug generators the site has.
 *
 * Diacritics are folded onto the letter they decorate rather than stripped
 * along with everything else: the filter below keeps only [a-z0-9], so
 * "Pokémon" used to become "pok-mon" and "Café International"
 * "caf-international" — addresses that name neither the game nor anything a
 * reader would type or link. Postgres has had the "unaccent" extension
 * installed since the first migration for exactly this job and nothing ever
 * called it; doing the fold here instead keeps slug generation a pure
 * function, which is what resolveSlug's collision loop and the suite both
 * want from it.
 */

/**
 * The letters NFD cannot take apart, because they are not a base letter plus
 * a combining mark but letters in their own right. Without them "Große Reise"
 * folds to "gro-e-reise", losing the character in the middle of a word rather
 * than transliterating it.
 */
const LIGATURES: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  đ: "d",
  ð: "d",
  þ: "th",
  ł: "l",
  ı: "i",
};

const LIGATURE_PATTERN = new RegExp(
  `[${Object.keys(LIGATURES).join("")}]`,
  "g",
);

/** Postgres's unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";

/**
 * How many times a save is allowed to re-resolve its slug and try again.
 *
 * Each retry is one lost race. Two is already an unusual coincidence on a
 * catalogue edited by hand; five is generous enough that the limit exists to
 * stop an infinite loop rather than to give up on real work.
 */
const SLUG_ATTEMPTS = 5;

function isSlugCollision(error: unknown, constraints: readonly string[]): boolean {
  if (typeof error !== "object" || error === null) return false;

  const { code, constraint } = error as { code?: string; constraint?: string };

  // The constraint name is checked, not just the SQLSTATE: a unique violation
  // on anything else — a duplicate rating, a migration name — is a real error
  // and retrying it would only hide it behind five identical failures.
  return (
    code === UNIQUE_VIOLATION &&
    typeof constraint === "string" &&
    constraints.includes(constraint)
  );
}

/**
 * Runs a save that resolves its own slug, retrying if another save took that
 * slug in between.
 *
 * resolveSlug asks which slugs are taken and the INSERT then claims one, and
 * nothing held the gap between the two. Two saves of the same title arriving
 * together both read "doom" as free, and the second one lost: Postgres
 * refused it on the UNIQUE constraint and the admin got the 500 page with
 * their entry gone. The window is small and the writers are a handful of
 * admins, so it is rare — but it is the one place in these models where the
 * comments promise that a game and its slug history "can never disagree" and
 * the code did not actually deliver it.
 *
 * A retry rather than a lock, because the losing transaction only finds out
 * once the winner has committed — by which point the winning slug is in the
 * history table, so re-resolving picks the next free suffix and the second
 * attempt succeeds. `write` therefore has to resolve the slug itself on every
 * call, not take one resolved outside the loop.
 *
 * Only the named constraints are retried; every other unique violation is
 * rethrown untouched.
 */
export async function withResolvedSlug<T>(
  constraints: readonly string[],
  write: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write();
    } catch (error) {
      if (attempt >= SLUG_ATTEMPTS || !isSlugCollision(error, constraints)) {
        throw error;
      }
    }
  }
}

/**
 * Lowercases `title`, folds what it can onto ASCII, and joins what is left
 * with dashes. Returns "" for a title with nothing ASCII-able in it at all —
 * the callers supply their own fallback base for that.
 */
export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      // After the lowercasing, so the table only needs the lowercase forms.
      .replace(LIGATURE_PATTERN, (character) => LIGATURES[character]!)
      // NFD splits "é" into "e" plus a combining acute; the mark is dropped
      // on the next line, which leaves the plain letter rather than a dash.
      .normalize("NFD")
      // The Combining Diacritical Marks block — what decomposing a Latin
      // letter actually produces.
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
  );
}

/**
 * Whether `slug` is `base` itself or `base` with the numeric suffix
 * resolveSlug hands out on a collision ("doom", "doom-2", "doom-17"). Used on
 * update to tell a save that keeps the title from one that changes it — see
 * Game.resolveSlugForUpdate. "doom-ii" is a different base, not a suffix.
 */
export function slugSharesBase(slug: string, base: string): boolean {
  if (slug === base) return true;

  if (!slug.startsWith(`${base}-`)) return false;

  return /^[1-9]\d*$/.test(slug.slice(base.length + 1));
}

/** Satisfied by the pool and by a single client checked out of it. */
export interface SlugQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/**
 * Everything that differs between one sluggable table and the next.
 *
 * models/game.ts and models/news.ts carried a resolveSlug and a
 * resolveSlugForUpdate each, and the pair differed only in these six values —
 * the rest was the same collision loop, the same reserved-name guard and the
 * same "keep the address unless the title's base actually moved" rule, written
 * out twice. They had already drifted once: the news copy filters its current
 * slug lookup on "deletedAt IS NULL" and the game copy does not, which is
 * correct (0022 dropped that column from "games") and is exactly the kind of
 * difference that is invisible while the two are separate files.
 */
export interface SlugConfig {
  /** The table the entity itself lives in — read by resolveSlugForUpdate. */
  table: string;
  /** The table remembering every slug the entity has ever answered at. */
  historyTable: string;
  /** The column in `historyTable` pointing back at the entity. */
  foreignKey: string;
  /**
   * Slugs a route already answers at, which no entity may take — see
   * utils/reserved-slugs.ts.
   */
  reserved: ReadonlySet<string>;
  /** The base to use for a title with nothing ASCII-able in it at all. */
  fallbackBase: string;
  /**
   * Extra SQL ANDed onto the current-slug lookup to skip a soft-deleted row,
   * such as `AND "deletedAt" IS NULL`. Empty for a table with no such column.
   */
  liveFilter?: string;
  /**
   * Set when the entity's bare numeric id is an address too — the game route
   * still answers a legacy "/123" with a 301 to that game's slug (see "/:id"
   * in routes/home.ts). An all-digit base is then unavailable whenever some
   * *other* row has that id: a new game titled "5" used to be slugged "5", and
   * since a slug is looked up before an id, "/5" stopped redirecting to game 5
   * — an old link or bookmark silently opened a different game.
   */
  numericIdsAreAddresses?: boolean;
}

/** The largest value an "integer" id column holds. */
const MAX_INT4 = 2_147_483_647;

/**
 * A slug for `title` that no row of this table has ever used, suffixing "-2",
 * "-3" and so on when the plain one is taken.
 *
 * Two entities sharing a title used to collide on the UNIQUE constraint and
 * fail the save with a 500. `ownerId` excludes an entity's own history, so
 * renaming it back to an earlier title gives it its original address again.
 *
 * The history table is what is asked, not the live one: an address an entity
 * has given up still redirects to it (see findCurrentSlug in both models), so
 * handing it to somebody else would break that redirect rather than merely
 * duplicate a name.
 *
 * Asking the history alone is only complete because the history holds every
 * *live* slug as well, and for a long time nothing guaranteed that: the
 * models record a slug in the statement that makes it current, and a row
 * inserted by hand or imported with SQL had a live slug the history had never
 * seen. This called it free, the write collided with it on the live column,
 * and withResolvedSlug re-resolved the same answer until it gave up — a 500
 * for creating "Quake" beside a hand-inserted "quake", or renaming anything
 * onto it. The triggers from 0054 now record the slug on every insert and
 * every change to it, whatever makes the write, so the one query below is the
 * whole answer again.
 */
export async function resolveSlug(
  db: SlugQueryable,
  config: SlugConfig,
  title: string,
  ownerId?: number,
): Promise<string> {
  const base = slugify(title) || config.fallbackBase;

  const { rows } = await db.query(
    `SELECT "slug" FROM "${config.historyTable}"
       WHERE ("slug" = $1 OR "slug" LIKE $2)
         AND ($3::int IS NULL OR "${config.foreignKey}" <> $3::int)`,
    [base, `${base}-%`, ownerId ?? null],
  );

  const taken = new Set<string>(rows.map((row) => row.slug));

  // A reserved name is unavailable for the same reason a taken one is:
  // something already answers at that address. A game titled "About" used to
  // be handed the slug "about" and then vanish behind the About page, and an
  // article titled "New" behind the admin form at "/news/new". Only the base
  // can collide; "about-2" is nobody's route.
  if (config.reserved.has(base)) taken.add(base);

  // An all-digit base can also be somebody's *id*, which is an address of its
  // own on a table that sets numericIdsAreAddresses — see SlugConfig. One
  // extra query, and only for a title that is nothing but digits.
  if (
    config.numericIdsAreAddresses &&
    !taken.has(base) &&
    /^\d+$/.test(base) &&
    Number(base) <= MAX_INT4
  ) {
    const { rows: owners } = await db.query(
      `SELECT 1 FROM "${config.table}"
         WHERE "id" = $1 AND ($2::int IS NULL OR "id" <> $2::int)`,
      [Number(base), ownerId ?? null],
    );

    if (owners.length > 0) taken.add(base);
  }

  if (!taken.has(base)) return base;

  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix++;

  return `${base}-${suffix}`;
}

/**
 * The first slug each of `ids` ever answered at, by id.
 *
 * What a feed names an item by for good. routes/feed.ts used the current
 * address as the <guid>, and a rename moves the address — so every subscriber
 * was shown the renamed game or article as a new item. The first slug never
 * changes, still resolves (the history 301s it to wherever the entity lives
 * now), and for everything that has never been renamed it is exactly the guid
 * the feed has always published, so switching to it re-announces nothing.
 *
 * The first slug is the one with the lowest id, so this is only as right as
 * the order the history was written in. Each slug is recorded once, the
 * moment the entity first takes it — by the models, and by the triggers from
 * 0054 for any other write — so the one it took first keeps the lowest id
 * whatever it has been renamed to since, back and forth included.
 *
 * An id with no history row is absent from the map, and the caller falls back
 * to the current slug — which is that same first slug, by definition. Since
 * 0054 that takes a hand-written row whose slug was already in another
 * entity's history; see the note there.
 */
export async function findFirstSlugs(
  db: SlugQueryable,
  config: SlugConfig,
  ids: number[],
): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();

  const { rows } = await db.query(
    `SELECT DISTINCT ON ("${config.foreignKey}")
            "${config.foreignKey}" AS "ownerId", "slug"
       FROM "${config.historyTable}"
      WHERE "${config.foreignKey}" = ANY($1::int[])
      ORDER BY "${config.foreignKey}", "id"`,
    [ids],
  );

  return new Map(rows.map((row) => [Number(row.ownerId), String(row.slug)]));
}

/**
 * The slug an existing entity keeps, or moves to, when it is saved.
 *
 * update() used to call resolveSlug on every save, and resolveSlug hands out
 * the lowest free suffix. So a game created as "Doom" while another owned
 * "doom" got "doom-2" — and then, once the other game was deleted, an admin
 * fixing a typo in its description silently moved it to "doom": the old
 * address still redirected, but the canonical URL, the sitemap and the feed
 * all changed on an edit that had nothing to do with the title.
 *
 * The current slug is kept whenever it is the new title's base or that base
 * with a numeric suffix — see slugSharesBase. Only a title whose base actually
 * differs is re-resolved, which is when the address is meant to move.
 *
 * And it is kept whenever the title has not changed at all, whatever its
 * shape. The base test alone assumed every stored slug came from today's
 * slugify(), and the older ones did not: the SQL backfills in 0019 and 0035
 * and the JavaScript before diacritics were folded made "pok-mon" of
 * "Pokémon", where slugify() now makes "pokemon". Such a slug shares no base
 * with its own title, so the next save of *any* field — a typo fixed in the
 * description — moved the game's canonical URL, sitemap entry and feed link,
 * the exact thing this function exists to prevent. An unchanged title is an
 * edit that is not about the address.
 *
 * A row that is not there, or that `liveFilter` excludes, falls through to
 * resolveSlug, which is what a caller updating a soft-deleted entity should
 * get: there is no address to keep.
 */
export async function resolveSlugForUpdate(
  db: SlugQueryable,
  config: SlugConfig,
  title: string,
  ownerId: number,
): Promise<string> {
  const base = slugify(title) || config.fallbackBase;

  const { rows } = await db.query(
    `SELECT "slug", "title" FROM "${config.table}" WHERE "id" = $1${
      config.liveFilter ? ` ${config.liveFilter}` : ""
    }`,
    [ownerId],
  );

  const current: unknown = rows[0]?.slug;
  const currentTitle: unknown = rows[0]?.title;

  if (
    typeof current === "string" &&
    ((typeof currentTitle === "string" &&
      currentTitle.trim() === title.trim()) ||
      slugSharesBase(current, base))
  ) {
    return current;
  }

  return resolveSlug(db, config, title, ownerId);
}
