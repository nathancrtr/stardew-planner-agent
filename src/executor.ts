import { Browser, Page, chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { Action, ActionResult, Plan } from "./types.js";

const PLANNER_URL = "https://stardew.info/planner";
const TILE = 16; // world pixels per tile at zoom 1

export interface ExecuteOptions {
  headless?: boolean;
  /** ms pause between actions so a human can follow along */
  pace?: number;
  /** call planner.savePlan() at the end and return the share URL */
  save?: boolean;
  screenshotPath?: string;
}

export interface ExecuteResult {
  results: ActionResult[];
  screenshot?: string;
  shareUrl?: string;
}

export async function executePlan(plan: Plan, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
  const headless = opts.headless ?? false;
  const pace = opts.pace ?? 250;
  const browser = await chromium.launch({
    headless,
    // Software GL so WebGL works without a GPU (headless runs, CI, VMs)
    args: headless ? ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] : [],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    await openPlanner(page);

    if (plan.layout !== "regular") {
      console.log(`switching layout to ${plan.layout}...`);
      await page.evaluate(`window.planner.loadLayout(${JSON.stringify(plan.layout)})`);
      await page.waitForTimeout(3000);
    }

    const results: ActionResult[] = [];
    for (const [i, action] of plan.actions.entries()) {
      const label = `${i + 1}/${plan.actions.length} ${action.type} ${action.item} @ (${action.column},${action.row})`;
      try {
        await dismissModals(page);
        let result = action.type === "place"
          ? await placeSingle(page, action)
          : await fillRect(page, action);
        if (!result.ok) {
          // A modal (e.g. the FPS warning) may have appeared mid-action and
          // eaten the clicks — clear it and retry once.
          await dismissModals(page);
          result = action.type === "place"
            ? await placeSingle(page, action)
            : await fillRect(page, action);
        }
        results.push(result);
        console.log(`${result.ok ? "✓" : "✗"} ${label}${result.ok ? "" : ` — ${result.detail}`}`);
      } catch (err) {
        results.push({ action, ok: false, detail: String(err) });
        console.log(`✗ ${label} — ${err}`);
      }
      await page.waitForTimeout(pace);
    }

    // Drop any held brush so the final screenshot has no ghost sprite
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    let screenshot: string | undefined;
    if (opts.screenshotPath !== "") {
      mkdirSync("screenshots", { recursive: true });
      screenshot = opts.screenshotPath ?? `screenshots/result-${Date.now()}.png`;
      await page.screenshot({ path: screenshot });
    }

    let shareUrl: string | undefined;
    if (opts.save) {
      const saved = await page.evaluate(`window.planner.savePlan()`) as { id?: string } | undefined;
      if (saved?.id) shareUrl = `${PLANNER_URL}/${saved.id}`;
    }

    if (!headless) await page.waitForTimeout(2000); // a beat to admire the result
    return { results, screenshot, shareUrl };
  } finally {
    await browser.close();
  }
}

async function openPlanner(page: Page): Promise<void> {
  await page.goto(PLANNER_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(`!!window.planner && !!window.planner.tiles`, undefined, { timeout: 30000 });
  await page.waitForTimeout(4000); // textures/menus finish loading
  await dismissModals(page);
  // The "Low PERFORMANCE detected" modal is FPS-triggered and appears a few
  // seconds into the session (always, under software GL) — wait it out once.
  await page.waitForTimeout(6000);
  await dismissModals(page);
}

/** Close any open modal ("Start planning!", "I understand", ...). */
async function dismissModals(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const clicked = await page.evaluate(`(() => {
      const open = document.querySelector(".modal-backdrop:not(.hidden)");
      if (!open) return false;
      const btn = open.querySelector(".modal-footer button");
      if (btn) { btn.click(); return true; }
      return false;
    })()`);
    if (!clicked) return;
    await page.waitForTimeout(800);
  }
}

/** Pick the item up as the cursor brush (ghost sprite follows the pointer). */
async function selectItem(page: Page, itemId: string): Promise<void> {
  const ok = await page.evaluate(`(() => {
    const p = window.planner;
    const o = p.getObjectByName(${JSON.stringify(itemId)});
    if (!o) return false;
    p.brushType = "default";
    p.changeGhostSprite(o);
    return true;
  })()`);
  if (!ok) throw new Error(`item "${itemId}" not found in planner catalogs`);
}

/** Convert a tile coordinate to page (mouse) coordinates via the Pixi scene graph. */
async function tileToPage(page: Page, column: number, row: number): Promise<{ x: number; y: number }> {
  const pt = await page.evaluate(`(() => {
    const p = window.planner;
    const g = p.plannerSpriteContainer.toGlobal({ x: ${column} * p.tileSize + p.tileSize / 2, y: ${row} * p.tileSize + p.tileSize / 2 });
    const r = p.app.view.getBoundingClientRect();
    return { x: r.left + g.x, y: r.top + g.y };
  })()`) as { x: number; y: number };
  if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
    throw new Error(`tile (${column},${row}) did not map to screen coordinates`);
  }
  return pt;
}

/** The catalog id of the sprite occupying this tile, or null. */
async function tileContents(page: Page, column: number, row: number): Promise<string | null> {
  return (await page.evaluate(
    `(() => {
      const p = window.planner;
      const t = (p.tiles[${row}] && p.tiles[${row}][${column}]) || (p.flooringTiles[${row}] && p.flooringTiles[${row}][${column}]);
      return t && t.objectData ? t.objectData.id : null;
    })()`
  )) as string | null;
}

async function placeSingle(page: Page, action: Action): Promise<ActionResult> {
  await selectItem(page, action.item);
  const pt = await tileToPage(page, action.column, action.row);
  await page.mouse.move(pt.x, pt.y, { steps: 15 });
  await page.waitForTimeout(120);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(120);
  const occupant = await tileContents(page, action.column, action.row);
  if (occupant === action.item) return { action, ok: true, detail: "placed" };
  return {
    action,
    ok: false,
    detail: occupant
      ? `tile already holds "${occupant}" — placement rejected`
      : "tile empty after click (restricted area?)",
  };
}

async function fillRect(page: Page, action: Action): Promise<ActionResult> {
  const width = action.width ?? 1;
  const height = action.height ?? 1;
  await selectItem(page, action.item);

  for (let r = action.row; r < action.row + height; r++) {
    const start = await tileToPage(page, action.column, r);
    const end = await tileToPage(page, action.column + width - 1, r);
    await page.mouse.move(start.x, start.y, { steps: 8 });
    await page.mouse.down();
    // drag across the row; one step per tile keeps the MULTI brush painting every tile
    await page.mouse.move(end.x, end.y, { steps: Math.max(width, 2) });
    await page.mouse.up();
    await page.waitForTimeout(60);
  }

  // Spot-check the four corners. A corner occupied by something else (e.g. a
  // sprinkler the fill painted around) still counts — fills skip blocked tiles.
  const corners: Array<[number, number]> = [
    [action.column, action.row],
    [action.column + width - 1, action.row],
    [action.column, action.row + height - 1],
    [action.column + width - 1, action.row + height - 1],
  ];
  let occupied = 0;
  for (const [c, r] of corners) {
    if ((await tileContents(page, c, r)) !== null) occupied++;
  }
  const ok = occupied === corners.length;
  return { action, ok, detail: ok ? `filled ${width}x${height}` : `only ${occupied}/4 corner tiles filled` };
}
