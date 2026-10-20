Louis Cleris

# F1 Airflow

An interactive 3D viewer that shows approximate airflow around two of my own models: an F1 car on a race track and a Falcon 6X business jet in the sky. Streamlines bend around the bodywork, speed is shown as colour (blue slower than the oncoming air, orange faster), and short-lived particles trace the turbulent wake. Click a part, or use the part buttons, to read what it does and to look at the flow around it alone.

It is an approximate visualisation, not a simulation. Nothing is solved: the flow is drawn from hand-authored guide curves that describe the paths the air takes. It shows no numbers, such as forces or coefficients, on purpose.

## What it shows

- **F1, Straight line.** Air arriving straight at the nose, dividing over and around the front wing, the wheels, the sidepods and the floor, and leaving in a wake behind the rear wing.
- **F1, Cornering.** The car in a constant-radius left-hand corner. Seen from the car, the oncoming air moves in arcs centred on the corner's centre: it arrives along the track ahead, passes the car and leaves along the track behind, with both ends bending towards the inside. Air further from the centre moves a little faster, and the car points slightly into the corner, so the right flank is exposed and the left flank sits in its lee. The front wheels steer and the wake swings towards the inside.
- **Falcon 6X.** Air dividing at the nose, accelerating over the wings and slowing underneath, drawn into the engines and out of their exhausts, and a tip vortex trailing from each winglet.
- **Moving scenery.** The background moves so the car and the jet read as moving. On the straight, an endless track streams past at exactly the speed of the oncoming air, like the rolling road of an F1 wind tunnel, and the wheels turn at the matching speed. In the corner, an endless ring of track turns about the corner's centre. Under the jet, the cloud deck drifts past. All of it follows the Speed slider and stops with Pause.

It runs in a desktop browser.

## Run it

You need Node.js. From this folder:

```
npm install
npm run dev        # development server; prints a local address
npm run build      # builds dist/ (re-traces the streamlines first if the flow has changed, which takes a few minutes)
npm test           # project checks (flow, speed pattern, cornering asymmetry, source models untouched)
npm run test:ui    # interface checks in headless Chrome (add "dist" to test the built site)
```

`dist/` is a plain static site (`index.html` plus the model and data files it loads), so it can be served by any static host, for example `npx serve dist` or GitHub Pages.

## Disclosure

This tool is built with AI assistance: the code is AI-generated to my specification, not hand-written by me. The 3D models, this specification, and the design decisions are my own. The component descriptions are based on my own notes and research, written with AI assistance. The interface design was made with Claude Design to my brief. Any use of this tool in an application or portfolio must state that plainly, and must describe the tool as an approximate visualisation rather than a simulation.
