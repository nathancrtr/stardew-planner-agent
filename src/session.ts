import { Browser, Page, chromium } from "playwright";

const PLANNER_URL = "https://stardew.info/planner";

export interface SessionOptions {
  headless?: boolean;
  /** ms pause after each board mutation so a human can follow along */
  pace?: number;
}

export interface OpResult {
  ok: boolean;
  detail: string;
}

/**
 * A long-lived browser session on stardew.info/planner. All board mutations go
 * through the app's own pointer pipeline (real mouse events); board state is
 * read back through the window.planner object.
 */
export class PlannerSession {
  private constructor(
    private browser: Browser,
    readonly page: Page,
    private pace: number,
  ) {}

  static async open(opts: SessionOptions = {}): Promise<PlannerSession> {
    const headless = opts.headless ?? false;
    const browser = await chromium.launch({
      headless,
      // Software GL so WebGL works without a GPU (headless runs, CI, VMs)
      args: headless ? ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] : [],
    });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    await page.goto(PLANNER_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(`!!window.planner && !!window.planner.tiles`, undefined, { timeout: 30000 });
    await page.waitForTimeout(4000); // textures/menus finish loading
    const session = new PlannerSession(browser, page, opts.pace ?? 250);
    await session.dismissModals();
    // The "Low PERFORMANCE detected" modal is FPS-triggered and appears a few
    // seconds into the session (always, under software GL) — wait it out once.
    await page.waitForTimeout(6000);
    await session.dismissModals();
    return session;
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  /** Close any open modal ("Start planning!", "I understand", ...). */
  async dismissModals(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      const clicked = await this.page.evaluate(`(() => {
        const open = document.querySelector(".modal-backdrop:not(.hidden)");
        if (!open) return false;
        const btn = open.querySelector(".modal-footer button");
        if (btn) { btn.click(); return true; }
        return false;
      })()`);
      if (!clicked) return;
      await this.page.waitForTimeout(800);
    }
  }

  async switchLayout(layout: string): Promise<OpResult> {
    const known = await this.page.evaluate(`!!window.planner.layouts[${JSON.stringify(layout)}]`);
    if (!known) return { ok: false, detail: `unknown layout "${layout}"` };
    await this.page.evaluate(`window.planner.loadLayout(${JSON.stringify(layout)})`);
    await this.page.waitForTimeout(3000);
    return { ok: true, detail: `layout switched to ${layout}` };
  }

  async placeItem(item: string, column: number, row: number): Promise<OpResult> {
    return this.withModalRetry(async () => {
      await this.selectItem(item);
      const pt = await this.tileToPage(column, row);
      await this.page.mouse.move(pt.x, pt.y, { steps: 15 });
      await this.page.waitForTimeout(120);
      await this.page.mouse.down();
      await this.page.mouse.up();
      await this.page.waitForTimeout(120 + this.pace);
      const occupant = await this.tileContents(column, row);
      if (occupant === item) return { ok: true, detail: `placed ${item} at (${column},${row})` };
      return {
        ok: false,
        detail: occupant
          ? `tile (${column},${row}) already holds "${occupant}" — placement rejected`
          : `tile (${column},${row}) is empty after the click — likely a restricted/unbuildable area`,
      };
    });
  }

  async fillArea(item: string, column: number, row: number, width: number, height: number): Promise<OpResult> {
    return this.withModalRetry(async () => {
      await this.selectItem(item);
      for (let r = row; r < row + height; r++) {
        const start = await this.tileToPage(column, r);
        const end = await this.tileToPage(column + width - 1, r);
        await this.page.mouse.move(start.x, start.y, { steps: 8 });
        await this.page.mouse.down();
        // one step per tile keeps the MULTI brush painting every tile
        await this.page.mouse.move(end.x, end.y, { steps: Math.max(width, 2) });
        await this.page.mouse.up();
        await this.page.waitForTimeout(60);
      }
      await this.page.waitForTimeout(this.pace);
      const { filled, total } = await this.countFilled(column, row, width, height);
      const ok = filled > 0;
      return {
        ok,
        detail: ok
          ? `${filled}/${total} tiles in the ${width}x${height} region now occupied (pre-occupied tiles were skipped)`
          : `no tiles in the ${width}x${height} region were filled — restricted area?`,
      };
    });
  }

