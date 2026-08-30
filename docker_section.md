### Option 2: Docker Container

For flexibility and multi-platform deployment, use the committed
[`Dockerfile`](../Dockerfile) at the repo root. It is a multi-stage build
that:

1. **Builder stage** (`node:22-alpine`): Installs build dependencies for native
   modules (Python, make, g++) and runs `npm ci` + `npm run build`
2. **Production stage** (`node:22-alpine`): Copies only production artifacts,
   creates a non-root `nodejs` user, and includes a healthcheck

```dockerfile
# Builder stage
FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++ libc-dev
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM node:22-alpine AS production
RUN addgroup -S nodejs && adduser -S nodejs -G nodejs
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/scripts ./scripts
RUN mkdir -p /app/data && chown -R nodejs:nodejs /app
USER nodejs
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1
CMD ["node", "server.js"]
```

The accompanying `.dockerignore` keeps `node_modules`, `.next`,
`contracts/target`, `.env*`, and `data/` out of the build context.

**Build:**
```bash
docker build -t stellar-bulk-pay:latest .
```

**Run locally:**

```bash
docker run --rm -p 3000:3000 \
  -e NODE_ENV=production \
  -e STELLAR_SECRET_KEY="$STELLAR_SECRET_KEY" \
  -v "$(pwd)/data:/app/data" \
  stellar-bulk-pay:latest
```

**Push:**

```bash
docker tag stellar-bulk-pay:latest myregistry/stellar-bulk-pay:latest
docker push myregistry/stellar-bulk-pay:latest
```

**Deploy to container service:**

- AWS ECS — mount an EFS volume at `/app/data` if you need durable SQLite.
- Google Cloud Run — pair with a managed database, or accept that
  `data/` resets on each container instance.
- Azure Container Instances

### Option 3: Traditional VPS