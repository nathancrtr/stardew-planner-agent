# Visual Quality Issues — Handoff

Bugs and prompt gaps identified from run-1781305830184 (`23-good-flies-engaged-jovially`).
Pick these up fresh; don't rely on the session that produced this document.

---

## 1. Grass tiles not blending (UNRESOLVED — needs investigation)

**Symptom:** The agent fills large areas with `grass-1`, `grass-2`, `blue-grass-1`, etc.
via `fill_area`. In the screenshot, these render as a rigid grid of identical, separate
grass sprites. Adjacent tiles do NOT visually merge.

**What should happen:** Per user testing, adjacent grass tiles in the planner ARE supposed
to auto-tile and blend into a continuous surface (same as floor tiles do). This is testable
in the browser by hand.

**Hypothesis — where to look:**
- `fill_area` forces `brushMode = "multi"` before dragging. This is needed for craftables,
  but grass/terrain tiles may use a different internal brush type. Forcing MULTI might
  suppress the planner's auto-tile neighbor-update logic for grass tiles specifically.
- Timing: the row-by-row drag loop issues `waitForTimeout(60)` per row. If the planner
  defers neighbor recalculation, more time (or a `waitForTimeout` at the end of the fill)
  might be needed.
- Item identity: `grass-1` vs `grass-2` vs `blue-grass` are separate catalog entries.
  The planner might only blend tiles of the exact same variant. If the model mixes
  variants in adjacent fills, visible seams appear at the boundary.

**Recommended investigation path:**
1. In the browser dev console, place a 5×5 block of `grass-1` manually and observe
   whether it blends. If yes, reproduce by calling `fillArea` with `grass-1` only and
   check the result.
2. If `fill_area` doesn't blend: probe the ghost sprite's `brushType` after
   `changeGhostSprite("grass-1")`. If it's not the same brush type used when clicking
   manually, that's the bug.
3. If blending only works within a single variant: add a prompt note telling the model
   to pick ONE grass variant per zone and fill the entire zone with only that variant.

---

## 2. Grass placed on water tiles (PARTIALLY FIXED)

**Symptom:** The model fills areas that include the natural pond with `fill_area`, placing
grass/flower sprites directly onto water tiles. The planner accepts these placements
(grass has a looser restriction layer than buildings) and they render as objects floating
on water.

**What's already done:** `session.ts fillArea()` now runs a post-placement check against
the `buildable` restriction layer (the same one `inspectArea` uses for `~`) and emits:
> `WARNING: N tile(s) in this region overlap restricted terrain (water/cliffs/edges) —
> items placed there will appear floating on water; erase and re-fill avoiding those tiles`

**Remaining gap:** The model needs a prompt rule to proactively avoid this:
> Before filling any region that borders water or cliffs, call `inspect_area` first and
> verify no `~` tiles appear in the target rectangle. If they do, split the fill into
> sub-regions that avoid the restricted tiles.

Add this to the "# How to work" section of the system prompt.

---

## 3. Service areas hidden behind building roofs (UNRESOLVED)

**Symptom:** The smithy yard (furnaces, anvil) was placed immediately ABOVE the furnace
shed (lower row numbers = north of the building). In the planner's top-down view, the
building's roof sprite visually covers everything placed at lower row numbers, making the
entire crafting area invisible.

**Fix:** Add to the "# Board model" or "# Design principles" section:
> Objects placed at row numbers LOWER than (above/north of) a building are visually
> obscured by the building's roof sprite. Place crafting yards and decorative elements
> at the SAME row or HIGHER row number (south/below) than adjacent buildings.

Also add to the exit checklist (item 9):
> Crafting yards and named service zones are visible in the screenshot — not hidden behind
> a building roof.

---

## 4. Chairs and benches facing illogically (UNRESOLVED — needs catalog research)

**Symptom:** Chairs/benches placed near the pond face away from the water. Chairs near
campfires face in inconsistent or illogical directions.

**What NOT to assume:** An earlier session incorrectly assumed all chairs face south and
can't be changed. Discard that. The planner may support directional furniture variants or
the default facing may vary by item type — this needs fresh investigation.

**Recommended investigation path:**
1. Open the planner in the browser. Place one `oak-bench` or `birch-bench`. Note which
   direction it faces by default.
2. Check whether clicking or right-clicking rotates it, or whether the planner has
   directional variants (like fences have `-ne`, `-sw`, etc.).
3. If rotation is available: add to the system prompt how to use it (click to rotate?
   right-click?). If directional catalog variants exist: document them.
4. If facing is fixed and uniform: add a prompt rule like "place seating on the side
   of the focal point that makes the default facing point toward it."

---

## 5. Session.ts change from this session

The only code change applied was in `session.ts fillArea()` (the water-overlap warning,
item 2 above). It passed `npm run typecheck`. No prompt changes were committed.
