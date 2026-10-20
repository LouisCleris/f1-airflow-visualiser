# Airflow Visualiser — Build Specification

**Author:** the author
**What this is:** A browser tool that shows beautiful, readable airflow around my own 3D models — an F1 car on a road with rotating wheels, and a Falcon 6X jet in the sky.
**What this is not:** A CFD solver. It does not compute forces and it will not display any number that looks computed. It is a visualisation.

A previous attempt was abandoned because it was started the wrong way. This build should be simple, finished, and good-looking rather than technically ambitious.

---

## 1. The two scenes

### Scene A — F1 car on track
- Car sits on a road surface, viewed from a free orbit camera
- **Wheels rotate** while the simulation runs
- Two driving states, selected by the user:
  - **Straight line** — airflow parallel to the car's centreline, high speed
  - **Cornering** — airflow arrives at a yaw angle (the car is turning), so flow hits the car at an angle and behaves asymmetrically
- Optional: a speed slider that changes how fast the streamlines move and how fast the wheels spin

### Scene B — Falcon 6X in flight
- Jet suspended in open sky with a **cloud background**
- Airflow along the fuselage, over the wings
- Optional: a small pitch control so the user can angle the aircraft into the flow

---

## 2. The visualisation itself

This is the whole point of the tool, so it should look genuinely good.

**Streamlines / particle traces**
- Thousands of small particles released upstream, flowing over and around the model
- They should visibly deflect around the bodywork, accelerate over curved surfaces, and swirl in the wake behind the car
- Trails, not dots — each particle leaves a short fading ribbon so the flow reads as lines
- Colour by local speed: cool colours where flow is slow, warm where it is fast. A simple legend saying "slower / faster" with no numbers.

**What should be visible by eye**
- Air splitting at the nose and front wing
- Flow speeding up over the top of the bodywork and through the venturi under the floor
- Turbulent, messy wake behind the rear wing and behind the wheels
- Asymmetry when cornering: one side of the car shielded, the other exposed
- On the jet: clean attached flow over the wing, and the wake trailing off the wingtips

**Controls**
- Play / pause / reset
- Particle density slider
- Trail length slider
- Toggle streamlines on and off to see the model alone
- Camera presets (front, side, top, three-quarter) plus free orbit

---

## 3. How the flow is generated (kept simple)

The flow field does not need to be a real solver. A well-tuned approximate field looks better than a badly-tuned real one, and this is explicitly a visualisation.

Suggested approach, simplest first:

1. **Base flow** — a uniform velocity field in the flow direction (set by straight-line or cornering yaw angle)
2. **Obstacle avoidance** — particles are pushed around the model surface rather than through it. Simplest reliable method: precompute a low-resolution occupancy grid from the mesh, and deflect particle velocity away from occupied cells based on the local surface normal.
3. **Speed-up over curvature** — where flow is squeezed between the body and the ground, or over a curved upper surface, increase local velocity. This is what makes it read as aerodynamics rather than smoke.
4. **Wake turbulence** — behind the model, add randomised swirl that decays with distance. This is the detail that makes the visual convincing.

Do **not** attempt Navier-Stokes, lattice-Boltzmann, or panel methods. Out of scope.

---

## 4. No computed numbers

The interface displays **no drag or lift coefficients, no forces, no pressures**. The output is the visual.

If reference values are wanted for educational context, they may appear only as clearly labelled published data, for example: *"Published reference: a Formula 1 car has a drag coefficient of roughly 0.7–1.1 depending on downforce setup. Not computed by this tool."* Otherwise, omit entirely.

A short, permanently visible line should state: *"Approximate flow visualisation for illustration. Not a computational fluid dynamics simulation."*

---

## 5. Geometry input

Use my existing exports; I should not have to rebuild models.

- Load **GLB/GLTF** (primary) and OBJ
- Preserve component names. Note: multi-component Blender OBJ exports need a line-by-line parser tracking `o ` markers, since generic scene loaders silently merge geometry and lose names. Geometry names survive GLB export and are readable as `mesh.name` during traversal.
- Handle high face counts: F1 car is 29 components and 240k+ faces; Falcon 6X is 6 components and ~163k faces. Decimate for the occupancy grid if needed, but keep the full mesh for display.
- If decimating, use an explicit target reduction and check visually for holes. Over-aggressive decimation has previously produced visible holes in watertight meshes.

---

## 6. Component descriptions

Each part of the F1 car has a short description I have written of its aerodynamic purpose (front wing, DRS system, floor, sidepods, rear wing, and so on). The tool should let the user click a component and read its description, as in my existing viewer.

This is my own written content and is part of what the tool is for: showing not just what the airflow looks like, but why each surface is shaped the way it is.

---

## 7. Interface requirements

- All text in **English**
- Descriptions written from a mechanical and aerospace engineering perspective
- A desktop-browser tool: on a screen too small for the layout, the page shows only a notice to open it on a computer
- Self-contained deployable build, consistent with my existing Three.js viewer
- Visual style: clean, minimal, monochrome UI so the flow colours stand out

---

## 8. Build order

**Phase 1** — Load the F1 GLB, render it on a road surface, free orbit camera, rotating wheels. No airflow yet.
*Check: model displays correctly, components named, wheels spin, runs in the browser.*

**Phase 2** — Particle system with uniform base flow and trails, no obstacle interaction.
*Check: particles flow smoothly at high density without frame drops.*

**Phase 3** — Obstacle deflection from the occupancy grid, so flow goes around the car rather than through it.
*Check: no particles pass through bodywork.*

**Phase 4** — Curvature speed-up, wake turbulence, speed-based colouring, legend.
*Check: it looks like airflow. This is the phase to iterate on visually until it is genuinely good.*

**Phase 5** — Straight-line vs cornering states; yaw angle changes flow direction and produces visible asymmetry.

**Phase 6** — Falcon 6X scene with cloud background and optional pitch control.

**Phase 7** — Component click-to-read descriptions, camera presets, UI polish, disclaimer line.

---

## 9. Assets I have

- F1 car (2026-spec), 29 components, 17 logical groups, GLB
- Falcon 6X, 6 components, GLB
- An aircraft part modelled from a 2D technical drawing, plus the drawing itself
- Written aerodynamic descriptions for the F1 components

---

## 10. Disclosure

This tool is built with AI assistance: the code is AI-generated to my specification, not hand-written by me. The 3D models, this specification, and the design decisions are my own. The component descriptions are based on my own notes and research, written with AI assistance. Any use of this tool in an application or portfolio must state that plainly, and must describe the tool as an approximate visualisation rather than a simulation.
