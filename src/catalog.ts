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
        return fp?.width && fp?.height && (fp.width > 1 || fp.height > 1)
          ? `${e.id} ${fp.width}x${fp.height}`
          : e.id;
      })
      .join(", ");
  return [
    `## Crops (seeds — these grow into the crop; 1x1 unless noted)\n${fmt(c.crops)}`,
    `## Craftables (sprinklers, machines, fences, scarecrows... 1x1 unless noted)\n${fmt(c.craftables)}`,
    `## Buildings (multi-tile; footprint WxH listed)\n${fmt(c.buildings)}`,
    `## Misc (trees, paths, flooring, decorations)\n${fmt(c.misc)}`,
  ].join("\n\n");
}
