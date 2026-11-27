import * as THREE from 'three';
import { seededRandom } from '../math';
import type { MeshBatcher } from '../MeshBatcher';
import { BAY_X, HALL, roofY } from './layout';
import type { ShopMaterials } from './materials';

/**
 * Where the two tripod worklights stand, and how high their lamp heads are. The lighting rig aims real
 * lights from here. They stand out by the bay lines, clear of every preset camera's view of the car.
 */
export const WORKLIGHTS = [
  { x: 5.7, z: 2.3, height: 1.8 },
  { x: -5.5, z: 3.3, height: 1.8 },
] as const;

const HALF_PI = Math.PI / 2;

function shadow(b: MeshBatcher, m: ShopMaterials, w: number, d: number, x = 0, z = 0): void {
  b.decal(m.blob, w, d, x, 0.006, z);
}

function caster(b: MeshBatcher, m: ShopMaterials, x: number, z: number, r = 0.055): void {
  b.cyl(m.rubber, r, 0.04, x, r, z, 'x', { segments: 12 });
  b.box(m.alloy, 0.05, 0.03, 0.07, x, r * 2 + 0.012, z);
}

/** A stack of drawer fronts with full-width aluminum pulls. */
function drawers(b: MeshBatcher, m: ShopMaterials, body: THREE.Material, w: number, yBottom: number, heights: number[], zFront: number): void {
  let y = yBottom;
  for (const h of heights) {
    b.box(body, w, h - 0.014, 0.022, 0, y + h / 2, zFront);
    b.box(m.alloy, w - 0.04, 0.02, 0.028, 0, y + h - 0.024, zFront + 0.016);
    y += h;
  }
}

/** Tall roller cabinet with a top chest. Stands with its back at local z = -0.28. */
function toolChest(b: MeshBatcher, m: ShopMaterials, w = 1.42): void {
  for (const x of [-w / 2 + 0.1, w / 2 - 0.1]) for (const z of [-0.2, 0.2]) caster(b, m, x, z);
  b.slab(m.red, w, 0.88, 0.56, 0, 0.14, 0);
  drawers(b, m, m.red, w - 0.06, 0.16, [0.2, 0.16, 0.13, 0.13, 0.11, 0.11], 0.285);
  b.slab(m.rubber, w + 0.02, 0.014, 0.58, 0, 1.02, 0);
  b.slab(m.red, w - 0.04, 0.5, 0.46, 0, 1.034, -0.04);
  drawers(b, m, m.red, w - 0.1, 1.05, [0.13, 0.1, 0.1, 0.1], 0.195);
  b.box(m.alloy, w - 0.04, 0.03, 0.47, 0, 1.55, -0.04);
  b.box(m.alloy, 0.32, 0.045, 0.006, 0, 1.5, 0.208);
  for (const side of [-1, 1]) b.beam(m.alloy, [side * (w / 2 + 0.035), 0.62, -0.14], [side * (w / 2 + 0.035), 0.62, 0.14], 0.022);
  shadow(b, m, w + 0.7, 1.2);
}

/** Waist-high service cart with an open tool tray on top. */
function serviceCart(b: MeshBatcher, m: ShopMaterials): void {
  const w = 0.82;
  for (const x of [-0.33, 0.33]) for (const z of [-0.17, 0.17]) caster(b, m, x, z);
  b.slab(m.red, w, 0.62, 0.46, 0, 0.14, 0);
  drawers(b, m, m.red, w - 0.05, 0.16, [0.2, 0.14, 0.12, 0.12], 0.235);
  b.slab(m.red, w, 0.02, 0.46, 0, 0.9, 0);
  for (const z of [-0.22, 0.22]) b.box(m.red, w, 0.07, 0.016, 0, 0.955, z);
  for (const x of [-0.4, 0.4]) b.box(m.red, 0.016, 0.07, 0.46, x, 0.955, 0);
  b.slab(m.rubber, w - 0.04, 0.008, 0.42, 0, 0.92, 0);
  // Loose tools in the tray.
  b.box(m.chrome, 0.26, 0.012, 0.022, -0.16, 0.936, -0.08, [0, 0.4, 0]);
  b.box(m.chrome, 0.22, 0.012, 0.02, -0.1, 0.936, 0.06, [0, -0.25, 0]);
  b.box(m.chrome, 0.3, 0.014, 0.024, 0.14, 0.937, 0.1, [0, 0.12, 0]);
  b.cyl(m.orange, 0.016, 0.11, 0.2, 0.944, -0.1, 'x', { segments: 8 });
  b.cyl(m.chrome, 0.006, 0.13, 0.32, 0.944, -0.1, 'x', { segments: 6 });
  b.cyl(m.blue, 0.033, 0.19, 0.3, 1.024, 0.02, 'y', { segments: 12 });
  b.beam(m.alloy, [-0.43, 0.86, -0.2], [-0.43, 0.86, 0.2], 0.022);
  shadow(b, m, w + 0.55, 1.0);
}

