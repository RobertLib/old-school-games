/**
 * Postgres SQLSTATE for a foreign-key violation. Not exported: the questions
 * anybody asks of it are the two below, and a bare code exported beside a
 * predicate only invites a third, hand-rolled copy of the check.
 */
const FOREIGN_KEY_VIOLATION = "23503";

/**
 * The named constraint behind each of the two violations a comment insert can
 * lose a race on.
 *
 * Postgres puts the constraint's name on the error, and it is the only thing
 * that tells the two apart: both are SQLSTATE 23503 on the same INSERT. The
 * names are what it assigned the column-level REFERENCES in 0001 and 0020
 * respectively — `\d comments` prints both.
 *
 * Distinguishing them matters because the answers differ. A vanished *game*
 * means the page the visitor is on no longer exists; a vanished *parent
 * comment* means a moderator deleted the comment they were replying to while
 * they were typing, and the game and its thread are still there. Reporting the
 * second as "Game not found", which is what a check on the SQLSTATE alone did,
 * sends somebody to look for a page that is fine.
 */
const COMMENT_GAME_CONSTRAINT = "comments_gameId_fkey";
const COMMENT_PARENT_CONSTRAINT = "comments_parentId_fkey";

/** What Postgres reports on a violated constraint, as much of it as is read. */
function violation(
  error: unknown,
): { code?: string; constraint?: string } | null {
  if (typeof error !== "object" || error === null) return null;

  return error as { code?: string; constraint?: string };
}

function isForeignKeyViolation(error: unknown): boolean {
  return violation(error)?.code === FOREIGN_KEY_VIOLATION;
}

/**
 * Whether an error is Postgres refusing a row because the game it points at
 * is gone.
 *
 * A game can be deleted while someone still has its page open, so the row a
 * comment, a rating or a play refers to may have vanished by the time the
 * insert runs. Postgres reports that as a foreign-key violation, which is a
 * 404 rather than a server fault. Shared by routes/games.ts and
 * routes/comments.ts, which each used to carry their own copy.
 *
 * The parent-comment key is excluded by name rather than by leaving it to
 * whichever check runs first: "the game is gone" is a claim about the game, and
 * a caller asking this question should get "no" for a violation that says
 * nothing about it. Every other foreign key reachable from here points at
 * "games" — "ratings", "plays" and the comment's own game id — so an unnamed
 * violation is still read as a missing game, which is what it was before
 * constraint names were looked at at all.
 */
export function isMissingGameError(error: unknown): boolean {
  return (
    isForeignKeyViolation(error) &&
    violation(error)?.constraint !== COMMENT_PARENT_CONSTRAINT
  );
}

/**
 * Whether an error is Postgres refusing a reply because the comment it answers
 * is gone.
 *
 * The same race as above, one table along: routes/comments.ts checks that the
 * parent exists and belongs to the same game before it inserts, and a
 * moderator deleting that comment in between turns the insert into this. It is
 * a 409 rather than a 404 — the address the request was sent to is fine, it is
 * the thing being replied to that has gone.
 */
export function isMissingParentCommentError(error: unknown): boolean {
  return (
    isForeignKeyViolation(error) &&
    violation(error)?.constraint === COMMENT_PARENT_CONSTRAINT
  );
}

/**
 * Exported for the suite, which has to name the constraints it simulates —
 * hard-coding them there would be a second copy of the names above, and a
 * schema rename would leave the tests passing against strings the database no
 * longer uses.
 */
export const COMMENT_CONSTRAINTS = {
  game: COMMENT_GAME_CONSTRAINT,
  parent: COMMENT_PARENT_CONSTRAINT,
};
