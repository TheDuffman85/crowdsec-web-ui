# Dockerfile
# Use oven/bun:1 as base image
FROM oven/bun:1

# Set working directory
WORKDIR /app

# Copy root package files and install backend dependencies
COPY package.json ./
# Bun install is fast
RUN bun install --production

# Copy frontend package files and install frontend dependencies
COPY frontend/package*.json ./frontend/
RUN cd frontend && bun install

# Copy the rest of the application code
COPY . .

# Build args
ARG VITE_COMMIT_HASH
ARG VITE_BUILD_DATE
ARG VITE_REPO_URL
ARG VITE_BRANCH
ARG DOCKER_IMAGE_REF=theduffman85/crowdsec-web-ui

# Set as env vars for the build
ENV VITE_COMMIT_HASH=$VITE_COMMIT_HASH
ENV VITE_BUILD_DATE=$VITE_BUILD_DATE
ENV VITE_REPO_URL=$VITE_REPO_URL
ENV VITE_BRANCH=$VITE_BRANCH
ENV DOCKER_IMAGE_REF=$DOCKER_IMAGE_REF

# Install gosu for easy step-down from root
RUN apt-get update && apt-get install -y \
    gosu \
    && rm -rf /var/lib/apt/lists/*

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Build the frontend (Bun can run vite)
RUN bun run build-ui

# Expose port 3000
EXPOSE 3000

ENV DB_DIR="/app/data"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bun", "index.js"]
