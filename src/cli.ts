import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { makePlan } from "./plan.js";
import { executePlan } from "./executor.js";
import { runAgent, runInteractive } from "./agent.js";
import { PlanSchema } from "./types.js";

const USAGE = `Usage: npm run agent -- "<layout request>" [options]

Modes:
  (default)         agentic loop — Claude builds, sees results, adapts, exits
  -i, --interactive conversational shell — keep refining with follow-ups ("move the
                    flower patch three tiles right") until you type 'exit'
  --oneshot         v1 workflow — Claude plans once, code executes open-loop

A request (CLI or shell prompt) starting with '/image <path> [instructions]' attaches
a local image — e.g. a screenshot of a farm to recreate (best-effort). Quote paths
containing spaces.

Options:
  --headless        run the browser invisibly (default: headed, watchable)
  --save            save the plan on stardew.info and print the share URL
  --pace <ms>       pause between actions (default 250)
  --max-turns <n>   agentic mode: cap on loop iterations (default 30)
  --dry-run         oneshot only: print the generated plan JSON, don't run a browser
  --plan <file>     oneshot only: execute an existing plan JSON file

Examples:
  npm run agent -- "Place a Junimo Hut in the center of a standard farm, surrounded by a perfect grid of Iridium Sprinklers and Ancient Fruit crops"
  npm run agent -- -i "/image my-farm.png recreate this layout"
  npm run agent -- --oneshot --plan plans/my-plan.json --headless`;

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set<string>();
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (["--plan", "--pace", "--max-turns"].includes(args[i])) opts[args[i].slice(2)] = args[++i];
    else if (args[i].startsWith("--")) flags.add(args[i].slice(2));
    else if (args[i] === "-i") flags.add("i");
    else positional.push(args[i]);
  }

  const request = positional.join(" ").trim();
  const interactive = flags.has("interactive") || flags.has("i");
  if (!request && !opts.plan && !interactive) {
    console.log(USAGE);
    process.exit(1);
  }

  const headless = flags.has("headless");
  const save = flags.has("save");
  const pace = opts.pace ? Number(opts.pace) : undefined;

  if (interactive) {
    await runInteractive(request || undefined, {
      headless,
      save,
      pace,
      maxTurns: opts["max-turns"] ? Number(opts["max-turns"]) : undefined,
    });
    return;
  }

  if (!flags.has("oneshot") && !opts.plan && !flags.has("dry-run")) {
    await runAgent(request, {
      headless,
      save,
      pace,
      maxTurns: opts["max-turns"] ? Number(opts["max-turns"]) : undefined,
    });
    return;
  }

  // ---- v1 workflow mode ----
  let plan;
  if (opts.plan) {
    plan = PlanSchema.parse(JSON.parse(readFileSync(opts.plan, "utf8")));
    console.log(`loaded plan from ${opts.plan}: ${plan.actions.length} actions`);
  } else {
    console.log("asking Claude to design the layout...");
    plan = await makePlan(request);
    mkdirSync("plans", { recursive: true });
    const planFile = `plans/plan-${Date.now()}.json`;
    writeFileSync(planFile, JSON.stringify(plan, null, 2));
    console.log(`\n${plan.summary}\n`);
    console.log(`plan: ${plan.actions.length} actions on the "${plan.layout}" farm (saved to ${planFile})`);
  }

  if (flags.has("dry-run")) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  console.log("\ndriving stardew.info/planner...\n");
  const { results, screenshot, shareUrl } = await executePlan(plan, { headless, save, pace });

  const okCount = results.filter((r) => r.ok).length;
  console.log(`\ndone: ${okCount}/${results.length} actions succeeded`);
  if (screenshot) console.log(`screenshot: ${screenshot}`);
  if (shareUrl) console.log(`share URL: ${shareUrl}`);
  if (okCount < results.length) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