/** Steel bench with a butcher-block top, a vise, and a pegboard of tools on the wall behind it. Back at local z = -0.4. */
function workbench(b: MeshBatcher, m: ShopMaterials, w: number, seed: number): void {
  const rand = seededRandom(seed);
  for (const x of [-w / 2 + 0.05, w / 2 - 0.05]) for (const z of [-0.33, 0.33]) b.slab(m.steel, 0.06, 0.86, 0.06, x, 0, z);
  b.slab(m.steel, w - 0.08, 0.03, 0.66, 0, 0.2, 0);
  b.slab(m.steel, w - 0.08, 0.1, 0.04, 0, 0.74, 0.34);
  b.slab(m.wood, w, 0.07, 0.78, 0, 0.86, 0);
  // Drawer unit hung under the top.
  b.slab(m.grey, 0.62, 0.42, 0.62, -w / 2 + 0.42, 0.42, 0.02);
  b.at(-w / 2 + 0.42, 0, 0, 0, () => drawers(b, m, m.grey, 0.58, 0.44, [0.14, 0.12, 0.12], 0.335));
  // Stuff on the lower shelf.
  b.slab(m.red, 0.5, 0.24, 0.26, w / 2 - 0.5, 0.23, 0.02);
  b.box(m.alloy, 0.2, 0.02, 0.03, w / 2 - 0.5, 0.49, 0.02);
  b.slab(m.cardboard, 0.42, 0.3, 0.36, w / 2 - 1.15, 0.23, -0.04, [0, 0.12, 0]);
  // Bench vise.
  b.at(w / 2 - 0.34, 0.93, 0.24, 0, () => {
    b.slab(m.castIron, 0.16, 0.05, 0.2, 0, 0, 0);
    b.slab(m.blue, 0.1, 0.12, 0.16, 0, 0.05, -0.02);
    b.slab(m.blue, 0.13, 0.09, 0.04, 0, 0.13, -0.08);
    b.slab(m.blue, 0.13, 0.09, 0.04, 0, 0.13, 0.1);
    b.cyl(m.chrome, 0.014, 0.3, 0, 0.12, 0.1, 'z', { segments: 8 });
    b.cyl(m.chrome, 0.008, 0.22, 0, 0.12, 0.25, 'x', { segments: 6 });
  });
  // Spray cans and a parts tray on the top.
  const cans = [m.blue, m.yellow, m.black, m.white, m.green];
  for (let i = 0; i < 5; i++) {
    const x = -w / 2 + 0.95 + i * 0.1;
    b.cyl(cans[i], 0.032, 0.19, x, 1.025, -0.26, 'y', { segments: 12 });
    b.cyl(m.white, 0.02, 0.03, x, 1.135, -0.26, 'y', { segments: 8 });
  }
  b.slab(m.black, 0.36, 0.035, 0.26, -0.1, 0.93, 0.12, [0, 0.2, 0]);

  // Pegboard, with outlines of the tools that hang on it.
  const py = 1.86;
  const pz = -0.385;
  b.panel(m.pegboard, w, 1.3, 0, py, pz);
  b.box(m.steel, w + 0.06, 0.04, 0.03, 0, py + 0.66, pz);
  b.box(m.steel, w + 0.06, 0.04, 0.03, 0, py - 0.66, pz);
  const tz = pz + 0.02;
  // Combination wrenches in descending sizes.
  for (let i = 0; i < 9; i++) {
    const len = 0.34 - i * 0.022;
    const x = -w / 2 + 0.2 + i * 0.085;
    b.box(m.chrome, 0.02, len, 0.008, x, py + 0.42 - len / 2, tz);
    b.cyl(m.chrome, 0.021 - i * 0.001, 0.008, x, py + 0.43, tz, 'z', { segments: 10 });
  }
  // Screwdrivers.
  for (let i = 0; i < 6; i++) {
    const x = -w / 2 + 1.12 + i * 0.07;
    b.cyl(i % 2 ? m.red : m.yellow, 0.017, 0.1, x, py + 0.36, tz + 0.012, 'y', { segments: 8 });
    b.cyl(m.chrome, 0.005, 0.16, x, py + 0.23, tz + 0.012, 'y', { segments: 6 });
  }
  // Hammers, a hacksaw frame and a square.
  for (const [x, tilt] of [
    [w / 2 - 0.72, 0.1],
    [w / 2 - 0.5, -0.08],
  ] as const) {
    b.box(m.wood, 0.03, 0.3, 0.02, x, py + 0.22, tz, [0, 0, tilt]);
    b.box(m.castIron, 0.12, 0.04, 0.035, x - tilt * 0.16, py + 0.39, tz, [0, 0, tilt]);
  }
  b.box(m.orange, 0.42, 0.02, 0.012, w / 2 - 0.36, py - 0.02, tz);
  b.box(m.orange, 0.02, 0.12, 0.012, w / 2 - 0.56, py - 0.08, tz);
  b.box(m.orange, 0.02, 0.12, 0.012, w / 2 - 0.16, py - 0.08, tz);
  b.box(m.chrome, 0.4, 0.008, 0.006, w / 2 - 0.36, py - 0.135, tz);
  b.box(m.alloy, 0.3, 0.035, 0.006, -w / 2 + 0.3, py - 0.2, tz);
  b.box(m.alloy, 0.035, 0.22, 0.006, -w / 2 + 0.17, py - 0.3, tz);
  // Pliers and cutters along the bottom, bins of fasteners beside them.
  for (let i = 0; i < 5; i++) {
    const x = -w / 2 + 0.62 + i * 0.11;
    b.box(i % 2 ? m.blue : m.red, 0.014, 0.12, 0.012, x - 0.012, py - 0.38, tz, [0, 0, 0.1]);
    b.box(i % 2 ? m.blue : m.red, 0.014, 0.12, 0.012, x + 0.012, py - 0.38, tz, [0, 0, -0.1]);
    b.box(m.castIron, 0.022, 0.07, 0.012, x, py - 0.285, tz);
  }
  const bins = [m.red, m.blue, m.yellow, m.green];
  for (let i = 0; i < 6; i++) {
    const x = w / 2 - 0.82 + i * 0.135;
    b.box(bins[Math.floor(rand() * bins.length)], 0.12, 0.09, 0.11, x, py - 0.44, tz + 0.05);
  }
  // Task light under a narrow shelf.
  b.box(m.steel, w, 0.03, 0.22, 0, py + 0.74, pz + 0.11);
  b.box(m.glow.ledBay.material, w - 0.3, 0.02, 0.05, 0, py + 0.715, pz + 0.16);
  for (let i = 0; i < 4; i++) b.slab(m.cardboard, 0.3 + rand() * 0.15, 0.16 + rand() * 0.12, 0.18, -w / 2 + 0.35 + i * 0.6, py + 0.755, pz + 0.11);
  shadow(b, m, w + 0.8, 1.5);
}

