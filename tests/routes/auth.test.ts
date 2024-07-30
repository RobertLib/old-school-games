import { beforeEach, describe, expect, it, vi, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import crypto from "crypto";
import * as password from "../../utils/password";
import authRouter from "../../routes/auth";
import User from "../../models/user";
import db from "../../db";
import { credentialOf } from "../../utils/session-credential";
import { DEVICE_COOKIE } from "../../utils/device-cookie";

/**
 * The three hashing functions mocked, and everything else the module exports
 * kept as it is — PasswordHashingBusyError above all. This used to be a bare
 * automock, which would have replaced the error class with a mock of itself:
 * the route tells "busy" from "wrong" with instanceof, and a mocked class is a
 * poor stand-in for the one it compares against.
 */
vi.mock("../../utils/password", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/password")>()),
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
  fakeVerifyPassword: vi.fn(),
}));
vi.mock("../../models/user", () => ({
  default: {
    findByEmail: vi.fn(),
    create: vi.fn(),
  },
}));

/**
 * What the last successful login wrote into its session, as the fake store's
 * save saw it — the session itself is gone by the time the response arrives.
 */
let lastSavedUser: unknown;

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const sessionHeader = req.headers.testsession;
  if (sessionHeader && typeof sessionHeader === "string") {
    try {
      const sessionData = JSON.parse(sessionHeader);
      req.session = {
        ...sessionData,
        id: "test-session-id",
        cookie: {} as any,
        regenerate: vi.fn((callback?: (err?: any) => void) => {
          if (callback) callback();
        }),
        destroy: vi.fn((callback?: (err?: any) => void) => {
          req.session = {
            id: "test-session-id",
            cookie: {} as any,
            regenerate: vi.fn(),
            destroy: vi.fn(),
            reload: vi.fn(),
            save: vi.fn((callback?: (err?: any) => void) => {
              if (callback) callback();
            }),
            touch: vi.fn(),
          } as any;
          if (callback) callback();
        }),
        reload: vi.fn(),
        save: vi.fn((callback?: (err?: any) => void) => {
          if (callback) callback();
        }),
        touch: vi.fn(),
      } as any;
    } catch {
      req.session = {
        id: "test-session-id",
        cookie: {} as any,
        regenerate: vi.fn((callback?: (err?: any) => void) => {
          if (callback) callback();
        }),
        destroy: vi.fn((callback?: (err?: any) => void) => {
          if (callback) callback();
        }),
        reload: vi.fn(),
        save: vi.fn((callback?: (err?: any) => void) => {
          if (callback) callback();
        }),
        touch: vi.fn(),
      } as any;
    }
  } else {
    req.session = {
      id: "test-session-id",
      cookie: {} as any,
      regenerate: vi.fn((callback?: (err?: any) => void) => {
        if (callback) callback();
      }),
      destroy: vi.fn((callback?: (err?: any) => void) => {
        if (callback) callback();
      }),
      reload: vi.fn(),
      // A store that can be told to fail, for the case below that proves the
      // login waits for it.
      save: vi.fn((callback?: (err?: any) => void) => {
        lastSavedUser = req.session.user;

        if (callback) {
          callback(
            req.headers["x-test-save-error"] ? new Error("store down") : undefined,
          );
        }
      }),
      touch: vi.fn(),
    } as any;
  }
  next();
});

app.use((req, res, next) => {
  res.render = vi.fn((view, data) => {
    res.json({ view, data });
  });
  next();
});

/**
 * The address the limiters count against, settable per request.
 *
 * Every request in this file comes off the same loopback socket, so req.ip is
 * 127.0.0.1 for all of them — and the point of keying the account limiter on
 * the account *and* the caller is that two callers are two budgets, which
 * cannot be expressed without two addresses. A header rather than a second
 * app, so these cases run against exactly the stack every other test here
 * uses.
 *
 * defineProperty because req.ip is a getter on Express's request prototype.
 */
app.use((req, res, next) => {
  const forced = req.headers["x-test-ip"];

  if (typeof forced === "string") {
    Object.defineProperty(req, "ip", { value: forced, configurable: true });
  }

  next();
});

app.use(authRouter);

/**
 * One listening server for the whole file, handed to supertest directly.
 *
 * `request(app)` opens a fresh server on an ephemeral port for every single
 * call and closes it again when the response arrives — this suite did that a
 * few hundred times a run. Ports come back round: a request could be answered
 * by whatever had taken the port since, which showed up as an assertion
 * failing against a status the routes under test cannot even produce (a 401,
 * from an app with no authentication in it at all). Intermittent, unrelated to
 * the code being tested, and impossible to read.
 *
 * Passing the server instead means supertest opens and closes nothing.
 */
const server = app.listen(0);

afterAll(() => {
  server.close();
});

