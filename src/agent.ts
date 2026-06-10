import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { catalogPromptText } from "./catalog.js";
import { PlannerSession } from "./session.js";
import { TOOLS, runTool } from "./tools.js";

const SYSTEM = `You are a Stardew Valley farm-layout agent driving the stardew.info/planner (V3)
board through tools. You design AND build the layout the user asks for, verifying your
work as you go.

# Board model
- The board is a tile grid. The REGULAR farm is 80 columns x 65 rows; column 0 is the left
  edge, row 0 is the TOP edge (rows increase downward).
- On the regular farm the farmhouse sits with anchor at (column 59, row 16) (9x5 footprint,
  extending right and up from there) and the greenhouse at (column 24, row 17) (7x8). Leave
  those areas clear. The top ~10 rows, the far edges, and scattered ponds/cliffs are
  unbuildable; prefer the open central farmland (roughly columns 6-72, rows 18-60) unless
  the user directs otherwise.
- A tile holds exactly ONE object. Crops cannot share a tile with sprinklers, scarecrows,
  paths, or buildings. Place buildings/sprinklers FIRST, then fill crops around them —
  fill_area skips occupied tiles automatically.

# Game knowledge
- Crops are placed via their SEED id (ancient fruit -> "ancient-seeds", melons -> "melon-seeds").
- Iridium sprinklers water a 5x5 area centered on themselves; quality sprinklers 3x3;
  regular sprinklers the 4 adjacent tiles. Scarecrows cover a radius of 8. Junimo huts
  harvest a 17x17 area centered on the hut.

# How to work
- Plan briefly, then act. Place, then VERIFY with inspect_area (cheap and exact). Take a
  screenshot at most a couple of times — typically once at the end to confirm the overall
  layout looks right.
- When a placement is rejected, read the error: if the tile holds something you placed by
  mistake, erase_area and redo; if the area is unbuildable terrain, relocate deliberately
  (shift the whole structure, don't just nudge one tile).
- Keep going until the build matches the request; then stop and summarize what you built
  and where. Mention anything you had to adapt and why.

# Item catalog (exact ids)
${catalogPromptText()}`;

export interface AgentOptions {
  headless?: boolean;
  pace?: number;
  save?: boolean;
  maxTurns?: number;
  model?: string;
}

export async function runAgent(request: string, opts: AgentOptions = {}): Promise<void> {
  const model = opts.model ?? "claude-opus-4-8";
  const maxTurns = opts.maxTurns ?? 30;
  const client = new Anthropic();

  console.log("opening stardew.info/planner...");
  const session = await PlannerSession.open({ headless: opts.headless, pace: opts.pace });

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: opts.save
        ? `${request}\n\n(When you're done, call save_plan and give me the share URL.)`
        : request,
    },
  ];

  const usage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  let turns = 0;

  try {
    while (turns < maxTurns) {
      turns++;
      const response = await client.messages.create({
        model,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        tools: TOOLS,
        messages,
        cache_control: { type: "ephemeral" }, // auto-cache the growing transcript
      });

      usage.in += response.usage.input_tokens;
      usage.out += response.usage.output_tokens;
      usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
      usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;

      // Replay the assistant turn verbatim (thinking blocks included — required).
      messages.push({ role: "assistant", content: response.content });

      for (const block of response.content) {
        if (block.type === "text" && block.text.trim()) console.log(`\n🗨  ${block.text.trim()}\n`);
      }

      if (response.stop_reason !== "tool_use") {
        if (response.stop_reason !== "end_turn") {
          console.log(`(stopped: ${response.stop_reason})`);
        }
        break;
      }

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of toolUses) {
        const outcome = await runTool(session, call.name, call.input as Record<string, unknown>);
        console.log(`${outcome.isError ? "✗" : "✓"} [turn ${turns}] ${call.name}(${shortArgs(call.input)}) — ${outcome.log}`);
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: outcome.content,
          is_error: outcome.isError,
        });
      }
      messages.push({ role: "user", content: results });
    }

    if (turns >= maxTurns) {
      console.log(`\n⚠ hit the --max-turns guard (${maxTurns}) — stopping the loop`);
    }

    mkdirSync("screenshots", { recursive: true });
    const shot = `screenshots/agent-${Date.now()}.png`;
    writeFileSync(shot, await session.screenshot());
    console.log(`\nfinal screenshot: ${shot}`);

    mkdirSync("runs", { recursive: true });
    const transcript = `runs/run-${Date.now()}.json`;
    writeFileSync(transcript, JSON.stringify({ request, model, turns, usage, messages }, scrubImages, 2));
    console.log(`transcript: ${transcript}`);
    console.log(
      `usage: ${turns} turns, in=${usage.in} out=${usage.out} cache_read=${usage.cacheRead} cache_write=${usage.cacheWrite}`,
    );

    if (!(opts.headless ?? false)) await session.page.waitForTimeout(3000);
  } finally {
    await session.close();
  }
}

function shortArgs(input: unknown): string {
  const s = JSON.stringify(input);
  return s.length > 90 ? s.slice(0, 87) + "..." : s;
}

/** Keep transcripts readable: replace base64 image payloads with a placeholder. */
function scrubImages(_key: string, value: unknown): unknown {
  if (
    typeof value === "object" && value !== null &&
    (value as { type?: string }).type === "base64" &&
    typeof (value as { data?: string }).data === "string"
  ) {
    return { type: "base64", media_type: (value as { media_type?: string }).media_type, data: "<image omitted>" };
  }
  return value;
}
