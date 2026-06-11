import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface CatalogEntry {
  id: string;
  name?: string;
  group?: string;
  subGroup?: string;
  footprint?: { width?: number; height?: number };
}

interface Catalog {
  crops: Record<string, CatalogEntry>;
  craftables: Record<string, CatalogEntry>;
  buildings: Record<string, CatalogEntry>;
  furniture: Record<string, CatalogEntry>;
  misc: Record<string, CatalogEntry>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Column offset (from the building's LEFT edge) of the human door, which sits
 * on the SOUTH (bottom) row of the footprint. Buildings not listed have no
 * walk-in door. Source: Stardew 1.6 Data/Buildings.json (HumanDoor.X).
 */
export const DOOR_OFFSETS: Record<string, number> = {
  coop: 1, "big-coop": 1, "deluxe-coop": 1,
  barn: 1, "big-barn": 1, "deluxe-barn": 1,
  shed: 3, "big-shed": 3,
  "slime-hutch": 3,
  "log-cabin": 2, "log-cabin-2": 2, "log-cabin-3": 2,
  "plank-cabin": 2, "plank-cabin-2": 2, "plank-cabin-3": 2,
  "stone-cabin": 2, "stone-cabin-2": 2, "stone-cabin-3": 2,
  house: 5, "house-2": 5, "house-3": 5,
  greenhouse: 3, "greenhouse-repaired": 3,
};

let cached: Catalog | undefined;

export function loadCatalog(): Catalog {
  if (!cached) {
    cached = JSON.parse(readFileSync(join(__dirname, "../data/catalog.json"), "utf8")) as Catalog;
  }
  return cached;
}

export function findItem(id: string): CatalogEntry | undefined {
  const c = loadCatalog();
  return c.crops[id] ?? c.craftables[id] ?? c.buildings[id] ?? c.misc[id] ?? c.furniture[id];
}

/** Compact catalog listing for the planning prompt: "id WxH" per item. */
export function catalogPromptText(): string {
  const c = loadCatalog();
  const fmt = (entries: Record<string, CatalogEntry>) =>
    Object.values(entries)
      .map((e) => {
        const fp = e.footprint;
        const size = fp?.width && fp?.height && (fp.width > 1 || fp.height > 1) ? ` ${fp.width}x${fp.height}` : "";
        const door = DOOR_OFFSETS[e.id] !== undefined ? ` door+${DOOR_OFFSETS[e.id]}` : "";
        return `${e.id}${size}${door}`;
      })
      .join(", ");
  return [
    `## Crops (seeds — these grow into the crop; 1x1 unless noted)\n${fmt(c.crops)}`,
    `## Craftables (sprinklers, machines, fences, scarecrows... 1x1 unless noted)\n${fmt(c.craftables)}`,
    `## Buildings (multi-tile; footprint WxH; "door+N" = human door N columns right of the LEFT edge, on the SOUTH row — keep the tile south of the door clear)\n${fmt(c.buildings)}`,
    `## Misc (trees, paths, flooring, decorations)\n${fmt(c.misc)}`,
  ].join("\n\n");
}
