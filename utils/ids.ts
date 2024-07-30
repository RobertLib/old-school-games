/**
 * The id columns are integers, so anything else reaches Postgres as a cast
 * error ("invalid input syntax for type integer") and surfaces as a 500.
 *
 * parseInt is too forgiving to guard that: it reads "5abc" as 5, so a check
 * built on it passed while the original string travelled on to the query.
 */

/**
 * The largest value a Postgres "integer" column holds. A safe integer is not
 * a narrow enough test on its own: every id up to 2^53 cleared it and then
 * reached the database as "value out of range for type integer" — the same
 * 500 this module exists to prevent, only from the other end of the range.
 * Anything above this cannot name a row, so it is a 404, not a server fault.
 */
const MAX_INT4 = 2147483647;

export function parseId(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 && value <= MAX_INT4
      ? value
      : null;
  }

  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;

  const id = Number(value);

  return Number.isInteger(id) && id > 0 && id <= MAX_INT4 ? id : null;
}
