/**
 * What a Content-Security-Policy violation report is reduced to before it is
 * logged.
 *
 * Both policies in app.ts send their reports to routes/csp-report.ts, and
 * this is the half of that endpoint with no request in it: a body in, a list
 * of log lines out. Separate so it can be tested without an app, a limiter or
 * a database behind it.
 *
 * A report is mostly things this site must not write down. It carries the
 * full address of the page the visitor was on (the query string included,
 * which for a search is what they typed), the page they came from, the full
 * address of whatever was blocked, the first forty characters of the script
 * that was refused, the browser's user agent, and — on the request itself —
 * the visitor's IP address. The privacy policy says the server's request log
 * carries no IP address and nothing else identifying a visitor, and a
 * violation log is a request log by another name. So the line keeps only what
 * says *which rule refused what, where*:
 *
 *   - directive: the directive that refused it ("script-src-elem").
 *   - blocked: the blocked resource's origin, or its scheme when it has no
 *     origin worth naming ("data:", "chrome-extension:"), or the keyword CSP
 *     reports for things that are not resources at all ("inline", "eval").
 *   - document: the path of the page it happened on, with no query or
 *     fragment.
 *   - source: the origin or scheme of the script that was running, when the
 *     report names one. This is the field that tells a refusal the site
 *     caused from one an extension did — "chrome-extension:" — which is most
 *     of what any CSP report endpoint receives. The extension's id is not
 *     kept: which extensions a visitor has installed is a fingerprint.
 *   - disposition: "enforce" or "report", so a report-only policy added later
 *     cannot be mistaken for one that refused something.
 *
 * No URL survives whole, and nothing the visitor typed, came from or runs is
 * kept.
 */

/** One line's worth of a violation. */
export type CspViolation = {
  directive: string;
  blocked: string;
  document: string;
  source?: string;
  disposition?: string;
};

/** A violation, and how many identical ones arrived in the same request. */
export type CspViolationLine = CspViolation & { count: number };

/**
 * The two bodies a browser sends.
 *
 * "csp-report" is report-uri's: one violation per request, as
 * `{ "csp-report": { "document-uri": …, "blocked-uri": … } }`. It is what a
 * browser without the Reporting API sends, which today means Firefox.
 *
 * "reports+json" is the Reporting API's, which report-to uses: an array of
 * reports, batched — `[{ "type": "csp-violation", "url": …, "body": {
 * "documentURL": …, "blockedURL": … } }]` — whose field names are camelCase
 * where report-uri's are kebab-case.
 */
export type CspReportFormat = "csp-report" | "reports+json";

/**
 * How many distinct violations one request may put in the log.
 *
 * A batch is whatever the browser had queued, and during a storm that is
 * dozens of reports — usually the same one many times over, which is why
 * identical violations are folded into a single line with a count. The cap is
 * for the storm that is not identical: past it the rest are counted in one
 * line rather than written out, so a single request cannot turn into a page
 * of log. The limiter in routes/csp-report.ts bounds how many requests there
 * are; this bounds how much each one writes.
 */
export const MAX_LINES_PER_REQUEST = 10;

/** Longest a field may be. Every value here is an origin, a keyword or a path. */
const MAX_FIELD_LENGTH = 200;

/** A directive name: "script-src", "script-src-elem", "frame-ancestors". */
const DIRECTIVE = /^[a-z][a-z-]{0,39}$/;

/**
 * What CSP reports in place of a URL when the thing refused had none —
 * "inline", "eval", "wasm-eval", "trusted-types-sink" — and the bare scheme
 * names older engines sent ("data", "blob", "self"). Anything shaped like a
 * word passes, anything else is "unknown": a report arrives from anybody who
 * can send a POST, and this is a log line, not a place to keep what they
 * wrote.
 */
const KEYWORD = /^[a-z][a-z0-9-]{0,31}$/;

/** The schemes whose origin says something: the rest are named by scheme. */
const WEB_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

const DISPOSITIONS = new Set(["enforce", "report"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(value: string): string {
  return value.length > MAX_FIELD_LENGTH
    ? value.slice(0, MAX_FIELD_LENGTH)
    : value;
}

/** The first of several field names a report may carry the value under. */
function field(report: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (report[name] !== undefined && report[name] !== null) {
      return report[name];
    }
  }

  return undefined;
}

/**
 * A blocked or running resource, reduced to its origin, its scheme or its
 * keyword.
 *
 * The origin, never the URL: a URL's path and query are where anything
 * personal in it lives, and "which host was refused" is the whole of what the
 * line is for. new URL drops a userinfo on the way to .origin, too.
 *
 * The scheme alone for anything that is not a web origin. A data: or blob:
 * URL carries its content in the address; an extension's URL carries the
 * extension's id; neither belongs in a log.
 */
function originOrScheme(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return KEYWORD.test(value) ? value : "unknown";
  }

  return clip(WEB_SCHEMES.has(url.protocol) ? url.origin : url.protocol);
}

