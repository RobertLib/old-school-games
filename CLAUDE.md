# CLAUDE.md

Express 5 + PostgreSQL + EJS, running on Node 24's native TypeScript (no build
step — nothing is compiled, so `typecheck` is the only thing that catches a
type error). ESM throughout, and imports carry the `.ts` extension.

## Commands

```bash
npm run dev                    # node --watch, loads .env if present
npm test                       # both vitest projects
npx vitest run --project unit  # no database needed at all
npm run typecheck              # sources and suite; the only type check there is
npm run lint                   # eslint
npm run migrate                # apply pending migrations
```

Run one integration file with `npx vitest run tests/<file>.test.ts`.

## Conventions

- **Every non-trivial decision carries a comment saying WHY** — specifically,
  which concrete failure it prevents, and very often the bug that produced it.
  If a line looks odd, the comment above it is the reason. If you write an odd
  line, that is the comment to leave. Do not "tidy" these away.
- **User content is rendered with `<%= %>`, never `<%- %>`.** The two
  exceptions are stored game descriptions and news articles, which go through
  `utils/sanitize-html.ts` first.
- **JSON-LD is escaped with `.replace(/</g, "\\u003c")`** before it goes into a
  `<script type="application/ld+json">`. Without it a `</script>` inside a
  title closes the block and the rest is markup.

## Tests

Two vitest projects, and the split is enforced rather than remembered:
`tests/unit-project-isolation.test.ts` walks what every file in the `unit` list
(`UNIT_TESTS` in `vitest.config.ts`) can reach and fails if any of it touches
`db.ts`, `app.ts`, `index.ts` or `migrate.ts`. `db.ts` opens a pool at import
time, and the `unit` project has no setup file to point `DATABASE_URL` anywhere
— so an accidental import opens a pool against whatever the shell happens to
export. Anything new goes in `integration` unless it is checked.

## Migrations

Forward-only, one file per change, `migrations/NNNN_what_it_does.sql`. The
runner (`utils/migrations.ts`, shared by `migrate.ts` and `tests/setup.ts`)
records a checksum per file, so an applied migration must never be edited:
add another.

## Things that live in more than one place

- **The Node version is written in four places** and they must move together:
  `.nvmrc`, `engines` in `package.json`, `ARG NODE_VERSION` in the `Dockerfile`
  and `NODE_VERSION` in `fly.toml`. CI reads `.nvmrc`; the other three do not.
- **Caches are invalidated through the shared cache epoch**, not by clearing a
  map. A write bumps a counter in the database and every machine drops its
  caches at the next sync (`utils/cache-epoch.ts`). Clearing locally only
  clears one machine, and there is more than one.
- **Whether a page is indexable is decided in `utils/indexability.ts`** and
  nowhere else. `views/head.ejs` turns that one answer into the robots tag, the
  canonical and the breadcrumb schema — so a page cannot say two different
  things about itself.
- **The media origin, the canonical host and the player origin** come from
  `utils/site.ts`. The media origin and the site's own origin are also
  hard-coded in `public/js/js-dos-player.js` (`MEDIA_ORIGIN`, `SITE_ORIGIN`),
  which is a static file and cannot read them. The suite checks both agree
  (`tests/public-assets.test.ts`). `PLAYER_ORIGIN` is optional: unset, the
  player is framed from the site itself, and its sandbox is no boundary.
