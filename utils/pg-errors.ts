/** Postgres SQLSTATE for a foreign-key violation. */
export const FOREIGN_KEY_VIOLATION = "23503";

/**
 * Whether an error is Postgres refusing a row because the game it points at
 * is gone.
 *
 * A game can be deleted while someone still has its page open, so the row a
 * comment, a rating or a play refers to may have vanished by the time the
 * insert runs. Postgres reports that as a foreign-key violation, which is a
 * 404 rather than a server fault. Shared by routes/games.ts and
 * routes/comments.ts, which each used to carry their own copy.
 */
export function isMissingGameError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === FOREIGN_KEY_VIOLATION
  );
}
