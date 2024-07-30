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
