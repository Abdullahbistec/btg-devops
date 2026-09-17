# Getting Summarize working inside the Docker container

The container runs audits and cost refresh fine — `web/lib/scheduler.ts`'s
in-process poller is exactly what it was built for. Summarize does not work
inside it yet, and turning `CLAUDE_DRAIN_ENABLED` back on without the two
things below would just make it fail silently instead of visibly.

## What's missing

1. **The `claude` CLI.** Not installed in the image. Add to the Dockerfile's
   runtime stage (already `node:24-alpine`, so this is cheap):
   ```dockerfile
   RUN npm install -g @anthropic-ai/claude-code
   ```

2. **Auth.** `claude -p` needs a logged-in session — on a host that's
   `~/.claude/.credentials.json` plus `~/.claude.json`. Two ways to provide
   that inside a container, and they carry different weight:

   - **Mount a host account's credentials** (read-only volume mapping
     `~/.claude` into the container). Simplest, but it means the drain runs
     *as that person's Claude account* inside a server process — whoever's
     credentials those are should be the one deciding to do this, not
     something wired in as a default.
   - **A service-style credential** (if/when Anthropic offers one suited to
     unattended containers) — the cleaner long-term answer, not something
     this repo can set up unilaterally today.

## Once both exist

Set `CLAUDE_DRAIN_ENABLED=1` back in `docker-compose.yml`'s `environment:`
block (removing the override added alongside this file), rebuild, and
verify the same way the host setup was verified: queue a Summarize request,
confirm `docker logs` shows `claude -p` actually invoked, and confirm the
request reaches `done` rather than sitting `pending`.

## Until then

Leave `CLAUDE_DRAIN_ENABLED=0` in the compose file. Summarize clicks queue a
row and wait for something else to drain it — the host's manual
`btg-devops.exe mcp --http` + a live Claude Code session, same as before
Docker existed.
