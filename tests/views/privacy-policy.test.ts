import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../../app.ts";
import pool from "../../db.ts";
import { PostgresRateLimitStore } from "../../utils/rate-limit-store.ts";
import { CSRF_COOKIE } from "../../middlewares/csrf.ts";
import { VOTER_COOKIE } from "../../middlewares/voter-id.ts";
import { SESSION_COOKIE } from "../../utils/session-cookie.ts";

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
 * The name as a reader sees it in their browser, minus the "__Host-" the CSRF
 * cookie carries in production only. The prefix is a browser instruction
 * rather than part of the name anyone needs explained, and the policy has to
 * read the same in both environments — see CSRF_COOKIE in middlewares/csrf.ts.
 */
function readableName(cookie: string): string {
  return cookie.replace(/^__Host-/, "");
}

describe("privacy policy", () => {
  describe("names every cookie the app sets", () => {
    it.each([
      ["the CSRF secret", CSRF_COOKIE],
      ["the anonymous voter id", VOTER_COOKIE],
      ["an administrator's session", SESSION_COOKIE],
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
  // cookie's maxAge in app.ts.
  it.each([
    ["the voter id's year", "one year"],
    ["the CSRF secret's month", "one month"],
    ["the session's 30 days", "30 days"],
    ["the rating IP window", "90 days"],
  ])("states %s", (_label, phrase) => {
    expect(policy).toContain(phrase);
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

    it("states the window the code actually enforces", () => {
      // The longest window is 15 minutes (app.ts, auth.ts, games.ts) and
      // PRUNE_INTERVAL_MS in rate-limit-store.ts sweeps every 10, so 25
      // minutes is the worst case the policy is entitled to claim.
      expect(policy).toContain("25 minutes");
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
});
