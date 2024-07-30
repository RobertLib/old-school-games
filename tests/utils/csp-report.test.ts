import { describe, expect, it } from "vitest";
import {
  MAX_LINES_PER_REQUEST,
  summarizeCspReports,
} from "../../utils/csp-report.ts";

/**
 * What a CSP violation report is reduced to before routes/csp-report.ts logs
 * it: which directive refused what, on which page — and none of the rest of
 * what a report carries, because the privacy policy says the server's logs
 * hold no IP address and nothing else identifying a visitor.
 */

/** A report-uri body as Firefox sends one, with everything a report may say. */
function cspReport(overrides: Record<string, unknown> = {}) {
  return {
    "csp-report": {
      "document-uri": "https://oldschoolgames.eu/search?search=my+secret+query#top",
      referrer: "https://www.example.org/private/page?token=abc",
      "violated-directive": "script-src-elem",
      "effective-directive": "script-src-elem",
      "original-policy": "default-src 'self'; script-src 'self' 'nonce-abc'",
      disposition: "enforce",
      "blocked-uri": "https://user:pw@evil.example:8443/steal.js?id=42",
      "line-number": 12,
      "column-number": 3,
      "source-file": "https://oldschoolgames.eu/js/ui.js?v=123",
      "status-code": 200,
      "script-sample": "var visitorEmail = 'someone@example.org'",
      ...overrides,
    },
  };
}

/** A Reporting API report, the shape report-to delivers in a batch. */
function reportingApiReport(body: Record<string, unknown> = {}, url?: string) {
  return {
    type: "csp-violation",
    age: 12,
    url: url ?? "https://oldschoolgames.eu/doom?search=x",
    user_agent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0",
    body: {
      documentURL: "https://oldschoolgames.eu/doom?search=x",
      referrer: "https://www.example.org/",
      blockedURL: "https://cdn.example.net/lib.js?q=1",
      effectiveDirective: "script-src-elem",
      originalPolicy: "default-src 'self'",
      sourceFile: "https://oldschoolgames.eu/doom",
      sample: "",
      disposition: "enforce",
      statusCode: 200,
      lineNumber: 1,
      columnNumber: 1,
      ...body,
    },
  };
}

function only(body: unknown, format: "csp-report" | "reports+json") {
  const summary = summarizeCspReports(body, format);

  expect(summary).not.toBeNull();
  expect(summary!.lines).toHaveLength(1);

  return summary!.lines[0]!;
}

