import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

type LogLevel = "info" | "warn" | "error";

/**
 * Where a line ends up depends on where the process runs.
 *
 * In production it goes to stdout/stderr, which is what the platform collects
 * and rotates. Appending to files inside the container instead, as this used
 * to, grew without limit on a disk nobody watches — and the container throws
 * them away on the next restart regardless.
 *
 * Locally the files are still convenient, so they stay. Under test nothing is
 * written: a test run used to leave thousands of lines of deliberately
 * provoked errors sitting in the working tree.
 */
const target =
  process.env.NODE_ENV === "test"
    ? "none"
    : process.env.NODE_ENV === "production"
      ? "console"
      : "file";

/**
 * How large a development log file may get before it is rolled over.
 *
 * The two files below had no bound at all. In production that costs nothing —
 * nothing writes them there — but locally they are in the working tree and
 * every `npm run dev` session appends to the same pair forever. Five
 * megabytes is far more than anyone reads and small enough to stay out of the
 * way.
 */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * Where the two development log files live: beside package.json, always.
 *
 * They used to be opened as bare relative names, which resolves against the
 * *current working directory* — so where a line landed depended on where the
 * command had been run from. `npm run dev` from the project root wrote the
 * pair .gitignore and .dockerignore name; the same process started from a
 * subdirectory, or by an editor task, or by a `create-admin` invoked from
 * elsewhere, quietly created a second combined.log/error.log pair there, which
 * nothing ignores and nobody thinks to look in. Worse for the rollover: the
 * size check and the rename operate on whichever copy the CWD selected, so two
 * working directories mean two independent 5 MB caps and one counter shared
 * between them.
 *
 * Derived from this module's own location, which is fixed whatever the CWD is.
 */
const ROOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMBINED_LOG = path.join(ROOT_DIR, "combined.log");
const ERROR_LOG = path.join(ROOT_DIR, "error.log");

/**
 * Severity, as a number, so one can be compared with another.
 *
 * Three levels rather than the usual half-dozen, because three is what this
 * app calls: "error" is something to investigate, "warn" is a request
 * somebody simply sent wrong, "info" is everything else. There is no "debug"
 * to leave out.
 */
const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2 };

/**
 * The quietest level that is still written, read once from LOG_LEVEL.
 *
 * Until this existed there was no way to turn the volume down at all: the
 * access log in app.ts writes an "info" line per request, and on the
 * production target that is every request the site serves going through the
 * platform's log collector. Somebody watching an incident wants the errors
 * out of that, and the only lever was the NODE_ENV that also decides *where*
 * a line goes — so quieting the log meant pretending not to be in production.
 *
 * Default "info", i.e. everything, because that is what every deployment got
 * before this and a configuration option should not change what an existing
 * one does.
 *
 * An unrecognised value falls back to "info" and says so once, rather than
 * being taken as "off". A typo'd LOG_LEVEL is the one case where guessing
 * wrong is expensive: read strictly it would silence the log, and the missing
 * lines are the last thing anybody would connect to a misspelled variable.
 * Louder-than-asked-for is a nuisance; silence is an outage nobody can see.
 *
 * Object.hasOwn rather than `in`, which also answers true for anything on
 * Object.prototype: LOG_LEVEL="constructor", "toString" or "valueOf" passed
 * the check, was accepted as a level, and then indexed LEVEL_ORDER to a
 * *function*. Comparing a number against that is NaN, so every comparison
 * below is false and the threshold silently became "write everything" — with
 * no complaint logged either, because the value had been judged valid.
 */
const requested = process.env.LOG_LEVEL?.trim().toLowerCase();
const invalidLevel =
  requested !== undefined &&
  requested !== "" &&
  !Object.hasOwn(LEVEL_ORDER, requested)
    ? process.env.LOG_LEVEL
    : undefined;
const threshold: LogLevel =
  requested !== undefined && Object.hasOwn(LEVEL_ORDER, requested)
    ? (requested as LogLevel)
    : "info";

/**
 * Bytes written to each file since this process started caring, so the size
 * check below costs no syscall per line.
 *
 * Seeded from the file on disk the first time it is written to, because the
 * previous session's lines count towards the cap too — a counter starting at
 * zero on every boot would never roll a file over on a machine that restarts
 * often.
 */