/** Row of steel wall cabinets. Back at local z = 0. */
function wallCabinets(b: MeshBatcher, m: ShopMaterials, count: number): void {
  for (let i = 0; i < count; i++) {
    const x = (i - (count - 1) / 2) * 0.78;
    b.box(m.grey, 0.76, 0.72, 0.34, x, 0, 0.17);
    b.box(m.grey, 0.36, 0.68, 0.014, x - 0.185, 0, 0.347);
    b.box(m.grey, 0.36, 0.68, 0.014, x + 0.185, 0, 0.347);
    b.box(m.alloy, 0.014, 0.16, 0.02, x - 0.03, -0.12, 0.362);
    b.box(m.alloy, 0.014, 0.16, 0.02, x + 0.03, -0.12, 0.362);
  }
}

/** Pallet-rack shelving stocked with oil, fluids, cans and boxes. Back at local z = -0.3. */
function fluidShelving(b: MeshBatcher, m: ShopMaterials, seed: number): void {
  const rand = seededRandom(seed);
  const w = 2.1;
  const h = 2.3;
  for (const x of [-w / 2, w / 2]) {
    for (const z of [-0.27, 0.27]) b.slab(m.blue, 0.06, h, 0.05, x, 0, z);
    b.beam(m.blue, [x, 0.15, -0.27], [x, 0.9, 0.27], 0.025);
    b.beam(m.blue, [x, 0.9, 0.27], [x, 1.65, -0.27], 0.025);
  }
  const bodies = [m.black, m.grey, m.blue, m.red, m.white, m.green, m.yellow];
  const levels = [0.14, 0.62, 1.08, 1.52, 1.94];
  levels.forEach((y, level) => {
    for (const z of [-0.27, 0.27]) b.box(m.orange, w, 0.08, 0.04, 0, y, z);
    b.box(m.galvanized, w - 0.04, 0.02, 0.56, 0, y + 0.045, 0);
    let x = -w / 2 + 0.12;
    const top = y + 0.056;
    while (x < w / 2 - 0.16) {
      const kind = (level + Math.floor(rand() * 4)) % 4;
      const body = bodies[Math.floor(rand() * bodies.length)];
      if (kind === 0) {
        // Row of 5 litre oil jugs, two deep.
        const n = 2 + Math.floor(rand() * 3);
        for (let i = 0; i < n && x < w / 2 - 0.14; i++) {
          for (const z of [0.12, -0.12]) {
            b.slab(body, 0.17, 0.27, 0.1, x + 0.085, top, z);
            b.cyl(m.black, 0.022, 0.03, x + 0.04, top + 0.285, z, 'y', { segments: 8 });
          }
          b.panel(m.label, 0.14, 0.12, x + 0.085, top + 0.13, 0.171);
          x += 0.2;
        }
      } else if (kind === 1) {
        // Quart bottles.
        const n = 3 + Math.floor(rand() * 4);
        for (let i = 0; i < n && x < w / 2 - 0.1; i++) {
          for (const z of [0.16, 0.04, -0.08]) {
            b.cyl(body, 0.04, 0.2, x + 0.045, top + 0.1, z, 'y', { segments: 10 });
            b.cyl(m.black, 0.018, 0.04, x + 0.045, top + 0.22, z, 'y', { segments: 8 });
          }
          x += 0.1;
        }
      } else if (kind === 2) {
        // Gallon cans.
        const n = 1 + Math.floor(rand() * 3);
        for (let i = 0; i < n && x < w / 2 - 0.2; i++) {
          b.cyl(m.alloy, 0.09, 0.2, x + 0.1, top + 0.1, 0.08, 'y', { segments: 16 });
          b.cyl(body, 0.092, 0.11, x + 0.1, top + 0.1, 0.08, 'y', { segments: 16, open: true });
          b.cyl(m.alloy, 0.09, 0.2, x + 0.1, top + 0.1, -0.13, 'y', { segments: 16 });
          x += 0.21;
        }
      } else {
        const bw = 0.3 + rand() * 0.2;
        if (x + bw < w / 2 - 0.05) b.slab(m.cardboard, bw, 0.2 + rand() * 0.14, 0.4, x + bw / 2, top, 0, [0, (rand() - 0.5) * 0.12, 0]);
        x += bw + 0.03;
      }
      x += 0.04 + rand() * 0.06;
    }
  });
  shadow(b, m, w + 0.6, 1.3);
}

function tire(b: MeshBatcher, m: ShopMaterials, x: number, y: number, z: number, axis: 'x' | 'y', radius = 0.33, rim = false): void {
  const tube = radius * 0.33;
  const rot: [number, number, number] = axis === 'x' ? [0, HALF_PI, 0] : [HALF_PI, 0, 0];
  const g = new THREE.TorusGeometry(radius - tube, tube, 10, 26);
  g.scale(1, 1, 1.25);
  b.add(m.rubber, g, x, y, z, rot);
  if (rim) {
    b.cyl(m.alloy, radius - tube * 1.55, tube * 1.6, x, y, z, axis, { segments: 20 });
    b.cyl(m.castIron, radius * 0.2, tube * 1.7, x, y, z, axis, { segments: 12 });
  }
}

