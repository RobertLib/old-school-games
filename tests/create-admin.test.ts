import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import User from "../models/user";

/**
 * The seeding script, driven the way tests/migrate.test.ts drives the
 * migration one: by importing it with its collaborators mocked, because both
 * do their work at module scope.
 *
 * Worth testing rather than eyeballing, because this is run by hand against a
 * production database and every refusal in it ends in process.exit — a path
 * that cannot be checked by reading the happy case.
 */
vi.mock("../models/user", () => ({
  default: { upsertAdmin: vi.fn() },
}));

vi.mock("../db", () => ({
  default: { end: vi.fn() },
}));

const mockUser = vi.mocked(User);

/**
 * Stands in for process.exit, which would otherwise take the worker down.
 *
 * A plain field rather than a parameter property: node strips types at
 * runtime instead of compiling them, so the sources have to be erasable and
 * `constructor(readonly code)` is not (tsconfig's erasableSyntaxOnly).
 */
class Exited extends Error {
  code: number | undefined;

  constructor(code: number | undefined) {
    super(`exit ${code}`);
    this.code = code;
  }
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

/**
 * Imports the script and reports how it ended, so a test can assert on a
 * refusal without the refusal ending the run.
 */
async function run(): Promise<{ exitCode: number | undefined }> {
  try {
    await import("../create-admin");
  } catch (error) {
    if (error instanceof Exited) return { exitCode: error.code };
    throw error;
  }

  // process.exitCode is widened to allow a string or null; the script only
  // ever sets a number or leaves it alone.
  return { exitCode: process.exitCode as number | undefined };
}

describe("create-admin", () => {
  const argv = process.argv;
  const env = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    process.argv = ["node", "create-admin.ts"];
    process.env = { ...env };
    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD;
    process.exitCode = undefined;

    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Exited(code);
    }) as never);
  });

  afterEach(() => {
    process.argv = argv;
    process.env = env;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("creates the account from the environment", async () => {
    mockUser.upsertAdmin.mockResolvedValue({ id: 4, created: true });
    process.env.ADMIN_EMAIL = "admin@example.com";
    process.env.ADMIN_PASSWORD = "a-long-enough-password";

    await run();

    expect(mockUser.upsertAdmin).toHaveBeenCalledWith({
      email: "admin@example.com",
      password: "a-long-enough-password",
    });
    expect(logSpy).toHaveBeenCalledWith("Created admin admin@example.com (id 4).");
  });

  it("takes the email from the command line, where it is not a secret", async () => {
    mockUser.upsertAdmin.mockResolvedValue({ id: 4, created: true });
    process.argv = ["node", "create-admin.ts", "  argv@example.com  "];
    process.env.ADMIN_EMAIL = "env@example.com";
    process.env.ADMIN_PASSWORD = "a-long-enough-password";

    await run();

    // Trimmed, and argv wins over the environment.
    expect(mockUser.upsertAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ email: "argv@example.com" }),
    );
  });

  it("says when it promoted an account rather than creating one", async () => {
    mockUser.upsertAdmin.mockResolvedValue({ id: 4, created: false });
    process.env.ADMIN_EMAIL = "admin@example.com";
    process.env.ADMIN_PASSWORD = "a-long-enough-password";

    await run();

    expect(logSpy).toHaveBeenCalledWith(
      "admin@example.com (id 4) is now an admin, with the password just given.",
    );
  });

  it("refuses with no email at all", async () => {
    const { exitCode } = await run();

    expect(exitCode).toBe(1);
    expect(mockUser.upsertAdmin).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls[0]![0]).toContain("No email given");
  });

  it("refuses something that is not an email", async () => {
    process.env.ADMIN_EMAIL = "--force";
    process.env.ADMIN_PASSWORD = "a-long-enough-password";

    const { exitCode } = await run();

    expect(exitCode).toBe(1);
    expect(mockUser.upsertAdmin).not.toHaveBeenCalled();
  });

  it("refuses a password too short to be worth the hash", async () => {
    process.env.ADMIN_EMAIL = "admin@example.com";
    process.env.ADMIN_PASSWORD = "short";

    const { exitCode } = await run();

    expect(exitCode).toBe(1);
    expect(mockUser.upsertAdmin).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls[0]![0]).toContain("at least 12 characters");
  });

  it("refuses rather than hanging when there is nothing to prompt on", async () => {
    // What `fly ssh console -C "…"` looks like: no ADMIN_PASSWORD and no TTY.
    // The README documents an interactive shell for this reason.
    process.env.ADMIN_EMAIL = "admin@example.com";
    const isTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });

    try {
      const { exitCode } = await run();

      expect(exitCode).toBe(1);
      expect(errorSpy.mock.calls[0]![0]).toContain("nothing to prompt on");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: isTTY,
        configurable: true,
      });
    }
  });

  it("reports a failed write without pretending it worked", async () => {
    mockUser.upsertAdmin.mockRejectedValue(new Error("connection refused"));
    process.env.ADMIN_EMAIL = "admin@example.com";
    process.env.ADMIN_PASSWORD = "a-long-enough-password";

    const { exitCode } = await run();

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "Could not create the admin account:",
      expect.any(Error),
    );
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Created admin"),
    );
  });
});