const written = new Map<string, number>();

/**
 * The append currently in flight for each file, so the next one waits for it.
 *
 * The rollover is synchronous and the append is not, and the two used to race
 * each other over the same file. A line handed to fs.appendFile is written
 * whenever the thread pool gets to it, while the very next call to this
 * function checks the size, renames the file out from under it and starts
 * writing to a fresh one — so the older line landed in "<name>.1" *after* the
 * rollover, behind lines that were logged later, or in a file that no longer
 * had the name it was opened under. Two appends to the same file were equally
 * free to complete in either order, which is how a burst of lines around an
 * error arrived out of sequence in the file you read to work out what
 * happened first.
 *
 * Chained per file rather than one chain for the whole logger: combined.log
 * and error.log are separate files with separate caps, and an error line
 * should not queue behind the access log's.
 *
 * The entry is dropped once it settles, so a file nobody is writing to is
 * back to being appended to immediately — the first line of a burst still
 * reaches fs.appendFile synchronously, and only the ones behind it wait.
 */
const appending = new Map<string, Promise<void>>();

/**
 * Appends a line, rolling the file over first if it has grown past the cap.
 *
 * One generation is kept, as "<name>.1": enough to still have the run before
 * the current one, and a fixed ceiling of twice the cap per file rather than
 * a numbered series nothing would ever prune. The rolled-over name needed its
 * own line in .gitignore and .dockerignore — "*.log" does not match
 * "combined.log.1", because that name no longer ends in ".log".
 *
 * Everything here is wrapped, because this runs from inside catch blocks. A
 * logger that throws while reporting an error replaces the error the caller
 * needs to see with one about logging, which is the failure format() above
 * already exists to avoid. That is also why nothing here rejects: an
 * unhandled rejection out of the logger would be reported as an error of its
 * own, on behalf of a line that failed to be written.
 */
function appendRotating(file: string, line: string): void {
  const bytes = Buffer.byteLength(line);

  const write = async (): Promise<void> => {
    // The size this line is being appended to, after any rollover below.
    // Undefined means the sizing itself failed, and the counter is then left
    // alone so the next line reads it from disk again rather than counting up
    // from a guess.
    let size: number | undefined;

    try {
      const counted = written.get(file);

      size = counted ?? (fs.existsSync(file) ? fs.statSync(file).size : 0);

      if (size + bytes > MAX_LOG_BYTES) {
        // Rename rather than truncate: a truncate would drop the lines while
        // the previous session's context is often the interesting part.
        //
        // Safe to do synchronously here, and only here: the chain above means
        // no append to this file is in flight, so the file being renamed is
        // one nothing is holding open behind us.
        fs.renameSync(file, `${file}.1`);
        size = 0;
      }
    } catch {
      // The rollover failed — a permissions problem, a file that vanished.
      // The line is still worth writing, and the next call will try again.
      size = undefined;
    }

    await new Promise<void>((resolve) => {
      try {
        fs.appendFile(file, line, (error) => {
          // Credited once the bytes are actually on disk, which is possible
          // now that the next append to this file waits for this callback.
          // Counting on the way in and correcting on failure, as this used to
          // do, was the only way to keep a burst from all reading the same
          // stale size — and it drifted the count up whenever an EACCES or a
          // full disk left the file exactly as it was, until it reached the
          // cap on its own and renamed a file the process had not written a
          // byte to. Nothing is reported either way: this runs from inside
          // catch blocks, and a logger that logs about logging is the one
          // thing it must never do.
          if (!error && size !== undefined) written.set(file, size + bytes);

          resolve();
        });
      } catch {
        // fs.appendFile itself refusing the arguments. Nothing was written and
        // nothing is counted; the chain must still move on.
        resolve();
      }
    });
  };

  const previous = appending.get(file);

  // Started straight away when the file is idle — the same handler, the same
  // tick — so a single line still reaches fs.appendFile before this function
  // returns. `then(write, write)` rather than `then(write)`, so one line's
  // failure cannot strand every line behind it.
  const next = previous ? previous.then(write, write) : write();

  appending.set(file, next);

  void next.then(
    () => {
      if (appending.get(file) === next) appending.delete(file);
    },
    () => {
      if (appending.get(file) === next) appending.delete(file);
    },
  );
}

