import "dotenv/config";
import { runInteractive } from "./src/agent.js";

const REQUEST = `# Farm Plan

We will be laying out a mid-game farm (Regular farm type) that is approaching Year 3. The primary income drivers of the farm are artisan animal goods and wine, but the farm is already extremely profitable, and thus I would like to emphasize a relaxed, decorative, cottagecore aesthetic that emphasizes diverse crop growth for role-playing as a vegetable farmer with a culinary interest so I can collect and cook lots of recipes.

## Layout

Generally speaking, we will be thinking in *vertical* and *horizontal* thirds for the layout of the farm:

### Vertical

| Left                     | Center | Right        |
|--------------------------|--------|--------------|
| Wild forest, forageables | Crops  | Barns, coops |

### Horizontal

| Top                                        | Center                             | Bottom                                                                                   |
|--------------------------------------------|------------------------------------|------------------------------------------------------------------------------------------|
| Farmhouse Greenhouse Fruit bat cave Stable | Mixed (forest, crops, barns/coops) | Naturalistic zone, orchard, pond. A park-like feel with pathing, benches, lighting, etc. |

## Zone characters

**Left — Wild forest**
An old-growth forest you'd wander into: dense mixed canopy of oak, maple, mahogany, and pine, with stumps, mushroom logs, and large rocks on the floor. Patches of wild forageable plants fill clearings between trees. The eastern edge should dissolve gradually into the crop zone — solitary trees and wildflowers bridging wild and cultivated, no hard boundary line.

**Top band — Working farmyard**
The productive heart of the property: tidy but dressed up. Cobblestone underfoot, flower planters and tubs flanking every building entrance, iron lamp posts marking the road. The furnace yard behind the shed should feel like a smithy. Buildings are workmanlike but not bare — flowers and small decorative accents at every door.

**Center — Cottage kitchen garden**
Small distinct plots growing a variety of vegetables, separated by gravel paths narrow enough to feel intimate. Scarecrows stand between plots as characters, not just mechanics. Flowers grow at the edges of beds — this is a garden someone tends lovingly, not a commercial field. The bee garden below the crops is a flower meadow with hives tucked among the blooms.

**Right — Livestock paddock**
A proper working farm paddock: hardwood-fenced, grassy, ordered. The one zone where crisp alignment is intentional — animals have room to graze, barn and coop doors have clear straw-floored approaches. Functional and purposeful; the contrast with the softer zones around it is part of the aesthetic.

**Bottom — Orchard and lakeside park**
The zone that invites lingering. Fruit trees with wildflowers growing beneath them, connected by meandering steppingstone paths. A campfire with chairs tucked into the orchard for a gathering spot. The natural pond is the focal point of the whole bottom zone: benches face the water, lamp posts frame the shore, flowers edge the bank. Fish ponds flank it. This zone should reward the player for walking through it.

## Design

The overall feel is cottagecore/naturalistic. Fundamental gameplay ergonomics must still be respected — the daily loop must remain tight and efficient.

The cultivated, high-traffic farm lives in the center and right; the wild, beautiful, low-touch farm lives on the left and bottom.

Barns and coops should be enclosed in hardwood fencing with grass growing within to allow livestock to graze. This space can be somewhat large, as it could support as many as 50 animals eventually.

Crops should be organized around iridium sprinklers, of which I have a dozen available. Drop scarecrows throughout so the crops are protected.

Make liberal use of pathing within the daily loop, as this formalizes the route, is aesthetically pleasing, and makes the player character run faster.

No cultivated or transitional zone should have large patches of bare grass or dirt — after placing functional elements, fill remaining ground with flowers, mixed ground cover, floor tiles, or small decorative objects until the zone feels fully inhabited.

### Materials

**Floors and paths:**
- Farmyard road (top band, past sheds and mill): cobblestone
- Main north–south connector: cobblestone or wood-path
- Between crop plots (internal garden paths): gravel-path
- Park promenade and orchard meander: steppingstone
- Paddock door approaches: straw-floor; paddock interior: grass
- Forest floor: no hard flooring — grass and ground items only

**Lighting:**
- Iron lamp posts along the working road and near sheds/mill
- Wood lamp posts along garden paths, park promenade, and orchard — every 6–10 tiles and at every path junction

## Object inventory

### Buildings

* Farmhouse
* Greenhouse (completed)
  * Contains fruit trees, starfruit, ancient fruit for wine
* Big shed x2
  * One contains keg production; one contains the furnaces
* Stable
  * Attached to farmhouse
* Deluxe barn x2
* Deluxe coop x2
* Mill
* Silo x2

### Craftables

* Beehives 12x
  * Placed in the flower meadow bee garden below the crops, with flowers and sprinklers for synergy
* Furnaces 12x
  * Located in the smithy yard behind the furnace shed
* Fish pond(s)
  * Flanking the natural pond in the bottom park zone

### Decorative

* Flowers throughout — mixed species per area, not separated by type: tulips, blue jazz, sweet peas, fairy roses, poppies, summer spangle
* Ground cover fill between larger elements: grass-1, grass-2, blue-grass varieties
* Tub-o'-flowers flanking every building entrance
* Forest floor accents: large stumps, large rocks, mushroom logs as landmarks; wild-seed forage patches in clearings
* Seating: benches facing the pond; campfire with chairs in the orchard — always oriented toward a focal point
* Torches or small lanterns at path junctions in the forest and garden`;

await runInteractive(REQUEST, { headless: false, model: "claude-opus-4-8", maxTurns: 50 });
