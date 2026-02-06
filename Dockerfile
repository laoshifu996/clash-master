# Clash Master - Multi-stage Docker Build
FROM node:22-alpine AS base

# Install pnpm and build tools for native modules
RUN apk add --no-cache python3 make g++ gcc && \
    npm install -g pnpm@9.15.9

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/collector/package.json ./apps/collector/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build shared package first
RUN pnpm --filter @clashmaster/shared build

# Build collector
RUN pnpm --filter @clashmaster/collector build

# Build web
RUN pnpm --filter @clashmaster/web build

# Production stage
FROM node:22-alpine AS production

# Install wget for health checks
RUN apk add --no-cache wget

WORKDIR /app

# Default environment variables
ENV NODE_ENV=production \
    WEB_PORT=3000 \
    API_PORT=3001 \
    COLLECTOR_WS_PORT=3002 \
    DB_PATH=/app/data/stats.db

# Ensure data directory exists
RUN mkdir -p /app/data

# Copy collector (with its node_modules for runtime dependencies)
COPY --from=base /app/apps/collector/dist ./apps/collector/dist
COPY --from=base /app/apps/collector/package.json ./apps/collector/
COPY --from=base /app/apps/collector/node_modules ./apps/collector/node_modules

# Copy web (Next.js standalone output)
COPY --from=base /app/apps/web/.next/standalone ./apps/web/.next/standalone
COPY --from=base /app/apps/web/.next/static ./apps/web/.next/standalone/apps/web/.next/static
COPY --from=base /app/apps/web/public ./apps/web/.next/standalone/apps/web/public

# Copy packages/shared (for collector dependencies)
COPY --from=base /app/packages/shared ./packages/shared

# Copy root node_modules for workspace dependencies
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/package.json ./

# Expose ports
EXPOSE 3000 3001 3002

# Data volume
VOLUME ["/app/data"]

# Health check - verify API is responding
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:3001/health || exit 1

# Start script
COPY docker-start.sh ./
RUN chmod +x docker-start.sh

CMD ["./docker-start.sh"]
