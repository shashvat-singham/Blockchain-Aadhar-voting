# syntax=docker/dockerfile:1
#
# Two targets:
#
#   runtime    the app. Production dependencies only (ethers + jose), no
#              compiler, no Hardhat. This is what you deploy.
#   toolchain  the full dev toolchain, used by docker-compose to run a local
#              chain and to deploy/seed the contract. Never ship this.
#
# Build just the app:
#   docker build --target runtime -t aadhaar-voting .

ARG NODE_VERSION=20-alpine

# ---------------------------------------------------------------- deps ------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

COPY package.json package-lock.json* ./

# Separate layers so a change to application code does not reinstall anything.
RUN npm ci --omit=dev --no-audit --no-fund

# ------------------------------------------------------------ toolchain -----
FROM node:${NODE_VERSION} AS toolchain
WORKDIR /app

# Hardhat's solc download and some transitive builds need these.
RUN apk add --no-cache git python3 make g++ bash curl

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npx hardhat compile

# -------------------------------------------------------------- runtime -----
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# `tini` reaps zombies and forwards SIGTERM, so the graceful shutdown in
# server.js actually runs when the container stops.
RUN apk add --no-cache tini curl

COPY --from=deps /app/node_modules ./node_modules

# Only what the server needs at runtime. No contracts, tests, or scripts.
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node api ./api
COPY --chown=node:node public ./public
COPY --chown=node:node config ./config

# The roll is PII and is never baked into an image. Mount it, or supply
# VOTER_REGISTRY_JSON / VOTER_REGISTRY_PATH.
RUN mkdir -p /app/data && chown node:node /app/data

# Drop privileges. `node` is a non-root user that already exists in the image.
USER node

EXPOSE 3000

# /api/health returns 503 until the chain, relayer and roll are all usable, so
# orchestrators hold traffic back rather than routing it into failing ballots.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
