# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Copy workspace files
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* .npmrc* ./
COPY tsconfig.base.json ./

# Copy packages
COPY packages/core-config/package.json packages/core-config/
COPY packages/core-telemetry/package.json packages/core-telemetry/
COPY packages/core-kafka/package.json packages/core-kafka/
COPY packages/core-contracts/package.json packages/core-contracts/
COPY packages/worker-base/package.json packages/worker-base/

# Copy worker
COPY apps/workers/mail-embedder/package.json apps/workers/mail-embedder/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/ packages/
COPY apps/workers/mail-embedder/ apps/workers/mail-embedder/

# Build all packages
RUN pnpm build

# Production stage
FROM node:20-alpine AS runner

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Copy built packages
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/workers/mail-embedder ./apps/workers/mail-embedder

WORKDIR /app/apps/workers/mail-embedder

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "console.log('healthy')" || exit 1

# Run as non-root
USER node

CMD ["node", "dist/main.js"]
