FROM node:20-slim

# Build tools for better-sqlite3 + Java + Python for compile endpoints
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    make \
    g++ \
    default-jdk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src ./src

EXPOSE 3001

CMD ["node", "src/index.js"]
