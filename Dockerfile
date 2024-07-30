# syntax = docker/dockerfile:1

# Node 24 is the current LTS. The app is started as `node index.ts` and relies
# on the runtime stripping the type annotations, which needs 22.18 or newer —
# the 22.6 this used to default to would refuse to boot.
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="Node.js"

# Node.js app lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV="production"


# Throw-away build stage to reduce size of final image
FROM base AS build

# Install packages needed to build node modules
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp pkg-config python-is-python3

# Install node modules. Production only: linting, typechecking and the test
# suite all run in CI, so typescript, vitest and nodemon were being shipped
# into the runtime image for nothing.
COPY --link package-lock.json package.json ./
RUN npm ci --omit=dev

# Copy application code
COPY --link . .


# Final stage for app image
FROM base

# The image ships with an unprivileged `node` user; nothing here needs root.
COPY --from=build --chown=node:node /app /app

USER node

# node directly, not "npm run start": npm would be PID 1 with node as its
# child, and the SIGTERM the platform sends on a deploy or an auto-stop would
# reach npm rather than the handler in index.ts that drains the connection
# pool. Machines are stopped and started routinely (see fly.toml), so this is
# the common path, not an edge case.
EXPOSE 3000
CMD [ "node", "index.ts" ]
