import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { catalogPromptText, findItem } from "./catalog.js";
import { Plan, PlanSchema } from "./types.js";

const SYSTEM = `You are a Stardew Valley farm-layout designer. You translate natural-language
requests into a precise placement plan for the stardew.info/planner (V3) board.

# Board model
- The board is a tile grid. The REGULAR farm is 80 columns x 65 rows; column 0 is the left
  edge, row 0 is the TOP edge (rows increase downward).
- On the regular farm the farmhouse sits with anchor at (column 59, row 16) (9x5 footprint,
  extending right and up from there) and the greenhouse at (column 24, row 17) (7x8). Leave
  those areas clear. The top ~10 rows, the far edges, and scattered ponds/cliffs are
  unbuildable; prefer the open central farmland (roughly columns 6-72, rows 18-60) unless
  the user directs otherwise.
- "place" actions: (column, row) is the object's ANCHOR TILE - the BOTTOM-LEFT tile of its
  footprint. A WxH building at (c, r) occupies columns c..c+W-1 and rows r-H+1..r.
- "fill" actions: only for 1x1 items (crops, paths, sprinklers, flooring). (column, row) is
  the TOP-LEFT corner of the rectangle; it extends width tiles right and height tiles down.

# Design rules
- Use exact item ids from the catalog below. Crops are placed via their SEED id
  (e.g. ancient fruit -> "ancient-seeds", melons -> "melon-seeds").
- Iridium sprinklers water a 5x5 area centered on themselves; quality sprinklers 3x3;
  regular sprinklers the 4 adjacent tiles. Lay out crop grids accordingly (e.g. iridium
  sprinklers every 5 tiles within a crop field, each on the center tile of its 5x5 cell).
- Scarecrows cover a radius of 8. Junimo huts harvest a 17x17 area centered on the hut.
- CRITICAL: a tile holds exactly ONE object. Crops cannot share a tile with sprinklers,
  scarecrows, paths, or buildings — a click or fill on an occupied tile is rejected.
- Therefore ORDER MATTERS: place buildings, sprinklers, and scarecrows FIRST, then emit
  crop/path fills. A fill dragged over occupied tiles skips them and paints the rest, so
  you may fill the whole field rectangle after placing the sprinklers inside it.
- Keep plans efficient: prefer "fill" for fields and paths over many single placements.
- If the user's request is impossible or ambiguous, make a reasonable choice and explain
  it in the summary.

# Item catalog
${catalogPromptText()}`;

export interface PlanOptions {
  model?: string;
}

export async function makePlan(request: string, opts: PlanOptions = {}): Promise<Plan> {
  const client = new Anthropic();
  const response = await client.messages.parse({
    model: opts.model ?? "claude-opus-4-8",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: request }],
    output_config: { format: zodOutputFormat(PlanSchema) },
  });

  const plan = response.parsed_output;
  if (!plan) {
    throw new Error(`Claude did not return a parseable plan (stop_reason: ${response.stop_reason})`);
  }
  return validatePlan(plan);
}

/** Validates item ids and fill constraints; throws with a helpful message. */
export function validatePlan(plan: Plan): Plan {
  const problems: string[] = [];
  for (const [i, a] of plan.actions.entries()) {
    const item = findItem(a.item);
    if (!item) {
      problems.push(`action ${i}: unknown item id "${a.item}"`);
      continue;
    }
    if (a.type === "fill") {
      if (!a.width || !a.height) problems.push(`action ${i}: fill needs width and height`);
      const fp = item.footprint;
      if (fp?.width && fp?.height && (fp.width > 1 || fp.height > 1)) {
        problems.push(`action ${i}: fill only supports 1x1 items, "${a.item}" is ${fp.width}x${fp.height}`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`Plan validation failed:\n  ${problems.join("\n  ")}`);
  }
  return plan;
}
