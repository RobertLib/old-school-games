import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import app from "../../app.ts";
import pool from "../../db.ts";
import { PostgresRateLimitStore } from "../../utils/rate-limit-store.ts";
import { CSRF_COOKIE } from "../../middlewares/csrf.ts";
import { VOTER_COOKIE } from "../../middlewares/voter-id.ts";
import { SESSION_COOKIE } from "../../utils/session-cookie.ts";
import { DEVICE_COOKIE } from "../../utils/device-cookie.ts";
import { PER_GAME_WINDOW_MS } from "../../routes/games.ts";
import {
  SOURCE_RETENTION_DAYS,
  commentSource,
} from "../../models/comment.ts";
import logger from "../../utils/logger.ts";
import User from "../../models/user.ts";

/**
 * Keeps the privacy policy honest about the cookies this app sets.
 *
 * It had drifted twice over, and in the direction that matters — the policy
 * claimed less than the code did. It said osg_vid was set "when you rate a
 * game", where the voterId middleware is mounted globally and sets it on the
 * first request to any page; and it never mentioned osg_csrf or connect.sid
 * at all, though the first is set on every visit.
 *
 * Nothing about prose keeps it in step with code, which is why this exists.
 * The names are imported from the constants the middleware actually uses, so
 * renaming a cookie fails here rather than quietly making the policy wrong.
 */
const POLICY_PATH = path.join(process.cwd(), "views", "privacy-policy.ejs");

const policy = fs.readFileSync(POLICY_PATH, "utf-8");

/**
 * The same policy as a reader gets it: tags out, and every run of whitespace
 * one space — so a phrase the template wraps across two lines is still found.
 * The raw source is what the older checks here were written against, and it
 * let a claim pass or fail on where a line happened to break.
 */
const policyText = policy.replace(/<[^>]*>/g, "").replace(/\s+/g, " ");

/**
 * The policy's text between two headings, read as policyText is — so a claim
 * can be looked for in the section that has to make it rather than anywhere
 * on the page.
 */
function section(from: string, to: string): string {
  const start = policyText.indexOf(from);
  const end = policyText.indexOf(to, start);

  expect(start, `no "${from}" in the policy`).toBeGreaterThan(-1);
  expect(end, `no "${to}" after "${from}"`).toBeGreaterThan(start);

  return policyText.slice(start, end);
}

/**
 * The name as a reader sees it in their browser, minus the "__Host-" the CSRF
 * cookie carries in production only — or the "__Secure-" the device cookie
 * does. The prefix is a browser instruction rather than part of the name
 * anyone needs explained, and the policy has to read the same in both
 * environments — see CSRF_COOKIE in middlewares/csrf.ts and DEVICE_COOKIE in
 * utils/device-cookie.ts.
 */
function readableName(cookie: string): string {
  return cookie.replace(/^__(?:Host|Secure)-/, "");
}

