# 🕹️ Old School Games

A web application for browsing and playing classic MS-DOS games directly in your browser. The project offers a nostalgic experience with games from the MS-DOS era combined with a modern user interface.

## 🎮 Features

- **Game Catalog**: Browse through an extensive database of classic MS-DOS games
- **Browser Gaming**: Play games directly in your browser without any installation
- **Filtering & Search**:
  - Filter by genre, release year, developer, publisher
  - Alphabetical filtering by first letter
  - Text search across titles, developers and publishers
- **Game Rating**: User rating system for games
- **Game of the Week**: Automatically selected weekly featured game
- **Curated Lists**: Predefined thematic game lists (top games, genres, eras, etc.)
- **News**: News section with admin-managed articles
- **Favorite Games**: Save favorite games in localStorage
- **Recently Played**: History of recently played games
- **Comments**: Comment system for individual games
- **Administration**: Admin interface for managing games, news, and content
- **Responsive Design**: Fully responsive web interface
- **Theme Switcher**: Three palettes, chosen in the page chrome and applied before first paint
- **Feeds**: RSS and Atom for the news section
- **/random**: Sends you to a game you have not chosen
- **/most-played**: The catalogue ordered by what people actually start
- **Sitemap**: Automatic sitemap generation for SEO
- **Stable addresses**: A renamed game or article keeps its old URL working — the slug history answers with a 301 to the current one
- **Structured data**: JSON-LD for the organisation, the breadcrumbs, the games and the articles, so a search result can be more than a blue link
- **/healthz**: A liveness endpoint the platform checks, answered above the session and the rate limiter

## 🛠️ Technologies

- **Backend**: Node.js 24 LTS (native TypeScript support), Express 5
- **Database**: PostgreSQL
- **Frontend**: EJS templates, vanilla JavaScript
- **Styling**: Custom CSS
- **Testing**: Vitest
- **Deployment**: Fly.io (Docker)
- **Session management**: express-session with PostgreSQL store
- **Security**: Helmet (CSP with a per-response nonce), rate limiting, CSRF protection, DOMPurify + jsdom for author-supplied markup
- **Performance**: `compression` (gzip/brotli), content-hashed asset URLs, TTL caches dropped through a shared cache epoch

## 📁 Project Structure

```
├── index.ts              # Entry point: listens on a port, handles signals
├── app.ts                # The application: middleware, routes, error handling
├── db.ts                 # Database connection
├── migrate.ts            # Migration script (a deploy's release command)
├── create-admin.ts       # Seeds or promotes an admin account
├── models/               # Database models
│   ├── model.ts         # Base model class
│   ├── game.ts          # Game model
│   ├── user.ts          # User model
│   ├── comment.ts       # Comment model
│   ├── game-of-the-week.ts # Game of the week model
│   └── news.ts          # News model
├── routes/               # Express routes
│   ├── auth.ts          # Authentication
│   ├── games.ts         # Game management
│   ├── home.ts          # Home page
│   ├── comments.ts      # Comments
│   ├── csp-report.ts    # Where browsers send Content-Security-Policy violation reports
│   ├── lists.ts         # Curated game lists
│   ├── news.ts          # News
│   ├── feed.ts          # RSS feeds
│   └── sitemap.ts       # Sitemap
├── utils/                # Utility functions
│   ├── assets.ts        # Content-hashed asset URLs
│   ├── breadcrumbs.ts   # Breadcrumb trails and their JSON-LD
│   ├── cache.ts         # TTL cache for the lists every page renders
│   ├── cache-epoch.ts   # Shared counter that drops every machine's caches after a write
│   ├── cookies.ts       # Single-cookie reader
│   ├── csp-report.ts    # CSP violation reports reduced to one log line each
│   ├── device-cookie.ts # The login's device cookie: a browser that has signed in before
│   ├── expects-json.ts  # Which endpoints get a JSON error rather than a page
│   ├── faq.ts           # FAQ entries and their JSON-LD
│   ├── html-text.ts     # Stored description HTML flattened to plain text
│   ├── ids.ts           # Strict integer id parsing
│   ├── indexability.ts  # Which pages carry noindex and no canonical
│   ├── letter-buckets.ts # The A–Z (and 0–9) browse: which letter page a game is on
│   ├── logger.ts        # Logger
│   ├── migrations.ts    # The migration runner, shared by migrate.ts and the suite
│   ├── organization.ts  # The site's Organization JSON-LD
│   ├── page-cache.ts    # Caches for the sitemap, the feeds and /most-played
│   ├── pagination.ts    # ?page= parsing
│   ├── password.ts      # Password hashing, capped per process
│   ├── pg-errors.ts     # Postgres error codes the routes tell a 404 apart by
│   ├── query.ts         # Query-string helpers
│   ├── rate-limit-store.ts # Rate-limit counters, shared across machines
│   ├── reserved-slugs.ts # Addresses a generated game slug must not take
│   ├── sanitize-html.ts # The one DOMPurify author-supplied markup goes through
│   ├── session-cookie.ts # The session cookie's name and attributes, and ending a session
│   ├── session-credential.ts # The password fingerprint a session is checked against
│   ├── session-secret.ts # SESSION_SECRET and the keys derived from it
│   ├── session-store.ts # The session store: a save never re-creates an ended session
│   ├── sidebar-cache.ts # The cache the page chrome shares with the models
│   ├── site.ts          # The site's own host and origin, the media origin and the optional player origin
│   ├── shutdown.ts      # The drain: SIGTERM/SIGINT, uncaught errors, the exit status
│   ├── slug.ts          # A title turned into an address, shared by games and news
│   └── xml.ts           # Escaping and character stripping for the feeds and sitemap
├── middlewares/          # Express middlewares
│   ├── csrf.ts          # Double-submit CSRF tokens
│   ├── csp-nonce.ts     # Per-response nonce for inline scripts
│   ├── flash.ts         # One-shot messages across a redirect
│   ├── is-admin.ts      # Admin guard
│   ├── is-auth.ts       # Session guard
│   ├── sidebar-data.ts  # Cached page chrome
│   └── voter-id.ts      # Anonymous per-browser rating id
├── content/              # Editorial copy
│   └── blurbs.ts        # Genre, studio and year blurbs for the filter pages
├── types/                # TypeScript type definitions
│   └── session.ts       # Session types
├── views/                # EJS templates
├── public/               # Static files, served from the site root
│   ├── css/, fonts/, images/, js/  # Assets, addressed through asset() with a content hash
│   ├── favicon.png      # The browser tab icon, named from views/head.ejs
│   ├── site.webmanifest # Name, icons and display mode for an installed copy
│   └── js-dos.html      # The DOS player frame: one pinned, hash-checked js-dos release
├── validations/          # Validation logic
├── migrations/           # SQL migrations (NNNN_what_it_does.sql, forward-only)
├── tests/               # Tests
├── vitest.config.ts      # The unit/integration split and the coverage floors
├── tsconfig.json         # Type-checking the sources (nothing is compiled)
├── tsconfig.tests.json   # The same for the suite
├── eslint.config.js      # Lint rules
├── Dockerfile            # The production image
├── fly.toml              # The Fly.io deployment: env, health check, concurrency
└── .github/workflows/    # CI: lint, typecheck, coverage, image build, deploy
```

