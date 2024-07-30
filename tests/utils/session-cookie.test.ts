import { afterEach, describe, expect, it, vi } from "vitest";
import express, { type Request } from "express";
import session, { type SessionData } from "express-session";
import request from "supertest";
import { flash } from "../../middlewares/flash.ts";
import {
  SESSION_COOKIE,
  endSession,
  preventStaleSessionCookie,
} from "../../utils/session-cookie.ts";

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

describe("issuing the session cookie", () => {
  class TrackedMemoryStore extends session.MemoryStore {
    #restored = new WeakSet<object>();
    override createSession(req: Request, data: SessionData) {
      const loaded = super.createSession(req, data);
      this.#restored.add(loaded);
      return loaded;
    }
    isPersisted(data: SessionData): boolean {
      return this.#restored.has(data);
    }
  }

  function makeApp() {
    const app = express();
    const store = new TrackedMemoryStore();
    app.use(session({
      store,
      secret: "a session-cookie test secret",
      name: SESSION_COOKIE,
      resave: false,
      saveUninitialized: false,
      rolling: false,
      cookie: { maxAge: 365 * 24 * 60 * 60 * 1000 },
    }));
    app.use(preventStaleSessionCookie(store));
    app.use(flash);
    app.get("/flash", (req, res) => {
      req.flash("error", "Please try again.");
      res.cookie("other", "preserved");
      req.session.save((error) => {
        if (error) throw error;
        res.redirect("/read");
      });
    });
    app.get("/read", (req, res) => res.json(req.flash()));
    app.get("/clear", (_req, res) => {
      res.clearCookie(SESSION_COOKIE);
      res.send("Done.");
    });
    app.get("/login", (req, res, next) => {
      req.session.regenerate((error) => {
        if (error) return next(error);
        req.flash("success", "Signed in.");
        res.send("Signed in.");
      });
    });
    app.get("/logout", async (req, res) => {
      await endSession(req);
      res.send("Signed out.");
    });
    return app;
  }

  function issuedCookies(response: request.Response): string[] {
    return response.headers["set-cookie"] as unknown as string[] ?? [];
  }

  function sidCookie(response: request.Response): string | undefined {
    return issuedCookies(response)
      .find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))?.split(";")[0];
  }

  it.each([undefined, "connect.sid=s%3Amissing.invalid"])(
    "issues a new anonymous flash cookie with incoming cookie %s",
    async (incoming) => {
      const app = makeApp();
      const post = request(app).get("/flash");
      if (incoming) post.set("Cookie", incoming);
      const flashed = await post;
      const cookie = sidCookie(flashed);
      expect(cookie).toBeDefined();

      const page = await request(app).get("/read").set("Cookie", cookie!);
      expect(page.body).toEqual({ error: ["Please try again."] });
      expect(sidCookie(page)).toBeUndefined();
    },
  );

  it.each([false, true])(
    "keeps other cookies when a restored session changes (quoted: %s)",
    async (quoted) => {
      const app = makeApp();
      const cookie = sidCookie(await request(app).get("/flash"))!;
      const incoming = quoted
        ? cookie.replace(/^([^=]+)=(.*)$/, '$1="$2"')
        : cookie;
      const changed = await request(app).get("/flash").set("Cookie", incoming);
      expect(sidCookie(changed)).toBeUndefined();
      expect(issuedCookies(changed)).toEqual(["other=preserved; Path=/"]);
    },
  );

  it("allows regenerated login ids and leaves a logged-out id inert", async () => {
    const app = makeApp();
    const original = sidCookie(await request(app).get("/flash"))!;
    const login = await request(app).get("/login").set("Cookie", original);
    const current = sidCookie(login)!;
    expect(current).toBeDefined();
    expect(current).not.toBe(original);

    const logout = await request(app).get("/logout").set("Cookie", current);
    expect(sidCookie(logout)).toBeUndefined();
    expect((await request(app).get("/read").set("Cookie", current)).body).toEqual({});
  });

  it("blocks a cookie deletion from a response of an existing id", async () => {
    const app = makeApp();
    const cookie = sidCookie(await request(app).get("/flash"))!;
    const response = await request(app).get("/clear").set("Cookie", cookie);
    expect(sidCookie(response)).toBeUndefined();
  });

  it("issues a fresh flash cookie when a valid incoming id has no row", async () => {
    const app = makeApp();
    const original = sidCookie(await request(app).get("/flash"))!;
    await request(app).get("/logout").set("Cookie", original);
    const flashed = await request(app).get("/flash").set("Cookie", original);
    const current = sidCookie(flashed)!;
    expect(current).toBeDefined();
    expect(current).not.toBe(original);
    expect((await request(app).get("/read").set("Cookie", current)).body)
      .toEqual({ error: ["Please try again."] });
  });
});
