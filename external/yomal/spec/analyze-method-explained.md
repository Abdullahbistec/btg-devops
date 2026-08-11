# How Analyze works: old method vs. new (deep research)

A simple explanation of what changed and why the results are more trustworthy now.

## Old method

Think of it as asking one question and getting one answer, instantly.

- The dashboard sent one resource type's data to an AI model, with one generic instruction:
  *"Find all problems, as a senior DevOps engineer would."*
- The model answered once, in one pass. No second look, no fact-checking itself.
- **Severity was guessed from the category, not the actual risk.** Anything security-related
  tended to get marked Critical, whether or not it was actually urgent or easy to fix.
- Each resource type was judged completely alone — Cosmos DB was never compared against IAM or
  Key Vault, so connected problems (a public app → its identity → a Key Vault → real credentials)
  could never be noticed.
- If the model didn't have enough data to check something, it either skipped it quietly or
  guessed — you had no way to know what it couldn't actually verify.
- Fast (~5-15 seconds) and cheap, but shallow by design.

**Result:** a handful of generic findings per run, an unreliable Critical column, no real
investigation.

## New method — deep research

Think of it as a real investigator working a case, not answering a quiz question.

The agent is now required to go through **5 steps**, every time, for every scope:

1. **Build the map first.** Before judging anything, it looks around — other resource types, cost
   data, usage data, and history from past audits — to understand the environment (which resource
   groups are production vs. test, what the spend pattern looks like, etc.).
2. **Cross-check data types together.** Configuration + cost + usage, for the same resource, to
   catch waste that's invisible if you only look at one of those at a time.
3. **Connect small facts into real chains.** Individually minor issues get linked together into one
   real finding — e.g. "this public-facing app has an identity that can reach this Key Vault that
   holds production credentials" — instead of three separate, disconnected notes.
4. **Judge severity using the environment map, not just the category.** A security-related issue on
   a dev/test resource is treated differently from the same issue in production.
5. **Try to disprove every Critical before reporting it.** If a Critical doesn't survive that
   check, it gets downgraded or dropped. A wrong Critical is treated as worse than a missed one.

On top of that:

- **Every finding must show its evidence** — the exact data field/value that proves the problem,
  not a vague claim.
- **Every finding gets a `fix_effort`** (quick / moderate / complex), so "critical but a 2-minute
  fix" is now visibly different from "critical and a real project."
- **It records what it couldn't check** (`data_gaps`) — so gaps in the data are visible and
  trackable, instead of silently producing a wrong or guessed answer.
- **It runs as a real multi-step agent**, not one instant API call — which is also why it now
  takes minutes instead of seconds. That extra time is what makes steps 1-5 possible.

**Result:** fewer, better-evidenced findings; a Critical label you can actually trust; and — most
importantly — the kind of connected, "took real digging to find" issue that used to require a
human spending hours on it. In the very first real run, this is exactly what happened: the agent
noticed cost data mentioned a Virtual Machine that no data collector was even tracking — a real
blind spot a shallow, one-pass check would never have caught.

## In one sentence

**Old:** ask once, answer once, guess at severity, don't compare anything.
**New:** investigate properly, check your own work, judge severity in context, and say what you
still don't know.
