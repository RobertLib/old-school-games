import { describe, expect, it } from "vitest";
import { scryptSync } from "crypto";
import {
  fakeVerifyPassword,
  hashPassword,
  PasswordHashingBusyError,
  verifyPassword,
} from "../../utils/password.ts";

/**
 * A hash in the shape this used to store: "salt:key" at node's own scrypt
 * defaults, with the cost left unstated. Rows written before the format
 * carried its parameters still look like this, and they have to keep
 * verifying — the accounts here are seeded by hand and there is no reset flow.
 */
function legacyHash(password: string, salt: string): string {
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

describe("hashPassword", () => {
  it("stores the cost alongside the salt and key", async () => {
    const hash = await hashPassword("correct horse battery staple");

    // "scrypt$N$r$p$salt$key". The cost is written down so it can be raised
    // without invalidating every password already stored.
    expect(hash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    await expect(
      verifyPassword("correct horse battery staple", hash),
    ).resolves.toBe(true);
  });

  it("stays inside the column the hash is stored in", async () => {
    const hash = await hashPassword("correct horse battery staple");

    // "password" is VARCHAR(255) — see migrations/0001_init.sql.
    expect(hash.length).toBeLessThanOrEqual(255);
  });

  it("salts each hash, so the same password never stores the same value", async () => {
    const [first, second] = await Promise.all([
      hashPassword("same-password"),
      hashPassword("same-password"),
    ]);

    expect(first).not.toBe(second);
    await expect(verifyPassword("same-password", first)).resolves.toBe(true);
    await expect(verifyPassword("same-password", second)).resolves.toBe(true);
  });

  it("handles empty and unicode passwords", async () => {
    const empty = await hashPassword("");
    const unicode = await hashPassword("héslo–ü🔑");

    await expect(verifyPassword("", empty)).resolves.toBe(true);
    await expect(verifyPassword("héslo–ü🔑", unicode)).resolves.toBe(true);
    await expect(verifyPassword("x", empty)).resolves.toBe(false);
  });
});

describe("verifyPassword", () => {
  it("rejects a wrong password", async () => {
    const hash = await hashPassword("right");

    await expect(verifyPassword("wrong", hash)).resolves.toBe(false);
  });

  it("is case- and whitespace-sensitive", async () => {
    const hash = await hashPassword("Secret");

    await expect(verifyPassword("secret", hash)).resolves.toBe(false);
    await expect(verifyPassword("Secret ", hash)).resolves.toBe(false);
  });

  // A malformed row used to hand `undefined` to Buffer.from, which throws and
  // turned a failed login into a 500.
  it.each([
    ["no separator", "notahash"],
    ["empty string", ""],
    ["empty salt", ":abcdef"],
    ["non-hex key", "salt:zzzz"],
    ["odd-length key", "salt:abc"],
    ["separator only", ":"],
  ])("returns false for a malformed hash (%s)", async (_label, stored) => {
    await expect(verifyPassword("anything", stored)).resolves.toBe(false);
  });

  it("returns false when the stored key is the wrong length", async () => {
    await expect(verifyPassword("anything", "salt:abcd")).resolves.toBe(false);
  });

  /**
   * The signature says string, but the value comes off a database row, so the
   * guard is not reachable from typed code and is worth keeping anyway: a
   * NULL column would otherwise throw out of a failed login as a 500.
   */
  it("refuses a stored value that is not a string at all", async () => {
    for (const stored of [null, undefined, 42, {}]) {
      await expect(
        verifyPassword("anything", stored as unknown as string),
      ).resolves.toBe(false);
    }
  });

  it("still accepts a hash stored in the old salt:key shape", async () => {
    const stored = legacyHash("legacy-password", "a".repeat(32));

    await expect(verifyPassword("legacy-password", stored)).resolves.toBe(true);
    await expect(verifyPassword("wrong", stored)).resolves.toBe(false);
  });

  /**
   * The cost comes out of the database, and scrypt allocates 128 * N * r
   * bytes before it does anything else — so a mangled row claiming a huge N
   * would ask for a terabyte and take the process down rather than failing
   * one login.
   */
  it("refuses a cost past the bound instead of allocating for it", async () => {
    const absurd = `scrypt$1073741824$8$1$${"a".repeat(32)}$${"b".repeat(128)}`;

    await expect(verifyPassword("anything", absurd)).resolves.toBe(false);
  });

  it("refuses a malformed cost field", async () => {
    const salt = "a".repeat(32);
    const key = "b".repeat(128);

    for (const bad of [
      `scrypt$0$8$1$${salt}$${key}`,
      `scrypt$16384$8$1e1$${salt}$${key}`,
      `scrypt$16384$8$${salt}$${key}`,
      `scrypt$16384$8$1$not-hex$${key}`,
    ]) {
      await expect(verifyPassword("anything", bad)).resolves.toBe(false);
    }
  });

  /**
   * N has to be a power of two, which the bounds check cannot know. node
   * refuses it, and that is a row this process cannot verify — a failed
   * login, not a 500.
   */
  it("refuses a cost node itself rejects", async () => {
    const odd = `scrypt$16385$8$1$${"a".repeat(32)}$${"b".repeat(128)}`;

    await expect(verifyPassword("anything", odd)).resolves.toBe(false);
  });
});

describe("fakeVerifyPassword", () => {
  it("resolves without throwing, so an unknown user still costs the same work", async () => {
    await expect(fakeVerifyPassword("anything")).resolves.toBeUndefined();
  });
});

/**
 * Every login attempt costs a derivation — about a tenth of a second of a core
 * and 16 MiB — on the libuv thread pool the rest of the process shares, and
 * the only thing that used to bound how many ran at once was ten attempts per
 * address per quarter hour. Enough addresses at once kept every pool thread
 * and the one vCPU hashing. The limit is process-wide: two running, eight
 * waiting, and a typed refusal past that, before any work is done.
 *
 * Each case awaits everything it started, because the limit is module state:
 * a derivation left running would be taking a place in the next case's count.
 */
describe("the limit on derivations in flight", () => {
  /** Running plus waiting — the most this process takes on at once. */
  const CAPACITY = 10;

  function fill(): Promise<void>[] {
    return Array.from({ length: CAPACITY }, (_, index) =>
      fakeVerifyPassword(`filler ${index}`),
    );
  }

  it("serves every caller the queue has room for, in turn", async () => {
    const results = await Promise.allSettled(fill());

    expect(results.map((result) => result.status)).toEqual(
      Array(CAPACITY).fill("fulfilled"),
    );
  });

  it("refuses the next one at once rather than queueing it", async () => {
    const fillers = fill();
    let settled = 0;

    for (const filler of fillers) void filler.finally(() => settled++);

    const refusal = await fakeVerifyPassword("one too many").then(
      () => null,
      (error: unknown) => error,
    );

    // Refused while every place is still taken — it did not wait its turn.
    expect(settled).toBe(0);
    expect(refusal).toBeInstanceOf(PasswordHashingBusyError);
    expect((refusal as PasswordHashingBusyError).retryAfterSeconds).toBe(1);

    await Promise.allSettled(fillers);
  });

  /**
   * The one refusal verifyPassword must not turn into `false`. Every other
   * failure to derive is a row this process cannot verify, which is a failed
   * login; this one is a busy server, and reading it as a wrong password would
   * tell the owner of the account that their password is wrong.
   */
  it("makes verifyPassword say busy, not wrong", async () => {
    const hash = await hashPassword("the right password");
    const fillers = fill();

    await expect(verifyPassword("the right password", hash)).rejects.toBeInstanceOf(
      PasswordHashingBusyError,
    );

    await Promise.allSettled(fillers);
  });

  it("holds hashPassword to the same limit", async () => {
    const fillers = fill();

    await expect(hashPassword("anything")).rejects.toBeInstanceOf(
      PasswordHashingBusyError,
    );

    await Promise.allSettled(fillers);
  });

  /**
   * A login presenting a device cookie for the account it names asks for
   * priority: a flood that fills the queue is when the owner most needs to
   * sign in, and a "busy" would be charged to their device's own budget. It is
   * never refused and waits at the front, for the next free place.
   */
  it("queues a priority derivation even when the queue is full, and at the front", async () => {
    const order: string[] = [];
    const fillers = fill().map((filler, index) =>
      filler.then(() => order.push(`filler ${index}`)),
    );

    const owner = fakeVerifyPassword("the owner", { priority: true }).then(() =>
      order.push("owner"),
    );

    // Not refused, though every place and every queue slot is taken.
    await expect(owner).resolves.toBeDefined();
    await Promise.allSettled(fillers);

    // Two were already running when it arrived, and it took the first place
    // either of them freed — ahead of all eight that were waiting. It may
    // still finish just after the waiter that took the other place, since the
    // two run side by side, but no later: at the back of the queue it would
    // have been last.
    expect(order.indexOf("owner")).toBeLessThanOrEqual(3);
    expect(order).toHaveLength(CAPACITY + 1);
  });

  it("gives verifyPassword the same priority", async () => {
    const hash = await hashPassword("the owner's password");
    const fillers = fill();

    await expect(
      verifyPassword("the owner's password", hash, { priority: true }),
    ).resolves.toBe(true);

    await Promise.allSettled(fillers);
  });

  it("frees its places once the work is done", async () => {
    await Promise.allSettled(fill());

    const hash = await hashPassword("after the rush");

    await expect(verifyPassword("after the rush", hash)).resolves.toBe(true);
  });

  /**
   * A derivation that node refuses — an N that is not a power of two — still
   * has to give its place back. Without that, two such rows would leave both
   * places taken for good and every later login would queue behind them
   * forever: this case would time out rather than fail.
   */
  it("frees a place when the derivation fails", async () => {
    const odd = `scrypt$16385$8$1$${"a".repeat(32)}$${"b".repeat(128)}`;

    for (let attempt = 0; attempt < CAPACITY; attempt++) {
      await expect(verifyPassword("anything", odd)).resolves.toBe(false);
    }

    const results = await Promise.allSettled(fill());

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
  });
});
