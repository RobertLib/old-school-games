import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import rateLimit from "express-rate-limit";
import logger from "../utils/logger.ts";
import { rateLimitLogger } from "../utils/rate-limit-store.ts";
import {
  summarizeCspReports,
  type CspReportFormat,
} from "../utils/csp-report.ts";

/**
 * Where a browser sends a Content-Security-Policy violation, and what is done
 * with it: one compact line in the log, and a 204.
 *
 * Neither policy in app.ts used to name anywhere to report to, and the
 * comments around them keep arriving at the same failure: a refused resource
 * is reported nowhere but the browser console. The media bucket, the
 * analytics collection hosts, data: in img-src, blob: for the emulator's
 * worker — each of those was found by somebody opening a console on a page
 * that had quietly stopped working, and a console is open on almost nobody's
 * machine. With report-to and report-uri on both policies, the next one is a
 * line in the log instead.
 *
 * What the line holds, and what it deliberately does not, is argued in
 * utils/csp-report.ts.
 */

/**
 * The endpoint's address, and the name the Reporting API knows it by.
 *
 * Relative, in both policies and in the Reporting-Endpoints header, and that
 * is load-bearing rather than tidy. A browser resolves it against the
 * document that is reporting, so the site's pages report to the site and the
 * player reports to whichever origin it is served from — its own when
 * PLAYER_ORIGIN is set, which is why app.ts mounts this above the gate that
 * otherwise answers only the player's files there. Same-origin in both cases,
 * so a report is an ordinary POST: an absolute address on another origin
 * would make every Reporting API delivery a CORS request with a preflight in
 * front of it. And a development server's reports stay on the development
 * server, where an absolute SITE_URL would have sent them to production.
 */
export const CSP_REPORT_PATH = "/csp-report";
export const CSP_REPORT_GROUP = "csp-endpoint";

/**
 * How many report requests one client may send in the window.
 *
 * A browser sends reports on its own schedule, and that schedule can be a
 * flood: report-uri is one POST per violation, so a page whose policy refuses
 * five things sends five per view, and an extension that injects an inline
 * script trips a violation on every page it touches. Sixty in ten minutes is
 * more than any one visitor's genuine refusals need — a refusal the site
 * caused shows up across many visitors, not as sixty lines from one — and it
 * keeps a single client, broken or hostile, from writing the log.
 *
 * Counted in this process's memory, like the global limiter in app.ts and
 * for its reason: this protects a machine's log and event loop rather than
 * rationing a person, and a flood arrives at a machine. The shared Postgres
 * store would also turn a storm of reports into a storm of writes, which is
 * the one thing an endpoint that exists to report trouble must not cause.
 * Ten minutes keeps it inside the fifteen the privacy policy gives as the
 * longest window an address is counted in.
 *
 * Exported for the suite, which has to know where the limit is to test it.
 */
export const CSP_REPORT_LIMIT = 60;
const CSP_REPORT_WINDOW_MS = 10 * 60 * 1000;

const reportLimiter = rateLimit({
  windowMs: CSP_REPORT_WINDOW_MS,
  limit: CSP_REPORT_LIMIT,
  // ...and says so through utils/logger.ts rather than the library's own
  // console fallback — see rateLimitLogger.
  logger: rateLimitLogger,
});

/**
 * One parser per format, each with a limit sized to what that format is.
 *
 * report-uri sends one violation per request, and a violation is a few
 * hundred bytes plus the policy text and a handful of URLs: the site's own
 * policy is under a kilobyte, so 16 KB is several times the largest honest
 * report and a fraction of express.json's default hundred. The Reporting API
 * batches, so its bodies are larger by design — 64 KB is some forty reports,
 * and a batch past that is refused with a 413 and logged rather than read.
 * Nothing about a report is worth a larger body than that.
 */
const parseCspReport = express.json({
  type: "application/csp-report",
  limit: "16kb",
});

const parseReports = express.json({
  type: "application/reports+json",
  limit: "64kb",
});

/**
 * The format a request says it is, from its Content-Type alone.
 *
 * Not req.is(), which answers null for a request with no body — so an empty
 * report would be told its media type is unsupported, which is not what is
 * wrong with it. The type is read off the header; whether there is a report
 * in the body is summarizeCspReports's question.
 */
function formatOf(req: Request): CspReportFormat | null {
  const mediaType = (req.headers["content-type"] ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();

  if (mediaType === "application/csp-report") return "csp-report";
  if (mediaType === "application/reports+json") return "reports+json";

  return null;
}

/**
 * Refuses a request that is not a report, with a status and no body.
 *
 * Logged, once and compactly, because a browser never sends one of these —
 * so a run of them is either somebody probing, which the limiter bounds, or a
 * browser whose reports this no longer understands, which is exactly the kind
 * of silent failure this endpoint exists to end.
 */
function refuse(res: Response, status: number, reason: string): void {
  logger.warn("csp report refused", { status, reason });
  res.status(status).end();
}

const router = express.Router();

router.post(
  CSP_REPORT_PATH,
  // Ahead of the parsers, so a flood is turned away before any of it is read.
  reportLimiter,
  parseCspReport,
  parseReports,
  (req, res) => {
    const format = formatOf(req);

    if (format === null) {
      refuse(res, 415, "unsupported media type");
      return;
    }

    const summary = summarizeCspReports(req.body, format);

    if (summary === null) {
      refuse(res, 400, "not a report");
      return;
    }

    // Warn, not info. LOG_LEVEL=warn is what the README suggests for a busy
    // deployment, and at info these would be dropped with the access log —
    // a refusal the site caused is the thing this whole endpoint exists to
    // surface, not traffic.
    for (const line of summary.lines) {
      logger.warn("csp violation", line);
    }

    if (summary.omitted > 0) {
      logger.warn("csp violations omitted", { count: summary.omitted });
    }

    // Nothing to send back: nothing reads it. A 2xx is what tells the
    // Reporting API the batch was delivered, so it does not try again.
    res.status(204).end();
  },
);

/**
 * The parsers' own refusals — a body over the limit, JSON that does not
 * parse, a charset nobody sends — answered here rather than by the handler at
 * the foot of app.ts.
 *
 * That handler renders the site's 400 page, with its layout and its sidebars,
 * for anything that is not JSON-shaped by its address — a full page render
 * per malformed report, in reply to something that never reads a body.
 * Anything that is not a client's mistake still goes on to it, to be logged
 * with its stack.
 */
router.use(
  (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    const { status, type } = (error ?? {}) as { status?: unknown; type?: unknown };

    if (typeof status === "number" && status >= 400 && status < 500) {
      refuse(res, status, typeof type === "string" ? type : "unreadable body");
      return;
    }

    next(error);
  },
);

export default router;
