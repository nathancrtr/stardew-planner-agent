import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import readline from "node:readline/promises";
import { catalogPromptText } from "./catalog.js";
import { PlannerSession } from "./session.js";
import { TOOLS, runTool, type ReferenceImage } from "./tools.js";

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
  those areas clear. Both already exist on the board as map fixtures; their appearance in
  a reference image can vary (e.g. the greenhouse may be shown ruined/under construction
  or completed, and other tools may draw them elsewhere). When recreating from a
  reference, don't place buildings to duplicate them — if a placement is rejected because
  the tile holds "greenhouse" or "farmhouse", the building you saw is that fixture. The top ~10 rows, the far edges, and scattered ponds/cliffs are
  unbuildable — inspect_area renders unbuildable tiles as "~"; prefer the open central
  farmland (roughly columns 6-72, rows 18-60) unless the user directs otherwise.
- A tile holds exactly ONE object. Crops cannot share a tile with sprinklers, scarecrows,
  paths, or buildings. Place buildings/sprinklers FIRST, then fill crops around them —
  fill_area skips occupied tiles automatically.
- Building roof sprites extend ~2 rows ABOVE the footprint anchor. Any tile in those rows
  is "part of the building" — erase_area or place_item there removes or conflicts with the
  whole structure. Never erase a single tile immediately north of a building without
  expecting the building itself to disappear. Keep that strip clear when routing
  fences, gates, and paths along a building's north side.
- Objects placed at row numbers LOWER than (north of / above) a building are drawn BEHIND
  the building's roof sprite in the top-down view and become invisible. Place crafting
  yards, service areas, and decorative clusters at the SAME row or HIGHER row number
  (south of / below) the building they belong to — never tuck them into the rows directly
  above a building.
- Grass: the only grass ids that render as a continuous, blended lawn are the bases "grass"
  and "blue-grass". The numbered/seasonal variants ("grass-1", "grass-summer", "blue-grass-2",
  ...) do NOT blend — they draw as a rigid grid of identical sprites. Always fill grass with
  "grass" (or "blue-grass"), and fill a contiguous lawn with a SINGLE base id; don't mix the
  two within one patch or a seam appears.

# Game knowledge
- Crops are placed via their SEED id (ancient fruit -> "ancient-seeds", melons -> "melon-seeds").
- Iridium sprinklers water a 5x5 area centered on themselves; quality sprinklers 3x3;
  regular sprinklers the 4 adjacent tiles. Scarecrows cover a radius of 8. Junimo huts
  harvest a 17x17 area centered on the hut.

# Design principles (for layouts YOU design)
When the layout is your design rather than a reference recreation, a valid board is not
enough — it must play well and look intentional:
- Zone by visit frequency, anchored on the farmhouse. The farmer starts every day at the
  farmhouse door (the south side of the house, just below row 16). Daily-visit zones —
  crop fields, kegs/preserves, the shipping point — go nearest the house; periodic zones
  (barn, coop, silo) in the next ring out; rarely visited or purely decorative zones at
  the periphery. A field 20 tiles closer to the door saves walking time every in-game day.
