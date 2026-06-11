import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import readline from "node:readline/promises";
import { catalogPromptText } from "./catalog.js";
import { PlannerSession } from "./session.js";
import { TOOLS, runTool } from "./tools.js";

const SYSTEM = `You are a Stardew Valley farm-layout agent driving the stardew.info/planner (V3)
board through tools. You design AND build the layout the user asks for, verifying your
work as you go. You may be in an ongoing design session: the user can send follow-up
requests that refer to things you built earlier ("move the flower patch right") — resolve
those references from the conversation and adjust the board accordingly.

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
- When the user asks you to modify something you built, erase exactly the affected region
  and rebuild it at the new location — don't disturb unrelated parts of the board. If a
  request is ambiguous, ask the user instead of guessing.
- The user may attach a reference image of a farm to recreate. Build a best-effort
  approximation: identify the major structures and fields, estimate their tile
  coordinates and sizes, build, then screenshot once to compare against the reference
  and fix the largest deviations. Substitute the closest catalog item for anything you
  can't identify exactly, and say what you approximated.
- When the build matches the request, stop and summarize what you built and where.
  Mention anything you had to adapt and why.

# Item catalog (exact ids)
${catalogPromptText()}`;

type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";
const IMAGE_MEDIA_TYPES: Record<string, ImageMediaType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * `/image <path> [instructions]` attaches a local image (e.g. a screenshot of a
 * farm to recreate) to the request; quote the path if it contains spaces.
 * Anything else passes through as plain text. Throws (before touching message
 * history) if the path is missing, unreadable, or not an image.
 */
export function toUserContent(text: string): string | Anthropic.ContentBlockParam[] {
  if (!/^\/image\b/.test(text)) return text;
  const rest = text.slice("/image".length).trim();
  const match = rest.match(/^"([^"]+)"\s*([\s\S]*)$/) ?? rest.match(/^(\S+)\s*([\s\S]*)$/);
  if (!match) throw new Error("usage: /image <path> [instructions]");
  const [, path, instructions] = match;
  const mediaType = IMAGE_MEDIA_TYPES[extname(path).toLowerCase()];
  if (!mediaType) {
    throw new Error(`unsupported image type "${extname(path) || path}" — use .png/.jpg/.jpeg/.webp/.gif`);
  }
  const data = readFileSync(path);
  return [
    { type: "image", source: { type: "base64", media_type: mediaType, data: data.toString("base64") } },
    {
      type: "text",
      text: instructions.trim() || "Recreate the farm layout in this image on the board, as closely as you reasonably can.",
    },
  ];
}

export interface AgentOptions {
  headless?: boolean;
  pace?: number;
  save?: boolean;
  maxTurns?: number;
  model?: string;
}

interface AgentContext {
  client: Anthropic;
  session: PlannerSession;
  messages: Anthropic.MessageParam[];
  usage: { in: number; out: number; cacheRead: number; cacheWrite: number };
  model: string;
  maxTurnsPerRequest: number;
  totalTurns: number;
  transcriptPath: string;
  firstRequest: string;
}

async function openContext(request: string, opts: AgentOptions): Promise<AgentContext> {
  console.log("opening stardew.info/planner...");
  const session = await PlannerSession.open({ headless: opts.headless, pace: opts.pace });
  mkdirSync("runs", { recursive: true });
  return {
    client: new Anthropic(),
    session,
    messages: [],
    usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
    model: opts.model ?? "claude-opus-4-8",
    maxTurnsPerRequest: opts.maxTurns ?? 30,
    totalTurns: 0,
    transcriptPath: `runs/run-${Date.now()}.json`,
    firstRequest: request,
  };
}

/**
 * One operator request: append it, then run the agent loop (stream → execute
 * tools → feed back results) until the model ends its turn.
 */
