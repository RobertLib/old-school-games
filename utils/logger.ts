import fs from "fs";

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
 * already exists to avoid.
 */
function appendRotating(file: string, line: string): void {
  const bytes = Buffer.byteLength(line);

  try {
    let size = written.get(file);

    if (size === undefined) {
      size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    }

    if (size + bytes > MAX_LOG_BYTES) {
      // Rename rather than truncate: a truncate would drop the lines while
      // the previous session's context is often the interesting part.
      fs.renameSync(file, `${file}.1`);
      size = 0;
    }

    written.set(file, size + bytes);
  } catch {
    // The rollover failed — a permissions problem, a file that vanished. The
    // line is still worth writing, and the next call will try again.
  }

  fs.appendFile(file, line, () => {});
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

  appendRotating("combined.log", line + "\n");
  if (level === "error") {
    appendRotating("error.log", line + "\n");
  }

  if (level === "error") {
    console.error(message, ...args);
  } else {
    console.log(message, ...args);
  }
}

export const logger = {
  info: (message: string, ...args: unknown[]) => log("info", message, ...args),
  warn: (message: string, ...args: unknown[]) => log("warn", message, ...args),
  error: (message: string, ...args: unknown[]) =>
    log("error", message, ...args),
};

export default logger;
