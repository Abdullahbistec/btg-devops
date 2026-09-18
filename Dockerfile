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
WORKDIR /app/web
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
