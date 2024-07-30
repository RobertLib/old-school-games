/**
 * Reads one cookie out of a raw Cookie header.
 *
 * The app sets a handful of cookies but never needs to parse a request body's
 * worth of them, so this stays in place of a cookie-parser dependency.
 */
export function readCookie(
  header: string | undefined,
  name: string,
): string | null {
  if (!header) return null;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");

    if (separator === -1) continue;

    if (part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();

      // A stray "%" makes decodeURIComponent throw. Both callers run on every
      // request, so one mangled cookie used to answer every page with a 500 —
      // and the cookie stayed put, leaving the visitor no way out but clearing
      // it by hand. An undecodable value is simply not a value we wrote.
      try {
        return decodeURIComponent(value);
      } catch {
        return null;
      }
    }
  }

  return null;
}