## 🚀 Installation & Setup

### Prerequisites

- Node.js 24 — the version in `.nvmrc`, so `nvm use` picks it up, and the
  one CI, the Dockerfile and Fly all run (`node-version-file: .nvmrc`,
  `NODE_VERSION=24`). `package.json` says `^24` to match, and `.npmrc` sets
  `engine-strict=true`, so `npm install` on another major **fails** rather
  than warning and installing anyway — run `nvm use` first. The floor the code
  itself imposes is lower — 22.18, the first release that strips type
  annotations, which is what `node index.ts` relies on — but 24 is the only
  version anything here is tested against; move all four together.
- PostgreSQL
- npm (the lockfile is npm's, and CI runs `npm ci`)

### Local Development

1. **Clone the repository**

   ```bash
   git clone <repository-url>
   cd old-school-games
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Create your `.env`**

   ```bash
   cp .env.example .env
   ```

   `.env.example` lists every variable the code reads, each with what it is
   for and what happens if it is wrong. Fill in `DATABASE_URL` and
   `SESSION_SECRET`; the rest have working defaults.

   Nothing loads this file at import time — `npm run dev`, `npm start`,
   `npm run migrate` and `npm run create-admin` all pass
   `--env-file-if-exists=.env` to Node, which is the runtime's own loader and
   is happy for the file to be absent. On Fly there is no `.env` at all: the
   values arrive as secrets in the process environment, and
   `--env-file-if-exists` is what makes the same command work in both places.

4. **Database setup**
   - Create a PostgreSQL database
   - Point `DATABASE_URL` at it, in `.env` or in the environment

   ```bash
   DATABASE_URL="postgresql://username:password@localhost:5432/old_school_games"
   ```

   If that is a Supabase pooler URL, it must be the **session-mode** one
   (port 5432), not transaction mode (port 6543). The app sets a
   per-connection `statement_timeout` at connect time and the migration
   runner holds a session-level advisory lock; a pgbouncer-style
   transaction-mode pooler accepts neither.

5. **Run migrations**

   ```bash
   npm run migrate
   ```

   Migrations are applied once each, in filename order, and their contents are
   hashed into the `migrations` table. Editing a migration that has already
   run makes the next run stop rather than let the schema drift apart between
   environments — put the change in a new file instead. Each file runs in a
   transaction of its own, unless it builds an index concurrently — see
   [Migrations outside a transaction](#migrations-outside-a-transaction).

6. **Create an admin account**

   ```bash
   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long random password' npm run create-admin
   ```

   There is no sign-up route by design, so this is how the admin interface —
   the game and news forms, and comment moderation — becomes reachable at all.
   Without it a fresh install has no account with the `ADMIN` role and every
   one of those pages answers 403.

   The password is read from `ADMIN_PASSWORD`, or prompted for if that is
   unset; it is never taken from the command line, where other processes can
   read it out of `ps` and the shell writes it into its history. The email may
   be passed as an argument (`npm run create-admin -- you@example.com`).

   Safe to re-run: it makes an existing account an admin and sets its
   password, so it doubles as the password reset. A reset also signs out every
   session that account had, yours included — a session opened with a leaked
   password must not outlive the reset meant to lock it out. That holds even
   for a session with a request in flight at that moment: see
   [Sessions and rate limits](#sessions-and-rate-limits).

7. **Start the application**

   ```bash
   # Development mode with hot reload
   npm run dev

   # The same without the file watcher
   npm start
   ```

   `npm start` is `node index.ts` with `.env` loaded, and nothing more: the
   mode it runs in is whatever `NODE_ENV` says, and the `.env.example` you
   copied says `development`. It used to be described here as production mode,
   which it is not — production never starts through npm at all. The image
   runs `node index.ts` directly, under the `NODE_ENV=production` that the
   Dockerfile and `fly.toml` set.

The application will run on `http://localhost:3000`

## 📝 NPM Scripts

- `npm run dev` - Start in development mode, restarting on change (`node --watch`), loading `.env` if there is one
- `npm start` - Start once, without the file watcher, loading `.env` if there is one. The mode is whatever `NODE_ENV` says — `development` in `.env.example` — not production; see step 7 above
- `npm test` - Run tests
- `npm run typecheck` - Type-check the sources and the suite (nothing is compiled at runtime, so this is the only thing that catches type errors)
- `npm run lint` - Lint the sources
- `npm run lint:fix` - Lint and apply the fixes it can make itself
- `npm run test:watch` - Run tests in watch mode
- `npm run test:coverage` - Run tests with coverage report, held to the floors in `vitest.config.ts`
- `npm run migrate` - Apply pending migrations: `migrate.ts`, the same script a deploy runs as its release command, against whatever database `.env` names
- `npm run create-admin` - Create an admin account, or make an existing one an admin (see step 6 above)
- `npm run format:ejs` - Format EJS templates. It calls `npx js-beautify`, and `npx` runs the copy in `node_modules` that the lockfile pinned — it only reaches the registry for a package that is not installed, and `js-beautify` is a devDependency precisely so that it never does.

CI runs `lint`, `typecheck`, `test:coverage` and `npm audit --omit=dev
--audit-level=high` on every push to `main` and on every pull request (that
is what the workflow's `on:` triggers say — a push to another branch with no
pull request open runs nothing), builds the Docker image in a job of its own,
and only deploys from `main`, and only if all of it passes. It is
`test:coverage` rather than `test` on purpose: the coverage thresholds are
only evaluated when coverage is collected, so run as plain `test` they would
never fail a build.

The image is built because it is what production actually runs — a Dockerfile
that no longer builds used to be found by `flyctl deploy` failing on main,
after the tests had gone green — and then it is *started*, with no database
behind it, and polled for `/healthz` for up to thirty seconds. A build only
proves the image can be assembled; the two failures it cannot see are a
container that exits on boot and one that boots but never answers. That check
needs no Postgres because `/healthz` reports the database rather than letting
it decide the answer: `{"status":"ok","database":"down"}` with a 200 is the
correct response to an unreachable one, for the reasons given next to the
route in `app.ts`. The container's logs are printed either way.

Test runs are grouped per ref and cancelled when a new commit arrives
(`concurrency: test-<ref>`), so three pushes in a minute no longer hold three
runners and three Postgres service containers. The deploy job keeps its own
group and is deliberately *not* cancelled part-way through.

Dependency updates come in weekly as pull requests (`.github/dependabot.yml`,
covering npm and GitHub Actions); they go through the same checks as anything
else, and nothing merges itself. The Docker base image is not on that list,
though it used to appear to be: Dependabot only reads a `FROM` line with a
literal tag or digest, and this Dockerfile's tag comes from an `ARG` (one of
the four copies of the Node version), so the entry parsed nothing. The base
stays current by being a moving tag that every build resolves afresh — the
Dockerfile's header has the reasoning, and what it costs.

