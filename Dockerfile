# Dockerfile
FROM node:14-alpine

# Install the Docker CLI so docker commands can be executed
RUN apk update && apk add --no-cache docker-cli

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose port 3000
EXPOSE 3000

# Run the application
CMD ["npm", "start"]