/** Two-tier tire rack. Its length runs along local X, back at local z = -0.32. */
function tireRack(b: MeshBatcher, m: ShopMaterials): void {
  const w = 3.3;
  for (const x of [-w / 2, 0, w / 2]) for (const z of [-0.28, 0.28]) b.slab(m.steel, 0.05, 2.25, 0.05, x, 0, z);
  for (const y of [0.24, 1.22]) {
    for (const z of [-0.24, 0.24]) b.cyl(m.galvanized, 0.022, w, 0, y, z, 'x', { segments: 8 });
    for (let i = 0; i < 11; i++) {
      const x = -w / 2 + 0.2 + i * 0.29;
      tire(b, m, x, y + 0.35, 0, 'x', 0.335 + ((i * 7) % 3) * 0.008);
    }
  }
  b.box(m.steel, w, 0.04, 0.6, 0, 2.25, 0);
  shadow(b, m, w + 0.6, 1.3);
}

function tireStack(b: MeshBatcher, m: ShopMaterials, count: number, seed: number): void {
  const rand = seededRandom(seed);
  for (let i = 0; i < count; i++) tire(b, m, (rand() - 0.5) * 0.05, 0.13 + i * 0.27, (rand() - 0.5) * 0.05, 'y', 0.34, i === count - 1);
  shadow(b, m, 1.2, 1.2);
}

/** Alloy wheels displayed on wall pegs. The wall is at local z = 0 and the wheels face +Z. */
function wheelWall(b: MeshBatcher, m: ShopMaterials): void {
  const finishes = [m.alloy, m.black, m.chrome, m.grey, m.alloy, m.black];
  for (let i = 0; i < 6; i++) {
    const x = (i % 3) * 0.86 - 0.86;
    const y = 1.5 + Math.floor(i / 3) * 0.86;
    const mat = finishes[i];
    b.cyl(m.steel, 0.02, 0.22, x, y, 0.11, 'z', { segments: 8 });
    b.cyl(mat, 0.3, 0.2, x, y, 0.27, 'z', { segments: 28, open: true });
    b.add(mat, new THREE.TorusGeometry(0.3, 0.018, 8, 28), x, y, 0.37);
    b.cyl(mat, 0.07, 0.05, x, y, 0.34, 'z', { segments: 14 });
    const spokes = i % 2 ? 5 : 7;
    for (let s = 0; s < spokes; s++) {
      const a = (s / spokes) * Math.PI * 2 + i;
      b.box(mat, 0.05, 0.25, 0.03, x + Math.sin(a) * 0.17, y + Math.cos(a) * 0.17, 0.34, [0, 0, -a]);
    }
  }
}

/** Upright air compressor, with a hose reel beside it. */
function compressor(b: MeshBatcher, m: ShopMaterials): void {
  b.cyl(m.red, 0.31, 1.25, 0, 0.82, 0, 'y', { segments: 24 });
  for (const y of [0.2, 1.44]) b.add(m.red, new THREE.SphereGeometry(0.31, 24, 12), 0, y, 0, [0, 0, 0], [1, 0.42, 1]);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    b.slab(m.black, 0.1, 0.1, 0.1, Math.cos(a) * 0.26, 0, Math.sin(a) * 0.26);
  }
  b.slab(m.black, 0.6, 0.03, 0.4, 0, 1.56, 0);
  b.cyl(m.black, 0.12, 0.3, -0.14, 1.72, 0, 'x', { segments: 16 });
  b.slab(m.castIron, 0.2, 0.26, 0.2, 0.17, 1.59, 0);
  for (let i = 0; i < 5; i++) b.box(m.castIron, 0.24, 0.012, 0.24, 0.17, 1.66 + i * 0.035, 0);
  b.box(m.black, 0.5, 0.34, 0.05, 0.02, 1.76, 0.21);
  b.cyl(m.white, 0.045, 0.02, 0.28, 1.1, 0.2, 'z', { segments: 14 });
  b.cyl(m.chrome, 0.05, 0.012, 0.28, 1.1, 0.19, 'z', { segments: 14 });
  b.beam(m.orange, [0.17, 1.6, -0.1], [0.3, 1.1, -0.12], 0.016);
  shadow(b, m, 1.4, 1.4);
}

function hoseReel(b: MeshBatcher, m: ShopMaterials, drop: number): void {
  b.cyl(m.yellow, 0.2, 0.12, 0, 0, 0, 'x', { segments: 20 });
  for (const side of [-1, 1]) b.cyl(m.steel, 0.26, 0.012, side * 0.07, 0, 0, 'x', { segments: 20 });
  b.box(m.steel, 0.2, 0.06, 0.3, 0, 0.26, -0.05);
  b.cyl(m.yellow, 0.012, drop, 0, -drop / 2 - 0.2, 0.2, 'y', { segments: 6 });
  b.cyl(m.chrome, 0.016, 0.1, 0, -drop - 0.25, 0.2, 'y', { segments: 8 });
  b.add(m.rubber, new THREE.SphereGeometry(0.035, 8, 6), 0, -drop - 0.19, 0.2);
}