describe("Auth Routes", () => {
  /**
   * The same cleanup the rate-limit describes below have, and for a reason
   * this block gave itself: nine of the cases in it post a login that is
   * refused, and every one of those is charged to the per-IP limiter — ten
   * failures per quarter hour, all of them from 127.0.0.1. Nothing here put
   * the rows back, so the file ran with one attempt of headroom left and any
   * case added to this block, or any retry, turned into a 429 that has nothing
   * to do with what the case is about.
   *
   * Every prefix the login route writes, not just "login:": the account
   * limiter and its per-caller half count the same requests.
   */
  beforeEach(async () => {
    vi.clearAllMocks();

    await db.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login%'`);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login%'`);
  });

  describe("GET /login", () => {
    it("should render login page", async () => {
      const response = await request(server).get("/login");

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("auth/login");
      expect(response.body.data).toBeUndefined();
    });
  });

  describe("POST /login", () => {
    const mockUser = {
      id: 1,
      email: "test@example.com",
      password: "hashedpassword",
      role: "USER",
    };

    /**
     * express-session's own save runs inside its res.end wrapper, which
     * writes the status line and headers before the store has answered — and
     * a browser follows a 302 the moment the headers arrive. So the GET /
     * after a login could reach the app before the session row existed and
     * render the page logged out. The route now saves first and redirects
     * from the callback; a store that fails is therefore an error rather than
     * a redirect into a session that was never written.
     */
    it("waits for the session to be saved before it redirects", async () => {
      vi.mocked(User.findByEmail).mockResolvedValue(mockUser as any);
      vi.mocked(password.verifyPassword).mockResolvedValue(true);

      const response = await request(server)
        .post("/login")
        .set("x-test-save-error", "1")
        .send({ email: "test@example.com", password: "password123" });

      expect(response.status).toBe(500);
      expect(response.headers.location).toBeUndefined();
    });

    it("should login successfully with valid credentials", async () => {
      vi.mocked(User.findByEmail).mockResolvedValue(mockUser as any);
      vi.mocked(password.verifyPassword).mockResolvedValue(true);

      const response = await request(server).post("/login").send({
        email: "test@example.com",
        password: "password123",
      });

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");
      expect(User.findByEmail).toHaveBeenCalledWith("test@example.com");
      // No device cookie, so no priority at the hashing queue — see
      // checkPassword in routes/auth.ts.
      expect(password.verifyPassword).toHaveBeenCalledWith(
        "password123",
        "hashedpassword",
        { priority: false },
      );
    });

    /**
     * 400 for a malformed post and 401 for a refused credential, where all six
     * of these used to answer 200 with the form and its message.
     *
     * The body is unchanged — the visitor sees the same page either way — but
     * the status is what everything other than a human reads: a 200 tells a
     * password manager the credentials it just filled in worked, so it offers
     * to save them, and it makes a failed login indistinguishable from a
     * successful one in an access log.
     */
    it("should return error when email is missing", async () => {
      const response = await request(server).post("/login").send({
        password: "password123",
      });

      expect(response.status).toBe(400);
      expect(response.body.view).toBe("auth/login");
      expect(response.body.data.error).toBe("All fields are required.");
    });

    it("should return error when password is missing", async () => {
      const response = await request(server).post("/login").send({
        email: "test@example.com",
      });

      expect(response.status).toBe(400);
      expect(response.body.view).toBe("auth/login");
      expect(response.body.data.error).toBe("All fields are required.");
    });

    it("should return error when both email and password are missing", async () => {
      const response = await request(server).post("/login").send({});

      expect(response.status).toBe(400);
      expect(response.body.view).toBe("auth/login");
      expect(response.body.data.error).toBe("All fields are required.");
    });

    // "email[]=a&email[]=b" arrives as an array, which a bare falsy check let
    // through — scrypt then threw on the non-string password and the malformed
    // post came back a 500.
    it("refuses a non-string email or password instead of throwing", async () => {
      const response = await request(server)
        .post("/login")
        .type("form")
        .send("email[]=a@b.c&email[]=x&password[]=p&password[]=q");

      expect(response.status).toBe(400);
      expect(response.body.view).toBe("auth/login");
      expect(response.body.data.error).toBe("All fields are required.");
    });

    it("should return error when user is not found", async () => {
      vi.mocked(User.findByEmail).mockResolvedValue(null);

      const response = await request(server).post("/login").send({
        email: "nonexistent@example.com",
        password: "password123",
      });

      expect(response.status).toBe(401);
      expect(response.body.view).toBe("auth/login");
      expect(response.body.data.error).toBe("Invalid credentials.");
      expect(User.findByEmail).toHaveBeenCalledWith("nonexistent@example.com");
    });

    it("should return error when password is invalid", async () => {
      vi.mocked(User.findByEmail).mockResolvedValue(mockUser as any);
      vi.mocked(password.verifyPassword).mockResolvedValue(false);

      const response = await request(server).post("/login").send({
        email: "test@example.com",
        password: "wrongpassword",
      });

      expect(response.status).toBe(401);
      expect(response.body.view).toBe("auth/login");
      expect(response.body.data.error).toBe("Invalid credentials.");
      expect(User.findByEmail).toHaveBeenCalledWith("test@example.com");
      expect(password.verifyPassword).toHaveBeenCalledWith(
        "wrongpassword",
        "hashedpassword",
        { priority: false },
      );
    });

    /**
     * The address comes back on a refused attempt; the password never does.
     *
     * Retyping an address to find out it was the password that was wrong is
     * the thing this fixes — and a browser that has just been told the login
     * failed will not refill the field by itself. The password is the other
     * half of the same decision and the more important one: re-rendered into
     * HTML it would sit in the page source, in the back/forward cache and in
     * any proxy that saw the response.
     */
    it("echoes the submitted e-mail back, and never the password", async () => {
      vi.mocked(User.findByEmail).mockResolvedValue(mockUser as any);
      vi.mocked(password.verifyPassword).mockResolvedValue(false);

      const response = await request(server).post("/login").send({
        email: "test@example.com",
        password: "hunter2",
      });

      expect(response.body.data.email).toBe("test@example.com");
      expect(JSON.stringify(response.body.data)).not.toContain("hunter2");
    });

    /**
     * The malformed-post branch, where `email` is not a string at all —
     * "email[]=a&email[]=b" arrives as an array, and handing that to the
     * template would render "a,b" into the field.
     */
    it("does not echo an e-mail that is not a string", async () => {
      const response = await request(server)
        .post("/login")
        .send("email[]=a&email[]=b&password=x");

      expect(response.status).toBe(400);
      expect(response.body.data.email).toBe("");
    });

    it("should set session user data on successful login", async () => {
      vi.mocked(User.findByEmail).mockResolvedValue(mockUser as any);
      vi.mocked(password.verifyPassword).mockResolvedValue(true);

      const response = await request(server).post("/login").send({
        email: "test@example.com",
        password: "password123",
      });

      expect(response.status).toBe(302);
    });

    /**
     * The session carries the credential it was opened with — a fingerprint
     * of the password hash at the moment of the login — so that
     * middlewares/is-admin.ts can tell it apart from a session opened under a
     * password that has since been reset. Without it a reset could only end a
     * session by deleting its row, and anything that put the row back handed
     * back a full admin.
     */
    it("records the credential the session was opened with", async () => {
      vi.mocked(User.findByEmail).mockResolvedValue(mockUser as any);
      vi.mocked(password.verifyPassword).mockResolvedValue(true);
      lastSavedUser = undefined;

      const response = await request(server).post("/login").send({
        email: "test@example.com",
        password: "password123",
      });

      expect(response.status).toBe(302);
      expect(lastSavedUser).toEqual({
        id: 1,
        email: "test@example.com",
        role: "USER",
        credential: credentialOf("hashedpassword"),
      });
    });

    /**
     * The process-wide limit on password hashing (see derive in
     * utils/password.ts) refuses a derivation once two are running and eight
     * are waiting. That is a busy server, not a refused credential, and the
     * answer has to say so: a 503 with a Retry-After for whatever reads the
     * status, and the form with a message for the person who sent it.
     */
    describe("when password hashing is at capacity", () => {
      it("answers 503 with a Retry-After and says the password was not checked", async () => {
        vi.mocked(User.findByEmail).mockResolvedValue(mockUser as any);
        vi.mocked(password.verifyPassword).mockRejectedValueOnce(
          new password.PasswordHashingBusyError(),
        );

        const response = await request(server).post("/login").send({
          email: "test@example.com",
          password: "password123",
        });

        expect(response.status).toBe(503);
        expect(response.headers["retry-after"]).toBe("1");
        expect(response.body.view).toBe("auth/login");
        expect(response.body.data.error).toMatch(/busy/i);
        expect(response.body.data.error).not.toMatch(/invalid credentials/i);
        // The address comes back as it does on any refusal; the password never.
        expect(response.body.data.email).toBe("test@example.com");
        expect(JSON.stringify(response.body.data)).not.toContain("password123");
      });

      // The same answer for an address with no account, or "busy" itself
      // would say which addresses have one.
      it("answers the same for an address with no account", async () => {
        vi.mocked(User.findByEmail).mockResolvedValue(null);
        vi.mocked(password.fakeVerifyPassword).mockRejectedValueOnce(
          new password.PasswordHashingBusyError(),
        );

        const response = await request(server).post("/login").send({
          email: "nobody@example.com",
          password: "password123",
        });

        expect(response.status).toBe(503);
        expect(response.headers["retry-after"]).toBe("1");
        expect(response.body.data.error).toMatch(/busy/i);
      });

      it("hands any other failure to the error handler", async () => {
        vi.mocked(User.findByEmail).mockResolvedValue(mockUser as any);
        vi.mocked(password.verifyPassword).mockRejectedValueOnce(
          new Error("something else entirely"),
        );

        const response = await request(server).post("/login").send({
          email: "test@example.com",
          password: "password123",
        });

        expect(response.status).toBe(500);
      });
    });
  });

  /**
   * The CSRF secret lives in a cookie of its own rather than in the session
   * (see middlewares/csrf.ts), so express-session regenerating its id on
   * login left it untouched: a secret an attacker had fixed onto the browser
   * beforehand went on minting tokens the now-privileged session accepted.
   * Both moments where the identity behind the browser changes rotate it.
   */
  describe("rotating the CSRF secret", () => {
    /** The secret a response set, whatever name the cookie has here. */
    function issuedSecret(response: { headers: Record<string, unknown> }) {
      const cookies = (response.headers["set-cookie"] as string[]) ?? [];

      return cookies
        .map((cookie) => /^(?:__Host-)?osg_csrf=([0-9a-f]{64})/.exec(cookie))
        .find(Boolean)?.[1];
    }

    it("mints a fresh one when a login succeeds", async () => {
      vi.mocked(User.findByEmail).mockResolvedValue({
        id: 1,
        email: "test@example.com",
        password: "hashed",
        role: "ADMIN",
      } as never);
      vi.mocked(password.verifyPassword).mockResolvedValue(true);

      const response = await request(server)
        .post("/login")
        .send({ email: "test@example.com", password: "password123" });

      expect(response.status).toBe(302);
      expect(issuedSecret(response)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("mints nothing when the login is refused", async () => {
      vi.mocked(User.findByEmail).mockResolvedValue(null as never);

      const response = await request(server)
        .post("/login")
        .send({ email: "test@example.com", password: "wrong" });

      expect(response.status).toBe(401);
      expect(issuedSecret(response)).toBeUndefined();
    });

    // Everything identifying this browser as the one that was logged in
    // ends at the logout, not just the session id.
    it("mints a fresh one on the way out too", async () => {
      const response = await request(server).post("/logout");

      expect(issuedSecret(response)).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("POST /logout", () => {
    it("should logout user and redirect to home", async () => {
      const response = await request(server)
        .post("/logout")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "test@example.com", role: "USER" },
          }),
        );

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");
    });

    it("should work even when user is not logged in", async () => {
      const response = await request(server).post("/logout");

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");
    });

    it("tells the browser to drop the session cookie", async () => {
      const response = await request(server)
        .post("/logout")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "test@example.com", role: "USER" },
          }),
        );

      // destroy() only removes the row in the store, so without an explicit
      // clear the cookie stayed in the browser and was sent on every later
      // request, pointing at a session that no longer existed.
      const cleared = (response.headers["set-cookie"] as unknown as string[])
        .filter((cookie) => cookie.startsWith("connect.sid="))
        .find((cookie) => /Expires=Thu, 01 Jan 1970/i.test(cookie));

      expect(cleared).toBeDefined();
      // The attributes have to match the ones the cookie was set with or the
      // browser keeps it — Path above all, which express-session defaults to.
      expect(cleared).toMatch(/Path=\//i);
      expect(cleared).toMatch(/HttpOnly/i);

      // And the session cookie is still the one being cleared: rotating the
      // CSRF secret on the same response adds a Set-Cookie, it does not
      // replace this one.
      const all = response.headers["set-cookie"] as unknown as string[];

      expect(all.some((cookie) => /osg_csrf=[0-9a-f]{64}/.test(cookie))).toBe(
        true,
      );
    });
  });
});

/**
 * The budget is a brake on guessing, and a login that succeeded is not a
 * guess — but it used to spend the same budget, shared by everyone behind one
 * address. An admin who mistyped twice and then got it right had three of
 * their ten gone for the next quarter hour, and an office behind a single NAT
 * hit the limit on ordinary use.
 *
 * These read the counter out of the table the store writes to, because that
 * is where the effect is: the refund does not change the response, only what
 * the next request is charged.
 */
describe("POST /login rate limiting", () => {
  const credentials = { email: "test@example.com", password: "password123" };

  const mockUser = {
    id: 1,
    email: "test@example.com",
    password: "hashedpassword",
    role: "USER",
  };

  async function loginHits(): Promise<number> {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM("hits"), 0)::int AS hits FROM "rate_limits"
        WHERE "key" LIKE 'login:%' AND "expiresAt" > NOW()`,
    );

    return rows[0].hits;
  }

  /**
   * Polled rather than read once. express-rate-limit hangs the refund off the
   * response's own "finish" event, so it is still a database round trip in
   * flight by the time supertest has the answer — reading straight after the
   * request is a race, and the kind that fails on a loaded machine only.
   */
  async function waitForHits(expected: number): Promise<number> {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await loginHits()) === expected) return expected;

      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    return loginHits();
  }

  beforeEach(async () => {
    await db.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login:%'`);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login:%'`);
  });

  /**
   * A failure first, so there is something to give back.
   *
   * This used to be the successful login alone, asserted with waitForHits(0)
   * — against a table the beforeEach above had just emptied. Zero is what an
   * empty table reads as, the poll returns on its first attempt, and the case
   * passed whether the limiter counted, refunded, or was never reached at all.
   * Starting from a counter that is provably one means the assertion has
   * something to distinguish: without the refund the second request leaves it
   * at two.
   */
  it("gives the attempt back when the login succeeds", async () => {
    vi.mocked(User.findByEmail).mockResolvedValue(null);

    const refused = await request(server).post("/login").send(credentials);

    expect(refused.status).toBe(401);
    expect(await waitForHits(1)).toBe(1);

    vi.mocked(User.findByEmail).mockResolvedValue(mockUser as any);
    vi.mocked(password.verifyPassword).mockResolvedValue(true);

    const response = await request(server).post("/login").send(credentials);

    expect(response.status).toBe(302);
    // The increment is awaited inside the request, so the counter is at two by
    // the time this poll starts and comes back to one only when the refund
    // lands. Without it the poll times out and reads two.
    expect(await waitForHits(1)).toBe(1);
  });

  // The other half, and the half that must not regress: this option keys off
  // the response status, so it only counts failures because the route answers
  // 401 for one. On the 200 this route used to send for a rejected login it
  // would have refunded the guess and counted nothing at all.
  /**
   * How long a refund actually takes here, provoked rather than guessed at.
   *
   * The case below has to assert that something did *not* happen, and the
   * only way to do that in time is to wait — so the length of the wait had
   * better come from the mechanism instead of from a number that happened to
   * work on one machine. A successful login is a refund by definition, so one
   * is run and the round trip timed; the case then waits out a generous
   * multiple of it.
   *
   * Left in the table by this is nothing: the hit it spends is the one it
   * then gets back, and the rows are cleared anyway.
   */
  async function measureRefundMs(): Promise<number> {
    vi.mocked(User.findByEmail).mockResolvedValue(mockUser as any);
    vi.mocked(password.verifyPassword).mockResolvedValue(true);

    const started = performance.now();

    await request(server).post("/login").send(credentials);
    // The increment is awaited as part of the request; this is the refund.
    await waitForHits(0);

    const elapsed = performance.now() - started;

    await db.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login:%'`);

    return elapsed;
  }

  it("keeps counting the ones that fail", async () => {
    const refundMs = await measureRefundMs();

    vi.mocked(User.findByEmail).mockResolvedValue(null);

    const response = await request(server).post("/login").send(credentials);

    expect(response.status).toBe(401);
    expect(await waitForHits(1)).toBe(1);

    // Held, not merely slow to be given back — and the window is ten times a
    // refund's own measured cost rather than the flat 250ms this used to
    // sleep. A fixed number is a false pass waiting for a loaded runner: the
    // refund lands a moment after it, the assertion has already been made,
    // and the test reports that failures are counted when they are not.
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(refundMs * 10, 250)),
    );

    expect(await loginHits()).toBe(1);
  });
});

