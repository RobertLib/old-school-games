/**
 * An e-mail address as the login reads it: trimmed and lower-cased, by
 * JavaScript, once.
 *
 * Two things ask "which account is this?" of the same typed address, and they
 * have to give the same answer: User.findByEmail, which finds the account, and
 * accountKey in routes/auth.ts, which the login limiters and the device cookie
 * count by. The lookup used to fold case in Postgres — LOWER($1) — and the key
 * in JavaScript, and the two disagree. LOWER('İ') is 'i' under the database's
 * collation; 'İ'.toLowerCase() is 'i' followed by a combining dot. So an
 * address with every "i" swapped for "İ" reached the same account through the
 * lookup while landing in a different limiter bucket — 2^k buckets for an
 * address with k of them, each with its own 200 an hour at the account-wide
 * backstop.
 *
 * Both now take this value, so a key is exactly one account. The stored side
 * is still folded by Postgres (LOWER("email"), which the unique index from
 * 0025 covers); an account is reachable by the address that folds to what
 * LOWER makes of it, and for every address create-admin.ts has been handed in
 * practice — anything without an "İ" or a word-final "Σ" — the two folds agree.
 */
export function foldEmail(email: string): string {
  return email.trim().toLowerCase();
}