### A note on the TypeScript version

`typescript` is deliberately held below 6.1, as `">=6.0.3 <6.1.0"` rather
than a caret range. The ceiling is not TypeScript 7: `typescript-eslint`
declares `typescript: ">=4.8.4 <6.1.0"` as a peer dependency, so 6.1 is
already out of range — and above the range it refuses to load against the
compiler API
([typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)),
which means `npm run lint`, and therefore CI, fails outright. A caret range
would let a routine `npm install` walk into that; this one cannot. The
documented workaround is installing a second, older copy of the compiler side
by side, which is a lot of moving parts to buy nothing: nothing here needs a
newer compiler feature.

`.github/dependabot.yml` ignores `typescript` for both major *and* minor
updates for the same reason — 6.1 is a minor, so ignoring only majors let the
one breaking bump arrive grouped in with a week of harmless ones. Patches
still come through. Widen the range and the ignore together, once
typescript-eslint's peer range does.

### A note on the two pinned `@types` packages

`npm outdated` flags neither of these, and it is worth knowing why before
somebody "fixes" them:

- **`@types/ejs` 3.x for `ejs` 6.** 3.1.5 is the newest version published.
  `ejs` ships no types of its own and the `@types` package has not been
  renumbered alongside it, so the major numbers do not line up and are not
  meant to.
- **`@types/connect-pg-simple` 7.x for `connect-pg-simple` 10.** Same story:
  7.0.3 is the newest published, and the typings still describe the current
  API.

If either package ever does publish a matching major, Dependabot will raise
it.

## 🗄️ Database Models

### Games

- `title` - Game title
- `slug` - URL-friendly identifier
- `description` - Game description
- `genre` - Genre (enum)
- `release` - Release year
- `developer` - Developer
- `publisher` - Publisher
- `images` - Array of images
- `stream` - URL of the js-dos bundle (`.jsdos`) the player loads
- `manual` - Manual (.pdf)

### Users

- `email` - User email
- `password` - Hashed password
- `role` - Role (USER/ADMIN). There is no sign-up route; accounts are seeded
  with `npm run create-admin`, which is also the only thing that writes
  `ADMIN`

### Comments

- `nick` - Author nickname
- `content` - Comment content
- `gameId` - Reference to game

### Ratings

- `gameId` - Reference to game
- `voterId` - Anonymous per-browser id; one rating per browser per game
- `ipAddress` - Rater's IP address, recorded alongside but not used to deduplicate
- `rating` - Rating 1-5

### Game of the Week

- `gameId` - Reference to game
- `startDate` - When this pick starts being current (defaults to the insert)
- `endDate` - When it stops (defaults to seven days later)
- `createdAt` - Date of selection
- `updatedAt` - Date of last update

`startDate` and `endDate` are what decides which pick is showing: the widget
reads the one row where `NOW()` falls between them. A request arriving in the
gap after a week expires selects the next pick under an advisory lock, so a
busy moment produces one pick rather than one per request.

### Plays

- `gameId` - Reference to game
- `createdAt` - Date of play

Records older than a year are pruned automatically: the table is one row per
game started and `findMostPlayed` aggregates all of it, so nothing used to
stop it growing. The sweep runs on boot and daily thereafter — on boot too,
because machines are stopped when idle and a daily timer would rarely live
long enough to fire.

### Rate limits

- `key` - The limiter's own prefix plus the client address
- `hits` - Requests counted in the current window
- `expiresAt` - When that window ends

Rate limits are counted here rather than in each process's memory, so a budget
belongs to the app rather than to each machine. If the database is unreachable
the limiters let requests through — a blip should cost the site its rate
limiting, not its availability.

