import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import {
  CSRF_COOKIE,
  csrfToken,
  maskToken,
  validateCsrf,
} from "../../middlewares/csrf.ts";

const VALID = "a".repeat(64);

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    method: "GET",
    // validateCsrf asks expectsJson which kind of 403 to send, and that reads
    // the path. An ordinary page is the default; the JSON endpoints name
    // their own below.
    path: "/",
    headers: {},
    body: {},
    ...overrides,
  } as Request;
}

function makeRes(): Response {
  return {
    cookie: vi.fn(),
    locals: {},
    status: vi.fn().mockReturnThis(),
    send: vi.fn(),
    json: vi.fn().mockReturnThis(),
    render: vi.fn(),
  } as unknown as Response;
}

describe("csrfToken", () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
  });

  it("issues a token and a cookie when the browser has none", () => {
    const req = makeReq();
    const res = makeRes();

    csrfToken(req, res, next);

    expect(req.csrfToken).toMatch(/^[0-9a-f]{64}$/);
    // The rendered token is a masked copy, never the secret itself — see
    // maskToken. The cookie still carries the secret.
    expect(res.locals.csrfToken).toMatch(/^[0-9a-f]{128}$/);
    expect(res.locals.csrfToken).not.toBe(req.csrfToken);
    expect(res.cookie).toHaveBeenCalledWith(
      CSRF_COOKIE,
      req.csrfToken,
      expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" }),
    );
    expect(next).toHaveBeenCalled();
  });

  it("keeps the secret the browser already holds", () => {
    const req = makeReq({ headers: { cookie: `${CSRF_COOKIE}=${VALID}` } });
    const res = makeRes();

    csrfToken(req, res, next);

    expect(req.csrfToken).toBe(VALID);
  });

  /**
   * The cookie used to be sent only when one had to be minted, so its month
   * ran from the first visit rather than from the last — a visitor who came
   * back every week still lost it on the thirtieth day, and the next form they
   * submitted was refused through no fault of their own.
   *
   * The secret must survive the refresh. Minting a new one here would expire
   * every token already rendered into a page somebody has open, which is the
   * same 403 arriving by a different route.
   */
  it("re-sends the existing cookie so its expiry slides", () => {
    const req = makeReq({ headers: { cookie: `${CSRF_COOKIE}=${VALID}` } });
    const res = makeRes();

    csrfToken(req, res, next);

    expect(res.cookie).toHaveBeenCalledWith(
      CSRF_COOKIE,
      VALID,
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 30 * 24 * 60 * 60 * 1000,
      }),
    );
  });

  it("replaces a token that is not a 64-character hex string", () => {
    for (const value of ["short", "z".repeat(64), ""]) {
      const req = makeReq({ headers: { cookie: `${CSRF_COOKIE}=${value}` } });
      const res = makeRes();

      csrfToken(req, res, next);

      expect(req.csrfToken).not.toBe(value);
      expect(res.cookie).toHaveBeenCalled();
    }
  });

  it("finds its cookie among others", () => {
    const req = makeReq({
      headers: { cookie: `osg_vid=x; ${CSRF_COOKIE}=${VALID}; other=y` },
    });
    const res = makeRes();

    csrfToken(req, res, next);

    expect(req.csrfToken).toBe(VALID);
  });

  /**
   * Every response used to carry the secret itself, in a <meta> tag beside the
   * visitor's own reflected "?search=" value, over a compressed body — the
   * BREACH setup. A pad drawn per response leaves nothing stable to compress a
   * guess against.
   */
  it("renders a different token on every response for one secret", () => {
    const req = makeReq({ headers: { cookie: `${CSRF_COOKIE}=${VALID}` } });
    const rendered = new Set<string>();

    for (let attempt = 0; attempt < 20; attempt++) {
      const res = makeRes();

      csrfToken(req, res, next);

      expect(req.csrfToken).toBe(VALID);
      rendered.add(res.locals.csrfToken as string);
    }

    expect(rendered.size).toBe(20);
  });

  it("never renders the secret itself", () => {
    const req = makeReq({ headers: { cookie: `${CSRF_COOKIE}=${VALID}` } });
    const res = makeRes();

    csrfToken(req, res, next);

    expect(res.locals.csrfToken).not.toContain(VALID);
  });

  // The token used to live in the session, which made express-session persist
  // a row for every visitor that would never submit anything.
  it("does not touch the session", () => {
    const session = {};
    const req = makeReq({ session } as Partial<Request>);

    csrfToken(req, makeRes(), next);

    expect(session).toEqual({});
  });
});

