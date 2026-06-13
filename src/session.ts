import { Browser, Page, chromium } from "playwright";
import { DOOR_OFFSETS, findItem } from "./catalog.js";

const PLANNER_URL = "https://stardew.info/planner";
const DOORS_JSON = JSON.stringify(DOOR_OFFSETS);

export interface SessionOptions {
  headless?: boolean;
  /** ms pause after each board mutation so a human can follow along */
  pace?: number;
}

export interface OpResult {
  ok: boolean;
  detail: string;
}

/** Margin around a mutated region when diffing board state, so objects the
 * site registers slightly offset from the click (wild trees do) still show. */
const DIFF_MARGIN = 3;
/** Erase diffs use a wider margin: erasing one tile of a multi-tile building
 * removes the whole building, whose footprint can extend well past the rect. */
const ERASE_DIFF_MARGIN = 10;

interface TileChange {
  column: number;
  row: number;
  id: string;
}

/** Snapshot keys are "o:col,row" (objects layer) / "f:col,row" (flooring). */
type Snapshot = Record<string, string>;

function parseKey(key: string, id: string): TileChange {
  const [column, row] = key.slice(2).split(",").map(Number);
  return { column, row, id };
}

function diffSnapshots(before: Snapshot, after: Snapshot): { added: TileChange[]; removed: TileChange[] } {
  const added: TileChange[] = [];
  const removed: TileChange[] = [];
  for (const [key, id] of Object.entries(after)) if (before[key] !== id) added.push(parseKey(key, id));
  for (const [key, id] of Object.entries(before)) if (after[key] !== id) removed.push(parseKey(key, id));
  return { added, removed };
}

/** "14 grass tiles (cols 57-70, row 37); 1 deluxe-barn tile at (57,36)" */
function summarize(changes: TileChange[]): string {
  const byId = new Map<string, TileChange[]>();
  for (const ch of changes) {
    const group = byId.get(ch.id);
    if (group) group.push(ch);
    else byId.set(ch.id, [ch]);
  }
  return [...byId.entries()]
    .map(([id, tiles]) => {
      if (tiles.length === 1) return `1 ${id} tile at (${tiles[0].column},${tiles[0].row})`;
      return `${tiles.length} ${id} tiles (${rectText(tiles)})`;
    })
    .join("; ");
}