  async eraseArea(column: number, row: number, width: number, height: number): Promise<OpResult> {
    return this.withModalRetry(async () => {
      const before = await this.countFilled(column, row, width, height);
      await this.page.evaluate(`window.planner.brushTypeEraser()`);
      for (let r = row; r < row + height; r++) {
        const start = await this.tileToPage(column, r);
        const end = await this.tileToPage(column + width - 1, r);
        await this.page.mouse.move(start.x, start.y, { steps: 4 });
        await this.page.mouse.down();
        await this.page.mouse.move(end.x, end.y, { steps: Math.max(width, 2) });
        await this.page.mouse.up();
        await this.page.waitForTimeout(60);
      }
      // back to the default brush, drop the (red-tinted) eraser ghost
      await this.page.evaluate(`window.planner.brushTypeDefault()`);
      await this.page.keyboard.press("Escape");
      await this.page.waitForTimeout(this.pace);
      const after = await this.countFilled(column, row, width, height);
      return { ok: true, detail: `erased ${before.filled - after.filled} object(s) in the ${width}x${height} region (${after.filled} remain)` };
    });
  }

  /** Text grid of occupant ids — exact board state without image tokens. */
  async inspectArea(column: number, row: number, width: number, height: number): Promise<string> {
    const grid = (await this.page.evaluate(`(() => {
      const p = window.planner;
      const out = [];
      for (let r = ${row}; r < ${row + height}; r++) {
        const line = [];
        for (let c = ${column}; c < ${column + width}; c++) {
          const t = (p.tiles[r] && p.tiles[r][c]) || (p.flooringTiles[r] && p.flooringTiles[r][c]);
          line.push(t && t.objectData ? t.objectData.id : ".");
        }
        out.push(line);
      }
      return out;
    })()`)) as string[][];
    const lines = grid.map((line, i) => `row ${row + i}: ` + line.join(" "));
    return `occupants of columns ${column}-${column + width - 1} ("." = empty):\n${lines.join("\n")}`;
  }

  /** PNG of the board canvas only (clipped — cheaper in image tokens). */
  async screenshot(): Promise<Buffer> {
    await this.page.keyboard.press("Escape"); // drop any held brush ghost
    await this.page.waitForTimeout(300);
    const canvas = this.page.locator("canvas").first();
    return canvas.screenshot({ type: "png" });
  }

  async savePlan(): Promise<OpResult> {
    const saved = (await this.page.evaluate(`window.planner.savePlan()`)) as { id?: string } | undefined;
    return saved?.id
      ? { ok: true, detail: `${PLANNER_URL}/${saved.id}` }
      : { ok: false, detail: "savePlan() returned no id" };
  }

  // ---- internals ----

  /** Retry once after dismissing modals — the FPS modal can appear mid-action and eat clicks. */
  private async withModalRetry(fn: () => Promise<OpResult>): Promise<OpResult> {
    await this.dismissModals();
    let result = await fn();
    if (!result.ok) {
      await this.dismissModals();
      result = await fn();
    }
    return result;
  }

  private async selectItem(itemId: string): Promise<void> {
    const ok = await this.page.evaluate(`(() => {
      const p = window.planner;
      const o = p.getObjectByName(${JSON.stringify(itemId)});
      if (!o) return false;
      p.brushType = "default";
      p.changeGhostSprite(o);
      return true;
    })()`);
    if (!ok) throw new Error(`item "${itemId}" not found in planner catalogs`);
  }

  private async tileToPage(column: number, row: number): Promise<{ x: number; y: number }> {
    const pt = (await this.page.evaluate(`(() => {
      const p = window.planner;
      const g = p.plannerSpriteContainer.toGlobal({ x: ${column} * p.tileSize + p.tileSize / 2, y: ${row} * p.tileSize + p.tileSize / 2 });
      const r = p.app.view.getBoundingClientRect();
      return { x: r.left + g.x, y: r.top + g.y };
    })()`)) as { x: number; y: number };
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
      throw new Error(`tile (${column},${row}) did not map to screen coordinates`);
    }
    return pt;
  }

  private async tileContents(column: number, row: number): Promise<string | null> {
    return (await this.page.evaluate(`(() => {
      const p = window.planner;
      const t = (p.tiles[${row}] && p.tiles[${row}][${column}]) || (p.flooringTiles[${row}] && p.flooringTiles[${row}][${column}]);
      return t && t.objectData ? t.objectData.id : null;
    })()`)) as string | null;
  }

  private async countFilled(column: number, row: number, width: number, height: number): Promise<{ filled: number; total: number }> {
    return (await this.page.evaluate(`(() => {
      const p = window.planner;
      let filled = 0;
      for (let r = ${row}; r < ${row + height}; r++) {
        for (let c = ${column}; c < ${column + width}; c++) {
          const t = (p.tiles[r] && p.tiles[r][c]) || (p.flooringTiles[r] && p.flooringTiles[r][c]);
          if (t) filled++;
        }
      }
      return { filled, total: ${width * height} };
    })()`)) as { filled: number; total: number };
  }
}