/**
 * The per-account backstop on /login.
 *
 * Per-IP alone handed an attacker rotating addresses ten fresh guesses per
 * address at one account, so the failures have to be counted against the
 * account from wherever they come — but counting *only* that, at the twenty an
 * hour this used to be, made the account's own budget something a stranger who
 * knows the admin's address can spend from one machine in seconds, locking the
 * real account out for as long as they keep sending. The tight limit moved
 * onto the account-and-caller pair (the describe below); what stays here is
 * the same count at a ceiling ten times higher, which is what still bounds a
 * distributed attempt.
 *
 * The key is a hash — the rate-limit table is not a list of the addresses
 * people have tried to sign in as.
 */
describe("POST /login per-account rate limiting", () => {
  async function accountRows(): Promise<{ key: string; hits: number }[]> {
    const { rows } = await db.query(
      `SELECT "key", "hits" FROM "rate_limits"
        WHERE "key" LIKE 'login-account:%' AND "expiresAt" > NOW()`,
    );

    return rows;
  }

  async function waitForRows(expected: number) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await accountRows();

      if (rows.length === expected) return rows;

      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    return accountRows();
  }

  // Every prefix the route writes, not only the one these cases read. The
  // tight per-caller half writes "login-account-ip:" rows for the same
  // requests, and the per-IP limiter above writes "login:" — eight refused
  // logins in this block against a budget of ten, so a run that left those
  // behind would answer 429 somewhere in the middle for reasons having nothing
  // to do with the case that failed.
  beforeEach(async () => {
    await db.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login%'`);
    vi.mocked(User.findByEmail).mockResolvedValue(null);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login%'`);
  });

  it("counts failures against the account, whatever the case of the address", async () => {
    await request(server).post("/login").send({ email: "Someone@Example.com", password: "x" });
    await request(server).post("/login").send({ email: " someone@example.com ", password: "y" });

    const rows = await waitForRows(1);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.hits).toBe(2);
  });

  it("stores a hash of the address, never the address", async () => {
    await request(server).post("/login").send({ email: "someone@example.com", password: "x" });

    const [row] = await waitForRows(1);

    expect(row!.key).toMatch(/^login-account:[0-9a-f]{64}$/);
    expect(row!.key).not.toContain("someone");
  });

  it("keeps separate accounts apart", async () => {
    await request(server).post("/login").send({ email: "a@example.com", password: "x" });
    await request(server).post("/login").send({ email: "b@example.com", password: "x" });

    const rows = await waitForRows(2);

    expect(rows.map((row) => row.hits)).toEqual([1, 1]);
  });

  /**
   * The absence, asserted through a positive case rather than through a sleep.
   *
   * This used to send the anonymous request and then sleep 100ms before
   * finding the table empty — which passes whether the limiter skipped the
   * request or merely had not written its row yet, and the second of those is
   * what a loaded machine produces. So a request that *does* name an account
   * is sent afterwards and its row polled for: by the time that row is
   * visible, a write from the earlier request — whose response finished
   * first — has had at least as long to appear, and the count being one
   * rather than two is the assertion.
   */
  it("does not count a request that names no account", async () => {
    const response = await request(server).post("/login").send({ password: "x" });

    expect(response.status).toBe(400);

    await request(server)
      .post("/login")
      .send({ email: "named@example.com", password: "x" });

    const rows = await waitForRows(1);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.hits).toBe(1);
  });

  /**
   * A failure first, for the same reason as the per-IP case above.
   *
   * This used to send the successful login on its own and then assert
   * `rows.length === 0 || rows[0].hits === 0` — both halves of which are true
   * of the empty table the beforeEach leaves behind, before the request is
   * even sent. It could not fail. Counting one failure first gives the
   * assertion something to see: the successful attempt is charged and given
   * back, leaving the row at one rather than two.
   */
  it("gives the attempt back when the login succeeds", async () => {
    const refused = await request(server)
      .post("/login")
      .send({ email: "someone@example.com", password: "wrong" });

    expect(refused.status).toBe(401);

    const [counted] = await waitForRows(1);

    expect(counted!.hits).toBe(1);

    vi.mocked(User.findByEmail).mockResolvedValue({
      id: 1,
      email: "someone@example.com",
      password: "hashed",
      role: "USER",
    } as any);
    vi.mocked(password.verifyPassword).mockResolvedValue(true);

    const response = await request(server)
      .post("/login")
      .send({ email: "someone@example.com", password: "right" });

    expect(response.status).toBe(302);

    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await accountRows();

      if (rows[0]?.hits === 1) break;

      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const rows = await accountRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.hits).toBe(1);
  });
});