function rectText(tiles: TileChange[]): string {
  const cols = tiles.map((t) => t.column);
  const rows = tiles.map((t) => t.row);
  const c0 = Math.min(...cols), c1 = Math.max(...cols);
  const r0 = Math.min(...rows), r1 = Math.max(...rows);
  const colTxt = c0 === c1 ? `col ${c0}` : `cols ${c0}-${c1}`;
  const rowTxt = r0 === r1 ? `row ${r0}` : `rows ${r0}-${r1}`;
  return `${colTxt}, ${rowTxt}`;
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

  /** Close any open modal ("Start planning!", "I understand", ...). Returns whether one was dismissed. */
  async dismissModals(): Promise<boolean> {
    let dismissed = false;
    for (let i = 0; i < 4; i++) {
      const clicked = await this.page.evaluate(`(() => {
        const open = document.querySelector(".modal-backdrop:not(.hidden)");
        if (!open) return false;
        const btn = open.querySelector(".modal-footer button");
        if (btn) { btn.click(); return true; }
        return false;
      })()`);
      if (!clicked) return dismissed;
      dismissed = true;
      await this.page.waitForTimeout(800);
    }
    return dismissed;
  }

  async switchLayout(layout: string): Promise<OpResult> {
    const known = await this.page.evaluate(`!!window.planner.layouts[${JSON.stringify(layout)}]`);
    if (!known) return { ok: false, detail: `unknown layout "${layout}"` };
    await this.page.evaluate(`window.planner.loadLayout(${JSON.stringify(layout)})`);
    await this.page.waitForTimeout(3000);
    return { ok: true, detail: `layout switched to ${layout}` };
  }

  async placeItem(item: string, column: number, row: number): Promise<OpResult> {
    const fp = findItem(item)?.footprint;
    const w = fp?.width ?? 1;
    const h = fp?.height ?? 1;
    // diff window: the footprint (anchored bottom-left, extends right/up) plus margin
    const win = {
      column: column - DIFF_MARGIN,
      row: row - h + 1 - DIFF_MARGIN,
      width: w + 2 * DIFF_MARGIN,
      height: h + 2 * DIFF_MARGIN,
    };
    return this.withModalRetry(async () => {
      const before = await this.snapshotRegion(win.column, win.row, win.width, win.height);
      await this.selectItem(item);
      const pt = await this.tileToPage(column, row);
      await this.page.mouse.move(pt.x, pt.y, { steps: 15 });
      await this.page.waitForTimeout(120);
      await this.page.mouse.down();
      await this.page.mouse.up();
      await this.page.waitForTimeout(120 + this.pace);
      const after = await this.snapshotRegion(win.column, win.row, win.width, win.height);
      const { added, removed } = diffSnapshots(before, after);
      const mine = added.filter((t) => t.id === item);
      if (mine.length > 0) {
        // sprites anchor bottom-left, so the anchor is (min col, max row)
        const anchorCol = Math.min(...mine.map((t) => t.column));
        const anchorRow = Math.max(...mine.map((t) => t.row));
        let placed = `placed ${item} at (${anchorCol},${anchorRow})`;
        if (mine.length > 1) placed += `, occupying ${rectText(mine)}`;
        if (anchorCol !== column || anchorRow !== row) {
          placed += ` — NOTE: the planner registered it offset from the requested (${column},${row})`;
        }
        const notes = await this.doorNotes(item, anchorCol, anchorRow);
        if (removed.length > 0) notes.push(`WARNING: this click also removed: ${summarize(removed)}`);
        return { ok: true, detail: [placed, ...notes].join("; ") };
      }
      const occupant = await this.tileContents(column, row);
      if (occupant) {
        return { ok: false, detail: `tile (${column},${row}) already holds "${occupant}" — placement rejected` };
      }
      const { restricted, layer } = await this.countRestricted(item, column, row - h + 1, w, h);
      if (restricted > 0) {
        return {
          ok: false,
          detail:
            `${restricted} of the ${w}x${h} footprint tiles at anchor (${column},${row}) are restricted terrain ` +
            `("${layer}" layer: water/cliffs/edges) — relocate; retrying the same coordinates will fail again`,
        };
      }
      return {
        ok: false,
        detail: `the click at (${column},${row}) changed nothing, though the ground there is unrestricted — a modal may have eaten the click`,
      };
    });
  }

  async fillArea(item: string, column: number, row: number, width: number, height: number): Promise<OpResult> {
    const win = {
      column: column - DIFF_MARGIN,
      row: row - DIFF_MARGIN,
      width: width + 2 * DIFF_MARGIN,
      height: height + 2 * DIFF_MARGIN,
    };
    return this.withModalRetry(async () => {
      const before = await this.snapshotRegion(win.column, win.row, win.width, win.height);
      await this.selectItem(item);
      // The site gives craftables/furniture a SINGLE brush (one object per
      // drag); only crops/flooring/fences get the MULTI rectangle brush.
      // Force MULTI — changeGhostSprite just reset it from the item's group —
      // so 1x1 machines (kegs, jars) drag-fill like crops. The MULTI mouseup
      // handler runs the same per-tile restriction checks either way.
      await this.page.evaluate(`window.planner.brushMode = "multi"`);
      // A zero-distance drag (1×1 region) yields 0 placed because the MULTI
      // brush requires movement to register tiles. Use a single click instead.
      if (width === 1 && height === 1) {
        const point = await this.tileToPage(column, row);
        await this.page.mouse.click(point.x, point.y);
      } else {
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
      }
      await this.page.waitForTimeout(this.pace);
      const after = await this.snapshotRegion(win.column, win.row, win.width, win.height);
      const { added, removed } = diffSnapshots(before, after);
      const inRect = (t: TileChange) =>
        t.column >= column && t.column < column + width && t.row >= row && t.row < row + height;
      const addedIn = added.filter(inRect);
      const addedOut = added.filter((t) => !inRect(t));
      // distinct pre-occupied tiles inside the rect (object or flooring layer)
      const preOccupied = new Set(
        Object.keys(before)
          .map((k) => k.slice(2))
          .filter((k) => {
            const [c, r] = k.split(",").map(Number);
            return c >= column && c < column + width && r >= row && r < row + height;
          }),
      ).size;
      const total = width * height;

      if (added.length === 0 && preOccupied < total) {
        const { restricted, layer } = await this.countRestricted(item, column, row, width, height);
        return {
          ok: false,
          detail:
            restricted > 0
              ? `nothing was placed: ${restricted}/${total} tiles in the region are restricted terrain for "${item}" ` +
                `("${layer}" layer: water/cliffs/edges) and ${preOccupied} were already occupied — adjust the region`
              : `nothing was placed, though the region is unrestricted — a modal may have eaten the drag, or "${item}" cannot be drag-filled`,
        };
      }

      // Check for water/cliff tiles in the region using the buildable restriction
      // layer (same one inspectArea uses for "~"). Some items (grass, flowers) have
      // a looser restrictionLayer and the planner lets them land on water — warn so
      // the model knows it placed items that will visually float on water.
      const waterCount = (await this.page.evaluate(`(() => {
        const p = window.planner;
        if (!p.restrictionLayersExist || !p.restrictionLayers.buildable) return 0;
        const blocked = new Set(p.restrictionLayers.buildable);
        let n = 0;
        for (let r = ${row}; r < ${row + height}; r++)
          for (let c = ${column}; c < ${column + width}; c++)
            if (blocked.has(c + ", " + r)) n++;
        return n;
      })()`)) as number;

      const lines: string[] = [
        `placed ${addedIn.length} "${item}" tiles in the ${width}x${height} region` +
          (preOccupied > 0 ? ` (${preOccupied} tiles were already occupied and skipped)` : ""),
      ];
      if (waterCount > 0) {
        lines.push(`WARNING: ${waterCount} tile(s) in this region overlap restricted terrain (water/cliffs/edges) — items placed there will appear floating on water; erase and re-fill avoiding those tiles`);
      }
      if (addedOut.length > 0) {
        lines.push(`NOTE: the planner registered some outside the requested region: ${summarize(addedOut)}`);
      }
      if (removed.length > 0) lines.push(`WARNING: the drag also removed: ${summarize(removed)}`);
      lines.push(...(await this.findBlockedDoors(column, row, width, height)));
      return { ok: true, detail: lines.join("\n") };
    });
  }

  async eraseArea(column: number, row: number, width: number, height: number): Promise<OpResult> {
    const win = {
      column: column - ERASE_DIFF_MARGIN,
      row: row - ERASE_DIFF_MARGIN,
      width: width + 2 * ERASE_DIFF_MARGIN,
      height: height + 2 * ERASE_DIFF_MARGIN,
    };
    return this.withModalRetry(async () => {
      // Hard guard: refuse if any tile in the rect belongs to a multi-tile object
      // that also has tiles OUTSIDE the rect (roof overhang is the common case).
      // Uses JS reference equality on objectData — same reference = same instance.
      const overhangBuildings = (await this.page.evaluate(`(() => {
        const p = window.planner;
        const r0 = ${row}, r1 = ${row + height - 1};
        const c0 = ${column}, c1 = ${column + width - 1};
        const insideObjs = new Set();
        for (let r = r0; r <= r1; r++)
          for (let c = c0; c <= c1; c++) {
            const t = p.tiles[r] && p.tiles[r][c];
            if (t && t.objectData) insideObjs.add(t.objectData);
          }
        if (insideObjs.size === 0) return [];
        const danger = new Set();
        for (let r = Math.max(0, r0 - 4); r <= Math.min(64, r1 + 1); r++)
          for (let c = Math.max(0, c0 - 1); c <= Math.min(79, c1 + 1); c++) {
            if (r >= r0 && r <= r1 && c >= c0 && c <= c1) continue;
            const t = p.tiles[r] && p.tiles[r][c];
            if (t && t.objectData && insideObjs.has(t.objectData))
              danger.add(t.objectData.id || t.objectData.name || 'building');
          }
        return [...danger];
      })()`)) as string[];
      if (overhangBuildings.length > 0) {
        return {
          ok: false,
          detail:
            `refused: the region contains roof/overhang tiles of ${overhangBuildings.map((b) => `"${b}"`).join(", ")} — ` +
            `erasing any tile of a multi-tile object destroys the whole thing. ` +
            `Buildings have roof sprites 2–3 rows above their anchor row. ` +
            `To intentionally remove a building, erase its anchor tile (southernmost row).`,
        };
      }

      const before = await this.snapshotRegion(win.column, win.row, win.width, win.height);
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
      const after = await this.snapshotRegion(win.column, win.row, win.width, win.height);
      const { removed } = diffSnapshots(before, after);
      if (removed.length === 0) {
        return { ok: true, detail: `nothing was erased — the ${width}x${height} region was already empty` };
      }
      const outOfRect = removed.filter(
        (t) => t.column < column || t.column >= column + width || t.row < row || t.row >= row + height,
      );
      const lines = [`erased: ${summarize(removed)}`];
      if (outOfRect.length > 0) {
        lines.push(
          `WARNING: the erase reached outside the requested region — erasing any tile of a multi-tile object removes the whole object. Buildings have roof sprites that extend ~2 rows ABOVE the footprint anchor, so a tile in those rows counts as part of the building: ${summarize(outOfRect)}`,
        );
      }
      return { ok: true, detail: lines.join("\n") };
    });
  }

  /** Text grid of occupant ids — exact board state without image tokens. */
  async inspectArea(column: number, row: number, width: number, height: number): Promise<string> {
    const grid = (await this.page.evaluate(`(() => {
      const p = window.planner;
      // restriction layers list RESTRICTED tiles as "col, row" strings
      const blocked = p.restrictionLayersExist ? new Set(p.restrictionLayers.buildable) : new Set();
      const out = [];
      for (let r = ${row}; r < ${row + height}; r++) {
        const line = [];
        for (let c = ${column}; c < ${column + width}; c++) {
          const t = (p.tiles[r] && p.tiles[r][c]) || (p.flooringTiles[r] && p.flooringTiles[r][c]);
          line.push(t && t.objectData ? t.objectData.id : blocked.has(c + ", " + r) ? "~" : ".");
        }
        out.push(line);
      }
      return out;
    })()`)) as string[][];
    const lines = grid.map((line, i) => `row ${row + i}: ` + line.join(" "));
    return `occupants of columns ${column}-${column + width - 1} ("." = empty buildable ground, "~" = unbuildable terrain — water/cliff/edge):\n${lines.join("\n")}`;
  }

  /** PNG of the board canvas only (clipped — cheaper in image tokens). */
  async screenshot(): Promise<Buffer> {
    await this.page.keyboard.press("Escape"); // drop any held brush ghost
    await this.page.waitForTimeout(300);
    const canvas = this.page.locator("canvas").first();
    const png = await canvas.screenshot({ type: "png" });
    // Screenshots stay in the transcript and are re-sent on every later turn,
    // so resolution is a recurring token cost. ~1280px keeps the whole-board
    // layout legible; exact detail goes through inspect_area anyway.
    return this.downscaleImage(png, 1280);
  }

  /** Cap an image's long edge (smoothing on — this is a downscale, not pixel-art zoom). */
  private async downscaleImage(png: Buffer, maxEdge: number): Promise<Buffer> {
    const page = await this.getUtilPage();
    const dataUrl = (await page.evaluate(`(async () => {
      const img = new Image();
      img.src = ${JSON.stringify(`data:image/png;base64,${png.toString("base64")}`)};
      await img.decode();
      const scale = ${maxEdge} / Math.max(img.naturalWidth, img.naturalHeight);
      if (scale >= 1) return null;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png");
    })()`)) as string | null;
    return dataUrl ? Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64") : png;
  }

  /**
   * Crop a fractional region (0-1) of an arbitrary image and upscale it so
   * small objects become legible (nearest-neighbor — the planner art is pixel
   * art, so it stays crisp). Runs in a blank browser page because Node has no
   * built-in image codec, and the planner page's CSP shouldn't be a factor.
   */
  async magnifyImage(base64: string, mediaType: string, left: number, top: number, width: number, height: number): Promise<Buffer> {
    const page = await this.getUtilPage();
    const dataUrl = (await page.evaluate(`(async () => {
      const img = new Image();
      img.src = ${JSON.stringify(`data:${mediaType};base64,${base64}`)};
      await img.decode();
      const sx = Math.floor(img.naturalWidth * ${left});
      const sy = Math.floor(img.naturalHeight * ${top});
      const sw = Math.max(1, Math.round(img.naturalWidth * ${width}));
      const sh = Math.max(1, Math.round(img.naturalHeight * ${height}));
      const scale = Math.max(1, Math.min(8, 1400 / Math.max(sw, sh)));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(sw * scale);
      canvas.height = Math.round(sh * scale);
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png");
    })()`)) as string;
    return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  }

  private utilPage?: Page;

  private async getUtilPage(): Promise<Page> {
    if (!this.utilPage || this.utilPage.isClosed()) this.utilPage = await this.browser.newPage();
    return this.utilPage;
  }

  async savePlan(): Promise<OpResult> {
    const saved = (await this.page.evaluate(`window.planner.savePlan()`)) as { id?: string } | undefined;
    return saved?.id
      ? { ok: true, detail: `${PLANNER_URL}/${saved.id}` }
      : { ok: false, detail: "savePlan() returned no id" };
  }

  // ---- internals ----

  /**
   * Retry once after dismissing modals — the FPS modal can appear mid-action
   * and eat clicks. Only retry if a modal was ACTUALLY dismissed: blind
   * re-execution of a "failed" op that in fact succeeded (e.g. an item that
   * registered offset from the click) would place duplicates.
   */
  private async withModalRetry(fn: () => Promise<OpResult>): Promise<OpResult> {
    await this.dismissModals();
    let result = await fn();
    if (!result.ok && (await this.dismissModals())) {
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

  /**
   * Entrance feedback for a just-placed item: where its own door is (and
   * whether the approach tile is already blocked), plus any existing
   * building's door this item now walls off.
   */
  private async doorNotes(item: string, column: number, row: number): Promise<string[]> {
    const notes: string[] = [];
    const door = DOOR_OFFSETS[item];
    if (door !== undefined) {
      const doorCol = column + door;
      const blocker = await this.objectAt(doorCol, row + 1);
      notes.push(
        blocker
          ? `WARNING: its door at (${doorCol},${row}) is blocked by "${blocker}" on the approach tile (${doorCol},${row + 1}) — clear that tile`
          : `its door is at (${doorCol},${row}); keep the approach tile (${doorCol},${row + 1}) clear and run paths to it`,
      );
    }
    const fp = findItem(item)?.footprint;
    const w = fp?.width ?? 1;
    const h = fp?.height ?? 1;
    notes.push(...(await this.findBlockedDoors(column, row - h + 1, w, h)));
    return notes;
  }

  /**
   * Scan a rectangle for occupied tiles sitting directly in front of (south
   * of) a building's human door. Flooring doesn't count as a blocker — paths
   * belong in front of doors.
   */
  private async findBlockedDoors(column: number, row: number, width: number, height: number): Promise<string[]> {
    return (await this.page.evaluate(`(() => {
      const DOORS = ${DOORS_JSON};
      const p = window.planner;
      const out = [];
      for (let r = ${row}; r < ${row + height}; r++) {
        for (let c = ${column}; c < ${column + width}; c++) {
          const occ = p.tiles[r] && p.tiles[r][c];
          if (!occ || !occ.objectData) continue;
          const n = p.tiles[r - 1] && p.tiles[r - 1][c];
          if (!n || !n.objectData || n === occ) continue;
          const off = DOORS[n.objectData.id];
          if (off === undefined) continue;
          // sprites anchor bottom-left: x/y encode the anchor tile
          const anchorCol = Math.round(n.x / p.tileSize);
          const bottomRow = Math.round(n.y / p.tileSize) - 1;
          if (c === anchorCol + off && r === bottomRow + 1) {
            out.push('WARNING: "' + occ.objectData.id + '" at (' + c + ',' + r + ') blocks the door of the ' + n.objectData.id + ' at (' + c + ',' + (r - 1) + ') — keep that tile walkable');
          }
        }
      }
      return out;
    })()`)) as string[];
  }

  /** Occupant of the objects layer only — flooring underneath doesn't count. */
  private async objectAt(column: number, row: number): Promise<string | null> {
    return (await this.page.evaluate(`(() => {
      const p = window.planner;
      const t = p.tiles[${row}] && p.tiles[${row}][${column}];
      return t && t.objectData ? t.objectData.id : null;
    })()`)) as string | null;
  }

  private async tileContents(column: number, row: number): Promise<string | null> {
    return (await this.page.evaluate(`(() => {
      const p = window.planner;
      const t = (p.tiles[${row}] && p.tiles[${row}][${column}]) || (p.flooringTiles[${row}] && p.flooringTiles[${row}][${column}]);
      return t && t.objectData ? t.objectData.id : null;
    })()`)) as string | null;
  }

  /**
   * Occupancy snapshot of a rectangle, both layers, keyed "o:col,row"
   * (objects) / "f:col,row" (flooring). Diffing two snapshots around a
   * mutation yields what ACTUALLY changed — the planner sometimes registers
   * objects offset from the clicked tile, and erases can take out whole
   * multi-tile buildings, so per-tile read-back of the target alone lies.
   */
  private async snapshotRegion(column: number, row: number, width: number, height: number): Promise<Snapshot> {
    return (await this.page.evaluate(`(() => {
      const p = window.planner;
      const out = {};
      for (let r = ${row}; r < ${row + height}; r++) {
        for (let c = ${column}; c < ${column + width}; c++) {
          const t = p.tiles[r] && p.tiles[r][c];
          if (t && t.objectData) out["o:" + c + "," + r] = t.objectData.id;
          const f = p.flooringTiles[r] && p.flooringTiles[r][c];
          if (f && f.objectData) out["f:" + c + "," + r] = f.objectData.id;
        }
      }
      return out;
    })()`)) as Snapshot;
  }

  /**
   * How many tiles of a rectangle the item's own restriction layer forbids.
   * Layers list RESTRICTED tiles as "col, row" strings; which layer applies
   * (buildable/tillable/accessible) comes from the item's objectData.
   */
  private async countRestricted(
    item: string,
    column: number,
    row: number,
    width: number,
    height: number,
  ): Promise<{ restricted: number; layer: string }> {
    return (await this.page.evaluate(`(() => {
      const p = window.planner;
      const o = p.getObjectByName(${JSON.stringify(item)});
      const layer = (o && o.restrictionLayer) || "buildable";
      if (!p.restrictionLayersExist || !p.restrictionLayers[layer]) return { restricted: 0, layer };
      const blocked = new Set(p.restrictionLayers[layer]);
      let restricted = 0;
      for (let r = ${row}; r < ${row + height}; r++) {
        for (let c = ${column}; c < ${column + width}; c++) {
          if (blocked.has(c + ", " + r)) restricted++;
        }
      }
      return { restricted, layer };
    })()`)) as { restricted: number; layer: string };
  }
}