describe("validateCsrf", () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
  });

  it.each(["GET", "HEAD", "OPTIONS"])("lets %s through", (method) => {
    validateCsrf(makeReq({ method }), makeRes(), next);

    expect(next).toHaveBeenCalled();
  });

  // Masked, which is the only form validateCsrf takes and the only one any
  // template renders. What these two are checking is the carrier — the form
  // field and the header — not the encoding.
  it("accepts a matching token from the form body", () => {
    const req = makeReq({ method: "POST", body: { _csrf: maskToken(VALID) } });
    req.csrfToken = VALID;

    validateCsrf(req, makeRes(), next);

    expect(next).toHaveBeenCalled();
  });

  it("accepts a matching token from the header", () => {
    const req = makeReq({
      method: "POST",
      headers: { "x-csrf-token": maskToken(VALID) },
    });
    req.csrfToken = VALID;

    validateCsrf(req, makeRes(), next);

    expect(next).toHaveBeenCalled();
  });

  it("rejects a request that carries no token", () => {
    const req = makeReq({ method: "POST" });
    req.csrfToken = VALID;
    const res = makeRes();

    validateCsrf(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a token of the right shape but the wrong value", () => {
    const req = makeReq({ method: "POST", body: { _csrf: "b".repeat(64) } });
    req.csrfToken = VALID;
    const res = makeRes();

    validateCsrf(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a token of a different length without throwing", () => {
    const req = makeReq({ method: "POST", body: { _csrf: "short" } });
    req.csrfToken = VALID;
    const res = makeRes();

    expect(() => validateCsrf(req, res, next)).not.toThrow();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  // The length guard used to count characters while timingSafeEqual counts
  // bytes, so a token of 64 multi-byte characters cleared the check and then
  // threw — a forged token came back as a 500 instead of a 403.
  it("rejects a multi-byte token of the same character length without throwing", () => {
    const req = makeReq({ method: "POST", body: { _csrf: "é".repeat(64) } });
    req.csrfToken = VALID;
    const res = makeRes();

    expect(() => validateCsrf(req, res, next)).not.toThrow();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a multi-byte token sent through the header", () => {
    const req = makeReq({
      method: "POST",
      headers: { "x-csrf-token": "😀".repeat(32) },
    });
    req.csrfToken = VALID;
    const res = makeRes();

    expect(() => validateCsrf(req, res, next)).not.toThrow();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  // Each response masks the same secret differently, and any of those masks
  // has to validate — a visitor may submit a form from a page older than the
  // one their next request renders.
  it("accepts any mask of the right secret", () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const localNext = vi.fn();
      const req = makeReq({
        method: "POST",
        body: { _csrf: maskToken(VALID) },
      });
      req.csrfToken = VALID;

      validateCsrf(req, makeRes(), localNext);

      expect(localNext).toHaveBeenCalled();
    }
  });

  it("rejects a mask of the wrong secret", () => {
    const req = makeReq({
      method: "POST",
      body: { _csrf: maskToken("b".repeat(64)) },
    });
    req.csrfToken = VALID;
    const res = makeRes();

    validateCsrf(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  /**
   * The bare secret was accepted for a while after masking arrived, so that a
   * page rendered before the change did not stop working. It is refused now.
   *
   * Masking exists so that no two responses carry the same bytes for the
   * secret — that is what breaks the correlation BREACH depends on, with the
   * visitor's own "?search=" reflected into the navbar over a compressed
   * body. Accepting the stable form as well left the attack's payoff intact:
   * a secret recovered from response lengths was still a token this would
   * take. The cookie lives a month and no template has rendered an unmasked
   * token since, so the compatibility window is long closed.
   */
  it("refuses the bare secret, which only a pre-masking page would send", () => {
    const req = makeReq({ method: "POST", body: { _csrf: VALID } });
    req.csrfToken = VALID;
    const res = makeRes();

    validateCsrf(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a 128-character value that is not hex without throwing", () => {
    const req = makeReq({ method: "POST", body: { _csrf: "z".repeat(128) } });
    req.csrfToken = VALID;
    const res = makeRes();

    expect(() => validateCsrf(req, res, next)).not.toThrow();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  /**
   * The reason has to reach the client in the shape it reads. comments.js and
   * rating-stars.js both take it off `error` in a JSON body, so a plain-text
   * 403 made response.json() throw and the visitor was shown the generic
   * "Could not post the comment" / "Failed to submit rating" — the one
   * message that does not say what to do about it. This is the same trade the
   * rate limiters make by sending message objects.
   */
  describe("the shape of the refusal", () => {
    const JSON_ENDPOINTS = [
      ["POST", "/comments"],
      ["POST", "/games/12/rate"],
      ["POST", "/games/12/play"],
    ] as const;

    it.each(JSON_ENDPOINTS)(
      "answers %s %s with a JSON reason",
      (method, path) => {
        const req = makeReq({ method, path });
        req.csrfToken = VALID;
        const res = makeRes();

        validateCsrf(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith({
          error: expect.stringContaining("reload"),
        });
        expect(res.send).not.toHaveBeenCalled();
        expect(next).not.toHaveBeenCalled();
      },
    );

    // A form post that would have been answered with a page, so a JSON body
    // would be raw JSON in front of the visitor.
    it.each([
      ["POST", "/games/12"],
      ["POST", "/games/12/delete"],
      ["POST", "/comments/12/delete"],
      ["POST", "/login"],
      ["POST", "/logout"],
      ["POST", "/news"],
    ])("answers %s %s with the 403 page", (method, path) => {
      const req = makeReq({ method, path });
      req.csrfToken = VALID;
      const res = makeRes();

      validateCsrf(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      // The rendered page, not the line of plain text this used to send —
      // these are all form posts, so the answer is a document either way and
      // it may as well be the site's own.
      expect(res.render).toHaveBeenCalledWith("403", {
        // See the note on the same assertion in
        // tests/middlewares/is-admin.test.ts.
        noindex: true,
        message: expect.stringContaining("reload"),
      });
      expect(res.json).not.toHaveBeenCalled();
      expect(res.send).not.toHaveBeenCalled();
    });
  });

  it("rejects when the browser has no token of its own", () => {
    const req = makeReq({ method: "POST", body: { _csrf: VALID } });
    const res = makeRes();

    validateCsrf(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it.each(["PUT", "PATCH", "DELETE"])("guards %s as well", (method) => {
    const req = makeReq({ method });
    req.csrfToken = VALID;
    const res = makeRes();

    validateCsrf(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});
