import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import {
  CSRF_COOKIE,
  csrfToken,
  issueCsrfSecret,
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
    // expectsJson negotiates POST /comments per request, because the same
    // form is also submitted without JavaScript. A browser form post is the
    // default; the fetch() case below overrides `is`.
    is: (() => false) as unknown as Request["is"],
    accepts: (() => "html") as unknown as Request["accepts"],
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

  /**
   * The cookie is SameSite=Lax, so a top-level POST from another site
   * arrives without it. Minting here Set-Cookie'd a fresh secret over the
   * one every open tab held tokens for, and the visitor's next submit was
   * the "expired" 403 — a nuisance any other page could inflict. The request
   * carries no token that could match, so validateCsrf refuses it anyway.
   */
  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "mints nothing on a %s with no cookie",
    (method) => {
      const req = makeReq({ method });
      const res = makeRes();

      csrfToken(req, res, next);

      expect(req.csrfToken).toBeUndefined();
      expect(res.locals.csrfToken).toBeUndefined();
      expect(res.cookie).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    },
  );

  it("still reads and re-sends the secret it is given on a POST", () => {
    const req = makeReq({
      method: "POST",
      headers: { cookie: `${CSRF_COOKIE}=${VALID}` },
    });
    const res = makeRes();

    csrfToken(req, res, next);

    expect(req.csrfToken).toBe(VALID);
    expect(res.cookie).toHaveBeenCalledWith(CSRF_COOKIE, VALID, expect.anything());
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
  /**
   * Defence in depth behind the token, and production only: the suite and a
   * developer's browser run on localhost under any number of ports, and
   * SITE_URL names the live origin, so comparing against it outside
   * production would refuse every form post on a developer's machine.
   */
  describe("the Origin check", () => {
    function inProduction<T>(run: () => T): T {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      try {
        return run();
      } finally {
        process.env.NODE_ENV = previous;
      }
    }

    function post(origin?: string): { req: Request; res: Response } {
      const req = makeReq({
        method: "POST",
        body: { _csrf: maskToken(VALID) },
        headers: origin === undefined ? {} : { origin },
      });
      req.csrfToken = VALID;

      return { req, res: makeRes() };
    }

    it("accepts a valid token from the site's own origin", () => {
      const { req, res } = post("https://oldschoolgames.eu");

      inProduction(() => validateCsrf(req, res, next));

      expect(next).toHaveBeenCalled();
    });

    /**
     * A missing Origin is not evidence of anything. Browsers omit it on
     * same-origin form posts, which is exactly what the comment form sends
     * with scripts off, and curl and the health checkers send nothing either
     * — so requiring it would refuse the very submits this site is built to
     * accept.
     */
    it("accepts a valid token with no Origin at all", () => {
      const { req, res } = post(undefined);

      inProduction(() => validateCsrf(req, res, next));

      expect(next).toHaveBeenCalled();
    });

    it("refuses a valid token sent from another origin", () => {
      const { req, res } = post("https://evil.example");

      inProduction(() => validateCsrf(req, res, next));

      expect(next).not.toHaveBeenCalled();
      // The same refusal a bad token gets, deliberately: separate answers
      // would tell a prober which check it tripped.
      expect(res.status).toHaveBeenCalledWith(403);
    });

    /**
     * "null" is what a browser writes for an opaque origin — a sandboxed
     * frame, a data: URL — and it is also what it wrote for *every* same-
     * origin form post while the site sent "Referrer-Policy: no-referrer",
     * which is how the login came to answer 403 in production only. The fix
     * is the policy app.ts sends, not accepting "null" here: doing that
     * would have let an opaque origin past the check for good.
     */
    it("refuses a null Origin", () => {
      const { req, res } = post("null");

      inProduction(() => validateCsrf(req, res, next));

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    // Nobody legitimately repeats the header, and an array cannot equal the
    // canonical origin — which is the right answer for it.
    it("refuses a repeated Origin header", () => {
      const req = makeReq({
        method: "POST",
        body: { _csrf: maskToken(VALID) },
        headers: { origin: ["https://oldschoolgames.eu"] as any },
      });
      req.csrfToken = VALID;
      const res = makeRes();

      inProduction(() => validateCsrf(req, res, next));

      expect(next).not.toHaveBeenCalled();
    });

    /**
     * Outside production it is not applied at all, which is what keeps the
     * suite above and every development server working — and is asserted
     * rather than assumed, because a check that silently started applying
     * everywhere would refuse every form post on localhost.
     */
    it("is not applied outside production", () => {
      const { req, res } = post("https://evil.example");

      validateCsrf(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  /**
   * The login rotates the secret, so every tab opened before it holds a page
   * whose token masks the old one. Clicking Logout in such a tab was answered
   * "your session has expired — please reload the page" while the week-long
   * session behind it stayed signed in: on a shared machine, that reads as
   * logged out, and it is not.
   *
   * A logout is let through with a stale token, or none, when its Origin
   * proves a page of this site sent it. That is all a token would have proven
   * here, and a forged logout is already stopped by SameSite and by the
   * refusal of a foreign Origin above. Nothing else is let through this way.
   */
  describe("a logout from a page rendered before the secret changed", () => {
    const SITE = "https://oldschoolgames.eu";
    const STALE = maskToken("b".repeat(64));

    function inProduction<T>(run: () => T): T {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      try {
        return run();
      } finally {
        process.env.NODE_ENV = previous;
      }
    }

    function logout(
      overrides: Partial<Request> & { origin?: string | string[] } = {},
    ): { req: Request; res: Response } {
      const { origin, ...rest } = overrides;
      const req = makeReq({
        method: "POST",
        path: "/logout",
        body: { _csrf: STALE },
        headers: origin === undefined ? {} : { origin: origin as string },
        ...rest,
      });
      req.csrfToken = VALID;

      return { req, res: makeRes() };
    }

    it("lets it through when its Origin is this site's", () => {
      const { req, res } = logout({ origin: SITE });

      inProduction(() => validateCsrf(req, res, next));

      expect(next).toHaveBeenCalledWith();
      expect(res.status).not.toHaveBeenCalled();
    });

    // The first request after the cookie was cleared carries no secret at
    // all, and a form with no token field is the same case again.
    it("lets it through with no token and no secret at all", () => {
      const { req, res } = logout({ origin: SITE, body: {} });
      req.csrfToken = undefined;

      inProduction(() => validateCsrf(req, res, next));

      expect(next).toHaveBeenCalledWith();
    });

    // Absence proves nothing, which is why hasForeignOrigin lets it through
    // to the token check — and why it cannot stand in for the token here.
    it("still wants the token when there is no Origin", () => {
      const { req, res } = logout();

      inProduction(() => validateCsrf(req, res, next));

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it.each([
      ["another site's", "https://evil.example"],
      ["an opaque", "null"],
      ["the site's host over plain HTTP", "http://oldschoolgames.eu"],
      ["a subdomain's", "https://www.oldschoolgames.eu"],
    ])("refuses one with %s Origin", (_label, origin) => {
      const { req, res } = logout({ origin });

      inProduction(() => validateCsrf(req, res, next));

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it("refuses a repeated Origin header", () => {
      const { req, res } = logout({ origin: [SITE, SITE] });

      inProduction(() => validateCsrf(req, res, next));

      expect(res.status).toHaveBeenCalledWith(403);
    });

    // The logout and only the logout: every other form still needs its token,
    // Origin or not.
    it.each([
      ["POST", "/login"],
      ["POST", "/comments"],
      ["POST", "/games/12/delete"],
      ["POST", "/comments/12/delete"],
      ["POST", "/logout/"],
      ["POST", "/logout/anything"],
      ["POST", "/news/logout"],
      ["PUT", "/logout"],
      ["DELETE", "/logout"],
    ])("still refuses a stale token on %s %s", (method, path) => {
      const { req, res } = logout({ origin: SITE, method, path });

      inProduction(() => validateCsrf(req, res, next));

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    // A logout that carries a good token is judged by it, as it always was.
    it("still accepts a logout with a good token and no Origin", () => {
      const { req, res } = logout({ body: { _csrf: maskToken(VALID) } });

      inProduction(() => validateCsrf(req, res, next));

      expect(next).toHaveBeenCalledWith();
    });

    // Outside production there is no canonical origin to hold the header
    // against — the same reason hasForeignOrigin is off there — so a stale
    // logout on a developer's machine is refused as before.
    it("is production only", () => {
      const { req, res } = logout({ origin: SITE });

      validateCsrf(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("the shape of the refusal", () => {
    const JSON_ENDPOINTS = [
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

    // A comment sent by fetch() carries a JSON body; only then is a JSON
    // reason the right shape. The plain form post is in the page table below.
    it("answers a fetch()ed comment post with a JSON reason", () => {
      const req = makeReq({
        method: "POST",
        path: "/comments",
        is: ((type: string) =>
          type === "json" ? "application/json" : false) as unknown as Request["is"],
      });
      req.csrfToken = VALID;
      const res = makeRes();

      validateCsrf(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: expect.stringContaining("reload"),
      });
      expect(next).not.toHaveBeenCalled();
    });

    // A form post that would have been answered with a page, so a JSON body
    // would be raw JSON in front of the visitor.
    it.each([
      ["POST", "/comments"],
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

  /**
   * The test used to be a denylist — "POST, PUT, PATCH, DELETE" — so a method
   * in neither set was neither guarded nor declared safe and went through
   * unchecked. TRACE and PROPFIND are the ones a proxy or a WebDAV client
   * sends today; a router.all() added to any route tomorrow is the one that
   * would matter. Asking whether the method is *safe* instead means an unknown
   * method is validated, which is the only direction this can fall.
   */
  it.each(["TRACE", "PROPFIND", "LOCK", "SEARCH", "COPY"])(
    "refuses an unknown method with no token: %s",
    (method) => {
      const req = makeReq({ method });
      req.csrfToken = VALID;
      const res = makeRes();

      validateCsrf(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    },
  );

  // And still passes one that carries a good token, so the allowlist guards
  // the unknown method rather than blocking it outright.
  it("accepts an unknown method that carries a valid token", () => {
    const req = makeReq({
      method: "PROPFIND",
      body: { _csrf: maskToken(VALID) },
    });
    req.csrfToken = VALID;

    validateCsrf(req, makeRes(), next);

    expect(next).toHaveBeenCalled();
  });

  /**
   * An empty "_csrf" used to suppress the header entirely, because the two
   * were combined with `??` and "" is neither null nor undefined. A client
   * that sends the field unconditionally — or a form rendered before
   * csrfToken had a secret to put in it — therefore had its perfectly good
   * X-CSRF-Token ignored and was answered 403.
   */
  it("falls back to the header when the form field is empty", () => {
    const req = makeReq({
      method: "POST",
      body: { _csrf: "" },
      headers: { "x-csrf-token": maskToken(VALID) },
    });
    req.csrfToken = VALID;

    validateCsrf(req, makeRes(), next);

    expect(next).toHaveBeenCalled();
  });

  // The field still wins when it holds something: a page carrying a token is
  // the ordinary case, and a header must not be able to override it.
  it("prefers a non-empty form field over the header", () => {
    const req = makeReq({
      method: "POST",
      body: { _csrf: maskToken("b".repeat(64)) },
      headers: { "x-csrf-token": maskToken(VALID) },
    });
    req.csrfToken = VALID;
    const res = makeRes();

    validateCsrf(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  // Neither carrier holds anything, which is still a refusal rather than a
  // throw — "" reaching unmaskToken is not 128 hex characters.
  it("refuses an empty field with no header behind it", () => {
    const req = makeReq({ method: "POST", body: { _csrf: "" } });
    req.csrfToken = VALID;
    const res = makeRes();

    expect(() => validateCsrf(req, res, next)).not.toThrow();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

/**
 * The secret is in a cookie of its own rather than in the session, which is
 * what keeps it off every anonymous visitor's session row — and also what
 * means nothing about regenerating a session touches it. routes/auth.ts
 * calls this at the two moments where the identity behind the browser
 * changes, so that a secret fixed onto it beforehand cannot be used after.
 */
describe("issueCsrfSecret", () => {
  it("replaces the secret the browser was carrying", () => {
    const previous = "b".repeat(64);
    const req = makeReq({ headers: { cookie: `${CSRF_COOKIE}=${previous}` } });
    const res = makeRes();

    csrfToken(req, res, vi.fn());

    expect(req.csrfToken).toBe(previous);

    const issued = issueCsrfSecret(req, res);

    expect(issued).toMatch(/^[0-9a-f]{64}$/);
    expect(issued).not.toBe(previous);
    expect(req.csrfToken).toBe(issued);
  });

  /**
   * The same attributes csrfToken sends, because a cookie differing in path
   * or SameSite is a second cookie as far as the browser is concerned — and
   * the two would then come back in an order nothing here controls.
   */
  it("sends it with the attributes the middleware uses", () => {
    const req = makeReq();
    const res = makeRes();

    const issued = issueCsrfSecret(req, res);

    expect(res.cookie).toHaveBeenCalledWith(
      CSRF_COOKIE,
      issued,
      expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" }),
    );
  });

  // The response that calls this may still render a page, and a token
  // masking the secret that has just been replaced would be refused by the
  // very next submit.
  it("leaves a token for the new secret on the response", () => {
    const req = makeReq();
    const res = makeRes();

    const issued = issueCsrfSecret(req, res);

    expect(res.locals.csrfToken).toMatch(/^[0-9a-f]{128}$/);
    expect(validateCsrfAccepts(res.locals.csrfToken as string, issued)).toBe(
      true,
    );
  });

  it("mints a different secret every time", () => {
    const first = issueCsrfSecret(makeReq(), makeRes());
    const second = issueCsrfSecret(makeReq(), makeRes());

    expect(first).not.toBe(second);
  });
});

/** Whether validateCsrf would accept `token` from a browser holding `secret`. */
function validateCsrfAccepts(token: string, secret: string): boolean {
  const req = makeReq({
    method: "POST",
    body: { _csrf: token },
  });

  req.csrfToken = secret;

  const next = vi.fn();

  validateCsrf(req, makeRes(), next);

  return next.mock.calls.length === 1;
}
