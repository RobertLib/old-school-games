import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import app from "../../app.ts";
import logger from "../../utils/logger.ts";
import { CSP_REPORT_LIMIT } from "../../routes/csp-report.ts";
import { MAX_LINES_PER_REQUEST } from "../../utils/csp-report.ts";

/**
 * POST /csp-report, through the assembled app — because most of what matters
 * about it is where it is mounted.
 *
 * A browser sends a report with no CSRF token, often with no cookie, and on
 * its own schedule, so an endpoint mounted where the rest of the site's POSTs
 * are would refuse every one with the CSRF 403, hand each one a session
 * cookie, and count each one against the visitor's budget for the whole
 * site. What it keeps from a report is argued in utils/csp-report.ts and
 * tested in tests/utils/csp-report.test.ts; here it is the request's side.
 */

// One listening server for the file, for the reason tests/app.test.ts gives.
const server = app.listen(0);

afterAll(() => {
  server.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A report-uri body as a browser without the Reporting API sends it. */
const CSP_REPORT = {
  "csp-report": {
    "document-uri": "https://oldschoolgames.eu/search?search=private+words",
    referrer: "https://www.example.org/where-they-came-from",
    "violated-directive": "img-src",
    "effective-directive": "img-src",
    "original-policy": "default-src 'self'",
    disposition: "enforce",
    "blocked-uri": "https://images.example.net/pic.png?user=42",
    "status-code": 200,
    "script-sample": "",
  },
};

/** A Reporting API batch, the shape report-to delivers. */
function batch(...blocked: string[]) {
  return blocked.map((blockedURL) => ({
    type: "csp-violation",
    age: 5,
    url: "https://oldschoolgames.eu/doom?search=x",
    user_agent: "Mozilla/5.0 Chrome/140.0",
    body: {
      documentURL: "https://oldschoolgames.eu/doom?search=x",
      blockedURL,
      effectiveDirective: "connect-src",
      originalPolicy: "default-src 'self'",
      disposition: "enforce",
      statusCode: 200,
    },
  }));
}

function post(type: string, body: string) {
  return request(server)
    .post("/csp-report")
    .set("Content-Type", type)
    .send(body);
}

/** The "csp violation" lines logged while running `send`. */
async function violationsLogged(
  send: () => Promise<unknown>,
): Promise<Record<string, unknown>[]> {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

  await send();

  return warn.mock.calls
    .filter(([message]) => message === "csp violation")
    .map(([, fields]) => fields as Record<string, unknown>);
}

describe("POST /csp-report", () => {
  it("takes a report-uri report and answers 204 with nothing", async () => {
    const response = await post(
      "application/csp-report",
      JSON.stringify(CSP_REPORT),
    );

    expect(response.status).toBe(204);
    expect(response.text).toBe("");
  });

  it("logs one compact line for it", async () => {
    const lines = await violationsLogged(() =>
      post("application/csp-report", JSON.stringify(CSP_REPORT)),
    );

    expect(lines).toEqual([
      {
        directive: "img-src",
        blocked: "https://images.example.net",
        document: "/search",
        disposition: "enforce",
        count: 1,
      },
    ]);
  });

  /**
   * The privacy policy says the server's logs carry no IP address and
   * nothing else identifying a visitor. A report is full of both: the
   * search they typed, the page they came from, their browser, and on the
   * request itself their address.
   */
  it("logs nothing personal — no address, no query, no referrer", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});

    await post("application/csp-report", JSON.stringify(CSP_REPORT));
    await post("application/reports+json", JSON.stringify(batch("inline")));

    const logged = JSON.stringify([warn.mock.calls, info.mock.calls]);

    for (const secret of [
      "127.0.0.1",
      "::1",
      "private+words",
      "search=",
      "www.example.org",
      "user=42",
      "Mozilla",
    ]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("takes a Reporting API batch, folding the same violation into one line", async () => {
    const lines = await violationsLogged(async () => {
      const response = await post(
        "application/reports+json",
        JSON.stringify(
          batch(
            "https://tracker.example/a",
            "https://tracker.example/b",
            "eval",
          ),
        ),
      );

      expect(response.status).toBe(204);
    });

    expect(lines).toEqual([
      expect.objectContaining({ blocked: "https://tracker.example", count: 2 }),
      expect.objectContaining({ blocked: "eval", count: 1 }),
    ]);
  });

  /**
   * A storm that is not the same violation over and over: past the cap one
   * request writes, the rest are counted in one line rather than dropped in
   * silence or written out one by one.
   */
  it("says how many it left out of a batch too large to write out", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const blocked = Array.from(
      { length: MAX_LINES_PER_REQUEST + 2 },
      (_, index) => `https://host${index}.example/x.js`,
    );

    const response = await post(
      "application/reports+json",
      JSON.stringify(batch(...blocked)),
    );

    expect(response.status).toBe(204);
    expect(
      warn.mock.calls.filter(([message]) => message === "csp violation"),
    ).toHaveLength(MAX_LINES_PER_REQUEST);
    expect(warn).toHaveBeenCalledWith("csp violations omitted", { count: 2 });
  });

  /**
   * Mounted above the CSRF check, which would refuse every report: a
   * browser sends one with no token and no way to get one. In production
   * the check also refuses an Origin that is not the site's — shown here
   * against a comment post under the same conditions, which it refuses.
   */
  it("needs no CSRF token, even in production and from another origin", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      const send = (path: string, type: string, body: string) =>
        request(server)
          .post(path)
          .set("Host", "oldschoolgames.eu")
          .set("x-forwarded-proto", "https")
          .set("Origin", "https://play.example.test")
          .set("Content-Type", type)
          .send(body);

      const report = await send(
        "/csp-report",
        "application/csp-report",
        JSON.stringify(CSP_REPORT),
      );
      const comment = await send(
        "/comments",
        "application/json",
        JSON.stringify({ content: "hi", gameId: 1 }),
      );

      expect(report.status).toBe(204);
      expect(comment.status).toBe(403);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  // Above the session, the CSRF cookie and the voter id: a browser never
  // sends any of them back from a report.
  it("hands out no cookies", async () => {
    const response = await post(
      "application/csp-report",
      JSON.stringify(CSP_REPORT),
    );

    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  // Above the access log too: the report is its own line, and a refused
  // flood must not become one line per refusal.
  it("writes no access-log line of its own", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});

    await post("application/csp-report", JSON.stringify(CSP_REPORT));

    expect(
      info.mock.calls.filter(
        ([message, fields]) =>
          message === "request" &&
          (fields as { path?: string })?.path === "/csp-report",
      ),
    ).toEqual([]);
  });

  // POST only: anything else at the address is the site's, as before.
  it("leaves GET /csp-report to the rest of the site", async () => {
    const response = await request(server).get("/csp-report");

    expect(response.status).toBe(404);
  });
});

describe("POST /csp-report — what is not a report", () => {
  /** The refusal line, which is the one sign a browser's format has moved. */
  async function refusal(send: () => Promise<{ status: number }>) {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const response = await send();

    const line = warn.mock.calls.find(
      ([message]) => message === "csp report refused",
    );

    return { status: response.status, fields: line?.[1] };
  }

  it.each([
    ["application/json"],
    ["text/plain"],
    ["application/x-www-form-urlencoded"],
  ])("refuses %s with 415", async (type) => {
    const { status, fields } = await refusal(() =>
      post(type, JSON.stringify(CSP_REPORT)),
    );

    expect(status).toBe(415);
    expect(fields).toMatchObject({ status: 415 });
  });

  it("refuses a body that is not JSON with 400", async () => {
    const { status } = await refusal(() =>
      post("application/csp-report", "{not json"),
    );

    expect(status).toBe(400);
  });

  it("refuses JSON that is not a report with 400", async () => {
    const { status } = await refusal(() =>
      post("application/csp-report", JSON.stringify({ hello: "world" })),
    );

    expect(status).toBe(400);
  });

  it("refuses an empty report with 400, not as the wrong type", async () => {
    const { status } = await refusal(() => post("application/csp-report", ""));

    expect(status).toBe(400);
  });

  /**
   * A tight limit, because nothing honest is large: one report-uri report is
   * a few hundred bytes and the policy text. Refused before it is parsed,
   * and answered here rather than by the site's error page.
   */
  it("refuses a report-uri body over 16 KB with 413", async () => {
    const big = JSON.stringify({
      "csp-report": { ...CSP_REPORT["csp-report"], "script-sample": "x".repeat(17_000) },
    });

    const { status, fields } = await refusal(() =>
      post("application/csp-report", big),
    );

    expect(status).toBe(413);
    expect(fields).toMatchObject({ status: 413 });
  });

  // A batch is allowed to be larger — some forty reports — and no more.
  it("takes a batch over 16 KB, and refuses one over 64 KB", async () => {
    const report = batch("inline")[0]!;
    const padded = (size: number) =>
      JSON.stringify([
        { ...report, body: { ...report.body, originalPolicy: "x".repeat(size) } },
      ]);

    expect((await post("application/reports+json", padded(20_000))).status).toBe(
      204,
    );
    expect((await post("application/reports+json", padded(70_000))).status).toBe(
      413,
    );
  });
});

/**
 * Its own limiter, because the global one would have counted reports against
 * the visitor's budget for the pages. Checked on an app of its own, so that
 * the requests the cases above made are not in its count: the limiter holds
 * its counts in memory, and a fresh import is a fresh limiter.
 */
describe("POST /csp-report — the limiter", () => {
  it(`takes ${CSP_REPORT_LIMIT} reports from one client and refuses the next`, async () => {
    vi.resetModules();

    const { default: freshApp } = await import("../../app.ts");
    const fresh = freshApp.listen(0);

    try {
      const send = () =>
        request(fresh)
          .post("/csp-report")
          .set("Content-Type", "application/csp-report")
          .send(JSON.stringify(CSP_REPORT));

      for (let index = 0; index < CSP_REPORT_LIMIT; index++) {
        expect((await send()).status).toBe(204);
      }

      expect((await send()).status).toBe(429);
    } finally {
      fresh.close();
      vi.resetModules();
    }
  });
});
