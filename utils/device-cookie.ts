import crypto from "crypto";
import { type Request, type Response } from "express";
import { readCookies } from "./cookies.ts";
import { deriveKey } from "./session-secret.ts";

/**
 * The OWASP "device cookie": proof that this browser has signed in to an
 * account before, so that a flood of failures from elsewhere does not lock the
 * account's owner out along with the attacker.
 *
 * The login's account-wide backstop (see routes/auth.ts) counts every failed
 * attempt at an account together, from wherever it comes, and closes the
 * account for the rest of the hour at two hundred. That is what bounds a
 * guessing attack spread over many addresses — and it is also a lockout
 * anyone can trigger, because the admin's address is not a secret and the
 * per-address limits let each source contribute ten failures at once, so
 * twenty sources are enough. A reproduction with twenty-one took under six
 * seconds, after which the real admin, from a fresh address and with the right
 * password, was refused for the rest of the hour; and the attack can be
 * repeated every hour. Nothing that sees only the request's address and the
 * account named in it can tell the owner from the attacker. A cookie that only
 * a successful login hands out can.
 *
 * So a successful login issues one, and an attempt that presents a valid one
 * for the very account it names is judged as the owner's device: it skips the
 * account-wide backstop and is counted against a budget of its own instead.
 * The per-address limits still apply to it — a stolen cookie is not a way
 * around those.
 *
 * Stateless: the value is a random nonce, the moment it was issued and a MAC
 * over both, the account and the account's current credential, so there is no
 * table of issued cookies to keep. The account is bound through the MAC rather
 * than written into the value, so the cookie does not carry an identifier
 * derived from anyone's e-mail address.
 *
 * The credential is what a password reset revokes them with. It is the one
 * utils/session-credential.ts derives from the stored hash, and a reset always
 * stores a new hash, so every device cookie issued before it stops verifying
 * at that moment — the same way every session opened before it does. Without
 * it, somebody who had logged in once with a phished password kept, for a
 * year after the reset, a cookie that skipped the account-wide backstop and
 * had its hashing put first in the queue; only rotating SESSION_SECRET
 * revoked it.
 */

const SECURE = process.env.NODE_ENV === "production";

/**
 * "__Secure-" in production, which a browser only accepts from a secure
 * origin, so nothing speaking plain HTTP can plant one. Not "__Host-", the
 * prefix the CSRF cookie uses: that one also requires Path=/, and this cookie
 * is scoped to /login below. Planting would buy little anyway — a value that
 * does not verify is ignored, and every cookie of the name is read, so one
 * cannot hide another (see recognisedDevice) — but the prefix costs nothing. It requires
 * Secure, so development over HTTP uses the bare name.
 */
export const DEVICE_COOKIE = SECURE ? "__Secure-osg_device" : "osg_device";

/**
 * A year from the last successful login on this device.
 *
 * Long, because the whole value of the cookie is in being there on the day
 * the account is under attack and its owner needs to sign in — which may be
 * long after they last did: server inactivity expiry is renewed on use, so an
 * admin who visits every week can stay signed in until the fixed browser
 * cookie expires, and their device's cookie ages from the last login. A term
 * measured in weeks would have
 * expired on exactly the admins who use the site most.
 *
 * Not longer, because browsers now cap any cookie's lifetime at 400 days
 * whatever it asks for, and because the MAC binds the issue time: the year is
 * enforced here, not just requested of the browser, so a cookie that
 * something kept longer still stops counting.
 *
 * What a leaked one is worth is bounded regardless of the term — it still
 * needs the password, and its own failure budget (see routes/auth.ts) is
 * smaller than a single address's — so there was little to trade for a
 * shorter one.
 */
export const DEVICE_COOKIE_TERM_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * How far into the future an issue time may be and still count: machines here
 * agree on the time to well within this, and one issued a moment ago on a
 * machine whose clock runs a little fast must not be refused by the next.
 */
const CLOCK_SKEW_SECONDS = 5 * 60;

const NONCE_BYTES = 16;

/** "<nonce>.<issued, in seconds>.<mac>" — hex, digits, hex. */
const VALUE_PATTERN = /^([0-9a-f]{32})\.([1-9][0-9]{0,11})\.([0-9a-f]{64})$/;

/**
 * Its own key, derived from SESSION_SECRET for this purpose alone: a MAC
 * minted here verifies as nothing else, and nothing else as one of these.
 *
 * v2 since the credential went into the MAC. Every v1 cookie stopped
 * verifying on that deploy, which costs its owner nothing until the account
 * is under attack, and the next successful login issues a v2 one.
 */
