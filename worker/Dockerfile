# =============================================================================
# Single stage — no TypeScript build needed
# =============================================================================
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src

# Run as non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S worker -u 1001 && \
    chown -R worker:nodejs /app

USER worker

CMD ["node", "src/index.js"]
