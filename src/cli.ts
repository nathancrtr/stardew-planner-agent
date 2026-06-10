import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { makePlan } from "./plan.js";
import { executePlan } from "./executor.js";
import { PlanSchema } from "./types.js";

const USAGE = `Usage: npm run agent -- "<layout request>" [options]

Options:
  --headless        run the browser invisibly (default: headed, watchable)
  --save            save the plan on stardew.info and print the share URL
  --dry-run         print the generated plan JSON without driving the browser
  --plan <file>     skip Claude and execute an existing plan JSON file
  --pace <ms>       pause between actions (default 250)

Examples:
  npm run agent -- "Place a Junimo Hut in the center of a standard farm, surrounded by a perfect grid of Iridium Sprinklers and Ancient Fruit crops"
  npm run agent -- --plan plans/my-plan.json --headless`;

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set<string>();
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--plan" || args[i] === "--pace") opts[args[i].slice(2)] = args[++i];
    else if (args[i].startsWith("--")) flags.add(args[i].slice(2));
    else positional.push(args[i]);
  }

  const request = positional.join(" ").trim();
  if (!request && !opts.plan) {
    console.log(USAGE);
    process.exit(1);
  }

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
  const { results, screenshot, shareUrl } = await executePlan(plan, {
    headless: flags.has("headless"),
    save: flags.has("save"),
    pace: opts.pace ? Number(opts.pace) : undefined,
  });

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
