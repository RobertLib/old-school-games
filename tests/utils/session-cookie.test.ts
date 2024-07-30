import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The session cookie's name, which is read once at import — so each case
 * loads the module afresh under the environment it is about.
 *
 * "__Host-" in production, so that code on a subdomain of the site cannot set
 * a "connect.sid" for the whole domain and swap the admin's session for one of
 * its own choosing. The prefix needs Secure and Path=/, so the options it is
 * set with have to say both.
 */
describe("the session cookie", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("carries the __Host- prefix in production, with what the prefix needs", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();

    const { SESSION_COOKIE, SESSION_COOKIE_OPTIONS } = await import(
      "../../utils/session-cookie.ts"
    );

    expect(SESSION_COOKIE).toBe("__Host-connect.sid");
    expect(SESSION_COOKIE_OPTIONS).toEqual(
      expect.objectContaining({ secure: true, path: "/" }),
    );
    expect(SESSION_COOKIE_OPTIONS).not.toHaveProperty("domain");
  });

  // A "__Host-" cookie without Secure is refused by the browser outright, and
  // development runs over plain HTTP.
  it("keeps the bare name outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.resetModules();

    const { SESSION_COOKIE, SESSION_COOKIE_OPTIONS } = await import(
      "../../utils/session-cookie.ts"
    );

    expect(SESSION_COOKIE).toBe("connect.sid");
    expect(SESSION_COOKIE_OPTIONS.secure).toBe(false);
  });
});
