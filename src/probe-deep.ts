/**
 * Deep probe of the window.planner object: menu geometry, tile math,
 * layout info — everything the executor needs.
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

  await page.goto("https://stardew.info/planner", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(8000);

  for (const name of [/start planning/i, /i understand/i]) {
    const btn = page.getByRole("button", { name });
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(2000);
    }
  }

  const report = await page.evaluate(`(() => {
    const p = window.planner;
    const safe = (obj, fields) => {
      const out = {};
      for (const f of fields) {
        try {
          const v = obj?.[f];
          if (v === null || ["string", "number", "boolean"].includes(typeof v)) out[f] = v;
          else if (v !== undefined) out[f] = "<" + typeof v + ">";
        } catch (e) { out[f] = "<err>"; }
      }
      return out;
    };
    const bounds = (s) => {
      try { const b = s.getBounds(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }
      catch (e) { return null; }
    };
    const menuItem = (m) => ({
      name: m?.name, label: m?.label, id: m?.id, type: m?.type,
      text: m?.text, item: typeof m?.item === "object" ? safe(m.item, Object.keys(m.item).slice(0, 20)) : m?.item,
      visible: m?.visible, bounds: bounds(m),
      keys: Object.keys(m || {}).slice(0, 40),
    });
    return {
      scalars: safe(p, ["tileSize", "toolbarHeight", "guiPadding", "defaultWidth", "defaultHeight", "brushMode", "brushType"]),
      spriteMenuItems: Array.isArray(p.spriteMenuItems) ? p.spriteMenuItems.slice(0, 60).map(menuItem) : typeof p.spriteMenuItems,
      toolsMenuItems: Array.isArray(p.toolsMenuItems) ? p.toolsMenuItems.slice(0, 60).map(menuItem) : typeof p.toolsMenuItems,
      optionDropdownItems: Array.isArray(p.optionDropdownItems) ? p.optionDropdownItems.slice(0, 30).map(menuItem) : typeof p.optionDropdownItems,
      activeLayout: typeof p.activeLayout === "object" && p.activeLayout
        ? { keys: Object.keys(p.activeLayout).slice(0, 60), ...safe(p.activeLayout, Object.keys(p.activeLayout).slice(0, 60)) }
        : p.activeLayout,
      userOptions: typeof p.userOptions === "object" && p.userOptions ? safe(p.userOptions, Object.keys(p.userOptions)) : p.userOptions,
      sessionOptions: typeof p.sessionOptions === "object" && p.sessionOptions ? safe(p.sessionOptions, Object.keys(p.sessionOptions)) : p.sessionOptions,
      plannerKeys: Object.keys(p),
      plannerProtoKeys: Object.getOwnPropertyNames(Object.getPrototypeOf(p) || {}),
    };
  })()`);

  writeFileSync("screenshots/planner-deep.json", JSON.stringify(report, null, 2));
  console.log("wrote screenshots/planner-deep.json");

  // Also fetch the app bundle for local grepping
  const bundle = await page.evaluate(`fetch("/planner/lib/planner.js?v=09022026").then(r => r.text())`);
  writeFileSync("screenshots/planner-bundle.js", bundle as string);
  console.log("bundle size:", (bundle as string).length);

  await page.screenshot({ path: "screenshots/planner-ready.png" });
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
