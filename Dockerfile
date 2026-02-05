# Dockerfile (Multi-stage)

# ==========================================
# Stage 1: Builder
# ==========================================
FROM oven/bun:1 AS builder

WORKDIR /app

# 1. Install backend dependencies (for production)
COPY package.json bun.lockb* ./
RUN bun install --production

# 2. Build Frontend
# We need to install frontend deps (including devDeps) to build it
COPY frontend/package*.json ./frontend/
RUN cd frontend && bun install

# Copy source code
COPY . .

# Build Args need to be declared BEFORE the build step
# Vite bakes VITE_* env vars into the static bundle at build time
ARG VITE_COMMIT_HASH
ARG VITE_BUILD_DATE
ARG VITE_REPO_URL
ARG VITE_BRANCH

# Build the frontend with VITE_* variables available
RUN bun run build-ui


# ==========================================
# Stage 2: Runner
# ==========================================
FROM oven/bun:1-slim

WORKDIR /app

# Build Args (metadata)
ARG VITE_COMMIT_HASH
ARG VITE_BUILD_DATE
ARG VITE_REPO_URL
ARG VITE_BRANCH
ARG DOCKER_IMAGE_REF=theduffman85/crowdsec-web-ui

# Set Runtime Environment Variables
ENV VITE_COMMIT_HASH=$VITE_COMMIT_HASH
ENV VITE_BUILD_DATE=$VITE_BUILD_DATE
ENV VITE_REPO_URL=$VITE_REPO_URL
ENV VITE_BRANCH=$VITE_BRANCH
ENV DOCKER_IMAGE_REF=$DOCKER_IMAGE_REF
ENV DB_DIR="/app/data"
ENV NODE_ENV=production

# Install gosu (for entrypoint) and apply security updates
RUN apt-get update && apt-get upgrade -y && apt-get install -y \
    gosu \
    && rm -rf /var/lib/apt/lists/*

# Copy backend dependencies from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy frontend build artifacts
COPY --from=builder /app/frontend/dist ./frontend/dist

# Copy backend source files
COPY package.json ./
COPY index.js ./
COPY lapi.js ./
COPY sqlite.js ./
COPY docker-entrypoint.sh /usr/local/bin/

# Set permissions
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose port
EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bun", "index.js"]
