# v3: Interactive shell — implementation plan & primer

v2 made the agent closed-loop with respect to *the board*: it sees the results of its own
actions. v3 makes it closed-loop with respect to *the operator*: after a build finishes,
control returns to you, and you can steer with follow-ups like "move the flower patch
three tiles to the right" — a conversational design session instead of a one-shot command.

## Primer: the concepts

### 1. The surprising part: this is almost free

A senior engineer's instinct is that "remembering the session" requires building memory —
a database of what was placed where, an entity store to resolve "the flower patch", etc.
It doesn't. Recall from v2 that the API is stateless and we re-send the full transcript
(`messages[]`) on every call. That transcript already *is* the memory. Every tool call the
agent made ("fill_area tulips at (40,30) 6x5"), every result, every screenshot it took —
all of it is in context on the next request.

So when you say "move the flower patch three tiles right," the model resolves the
reference the same way a human collaborator would: it remembers placing tulips at
(40,30) *because the conversation says so*, and translates your request into
`erase_area(40,30,6,5)` + `fill_area(43,30,6,5)`. Reference resolution ("it", "the
patch", "that field") is a language problem, and the language model is the component
that's good at it. The engineering work is just: **don't throw the transcript away
between user inputs.**

### 2. Two kinds of state, one invariant

| State | Lives in | Persists across user turns by... |
|---|---|---|
| Conversation (what was said/done/seen) | `messages[]` array | not resetting the array |
| World (the actual board) | the browser tab | not closing the browser |

The invariant that keeps the agent grounded: the conversation must never *claim* more
than the world contains. This is why the agent verifies with `inspect_area` after
mutating — if the user hand-edits the board mid-session (or an action silently fails),
the transcript's beliefs go stale. Tools that read the world are the re-sync mechanism.

### 3. The turn hierarchy

The shell adds one outer loop around v2's inner loop:

```
REPL loop (one iteration per operator input):
  read user line  ──▶  append to messages
  agent loop (v2, unchanged):
    call API → execute tool_use → append results → repeat until end_turn
  control returns to the prompt          ◀── stop_reason: "end_turn" is the handoff
```

`stop_reason: "end_turn"` is doing new work here: in v2 it meant "the program is done";
now it means "the agent yields the floor." This is exactly how chat agents (Claude Code
included) are structured: an agentic loop nested inside a conversation loop. A nice
side effect: the agent can now *ask you questions* ("the field doesn't fit there —
shrink it or relocate it?") and your answer arrives as just another user turn.

### 4. Context growth is now unbounded — in theory

A one-shot run had a natural ceiling on transcript length. A conversation doesn't: every
follow-up stacks more turns (and screenshots) into context. Prompt caching keeps the
*cost* manageable (each request re-reads the prefix at ~10%), but the context window is
finite. At our scale — dozens of turns, a handful of screenshots — this is comfortably a
non-issue; production chat agents handle it with **compaction** (summarize old history
into a shorter block) or **context editing** (prune stale tool results). We note the
cliff and don't build the bridge: the shell prints cumulative token usage on exit so
you can see how far away the cliff actually is.

### 5. Sessions end; transcripts shouldn't

Crash-safety changes shape: a one-shot run could save its transcript at the end, but an
interactive session ends whenever the operator wanders off or Ctrl-C's. So the shell
writes the transcript to `runs/` incrementally after every agent turn — the post-mortem
record survives any exit path.

## Implementation plan

| Step | What | Where |
|---|---|---|
| 1 | **Extract `agentTurn()`** — v2's inner loop (stream → execute tools → until `end_turn`) refactored to operate on a shared context (client, session, messages, usage) so it can be invoked repeatedly. One-shot mode becomes "open session, one `agentTurn`, wrap up." | `src/agent.ts` |
| 2 | **REPL** — `node:readline/promises` prompt (`you> `). Each line → `agentTurn()`. `exit`/`quit`/Ctrl-D ends the session (final screenshot, usage summary). Transcript written after every turn. | `src/agent.ts` |
| 3 | **CLI** — `--interactive` / `-i` flag. With an initial request: build it, then drop into the shell. Without: straight into the shell. | `src/cli.ts` |
| 4 | **Verify** — scripted stdin: turn 1 places something, turn 2 says "move it three tiles to the right" — passes iff the agent resolves "it", erases the original, and re-places at the offset. | — |

Deliberately out of scope: interrupting the agent mid-turn (needs request abort +
careful transcript repair), compaction (see §4), and slash-commands beyond `exit` —
anything you'd type ("take a screenshot", "save the plan") is already a capability the
model has via tools, so plain language is the command set.
