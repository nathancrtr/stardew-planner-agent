import Anthropic from "@anthropic-ai/sdk";
import { PlannerSession } from "./session.js";
import { findItem } from "./catalog.js";

/**
 * The agent's tool surface. Descriptions are written for the model — they are
 * the documentation it reads to decide when and how to call each tool.
 */
export const TOOLS: Anthropic.Tool[] = [
  {
    name: "place_item",
    description:
      "Place a single object on the board. (column, row) is the object's ANCHOR tile — the BOTTOM-LEFT tile of its footprint; a WxH building extends RIGHT and UP from there. Fails with a reason if the tile is occupied or restricted. Use this for buildings, sprinklers, scarecrows, machines, and other one-off objects.",
    input_schema: {
      type: "object",
      properties: {
        item: { type: "string", description: "catalog item id, e.g. 'junimo-hut', 'iridium-sprinkler', 'ancient-seeds'" },
        column: { type: "integer" },
        row: { type: "integer" },
      },
      required: ["item", "column", "row"],
    },
  },
  {
    name: "fill_area",
    description:
      "Paint a rectangle of a 1x1 item (crops, paths, flooring, fences). (column, row) is the TOP-LEFT corner; extends `width` right and `height` down. Tiles that are already occupied are skipped automatically, so you can fill a whole field after placing sprinklers/buildings inside it. Returns how many tiles in the region are now occupied.",
    input_schema: {
      type: "object",
      properties: {
        item: { type: "string", description: "catalog item id of a 1x1 object; crops use SEED ids (ancient fruit -> 'ancient-seeds')" },
        column: { type: "integer" },
        row: { type: "integer" },
        width: { type: "integer" },
        height: { type: "integer" },
      },
      required: ["item", "column", "row", "width", "height"],
    },
  },
  {
    name: "erase_area",
    description:
      "Erase all objects in a rectangle. (column, row) is the TOP-LEFT corner. Use this to correct mistakes before re-placing.",
    input_schema: {
      type: "object",
      properties: {
        column: { type: "integer" },
        row: { type: "integer" },
        width: { type: "integer" },
        height: { type: "integer" },
      },
      required: ["column", "row", "width", "height"],
    },
  },
  {
    name: "inspect_area",
    description:
      "Read the exact occupant ids of a rectangle of tiles as text ('.' = empty). Far cheaper than a screenshot and exact — prefer this to verify placements. Keep regions <= 25x25.",
    input_schema: {
      type: "object",
      properties: {
        column: { type: "integer" },
        row: { type: "integer" },
        width: { type: "integer" },
        height: { type: "integer" },
      },
      required: ["column", "row", "width", "height"],
    },
  },
  {
    name: "screenshot",
    description:
      "Take a PNG screenshot of the whole board. Use sparingly (it costs many tokens): at checkpoints and at the end to judge spatial layout and aesthetics. For verifying specific tiles, use inspect_area instead.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "switch_layout",
    description:
      "Switch the farm layout. Official names: regular, combat (wilderness), fishing (riverlands), foraging (forest), mining (hilltop), ranching (meadowlands), beach, fourcorners, ginger_island, quarry. Only call when the user asks for a non-standard farm; it clears the board.",
    input_schema: {
      type: "object",
      properties: { layout: { type: "string" } },
      required: ["layout"],
    },
  },
  {
    name: "save_plan",
    description:
      "Save the current board on stardew.info and get a permanent shareable URL. Call once at the end if the user wants a link.",
    input_schema: { type: "object", properties: {} },
  },
];

export interface ToolOutcome {
  content: Anthropic.ToolResultBlockParam["content"];
  isError: boolean;
  /** short line for console logging */
  log: string;
}

/** Execute one tool call against the live session. Never throws — errors become tool results. */
export async function runTool(
  session: PlannerSession,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  try {
    switch (name) {
      case "place_item": {
        const { item, column, row } = input as { item: string; column: number; row: number };
        if (!findItem(item)) {
          return err(`unknown item id "${item}" — use exact ids from the catalog in your instructions`);
        }
        const r = await session.placeItem(item, column, row);
        return r.ok ? text(r.detail) : err(r.detail);
      }
      case "fill_area": {
        const { item, column, row, width, height } = input as Record<string, never> & {
          item: string; column: number; row: number; width: number; height: number;
        };
        if (!findItem(item)) {
          return err(`unknown item id "${item}" — use exact ids from the catalog in your instructions`);
        }
        const fp = findItem(item)?.footprint;
        if (fp?.width && fp?.height && (fp.width > 1 || fp.height > 1)) {
          return err(`fill_area only supports 1x1 items; "${item}" is ${fp.width}x${fp.height} — use place_item`);
        }
        const r = await session.fillArea(item, column, row, width, height);
        return r.ok ? text(r.detail) : err(r.detail);
      }
      case "erase_area": {
        const { column, row, width, height } = input as { column: number; row: number; width: number; height: number };
        const r = await session.eraseArea(column, row, width, height);
        return r.ok ? text(r.detail) : err(r.detail);
      }
      case "inspect_area": {
        const { column, row, width, height } = input as { column: number; row: number; width: number; height: number };
        if (width * height > 900) return err("region too large — inspect at most 900 tiles at a time");
        return text(await session.inspectArea(column, row, width, height));
      }
      case "screenshot": {
        const png = await session.screenshot();
        return {
          isError: false,
          log: `screenshot (${Math.round(png.length / 1024)} KB)`,
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
            { type: "text", text: "current board" },
          ],
        };
      }
      case "switch_layout": {
        const r = await session.switchLayout((input as { layout: string }).layout);
        return r.ok ? text(r.detail) : err(r.detail);
      }
      case "save_plan": {
        const r = await session.savePlan();
        return r.ok ? text(`saved — share URL: ${r.detail}`) : err(r.detail);
      }
      default:
        return err(`unknown tool "${name}"`);
    }
  } catch (e) {
    return err(String(e));
  }
}

function text(t: string): ToolOutcome {
  return { content: [{ type: "text", text: t }], isError: false, log: t.split("\n")[0] };
}

function err(t: string): ToolOutcome {
  return { content: [{ type: "text", text: t }], isError: true, log: t.split("\n")[0] };
}
