# Browser checks for the garage

Scripts that open the running app in headless Edge and use it the way a person does. They need the
dev server (`npm run dev`) and Node 22 or newer, and nothing else.

| Run | What it does |
| --- | --- |
| `node tools/verify/sweep.mjs` | Loads all 14 cars on the selector; prints load time, wheels found, draw calls, fps and GPU memory for each. |
| `node tools/verify/journey.mjs <car-id>` | Rolls one car into the shop and uses every sidebar tool, the lift, the moods and the cameras with real clicks. |
| `node tools/verify/stability.mjs` | Switches between four cars three times and checks that memory and frame rate do not drift. |

Screenshots go to `blend-garage-shots` in the system temp folder (override with `VERIFY_SHOTS`).
Every script ends by listing console errors and warnings; an empty list is the pass.

The scripts read state through `window.__garage`, which the app only exposes in development builds.
`cdp.mjs` (the browser driver) and `hud.mjs` (click helpers) are shared by the three scripts.
