import { mkdirSync } from "node:fs";
import { Action, ActionResult, Plan } from "./types.js";
import { PlannerSession } from "./session.js";

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

/** v1 "workflow" mode: execute a pre-computed plan open-loop. */
export async function executePlan(plan: Plan, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
  const session = await PlannerSession.open({ headless: opts.headless, pace: opts.pace });
  try {
    if (plan.layout !== "regular") {
      console.log(`switching layout to ${plan.layout}...`);
      await session.switchLayout(plan.layout);
    }

    const results: ActionResult[] = [];
    for (const [i, action] of plan.actions.entries()) {
      const label = `${i + 1}/${plan.actions.length} ${action.type} ${action.item} @ (${action.column},${action.row})`;
      try {
        const r = action.type === "place"
          ? await session.placeItem(action.item, action.column, action.row)
          : await session.fillArea(action.item, action.column, action.row, action.width ?? 1, action.height ?? 1);
        results.push({ action, ok: r.ok, detail: r.detail });
        console.log(`${r.ok ? "✓" : "✗"} ${label}${r.ok ? "" : ` — ${r.detail}`}`);
      } catch (err) {
        results.push({ action, ok: false, detail: String(err) });
        console.log(`✗ ${label} — ${err}`);
      }
    }

    let screenshot: string | undefined;
    if (opts.screenshotPath !== "") {
      mkdirSync("screenshots", { recursive: true });
      screenshot = opts.screenshotPath ?? `screenshots/result-${Date.now()}.png`;
      const buf = await session.screenshot();
      const { writeFileSync } = await import("node:fs");
      writeFileSync(screenshot, buf);
    }

    let shareUrl: string | undefined;
    if (opts.save) {
      const saved = await session.savePlan();
      if (saved.ok) shareUrl = saved.detail;
    }

    if (!(opts.headless ?? false)) await session.page.waitForTimeout(2000);
    return { results, screenshot, shareUrl };
  } finally {
    await session.close();
  }
}