`key` is the limiter's own prefix plus whatever that limiter counts by. For
every limiter but one that is the client's IP address, which makes this table
personal data — the address recorded with a rating declares itself in the
privacy policy and has a 90-day retention, and this one used to hold an
address without saying so anywhere. The exception is the login *account*
limiter in `routes/auth.ts`: its key is a SHA-256 hash of the submitted
e-mail address, so that rotating IP addresses cannot buy fresh guesses at one
account. A hash is not an address, but it is still derived from one person's
identifier, so it is listed here rather than treated as anonymous. The login
*device* limiter is the other: its key is a SHA-256 hash of the random nonce
in an administrator's `osg_device` cookie (see below), and it holds nothing
else. The login limiters group an IPv6 address by its /48 rather than the
library's default /56, which left 256 separate budgets inside one customer's
allocation.

Rows are short-lived, and how short depends on the limiter.
`startRateLimitPruning` sweeps expired rows every 10 minutes, so a row lives
at most its window plus 10:

- 15 minutes or less — the per-IP login limiter and the rating, play and
  comment limiters — so 25 minutes is the worst case for an address alone;
- 60 minutes for the account limiter and the account+address limiter, so
  about 70;
- a day for the per-game play and vote counters (`rate-game`, `play-game`:
  an address plus a game id), which is what stops one address running up a
  game's play count or its votes — so 24 hours and 10 minutes.

The global limiter in `app.ts` and the CSP-report limiter keep their counts in
the process's memory and write nothing here. Section 2f of
`views/privacy-policy.ejs` states each of these, and
`tests/views/privacy-policy.test.ts` asserts the claims against the stores'
own keys so the two cannot drift. The device limiter's window is also 60
minutes; section 2e states it beside the cookie it is keyed by.

That account limiter is a backstop, two hundred failures an hour against one
account from anywhere, and on its own it was a cheap lockout: twenty addresses
could close the admin's account for the hour in seconds. A successful login
therefore hands the browser an `osg_device` cookie (`utils/device-cookie.ts`,
the OWASP "device cookie"): signed with a key derived from `SESSION_SECRET`,
bound to the account, scoped to `/login`, kept for a year from the last login
and left in place by a logout. An attempt that presents a valid one for the
account it names skips the backstop and is counted against its own device's
budget instead (ten failures an hour); the per-address limits apply to it as
to anyone. Rotating `SESSION_SECRET` retires every device cookie along with
every session.

### News

- `title` - Article title
- `content` - Article content (HTML)
- `userId` - Reference to author

## 🔧 Configuration

The application uses the following environment variables. Locally they come
from `.env` (copy `.env.example`, which documents every one of them); on Fly
they are secrets in the process environment and there is no file.

- `DATABASE_URL` - PostgreSQL connection string
- `SESSION_SECRET` - Secret key for sessions
- `NODE_ENV` - Application environment (development/production)
- `PORT` - Port the server listens on (default: `3000`)
- `LOG_LEVEL` - The quietest level still written: `error`, `warn` or `info` (default: `info`, i.e. everything). It decides *what* is written, not where — that is `NODE_ENV`'s job. Worth setting to `warn` on a busy deployment, because the access log writes an `info` line per request and an incident's error lines are otherwise buried in them. An unrecognised value warns once and falls back to `info` rather than being read as "off": a typo would otherwise silence the log, and missing lines are the last thing anybody connects to a misspelled variable
- `CANONICAL_HOST` - The site's own host: what production requests are redirected to, and what every canonical tag, feed link and sitemap entry is built from (default: `oldschoolgames.eu`). The player carries it too, as `SITE_ORIGIN` in `public/js/js-dos-player.js` — the page it trusts and the site whose games it will load once it has an origin of its own — so change the two together; `tests/public-assets.test.ts` checks they agree
- `MEDIA_ORIGIN` - Origin serving game artwork and the js-dos bundles (default: the current storage bucket). It is named in the `Content-Security-Policy`, so a deployment pointing at its own bucket must set this — get it wrong and the browser refuses every image and bundle, which is reported nowhere but its console. **Set it in two places:** the player also refuses a game bundle from anywhere but this origin, and `public/js/js-dos-player.js` is a static file that cannot read an environment variable, so it carries its own `MEDIA_ORIGIN` constant. `tests/public-assets.test.ts` asserts that constant matches the default here, the same way it keeps the js-dos release in step across two files
- `PLAYER_ORIGIN` - Origin the DOS player is served from, when it is not this site (default: unset, which keeps the player at `/js-dos.html` on this origin exactly as it has always been). Setting it is what makes the player's sandbox a real boundary; see *The player origin* below for why, how to roll it out, and what it costs — saved games move with it. A bare `https://` origin in production, and never `CANONICAL_HOST` itself: the app refuses to boot on either mistake rather than guess
- `TEST_DATABASE_URL` - Database the test suite runs against (default: `postgresql:///old_school_games_test`, which leaves host, user and password to libpq's defaults and the standard `PG*` variables)
- `ADMIN_EMAIL`, `ADMIN_PASSWORD` - Read by `npm run create-admin` only, never by the app itself. Not something to leave in `.env` on a server: the account exists in the database once the script has run

### The player origin

The game player (`public/js-dos.html`) is the one document here that runs
third-party code, with `'unsafe-eval'` in its policy. By default it is framed
from this site's own origin, and there its `sandbox` is **not an isolation
boundary**. The frame needs both `allow-scripts` and `allow-same-origin`, and
on a same-origin frame the HTML standard warns that the pair lets it remove
its own sandbox and reload itself; it need not bother, because it can reach
`parent.document` directly — the page's forms, its CSRF token, its nonce. A
foothold in the emulator (a js-dos bug, or a tampered `emulators.js` or
`wdosbox.js`, which js-dos loads from jsDelivr with no integrity check) runs as
this site, an admin's session included.

`PLAYER_ORIGIN` serves the player from an origin of its own, where the same
frame cannot reach the site at all. With it set:

- game pages frame `<PLAYER_ORIGIN>/js-dos.html`, and their `frame-src` names
  that origin and nothing else;
- that host answers for the player's own files (`PLAYER_PATHS` in
  `utils/site.ts`) and its CSP reports, and with a bare 404 for everything
  else, so it never becomes a mirror of the site; the canonical-host redirect
  leaves it alone;
