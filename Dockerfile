# syntax=docker/dockerfile:1.7

# =============================================================================
# HCD Title Transfer Agent — Multi-stage Dockerfile
# Base: node:22-bookworm-slim (glibc for @github/copilot + git compatibility)
# Ref: references/research/DOCKER_DEPLOYMENT_HIGH_QUALITY_REFERENCE.md §2
# =============================================================================

# --- Base: shared foundation -------------------------------------------------
ARG NODE_VERSION=22-bookworm-slim
FROM node:${NODE_VERSION} AS base
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

# --- Stage 1: deps (install from lockfile only) -----------------------------
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# Override NODE_ENV so devDependencies (tailwindcss, postcss, etc.) are installed
# for the build stage. The runtime stage re-sets NODE_ENV=production.
RUN --mount=type=cache,target=/root/.npm \
    NODE_ENV=development npm ci --no-audit --no-fund

# --- Stage 2: builder (compile Next.js standalone) --------------------------
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN --mount=type=cache,target=/app/.next/cache \
    npm run build

# --- Stage 3: runtime (production image with system tools) ------------------
FROM base AS runtime
WORKDIR /app

# 3a. System packages: Python, OCR, PDF utils, git, curl, tini
#     - tesseract-ocr: offline OCR for scanned title PDFs
#     - ghostscript + poppler-utils: PDF manipulation backends
#     - git: required by @github/copilot CLI
#     - tini: PID 1 signal handling / zombie reaping for child processes
#     - curl: healthcheck probe
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv \
      tesseract-ocr \
      ghostscript \
      poppler-utils \
      git \
      ca-certificates \
      curl \
      tini \
      sqlite3 \
    jq \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# 3b. Install uv (Python package/tool manager) via official standalone installer
#     This avoids pipx/pip dependency chain issues.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# 3c. Install GitHub Copilot CLI + tsx (TypeScript executor) globally (requires Node 22+)
RUN --mount=type=cache,target=/root/.npm \
    npm install -g @github/copilot@latest tsx

# 3d. Create non-root user `app` (UID 1001) for least-privilege execution
ARG APP_UID=1001
ARG APP_GID=1001
RUN groupadd --system --gid ${APP_GID} app \
 && useradd --system --uid ${APP_UID} --gid ${APP_GID} \
      --home /home/app --create-home app

# 3e. Create persistent /workspace directory (volume mount target at runtime)
RUN mkdir -p /workspace && chown -R app:app /workspace

# 3f. Pre-warm MCP PDF servers as user `app` so uv tool bins are accessible at runtime
USER app
ENV UV_TOOL_DIR=/home/app/.local/share/uv/tools \
    UV_TOOL_BIN_DIR=/home/app/.local/bin \
    PATH="/home/app/.local/bin:${PATH}"

RUN uv tool install "mcp-pdf[forms]" \
 && uv tool install pymupdf4llm-mcp

# 3g. Switch back to root briefly to copy build artifacts with correct ownership
USER root

# 3h. Copy standalone Next.js artifacts from builder
COPY --from=builder --chown=app:app /app/public            ./public
COPY --from=builder --chown=app:app /app/.next/standalone  ./
COPY --from=builder --chown=app:app /app/.next/static      ./.next/static

# 3i. Copy assets (blank HCD forms, sample title), scripts, and prompts
COPY --chown=app:app assets/ ./assets/
COPY --chown=app:app scripts/ ./scripts/
COPY --chown=app:app prompts/ ./prompts/
COPY --chown=app:app tsconfig.json ./tsconfig.json

# 3i-2. Copy source + node_modules for tsx-based scripts (smoke tests, discover-fields)
COPY --from=builder --chown=app:app /app/src ./src
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json ./package.json

# Allow the runtime user to write verification artifacts under /app when
# running in-container smoke and gate commands.
RUN chown app:app /app

# 3j. Runtime environment
ENV NODE_ENV=production \
    PORT=3031 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

# 3k. Run as non-root
USER app
EXPOSE 3031

# 3l. Healthcheck: probe the /api/health endpoint
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=15s \
  CMD ["sh", "/app/scripts/healthcheck.sh"]

# 3m. Use tini as PID 1 for proper signal propagation and zombie reaping
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
