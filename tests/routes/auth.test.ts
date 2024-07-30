import { beforeEach, describe, expect, it, vi, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import * as password from "../../utils/password";
import authRouter from "../../routes/auth";
import User from "../../models/user";
import db from "../../db";

vi.mock("../../utils/password");
vi.mock("../../models/user", () => ({
  default: {
    findByEmail: vi.fn(),
    create: vi.fn(),
  },
}));

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
            save: vi.fn(),
            touch: vi.fn(),
          } as any;
          if (callback) callback();
        }),
        reload: vi.fn(),
        save: vi.fn(),
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
        save: vi.fn(),
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
      save: vi.fn(),
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
  beforeEach(() => {
    vi.clearAllMocks();
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
      expect(password.verifyPassword).toHaveBeenCalledWith(
        "password123",
        "hashedpassword",
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
      );
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

  it("gives the attempt back when the login succeeds", async () => {
    vi.mocked(User.findByEmail).mockResolvedValue(mockUser as any);
    vi.mocked(password.verifyPassword).mockResolvedValue(true);

    const response = await request(server).post("/login").send(credentials);

    expect(response.status).toBe(302);
    expect(await waitForHits(0)).toBe(0);
  });

  // The other half, and the half that must not regress: this option keys off
  // the response status, so it only counts failures because the route answers
  // 401 for one. On the 200 this route used to send for a rejected login it
  // would have refunded the guess and counted nothing at all.
  it("keeps counting the ones that fail", async () => {
    vi.mocked(User.findByEmail).mockResolvedValue(null);

    const response = await request(server).post("/login").send(credentials);

    expect(response.status).toBe(401);
    expect(await waitForHits(1)).toBe(1);

    // Held, not merely slow to be given back: the refund would have landed
    // well inside this.
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(await loginHits()).toBe(1);
  });
});

/**
 * The second brake on /login, keyed on the account rather than the address.
 * Per-IP alone handed an attacker rotating addresses ten fresh guesses per
 * address at one account; this counts the failures against the account from
 * wherever they come. The key is a hash — the rate-limit table is not a
 * list of the addresses people have tried to sign in as.
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

  beforeEach(async () => {
    await db.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login-account:%'`);
    vi.mocked(User.findByEmail).mockResolvedValue(null);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM "rate_limits" WHERE "key" LIKE 'login-account:%'`);
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

  it("does not count a request that names no account", async () => {
    const response = await request(server).post("/login").send({ password: "x" });

    expect(response.status).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await accountRows()).toEqual([]);
  });

  it("gives the attempt back when the login succeeds", async () => {
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
      if (rows.length === 0 || rows[0]!.hits === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const rows = await accountRows();
    expect(rows.length === 0 || rows[0]!.hits === 0).toBe(true);
  });
});