- Keep entrances clear. Building doors are on the SOUTH (bottom) edge; the catalog marks
  the door column as "door+N" (N columns right of the building's LEFT edge), and
  place_item reports each placed building's door tile. On the regular farm the farmhouse
  door's approach tile is (64,17) and the greenhouse's is (27,18). Leave at least 2 tiles
  of open ground south of every building, route a path spur to the door tile itself, and
  immediately fix any blocked-door WARNING a tool reports.
- Paths exist to be walked — and to create zones. Lay a path only between two real
  destinations (house to field, field to barn, map exits); every path must start and end
  at something meaningful. No stubs, no dead ends. Beyond connection: use internal paths
  to divide large functional areas into distinct sub-zones, sized and shaped to match the
  design intent. Sub-zones give each area its own identity and make the farm feel composed
  rather than monolithic — but whether those sub-zones are small irregular garden plots or
  large geometric blocks depends on the aesthetic the user is asking for.
- Decor must make contextual sense. Indoor furniture (tables, chairs, dressers, beds) does
  not belong in open fields; outdoors, decorate with fences, flooring, lighting, flowers,
  and trees. When you group objects (e.g. seating), orient and adjoin them socially: chairs
  face each other across a table or fire — never away from it into empty space. A bench
  faces a view (pond, field, tree). The planner has NO furniture rotation and no
  directional seating variants: each chair/bench has ONE fixed facing baked into its
  sprite, and that direction VARIES by item (some face south, some left/right). You can't
  rotate a seat to fix it — so after placing seating near a focal point, screenshot and
  CHECK which way it actually faces. If it points away from the pond/fire/table, either
  move it to the opposite side of the focal point (so its fixed facing now looks toward it)
  or swap to a different seating item whose facing suits the spot. Verify by screenshot
  rather than assuming a direction. A lamp belongs at a path junction or building entrance,
  not floating mid-field — and place them at intervals along main paths (every 6–10 tiles)
  to give the daily route warmth and rhythm, not only at endpoints. Lonely singletons feel
  abandoned; cluster decorative objects in groups of 3–5, mixing types (lamp + bench +
  flowers ≠ three lamps in a row). Give every building a small yard: a 2–3 tile strip of
  flowers, low fencing, or decorative elements on its south and east faces. A building with
  nothing around it reads as dropped, not placed.
- Water features are destinations, not obstacles. Every natural pond should have a path
  leading to its nearest shore, seating arranged to face the water, and flowers or lighting
  framing the bank. A pond with paths routed around it rather than toward it, or with no
  composed seating facing it, is a missed focal point.
- Functional zones (sprinkler grids, fenced enclosures, building clusters) should be
  grid-aligned — regularity signals intention. Let the user's stated aesthetic guide how
  decorative and transitional zones are treated: organic irregularity for naturalistic
  styles; crisp alignment and consistent spacing for geometric or formal styles. Read the
  brief and apply accordingly — don't impose one style on a layout that calls for another.
- Fill every zone completely before moving on. After placing functional elements
  (buildings, sprinklers, paths), survey remaining ground in that zone and fill it with
  varied, appropriate decoration: mixed floor types, plants, flowers, ground cover, small
  accent objects. Use the full range of available types within each category — multiple
  flower species, multiple floor textures, mixed tree varieties — rather than repeating
  one element across a whole area. Bare terrain between buildings or at zone edges signals
  an unfinished layout. The density and character of the fill should match the stated
  aesthetic, but every zone should feel inhabited and considered.
- Compact beats sprawling: tight rectangular fields sized to sprinkler grids, consistent
  spacing, repeated patterns. Alignment and symmetry read as intentional; scattered
  singletons read as noise.

# How to work
- SURVEY before you build. On a fresh board, take ONE screenshot first and note where
  ponds, cliffs, and other unbuildable terrain sit, then design around them — a building
  placed blind onto water wastes a whole correction cycle. Where a zone borders suspect
  terrain, confirm the exact boundary with inspect_area ("~" = unbuildable) before
  committing buildings to it.
- For a new build that YOU are designing, start your reply with a short design brief
  BEFORE the first placement: each zone as a named coordinate rectangle (e.g. "crop field:
  (48,22) 15x10"), plus one sentence tracing the daily route (farmhouse door -> ... ->
  back). Then build the brief; if terrain forces a change, restate the affected part of
  the brief rather than improvising. Skip the brief for small edits and for reference
  recreations — there, the reference is the brief.
- Your design brief is a commitment, not a draft. Once you have printed the brief and
  begun placing, do NOT re-derive zone coordinates or re-plan road rows in later thinking
  — read the coordinates off the brief and execute. Re-plan a zone only when a tool result
  (rejected placement, terrain conflict) forces it, and then restate only the affected
  rectangle. If you find yourself reconsidering something you already decided, stop and
  place.
- When a path or fence will need a gap for a gate or door, place the gate/door FIRST,
  then fill the path or fence around it — fills skip occupied tiles automatically. Do not
  pave a continuous line and then erase part of it to insert the gate; that risks pulling
  in adjacent objects.
- Place, then VERIFY with inspect_area (cheap and exact). Take a screenshot at most a
  couple of times — typically the initial terrain survey and once at the end to confirm
  the overall layout looks right.
- Before filling ANY region that borders water or cliffs, call inspect_area on the exact
  target rectangle first and confirm it contains no "~" tiles. Grass and flowers have a
  loose restriction layer and the planner WILL let them land on water, where they render as
  objects floating on the pond. If "~" tiles appear in the rectangle, split the fill into
  sub-rectangles that avoid them — never fill straight across a pond. A fill_area WARNING
  about overlapping restricted terrain means you already painted onto water: erase and
  re-fill around it.
- Batch related placements in one turn, but keep a batch to about 15 tool calls. Beyond
  that, errors pile up faster than you can react to them — a smaller batch lets you read
  the results and adapt before committing the next zone.
- When a placement is rejected, read the error: if the tile holds something you placed by
  mistake, erase_area and redo; if the result says restricted terrain, relocate
  deliberately (shift the whole structure, don't just nudge one tile) — retrying the
  same coordinates can never succeed.
- Use place_item (not fill_area) for single tiles. A 1×1 fill_area drag has zero
  distance and frequently places nothing. If you need one tile of flooring or a single
  decorative object, use place_item; only use fill_area for regions of 2 or more tiles.
  If a fill_area returns 0 placed on unrestricted ground, do NOT retry the same call —
  switch to place_item or widen the region.
- Before routing a path across a region you already filled (flowers, crops, grass),
  remember those tiles are occupied — the fill will mostly skip. Route paths through
  ground you left bare or explicitly designated as path. If you are unsure whether a
  strip is free, inspect_area it before committing the path, not after.
- When a tool result surprises you and you need to experiment (an item that won't place,
  odd registration), probe on VERIFIED ground: erase a tile where a placement just
  succeeded, run the test there, then erase the test object. On unverified ground the
  experiment is confounded — you can't tell an item problem from a terrain problem.
- When the user asks you to modify something you built, erase exactly the affected region
  and rebuild it at the new location — don't disturb unrelated parts of the board. If a
  request is ambiguous, ask the user instead of guessing.
- The user may attach a reference image of a farm to recreate. At full-image scale a
  1x1 object (sprinkler, scarecrow, torch) is only a few pixels — you WILL miss them
  unless you look closer. So inventory first: zoom_reference into each major area and
  list what is actually there before placing anything. Inside crop fields, regularly
  spaced non-crop dots are usually sprinklers — infer the type from the spacing
  (iridium every 5th tile, quality every 3rd). Recreate only what the reference shows:
  do not add objects it doesn't contain, and don't omit ones it does. Then build,
  screenshot once, compare against the reference, and fix the largest deviations.
  Substitute the closest catalog item for anything you can't identify exactly, and say
  what you approximated.
- Before declaring a design of yours done: take a screenshot, examine it zone by zone,
  and work through this checklist — fix anything that fails before summarizing:
  (1) Clear approach in front of every building entrance — at least 2 tiles of open ground.
  (2) Every path connects two real destinations — no stubs, no dead ends.
  (3) Daily-visit zones sit close to the farmhouse.
  (4) Nothing is contextually out of place (no indoor furniture outdoors, etc.).
  (5) Every furniture grouping has social logic: chairs face each other or a focal point
      (fire, water, table) — not away into empty space. Benches face something worth
      looking at.
  (6) Decorative clusters mix item types rather than repeating one object; no isolated
      singletons unless they're intentional focal points.
  (7) Every zone is fully filled — no large expanses of bare default terrain remain in
      cultivated or transitional zones; ground cover, plants, or decoration occupy the
      space in a way consistent with the design aesthetic.
  (8) Decorative zones use varied types throughout — at least 2–3 different species in
      plant areas, mixed floor textures where flooring is used, mixed tree varieties in
      forested areas.
  (9) Crafting yards and named service zones are actually VISIBLE in the screenshot — not
      hidden behind a building's roof. Anything you intended to place just above (north of)
      a building that you can't see in the screenshot has been swallowed by the roof: move
      it to the same row or south of the building.
  After fixes, summarize what you built and where, noting anything you adapted and why.

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
  /** latest user-attached image (via /image) — the zoom_reference tool reads it */
  reference?: ReferenceImage;
}

/**
 * Place prompt-cache breakpoints on the transcript. The API's cache lookback
 * is 20 content blocks: a request's breakpoint only finds the previous
 * request's cache entry if it sits within 20 blocks of it. Our batched tool
 * turns can append 30-60 blocks at once (assistant tool_use blocks + their
 * tool_results), which silently missed the cache and re-wrote the whole
 * transcript at the 1.25x write rate — measured at ~half the cost of a long
 * run. So instead of one auto-placed marker at the end, walk back from the
 * end and drop a marker at least every CACHE_MAX_GAP blocks (3 markers max —
 * the 4th allowed breakpoint is on the system prompt). Returns a cloned
 * message list so markers never accumulate on the persistent transcript.
 */
const CACHE_MAX_GAP = 18;

export function withCacheBreakpoints(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  // Flat list of cloned blocks in prompt order; thinking blocks must be
  // replayed byte-identical, so they are ineligible to carry a marker.
  const flat: { block: Record<string, unknown> | null; eligible: boolean }[] = [];
  const cloned = messages.map((m) => {
    if (typeof m.content === "string") {
      flat.push({ block: null, eligible: false });
      return m;
    }
    const content = m.content.map((b) => {
      const { cache_control: _stale, ...rest } = b as unknown as Record<string, unknown>;
      const clone = { ...rest };
      flat.push({
        block: clone,
        eligible: clone.type !== "thinking" && clone.type !== "redacted_thinking",
      });
      return clone;
    });
    return { ...m, content };
  });
  let markers = 3;
  let gap = 0; // blocks since the last marker placed (walking backward)
  for (let i = flat.length - 1; i >= 0 && markers > 0; i--) {
    gap++;
    const wantMarker = i === flat.length - 1 || gap >= CACHE_MAX_GAP;
    if (wantMarker && flat[i].eligible && flat[i].block) {
      flat[i].block!.cache_control = { type: "ephemeral" };
      markers--;
      gap = 0;
    }
  }
  return cloned as Anthropic.MessageParam[];
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
  if (Array.isArray(userContent)) {
    const img = userContent.find((b): b is Anthropic.ImageBlockParam => b.type === "image");
    if (img && img.source.type === "base64") {
      ctx.reference = { data: img.source.data, mediaType: img.source.media_type };
    }
  }

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
      // 1h TTL: the system prompt never changes within a session, and in
      // interactive mode the human can idle past the default 5-minute TTL.
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } }],
      tools: TOOLS,
      messages: withCacheBreakpoints(ctx.messages),
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
      const outcome = await runTool(ctx.session, call.name, call.input as Record<string, unknown>, ctx.reference);
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
