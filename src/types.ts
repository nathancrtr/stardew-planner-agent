import { z } from "zod";

/**
 * One placement action on the planner board.
 * Coordinates are tile indices: column 0..79, row 0..64 on the regular farm.
 *
 * - "place": single click. (column, row) is the object's anchor tile — the
 *   BOTTOM-LEFT tile of its footprint. Multi-tile objects extend RIGHT and UP.
 * - "fill": rectangular paint for 1x1 items (crops, paths, sprinklers...).
 *   (column, row) is the TOP-LEFT corner; the region extends `width` tiles
 *   right and `height` tiles down.
 */
export const ActionSchema = z.object({
  type: z.enum(["place", "fill"]),
  item: z.string().describe("Object id from the catalog, e.g. 'junimo-hut', 'iridium-sprinkler', 'ancient-fruit'"),
  column: z.number().int(),
  row: z.number().int(),
  width: z.number().int().optional().describe("fill only: region width in tiles"),
  height: z.number().int().optional().describe("fill only: region height in tiles"),
  note: z.string().optional().describe("short human-readable description of this action"),
});

export const PlanSchema = z.object({
  layout: z
    .enum(["regular", "combat", "fishing", "foraging", "mining", "ranching", "beach", "ginger_island", "fourcorners", "quarry"])
    .describe("Farm layout to build on; 'regular' unless the user asks otherwise. In-game names map as: wilderness=combat, riverlands=fishing, forest=foraging, hilltop=mining, meadowlands=ranching, four corners=fourcorners"),
  summary: z.string().describe("One-paragraph description of the layout being built"),
  actions: z.array(ActionSchema),
});

export type Action = z.infer<typeof ActionSchema>;
export type Plan = z.infer<typeof PlanSchema>;

export interface ActionResult {
  action: Action;
  ok: boolean;
  detail: string;
}
