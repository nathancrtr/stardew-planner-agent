/**
 * Dumps the planner's placeable-object catalogs and farm layouts to
 * data/catalog.json — the knowledge base for the NL planning step.
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

async function main() {
  mkdirSync("data", { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto("https://stardew.info/planner", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(8000);
  for (const name of [/start planning/i, /i understand/i]) {
    const btn = page.getByRole("button", { name });
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(2000);
    }
  }

  const catalog = await page.evaluate(`(() => {
    const p = window.planner;
    const summarize = (dict) => {
      const out = {};
      for (const [id, o] of Object.entries(dict || {})) {
        if (!o || typeof o !== "object") continue;
        out[id] = {
          id: o.id, name: o.name, group: o.group, subGroup: o.subGroup,
          footprint: o.footprint ? {
            width: o.footprint.width, height: o.footprint.height,
            offsetRow: o.footprint.offsetRow, offsetColumn: o.footprint.offsetColumn,
          } : undefined,
          seasons: o.seasons, restriction: o.restriction,
        };
      }
      return out;
    };
    return {
      crops: summarize(p.crops),
      craftables: summarize(p.craftables),
      buildings: summarize(p.buildings),
      furniture: summarize(p.furniture),
      misc: summarize(p.misc),
      layouts: Object.fromEntries(Object.entries(p.layouts || {}).map(([k, l]) => [k, {
        name: l.name, label: l.label,
        keys: Object.keys(l),
        width: l.width, height: l.height,
        house: l.house, greenhouse: l.greenhouse,
      }])),
      restrictionLayerNames: Object.keys(p.restrictionLayers || {}),
      viewportKeys: p.viewport ? Object.keys(p.viewport).slice(0, 50) : null,
      viewportProto: p.viewport ? Object.getOwnPropertyNames(Object.getPrototypeOf(p.viewport)).slice(0, 80) : null,
    };
  })()`);

  writeFileSync("data/catalog.json", JSON.stringify(catalog, null, 2));
  const c = catalog as any;
  console.log("counts:", ["crops", "craftables", "buildings", "furniture", "misc"]
    .map((k) => `${k}=${Object.keys(c[k]).length}`).join(" "));
  console.log("layouts:", JSON.stringify(c.layouts).slice(0, 600));
  console.log("restriction layers:", c.restrictionLayerNames.join(", "));
  console.log("viewport proto:", (c.viewportProto || []).join(","));

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
