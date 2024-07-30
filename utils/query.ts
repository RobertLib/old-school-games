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
