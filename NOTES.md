# stardew.info/planner — reverse-engineering notes (probed 2026-06-10)

Stardew Planner **V3** by Henrik Peinar. Single PixiJS (WebGL) canvas app; all
menus/toolbars are rendered inside the canvas — there are no DOM menus. The app
exposes a global `window.planner` object which is the whole API surface.

## Boot sequence

1. `https://stardew.info/planner` → `#mainModal` ("Start planning!" button)
2. Under SwiftShader/software GL a `#performanceModal` ("I understand") appears next
3. Then the board is interactive. WebGL works headless only with
   `--enable-unsafe-swiftshader --use-angle=swiftshader`.

## Key `window.planner` facts

- `tileSize: 16` (world px per tile), `toolbarHeight: 55`, `guiPadding: 80`
- Catalogs (dicts keyed by object id): `crops` (65), `craftables` (147),
  `buildings` (39), `furniture` (578), `misc` (381). Dumped to `data/catalog.json`.
- `getObjectByName(id)` searches all catalogs.
- `changeGhostSprite(objectData)` → picks item up as the cursor "brush"
  (ghost sprite follows pointer; placement happens on pointerdown via
  `globalPointerDown`).
- `renderTile(objectData, xWorldPx, yWorldPx, planner.tiles)` → direct
  programmatic placement (snaps internally). Follow with `pushBoardState()` +
  `renderPostprocess()`.
- `snapPosition(x, y)` → `{x, y, row, column}` (floor division by 16).
- Sprites anchor `(0,1)` (bottom-left): a sprite placed on tile `(col,row)` gets
  `x = col*16`, `y = row*16 + 16`; multi-tile buildings extend up/right from the
  clicked tile.
- `checkRestriction` / `restrictionLayers` (`accessible`, `buildable`,
  `tillable`) validate placement.
- `loadLayout(layoutObj)` switches farm map; `planner.layouts` is a dict:
  `regular`, `combat`, `fishing`, ... Regular farm: 1280×1040 world px =
  **80 cols × 65 rows**; house at col 59 row 16, greenhouse col 24 row 17.
- `getBoardState()` / `restoreBoardState()` — full board serialization (verify
  placements). `savePlan()` saves and yields a shareable URL. `exportPlanImage()`.
- `viewport` is pixi-viewport (`toScreen`, `toWorld`, `setZoom`, …), but the
  simplest tile→screen conversion is
  `planner.plannerSpriteContainer.toGlobal({x: col*16+8, y: row*16+8})`
  which returns canvas-CSS-pixel coords; add the canvas bounding rect offset
  to get page coordinates for `page.mouse`.

## Interaction model for the executor

1. Select: `changeGhostSprite(getObjectByName(id))` (ghost visibly attaches to cursor)
2. Move: `page.mouse.move()` to the tile's page coords (ghost follows — watchable)
3. Place: `page.mouse.down()/up()` → app's own pointer pipeline handles it
4. Verify: `getBoardTileContents` / `getBoardState()`

## Gotchas

- `page.evaluate` with function callbacks breaks under tsx (esbuild injects
  `__name` helper missing in page context) — pass evaluate code as strings.
- `networkidle` never settles (ad/analytics endpoints get connection-refused
  in sandbox) — use `domcontentloaded` + explicit waits.
- The bundle lives at `/planner/lib/planner.js?v=09022026` (saved to
  `screenshots/planner-bundle.js` for grepping).
- The "Low PERFORMANCE detected" modal is FPS-triggered and appears several
  seconds *after* page load (always under SwiftShader). It silently eats all
  canvas clicks. The executor dismisses modals before every action and retries
  a failed action once after re-dismissing.
- Crop ids are SEED ids (`ancient-seeds`, not `ancient-fruit`). Official layout
  names: regular, combat (=wilderness), fishing (=riverlands), foraging
  (=forest), mining (=hilltop), ranching (=meadowlands), beach, fourcorners,
  ginger_island, quarry.
- `brushMode` (`"single"`/`"multi"`) is set by `changeBrushMode` inside
  `changeGhostSprite` from the item's group: FURNITURE/BUILDINGS/CRAFTABLES
  groups and TREES/GIANT_CROPS subgroups get `single` (a drag places ONE
  object); everything else (crops, flooring, fences) gets `multi` (drag paints
  a ghost rectangle, placed on mouseup with per-tile restriction checks).
  To drag-fill 1x1 craftables (kegs etc.), set `planner.brushMode = "multi"`
  AFTER `changeGhostSprite` — the same mouseup pipeline handles them fine.
