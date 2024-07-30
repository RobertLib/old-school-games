import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The secret the session cookie is signed with, and the keys derived from it.
 *
 * Each case loads the module afresh under the environment it is about,
 * because the secret is decided once, when the module is first read.
 */
async function load(secret: string | undefined) {
  if (secret === undefined) vi.stubEnv("SESSION_SECRET", undefined as never);
  else vi.stubEnv("SESSION_SECRET", secret);

  vi.resetModules();

  return import("../../utils/session-secret.ts");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("SESSION_SECRET", () => {
  it("is the environment's when there is one", async () => {
    const { SESSION_SECRET } = await load("s".repeat(64));

    expect(SESSION_SECRET).toBe("s".repeat(64));
  });

  /**
   * Random bytes rather than a fixed string outside production, so a
   * deployment that reaches this branch by a misspelled NODE_ENV does not sign
   * its cookies with a value written down in the source.
   */
  it("is random per process when there is none", async () => {
    const first = (await load(undefined)).SESSION_SECRET;
    const second = (await load(undefined)).SESSION_SECRET;

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
  });
});

describe("deriveKey", () => {
  it("gives each purpose a 32-byte key of its own", async () => {
    const { deriveKey } = await load("s".repeat(64));

    const device = deriveKey("login device cookie v1");
    const credential = deriveKey("session credential v1");

    expect(device).toHaveLength(32);
    expect(credential).toHaveLength(32);
    expect(device.equals(credential)).toBe(false);
  });

  it("gives the same purpose the same key, so what it signed still verifies", async () => {
    const { deriveKey } = await load("s".repeat(64));

    expect(deriveKey("purpose").equals(deriveKey("purpose"))).toBe(true);
  });

  it("is never the secret itself", async () => {
    const { deriveKey, SESSION_SECRET } = await load("s".repeat(64));

    expect(deriveKey("purpose").toString("utf8")).not.toContain(SESSION_SECRET);
  });

  // Rotating the secret retires everything derived from it at once.
  it("changes with the secret", async () => {
    const before = (await load("s".repeat(64))).deriveKey("purpose");
    const after = (await load("t".repeat(64))).deriveKey("purpose");

    expect(before.equals(after)).toBe(false);
  });
});
