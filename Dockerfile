# Dockerfile (Multi-stage)

# ==========================================
# Stage 1: Builder
# ==========================================
FROM node:24.15.0-trixie-slim AS builder

WORKDIR /app
ENV NODE_ENV=development

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10.33.0

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

# Build Args need to be declared BEFORE the build step
# Vite bakes VITE_* env vars into the static bundle at build time
ARG VITE_COMMIT_HASH
ARG VITE_BUILD_DATE
ARG VITE_REPO_URL
ARG VITE_BRANCH
ARG VITE_VERSION

# Copy source code
COPY client ./client
COPY server ./server
COPY shared ./shared
COPY scripts ./scripts
COPY tsconfig.json ./
COPY tsup.config.ts ./
COPY vite.config.ts ./
COPY vitest.config.ts ./
COPY vitest.server.config.ts ./
COPY vitest.client.config.ts ./
COPY eslint.config.js ./
COPY docker-entrypoint.sh ./
COPY run.sh ./
COPY run.ps1 ./

# Build the application with VITE_* variables available
RUN pnpm exec vite build \
    && pnpm exec tsup \
    && pnpm prune --prod


# ==========================================
# Stage 2: Runner
# ==========================================
FROM node:24.15.0-trixie-slim

WORKDIR /app

# Build Args (metadata)
ARG VITE_COMMIT_HASH
ARG VITE_BUILD_DATE
ARG VITE_REPO_URL
ARG VITE_BRANCH
ARG VITE_VERSION
ARG DOCKER_IMAGE_REF=theduffman85/crowdsec-web-ui

# Set Runtime Environment Variables
ENV VITE_COMMIT_HASH=$VITE_COMMIT_HASH
ENV VITE_BUILD_DATE=$VITE_BUILD_DATE
ENV VITE_REPO_URL=$VITE_REPO_URL
ENV VITE_BRANCH=$VITE_BRANCH
ENV VITE_VERSION=$VITE_VERSION
ENV DOCKER_IMAGE_REF=$DOCKER_IMAGE_REF
ENV DB_DIR="/app/data"
ENV NODE_ENV=production

RUN npm install -g pnpm@10.33.0

# Install gosu (for entrypoint) and apply security updates
RUN apt-get update && apt-get upgrade -y && apt-get install -y \
    gosu \
    && rm -rf /var/lib/apt/lists/*

# Copy backend dependencies from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy built application artifacts
COPY --from=builder /app/dist ./dist

# Copy runtime files for the existing pnpm start contract
COPY package.json ./
COPY pnpm-workspace.yaml ./
COPY scripts ./scripts
COPY docker-entrypoint.sh /usr/local/bin/

# Set permissions
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Pre-create data directory with correct ownership
# This ensures Docker named volumes inherit the right permissions
RUN mkdir -p /app/data && chown node:node /app/data

# Expose port
EXPOSE 3000

# Health check using Node to hit the health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["pnpm", "start"]
