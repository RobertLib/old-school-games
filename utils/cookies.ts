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

/**
 * Every value a Cookie header carries under one name, in the order sent,
 * leaving out any that does not decode (see readCookie).
 *
 * A browser sends two cookies of one name when they were set with different
 * Domain or Path attributes, and the header says nothing about which is
 * which: the longer path first, then the older one. Code on a sibling
 * subdomain can set one for the whole domain — a "__Secure-" prefix does not
 * stop that, only "__Host-" does — so where such a cookie decides anything,
 * the first value is not necessarily the one this site wrote, and reading
 * only that one lets a planted value hide the real one behind it.
 */
export function readCookies(header: string | undefined, name: string): string[] {
  if (!header) return [];

  const values: string[] = [];

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");

    if (separator === -1 || part.slice(0, separator).trim() !== name) continue;

    try {
      values.push(decodeURIComponent(part.slice(separator + 1).trim()));
    } catch {
      // Not a value we wrote; see readCookie.
    }
  }

  return values;
}
