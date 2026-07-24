FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application code
COPY . .

# Expose API Port
EXPOSE 3001

# Start Server Gateway
CMD ["node", "server.js"]
