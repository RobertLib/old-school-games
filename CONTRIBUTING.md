# Contributing

Pull requests are welcome. `README.md` is the long version — what the project
is, how to get it running, and why most things are the way they are; this file
is only the short path through it.

## Getting it running

Node 24 and a PostgreSQL, then:

```bash
nvm use            # .nvmrc says 24; "engines" is "^24" and .npmrc makes it strict
npm install
createdb old_school_games
cp .env.example .env
npm run migrate
npm run create-admin
npm run dev
```

`.env.example` documents every environment variable there is.

## The workflow

1. Fork the project.
2. Create a feature branch (`git checkout -b feature/AmazingFeature`).
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`).
4. Push to the branch (`git push origin feature/AmazingFeature`).
5. Open a pull request.

## Before you open it

Run what CI runs, because CI runs exactly this and nothing merges red:

```bash
npm run lint
npm run typecheck
npm run test:coverage
```

The suite needs a Postgres. `createdb old_school_games_test` is enough — the
schema is created and migrated on the first run. The half that does not need
one is a project of its own and takes a couple of seconds:

```bash
npx vitest run --project unit
```

`test:coverage` rather than `test`: the coverage floors in `vitest.config.ts`
are only evaluated when coverage is collected. They are floors, not targets —
raise them when the real figures move up, and do not lower them to make a run
pass.

## What a change is expected to carry

- **A test, when there is behaviour to pin down.** New files go in the
  `integration` project unless they have been checked and found not to import
  `db.ts` — directly or through a model, a route or `app.ts`. That rule is
  itself enforced: see `tests/unit-project-isolation.test.ts`.
- **A comment that says *why*.** This codebase's comments are not
  descriptions of the code next to them; they record the reasoning, and very
  often the bug that produced it. If a line looks odd, the comment above it is
  the reason it is that way — and if you are writing an odd line, that is the
  comment to leave.
- **A migration, if the schema moves.** Forward-only, one file per change,
  `migrations/NNNN-what-it-does.sql`. The runner records a checksum, so an
  applied file must never be edited afterwards: add another.
- **A README update, if you changed something it describes** — an environment
  variable, a script, a model, the deployment.

## Reporting a vulnerability

Not through a pull request or an issue. See [SECURITY.md](SECURITY.md).
