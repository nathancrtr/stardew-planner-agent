# v2: From workflow to agent — implementation plan & primer

v1 of this project is a **workflow**: Claude is called once, returns a complete placement
plan, and deterministic code executes it open-loop. Claude never learns whether anything
worked. v2 turns it into an **agent**: Claude stays in the loop, observes the results of
each action (including errors and screenshots), and decides what to do next. The code
around it — the part that executes Claude's requests and feeds back results — is the
**harness**.

This doc is both the implementation plan and a primer on the concepts involved, aimed at
an engineer who knows software but not LLM-agent plumbing.

---

## Primer: the concepts

### 1. Tool use ("function calling")

You don't give a model the ability to *do* anything. You give it a list of **tool
definitions** — name, description, and a JSON Schema for the arguments — alongside the
conversation. When the model wants to act, its response contains a structured `tool_use`
block instead of (or in addition to) prose:

```json
{ "type": "tool_use", "id": "toolu_abc", "name": "place_item",
  "input": { "item": "junimo-hut", "column": 36, "row": 38 } }
```

The model **emits a request; your code executes it**. This is the security and
correctness boundary of the whole design: the model can only do what you've given it a
tool for, with arguments validated against your schema, executed by code you wrote.

The tool *description* matters more than you'd expect — it's effectively documentation
the model reads to decide when and how to call the tool. Writing "Call this when..."
prose in descriptions is a real tuning lever, like naming in an API design review.

### 2. The agentic loop

The Claude API is **stateless** — each request must contain the entire conversation so
far. An agent is just this loop:

```
messages = [user request]
loop:
  response = api.create(model, system, tools, messages)
  messages.append(assistant: response.content)         # verbatim!
  if response.stop_reason != "tool_use": break          # model is done
  for each tool_use block in response.content:
      result = execute(block.name, block.input)         # the harness's job
  messages.append(user: [tool_result blocks])           # feedback
```

Two non-obvious rules:

- **Append `response.content` verbatim.** The response includes `thinking` blocks
  (the model's reasoning) that must be replayed unmodified on the next iteration —
  the API validates this. You never hand-edit history.
- **Every `tool_use` must get a matching `tool_result`** (paired by id) in the very
  next message, even if the tool failed. A model may request several tool calls in
  one response; all results go back in a single message.

The loop ends when the model stops requesting tools (`stop_reason: "end_turn"`). The
harness also imposes its own guards — a max-iteration cap so a confused model can't
loop forever, which is the agent equivalent of a watchdog timer.

### 3. Tool results are the feedback channel — errors are signal

In v1, "tile already holds iridium-sprinkler" was a log line for the human. In v2 it's
a `tool_result` the model reads:

```json
{ "type": "tool_result", "tool_use_id": "toolu_abc", "is_error": true,
  "content": "tile (36,38) already holds \"ancient-seeds\" — placement rejected" }
```

This is the entire difference between a workflow and an agent. Given that error, the
model can erase the crops, move the building, or rethink the layout — *because it saw
the error*. Harness design tip: error messages should be written for the model the way
you'd write them for a junior engineer — specific, actionable, naming the conflicting
object and coordinates.

### 4. Multimodal observations: screenshots as tool results

Tool results aren't limited to text — they can contain images. We give the model a
`screenshot` tool whose result is a PNG of the live board. Claude is natively
multimodal, so it can *look* at the farm it's building and catch problems no text
result would reveal (a field misaligned with a pond, a path that looks wrong). This is
the same pattern as Anthropic's "computer use": act → screenshot → assess → act.

Images cost tokens (roughly `width × height / 750`), so the harness clips screenshots
to the canvas rather than the whole window, and the system prompt tells the model to
screenshot at checkpoints rather than after every action.

### 5. Context growth and prompt caching

Because the API is stateless, the transcript is re-sent on every loop iteration — and
it only grows (every tool call, result, and screenshot accumulates). Two consequences:

- **Cost without caching would be quadratic-ish** in loop length. **Prompt caching**
  fixes this: the API caches the rendered prompt by *exact byte prefix*, so if each
  request = previous request + a bit more, everything before the new suffix is a cache
  read at ~10% of input price. The harness marks cache breakpoints to opt in. This is
  why the system prompt must be byte-stable (no timestamps!) and why we order content
  stable-first.
- **The context window is finite** (and screenshots are chunky). For our loop sizes
  (tens of turns) this is a non-issue; long-running agents use compaction/context
  editing, which we deliberately skip.

### 6. Structured outputs vs. tool use (what changed from v1)

v1 used **structured outputs**: one response, schema-enforced JSON, no further
interaction — right tool for a one-shot plan. In v2 the schemas move into the tool
definitions, and validation happens per-call. Same idea (typed contracts between model
and code), different interaction shape.

### 7. The system prompt is the spec

Domain knowledge (board geometry, anchor semantics, sprinkler coverage, one-object-per-
tile) moves from v1's planning prompt into the agent's **system prompt**, plus new
*operating* guidance: verify your work, screenshot at checkpoints, fix mistakes with
erase_area, stop when done. With strong instruction-following models, this file is
effectively the product spec — most behavior tuning happens here, not in code.

---

## Implementation plan

| Step | What | Where |
|---|---|---|
| 1 | **PlannerSession refactor** — browser lifecycle becomes a long-lived object: `open()`, `placeItem`, `fillArea`, `eraseArea`, `inspectArea`, `screenshot`, `switchLayout`, `savePlan`, `close()`. v1's `executePlan` reimplemented on top, so `--oneshot` keeps working. | `src/session.ts` |
| 2 | **Tool layer** — definitions (JSON Schema) + dispatcher mapping `tool_use` blocks onto session methods, returning `tool_result` content; screenshots return image blocks. Board mutations execute sequentially. | `src/tools.ts` |
| 3 | **The loop** — `claude-opus-4-8`, adaptive thinking, cached system prompt, the loop from §2 with a `--max-turns` guard (default 30), token-usage accounting, transcript saved to `runs/` for post-mortems. | `src/agent.ts` |
| 4 | **CLI** — agentic mode becomes the default; `--oneshot` selects v1. Existing flags (`--headless`, `--save`, `--pace`) unchanged. | `src/cli.ts` |
| 5 | **Verify E2E** — the junimo-hut prompt headless; success = the model places, observes at least one verification/screenshot, and recovers from at least one rejected placement without human help. Then README/NOTES, commit. | — |

### Tool surface (v2)

| Tool | Args | Returns |
|---|---|---|
| `place_item` | item, column, row | placed / specific rejection reason (`is_error`) |
| `fill_area` | item, column, row, width, height | corner-check summary |
| `erase_area` | column, row, width, height | tiles cleared |
| `inspect_area` | column, row, width, height | text grid of occupant ids (ground truth without image tokens) |
| `screenshot` | — | PNG of the board canvas (image block) |
| `switch_layout` | layout | ok |
| `save_plan` | — | shareable stardew.info URL |

Design choices worth noting: `inspect_area` exists because reading the board state as
text is ~50× cheaper in tokens than a screenshot and is exact — the model should prefer
it for verification and use `screenshot` for spatial/aesthetic judgment. `erase_area`
exists because an agent that can observe mistakes needs a way to *correct* them.