function jackStand(b: MeshBatcher, m: ShopMaterials): void {
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    b.beam(m.red, [Math.cos(a) * 0.15, 0, Math.sin(a) * 0.15], [Math.cos(a) * 0.045, 0.3, Math.sin(a) * 0.045], 0.03);
  }
  b.slab(m.red, 0.11, 0.03, 0.11, 0, 0.29, 0);
  b.slab(m.castIron, 0.04, 0.18, 0.04, 0, 0.3, 0);
  b.slab(m.castIron, 0.1, 0.03, 0.05, 0, 0.47, 0);
  shadow(b, m, 0.5, 0.5);
}

function floorJack(b: MeshBatcher, m: ShopMaterials): void {
  b.slab(m.blue, 0.26, 0.11, 0.66, 0, 0.04, 0);
  for (const side of [-1, 1]) {
    b.cyl(m.alloy, 0.045, 0.05, side * 0.16, 0.045, 0.3, 'x', { segments: 12 });
    b.cyl(m.alloy, 0.03, 0.04, side * 0.13, 0.03, -0.3, 'x', { segments: 10 });
  }
  b.beam(m.blue, [0, 0.13, 0.05], [0, 0.2, 0.3], 0.07, 0.04);
  b.cyl(m.castIron, 0.06, 0.03, 0, 0.225, 0.31, 'y', { segments: 14 });
  b.beam(m.chrome, [0, 0.13, -0.28], [0, 0.95, -0.72], 0.028);
  b.beam(m.rubber, [0, 0.83, -0.655], [0, 0.97, -0.73], 0.036);
  shadow(b, m, 0.7, 1.1);
}

function creeper(b: MeshBatcher, m: ShopMaterials): void {
  b.slab(m.black, 0.44, 0.04, 0.98, 0, 0.075, 0);
  b.slab(m.red, 0.3, 0.05, 0.2, 0, 0.11, 0.38);
  for (const x of [-0.19, 0.19]) for (const z of [-0.42, 0, 0.42]) b.cyl(m.rubber, 0.035, 0.03, x, 0.035, z, 'x', { segments: 10 });
  shadow(b, m, 0.8, 1.3);
}

function oilDrum(b: MeshBatcher, m: ShopMaterials, body: THREE.Material, pump: boolean): void {
  b.cyl(body, 0.29, 0.88, 0, 0.44, 0, 'y', { segments: 26 });
  for (const y of [0.02, 0.3, 0.58, 0.86]) b.add(body, new THREE.TorusGeometry(0.292, 0.012, 6, 28), 0, y, 0, [HALF_PI, 0, 0]);
  b.cyl(m.castIron, 0.035, 0.02, 0.15, 0.885, 0.08, 'y', { segments: 10 });
  if (pump) {
    b.cyl(m.chrome, 0.02, 0.5, -0.12, 1.1, -0.06, 'y', { segments: 10 });
    b.beam(m.chrome, [-0.12, 1.32, -0.06], [0.16, 1.24, -0.06], 0.018);
    b.beam(m.black, [-0.12, 1.2, -0.06], [-0.3, 1.36, -0.06], 0.02);
  }
  shadow(b, m, 0.95, 0.95);
}

function weldingCart(b: MeshBatcher, m: ShopMaterials): void {
  b.slab(m.black, 0.62, 0.04, 0.44, 0, 0.14, 0);
  for (const side of [-1, 1]) b.cyl(m.rubber, 0.13, 0.05, side * 0.34, 0.13, -0.12, 'x', { segments: 16 });
  b.slab(m.black, 0.05, 1.25, 0.04, -0.28, 0.16, -0.2);
  b.slab(m.black, 0.05, 1.25, 0.04, 0.28, 0.16, -0.2);
  b.beam(m.black, [-0.28, 1.36, -0.2], [0.28, 1.36, -0.2], 0.035);
  for (const [x, mat, h] of [
    [-0.15, m.green, 1.25],
    [0.15, m.red, 1.05],
  ] as const) {
    b.cyl(mat, 0.115, h, x, 0.18 + h / 2, 0.02, 'y', { segments: 18 });
    b.add(mat, new THREE.SphereGeometry(0.115, 18, 10), x, 0.18 + h, 0.02, [0, 0, 0], [1, 0.7, 1]);
    b.cyl(m.alloy, 0.035, 0.12, x, 0.18 + h + 0.12, 0.02, 'y', { segments: 10 });
    b.cyl(m.chrome, 0.04, 0.03, x + 0.06, 0.18 + h + 0.13, 0.02, 'z', { segments: 12 });
  }
  b.box(m.galvanized, 0.56, 0.02, 0.012, 0, 0.9, 0.14);
  b.add(m.red, new THREE.TorusGeometry(0.15, 0.014, 6, 20), 0.3, 0.9, -0.18, [0, HALF_PI, 0]);
  b.add(m.green, new THREE.TorusGeometry(0.16, 0.014, 6, 20), 0.33, 0.9, -0.18, [0, HALF_PI, 0]);
  shadow(b, m, 1.1, 1.0);
}

function flammablesCabinet(b: MeshBatcher, m: ShopMaterials): void {
  b.slab(m.yellow, 1.1, 1.65, 0.46, 0, 0.05, 0);
  b.slab(m.black, 1.06, 0.05, 0.42, 0, 0, 0);
  for (const side of [-1, 1]) {
    b.box(m.yellow, 0.53, 1.58, 0.014, side * 0.27, 0.88, 0.238);
    b.box(m.alloy, 0.02, 0.2, 0.03, side * 0.05, 0.92, 0.255);
  }
  b.box(m.red, 0.86, 0.2, 0.006, 0, 1.4, 0.247);
  b.box(m.white, 0.6, 0.04, 0.008, 0, 1.4, 0.249);
  shadow(b, m, 1.6, 1.1);
}