- the player's policy lets only `https://<CANONICAL_HOST>` frame it, so a
  development server on localhost cannot;
- this origin still serves `/js-dos.html`, but under the site's own policy,
  where the emulator cannot start;
- a game stored as a path on this site reaches the player as an address on
  this site, and the site's static files allow the player origin to fetch it.

**Rolling it out.**

1. Choose the hostname.
   - **The app's own `fly.dev` address**, `https://old-school-games.fly.dev`:
     no DNS, and Fly already holds its certificate. `fly.dev` is on the Public
     Suffix List, so the player is a different *site*, not only a different
     origin — the stronger separation. Anything that reached the site through
     that address used to be redirected to `oldschoolgames.eu`; it now gets a
     404.
   - **A subdomain**, e.g. `play.oldschoolgames.eu`: point it at the app (a
     `CNAME` to `old-school-games.fly.dev`, or `A`/`AAAA` records from
     `fly ips list`), attach it, and wait until Fly reports the certificate
     issued:

     ```bash
     fly certs add play.oldschoolgames.eu
     fly certs check play.oldschoolgames.eu
     ```

     A subdomain is the same *site* as `oldschoolgames.eu`. It still cannot
     read the site's pages or cookies, but code running there could *set*
     cookies for the whole domain: the CSRF secret is immune to that (its
     `__Host-` prefix), the session cookie `connect.sid` is not.
2. Set it beside `CANONICAL_HOST` and `MEDIA_ORIGIN` in the `[env]` block of
   `fly.toml` — for example `PLAYER_ORIGIN = "https://old-school-games.fly.dev"`
   — and deploy. No static file needs editing: the player takes the site's
   origin from `SITE_ORIGIN` in `public/js/js-dos-player.js`, which the suite
   already holds to `CANONICAL_HOST`. For the few minutes of the rolling
   restart, machines on either side of the change disagree about the player
   host, so a game started then may not load; a reload fixes it.
3. Check it: open a game and see that the frame's address is on the player
   origin, and from a shell:

   ```bash
   curl -sI https://old-school-games.fly.dev/js-dos.html   # frame-ancestors https://oldschoolgames.eu
   curl -sI https://old-school-games.fly.dev/about         # 404
   ```

**What it costs.** js-dos keeps saved games in the browser's storage, and
storage belongs to an origin — so moving the player moves the saves. Games
saved before the switch stay in each visitor's browser under
`oldschoolgames.eu`, where the player no longer looks; unsetting
`PLAYER_ORIGIN` brings them back, and hides the ones made on the player origin
in turn. The CRT setting resets the same way. On the `fly.dev` address the
frame is also cross-site, so browsers keep its storage partitioned under the
site framing it (harmless, since only this site does) and a browser set to
block third-party cookies may refuse it storage outright — the player then
starts with saving switched off rather than failing (`STORAGE_AVAILABLE` in
`public/js/js-dos-player.js`). A subdomain avoids both.

**Unset changes nothing.** Every deployment without it serves the player
exactly as before; the setting is opt-in because the hostname and the saved
games are the owner's call.

### A note on analytics and cookie consent

This site loads Google Analytics 4 on every page view and shows **no consent
banner**, so the GA cookies are set before the visitor is asked. That is a
deliberate decision, written down here and in `views/head.ejs` so that it is not
rediscovered as a bug on every review.

The position, plainly: analytics cookies are not strictly necessary, so the
ePrivacy Directive wants consent *before* they are set, and the Czech
implementation (Act No. 127/2005 Sb.) has been opt-in since 2022. This site does
not ask. Both ways of closing that were considered and declined:

- **A consent banner.** The operator does not want one on the site.
- **Cookieless GA.** Adding `analytics_storage: "denied"` to the
  `gtag("consent", "default", ...)` call in `views/head.ejs` stops GA writing
  cookies at all, and removes the consent question along with them. It also
  removes the plain visitor count the tag exists for: GA falls back to cookieless
  pings and modelled reporting.

What stands instead is disclosure. `views/privacy-policy.ejs` names these
cookies, says outright that they are set without asking, and tells the reader how
to refuse them in the browser — the site behaves identically either way, and
nothing checks whether analytics loaded. The advertising signals (`ad_storage`,
`ad_user_data`, `ad_personalization`) are denied explicitly; nothing here
advertises.

This is an accepted risk, not a compliance claim. It is worth reopening if the
trade changes — if the site starts advertising, if it begins collecting anything
beyond page views, or if modelled numbers become good enough after all. Anyone
who needs the question settled rather than documented should take it to a lawyer;
the two bullets above are the levers.

### A note on AI crawlers

`robots.txt` carries one `User-agent: *` group, so GPTBot, ClaudeBot, CCBot,
Google-Extended, PerplexityBot and the rest are **allowed**, on the same terms as
any other crawler. Like the section above, that is a decision rather than an
oversight, and it is written down because the file itself gave no way to tell the
two apart.

It is the decision the rest of the site already implies. `utils/faq.ts` marks up
`/how-to-play` as an `FAQPage` while stating that Google stopped rendering those
in 2023, and keeps it because answer engines read it — a site that publishes
structured data for answer engines and then blocks the crawlers feeding them is
arguing with itself. The catalogue is also not the product: nobody plays a DOS
game by reading about it, so a model that has read these descriptions and names
the site is sending a visitor rather than replacing one.