describe("privacy policy", () => {
  describe("names every cookie the app sets", () => {
    it.each([
      ["the CSRF secret", CSRF_COOKIE],
      ["the anonymous voter id", VOTER_COOKIE],
      ["an administrator's session", SESSION_COOKIE],
      ["an administrator's device", DEVICE_COOKIE],
    ])("names %s", (_label, cookie) => {
      expect(policy).toContain(readableName(cookie));
    });
  });

  /**
   * The claim that was wrong rather than merely missing. Asserted against the
   * running app so it cannot be satisfied by editing the copy alone: if the
   * cookie really did arrive only on a vote, this fails and the old wording
   * was right after all.
   */
  it("is right that the voter id arrives before anyone votes", async () => {
    const response = await request(app).get("/");

    const cookies = (
      (response.headers["set-cookie"] as unknown as string[]) ?? []
    ).join(";");

    expect(cookies).toContain(`${VOTER_COOKIE}=`);
    expect(cookies).toContain(`${readableName(CSRF_COOKIE)}=`);

    // And the one that genuinely is not set for an ordinary visitor, which is
    // what the policy says about it.
    expect(cookies).not.toContain(`${SESSION_COOKIE}=`);
  });

  // The retention periods in the policy are the ones the code enforces:
  // ONE_YEAR_MS in voter-id.ts, ONE_MONTH_MS in csrf.ts, and the session
  // cookie's maxAge in app.ts — checked against a real login below.
  it.each([
    ["the voter id's year", "one year"],
    ["the CSRF secret's month", "one month"],
    ["the session's seven days", "seven days without use"],
    ["the rating IP window", "90 days"],
  ])("states %s", (_label, phrase) => {
    expect(policyText).toContain(phrase);
  });

  /**
   * The session cookie's lifetime, read off a real login rather than off the
   * prose.
   *
   * The policy said thirty days, which is what the session lasted when it
   * also carried every visitor's CSRF token. app.ts has held it to seven days
   * of inactivity since — rolling, with a maxAge of a week — and nothing
   * noticed, because the "30 days" this file looked for was matched by
   * sentences about other things entirely: the GDPR reply deadline, and now a
   * comment's source.
   */
  it("is right about how long an administrator's session lasts", async () => {
    const email = "policy-session@example.com";
    const password = "correct horse battery staple";

    await pool.query('DELETE FROM "users" WHERE "email" = $1', [email]);
    await User.create({ email, password });

    try {
      const agent = request.agent(app);
      const page = await agent.get("/login");
      const token = /<meta name="csrf-token" content="([^"]+)"/.exec(
        page.text,
      )![1];

      const login = await agent
        .post("/login")
        .type("form")
        .send({ _csrf: token, email, password })
        .redirects(0);

      expect(login.status).toBe(302);

      const cookie = (
        (login.headers["set-cookie"] as unknown as string[]) ?? []
      ).find((value) => value.startsWith(`${SESSION_COOKIE}=`));
      const expires = /Expires=([^;]+)/i.exec(cookie ?? "")?.[1];
      const days =
        (new Date(expires!).getTime() - Date.now()) / (24 * 60 * 60 * 1000);

      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThanOrEqual(7);
    } finally {
      await pool.query('DELETE FROM "users" WHERE "email" = $1', [email]);
    }
  });

  /**
   * The rate limiters store an IP address in the database, and the policy did
   * not mention it.
   *
   * It was the one thing this app holds that went unlisted — the section on
   * ratings already declared its IP address and its 90 days, and every cookie
   * is named above, so the omission was not a policy that claimed less on
   * purpose but one that had simply not caught up with
   * utils/rate-limit-store.ts.
   *
   * Asserted against the store's own key rather than against prose alone: the
   * claim in the policy is specifically that the address is what the counter
   * is keyed by, so a limiter that started keying on something else — or
   * stopped storing the address at all — should fail this and have the
   * paragraph rewritten rather than leave it quietly wrong in either
   * direction.
   */
  describe("declares the IP address the rate limiters store", () => {
    it("says an IP address is stored for rate limiting", () => {
      expect(policy).toContain("IP address");
      expect(policy).toContain("rate-limit");
    });

    /**
     * Each window is the limiter's own plus PRUNE_INTERVAL_MS in
     * rate-limit-store.ts, which sweeps expired entries every 10 minutes.
     *
     * The comment here used to say the longest window was 15 minutes, and the
     * policy said the address behind any counter was gone within 25. Neither
     * was true by then: the login limiter that counts the account and the
     * address together (routes/auth.ts, "login-account-ip") runs for an hour,
     * and the per-game limits on starting and rating a game
     * (PER_GAME_WINDOW_MS in routes/games.ts) for a day. So each is stated.
     */
    it.each([
      // The login limiter in routes/auth.ts and the rating limiter in
      // routes/games.ts: 15 minutes, the longest of the short windows (the
      // comment limiters in routes/comments.ts are 5 and 1), + 10 for the
      // sweep. The site-wide one in app.ts is also 15, but in memory, where
      // nothing outlives its window.
      ["the short counters", "25 minutes"],
      // "login-account-ip" in routes/auth.ts: an hour + 10.
      ["the login counter per account and address", "70 minutes"],
      // PER_GAME_WINDOW_MS + 10 minutes.
      ["the per-game counters", "24 hours and 10 minutes"],
    ])("states the window of %s", (_label, phrase) => {
      expect(policyText).toContain(phrase);
    });

    // So a change to the per-game window fails here and has the sentence
    // rewritten, rather than leaving it quietly wrong.
    it("is right about the per-game window", () => {
      expect(PER_GAME_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    });

    // The two places that summarise the counters must not undercut the
    // section that describes them, which is how "minutes for the counter"
    // outlived the per-game counters.
    it("summarises the counters without claiming they last only minutes", () => {
      const retention = section("5. Data Retention", "6. Your Rights");

      expect(retention).toContain("24 hours and 10 minutes");
      expect(retention).toContain("70 minutes");
      expect(section("3. Legal Basis", "4. Data Sharing")).not.toContain(
        "minutes for the counter",
      );
    });

    it("is right that the counter is keyed by the address", async () => {
      const store = new PostgresRateLimitStore("policy-test");

      await store.increment("203.0.113.7");

      const { rows } = await pool.query(
        `SELECT "key" FROM "rate_limits" WHERE "key" LIKE $1`,
        ["policy-test:%"],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].key).toBe("policy-test:203.0.113.7");

      await store.resetAll();
    });
  });

  /**
   * The source recorded with a comment.
   *
   * Comments recorded nothing about where they came from, and the policy said
   * so: "we have no way to link them to you after submission". A keyed hash of
   * the address is stored with each one now, so moderation can remove a flood
   * in one step (see commentSource in models/comment.ts) — which made that
   * sentence false, and is personal data the policy has to name, with its
   * purpose and how long it is kept.
   *
   * Checked against the running app, like the voter id above: the claim is
   * that the address itself is never stored, so a comment is posted the way a
   * visitor posts one and the row is read back.
   */
  describe("declares the source recorded with a comment", () => {
    const comments = () => section("a) Comments", "b) Usage data");

    it("says a keyed hash of the address is stored, not the address", () => {
      expect(comments()).toContain("keyed hash of the IP address");
      expect(comments()).toContain("never the address itself");
    });

    it("states the retention the code enforces, where it is described and where it is summarised", () => {
      expect(comments()).toContain(
        `deleted after ${SOURCE_RETENTION_DAYS} days`,
      );
      expect(section("5. Data Retention", "6. Your Rights")).toContain(
        `is deleted after ${SOURCE_RETENTION_DAYS} days`,
      );
      expect(section("3. Legal Basis", "4. Data Sharing")).toContain(
        `${SOURCE_RETENTION_DAYS} days for a comment's source`,
      );
    });

    // The sentence that stopped being true.
    it("no longer says comments cannot be linked to anything", () => {
      expect(policy).not.toContain("we have no way to link them to you");
    });

    it("is right that what a post stores is a hash, not the address", async () => {
      const { rows: games } = await pool.query(
        `INSERT INTO "games" ("title", "slug", "genre")
         VALUES ('Policy Test', 'policy-test-game', 'ACTION') RETURNING "id"`,
      );
      const gameId = games[0].id as number;

      try {
        const agent = request.agent(app);
        const page = await agent.get("/privacy-policy");
        const token = /<meta name="csrf-token" content="([^"]+)"/.exec(
          page.text,
        )![1];

        const posted = await agent
          .post("/comments")
          .type("form")
          .send({ _csrf: token, gameId: String(gameId), content: "Hello" });

        expect(posted.status).toBe(303);

        const { rows } = await pool.query(
          `SELECT "sourceHash", row_to_json(c)::text AS "row"
           FROM "comments" c WHERE "gameId" = $1`,
          [gameId],
        );

        expect(rows).toHaveLength(1);
        // The loopback address the test client connects from, in whichever
        // family it used — and neither of them anywhere in the row.
        expect([commentSource("127.0.0.1"), commentSource("::1")]).toContain(
          rows[0].sourceHash,
        );
        expect(rows[0].row).not.toContain("127.0.0.1");
        expect(rows[0].row).not.toContain("::1");
      } finally {
        await pool.query('DELETE FROM "games" WHERE "id" = $1', [gameId]);
      }
    });

    /**
     * The 30 days are only true if the sweep that clears the hash runs, and
     * that sweep lives in index.ts — the one file this suite cannot import,
     * because it listens on a port. So the wiring is read off the source:
     * Comment.pruneSources is tested in tests/models/comment-source.test.ts,
     * and this is what makes it run daily and on every boot.
     */
    it("is right that something clears the hash on schedule", () => {
      const index = fs.readFileSync(
        path.join(process.cwd(), "index.ts"),
        "utf-8",
      );
      const sweep = /async function pruneExpiredData\(\)[\s\S]*?\n}\n/.exec(
        index,
      );

      expect(sweep, "no pruneExpiredData in index.ts").not.toBeNull();
      expect(sweep![0]).toContain("Comment.pruneSources()");
      expect(index).toMatch(/setInterval\(\s*\(\) => void pruneExpiredData\(\)/);
      expect(index).toMatch(/^void pruneExpiredData\(\);$/m);
    });
  });

  /**
   * The request log.
   *
   * The policy said the line written per request included, for a search, the
   * words searched for. It never did: the access log in app.ts records
   * req.path, which has no query string, on purpose — its comment calls the
   * search box the most personal thing the site receives — and the one line
   * that used to carry the whole URL, the warning for a refused request, was
   * brought into line with it. Over-stating what is logged is still a false
   * statement in a GDPR notice.
   *
   * Checked against the running app: every line it logs for a search, and
   * for a refused request carrying the same query, is collected and searched
   * for the term.
   */
  describe("describes the request log as it is", () => {
    const TERM = "zebralantern7731";

    it("says the query string is left out", () => {
      const logs = section("f) Abuse prevention", "3. Legal Basis");

      expect(logs).toContain("The query string is left out");
      expect(logs).not.toContain("includes the words you searched for");
    });

    it("is right that no line it writes carries what was searched for", async () => {
      const lines: string[] = [];
      const spies = (["info", "warn", "error"] as const).map((level) =>
        vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
          lines.push(JSON.stringify(args));
        }),
      );

      try {
        await request(app).get(`/?search=${TERM}`);

        // A body the parser refuses is a 400 with a log line of its own —
        // the one that used to carry the whole URL.
        const refused = await request(app)
          .post(`/comments?search=${TERM}`)
          .set("Content-Type", "application/json")
          .send("{not json");

        expect(refused.status).toBe(400);
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }

      // Both requests were logged...
      expect(lines.filter((line) => line.startsWith('["request"'))).toHaveLength(
        2,
      );
      expect(lines.some((line) => line.startsWith('["client error"'))).toBe(
        true,
      );
      // ...and not one line says what was searched for.
      expect(lines.filter((line) => line.includes(TERM))).toEqual([]);
    });
  });
});