function engineOnStand(b: MeshBatcher, m: ShopMaterials): void {
  // Stand.
  b.beam(m.blue, [-0.45, 0.08, -0.5], [0.45, 0.08, -0.5], 0.06);
  b.beam(m.blue, [0, 0.08, -0.5], [0, 0.08, 0.5], 0.06);
  b.beam(m.blue, [-0.3, 0.08, 0.5], [0.3, 0.08, 0.5], 0.06);
  b.slab(m.blue, 0.07, 0.86, 0.07, 0, 0.08, -0.45);
  b.cyl(m.blue, 0.05, 0.3, 0, 0.94, -0.36, 'z', { segments: 12 });
  for (const [x, z] of [
    [-0.45, -0.5],
    [0.45, -0.5],
    [-0.3, 0.5],
    [0.3, 0.5],
  ] as const)
    caster(b, m, x, z, 0.04);
  // V8 long block.
  b.at(0, 0.94, 0.12, 0, () => {
    b.box(m.castIron, 0.44, 0.34, 0.66, 0, -0.04, 0);
    b.box(m.castIron, 0.5, 0.1, 0.56, 0, -0.26, 0.02);
    for (const side of [-1, 1]) {
      b.box(m.alloy, 0.22, 0.14, 0.62, side * 0.2, 0.2, 0, [0, 0, -side * 0.78]);
      b.box(m.red, 0.17, 0.07, 0.6, side * 0.275, 0.285, 0, [0, 0, -side * 0.78]);
      for (let i = 0; i < 4; i++) b.beam(m.galvanized, [side * 0.3, 0.1, -0.22 + i * 0.15], [side * 0.36, -0.14, -0.1 + i * 0.07], 0.04);
      b.beam(m.galvanized, [side * 0.36, -0.14, -0.14], [side * 0.36, -0.22, 0.34], 0.06);
    }
    b.box(m.alloy, 0.24, 0.1, 0.5, 0, 0.26, 0);
    b.cyl(m.black, 0.13, 0.07, 0, 0.36, 0, 'y', { segments: 18 });
    b.cyl(m.chrome, 0.15, 0.012, 0, 0.4, 0, 'y', { segments: 18 });
    b.cyl(m.castIron, 0.19, 0.05, 0, -0.06, -0.36, 'z', { segments: 24 });
    for (const [x, y, r] of [
      [0, -0.16, 0.085],
      [-0.2, 0.06, 0.06],
      [0.18, 0.02, 0.05],
    ] as const)
      b.cyl(m.alloy, r, 0.03, x, y, 0.36, 'z', { segments: 16 });
  });
  shadow(b, m, 1.5, 1.6);
}

function pedestalFan(b: MeshBatcher, m: ShopMaterials): void {
  b.cyl(m.black, 0.3, 0.04, 0, 0.02, 0, 'y', { segments: 20 });
  b.cyl(m.chrome, 0.022, 1.3, 0, 0.68, 0, 'y', { segments: 10 });
  b.cyl(m.black, 0.09, 0.2, 0, 1.4, -0.08, 'z', { segments: 14 });
  for (const r of [0.38, 0.27, 0.15]) {
    b.add(m.chrome, new THREE.TorusGeometry(r, 0.006, 5, 30), 0, 1.4, 0.07);
    b.add(m.chrome, new THREE.TorusGeometry(r, 0.006, 5, 30), 0, 1.4, -0.03);
  }
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    b.box(m.grey, 0.12, 0.3, 0.012, Math.sin(a) * 0.19, 1.4 + Math.cos(a) * 0.19, 0.02, [0.3, 0, -a]);
  }
  shadow(b, m, 0.9, 0.9);
}

function stool(b: MeshBatcher, m: ShopMaterials): void {
  b.cyl(m.black, 0.17, 0.07, 0, 0.5, 0, 'y', { segments: 18 });
  b.cyl(m.chrome, 0.02, 0.4, 0, 0.27, 0, 'y', { segments: 8 });
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    b.beam(m.chrome, [0, 0.09, 0], [Math.cos(a) * 0.24, 0.07, Math.sin(a) * 0.24], 0.024);
    b.cyl(m.rubber, 0.03, 0.025, Math.cos(a) * 0.24, 0.03, Math.sin(a) * 0.24, 'x', { segments: 8 });
  }
  shadow(b, m, 0.7, 0.7);
}

function cone(b: MeshBatcher, m: ShopMaterials): void {
  b.slab(m.black, 0.34, 0.03, 0.34, 0, 0, 0);
  b.cyl(m.orange, 0.13, 0.62, 0, 0.34, 0, 'y', { radiusTop: 0.025, segments: 16 });
  b.cyl(m.white, 0.094, 0.1, 0, 0.4, 0, 'y', { radiusTop: 0.077, segments: 16, open: true });
  shadow(b, m, 0.6, 0.6);
}

function worklightTripod(b: MeshBatcher, m: ShopMaterials, height: number, aimYaw: number): void {
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    b.beam(m.black, [0, height * 0.42, 0], [Math.cos(a) * 0.48, 0, Math.sin(a) * 0.48], 0.022);
  }
  b.cyl(m.black, 0.016, height, 0, height / 2, 0, 'y', { segments: 8 });
  b.at(0, height, 0, aimYaw, () => {
    b.box(m.black, 0.62, 0.03, 0.03, 0, 0, 0);
    for (const x of [-0.19, 0.19]) {
      b.box(m.yellow, 0.3, 0.22, 0.07, x, 0.02, 0.04, [-0.25, 0, 0]);
      b.box(m.glow.worklamp.material, 0.26, 0.18, 0.012, x, 0.03, 0.082, [-0.25, 0, 0]);
    }
  });
  shadow(b, m, 0.9, 0.9);
}

