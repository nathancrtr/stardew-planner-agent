/**
 * Exploratory probe of stardew.info/planner: dumps page structure, canvas
 * geometry, menu items, and interesting globals so we can design the executor.
 * Writes findings to screenshots/ instead of stdout (stdout pipes get cut).
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

async function main() {
  mkdirSync("screenshots", { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  const consoleLog: string[] = [];
  page.on("console", (msg) => consoleLog.push(`[${msg.type()}] ${msg.text().slice(0, 200)}`));

  console.log("navigating...");
  await page.goto("https://stardew.info/planner", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(8000); // let PixiJS app boot

  // Dismiss the start modal if present
  const startBtn = page.getByRole("button", { name: /start planning/i });
  if (await startBtn.isVisible().catch(() => false)) {
    console.log("clicking Start planning!");
    await startBtn.click();
    await page.waitForTimeout(3000);
  }

  await page.screenshot({ path: "screenshots/probe-after-modal.png" });

  // Canvas elements and their geometry
  const canvases = await page.$$eval("canvas", (els) =>
    els.map((c) => ({
      id: c.id,
      class: c.className,
      width: c.width,
      height: c.height,
      rect: c.getBoundingClientRect().toJSON(),
    }))
  );

  // Visible interactive elements
  const clickables = await page.$$eval(
    "button, [role=button], a, select, input, li, [class*=tool], [class*=menu] *",
    (els) =>
      els
        .filter((e) => (e as HTMLElement).offsetParent !== null)
        .map((e) => ({
          tag: e.tagName,
          id: e.id,
          class: e.className.toString().slice(0, 80),
          text: (e.textContent || "").trim().slice(0, 60),
          title: e.getAttribute("title") || e.getAttribute("data-tooltip") || "",
        }))
        .slice(0, 400)
  );

  // Interesting globals (frameworks, app state).
  // Note: evaluate code passed as strings — tsx/esbuild injects a __name
  // helper into compiled function callbacks that doesn't exist in the page.
  const globals = await page.evaluate(`(() => {
    const skip = ["document", "location", "history", "navigator", "screen",
      "localStorage", "sessionStorage", "performance", "customElements", "visualViewport",
      "crypto", "indexedDB", "caches", "speechSynthesis", "styleMedia", "external",
      "clientInformation", "scheduler", "trustedTypes", "cookieStore", "launchQueue",
      "navigation", "origin", "frames", "self", "window", "parent", "top", "opener",
      "menubar", "toolbar", "locationbar", "personalbar", "scrollbars", "statusbar"];
    const found = {};
    for (const k of Object.getOwnPropertyNames(window)) {
      const v = window[k];
      if (v && typeof v === "object" && !/^(webkit|chrome|on)/.test(k)) {
        const keys = Object.keys(v).slice(0, 30);
        if (keys.length > 0 && !skip.includes(k)) found[k] = keys;
      }
    }
    return found;
  })()`) as Record<string, string[]>;

  // DOM outline to depth 6
  const outline = await page.evaluate(`(() => {
    const walk = (el, depth) => {
      if (depth > 6) return "";
      const id = el.id ? "#" + el.id : "";
      const cls = el.className && typeof el.className === "string"
        ? "." + el.className.trim().split(/\\s+/).slice(0, 4).join(".")
        : "";
      let out = "  ".repeat(depth) + el.tagName.toLowerCase() + id + cls + "\\n";
      for (const child of Array.from(el.children)) out += walk(child, depth + 1);
      return out;
    };
    return walk(document.body, 0);
  })()`) as string;

  writeFileSync("screenshots/probe-report.json", JSON.stringify({ url: page.url(), canvases, clickables, globals }, null, 2));
  writeFileSync("screenshots/dom-outline.txt", outline);
  writeFileSync("screenshots/console-log.txt", consoleLog.join("\n"));
  console.log("wrote screenshots/probe-report.json, dom-outline.txt, console-log.txt, probe-after-modal.png");

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
