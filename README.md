# 🕹️ Old School Games

A web application for browsing and playing classic MS-DOS games directly in your browser. The project offers a nostalgic experience with games from the MS-DOS era combined with a modern user interface.

## 🎮 Features

- **Game Catalog**: Browse through an extensive database of classic MS-DOS games
- **Browser Gaming**: Play games directly in your browser without any installation
- **Filtering & Search**:
  - Filter by genre, release year, developer, publisher
  - Alphabetical filtering by first letter
  - Text search by game title
- **Game Rating**: User rating system for games
- **Game of the Week**: Automatically selected weekly featured game
- **Curated Lists**: Predefined thematic game lists (top games, genres, eras, etc.)
- **News**: News section with admin-managed articles
- **Favorite Games**: Save favorite games in localStorage
- **Recently Played**: History of recently played games
- **Comments**: Comment system for individual games
- **Administration**: Admin interface for managing games, news, and content
- **Responsive Design**: Fully responsive web interface
- **Sitemap**: Automatic sitemap generation for SEO

## 🛠️ Technologies

- **Backend**: Node.js 24 LTS (native TypeScript support), Express.js
- **Database**: PostgreSQL
- **Frontend**: EJS templates, vanilla JavaScript
- **Styling**: Custom CSS
- **Testing**: Vitest
- **Deployment**: Fly.io (Docker)
- **Session management**: express-session with PostgreSQL store
- **Security**: Helmet, rate limiting, CSRF protection

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
│   ├── lists.ts         # Curated game lists
│   ├── news.ts          # News
│   ├── feed.ts          # RSS feeds
│   └── sitemap.ts       # Sitemap
├── utils/                # Utility functions
│   ├── assets.ts        # Content-hashed asset URLs
│   ├── cache.ts         # TTL cache for the lists every page renders
│   ├── cache-epoch.ts   # Shared counter that drops every machine's caches after a write
│   ├── cookies.ts       # Single-cookie reader
│   ├── expects-json.ts  # Which endpoints get a JSON error rather than a page
│   ├── html-text.ts     # Stored description HTML flattened to plain text
│   ├── ids.ts           # Strict integer id parsing
│   ├── logger.ts        # Logger
│   ├── migrations.ts    # The migration runner, shared by migrate.ts and the suite
│   ├── page-cache.ts    # Caches for the sitemap, the feeds and /most-played
│   ├── pagination.ts    # ?page= parsing
│   ├── password.ts      # Password hashing
│   ├── pg-errors.ts     # Postgres error codes the routes tell a 404 apart by
│   ├── query.ts         # Query-string helpers
│   ├── rate-limit-store.ts # Rate-limit counters, shared across machines
│   ├── reserved-slugs.ts # Addresses a generated game slug must not take
│   ├── sanitize-html.ts # The one DOMPurify author-supplied markup goes through
│   ├── session-cookie.ts # The session cookie's name and attributes
│   ├── sidebar-cache.ts # The cache the page chrome shares with the models
│   ├── site.ts          # The site's own host and origin
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
│   └── js-dos.html      # The DOS player frame: one pinned, hash-checked js-dos release
├── validations/          # Validation logic
├── migrations/           # SQL migrations
└── tests/               # Tests
```

## 🚀 Installation & Setup

### Prerequisites

- Node.js 24+ (22.18+ also works; the runtime must strip type annotations)
- PostgreSQL
- npm or yarn

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

3. **Database setup**
   - Create a PostgreSQL database
   - Set the `DATABASE_URL` environment variable

   ```bash
   export DATABASE_URL="postgresql://username:password@localhost:5432/old_school_games"
   ```

4. **Run migrations**

   ```bash
   npm run migrate
   ```

   Migrations are applied once each, in filename order, and their contents are
   hashed into the `migrations` table. Editing a migration that has already
   run makes the next run stop rather than let the schema drift apart between
   environments — put the change in a new file instead.

5. **Create an admin account**

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
   password, so it doubles as the password reset.

6. **Start the application**

   ```bash
   # Development mode with hot reload
   npm run dev

   # Production mode
   npm start
   ```

The application will run on `http://localhost:3000`

