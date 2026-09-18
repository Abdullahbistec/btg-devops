# Multi-stage build: compile the Go CLI, build the Next.js dashboard, then
# assemble a minimal runtime image with both. The web app spawns the CLI as
# a subprocess (BTG_DEVOPS_PATH, default "../btg-devops" relative to the
# web/ working directory — see web/lib/btg-runner.ts and
# web/.env.local.example) — the final layout below mirrors that relative
# path exactly (/app/btg-devops next to /app/web/), so no override is needed.

FROM golang:1.26-alpine AS cli-build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/btg-devops .

FROM node:24-alpine AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci
COPY web/ .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
COPY --from=cli-build /out/btg-devops ./btg-devops
COPY --from=web-build /app/web ./web
# claude -p (spawned from cwd /app/web by web/lib/routine-trigger.ts) walks
# up from its cwd looking for .mcp.json to discover the "btg-devops" MCP
# server — without this file present at /app/.mcp.json, it finds nothing,
# has zero MCP tools, and the drain silently completes without ever calling
# save_analysis. Every request stayed "pending" until this was added.
COPY .mcp.json ./.mcp.json
# Enables the Summarize/drain path (web/lib/routine-trigger.ts spawning
# `claude -p`) inside the container. Installing the CLI alone isn't enough —
# it also needs a headless auth token (CLAUDE_CODE_OAUTH_TOKEN, generated via
# `claude setup-token`) set in web/.env.local; see docs/docker-claude-drain.md.
# This image never bakes in credentials of its own.
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /app/web
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
