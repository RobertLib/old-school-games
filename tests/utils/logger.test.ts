import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";
import { fileURLToPath } from "url";

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

/**
 * Where the module writes, which is beside package.json rather than in the
 * current working directory.
 *
 * The two files used to be opened by their bare names, so where a line landed
 * depended on where the command was run from — and the 5 MB cap was applied
 * per directory while the byte counter was shared between them. Derived here
 * the same way utils/logger.ts derives it, from a module location rather than
 * from process.cwd(), so this stays true however the runner is invoked.
 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const COMBINED_LOG = path.join(ROOT, "combined.log");
const ERROR_LOG = path.join(ROOT, "error.log");

type Logger = typeof import("../../utils/logger.ts").default;

/**
 * A logger whose target was chosen under `env`, and whose threshold was
 * chosen under `logLevel`.
 *
 * resetModules first, because the module remembers its target, its threshold
 * and how many bytes it has written to each file — state that must not carry
 * from one of these blocks to the next.
 *
 * Both variables are stubbed on every call, undefined included. That is what
 * makes this file independent of what loaded before it: it used to be in the
 * integration project purely because two cases read whatever NODE_ENV the
 * process happened to be holding, which tests/setup.ts pins to "test" — so run
 * without that setup they failed, and vitest.config.ts carried a paragraph
 * explaining why a file that touches no database was behind a database setup.
 * Every case now states the environment it is about, so the file is in the
 * unit project where it belongs. Stubbing LOG_LEVEL has always been for the
 * same reason one step down: a developer with it set in their own shell must
 * not change what these assert.
 */
async function loadLogger(env: string, logLevel?: string): Promise<Logger> {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", env);
  vi.stubEnv("LOG_LEVEL", logLevel);

  return (await import("../../utils/logger.ts")).default;
}

/**
 * Waits for every append the logger has queued to reach the mock.
 *
 * appendRotating serialises the appends to one file behind a promise chain,
 * so that a rollover cannot rename the file out from under a write that is
 * still in flight. The first line of a burst still reaches fs.appendFile in
 * the same tick — every assertion about a single call is unchanged — but the
 * ones behind it are handed over as the chain settles, which is a microtask
 * at a time. A macrotask boundary is past all of them.
 */