function wallDetails(b: MeshBatcher, m: ShopMaterials): void {
  const back = HALL.minZ + 0.02;
  // Clock, notice and first aid on the back wall.
  b.panel(m.clock, 0.62, 0.62, -10.4, 3.75, back + 0.02);
  b.cyl(m.black, 0.33, 0.03, -10.4, 3.75, back, 'z', { segments: 28 });
  b.panel(m.safetySign, 1.2, 0.6, -13.6, 3.2, back + 0.01);
  b.box(m.white, 0.42, 0.42, 0.14, -5.6, 1.7, back + 0.07);
  b.box(m.green, 0.24, 0.07, 0.006, -5.6, 1.7, back + 0.143);
  b.box(m.green, 0.07, 0.24, 0.006, -5.6, 1.7, back + 0.143);
  // Fire extinguishers on red backing boards.
  for (const x of [-6.4, 5.4]) {
    b.box(m.red, 0.3, 0.9, 0.012, x, 1.35, back + 0.006);
    b.cyl(m.red, 0.075, 0.46, x, 1.12, back + 0.1, 'y', { segments: 14 });
    b.cyl(m.black, 0.03, 0.08, x, 1.4, back + 0.1, 'y', { segments: 8 });
    b.beam(m.black, [x + 0.03, 1.4, back + 0.1], [x + 0.1, 1.15, back + 0.12], 0.016);
  }
  // Conduit and outlet boxes along the back and side walls.
  for (const [from, to] of [
    [HALL.minX + 0.4, -5.2],
    [5.2, HALL.maxX - 0.4],
  ] as const) {
    b.cyl(m.galvanized, 0.014, to - from, (from + to) / 2, 3.05, back + 0.02, 'x', { segments: 6 });
    for (let x = from + 1.2; x < to; x += 2.6) {
      b.cyl(m.galvanized, 0.012, 1.78, x, 2.16, back + 0.02, 'y', { segments: 6 });
      b.box(m.grey, 0.12, 0.16, 0.06, x, 1.24, back + 0.03);
    }
  }
  for (const side of [-1, 1]) {
    const x = side * (HALL.maxX - 0.03);
    b.cyl(m.galvanized, 0.014, 20, x, 3.05, 1, 'z', { segments: 6 });
    for (let z = -8; z <= 10; z += 3.6) {
      b.cyl(m.galvanized, 0.012, 1.78, x, 2.16, z, 'y', { segments: 6 });
      b.box(m.grey, 0.06, 0.16, 0.12, x - side * 0.01, 1.24, z);
    }
  }
}

