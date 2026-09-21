/**
 * A query string may repeat a key — "?genre=a&genre=b" — and Express hands
 * that over as an array. Every route here wants a single value, so reaching
 * straight for a string method on it threw and turned a merely malformed URL
 * into a 500.
 */
export function firstQueryValue(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;

  return typeof raw === "string" ? raw : undefined;
}

/**
 * The query string exactly as it arrived, ready to re-attach to a redirect.
 *
 * Taken off req.originalUrl rather than rebuilt from req.query, which is the
 * parsed form: re-serialising it does not give back what was sent, because
 * repeated keys, arrays and the percent-encoding all shift on the way through.
 * A redirect that quietly rewrites the caller's query string is the one thing
 * these are not allowed to do.
 *
 * Here rather than in routes/home.ts, which is where it was: app.ts had a
 * third copy of the same split inline for the trailing-slash redirect, and the
 * canonical-host and HTTPS redirects above that one needed a fourth. Only the
 * query is taken from the raw target — the path always comes from req.path, so
 * that an absolute-form request target cannot put another origin into a
 * Location header.
 */
export function rawQuery(req: { originalUrl: string }): string {
  const query = req.originalUrl.split("?")[1];

  return query ? `?${query}` : "";
}