/**
 * The tight brake, keyed on the account *and* the address the attempt comes
 * from.
 *
 * Twenty failures an hour against one account used to be counted per account
 * alone, which is a lockout lever rather than a brake: the admin's e-mail
 * address is not a secret, so anyone who knows it could spend the whole budget
 * from one machine in a few seconds and keep the real account out for the rest
 * of the hour, indefinitely, for the price of twenty requests.
 *
 * Keyed on the pair, one source cannot spend the account's budget. What the
 * per-account count was opened for — an attacker rotating addresses — is still
 * covered twice over: twenty per address at this account instead of ten, and
 * the two-hundred backstop above counting all of them together.
 */
describe("POST /login per-account-and-caller rate limiting", () => {
  async function pairRows(): Promise<{ key: string; hits: number }[]> {
    const { rows } = await db.query(
      `SELECT "key", "hits" FROM "rate_limits"
        WHERE "key" LIKE 'login-account-ip:%' AND "expiresAt" > NOW()
        ORDER BY "key"`,
    );

    return rows;
  }

  async function waitForPairRows(expected: number) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await pairRows();

      if (rows.length === expected) return rows;

      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    return pairRows();
  }

  beforeEach(async () => {
    await db.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login%'`);
    vi.mocked(User.findByEmail).mockResolvedValue(null);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login%'`);
  });

  /**
   * The whole point of the change, in two requests.
   *
   * Two callers guessing at one account get a budget each, so neither can
   * exhaust the other's — which is what stops one stranger locking the account
   * out. The backstop still sees both, which is what stops a hundred of them.
   */
  it("gives two callers at one account a budget each", async () => {
    await request(server)
      .post("/login")
      .set("x-test-ip", "198.51.100.7")
      .send({ email: "someone@example.com", password: "x" });

    await request(server)
      .post("/login")
      .set("x-test-ip", "203.0.113.9")
      .send({ email: "someone@example.com", password: "x" });

    const rows = await waitForPairRows(2);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.hits)).toEqual([1, 1]);

    // And counted together by the backstop, which is the half that still
    // bounds an attempt spread over many machines.
    const { rows: account } = await db.query(
      `SELECT "hits" FROM "rate_limits"
        WHERE "key" LIKE 'login-account:%' AND "expiresAt" > NOW()`,
    );

    expect(account).toHaveLength(1);
    expect(account[0].hits).toBe(2);
  });

  // One caller at one account is one budget, whatever the case of the address
  // — the account half of the key is the same hash the backstop uses.
  it("counts one caller's failures against one budget", async () => {
    await request(server)
      .post("/login")
      .set("x-test-ip", "198.51.100.7")
      .send({ email: "Someone@Example.com", password: "x" });

    await request(server)
      .post("/login")
      .set("x-test-ip", "198.51.100.7")
      .send({ email: " someone@example.com ", password: "y" });

    const rows = await waitForPairRows(1);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.hits).toBe(2);
  });

  // Two accounts from one caller stay apart, so a guess at one account cannot
  // spend the budget guarding another.
  it("keeps two accounts from one caller apart", async () => {
    await request(server)
      .post("/login")
      .set("x-test-ip", "198.51.100.7")
      .send({ email: "a@example.com", password: "x" });

    await request(server)
      .post("/login")
      .set("x-test-ip", "198.51.100.7")
      .send({ email: "b@example.com", password: "x" });

    const rows = await waitForPairRows(2);

    expect(rows.map((row) => row.hits)).toEqual([1, 1]);
  });

  /**
   * The address is in the key now, and the address people typed still is not.
   * The account half stays the sha256 the backstop uses, so the table holds no
   * list of who has tried to sign in here.
   */
  it("stores a hash of the account, never the address typed", async () => {
    await request(server)
      .post("/login")
      .set("x-test-ip", "198.51.100.7")
      .send({ email: "someone@example.com", password: "x" });

    const [row] = await waitForPairRows(1);

    expect(row!.key).toMatch(/^login-account-ip:[0-9a-f]{64}:/);
    expect(row!.key).not.toContain("someone");
  });

  // Nothing to key on and nothing to guess at: a post with no account is
  // refused with a 400 before a password is looked at, so it is not charged
  // here either. Asserted through a positive case, like the backstop's own
  // version of this above.
  it("does not count a request that names no account", async () => {
    const response = await request(server)
      .post("/login")
      .set("x-test-ip", "198.51.100.7")
      .send({ password: "x" });

    expect(response.status).toBe(400);

    await request(server)
      .post("/login")
      .set("x-test-ip", "198.51.100.7")
      .send({ email: "named@example.com", password: "x" });

    const rows = await waitForPairRows(1);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.hits).toBe(1);
  });

  // The refund reaches this limiter too, for the reason it reaches the others:
  // a login that worked is not a guess.
  it("gives the attempt back when the login succeeds", async () => {
    const refused = await request(server)
      .post("/login")
      .set("x-test-ip", "198.51.100.7")
      .send({ email: "someone@example.com", password: "wrong" });

    expect(refused.status).toBe(401);

    const [counted] = await waitForPairRows(1);

    expect(counted!.hits).toBe(1);

    vi.mocked(User.findByEmail).mockResolvedValue({
      id: 1,
      email: "someone@example.com",
      password: "hashed",
      role: "USER",
    } as any);
    vi.mocked(password.verifyPassword).mockResolvedValue(true);

    const response = await request(server)
      .post("/login")
      .set("x-test-ip", "198.51.100.7")
      .send({ email: "someone@example.com", password: "right" });

    expect(response.status).toBe(302);

    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await pairRows();

      if (rows[0]?.hits === 1) break;

      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const rows = await pairRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.hits).toBe(1);
  });
});