function ceilingGear(b: MeshBatcher, m: ShopMaterials): void {
  // Linear LED high-bay fixtures in four rows, hung from the purlins on rods.
  for (const z of [-7.2, -1.2, 3.2, 9.2]) {
    for (const x of [-13.575, -8.145, -2.715, 2.715, 8.145, 13.575]) {
      const y = 6.5;
      b.box(m.white, 2.7, 0.07, 0.36, x, y, z);
      b.add(m.glow.ledBay.material, new THREE.PlaneGeometry(2.58, 0.27), x, y - 0.037, z, [HALF_PI, 0, 0]);
      for (const ox of [-1.1, 1.1]) b.cyl(m.galvanized, 0.008, roofY(z) - y - 0.1, x + ox, (roofY(z) + y) / 2, z, 'y', { segments: 5 });
    }
  }

  // Hexagonal LED grid over the hero bay.
  const hex = m.glow.hexGrid.material;
  const R = 0.82;
  const y = 5.25;
  const seen = new Set<string>();
  for (let row = -2; row <= 2; row++) {
    for (let col = -2; col <= 2; col++) {
      const cx = col * R * 1.5;
      const cz = (row + (Math.abs(col) % 2) * 0.5) * R * Math.sqrt(3);
      if (Math.abs(cz) > 3.4) continue;
      for (let e = 0; e < 6; e++) {
        const a0 = (e / 6) * Math.PI * 2;
        const a1 = ((e + 1) / 6) * Math.PI * 2;
        const x0 = cx + Math.cos(a0) * R;
        const z0 = cz + Math.sin(a0) * R;
        const x1 = cx + Math.cos(a1) * R;
        const z1 = cz + Math.sin(a1) * R;
        const key = `${Math.round((x0 + x1) * 50)}:${Math.round((z0 + z1) * 50)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        b.beam(hex, [x0, y, z0], [x1, y, z1], 0.045, 0.035);
      }
    }
  }
  for (const [x, z] of [
    [-2.4, -2.8],
    [2.4, -2.8],
    [-2.4, 2.8],
    [2.4, 2.8],
    [0, 0],
  ] as const)
    b.cyl(m.galvanized, 0.006, roofY(z) - y - 0.2, x, (roofY(z) + y) / 2 - 0.1, z, 'y', { segments: 5 });

  // Spiral supply duct under the ridge, with diffuser drops.
  b.cyl(m.galvanized, 0.34, 34, 0, 6.55, 1.05, 'x', { segments: 22 });
  for (let x = -16; x <= 16; x += 2) b.add(m.galvanized, new THREE.TorusGeometry(0.345, 0.012, 5, 22), x, 6.55, 1.05, [0, HALF_PI, 0]);
  for (const x of [-13.5, -6.5, 6.5, 13.5]) {
    b.cyl(m.galvanized, 0.2, 0.3, x, 6.12, 1.05, 'y', { segments: 16 });
    b.cyl(m.white, 0.3, 0.05, x, 5.95, 1.05, 'y', { segments: 16 });
  }
  for (const x of [-15, -9, -3, 3, 9, 15]) b.cyl(m.galvanized, 0.006, roofY(1.05) - 6.9, x, (roofY(1.05) + 6.9) / 2, 1.05, 'y', { segments: 5 });

  // Retractable air-hose reels beside each lift.
  for (const bx of [BAY_X[1], BAY_X[2]]) b.at(bx + 3.1, 6.3, -1.6, 0, () => hoseReel(b, m, 3.6));
}

/** Everything a working shop collects: storage, benches, tires, fluids, compressor and loose equipment. */
export function buildProps(b: MeshBatcher, m: ShopMaterials): void {
  const back = HALL.minZ;

  // Back wall, left of the photo bay.
  b.at(-16.4, 0, back + 0.42, 0, () => workbench(b, m, 2.7, 4));
  b.at(-13.6, 0, back + 0.36, 0, () => toolChest(b, m));
  b.at(-13.6, 2.35, back + 0.02, 0, () => wallCabinets(b, m, 2));
  b.at(-10.4, 0, back + 0.42, 0, () => workbench(b, m, 2.9, 9));
  b.at(-7.7, 0, back + 0.36, 0, () => toolChest(b, m, 1.2));

  // Back wall, right of the photo bay.
  b.at(7.0, 0, back + 0.36, 0, () => fluidShelving(b, m, 17));
  b.at(9.3, 0, back + 0.36, 0, () => fluidShelving(b, m, 31));
  b.at(11.5, 0, back + 0.3, 0, () => flammablesCabinet(b, m));
  b.at(13.5, 0, back + 0.36, 0, () => toolChest(b, m));
  b.at(15.3, 2.35, back + 0.02, 0, () => wallCabinets(b, m, 2));
  b.at(17.6, 0, back + 1.0, -0.5, () => compressor(b, m));
  b.at(15.9, 2.0, back + 0.18, 0, () => hoseReel(b, m, 0.9));

  // Left wall: tires, wheels and oil.
  b.at(HALL.minX + 0.42, 0, -3.4, HALF_PI, () => tireRack(b, m));
  b.at(HALL.minX + 0.03, 0, 3.6, HALF_PI, () => wheelWall(b, m));
  b.at(HALL.minX + 0.75, 0, 0.3, 0, () => tireStack(b, m, 4, 3));
  b.at(HALL.minX + 0.85, 0, 1.2, 0, () => tireStack(b, m, 3, 8));
  b.at(HALL.minX + 0.7, 0, 6.6, 0, () => tireStack(b, m, 5, 12));
  b.at(HALL.minX + 0.6, 0, 8.3, 0, () => oilDrum(b, m, m.blue, true));
  b.at(HALL.minX + 0.62, 0, 9.05, 0, () => oilDrum(b, m, m.blue, false));
  b.at(HALL.minX + 1.3, 0, 8.7, 0, () => oilDrum(b, m, m.black, false));

  // Right wall: engine, welding, bench and a fan.
  b.at(HALL.maxX - 1.5, 0, -5.4, -HALF_PI - 0.3, () => engineOnStand(b, m));
  b.at(HALL.maxX - 0.55, 0, -2.3, -HALF_PI, () => weldingCart(b, m));
  b.at(HALL.maxX - 0.42, 0, 5.2, -HALF_PI, () => workbench(b, m, 2.7, 21));
  b.at(HALL.maxX - 1.2, 0, 1.6, -HALF_PI - 0.5, () => pedestalFan(b, m));
  b.at(HALL.maxX - 0.7, 0, 8.6, 0, () => oilDrum(b, m, m.red, false));

  // Bay 1: set up for a brake job.
  const b1 = BAY_X[0];
  for (const [x, z] of [
    [-0.72, 1.25],
    [0.72, 1.25],
    [-0.72, -1.25],
    [0.72, -1.25],
  ] as const)
    b.at(b1 + x, 0, z, 0, () => jackStand(b, m));
  b.at(b1 + 0.3, 0, 3.3, 0.35, () => floorJack(b, m));
  b.at(b1 + 1.9, 0, -2.2, 0.5, () => creeper(b, m));
  b.cyl(m.black, 0.26, 0.12, b1 - 0.2, 0.06, 0.1, 'y', { segments: 20 });
  b.at(b1 + 3.0, 0, -0.6, -0.3, () => serviceCart(b, m));
  b.at(b1 - 2.2, 0, 1.9, 0, () => tireStack(b, m, 2, 5));

  // Hero bay: cart, stool, worklights and cones at the door.
  b.at(-3.5, 0, -2.9, 0.55, () => serviceCart(b, m));
  b.at(3.3, 0, -3.3, 0, () => stool(b, m));
  for (const w of WORKLIGHTS) b.at(w.x, 0, w.z, Math.atan2(-w.x, -w.z), () => worklightTripod(b, m, w.height, 0));
  for (const x of [-3.4, 3.4]) b.at(x, 0, HALL.maxZ - 1.3, 0, () => cone(b, m));
  b.cyl(m.grey, 0.25, 0.7, -5.9, 0.35, back + 1.2, 'y', { segments: 18, open: true });

  // Bay 3: second lift is built separately; this is its cart.
  b.at(BAY_X[2] + 3.2, 0, 1.9, -0.4, () => serviceCart(b, m));

  wallDetails(b, m);
  ceilingGear(b, m);
}
