import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The logger decides where a line goes once, at module load, from NODE_ENV —
 * so under the suite it is always the "none" target and everything else in
 * the module was unreachable from a test. That is the wrong half to leave
 * unexercised: almost every call to it is from inside a catch block, which
 * makes it the code most likely to be running while something else is already
 * wrong. A logger that throws there replaces the error the caller needs to
 * see with one about logging.
 *
 * Each block below re-imports the module under a stubbed NODE_ENV to reach
 * the target it is about.
 */

const appendFile = vi.fn(
  (_file: string, _line: string, callback: () => void) => callback(),
);
const existsSync = vi.fn(() => false);
const statSync = vi.fn(() => ({ size: 0 }));
const renameSync = vi.fn();

vi.mock("fs", () => ({
  default: { appendFile, existsSync, statSync, renameSync },
}));

/** MAX_LOG_BYTES in the module under test. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

type Logger = typeof import("../../utils/logger.ts").default;

/**
 * A logger whose target was chosen under `env`.
 *
 * resetModules first, because the module remembers both its target and how
 * many bytes it has written to each file — state that must not carry from one
 * of these blocks to the next.
 */
async function loadLogger(env: string): Promise<Logger> {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", env);

  return (await import("../../utils/logger.ts")).default;
}

/** The single JSON line a call produced, parsed. */
function parseLine(raw: string): {
  level: string;
  message: string;
  timestamp: string;
} {
  return JSON.parse(raw.trim());
}