async function agentTurn(ctx: AgentContext, userContent: string | Anthropic.ContentBlockParam[]): Promise<void> {
  ctx.messages.push({ role: "user", content: userContent });

  let turns = 0;
  while (turns < ctx.maxTurnsPerRequest) {
    turns++;
    ctx.totalTurns++;
    process.stdout.write(`\n⏳ turn ${ctx.totalTurns}: Claude is working...`);

    // Stream so the user sees reasoning/commentary live instead of a long
    // silent pause while the whole turn generates.
    const stream = ctx.client.messages.stream({
      model: ctx.model,
      max_tokens: 64000,
      thinking: { type: "adaptive", display: "summarized" },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      messages: ctx.messages,
      cache_control: { type: "ephemeral" }, // auto-cache the growing transcript
    });

    const DIM = "\x1b[2m";
    const RESET = "\x1b[0m";
    let firstOutput = true;
    const clearStatus = () => {
      if (firstOutput) {
        process.stdout.write("\r\x1b[2K"); // erase the "working..." status line
        firstOutput = false;
      }
    };
    for await (const event of stream) {
      if (event.type === "content_block_start") {
        clearStatus();
        if (event.content_block.type === "thinking") process.stdout.write(`\n${DIM}💭 `);
        else if (event.content_block.type === "text") process.stdout.write(`${RESET}\n🗨  `);
        else if (event.content_block.type === "tool_use") process.stdout.write(RESET);
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "thinking_delta") process.stdout.write(event.delta.thinking);
        else if (event.delta.type === "text_delta") process.stdout.write(event.delta.text);
      } else if (event.type === "content_block_stop") {
        process.stdout.write(RESET);
      }
    }
    process.stdout.write(`${RESET}\n`);
    const response = await stream.finalMessage();

    ctx.usage.in += response.usage.input_tokens;
    ctx.usage.out += response.usage.output_tokens;
    ctx.usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
    ctx.usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;

    // Replay the assistant turn verbatim (thinking blocks included — required).
    ctx.messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      if (response.stop_reason !== "end_turn") console.log(`(stopped: ${response.stop_reason})`);
      break;
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of toolUses) {
      const outcome = await runTool(ctx.session, call.name, call.input as Record<string, unknown>);
      console.log(`${outcome.isError ? "✗" : "✓"} [turn ${ctx.totalTurns}] ${call.name}(${shortArgs(call.input)}) — ${outcome.log}`);
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: outcome.content,
        is_error: outcome.isError,
      });
    }
    ctx.messages.push({ role: "user", content: results });
  }

  if (turns >= ctx.maxTurnsPerRequest) {
    console.log(`\n⚠ hit the --max-turns guard (${ctx.maxTurnsPerRequest}) for this request — returning control`);
  }

  saveTranscript(ctx); // incremental: survives Ctrl-C / crashes mid-session
}

function saveTranscript(ctx: AgentContext): void {
  writeFileSync(
    ctx.transcriptPath,
    JSON.stringify(
      { request: ctx.firstRequest, model: ctx.model, turns: ctx.totalTurns, usage: ctx.usage, messages: ctx.messages },
      scrubImages,
      2,
    ),
  );
}

async function wrapUp(ctx: AgentContext, headless: boolean): Promise<void> {
  mkdirSync("screenshots", { recursive: true });
  const shot = `screenshots/agent-${Date.now()}.png`;
  writeFileSync(shot, await ctx.session.screenshot());
  saveTranscript(ctx);
  console.log(`\nfinal screenshot: ${shot}`);
  console.log(`transcript: ${ctx.transcriptPath}`);
  console.log(
    `usage: ${ctx.totalTurns} turns, in=${ctx.usage.in} out=${ctx.usage.out} cache_read=${ctx.usage.cacheRead} cache_write=${ctx.usage.cacheWrite}`,
  );
  if (!headless) await ctx.session.page.waitForTimeout(3000);
}

/** One-shot mode: a single operator request, then exit. */
export async function runAgent(request: string, opts: AgentOptions = {}): Promise<void> {
  const ctx = await openContext(request, opts);
  try {
    await agentTurn(
      ctx,
      toUserContent(opts.save ? `${request}\n\n(When you're done, call save_plan and give me the share URL.)` : request),
    );
    await wrapUp(ctx, opts.headless ?? false);
  } finally {
    await ctx.session.close();
  }
}

/**
 * Buffers stdin lines so input typed (or piped) while the agent is busy isn't
 * lost — plain readline.question() drops lines that arrive with no question
 * pending.
 */
function lineSource(): { next: () => Promise<string | null>; close: () => void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const queued: string[] = [];
  let pending: ((line: string | null) => void) | null = null;
  let closed = false;
  rl.on("line", (line) => {
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve(line);
    } else {
      queued.push(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve(null);
    }
  });
  return {
    next: () => {
      if (queued.length > 0) return Promise.resolve(queued.shift()!);
      if (closed) return Promise.resolve(null);
      process.stdout.write("\nyou> ");
      return new Promise((resolve) => {
        pending = resolve;
      });
    },
    close: () => rl.close(),
  };
}

/** Interactive mode: a conversational design session at a REPL prompt. */
export async function runInteractive(initialRequest: string | undefined, opts: AgentOptions = {}): Promise<void> {
  const ctx = await openContext(initialRequest ?? "(interactive session)", opts);
  const input = lineSource();
  try {
    if (initialRequest) await agentTurn(ctx, toUserContent(initialRequest));
    else console.log("interactive session — describe what to build ('/image <path>' to attach a reference, 'exit' to finish)");

    while (true) {
      const line = await input.next();
      if (line === null) break; // Ctrl-D / closed stdin
      const text = line.trim();
      if (!text) continue;
      if (["exit", "quit", "q"].includes(text.toLowerCase())) break;
      let content: string | Anthropic.ContentBlockParam[];
      try {
        content = toUserContent(text);
      } catch (e) {
        console.error(`✗ ${e instanceof Error ? e.message : e}`);
        continue;
      }
      await agentTurn(ctx, content);
    }

    if (opts.save) await agentTurn(ctx, "We're done — call save_plan and give me the share URL.");
    await wrapUp(ctx, opts.headless ?? false);
  } finally {
    input.close();
    await ctx.session.close();
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