## 📝 NPM Scripts

- `npm run dev` - Start in development mode, restarting on change (`node --watch`)
- `npm start` - Start in production mode
- `npm test` - Run tests
- `npm run typecheck` - Type-check the sources and the suite (nothing is compiled at runtime, so this is the only thing that catches type errors)
- `npm run lint` - Lint the sources
- `npm run lint:fix` - Lint and apply the fixes it can make itself
- `npm run test:watch` - Run tests in watch mode
- `npm run test:coverage` - Run tests with coverage report, held to the floors in `vitest.config.ts`
- `npm run migrate` - Run database migrations
- `npm run create-admin` - Create an admin account, or make an existing one an admin (see step 5 above)
- `npm run format:ejs` - Format EJS templates

CI runs `lint`, `typecheck` and `test:coverage` on every push and pull
request, and a deploy only happens if all three pass. It is `test:coverage`
rather than `test` on purpose: the coverage thresholds are only evaluated when
coverage is collected, so run as plain `test` they would never fail a build.

### A note on the TypeScript version

`typescript` is deliberately held at 6.x. TypeScript 7 type-checks this
codebase cleanly, but `typescript-eslint` refuses to load against the TS 7 API
([typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)),
so `npm run lint` — and therefore CI — fails outright. The documented
workaround is installing a second, TS 6 copy of the compiler side by side,
which is a lot of moving parts to buy nothing: nothing here needs a TS 7
feature. Raise it once typescript-eslint supports >= 7.1.

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

`key` holds an IP address, which makes this table personal data and the only
place in the schema that holds any without saying so — the address recorded
with a rating declares itself in the privacy policy and has a 90-day
retention. A row here lives far shorter: the longest window is 15 minutes and
`startRateLimitPruning` sweeps expired rows every 10, so 25 minutes is the
worst case. Section 2f of `views/privacy-policy.ejs` states exactly that, and
`tests/views/privacy-policy.test.ts` asserts the claim against the store's own
key so the two cannot drift.

### News

- `title` - Article title
- `content` - Article content (HTML)
- `userId` - Reference to author

## 🔧 Configuration

The application uses the following environment variables:

- `DATABASE_URL` - PostgreSQL connection string
- `SESSION_SECRET` - Secret key for sessions
- `NODE_ENV` - Application environment (development/production)
- `PORT` - Port the server listens on (default: `3000`)
- `CANONICAL_HOST` - The site's own host: what production requests are redirected to, and what every canonical tag, feed link and sitemap entry is built from (default: `oldschoolgames.eu`)
- `MEDIA_ORIGIN` - Origin serving game artwork and the js-dos bundles (default: the current storage bucket). It is named in the `Content-Security-Policy`, so a deployment pointing at its own bucket must set this — get it wrong and the browser refuses every image and bundle, which is reported nowhere but its console. **Set it in two places:** the player also refuses a game bundle from anywhere but this origin, and `public/js/js-dos-player.js` is a static file that cannot read an environment variable, so it carries its own `MEDIA_ORIGIN` constant. `tests/public-assets.test.ts` asserts that constant matches the default here, the same way it keeps the js-dos release in step across two files
- `TEST_DATABASE_URL` - Database the test suite runs against (default: `postgresql:///old_school_games_test`, which leaves host, user and password to libpq's defaults and the standard `PG*` variables)
- `ADMIN_EMAIL`, `ADMIN_PASSWORD` - Read by `npm run create-admin` only, never by the app itself. Not something to leave in `.env` on a server: the account exists in the database once the script has run

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

Note also what the file can and cannot do: it governs crawling, not training, and
an agent that ignores it is not stopped by anything here.

## 🧪 Testing

The project includes a comprehensive test suite with:

- Unit tests for models
- Integration tests for API endpoints
- Middleware tests
- Validation tests

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

The application is ready for deployment on Fly.io:

1. **Install Fly CLI**
2. **Deploy the application**
   ```bash
   fly deploy
   ```

Migrations run automatically before each release via the `release_command`
in `fly.toml`; a failing migration aborts the deploy.

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