describe("logger", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    appendFile.mockClear();
    existsSync.mockClear();
    statSync.mockClear();
    renameSync.mockClear();
    existsSync.mockReturnValue(false);
    statSync.mockReturnValue({ size: 0 });
    renameSync.mockReset();
  });

  /**
   * A test run used to leave thousands of lines of deliberately provoked
   * errors sitting in the working tree, which is the whole reason this target
   * exists.
   */
  describe("under test", () => {
    it("writes nothing at all", async () => {
      const logger = await loadLogger("test");

      logger.info("hello");
      logger.warn("careful");
      logger.error("broken");

      expect(appendFile).not.toHaveBeenCalled();
      expect(console.log).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
    });
  });

  /**
   * In production the platform collects and rotates stdout/stderr. Appending
   * to files inside the container instead, as this used to, grew without limit
   * on a disk nobody watches — and the container throws them away on the next
   * restart regardless.
   */
  describe("in production", () => {
    it("writes one JSON line to stdout and no file", async () => {
      const logger = await loadLogger("production");

      logger.info("Server is running on port 3000");

      expect(appendFile).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledTimes(1);

      const line = parseLine(vi.mocked(console.log).mock.calls[0]![0] as string);

      expect(line.level).toBe("info");
      expect(line.message).toBe("Server is running on port 3000");
      // Parseable and absolute, which is the point of recording it at all.
      expect(new Date(line.timestamp).toISOString()).toBe(line.timestamp);
    });

    // Separated so a log collector can route them apart, and so an error is
    // not lost in the middle of ordinary traffic.
    it("sends an error to stderr rather than stdout", async () => {
      const logger = await loadLogger("production");

      logger.error("Idle database client error:");

      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.log).not.toHaveBeenCalled();
      expect(
        parseLine(vi.mocked(console.error).mock.calls[0]![0] as string).level,
      ).toBe("error");
    });

    it("puts a warning on stdout", async () => {
      const logger = await loadLogger("production");

      logger.warn("400 POST /comments: malformed body");

      expect(console.log).toHaveBeenCalledTimes(1);
      expect(console.error).not.toHaveBeenCalled();
    });
  });

  describe("in development", () => {
    it("appends to combined.log", async () => {
      const logger = await loadLogger("development");

      logger.info("hello");

      expect(appendFile).toHaveBeenCalledTimes(1);
      expect(appendFile.mock.calls[0]![0]).toBe("combined.log");
      expect(parseLine(appendFile.mock.calls[0]![1]).message).toBe("hello");
      // One line per call, so the file stays readable line by line.
      expect(appendFile.mock.calls[0]![1].endsWith("\n")).toBe(true);
    });

    it("also appends an error to error.log", async () => {
      const logger = await loadLogger("development");

      logger.error("broken");

      expect(appendFile.mock.calls.map((call) => call[0])).toEqual([
        "combined.log",
        "error.log",
      ]);
    });

    /**
     * error.log is where you look for something to investigate, so a request
     * somebody simply sent wrong does not belong in it — see the 4xx branch
     * of the error handler in app.ts, which warns rather than errors for
     * exactly this reason.
     */
    it("keeps a warning out of error.log", async () => {
      const logger = await loadLogger("development");

      logger.warn("careful");

      expect(appendFile.mock.calls.map((call) => call[0])).toEqual([
        "combined.log",
      ]);
    });

    // Convenient while you are watching the terminal; the file is for after.
    it("echoes to the console as well", async () => {
      const logger = await loadLogger("development");

      logger.info("hello", { id: 1 });

      expect(console.log).toHaveBeenCalledWith("hello", { id: 1 });
    });
  });

  /**
   * The two development files had no bound at all, and every `npm run dev`
   * session appends to the same pair forever.
   */
  describe("rotation", () => {
    it("rolls the file over once it passes the cap", async () => {
      existsSync.mockReturnValue(true);
      statSync.mockReturnValue({ size: MAX_LOG_BYTES });

      const logger = await loadLogger("development");

      logger.info("the line that tips it over");

      expect(renameSync).toHaveBeenCalledWith("combined.log", "combined.log.1");
      // The line is still written — to the fresh file.
      expect(appendFile).toHaveBeenCalledTimes(1);
    });

    it("leaves a file under the cap alone", async () => {
      existsSync.mockReturnValue(true);
      statSync.mockReturnValue({ size: 10 });

      const logger = await loadLogger("development");

      logger.info("hello");

      expect(renameSync).not.toHaveBeenCalled();
    });

    /**
     * The previous session's lines count towards the cap too, so the size is
     * seeded from disk the first time a file is written to. A counter starting
     * at zero on every boot would never roll a file over on a machine that
     * restarts often — but it must only be read once, not per line.
     */
    it("reads the size from disk once and then counts in memory", async () => {
      existsSync.mockReturnValue(true);
      statSync.mockReturnValue({ size: 10 });

      const logger = await loadLogger("development");

      logger.info("one");
      logger.info("two");
      logger.info("three");

      expect(statSync).toHaveBeenCalledTimes(1);
      expect(appendFile).toHaveBeenCalledTimes(3);
    });

    it("does not stat a file that is not there yet", async () => {
      existsSync.mockReturnValue(false);

      const logger = await loadLogger("development");

      logger.info("hello");

      expect(statSync).not.toHaveBeenCalled();
      expect(appendFile).toHaveBeenCalledTimes(1);
    });

    /**
     * A rollover can fail — a permissions problem, a file that vanished — and
     * this runs from inside catch blocks. The line is worth more than the
     * rollover.
     */
    it("still writes the line when the rollover fails", async () => {
      existsSync.mockReturnValue(true);
      statSync.mockReturnValue({ size: MAX_LOG_BYTES });
      renameSync.mockImplementation(() => {
        throw new Error("EACCES");
      });

      const logger = await loadLogger("development");

      expect(() => logger.info("hello")).not.toThrow();
      expect(appendFile).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Almost every call here is from a catch block, so the logger itself
   * becoming the second error — thrown while reporting the first — is the
   * failure this has to be immune to.
   */
  describe("rendering an argument", () => {
    async function messageFor(...args: unknown[]): Promise<string> {
      const logger = await loadLogger("production");

      logger.info("context:", ...args);

      return parseLine(vi.mocked(console.log).mock.calls[0]![0] as string)
        .message;
    }

    it("gives an Error its stack rather than {}", async () => {
      const error = new Error("boom");

      const message = await messageFor(error);

      // JSON.stringify(new Error(...)) is "{}" — the one rendering that says
      // nothing at all about what went wrong.
      expect(message).toContain("Error: boom");
      expect(message).toContain(error.stack!.split("\n")[1]!.trim());
    });

    it("falls back to the message when an Error carries no stack", async () => {
      const error = new Error("no stack here");
      error.stack = undefined;

      expect(await messageFor(error)).toBe("context: no stack here");
    });

    it("describes a circular structure instead of throwing on it", async () => {
      const circular: Record<string, unknown> = { name: "loop" };
      circular.self = circular;

      expect(await messageFor(circular)).toBe(
        "context: [unserializable object]",
      );
    });

    // JSON.stringify throws a TypeError on a BigInt, which is the other value
    // that used to take the logger down with the error it was reporting.
    it("describes a BigInt instead of throwing on it", async () => {
      expect(await messageFor(10n)).toBe("context: [unserializable bigint]");
    });

    it("renders undefined, which stringify answers with nothing", async () => {
      expect(await messageFor(undefined)).toBe("context: undefined");
    });

    it("joins several arguments onto the one message", async () => {
      expect(await messageFor(1, "two", { three: true })).toBe(
        'context: 1 "two" {"three":true}',
      );
    });

    it("leaves the message alone when there are no arguments", async () => {
      const logger = await loadLogger("production");

      logger.info("just this");

      expect(
        parseLine(vi.mocked(console.log).mock.calls[0]![0] as string).message,
      ).toBe("just this");
    });
  });
});
