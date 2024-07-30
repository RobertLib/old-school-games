# syntax = docker/dockerfile:1

# Node 24 is the current LTS, and the one version this project is built and
# tested against: .nvmrc, package.json's "engines", the setup-node step in
# .github/workflows/fly-deploy.yml and the NODE_VERSION in fly.toml all say 24.
# Keep them together. The app is started as `node index.ts` and relies on the
# runtime stripping the type annotations, which needs 22.18 or newer — the
# 22.6 this used to default to would refuse to boot.
#
# The tag, not a digest. A digest would pin the exact bytes and take the
# silent "node:24-slim moved underneath us" class of change off the table, but
# it also has to be re-resolved by hand on every base image security update,
# and nothing here watches for one — a stale digest is a deliberately pinned
# unpatched base. The tag is resolved afresh by every CI build (each job gets
# a new builder), so a deploy ships whatever node:24-slim is that day,
# security fixes included — which also means a quiet month ships none, and
# redeploying is how one arrives.
#
# Nothing automated will move a digest here either. This used to say that
# Dependabot "can move a digest for us", and it cannot: its Dockerfile parser
# only reads a FROM line with a literal tag or digest, and the line below takes
# its tag from an ARG — as it has to, being one of the four copies of the Node
# version. The Docker entry in .github/dependabot.yml parsed nothing for that
# reason and is gone. Pinning a digest means taking on the re-resolving by
# hand; until somebody decides to, the tag is the honest choice.
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="Node.js"

# Node.js app lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV="production"


# Throw-away build stage to reduce size of final image
FROM base AS build

# No apt-get here. This used to install build-essential, node-gyp, pkg-config
# and python-is-python3 for native addons that do not exist: every production
# dependency (express, pg, ejs, helmet, compression, express-session,
# connect-pg-simple, express-rate-limit, dompurify, jsdom) is pure JavaScript,
# and `npm ci --omit=dev` compiles nothing. It was ~150 MB of toolchain and a
# minute of apt on every build that changed the lockfile.

# Install node modules. Production only: linting, typechecking and the test
# suite all run in CI, so typescript, vitest and nodemon were being shipped
# into the runtime image for nothing.
#
# The cache mount keeps npm's own package cache between builds, so an install
# whose lockfile barely moved re-downloads almost nothing. It needs BuildKit,
# which is what the syntax directive at the top of this file asks for; Fly's
# remote builder and `docker build` on a current daemon both use it.
#
# --ignore-scripts because nothing shipped here has one to run. Every
# production dependency is pure JavaScript (see the note above), and the only
# package in the lockfile carrying an install script at all is fsevents —
# devDependency, optional, and macOS-only, so `--omit=dev` on a Linux base
# never sees it. What the flag buys is that a *future* dependency, or a
# transitive one moved by a lockfile bump, cannot run arbitrary code as root
# in the build stage without somebody first noticing that this flag had to
# come off.
#
# .npmrc alongside them, and it is not decoration: it sets engine-strict, which
# turns package.json's "engines" from a warning npm prints while installing
# anyway into a refusal. .dockerignore used to exclude it — the comment there
# claimed it was only unwanted at runtime — so the check was off for the one
# install that most needed it: `docker build --build-arg NODE_VERSION=<wrong>`
# produced an image that installed cleanly and then failed to boot, because
# `node index.ts` needs a runtime that strips type annotations (22.18+). npm
# reads it from the working directory, which is why it is copied here rather
# than only kept in the repository.
COPY --link package-lock.json package.json .npmrc ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts

# Copy application code
COPY --link . .


# Final stage for app image
FROM base

# The image ships with an unprivileged `node` user, and the app runs as it —
# but it does not own the app. This used to copy /app with --chown=node:node,
# which let the running process rewrite its own code, its views and public/
# although nothing it does writes there: in production the logger goes to
# stdout (utils/logger.ts), sessions and rate limits live in Postgres, every
# cache is in memory, and the only other fs calls in the sources read. So all
# that ownership bought was that anything able to run code in the process
# could also plant a script in public/ or edit a view. COPY gives the files
# to root; their modes are the checkout's, so `node` can read everything and
# write nothing under /app.
COPY --from=build /app /app

USER node

# Fly runs its own HTTP check against /healthz (see fly.toml) and ignores
# this one, but a container started anywhere else — locally, or on any plain
# Docker host — otherwise reports "healthy" for a process whose event loop
# has wedged. `node -e` rather than curl: the slim image has no curl, and
# adding one to run a health check would undo the point of the slim image.
# Same reasoning as fly.toml: /healthz is answered above the session, the rate
# limiter and the canonical-host redirect, so a check costs no queries.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD [ "node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" ]

# node directly, not "npm run start": npm would be PID 1 with node as its
# child, and the SIGTERM the platform sends on a deploy or an auto-stop would
# reach npm rather than the handler in index.ts that drains the connection
# pool. Machines are stopped and started routinely (see fly.toml), so this is
# the common path, not an edge case. SIGTERM because fly.toml's kill_signal
# says so; Fly's own default would be SIGINT.
EXPOSE 3000
CMD [ "node", "index.ts" ]
