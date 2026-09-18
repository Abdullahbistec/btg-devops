# Getting Summarize working inside the Docker container

The container runs audits and cost refresh fine — `web/lib/scheduler.ts`'s
in-process poller is exactly what it was built for. This is what it took to
make Summarize (`CLAUDE_DRAIN_ENABLED=1`, drained by `claude -p` in
`web/lib/routine-trigger.ts`) work inside it too.

## What was missing, and how each was resolved

1. **The `claude` CLI.** Not installed in the image. Added to the
   Dockerfile's runtime stage:
   ```dockerfile
   RUN npm install -g @anthropic-ai/claude-code
   ```

2. **Auth.** `claude -p` needs to authenticate as some Claude account, and
   whoever owns that account's subscription quota and usage history is a
   decision for that person, not a default to wire in silently.

   The first approach tried — mounting a host account's
   `~/.claude` + `~/.claude.json` read-only into the container — **does not
   work on a Windows host**. `claude` inside the container reported
   `Not logged in · Please run /login` even with both files mounted. The
   files carry the account's *structure* (config, settings) but not a usable
   secret: Claude Code on Windows stores the actual OAuth credential in
   Windows Credential Manager, DPAPI-encrypted and bound to that Windows
   user account. A Linux container can't decrypt it, so the mount is
   structurally present but functionally useless. (On macOS/Linux hosts,
   where credentials live directly in `~/.claude/.credentials.json`, this
   approach may actually work — untested here.)

   What works instead: **`claude setup-token`**, Anthropic's supported path
   for headless/unattended use, decoupled from any desktop keychain. On the
   machine belonging to whichever account should own the drain:
   ```bash
   claude setup-token
   ```
   This opens a browser to authorize and prints a long-lived token. Put it
   in `web/.env.local` (gitignored, already loaded via `env_file` in
   `docker-compose.yml`):
   ```
   CLAUDE_CODE_OAUTH_TOKEN=<the token>
   ```
   `claude` reads this env var automatically — no volume mount, no
   `claude login` inside the container.

3. **`.mcp.json` missing from the image.** `claude -p` is spawned from cwd
   `/app/web` and walks up looking for `.mcp.json` to discover the
   "btg-devops" MCP server (`mcp__btg-devops__*`) — the Dockerfile's runtime
   stage only ever copied `/app/btg-devops` and `/app/web`, never the
   repo-root `.mcp.json`. With it missing, `claude` has zero MCP tools
   available: it runs to completion, exits 0, and never calls
   `save_analysis` — every request stayed `pending` with no error anywhere,
   even with the CLI installed and the token above correctly set. Fixed by
   adding `COPY .mcp.json ./.mcp.json` to the runtime stage.

## Once the token is set

`CLAUDE_DRAIN_ENABLED=1` in `web/.env.local` now applies inside the
container as-is (no override needed in `docker-compose.yml`). Rebuild and
verify: queue a Summarize request, confirm `docker logs` shows `claude -p`
actually invoked, and confirm the request reaches `done` rather than sitting
`pending`.

Verified end-to-end (2026-09-18): a real request went `pending` → `done` in
under a minute, with a correct summary covering both security findings and
cost data.

## Until a token is set

Leave `CLAUDE_CODE_OAUTH_TOKEN` unset. `claude -p` inside the container will
fail to authenticate and the request just sits `pending` — the existing
try/catch in `routine-trigger.ts` keeps that failure from crashing anything,
but nothing on screen explains why, so don't turn `CLAUDE_DRAIN_ENABLED` on
until the token is actually in place.
