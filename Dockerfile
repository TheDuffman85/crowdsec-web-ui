# Dockerfile
# Use node:20-slim (Debian) instead of Alpine to avoid QEMU emulation issues on ARM64
FROM node:20-slim

# Install the Docker CLI so docker commands can be executed
# Debian uses apt-get. We install docker.io which contains the client.
RUN apt-get update && \
    apt-get install -y docker.io && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy root package files and install backend dependencies
COPY package*.json ./
RUN npm install

# Copy frontend package files and install frontend dependencies
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm install

# Copy the rest of the application code
COPY . .

# Build the frontend
RUN npm run build-ui

# Expose port 3000
EXPOSE 3000

# Run the application
CMD ["npm", "start"]
