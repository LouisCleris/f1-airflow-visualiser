# Interface design (Phase 7)

The approved layout for the F1 viewer. Build the interface to match it.

## Files

| File | What it shows |
| --- | --- |
| `1-desktop-viewer.png` | Desktop layout, 1440 × 900, with a component card open |
| `4-ui-kit.png` | Colours, type and controls |
| `html/` | The same two screens as plain HTML and CSS |
| `html/fonts/` | Geist and Geist Mono, variable woff2 |

Take exact colours, sizes and spacing from the HTML files, not by eye from the PNGs.

## Rules

- The background picture is a placeholder render. The live 3D view goes there.
- The Falcon 6X and Cornering buttons are in the design but deferred to Phases 5 and 6. Leave them out of the build for now.
- Keep the current three-stop legend from Phase 4 (Slower / Oncoming air / Faster). The design still shows an older two-stop version.
- Fonts: inline Geist and Geist Mono in the final build so it works offline. No Google Fonts link.
- No computed numbers anywhere. The disclaimer line is always visible.

## Component cards

- Cards read `data/components.json`. An empty `description` shows the title only.
- Clicking a part of the car opens the card for its group. Both mirrored halves resolve to the same entry.
- The part buttons (Full car, Front wing, Front wheels, Sidepods, Floor, Rear wing, Wake) open the matching card and move the camera to that part.
- "Show flow around this part only" shows only streamlines from that entry's `flowGroups` in `data/rakes.json`.
- Sidepods and Diffuser have no mesh of their own (they are part of Main body and Floor), so they open from the buttons only.
