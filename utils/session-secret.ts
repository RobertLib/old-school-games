// node:crypto rather than the `crypto` global, which is WebCrypto and has no
// randomBytes or hkdfSync.
import crypto from "node:crypto";

/**
 * What signs the session cookie, and the root of every other key this app
 * derives (see deriveKey below).
 *
 * The environment's SESSION_SECRET when there is one. Production refuses to
 * boot without a real one — the guards in app.ts check it is set, is not the
 * .env.example placeholder and is long enough — so the fallback below is only
 * ever reached outside production.
 *
 * That slot used to read `process.env.SESSION_SECRET ?? "secret"`, and the
 * fallback is the problem: "secret" is a fixed, published string, so any
 * deployment that reached this branch signed its cookies with a value written
 * down in the source. The guards mean production cannot reach it — but
 * "production" is decided by an environment variable, and the NODE_ENV check
 * at the top of app.ts exists because that variable is exactly the sort of
 * thing that arrives misspelled. A constant default is a forged admin session
 * one typo away; random bytes are not, whatever NODE_ENV says.
 *
 * Per process, so a restart invalidates every session signed by the one
 * before: `npm run dev` restarts on every save, and an admin logged into a
 * development server is logged out each time. That is the intended trade and
 * not a bug to work around — set SESSION_SECRET in .env (it is in
 * .env.example) if you want a development login to survive a reload.
 *
 * 32 bytes, matching SESSION_SECRET_MIN_LENGTH in app.ts — which counts
 * characters of hex, so the generated value is twice that and comfortably over
 * the floor production is held to.
 *
 * Its own module, rather than a function in app.ts where it used to live,
 * because the login route now needs keys derived from the same secret and
 * routes cannot import app.ts: app.ts imports them.
 */
export const SESSION_SECRET: string =
  process.env.SESSION_SECRET ?? crypto.randomBytes(32).toString("hex");

/**
 * A key for one purpose, derived from SESSION_SECRET.
 *
 * HKDF with the purpose as its "info" string, so every use gets a key of its
 * own: a MAC computed for one purpose can never verify as another's, and none
 * of them is the secret that signs the session cookie. The alternative — the
 * secret itself as every HMAC key — would make any value this app signs for
 * one reason a valid signature for all the others that sign the same shape.
 *
 * The purpose names a version, so changing what a key signs is a matter of
 * changing its string: every value signed under the old one stops verifying
 * at once, with no format field to keep in step.
 *
 * Rotating SESSION_SECRET rotates all of them together, which is the one lever
 * that ends every session and every device cookie at once.
 */
export function deriveKey(purpose: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      SESSION_SECRET,
      "oldschoolgames.eu",
      purpose,
      32,
    ),
  );
}
