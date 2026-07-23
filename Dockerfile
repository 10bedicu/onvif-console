# ── Stage 1: build the static UI ─────────────────────────────────────────
FROM node:22-alpine AS ui
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install
COPY next.config.ts tsconfig.json postcss.config.mjs ./
COPY src ./src
RUN pnpm build

# ── Stage 2: Python runtime serving API + static UI ──────────────────────
FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt backend/
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend ./backend
COPY --from=ui /app/out ./out

EXPOSE 5800
WORKDIR /app/backend
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "5800"]