/**
 * The page a violation happened on, as a path.
 *
 * The query and the fragment are dropped for the reason the access log in
 * app.ts drops them: the query is what a visitor typed into the search box.
 * The host is dropped because a browser only ever sends a report here from a
 * document on this app's own origins — the site's, and the player's when it
 * has one — since both policies name the endpoint by a relative address. A
 * report claiming any other page was written by hand.
 */
function documentPath(value: unknown): string {
  if (typeof value !== "string" || value === "") return "unknown";

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return "unknown";
  }

  return clip(
    url.protocol === "https:" || url.protocol === "http:"
      ? url.pathname
      : url.protocol,
  );
}

/**
 * The directive that refused it.
 *
 * effective-directive is CSP3's and names exactly one directive; CSP2 engines
 * sent only violated-directive, which may carry the directive's whole source
 * list after the name — only the name is wanted.
 */
function directiveName(report: Record<string, unknown>): string {
  const effective = field(report, "effectiveDirective", "effective-directive");
  const violated = field(report, "violatedDirective", "violated-directive");

  const name =
    typeof effective === "string"
      ? effective
      : typeof violated === "string"
        ? (violated.trim().split(/\s+/)[0] ?? "")
        : "";

  return DIRECTIVE.test(name) ? name : "unknown";
}

function summarize(report: Record<string, unknown>): CspViolation {
  const violation: CspViolation = {
    directive: directiveName(report),
    blocked:
      originOrScheme(field(report, "blockedURL", "blocked-uri")) ?? "unknown",
    document: documentPath(field(report, "documentURL", "document-uri")),
  };

  const source = originOrScheme(field(report, "sourceFile", "source-file"));

  if (source !== undefined) violation.source = source;

  const disposition = field(report, "disposition");

  if (typeof disposition === "string" && DISPOSITIONS.has(disposition)) {
    violation.disposition = disposition;
  }

  return violation;
}

/**
 * The reports inside a body, or null when the body is not a report at all.
 *
 * null is for a body of the wrong shape, which is the client's mistake and is
 * answered 400. A Reporting API batch that is shaped right but holds nothing
 * about CSP — other report types can share an endpoint — is an empty list,
 * not a mistake: the browser did nothing wrong by sending it.
 */
function reportsIn(
  body: unknown,
  format: CspReportFormat,
): Record<string, unknown>[] | null {
  if (format === "csp-report") {
    if (!isRecord(body) || !isRecord(body["csp-report"])) return null;

    return [body["csp-report"]];
  }

  if (!Array.isArray(body)) return null;

  return body.flatMap((entry) =>
    isRecord(entry) && entry.type === "csp-violation" && isRecord(entry.body)
      ? [
          {
            ...entry.body,
            // The page's address is on the report as well as in its body; the
            // body's is preferred, the report's is the fallback.
            documentURL: entry.body.documentURL ?? entry.url,
          },
        ]
      : [],
  );
}

/**
 * The lines a body turns into, folded and capped — or null when the body is
 * not a report.
 *
 * `omitted` counts the violations past MAX_LINES_PER_REQUEST, so the caller
 * can say that it left something out rather than leaving it out in silence.
 */
export function summarizeCspReports(
  body: unknown,
  format: CspReportFormat,
): { lines: CspViolationLine[]; omitted: number } | null {
  const reports = reportsIn(body, format);

  if (reports === null) return null;

  const lines = new Map<string, CspViolationLine>();
  let omitted = 0;

  for (const report of reports) {
    const violation = summarize(report);
    // Every field is a string from a fixed set of shapes, and the object is
    // always built in the same order, so this is a stable identity for it.
    const key = JSON.stringify(violation);
    const line = lines.get(key);

    if (line) {
      line.count += 1;
    } else if (lines.size < MAX_LINES_PER_REQUEST) {
      lines.set(key, { ...violation, count: 1 });
    } else {
      omitted += 1;
    }
  }

  return { lines: [...lines.values()], omitted };
}