function flushAppends(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The single JSON line a call produced, parsed. */
function parseLine(raw: string): {
  level: string;
  message: string;
  timestamp: string;
} & Record<string, unknown> {
  return JSON.parse(raw.trim());
}

describe("logger", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    // Drained before the mocks are cleared. A block that queues several lines
    // to one file leaves the tail of that chain pending, and those calls would
    // otherwise land in the *next* block's appendFile counts — the module is
    // re-imported per test, but the mock it writes to is shared.
    await flushAppends();

    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    appendFile.mockClear();
    appendFile.mockImplementation(
      (_file: string, _line: string, callback: () => void) => callback(),
    );
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
      expect(appendFile.mock.calls[0]![0]).toBe(COMBINED_LOG);
      expect(parseLine(appendFile.mock.calls[0]![1]).message).toBe("hello");
      // One line per call, so the file stays readable line by line.
      expect(appendFile.mock.calls[0]![1].endsWith("\n")).toBe(true);
    });

    it("also appends an error to error.log", async () => {
      const logger = await loadLogger("development");

      logger.error("broken");

      expect(appendFile.mock.calls.map((call) => call[0])).toEqual([
        COMBINED_LOG,
        ERROR_LOG,
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
        COMBINED_LOG,
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

      expect(renameSync).toHaveBeenCalledWith(COMBINED_LOG, `${COMBINED_LOG}.1`);
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

      // The second and third wait for the one before them — see flushAppends
      // — which is what stops a rollover renaming the file mid-write.
      await flushAppends();

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
     * The bytes are counted on the way in, because the count has to be in
     * place before the next call reads it and appendFile is asynchronous — a
     * burst crediting itself only on success would all read the same stale
     * size. A write that then *fails* has to give them back, or the count
     * drifts up on its own until it reaches the cap and renames a file the
     * process has not written a byte to.
     */
    it("does not count bytes a failed append never wrote", async () => {
      existsSync.mockReturnValue(true);
      statSync.mockReturnValue({ size: MAX_LOG_BYTES - 200 });
      appendFile.mockImplementation(
        (_file: string, _line: string, callback: (error?: Error) => void) =>
          callback(new Error("ENOSPC")),
      );

      const logger = await loadLogger("development");

      // Well over the 200 bytes of headroom in total, but none of it landed.
      for (let i = 0; i < 20; i += 1) logger.info(`line ${i}`);

      await flushAppends();

      expect(appendFile).toHaveBeenCalledTimes(20);
      expect(renameSync).not.toHaveBeenCalled();
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
    async function lineFor(
      ...args: unknown[]
    ): Promise<ReturnType<typeof parseLine>> {
      const logger = await loadLogger("production");

      logger.info("context:", ...args);

      return parseLine(vi.mocked(console.log).mock.calls[0]![0] as string);
    }

    async function messageFor(...args: unknown[]): Promise<string> {
      return (await lineFor(...args)).message;
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

    /**
     * An object literal is a bag of fields now (see the block below), so a
     * circular one is checked a value at a time — which is the case that
     * matters: the circle is almost always one property deep in something
     * otherwise perfectly loggable, and the rest of it is still worth having.
     */
    it("describes a circular value instead of throwing on it", async () => {
      const circular: Record<string, unknown> = { name: "loop" };
      circular.self = circular;

      const line = await lineFor(circular);

      expect(line.message).toBe("context:");
      expect(line.name).toBe("loop");
      expect(line.self).toBe("[unserializable object]");
    });

    it("describes a circular structure that is not a field bag", async () => {
      const circular: unknown[] = [];
      circular.push(circular);

      // An array has a prototype of its own, so it is rendered rather than
      // flattened — "0", "1", "2" are not field names anybody wants.
      expect(await messageFor(circular)).toBe("context: [unserializable object]");
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
      expect(await messageFor(1, "two", [3])).toBe('context: 1 "two" [3]');
    });

    it("leaves the message alone when there are no arguments", async () => {
      const logger = await loadLogger("production");

      logger.info("just this");

      expect(
        parseLine(vi.mocked(console.log).mock.calls[0]![0] as string).message,
      ).toBe("just this");
    });
  });
  /**
   * The access log in app.ts is the reason this exists: a collector can count
   * 500s per path or sort by durationMs when those are fields, and can do
   * neither when they are a substring of a sentence.
   */
  describe("fields", () => {
    async function lineFor(...args: unknown[]) {
      const logger = await loadLogger("production");

      logger.info("request", ...args);

      return parseLine(vi.mocked(console.log).mock.calls[0]![0] as string);
    }

    it("lifts an object literal's properties out of the message", async () => {
      const line = await lineFor({
        method: "GET",
        path: "/doom",
        status: 200,
        durationMs: 12.4,
      });

      expect(line.message).toBe("request");
      expect(line.method).toBe("GET");
      expect(line.path).toBe("/doom");
      // A number, not "200": the type is half of what makes a field useful.
      expect(line.status).toBe(200);
      expect(line.durationMs).toBe(12.4);
    });

    it("keeps appending everything that is not an object literal", async () => {
      const line = await lineFor("on", 3, { status: 500 });

      // Strings still go through JSON, which is what quotes "on" — the
      // rendering above this block is unchanged.
      expect(line.message).toBe('request "on" 3');
      expect(line.status).toBe(500);
    });

    /**
     * An Error is the one object most often passed here, and flattening it
     * would lose the only part worth having: JSON.stringify(new Error(...))
     * is "{}".
     */
    it("still renders an Error rather than flattening it", async () => {
      const line = await lineFor(new Error("boom"));

      expect(line.message).toContain("Error: boom");
    });

    it("merges several object arguments into one set of fields", async () => {
      const line = await lineFor({ a: 1 }, { b: 2 });

      expect(line.a).toBe(1);
      expect(line.b).toBe(2);
    });

    it("takes an object with no prototype as fields too", async () => {
      const bag = Object.create(null) as Record<string, unknown>;
      bag.path = "/news";

      expect((await lineFor(bag)).path).toBe("/news");
    });

    // The three fields the line is about are written last, so a caller
    // cannot displace them by accident — a "level" of its own would make
    // every line unfilterable by severity.
    it("does not let a field displace level, message or timestamp", async () => {
      const line = await lineFor({
        level: "debug",
        message: "elsewhere",
        timestamp: "yesterday",
      });

      expect(line.level).toBe("info");
      expect(line.message).toBe("request");
      expect(new Date(line.timestamp).toISOString()).toBe(line.timestamp);
    });

    it("writes the fields to the development file as well", async () => {
      const logger = await loadLogger("development");

      logger.info("request", { status: 404 });

      expect(parseLine(appendFile.mock.calls[0]![1]).status).toBe(404);
    });
  });

  /**
   * Turning the volume down, which until LOG_LEVEL existed was impossible:
   * the access log in app.ts writes an "info" line per request, and the only
   * lever was the NODE_ENV that also decides *where* a line goes.
   */
  describe("LOG_LEVEL", () => {
    /** Which of the three levels reached stdout or stderr. */
    async function written(logLevel?: string): Promise<string[]> {
      const logger = await loadLogger("production", logLevel);

      logger.info("an info line");
      logger.warn("a warn line");
      logger.error("an error line");

      return [
        ...vi.mocked(console.log).mock.calls,
        ...vi.mocked(console.error).mock.calls,
      ].map((call) => parseLine(call[0] as string).level);
    }

    // What every deployment got before this option existed, so adding it
    // changes nothing for one that does not set it.
    it("writes all three levels when it is unset", async () => {
      expect((await written()).sort()).toEqual(["error", "info", "warn"]);
    });

    it("drops info at warn", async () => {
      expect((await written("warn")).sort()).toEqual(["error", "warn"]);
    });

    it("drops everything but errors at error", async () => {
      expect(await written("error")).toEqual(["error"]);
    });

    it("writes all three at info", async () => {
      expect((await written("info")).sort()).toEqual(["error", "info", "warn"]);
    });

    // A value out of a shell or a Fly secret arrives however somebody typed
    // it, and "ERROR" is not a different level from "error".
    it("ignores case and surrounding space", async () => {
      expect((await written("  WARN  ")).sort()).toEqual(["error", "warn"]);
    });

    // Unset and set-to-nothing are the same thing; an empty secret is not a
    // request for silence.
    it("treats an empty value as unset", async () => {
      expect((await written("")).sort()).toEqual(["error", "info", "warn"]);
    });

    /**
     * The one case where guessing wrong is expensive. Read strictly, a typo
     * would silence the log — and the missing lines are the last thing
     * anybody would connect to a misspelled variable. Louder than asked for
     * is a nuisance; silence is an outage nobody can see.
     */
    describe("given a value that is not a level", () => {
      it("says so once, and at warn level", async () => {
        await loadLogger("production", "verbose");

        const lines = vi
          .mocked(console.log)
          .mock.calls.map((call) => parseLine(call[0] as string));

        expect(lines).toHaveLength(1);
        expect(lines[0]!.level).toBe("warn");
        expect(lines[0]!.message).toContain('LOG_LEVEL="verbose"');
        expect(lines[0]!.message).toContain('using "info"');
      });

      it("falls back to info rather than to silence", async () => {
        const logger = await loadLogger("production", "verbose");

        vi.mocked(console.log).mockClear();

        logger.info("still here");

        expect(console.log).toHaveBeenCalledTimes(1);
      });

      // The complaint goes through the same path as every other line, so
      // under the test target it is not written either — which is what keeps
      // it out of every other file's output.
      it("writes nothing at all under the test target", async () => {
        await loadLogger("test", "verbose");

        expect(console.log).not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
        expect(appendFile).not.toHaveBeenCalled();
      });
    });
  });
});
