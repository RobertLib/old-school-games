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

/**
 * How many derivations may run at once in this process, and how many may wait
 * for one of those places. See derive() for why there is a limit at all.
 *
 * Two running, because libuv's thread pool has four threads and the rest of
 * the process needs them too: zlib compressing every response, the file
 * system behind express.static, and DNS. The machine has one shared vCPU (see
 * fly.toml), so more than two in parallel would not finish any sooner — they
 * would only split the one core more ways, the event loop included.
 *
 * Eight waiting. A derivation is about a tenth of a second of one core, so
 * that is on the order of a second of queue: long enough that a few logins
 * arriving together are simply served in turn, short enough that nobody waits
 * on a queue that cannot drain before they give up. Past that the answer is
 * "busy", at once, before any work is done.
 *
 * At 16 MiB a derivation, two in flight is 32 MiB. The queued ones hold
 * nothing — scrypt allocates when it starts, not when it is asked.
 */
const MAX_RUNNING = 2;
const MAX_WAITING = 8;

/**
 * What a caller is told to wait before retrying, in seconds: about the time
 * the queue above takes to drain, and the least Retry-After can say, since it
 * counts in whole seconds.
 */
const RETRY_AFTER_SECONDS = 1;

/**
 * Every place above is taken: this process is already deriving as many keys
 * as it will, with as many more waiting as it will queue.
 *
 * Thrown instead of queueing without end, so that the caller can fail fast
 * and say so — routes/auth.ts answers it with a 503 and a Retry-After. A
 * class of its own so that nothing can mistake it for a wrong password:
 * verifyPassword turns every other failure to derive into `false`, and this
 * one must not be — a busy server is not a refused credential.
 */
export class PasswordHashingBusyError extends Error {
  retryAfterSeconds = RETRY_AFTER_SECONDS;

  constructor() {
    super("Password hashing is at capacity; retry shortly.");
    this.name = "PasswordHashingBusyError";
  }
}

/**
 * How a caller asks for its derivation.
 *
 * `priority` is for the one caller whose attempt must not be turned away by a
 * flood of other people's: a login presenting a device cookie this server
 * issued for the account it names (see utils/device-cookie.ts). Without it
 * the two protections worked against each other. A flood that fills this
 * queue is exactly when the account's owner most needs to sign in, and every
 * "busy" they were answered with was charged to their device's own failure
 * budget like any other refusal — so an owner retrying through a flood could
 * spend that budget and lock themselves out, which is the lockout the device
 * cookie exists to prevent.
 */
export interface DeriveOptions {
  priority?: boolean;
}

let running = 0;
const waiting: (() => void)[] = [];

/**
 * Takes one of the running places, waiting for one if the queue has room.
 *
 * A freed place is handed straight to the first waiter rather than given back
 * and competed for (see release below), so a waiter cannot be overtaken by a
 * request that arrived after it and the running count never overshoots.
 *
 * A priority caller is never refused and goes to the front of the queue: it
 * waits for the next free place, not behind the flood. That cannot be turned
 * into a flood of its own — every priority attempt presents a device cookie,
 * and routes/auth.ts holds each device to ten failures an hour and each
 * address to ten a quarter hour before anything here is asked.
 */
async function acquire(priority: boolean): Promise<void> {
  if (running < MAX_RUNNING) {
    running++;
    return;
  }

  if (priority) {
    await new Promise<void>((resolve) => waiting.unshift(resolve));
    return;
  }

  if (waiting.length >= MAX_WAITING) throw new PasswordHashingBusyError();

  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();

  if (next) next();
  else running--;
}

/**
 * Derives a key, through a process-wide limit on how many derivations run at
 * once.
 *
 * Every login attempt costs one of these — including an attempt at an address
 * with no account here (see fakeVerifyPassword) — and each is roughly a tenth
 * of a second of a core and 16 MiB. They run on libuv's shared thread pool,
 * the one zlib, static files and DNS also wait on. The login limiters only
 * bound attempts per address (ten per quarter hour), so enough addresses
 * asking at once could keep every pool thread and the one vCPU busy hashing
 * and stall every other request on the machine: login was a cheap lever for
 * degrading the whole site.
 *
 * With the limit, the most that can be spent on hashing is two derivations at
 * a time; everything past the short queue is refused before any work is done.
 * Refused requests cost the caller a retry, which is the right side for the
 * cost to land on.
 *
 * Per process, not shared across machines, deliberately — the resource being
 * protected is this machine's CPU and thread pool, and each machine has its
 * own. create-admin.ts runs in a process of its own and derives once, so it
 * can never meet the limit.
 */
async function derive(
  password: string,
  salt: string,
  cost: ScryptCost,
  { priority = false }: DeriveOptions = {},
): Promise<Buffer> {
  await acquire(priority);

  try {
    return await scryptAsync(password, salt, KEY_LENGTH, { ...cost });
  } finally {
    release();
  }
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
  options: DeriveOptions = {},
): Promise<boolean> {
  if (typeof hash !== "string") return false;

  const stored = parseHash(hash);

  if (!stored) return false;

  if (!HEX.test(stored.key) || stored.key.length % 2 !== 0) return false;

  let derivedKey: Buffer;

  try {
    derivedKey = await derive(password, stored.salt, stored.cost, options);
  } catch (error) {
    // Rethrown, not read as a mismatch: "busy" answered as "wrong password"
    // would tell the owner of the account their password is wrong, and would
    // be charged to the login limiters as a failed guess.
    if (error instanceof PasswordHashingBusyError) throw error;

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
 *
 * Through the same limit as a real check (see derive), and able to throw
 * PasswordHashingBusyError like one. Exempting it would have left the cheapest
 * way to make this process hash — an address with no account — outside the
 * only thing bounding how much it hashes; and refusing only real accounts'
 * checks when busy would have made "busy" itself tell the two apart.
 */
export async function fakeVerifyPassword(
  password: string,
  options: DeriveOptions = {},
): Promise<void> {
  await derive(password, "invalid-user-placeholder-salt", COST, options);
}
