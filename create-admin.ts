import { createInterface } from "readline/promises";
import db from "./db.ts";
import User from "./models/user.ts";

/**
 * Creates an admin account, or makes an existing account an admin.
 *
 * This is the piece the setup had no answer for. Accounts are seeded by hand
 * — there is no sign-up route, deliberately — but the only seeding code was
 * User.create, which cannot write "role" at all, so a fresh install ended up
 * with an admin interface nothing could reach: both game forms, both news
 * forms and comment moderation all sit behind isAdmin, and isAdmin asks the
 * database for a role of 'ADMIN' that nothing was able to set. The way in was
 * an UPDATE written by hand — after calling hashPassword from a REPL, because
 * verifyPassword will not accept a plaintext column value.
 *
 * Idempotent, so it is safe to re-run and doubles as the password reset: see
 * User.upsertAdmin.
 *
 *   npm run create-admin -- me@example.com     # prompts for the password
 *
 * The password is taken from ADMIN_PASSWORD or, if unset, a prompt, and never
 * from argv. Prompt input stays out of shell history, but is echoed in the
 * terminal. For automation, inject ADMIN_PASSWORD through trusted secret
 * configuration: typing a literal assignment in a shell command puts the
 * password in history. Processes permitted to inspect the environment can
 * still read it. The email may come from argv because it is not a secret.
 */

/** Long enough to be worth the scrypt cost in utils/password.ts. */
const MIN_PASSWORD_LENGTH = 12;

const USAGE = `Usage:
  npm run create-admin -- <email>
  ADMIN_EMAIL=<email> npm run create-admin

With ADMIN_PASSWORD unset, a TTY prompt reads the password and echoes it.
For automation, inject ADMIN_PASSWORD through trusted secret configuration.
Typing a literal password assignment in a shell command stores it in history.
The script never reads a password from argv.`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

/**
 * Asks for the password when the environment does not carry one.
 *
 * It echoes, so use a private terminal that is not being recorded. Prompt
 * input stays out of argv and shell history. For automation or a recorded
 * terminal, inject ADMIN_PASSWORD through trusted secret configuration;
 * typing a literal assignment in a shell command would put it in history.
 */
async function promptForPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    fail("No ADMIN_PASSWORD set and nothing to prompt on.");
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log("Note: what you type here will be visible.");

    return await rl.question("Password: ");
  } finally {
    rl.close();
  }
}

const email = (process.argv[2] ?? process.env.ADMIN_EMAIL ?? "").trim();

if (!email) {
  fail("No email given.");
}

// Not a full address grammar — nothing here needs one. It catches the two
// mistakes that actually happen: a flag mistaken for an address, and an
// argument left off so a password ends up here.
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  fail(`"${email}" does not look like an email address.`);
}

const password = process.env.ADMIN_PASSWORD ?? (await promptForPassword());

if (password.length < MIN_PASSWORD_LENGTH) {
  fail(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
}

try {
  const { id, created } = await User.upsertAdmin({ email, password });

  console.log(
    created
      ? `Created admin ${email} (id ${id}).`
      : // Said, because it is not obvious from "reset": every session the
        // account had is ended with it (see User.upsertAdmin), the operator's
        // own included, so a browser still logged in will have to log in again.
        `${email} (id ${id}) is now an admin, with the password just given. ` +
          "Every session it had has been signed out.",
  );
} catch (error) {
  console.error("Could not create the admin account:", error);
  process.exitCode = 1;
} finally {
  // Otherwise the idle pool holds the event loop open until its timeout.
  await db.end();
}
