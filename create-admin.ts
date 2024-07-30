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
 *   ADMIN_EMAIL=me@example.com ADMIN_PASSWORD=... npm run create-admin
 *   npm run create-admin -- me@example.com     # prompts for the password
 *
 * The password is taken from the environment or a prompt and never from argv,
 * which every other process on the machine can read out of `ps` and which the
 * shell writes into its history. The email may come from argv because it is
 * not a secret.
 */

/** Long enough to be worth the scrypt cost in utils/password.ts. */
const MIN_PASSWORD_LENGTH = 12;

const USAGE = `Usage:
  ADMIN_EMAIL=<email> ADMIN_PASSWORD=<password> npm run create-admin
  npm run create-admin -- <email>

The password is read from ADMIN_PASSWORD, or prompted for if that is unset.
It is never taken from the command line, where other processes can read it.`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

/**
 * Asks for the password when the environment does not carry one.
 *
 * It echoes. There is no way to stop that from node without reaching into
 * readline's internals, so anyone typing a password in front of somebody else
 * — or into a terminal that is being recorded — should pass ADMIN_PASSWORD
 * instead. Both routes keep it out of argv and out of shell history.
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
