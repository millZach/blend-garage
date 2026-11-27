# Drop `.blend` Car Models Here

Place any `.blend` car file in this folder (`cars/incoming/`), then run:

```bash
npm run import-cars
```

Or leave the auto-watcher running while you work in Blender:

```bash
npm run watch-cars
```

### What happens automatically
1. Headless Blender exports each `.blend` into a normalized `.glb` (meters scale, centered X/Y, tires grounded at `Y = 0` in Three.js).
2. Detected wheels, `part_*` panels, `slot_*` empties, and paint/rim/glass materials are indexed into `vehicle.json`.
3. Cars immediately show up in their own parking bay inside the Interactive Garage—even if you haven't added any special naming tags yet!

See `AGENTS.md` in the repo root for optional naming tags (`wheel_FL`, `part_spoiler`, `slot_spoiler`, `mat_paint_primary`, etc.).
