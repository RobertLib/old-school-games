import {
  scrypt,
  timingSafeEqual,
  randomBytes,
  type ScryptOptions,
} from "crypto";
import { promisify } from "util";

/**
 * Typed against the four-argument form. promisify infers the overload without
 * options, so the cost below would not have reached scrypt at all.
 */
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

const KEY_LENGTH = 64;
const SALT_BYTES = 16;

interface ScryptCost {
  N: number;
  r: number;
  p: number;
}

/**
 * What a new hash is derived at.
 *
 * OWASP asks for scrypt at N=2^17, r=8, p=1, and names N=2^14, r=8, p=5 as an
 * equivalent defence. The two differ in where the work goes: N buys memory
 * hardness and p buys only CPU, so the first needs 128 MiB for every hash in
 * flight where this one needs 16. On a 1 GB machine (see fly.toml) that
 * decides it — every login attempt derives a key, including the ones for
 * addresses that have no account here (see fakeVerifyPassword), so a handful
 * arriving together at 128 MiB apiece is an out-of-memory kill rather than a
 * slow login. 16 MiB also stays under node's default maxmem of 32 MiB, so
 * nothing has to lift a limit that exists to catch this very mistake.
 *
 * Four times the work this used to derive at, and raising it again is now a
 * one-line change — see PREFIX below for why it was not.
 */
const COST: ScryptCost = { N: 16384, r: 8, p: 5 };

/**
 * What the legacy "salt:key" rows were derived at: node's own scrypt defaults,
 * which is what the call that made them left unstated.
 */
const LEGACY_COST: ScryptCost = { N: 16384, r: 8, p: 1 };

/**
 * Marks a hash that carries the parameters it was made with, stored as
 * "scrypt$N$r$p$salt$key".
 *
 * The format used to be "salt:key" with the cost left implicit, which meant
 * the cost could not be raised at all: every existing password would have
 * stopped verifying the moment the numbers changed, and accounts here are
 * seeded by hand with no reset flow to recover from that. Writing the cost
 * down is what makes it changeable.
 *
 * Rows in the old shape keep working — verifyPassword reads either — and
 * nothing rewrites them. There is no sign-up route, so a re-hash on a
 * successful login would be the only opportunity, and for a handful of
 * hand-seeded admin accounts that is not worth the code: setting the password
 * again stores the new format.
 *
 * At these lengths the value is 178 characters, inside the column's 255.
 */
const PREFIX = "scrypt";

const HEX = /^[0-9a-f]+$/i;

/**
 * Bounds on a cost read back out of a stored hash.
 *
 * The numbers come from the database, and scrypt allocates 128 * N * r bytes
 * before it does anything else — so a mangled row claiming N=2^30 would ask
 * for a terabyte and take the process with it rather than failing one login.
 */
const MAX_N = 1 << 20;
const MAX_R = 32;
const MAX_P = 16;

function derive(
  password: string,
  salt: string,
  cost: ScryptCost,
): Promise<Buffer> {
  return scryptAsync(password, salt, KEY_LENGTH, { ...cost });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES).toString("hex");
  const derivedKey = await derive(password, salt, COST);

  return [
    PREFIX,
    COST.N,
    COST.r,
    COST.p,
    salt,
    derivedKey.toString("hex"),
  ].join("$");
}

interface StoredHash {
  salt: string;
  key: string;
  cost: ScryptCost;
}

/** Digits only, and inside the bound — Number() is too forgiving to decide it. */
function parseCostField(value: string, max: number): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;

  const parsed = Number(value);

  return parsed <= max ? parsed : null;
}

/**
 * Takes a stored value apart, in either shape, or answers null.
 *
 * Null rather than a throw for the same reason verifyPassword returned false
 * on a malformed value before this existed: one bad row should refuse one
 * login, not answer it with a 500.
 */
function parseHash(hash: string): StoredHash | null {
  if (hash.startsWith(`${PREFIX}$`)) {
    const parts = hash.split("$");

    // The name, three numbers, the salt and the key. Anything else — an extra
    // "$", a truncated value — is not this format.
    if (parts.length !== 6) return null;

    const [, rawN, rawR, rawP, salt, key] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];

    const N = parseCostField(rawN, MAX_N);
    const r = parseCostField(rawR, MAX_R);
    const p = parseCostField(rawP, MAX_P);

    if (N === null || r === null || p === null) return null;
    if (!salt || !HEX.test(salt)) return null;

    return { salt, key, cost: { N, r, p } };
  }

  // The legacy shape. A value that is not "salt:key" cannot match anything;
  // splitting it blindly used to hand `undefined` to Buffer.from, which
  // throws — so one malformed row turned a failed login into a 500.
  const separator = hash.indexOf(":");

  if (separator <= 0) return null;

  return {
    salt: hash.slice(0, separator),
    key: hash.slice(separator + 1),
    cost: LEGACY_COST,
  };
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  if (typeof hash !== "string") return false;

  const stored = parseHash(hash);

  if (!stored) return false;

  if (!HEX.test(stored.key) || stored.key.length % 2 !== 0) return false;

  let derivedKey: Buffer;

  try {
    derivedKey = await derive(password, stored.salt, stored.cost);
  } catch {
    // Parameters that passed the bounds above can still be refused by node —
    // an N that is not a power of two, or a combination over maxmem. That is a
    // row this process cannot verify, which is a failed login and not a 500.
    return false;
  }

  const storedKeyBuffer = Buffer.from(stored.key, "hex");

  if (derivedKey.length !== storedKeyBuffer.length) return false;

  return timingSafeEqual(derivedKey, storedKeyBuffer);
}

/**
 * Burns the same work a real verification costs, for logins where no user was
 * found. Returning early instead let the response time say whether an address
 * has an account here.
 *
 * Derived at the current cost, which is what a real account's hash is stored
 * at. A row still in the legacy shape verifies faster than this, so for those
 * the timing does distinguish — the fix is to set the password again, which
 * stores the current format. Nothing else here can close it: the cost of a
 * real check is whatever that row was written with.
 */
export async function fakeVerifyPassword(password: string): Promise<void> {
  await derive(password, "invalid-user-placeholder-salt", COST);
}