/** sha256 of the address the way the route normalises it — its account key. */
function accountKeyOf(email: string): string {
  return crypto
    .createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex");
}

/** The device cookie a response set, as "name=value", if it set one. */
function deviceCookieFrom(response: {
  headers: Record<string, unknown>;
}): string | undefined {
  return ((response.headers["set-cookie"] as string[] | undefined) ?? [])
    .find((cookie) => cookie.startsWith(`${DEVICE_COOKIE}=`))
    ?.split(";")[0];
}

/**
 * The OWASP device cookie: handed out by a successful login, and presented
 * again on a later attempt as proof that this browser has signed in to the
 * account before.
 */
describe("the device cookie", () => {
  const admin = {
    id: 1,
    email: "admin@example.com",
    password: "stored-hash",
    role: "ADMIN",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    await db.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login%'`);
    vi.mocked(User.findByEmail).mockResolvedValue(admin as any);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login%'`);
  });

  /**
   * Each attribute for a reason — see issueDeviceCookie: scoped to /login so
   * no other request carries a long-lived identifier, HttpOnly because no
   * script has any use for it, Strict because only the form's own same-site
   * POST needs it, and a year because it has to still be there on the day the
   * account is under attack.
   */
  it("is issued by a successful login, scoped to the login and kept for a year", async () => {
    vi.mocked(password.verifyPassword).mockResolvedValue(true);

    const response = await request(server)
      .post("/login")
      .send({ email: "admin@example.com", password: "right" });

    expect(response.status).toBe(302);

    const header = (
      (response.headers["set-cookie"] as unknown as string[] | undefined) ?? []
    ).find((cookie) => cookie.startsWith(`${DEVICE_COOKIE}=`));

    expect(header).toBeDefined();
    expect(header).toMatch(
      new RegExp(`^${DEVICE_COOKIE}=[0-9a-f]{32}\\.\\d+\\.[0-9a-f]{64};`),
    );
    expect(header).toMatch(/Path=\/login(;|$)/);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Strict/i);
    expect(header).toMatch(/Max-Age=31536000/);
    // It names no one: the account is bound through the MAC, not written in.
    expect(header).not.toContain(accountKeyOf("admin@example.com"));
    expect(header).not.toContain("admin");
  });

  it("is not issued by a refused login", async () => {
    vi.mocked(password.verifyPassword).mockResolvedValue(false);

    const response = await request(server)
      .post("/login")
      .send({ email: "admin@example.com", password: "wrong" });

    expect(response.status).toBe(401);
    expect(deviceCookieFrom(response)).toBeUndefined();
  });

  // A fresh nonce each time, so the term runs from the last login and a
  // cookie that has been failing elsewhere stops sharing a budget with this.
  it("is a new one on every login", async () => {
    vi.mocked(password.verifyPassword).mockResolvedValue(true);

    const first = await request(server)
      .post("/login")
      .send({ email: "admin@example.com", password: "right" });
    const second = await request(server)
      .post("/login")
      .send({ email: "admin@example.com", password: "right" });

    expect(deviceCookieFrom(first)).toBeDefined();
    expect(deviceCookieFrom(second)).toBeDefined();
    expect(deviceCookieFrom(first)).not.toBe(deviceCookieFrom(second));
  });

  // It says this browser has signed in before, which a logout does not make
  // any less true — and it is what the owner needs the next time they sign in.
  it("is left alone by a logout", async () => {
    const response = await request(server).post("/logout");

    expect(response.status).toBe(302);
    expect(
      (
        (response.headers["set-cookie"] as unknown as string[] | undefined) ?? []
      ).some((cookie) => cookie.startsWith(`${DEVICE_COOKIE}=`)),
    ).toBe(false);
  });
});

