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
# and there is nothing here that watches for one — a stale digest is a
# deliberately pinned unpatched base. Dependabot (see .github/dependabot.yml)
# raises Docker updates weekly and can move a digest for us; pin one here once
# that has been watched for a release or two.
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
COPY --link package-lock.json package.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# Copy application code
COPY --link . .


# Final stage for app image
FROM base

# The image ships with an unprivileged `node` user; nothing here needs root.
COPY --from=build --chown=node:node /app /app

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
# the common path, not an edge case.
EXPOSE 3000
CMD [ "node", "index.ts" ]
