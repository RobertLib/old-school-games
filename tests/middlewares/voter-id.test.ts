import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { VOTER_COOKIE, voterId } from "../../middlewares/voter-id.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface CookieOptions {
  maxAge: number;
  httpOnly: boolean;
  sameSite: string;
  secure: boolean;
}

function run(cookieHeader?: string, method: string = "GET") {
  const cookie = vi.fn<(name: string, value: string, options: CookieOptions) => void>();
  const req = { method, headers: { cookie: cookieHeader } } as unknown as Request;
  const res = { cookie } as unknown as Response;
  const next = vi.fn() as NextFunction;

  voterId(req, res, next);

  /** The options the middleware set the cookie with, if it set one. */
  const options = (): CookieOptions => cookie.mock.calls[0]![2];

  return { req, res, next, options };
}

/**
 * The anonymous identity a rating is keyed on. Covered until now only
 * through the rating routes, which never said what happens to a cookie that
 * is missing, malformed, or forged to look like somebody else's.
 */
describe("voterId", () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("issues a fresh id when there is no cookie", () => {
    const { req, res, next } = run(undefined);

    expect(req.voterId).toMatch(UUID);
    expect(res.cookie).toHaveBeenCalledWith(
      VOTER_COOKIE,
      req.voterId,
      expect.objectContaining({ httpOnly: true, sameSite: "lax" }),
    );
    expect(next).toHaveBeenCalled();
  });

  /**
   * The cookie is SameSite=Lax, so a top-level POST from another site
   * arrives without it. Minting here would have replaced the visitor's
   * year-old id — their dedupe key and "my ratings" — at any other page's
   * say-so. The rating route refuses a request with no id on its own.
   */
  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "mints nothing on a %s with no cookie",
    (method) => {
      const { req, res, next } = run(undefined, method);

      expect(req.voterId).toBeUndefined();
      expect(res.cookie).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    },
  );

  it("still reads the id it is given on a POST", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const { req, res } = run(`${VOTER_COOKIE}=${id}`, "POST");

    expect(req.voterId).toBe(id);
    // Re-sent rather than left alone, exactly as csrfToken re-sends the secret
    // it is handed on a POST: the request proves the browser still holds the
    // id, which is the moment its year is worth restarting.
    expect(res.cookie).toHaveBeenCalledWith(VOTER_COOKIE, id, expect.anything());
  });

  it("reuses a well-formed id rather than minting another", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const { req, res } = run(`other=1; ${VOTER_COOKIE}=${id}`);

    expect(req.voterId).toBe(id);
    expect(res.cookie).toHaveBeenCalledWith(VOTER_COOKIE, id, expect.anything());
  });

  it("accepts an upper-case id, since a UUID is case-insensitive", () => {
    const id = "123E4567-E89B-42D3-A456-426614174000";
    const { req, res } = run(`${VOTER_COOKIE}=${id}`);

    expect(req.voterId).toBe(id);
    expect(res.cookie).toHaveBeenCalledWith(VOTER_COOKIE, id, expect.anything());
  });

  /**
   * The cookie used to be sent only when one had to be minted, so its year ran
   * from the first visit rather than from the last — a visitor who came back
   * every week still lost it on the 365th day. What goes with it is every
   * rating they ever left: the dedupe key is the id, so "my ratings" comes
   * back empty and every game they had scored is offered to them unrated.
   *
   * The id must survive the refresh. Minting a fresh one here would be that
   * same loss, inflicted on purpose. Same reasoning as the CSRF secret — see
   * the matching case in tests/middlewares/csrf.test.ts.
   */
  it("re-sends the existing cookie so its expiry slides", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const { req, res, options } = run(`${VOTER_COOKIE}=${id}`);

    expect(req.voterId).toBe(id);
    expect(res.cookie).toHaveBeenCalledTimes(1);
    expect(options().maxAge).toBe(365 * 24 * 60 * 60 * 1000);
    expect(options().httpOnly).toBe(true);
    expect(options().sameSite).toBe("lax");
  });

  it.each([
    ["too short", "123e4567"],
    ["not hex", "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz"],
    ["a SQL fragment", "' OR 1=1 --"],
    ["empty", ""],
  ])("replaces a cookie that is %s", (_label, value) => {
    const { req, res } = run(`${VOTER_COOKIE}=${value}`);

    expect(req.voterId).toMatch(UUID);
    expect(req.voterId).not.toBe(value);
    expect(res.cookie).toHaveBeenCalledTimes(1);
  });

  it("issues distinct ids to distinct visitors", () => {
    const first = run(undefined).req.voterId;
    const second = run(undefined).req.voterId;

    expect(first).not.toBe(second);
  });

  it("keeps the cookie for a year", () => {
    const { options } = run(undefined);

    expect(options().maxAge).toBe(365 * 24 * 60 * 60 * 1000);
  });

  it("marks the cookie secure only in production", () => {
    process.env.NODE_ENV = "production";
    const production = run(undefined).options();

    process.env.NODE_ENV = "development";
    const development = run(undefined).options();

    expect(production.secure).toBe(true);
    expect(development.secure).toBe(false);
  });
});
