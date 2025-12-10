# Dockerfile
# Use node:20-slim (Debian) instead of Alpine to avoid QEMU emulation issues on ARM64
FROM node:20-slim

# Set working directory
WORKDIR /app

# Copy root package files and install backend dependencies
COPY package*.json ./
RUN npm install

# Copy frontend package files and install frontend dependencies
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm install --legacy-peer-deps

# Copy the rest of the application code
COPY . .

# Build args
ARG VITE_COMMIT_HASH
ARG VITE_BUILD_DATE
ARG VITE_REPO_URL

# Set as env vars for the build
ENV VITE_COMMIT_HASH=$VITE_COMMIT_HASH
ENV VITE_BUILD_DATE=$VITE_BUILD_DATE
ENV VITE_REPO_URL=$VITE_REPO_URL

# Build the frontend
RUN npm run build-ui

# Expose port 3000
EXPOSE 3000

# Security: Run as non-root user
USER node

# Increase Node.js memory limit to avoid OOM with large datasets
ENV NODE_OPTIONS="--max-old-space-size=4096"

# Run the application
CMD ["npm", "start"]
