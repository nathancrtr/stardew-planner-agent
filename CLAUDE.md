# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An AI agent that builds Stardew Valley farm layouts on the live site stardew.info/planner via Playwright browser automation. Claude (via the Anthropic API) drives a real browser through tools, observes results, and self-corrects. Requires `ANTHROPIC_API_KEY` in `.env` (see `.env.example`).

## Commands

```sh
npm install && npx playwright install chromium   # one-time setup
npm run typecheck                                # tsc --noEmit — the only check; there are no tests or linter
npm run agent -- "<request>"                     # agentic mode (headed browser, watchable)
npm run agent -- -i                              # interactive REPL session
npm run agent -- --oneshot "..." --dry-run       # v1: plan only, no browser, prints JSON
npm run agent -- "..." --headless                # software-GL browser (CI/sandbox-friendly)
npx tsx src/dump-catalog.ts                      # regenerate data/catalog.json from the live site
npm run probe                                    # reverse-engineering probe against the live site
```

Runs in TypeScript directly via `tsx` — there is no build step. Anything that opens a browser hits the real stardew.info site and (non-`--dry-run`) calls the Anthropic API, so it costs time and tokens.

## Architecture

Two independent modes share `src/cli.ts` as entry point and `src/catalog.ts` for item data:

**v2 agentic loop (default)** — `src/agent.ts` runs the loop: stream a Claude turn → execute its `tool_use` blocks via `src/tools.ts` → append `tool_result`s → repeat until `end_turn`. `src/tools.ts` defines the tool schemas (descriptions are the model's documentation — write them for the model) and dispatches onto `src/session.ts`, a long-lived `PlannerSession` wrapping one Playwright page. Interactive mode reuses the same loop, appending each REPL line to the same `messages` array so follow-ups can reference earlier work. Prompt caching: system prompt and growing transcript both carry `cache_control`. Assistant turns are replayed verbatim into history (thinking blocks included — required by the API).

**v1 oneshot (`--oneshot`)** — `src/plan.ts` gets a full plan in one structured-output call (`zodOutputFormat` + `messages.parse`, schemas in `src/types.ts`), then `src/executor.ts` executes it open-loop with no feedback to the model.

**The planner site** is a PixiJS canvas app with no DOM menus; everything goes through the global `window.planner` object. `PlannerSession` selects items via `planner.changeGhostSprite(...)` then places them with real mouse events (so the app's own pointer pipeline runs), converts tiles to page coords via `plannerSpriteContainer.toGlobal`, and verifies against `planner.tiles`. `NOTES.md` is the authoritative reverse-engineering reference (coordinate system, boot sequence, `window.planner` API) — read it before touching `session.ts`, and update it if you learn something new about the site.

## Critical gotchas (from NOTES.md — they will bite)

- `page.evaluate` must receive **code as strings**, not function callbacks: tsx/esbuild injects a `__name` helper that doesn't exist in the page context.
- Never wait for `networkidle` (ad endpoints never settle); use `domcontentloaded` + explicit waits.
- The "Low PERFORMANCE" modal appears seconds *after* load under software GL and silently eats canvas clicks — `session.ts` dismisses modals before actions and retries once; preserve that pattern.
- Coordinates: column 0 = left, row 0 = **top**. `place_item` anchors at the **bottom-left** tile (buildings extend right and up); `fill_area`/`erase_area`/`inspect_area` anchor at the **top-left**.
- Crop ids are SEED ids (`ancient-seeds`, not `ancient-fruit`).

## Artifacts

`runs/` (agentic transcripts, images scrubbed), `plans/` (v1 plan JSON), `screenshots/` (board PNGs + probe dumps, including `planner-bundle.js` — the site's bundle, kept for grepping). All are generated output, not source.

## Docs

`docs/agent-harness.md` (loop architecture + agent-concepts primer) and `docs/interactive-shell.md` (conversation state vs. world state) explain design decisions; keep them current if you change the corresponding behavior.