const KEY = deriveKey("login device cookie v2");

function mac(
  account: string,
  credential: string,
  nonce: string,
  issuedAt: number,
): string {
  return crypto
    .createHmac("sha256", KEY)
    .update(`${account}.${credential}.${nonce}.${issuedAt}`)
    .digest("hex");
}

/**
 * Whether the request carries a device cookie at all — what lets the login
 * skip looking the account up for the device check when there is nothing to
 * check.
 *
 * Every cookie of the name, for the reason recognisedDevice gives. This used
 * to be readCookie, which stops at the first and answers null when that one
 * does not decode — so a planted "%" ahead of the real cookie made the
 * request look as if it carried none, and recognisedDevice, which would have
 * found the real one, never ran.
 */
export function presentsDeviceCookie(req: Request): boolean {
  return readCookies(req.headers.cookie, DEVICE_COOKIE).length > 0;
}

/**
 * Hands the browser a fresh device cookie for `account` — the same account key
 * the login limiters count by — under the account's current `credential`
 * (credentialOf its stored password hash).
 *
 * Fresh every time, rather than the existing one kept: the term runs from the
 * last login, and a new nonce means a cookie that has been failing on some
 * other machine's behalf stops sharing a budget with this one.
 *
 * The attributes, each for a reason:
 *
 * - Path=/login. It is read by one route and nowhere else, so every other
 *   request on the site goes without it — it is not a long-lived identifier
 *   riding along on page views, and it is in fewer places to leak from.
 * - HttpOnly. No script has any business with it.
 * - SameSite=Strict. The only request that needs it is the login form's own
 *   same-site POST; a cross-site request has no business presenting it.
 */
export function issueDeviceCookie(
  res: Response,
  account: string,
  credential: string,
  now: number = Date.now(),
): void {
  const nonce = crypto.randomBytes(NONCE_BYTES).toString("hex");
  const issuedAt = Math.floor(now / 1000);
  const value = `${nonce}.${issuedAt}.${mac(account, credential, nonce, issuedAt)}`;

  res.cookie(DEVICE_COOKIE, value, {
    httpOnly: true,
    secure: SECURE,
    sameSite: "strict",
    path: "/login",
    maxAge: DEVICE_COOKIE_TERM_MS,
  });
}

/**
 * The nonce of a device cookie this server issued for `account` under its
 * current `credential` and whose term has not run out, or null for anything
 * else — no cookie, a mangled one, one for a different account, one issued
 * before the account's password was last reset, one from a different
 * SESSION_SECRET.
 *
 * The nonce is what the device's own failure budget is keyed by.
 *
 * Every cookie of the name is tried, not only the first. The "__Secure-"
 * prefix does not stop a sibling subdomain from setting one for the whole
 * domain, and a planted "__Secure-osg_device" with Path=/login that is older
 * than the real one is sent ahead of it. Reading only the first, a value that
 * did not verify was not ignored, as the rest of this file assumes: it hid
 * the one that did, and the owner lost the device's exemption from the
 * per-account lockout and its place ahead of the password-hashing queue —
 * which is what an attacker locking the account out would want.
 */
export function recognisedDevice(
  req: Request,
  account: string,
  credential: string,
  now: number = Date.now(),
): string | null {
  for (const value of readCookies(req.headers.cookie, DEVICE_COOKIE)) {
    const nonce = verifiedNonce(value, account, credential, now);

    if (nonce !== null) return nonce;
  }

  return null;
}

/** The nonce in one device cookie value, if it verifies; see above. */
function verifiedNonce(
  value: string,
  account: string,
  credential: string,
  now: number,
): string | null {
  const match = VALUE_PATTERN.exec(value);

  if (!match) return null;

  const [, nonce, rawIssuedAt, presented] = match as unknown as [
    string,
    string,
    string,
    string,
  ];
  const issuedAt = Number(rawIssuedAt);
  const nowSeconds = Math.floor(now / 1000);

  if (issuedAt > nowSeconds + CLOCK_SKEW_SECONDS) return null;
  if (nowSeconds - issuedAt >= DEVICE_COOKIE_TERM_MS / 1000) return null;

  // Both sides are 32 bytes — the pattern above fixes the presented one — so
  // timingSafeEqual cannot throw on a length mismatch.
  const valid = crypto.timingSafeEqual(
    Buffer.from(mac(account, credential, nonce, issuedAt), "hex"),
    Buffer.from(presented, "hex"),
  );

  return valid ? nonce : null;
}
