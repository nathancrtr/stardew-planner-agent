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
      "Place a single object on the board. (column, row) is the object's ANCHOR tile — the BOTTOM-LEFT tile of its footprint; a WxH building extends RIGHT and UP from there. Fails with a reason if the tile is occupied or restricted. For buildings with a human door the result reports the door tile and WARNS if a door's approach is blocked — fix those warnings. Use this for buildings, sprinklers, scarecrows, machines, and other one-off objects.",
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
      "Paint a rectangle of any 1x1 item (crops, paths, flooring, fences, and 1x1 machines like kegs or preserves jars). (column, row) is the TOP-LEFT corner; extends `width` right and `height` down. Tiles that are already occupied are skipped automatically, so you can fill a whole field after placing sprinklers/buildings inside it. Returns how many tiles in the region are now occupied, and WARNS if the fill buried the approach tile of a building's door.",
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
    name: "zoom_reference",
    description:
      "Magnify a rectangular region of the user's attached reference image (provided via /image). The full image renders 1x1 objects — sprinklers, scarecrows, paths — at only a few pixels, so zoom into each major area BEFORE building to inventory exactly what's there, and again whenever you're unsure what an object is. Region is in percentages of the image (0-100): the top-left quadrant is left_pct=0, top_pct=0, width_pct=50, height_pct=50. Regions <= 50% per side give the most useful magnification.",
    input_schema: {
      type: "object",
      properties: {
        left_pct: { type: "integer", description: "left edge, % of image width (0-100)" },
        top_pct: { type: "integer", description: "top edge, % of image height (0-100)" },
        width_pct: { type: "integer" },
        height_pct: { type: "integer" },
      },
      required: ["left_pct", "top_pct", "width_pct", "height_pct"],
    },
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

export interface ReferenceImage {
  data: string; // base64
  mediaType: string;
}

/** Execute one tool call against the live session. Never throws — errors become tool results. */
export async function runTool(
  session: PlannerSession,
  name: string,
  input: Record<string, unknown>,
  reference?: ReferenceImage,
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
      case "zoom_reference": {
        if (!reference) {
          return err("no reference image in this session — the user attaches one with '/image <path>'");
        }
        const { left_pct, top_pct, width_pct, height_pct } = input as {
          left_pct: number; top_pct: number; width_pct: number; height_pct: number;
        };
        const clamp = (n: number) => Math.min(100, Math.max(0, n));
        const left = clamp(left_pct);
        const top = clamp(top_pct);
        const width = Math.min(clamp(width_pct), 100 - left);
        const height = Math.min(clamp(height_pct), 100 - top);
        if (width <= 0 || height <= 0) return err("region is empty after clamping to the image bounds");
        const png = await session.magnifyImage(reference.data, reference.mediaType, left / 100, top / 100, width / 100, height / 100);
        return {
          isError: false,
          log: `magnified reference region ${left}%,${top}% ${width}x${height}% (${Math.round(png.length / 1024)} KB)`,
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
            { type: "text", text: `reference image, region left=${left}% top=${top}% width=${width}% height=${height}%, magnified` },
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