To reverse it, edit `ROBOTS_TXT` in `routes/sitemap.ts`. One thing to know first,
because it is the trap this looks like it avoids: robots.txt matching is **not**
additive — a crawler obeys the single most specific group naming it and ignores
every other, `*` included. A group naming GPTBot with nothing but an `Allow`
would therefore exempt it from the exclusions the `*` group carries (`/random`,
the admin forms). Every named group has to repeat those lines, and
`tests/routes/sitemap.test.ts` fails the build if one does not.

Every exclusion ends in `$`. A `Disallow` rule is a prefix, so without the anchor
`Disallow: /news/new` also blocked every article whose slug starts with "new" and
`Disallow: /random` the game filed at `/random-2`; the suite reads the file the
way RFC 9309 describes and checks both halves.

Note also what the file can and cannot do: it governs crawling, not training, and
an agent that ignores it is not stopped by anything here.

## 🧪 Testing

The project includes a comprehensive test suite with:

- Unit tests for models
- Integration tests for API endpoints
- Middleware tests
- Validation tests

It is split into two vitest **projects** (see `vitest.config.ts`):

- **`unit`** — `tests/js/` (the client-side scripts, read from `public/js` and
  eval'd into a jsdom window) and the pure-function utilities. No setup file,
  no database, files run in parallel; the whole project finishes in a couple
  of seconds and works on a checkout with no Postgres at all:

  ```bash
  npx vitest run --project unit
  ```

- **`integration`** — everything else, with `tests/setup.ts` in front of it:
  it points `DATABASE_URL` at the test database, truncates every table and
  applies any pending migration before each file, and runs one file at a time
  for that reason.

Membership is decided by what a file reaches, not by where it lives —
`tests/utils/` is split across both — and the rule for a new file is: it goes
in `integration` unless it has been checked and found not to import `db.ts`,
directly or through a model, a route or `app.ts`. That rule is not left to
memory: `tests/unit-project-isolation.test.ts` imports the `unit` project's
own include list and walks what every file in it reaches, so a unit test that
picks up `db.ts` four modules away fails rather than quietly opening a pool
against whatever `DATABASE_URL` happens to say. `npm test` and
`npm run test:coverage` run both projects, and the coverage thresholds are
measured across them together.

```bash
# Run all tests
npm test

# Tests with coverage report
npm run test:coverage

# Watch mode for development
npm run test:watch
```

The suite needs a PostgreSQL to talk to. The schema is created and migrated
automatically on the first run, so a database is all it wants:

```bash
createdb old_school_games_test
npm test
```

That works because the default connection string names nothing but the
database — `postgresql:///old_school_games_test` — leaving the host, user and
password to libpq's own defaults (the local socket, as the current OS user)
and to the standard `PGHOST` / `PGUSER` / `PGPASSWORD` variables.

If your Postgres wants to be reached some other way, point
`TEST_DATABASE_URL` at it instead:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/old_school_games_test npm test
```

## 🚀 Deployment

**A push to `main` deploys.** There is nothing to run by hand.
`.github/workflows/fly-deploy.yml` lints, typechecks and runs the suite; builds
the Docker image; starts that image and waits for `/healthz` to answer; pushes
it to the Fly registry tagged with the commit; and then releases *that* image
with `flyctl deploy --image`.

The last part is the point. The deploy used to be a `flyctl deploy
--remote-only`, which rebuilds from source on Fly's own builder — so the image
CI had tested and the image production ran were two different builds of the
same tree, on a different builder with a different cache and a different
resolution of every unpinned base-layer package. Anything that differed between
them was tested nowhere. Releasing the tested image by tag closes that, and a
rollback names a release whose image still exists.

Migrations run before each release via the `release_command` in `fly.toml`; a
failing migration aborts the deploy. Fly gives that command fifteen minutes
(`release_command_timeout`) before killing it. Its own default is five, which
is exactly how long `migrate.ts` waits for another run's advisory lock, so a
release command that waited out another deploy used to be killed the moment
it got the lock. The deploy job's `timeout-minutes` is set to outlast those
fifteen and the rolling restart after them, because the runner timing out
would kill `flyctl` halfway through a deploy.

### Rolling back

```bash
fly releases --image      # each release, and the image it ran
fly deploy --image registry.fly.io/old-school-games:<sha of the last good commit>
```

A rollback is a deploy of an older image and nothing more: there is no
rollback command, and none is needed, because every image CI pushes is tagged
with its commit and never overwritten. It changes the image and nothing else —
it uses the `fly.toml` in the directory you run it from and the secrets as
they are now — so run it from a checkout of `main`, and if the bad release
also changed `fly.toml`, decide separately whether that change goes back too.

**The schema stays forward.** The release command runs on a rollback as on
any deploy — flyctl skips it only when given `--skip-release-command`, and
there is no reason to — so it is the *old* image's `migrate.ts` meeting a
database that has already applied the bad release's migrations. It recognises
that state: applied migrations newer than the newest file in the image mean
the database is ahead of the build. It says so in the release log, applies
nothing, undoes nothing, and succeeds — and each machine that then boots on
the old image logs the same thing once, as a warning, from the check at
startup. It used to refuse — "has been applied
but is no longer in …", exit 1 — so a release that added a migration could not
be rolled back at all. A file missing from *below* the newest one is still
refused: that is a migration deleted or renamed out from under a database that
ran it, not an older build.

**Why that is safe:** it is a state every deploy already passes through.
Expand, then contract (see
[Schema: forward-only migrations](#schema-forward-only-migrations)) exists so
that the release before a migration keeps working on the schema after it —
for the length of every rolling restart, the old code *is* serving against the
new schema. A rollback to the previous release is that same pairing, held for
longer. Two things follow from it:

- **One release back is what the rule covers.** Going further back can cross a
  contract step — an older release still selecting a column a later one
  dropped — so read the migrations in between before rolling back past the
  previous release.
- **The fix goes forward.** Leave the bad release's migration file where it
  is; its schema is in the database either way. Deleting the file makes the
  next forward deploy refuse (a missing file below newer ones), and deleting
  its row from `migrations` makes that deploy apply it a second time. Undo what
  it did with a new migration.

### Break glass: deploying by hand

```bash
fly deploy    # builds on Fly's remote builder from the working tree
```

Kept for the case where Actions itself is unavailable, or where you need to
release something the workflow will not build. **It is not the normal path and
it is not equivalent to one:**

- It ships an image that no job has started, so nothing has proved it boots.
- It builds from your working tree, not from a commit — including whatever is
  uncommitted.
- It is the one path on which `[build.args] NODE_VERSION` in `fly.toml` is
  read at all. CI passes `--build-arg NODE_VERSION` from `.nvmrc` instead, so
  the two agree only as long as the four copies of the Node version do — see
  *Prerequisites* above, and `tests/node-version.test.ts`, which checks.

Afterwards the next push to `main` releases the tested image again, so a
hand-built image lives only until then.

The admin account is not part of a deploy — it lives in the database, so it
survives every release and only has to be created once:

```bash
fly ssh console
# then, inside the machine:
node /app/create-admin.ts you@example.com
```

An interactive shell rather than `fly ssh console -C "…"`, because `-C` gives
the command no TTY and the script will not prompt for a password it cannot
ask for. Typing it at the prompt keeps it out of the command line either way.
Re-running resets the password of an account that already exists.

Deployment configuration files:

- `Dockerfile` - Docker image definition
- `fly.toml` - Fly.io configuration

`fly.toml` caps how many requests the proxy will put on one machine at once
(`[http_service.concurrency]`: soft 20, hard 40). The number is not a guess
about traffic, it is a number about this process: `db.ts` builds a pool of
ten connections and waits two seconds for a free one, and a single page
renders several queries — the sidebar alone asks for six lists. Past a couple
of dozen concurrent requests the machine stops being slow and starts
answering pool timeouts, which the page renders as blank widgets. Raise the
limits and `max` in `db.ts` together, or not at all.

## 💾 Data and recovery

What the data is, where it lives, and what getting it back involves. None of
this is automated here beyond the migrations; the rest is a matter of knowing
which console to open, which is exactly what is easy to not know at the wrong
moment.

### Schema: forward-only migrations

Migrations live in `migrations/`, are applied once each in filename order,
and their contents are hashed into the `migrations` table. They are run by
the `release_command` in `fly.toml`, which executes before the new machines
take traffic and aborts the deploy if it fails.

**`release_command` runs before the machines are replaced, not instead of.**
Fly restarts them one at a time once it succeeds, so for the length of the
rolling restart the *old* code is serving against the *new* schema. A migration
that drops or renames a column the running release still selects breaks
production for that window and nothing reports it as a deploy problem. Schema
changes therefore go in two releases — **expand, then contract**: add the new
column and write to both in one release; drop the old column in a later one,
once nothing running reads it. A rename is an add, a backfill, a switch and a
drop, not an `ALTER ... RENAME`.

**There is no down migration, by design.** Rolling a schema back is not a
recovery plan — it is a second, untested change applied to a database that is
already in trouble. A mistake is corrected by a new migration going forward.
Editing a migration that has already run makes the next run stop rather than
let environments drift apart. Rolling back the *code* is a different matter,
and it works without touching the schema — see
[Rolling back](#rolling-back).

That leaves one case the migrations cannot answer: a release that has already
destroyed or rewritten data. For that, the backups below are the only answer,
so it is worth knowing their state *before* writing a migration that drops a
column.

**The checksum covers the comments too.** `utils/migrations.ts` hashes the
whole file, so a migration that has shipped cannot have its prose corrected
either — fixing a typo in a comment stops the next run on every database that
had already applied it. A comment that turns out to be wrong is therefore
written down here instead of edited there. Two are known:

- **0032** describes itself as a no-op for anyone whose 0030 already carried
  the line, which is true of the schema but not of the data. Its
  `"appliedAt" AT TIME ZONE 'UTC'` reinterprets the stored values in whatever
  zone the *session* is in, and it round-trips correctly only because
  `utils/migrations.ts` issues `SET LOCAL TIME ZONE 'UTC'` before each file.
  Applied by hand with `psql` on a server in another zone, it shifts every
  `appliedAt` in the table by that offset.
- **0041** (and **0043**, which repeats it) attributes
  `idx_comments_gameId` to migration 0014. It is created in
  **0020** (`0020_search_ratings_comments.sql`). Nothing behaves differently
  for it; it is a wrong cross-reference in a file that cannot be edited.

### Migrations outside a transaction

Every migration runs inside a transaction of its own, which is what keeps a
failure from committing half of one — and which rules out
`CREATE INDEX CONCURRENTLY`, because Postgres refuses it inside a transaction
block. Without it, a new index on a table that keeps growing (`plays`,
`ratings`) holds a `SHARE` lock for its whole build, and every vote and play
`INSERT` waits until it is done; the five-second lock bound in `migrate.ts`
limits the wait *for* a lock, not how long one is held. So a file can opt out:

```sql
-- migrate:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_plays_gameId_createdAt"
  ON "plays" ("gameId", "createdAt");
```

The rules, all enforced by `utils/migrations.ts` before anything runs:

- **The marker is the first line**, spelled exactly as above. Anywhere else it
  is refused, rather than read as an ordinary comment that leaves the file
  inside a transaction.
- **One statement per file.** Postgres runs several statements sent together
  as one implicit transaction, where `CONCURRENTLY` is refused just as it is
  after `BEGIN` — and with no transaction around the file, a failure halfway
  would have nothing to roll back to. A second index is a second file.
- **The file is recorded only after its statement succeeds**, so a run that
  dies in between — a dropped connection, a killed release command — runs the
  file again next time. That is why it says **`IF NOT EXISTS`**: the second
  run of a build that did finish is then a no-op instead of "relation already
  exists". `DROP INDEX CONCURRENTLY IF EXISTS` is the same idea the other way
  round.
- **A concurrent build waits a minute for locks, not five seconds.** It has to
  wait out the transactions that were already running when it began (for its
  last phase, any open snapshot in the database counts, whatever table it is
  on), and its own lock blocks no read and no write, so the short bound the
  other DDL gets would only turn a slow query into a failed build. A minute
  outlasts anything the app does (every page-view statement is cut off at
  fifteen seconds); what runs it out is a session left idle in a transaction.
  A statement in such a file that is not `CONCURRENTLY` keeps the five
  seconds.

**A concurrent build that fails leaves its index behind, marked `INVALID`.**
It does not roll back. A unique index over duplicate values, a lock wait that
ran out, a cancelled statement: each leaves an index that no query uses and
every write still pays for — and `IF NOT EXISTS` counts it as existing, so
simply running the file again "succeeds" over the broken index. The runner
does not let that through: it will not record a no-transaction file while an
`INVALID` index exists in the schema, it names the index in the error, and a
failure that left one is not retried automatically. To recover, find it (the
deploy log names it too), drop it — concurrently, so the drop does not lock
the table either — fix whatever made the build fail, and deploy again; the
file is still pending and runs from the start:

```sql
SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
DROP INDEX CONCURRENTLY IF EXISTS "idx_plays_gameId_createdAt";
```

All of this Postgres behaviour — the refusal inside a transaction, the
`INVALID` leftover, `IF NOT EXISTS` skipping it — is exercised against a real
server by `tests/utils/migrations-postgres.test.ts`.

### Postgres: Supabase

The production database is Supabase Postgres. Supabase takes its own backups,
but **what you get depends on the plan** — daily snapshots with a retention
window on some tiers, point-in-time recovery only as a paid add-on, and
nothing at all worth relying on at the bottom. Confirm the actual tier and
retention in the Supabase dashboard (Project → Database → Backups) rather
than assuming; this README deliberately does not state a number it cannot
verify.

A dump you hold yourself is worth having either way, if only because it is
the one copy that survives losing access to the account:

```bash
# Session mode (port 5432) — the same URL the app uses. A transaction-mode
# pooler URL (port 6543) will not do: pg_dump needs a session it can hold.
pg_dump --no-owner --no-privileges --format=custom \
  --file="osg-$(date +%F).dump" "$DATABASE_URL"
```

Restoring it, into a fresh database:

```bash
pg_restore --no-owner --no-privileges --clean --if-exists \
  --dbname="$TARGET_DATABASE_URL" osg-2025-01-01.dump
```

`--clean --if-exists` makes the restore idempotent against a database that
already has some of the schema; drop and recreate the database instead if you
want certainty about what is in it.

Two things to check while you are there:

- **The server's major version.** CI runs its tests against `postgres:17`
  (the service container in `.github/workflows/fly-deploy.yml`), and a dump
  taken from a newer server cannot be restored into an older one. Confirm
  what production actually runs with `SELECT version();` against
  `DATABASE_URL` and move the CI image to match if they have drifted — the
  suite passing against a different major than production is a gap, not a
  detail.
- **That a restore has been tried.** A dump nobody has restored is a file,
  not a backup.

### Storage: the media bucket

Game bundles and artwork are **not** in Postgres. They are served from the
storage origin in `MEDIA_ORIGIN` (`utils/site.ts`, and the matching constant
in `public/js/js-dos-player.js`), which today is a Supabase Storage bucket.
The database holds the paths; the bytes live there.

So a Postgres backup restores a catalogue pointing at files it does not
contain. **The bucket needs its own backup, and it does not have one here** —
Supabase Storage is not covered by the database backups above. Whatever form
that takes (a periodic sync to another bucket, an offline copy of the
originals), it is a separate job from anything in this repository, and the
catalogue is worth much less without it.

### Sessions and rate limits

`session` and `rate_limits` are working tables, not records. Losing them logs
everyone out and resets the counters; neither is worth a recovery plan, and
`tests/setup.ts` truncates both on every run for the same reason.

Deleting a session's row is how the logout and the password reset end it, and
that is final: the store (`utils/session-store.ts`) only ever updates the row
of a session it has already written, so a request of that session still in
flight cannot write the row back when it finishes — which the stock
connect-pg-simple upsert did. Behind that, a session records a fingerprint of
the password hash it was opened with, and the admin guard signs out any
session whose fingerprint no longer matches the account, whatever happened to
its row. A session written before the fingerprint existed has none and is
signed out the same way, so an admin logs in once more the first time they
open an admin page after deploying that change.

Password hashing is capped per process — two scrypt derivations at a time and
eight waiting (`utils/password.ts`) — because every login attempt costs one,
and they share libuv's thread pool with everything else. Past the cap the
login answers `503` with a `Retry-After` rather than queueing — except for an
attempt presenting a valid `osg_device` cookie, which waits at the front of
the queue instead, so a flood cannot keep the owner out that way either.

## 📊 Features

### For Visitors

- Browse game catalog
- Play games in browser
- Rate games
- Add comments
- Save favorite games
- Game play history

### For Administrators

- Add and edit games
- Manage comments
- Create and manage news articles

## 🤝 Contributing

1. Fork the project
2. Create a feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

[CONTRIBUTING.md](CONTRIBUTING.md) has the rest of it: what to run before
opening the pull request (the same three commands CI runs), which vitest
project a new test belongs in, and what a change is expected to carry.

## 🔒 Security

Found a vulnerability? Please do not open an issue — that is the one channel
that tells everybody at once. [SECURITY.md](SECURITY.md) has the two private
ways to report one, what is in scope, and what to expect.

## 📄 License

This project is licensed under the MIT License. See [LICENSE](LICENSE).

## 🎯 Roadmap

- [ ] Support for multiple gaming platforms
- [ ] User profiles with achievements
- [ ] Multiplayer features
- [ ] Mobile application
- [ ] Third-party API
- [ ] Advanced filtering
- [ ] Social features
