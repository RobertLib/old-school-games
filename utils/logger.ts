import fs from "fs";

type LogLevel = "info" | "warn" | "error";

function log(level: LogLevel, message: string, ...args: unknown[]): void {
  const extra = args.length
    ? " " +
      args
        .map((a) =>
          a instanceof Error ? (a.stack ?? a.message) : JSON.stringify(a),
        )
        .join(" ")
    : "";
  const line = JSON.stringify({
    level,
    message: message + extra,
    timestamp: new Date().toISOString(),
  });

  fs.appendFile("combined.log", line + "\n", () => {});
  if (level === "error") {
    fs.appendFile("error.log", line + "\n", () => {});
  }

  if (process.env.NODE_ENV !== "production") {
    if (level === "error") {
      console.error(message, ...args);
    } else {
      console.log(message, ...args);
    }
  }
}

export const logger = {
  info: (message: string, ...args: unknown[]) => log("info", message, ...args),
  warn: (message: string, ...args: unknown[]) => log("warn", message, ...args),
  error: (message: string, ...args: unknown[]) =>
    log("error", message, ...args),
};

export default logger;