/**
 * The lockout the device cookie exists to prevent, and the limits it must not
 * lift.
 *
 * The account-wide backstop closes an account for the rest of the hour at two
 * hundred failures, and each source contributes ten before the per-address
 * limiter stops it — so twenty sources close it at once. A reproduction with
 * twenty-one spoofed addresses took under six seconds, after which the real
 * admin, from a fresh address and with the right password, was refused for
 * the hour.
 */
describe("the device cookie and the account-wide backstop", () => {
  const ADMIN = "admin@example.com";
  const RIGHT = "the right password";

  const admin = { id: 1, email: ADMIN, password: "stored-hash", role: "ADMIN" };
  const other = {
    id: 2,
    email: "other@example.com",
    password: "other-hash",
    role: "USER",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    await db.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login%'`);

    vi.mocked(User.findByEmail).mockImplementation(async (email: string) =>
      email.trim().toLowerCase() === other.email ? (other as any) : (admin as any),
    );
    vi.mocked(password.verifyPassword).mockImplementation(
      async (given: string) => given === RIGHT,
    );
  });

  afterAll(async () => {
    await db.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login%'`);
  });

  function attempt(
    ip: string,
    passwordGiven: string,
    options: { email?: string; device?: string } = {},
  ) {
    const pending = request(server)
      .post("/login")
      .set("x-test-ip", ip)
      .send({ email: options.email ?? ADMIN, password: passwordGiven });

    return options.device ? pending.set("Cookie", options.device) : pending;
  }

  /** Signs in from `ip` and returns the device cookie that login handed out. */
  async function deviceFrom(ip: string, email = ADMIN): Promise<string> {
    const login = await attempt(ip, RIGHT, { email });

    expect(login.status).toBe(302);

    const device = deviceCookieFrom(login);

    expect(device).toBeDefined();

    return device!;
  }

  /**
   * The backstop filled to its ceiling, without two hundred requests.
   *
   * An upsert, because the login that handed out the device cookie was
   * charged to the backstop too — it had no cookie yet — and given back,
   * which leaves its row behind at zero.
   */
  async function lockAccount(email = ADMIN): Promise<void> {
    await db.query(
      `INSERT INTO "rate_limits" ("key", "hits", "expiresAt")
       VALUES ($1, 200, NOW() + INTERVAL '1 hour')
       ON CONFLICT ("key") DO UPDATE
         SET "hits" = 200, "expiresAt" = NOW() + INTERVAL '1 hour'`,
      [`login-account:${accountKeyOf(email)}`],
    );
  }

  /**
   * The whole attack, as it was reproduced: twenty sources, ten guesses
   * each. Then the owner, from an address none of it came from and with the
   * right password — refused without the cookie, let in with it.
   */
  it("lets the owner in from a browser that has signed in before, while the account is locked", async () => {
    const device = await deviceFrom("192.0.2.10");

    for (let source = 1; source <= 20; source++) {
      for (let guess = 0; guess < 10; guess++) {
        const response = await attempt(`198.51.100.${source}`, `guess ${guess}`);

        expect(response.status).toBe(401);
      }
    }

    const { rows } = await db.query(
      `SELECT "hits" FROM "rate_limits" WHERE "key" = $1`,
      [`login-account:${accountKeyOf(ADMIN)}`],
    );

    // Twenty sources are enough to reach the ceiling: the arithmetic the
    // comment on accountLimiter now states, where it used to say two hundred.
    expect(rows[0].hits).toBe(200);

    const stranger = await attempt("203.0.113.1", RIGHT);

    expect(stranger.status).toBe(429);
    expect(stranger.text).toContain("for this account");

    const owner = await attempt("203.0.113.2", RIGHT, { device });

    expect(owner.status).toBe(302);
  });

  // Bound to the account through its MAC: proof of signing in to one account
  // says nothing about an attempt at another.
  it("does not lift the backstop for a cookie issued to another account", async () => {
    const device = await deviceFrom("192.0.2.20", other.email);

    await lockAccount();

    const response = await attempt("203.0.113.3", RIGHT, { device });

    expect(response.status).toBe(429);
  });

  it("does not lift it for a cookie whose signature has been altered", async () => {
    const device = await deviceFrom("192.0.2.30");
    const last = device.at(-1) === "0" ? "1" : "0";

    await lockAccount();

    const response = await attempt("203.0.113.4", RIGHT, {
      device: `${device.slice(0, -1)}${last}`,
    });

    expect(response.status).toBe(429);
  });

  // "Skips the backstop only": the per-address brake still counts a
  // recognised device like any other caller.
  it("still holds a recognised device to the per-address limit", async () => {
    const device = await deviceFrom("192.0.2.40");

    for (let guess = 0; guess < 10; guess++) {
      expect((await attempt("192.0.2.41", `guess ${guess}`, { device })).status).toBe(
        401,
      );
    }

    const response = await attempt("192.0.2.41", RIGHT, { device });

    expect(response.status).toBe(429);
    // The per-address limiter's message, not the account's: it is the first
    // brake, and it is the one that stopped this.
    expect(response.text).toBe("Too many login attempts, please try again later.");
  });

  /**
   * A device cookie is a bearer token, so the skip on its own would make a
   * stolen one a way around the backstop from any number of addresses. Its
   * failures are counted together wherever they come from, and ten close it.
   */
  it("counts a device's failures together, and closes that device at ten", async () => {
    const device = await deviceFrom("192.0.2.50");

    for (let guess = 0; guess < 10; guess++) {
      const response = await attempt(`198.51.100.${100 + guess}`, `guess ${guess}`, {
        device,
      });

      expect(response.status).toBe(401);
    }

    const response = await attempt("198.51.100.200", RIGHT, { device });

    expect(response.status).toBe(429);

    // Keyed on a hash of the nonce, not the nonce: the table holds no part of
    // a value any browser presents.
    const nonce = device.split("=")[1]!.split(".")[0]!;
    const { rows } = await db.query(
      `SELECT "key", "hits" FROM "rate_limits" WHERE "key" LIKE 'login-device:%'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].key).toMatch(/^login-device:[0-9a-f]{64}$/);
    expect(rows[0].key).not.toContain(nonce);

    // And the backstop was never charged for any of it. The one hit it did
    // take was the login that issued the cookie, which had none yet — and
    // that login succeeded, so it was given back.
    const { rows: account } = await db.query(
      `SELECT COALESCE(SUM("hits"), 0)::int AS "hits" FROM "rate_limits"
        WHERE "key" LIKE 'login-account:%'`,
    );

    expect(account[0].hits).toBe(0);
  });

  /**
   * The hashing queue: a flood that fills it is the moment the owner most
   * needs to get in, and a 503 is charged to the device's budget like any
   * other refusal — so the owner's device asks for priority and waits for the
   * next free place instead of being turned away. Nobody else does.
   */
  it("asks the hashing queue for priority for a recognised device, and only then", async () => {
    const device = await deviceFrom("192.0.2.70");

    vi.mocked(password.verifyPassword).mockClear();

    await attempt("192.0.2.71", RIGHT, { device });

    expect(password.verifyPassword).toHaveBeenLastCalledWith(RIGHT, "stored-hash", {
      priority: true,
    });

    await attempt("192.0.2.72", RIGHT);

    expect(password.verifyPassword).toHaveBeenLastCalledWith(RIGHT, "stored-hash", {
      priority: false,
    });

    // A cookie for another account is no reason to jump the queue here.
    const elsewhere = await deviceFrom("192.0.2.73", other.email);

    await attempt("192.0.2.74", RIGHT, { device: elsewhere });

    expect(password.verifyPassword).toHaveBeenLastCalledWith(RIGHT, "stored-hash", {
      priority: false,
    });
  });

  // Only that device. Everyone else is judged by the backstop as before.
  it("leaves a closed device's account open to an attempt without it", async () => {
    const device = await deviceFrom("192.0.2.60");

    for (let guess = 0; guess < 10; guess++) {
      await attempt(`198.51.100.${150 + guess}`, `guess ${guess}`, { device });
    }

    expect((await attempt("198.51.100.199", RIGHT, { device })).status).toBe(429);
    expect((await attempt("198.51.100.198", RIGHT)).status).toBe(302);
  });
});

/**
 * IPv6 addresses are grouped by /48 for the login limiters rather than the
 * library's /56, which left 256 separate budgets inside the /48 a single
 * hosting customer is routinely handed.
 */
describe("POST /login IPv6 grouping", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await db.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login%'`);
    vi.mocked(User.findByEmail).mockResolvedValue(null);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login%'`);
  });

  it("counts two addresses in one /48 against one per-address budget", async () => {
    // Different /56s, the same /48.
    for (const ip of ["2001:db8:1:100::1", "2001:db8:1:ff00::1"]) {
      const response = await request(server)
        .post("/login")
        .set("x-test-ip", ip)
        .send({ email: "someone@example.com", password: "x" });

      expect(response.status).toBe(401);
    }

    const { rows } = await db.query(
      `SELECT "key", "hits" FROM "rate_limits" WHERE "key" LIKE 'login:%'`,
    );

    expect(rows).toEqual([{ key: "login:2001:db8:1::/48", hits: 2 }]);

    // The pair is grouped the same way, so one caller is one budget there too.
    const { rows: pairs } = await db.query(
      `SELECT "hits" FROM "rate_limits" WHERE "key" LIKE 'login-account-ip:%'`,
    );

    expect(pairs).toEqual([{ hits: 2 }]);
  });
});