/**
 * Renders one logged argument.
 *
 * JSON.stringify throws on a circular structure and on a BigInt, and almost
 * every call here is from a catch block — so the logger itself became the
 * second error, thrown while reporting the first. Anything it cannot
 * serialise is described instead.
 */
function format(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return `[unserializable ${typeof value}]`;
  }
}

/**
 * Whether a value is a bag of fields rather than a thing to describe.
 *
 * Only an object literal counts — `{}` or `Object.create(null)`. An Error, a
 * Date, an array, a class instance all have a prototype of their own and are
 * rendered into the message by format() as before, because their meaning is
 * not "here are some fields": flattening an Error would lose the stack, and
 * an array would arrive as "0", "1", "2".
 */
function isFieldBag(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;

  const proto = Object.getPrototypeOf(value) as object | null;

  return proto === Object.prototype || proto === null;
}

/**
 * One field's value, made safe to put in the line.
 *
 * Same contract as format() above and for the same reason — the logger must
 * not become the second error — but it keeps the value rather than turning
 * it into a string, so a number stays a number and a collector can filter on
 * it. Only what JSON.stringify refuses is described instead.
 */
function fieldValue(value: unknown): unknown {
  if (value instanceof Error) return value.stack ?? value.message;

  try {
    JSON.stringify(value);

    return value;
  } catch {
    return `[unserializable ${typeof value}]`;
  }
}

/**
 * Renders one line.
 *
 * An object literal among the arguments contributes its properties as fields
 * of their own — `logger.info("request", { status: 404 })` produces
 * `{"status":404,…}` rather than a message with `{"status":404}` glued onto
 * the end. A log collector can filter and aggregate on a field; it cannot on
 * a substring, which is what the access log in app.ts needed. Everything
 * else an argument can be is still appended to the message, so every other
 * call site reads as it did.
 *
 * The three fields the line is *about* are written last, so a caller that
 * happens to pass a "level" or a "message" of its own cannot displace them.
 */
function log(level: LogLevel, message: string, ...args: unknown[]): void {
  if (target === "none") return;
  // Before anything is rendered: a line nobody will read should not cost a
  // JSON.stringify per argument, which is the point of a threshold on an
  // access log that runs once per request.
  if (LEVEL_ORDER[level] > LEVEL_ORDER[threshold]) return;

  const rendered: string[] = [];
  const fields: Record<string, unknown> = {};

  for (const arg of args) {
    if (isFieldBag(arg)) {
      for (const [key, value] of Object.entries(arg)) {
        fields[key] = fieldValue(value);
      }
    } else {
      rendered.push(format(arg));
    }
  }

  const extra = rendered.length ? " " + rendered.join(" ") : "";
  const line = JSON.stringify({
    ...fields,
    level,
    message: message + extra,
    timestamp: new Date().toISOString(),
  });

  if (target === "console") {
    if (level === "error") {
      console.error(line);
    } else {
      console.log(line);
    }

    return;
  }

  appendRotating(COMBINED_LOG, line + "\n");
  if (level === "error") {
    appendRotating(ERROR_LOG, line + "\n");
  }

  if (level === "error") {
    console.error(message, ...args);
  } else {
    console.log(message, ...args);
  }
}

// Once, at load, and through the same path as every other line so it lands
// wherever this process's lines land. It is deliberately not thrown: a
// misconfigured log level must not be what stops the site from booting.
if (invalidLevel !== undefined) {
  log(
    "warn",
    `LOG_LEVEL="${invalidLevel}" is not one of error, warn, info — using "info".`,
  );
}

export const logger = {
  info: (message: string, ...args: unknown[]) => log("info", message, ...args),
  warn: (message: string, ...args: unknown[]) => log("warn", message, ...args),
  error: (message: string, ...args: unknown[]) =>
    log("error", message, ...args),
};

export default logger;