describe("summarizeCspReports — what a line keeps", () => {
  it("keeps the directive, the blocked origin, the page's path and where it ran", () => {
    expect(only(cspReport(), "csp-report")).toEqual({
      directive: "script-src-elem",
      blocked: "https://evil.example:8443",
      document: "/search",
      source: "https://oldschoolgames.eu",
      disposition: "enforce",
      count: 1,
    });
  });

  /**
   * The whole point of reducing a report: the query string is what a visitor
   * typed into the search box, the referrer is where they came from, the
   * sample is a piece of the page, and a blocked URL's path and userinfo are
   * nobody's business. None of it may reach the log.
   */
  it("keeps nothing a visitor typed, came from or ran", () => {
    const logged = JSON.stringify(only(cspReport(), "csp-report"));

    for (const secret of [
      "my+secret+query",
      "search=",
      "www.example.org",
      "token=abc",
      "someone@example.org",
      "steal.js",
      "id=42",
      "user:pw",
      "Mozilla",
      "nonce-abc",
    ]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("does the same for the Reporting API's camelCase body", () => {
    expect(only([reportingApiReport()], "reports+json")).toEqual({
      directive: "script-src-elem",
      blocked: "https://cdn.example.net",
      document: "/doom",
      source: "https://oldschoolgames.eu",
      disposition: "enforce",
      count: 1,
    });
  });

  it("falls back to the report's own address for the page", () => {
    const report = reportingApiReport({ documentURL: undefined }, "https://oldschoolgames.eu/news?x=1");

    expect(only([report], "reports+json").document).toBe("/news");
  });

  // CSP2 engines sent only violated-directive, with the directive's whole
  // source list after the name.
  it("takes the directive's name out of an old violated-directive", () => {
    const report = cspReport({
      "effective-directive": undefined,
      "violated-directive": "script-src 'self' 'nonce-abc' https://x.example",
    });

    expect(only(report, "csp-report").directive).toBe("script-src");
  });

  it("does not trust a directive that is not shaped like one", () => {
    const report = cspReport({ "effective-directive": "script-src; evil" });

    expect(only(report, "csp-report").directive).toBe("unknown");
  });

  // A report that leaves things out is still a report; what it did not say
  // is "unknown" rather than a guess, and nothing is invented for it.
  it("says unknown for what a report leaves out", () => {
    const line = only(
      {
        "csp-report": {
          "blocked-uri": "https://evil.example/x.js",
        },
      },
      "csp-report",
    );

    expect(line).toEqual({
      directive: "unknown",
      blocked: "https://evil.example",
      document: "unknown",
      count: 1,
    });
  });

  it("keeps only a disposition CSP defines", () => {
    const line = only(cspReport({ disposition: "maybe" }), "csp-report");

    expect(line).not.toHaveProperty("disposition");
  });
});

describe("summarizeCspReports — what was blocked", () => {
  it.each([
    ["inline", "inline"],
    ["eval", "eval"],
    ["wasm-eval", "wasm-eval"],
    ["trusted-types-sink", "trusted-types-sink"],
    // The bare scheme names older engines reported.
    ["data", "data"],
    // A data: or blob: URL carries its content in the address.
    ["data:image/png;base64,AAAA", "data:"],
    ["blob:https://oldschoolgames.eu/7b1c-uuid", "blob:"],
    // An extension's URL carries its id, and which extensions a visitor has
    // installed is a fingerprint.
    ["chrome-extension://abcdefghijklmnop/inject.js", "chrome-extension:"],
    ["moz-extension://0f3c-uuid/content.js", "moz-extension:"],
    ["wss://socket.example.com/feed?user=1", "wss://socket.example.com"],
    // Anybody can POST here, so what is not shaped like a keyword is not kept.
    ["<script>alert(1)</script>", "unknown"],
    ["a".repeat(40), "unknown"],
  ])("reports %o as %o", (blocked, expected) => {
    expect(only(cspReport({ "blocked-uri": blocked }), "csp-report").blocked).toBe(
      expected,
    );
  });

  it("says unknown when nothing was named", () => {
    expect(
      only(cspReport({ "blocked-uri": "" }), "csp-report").blocked,
    ).toBe("unknown");
  });
});

describe("summarizeCspReports — the page it happened on", () => {
  it.each([
    ["https://oldschoolgames.eu/", "/"],
    ["https://play.example.test/js-dos.html?v=1&stream=x", "/js-dos.html"],
    ["about:srcdoc", "about:"],
    ["not a url", "unknown"],
  ])("reports %o as %o", (documentUri, expected) => {
    expect(
      only(cspReport({ "document-uri": documentUri }), "csp-report").document,
    ).toBe(expected);
  });

  it("clips a path nobody's browser would send", () => {
    const path = `/${"x".repeat(500)}`;
    const line = only(
      cspReport({ "document-uri": `https://oldschoolgames.eu${path}` }),
      "csp-report",
    );

    expect(line.document.length).toBeLessThanOrEqual(200);
  });
});

describe("summarizeCspReports — a batch", () => {
  /**
   * During a storm a batch is the same violation many times over, and one
   * line with a count says that better than a screenful of copies.
   */
  it("folds identical violations into one line with a count", () => {
    const batch = [reportingApiReport(), reportingApiReport(), reportingApiReport()];
    const summary = summarizeCspReports(batch, "reports+json")!;

    expect(summary.lines).toHaveLength(1);
    expect(summary.lines[0]!.count).toBe(3);
    expect(summary.omitted).toBe(0);
  });

  it("caps the distinct lines one request may write, and counts the rest", () => {
    const batch = Array.from({ length: MAX_LINES_PER_REQUEST + 5 }, (_, index) =>
      reportingApiReport({ blockedURL: `https://host${index}.example/x.js` }),
    );
    const summary = summarizeCspReports(batch, "reports+json")!;

    expect(summary.lines).toHaveLength(MAX_LINES_PER_REQUEST);
    expect(summary.omitted).toBe(5);
  });

  // Other report types can share an endpoint; a browser sending one did
  // nothing wrong, and there is nothing about CSP in it to log.
  it("ignores reports that are not about CSP", () => {
    const batch = [
      { type: "deprecation", url: "https://oldschoolgames.eu/", body: { id: "x" } },
      reportingApiReport(),
    ];

    expect(summarizeCspReports(batch, "reports+json")!.lines).toHaveLength(1);
  });

  it("accepts a batch with nothing in it about CSP as an empty one", () => {
    expect(summarizeCspReports([], "reports+json")).toEqual({
      lines: [],
      omitted: 0,
    });
  });
});

describe("summarizeCspReports — what is not a report", () => {
  it.each([
    ["no body at all", undefined, "csp-report"],
    ["an empty object", {}, "csp-report"],
    ["a report-uri body with no report in it", { "csp-report": "x" }, "csp-report"],
    ["a batch sent as report-uri", [reportingApiReport()], "csp-report"],
    ["a report-uri body sent as a batch", cspReport(), "reports+json"],
    ["a string", "hello", "reports+json"],
  ] as const)("refuses %s", (_label, body, format) => {
    expect(summarizeCspReports(body, format)).toBeNull();
  });
});
