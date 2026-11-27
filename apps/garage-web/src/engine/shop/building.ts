import * as THREE from 'three';
import type { MeshBatcher } from '../MeshBatcher';
import { BAY_X, BOOTH, DOOR, HALL, TRUSS_X, roofY } from './layout';
import type { ShopMaterials } from './materials';

const WAINSCOT = 1.4;
const HALL_W = HALL.maxX - HALL.minX;
const HALL_D = HALL.maxZ - HALL.minZ;
const HALL_CZ = (HALL.minZ + HALL.maxZ) / 2;
const BOOTH_W = BOOTH.maxX - BOOTH.minX;
const BOOTH_D = BOOTH.maxZ - BOOTH.minZ;
const BOOTH_CZ = (BOOTH.minZ + BOOTH.maxZ) / 2;
const SLOPE = Math.atan((HALL.ridge - HALL.eave) / (HALL.ridgeZ - HALL.minZ));

/** Wall in the XY plane at `z`, facing +Z (`facing` 1) or -Z (-1): painted block below, ribbed cladding above. */
function wallAlongX(b: MeshBatcher, m: ShopMaterials, x0: number, x1: number, z: number, facing: 1 | -1, y0: number, y1: number): void {
  const yaw = facing === 1 ? 0 : Math.PI;
  const w = x1 - x0;
  const cx = (x0 + x1) / 2;
  if (y0 < WAINSCOT) {
    const top = Math.min(y1, WAINSCOT);
    b.panel(m.wallBlock, w, top - y0, cx, (y0 + top) / 2, z, yaw);
  }
  if (y1 > WAINSCOT) {
    const bottom = Math.max(y0, WAINSCOT);
    b.panel(m.wallMetal, w, y1 - bottom, cx, (bottom + y1) / 2, z, yaw);
  }
  if (y0 < WAINSCOT && y1 > WAINSCOT) b.box(m.steel, w, 0.07, 0.05, cx, WAINSCOT, z + facing * 0.025);
}

/** Wall in the ZY plane at `x`, facing +X (`facing` 1) or -X (-1). */
function wallAlongZ(b: MeshBatcher, m: ShopMaterials, x: number, facing: 1 | -1, z0: number, z1: number, y0: number, y1: number): void {
  const yaw = (facing * Math.PI) / 2;
  const w = z1 - z0;
  const cz = (z0 + z1) / 2;
  b.panel(m.wallBlock, w, WAINSCOT - y0, x, (y0 + WAINSCOT) / 2, cz, yaw);
  b.panel(m.wallMetal, w, y1 - WAINSCOT, x, (WAINSCOT + y1) / 2, cz, yaw);
  b.box(m.steel, 0.05, 0.07, w, x + facing * 0.025, WAINSCOT, cz);
}

/** A flat triangle whose lit side faces `toward`. */
function triangle(b: MeshBatcher, material: THREE.Material, p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, toward: THREE.Vector3): void {
  const n = new THREE.Vector3().subVectors(p1, p0).cross(new THREE.Vector3().subVectors(p2, p0)).normalize();
  const pts = n.dot(toward) >= 0 ? [p0, p1, p2] : [p0, p2, p1];
  if (n.dot(toward) < 0) n.negate();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flatMap((p) => [p.x, p.y, p.z]), 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2));
  b.add(material, g);
}

function floorsAndMarkings(b: MeshBatcher, m: ShopMaterials): void {
  b.decal(m.floor, HALL_W, HALL_D, 0, 0, HALL_CZ);
  b.decal(m.boothFloor, BOOTH_W, BOOTH_D, 0, 0, BOOTH_CZ);
  b.decal(m.apron, 90, 40, 0, -0.012, HALL.maxZ + 20);

  // Saw-cut control joints.
  for (let x = HALL.minX + 6.33; x < HALL.maxX - 1; x += 6.33) b.decal(m.seam, 0.018, HALL_D, x, 0.002, HALL_CZ);
  for (let z = HALL.minZ + 5.5; z < HALL.maxZ - 1; z += 5.5) b.decal(m.seam, HALL_W, 0.018, 0, 0.002, z);

  // Bay dividers, stop lines and door thresholds.
  for (const x of [-15.75, -5.25, 5.25, 15.75]) b.decal(m.linePaint, 0.1, 17.2, x, 0.004, 2.1);
  for (const bx of BAY_X) {
    b.decal(m.linePaint, 4.4, 0.1, bx, 0.004, -6.5);
    b.decal(m.hazard, DOOR.width, 0.32, bx, 0.004, HALL.maxZ - 0.3);
  }
  BAY_X.forEach((bx, i) => b.decal(m.bayNumbers[i], 1.25, 1.25, bx + 3.55, 0.005, 9.9));
  // Pedestrian aisle along the back of the hall.
  b.decal(m.whitePaint, 14, 0.09, -11.7, 0.004, -7.7);
  b.decal(m.whitePaint, 14, 0.09, 11.7, 0.004, -7.7);

  // Trench drain across the bays just inside the doors, plus two floor drains between the bays.
  b.decal(m.grate, HALL_W - 4, 0.3, 0, 0.004, 8.9);
  for (const z of [8.72, 9.08]) b.decal(m.seam, HALL_W - 4, 0.03, 0, 0.005, z);
  for (const x of [-5.25, 5.25]) b.decal(m.grate, 0.5, 0.5, x, 0.005, -3.2);

  // Threshold strip where the photo bay floor meets the shop floor.
  b.decal(m.tread, BOOTH.mouthHalfWidth * 2, 0.24, 0, 0.004, HALL.minZ);

  // Apron parking stripes.
  for (let x = -12; x <= 12; x += 3) b.decal(m.whitePaint, 0.12, 5, x, 0.001, HALL.maxZ + 13);
}

function walls(b: MeshBatcher, m: ShopMaterials): void {
  const mouth = BOOTH.mouthHalfWidth;
  // Back wall, around the photo bay opening.
  wallAlongX(b, m, HALL.minX, -mouth, HALL.minZ, 1, 0, HALL.eave);
  wallAlongX(b, m, mouth, HALL.maxX, HALL.minZ, 1, 0, HALL.eave);
  wallAlongX(b, m, -mouth, mouth, HALL.minZ, 1, BOOTH.mouthHeight, HALL.eave);

  // Front wall, around the three door openings.
  const half = DOOR.width / 2;
  const edges = [HALL.minX, ...BAY_X.flatMap((x) => [x - half, x + half]), HALL.maxX];
  for (let i = 0; i < edges.length - 1; i += 2) wallAlongX(b, m, edges[i], edges[i + 1], HALL.maxZ, -1, 0, HALL.eave);
  for (const bx of BAY_X) wallAlongX(b, m, bx - half, bx + half, HALL.maxZ, -1, DOOR.height, HALL.eave);

  // Gable end walls.
  for (const side of [-1, 1] as const) {
    const x = side * HALL.maxX;
    wallAlongZ(b, m, x, side === -1 ? 1 : -1, HALL.minZ, HALL.maxZ, 0, HALL.eave);
    triangle(
      b,
      m.wallMetal,
      new THREE.Vector3(x, HALL.eave, HALL.minZ),
      new THREE.Vector3(x, HALL.eave, HALL.maxZ),
      new THREE.Vector3(x, HALL.ridge, HALL.ridgeZ),
      new THREE.Vector3(-side, 0, 0),
    );
  }

  // Shop front seen from the apron, with a parapet that hides the roof.
  const parapet = 9.6;
  for (let i = 0; i < edges.length - 1; i += 2) b.panel(m.facade, edges[i + 1] - edges[i], parapet, (edges[i] + edges[i + 1]) / 2, parapet / 2, HALL.maxZ + 0.12);
  for (const bx of BAY_X) b.panel(m.facade, DOOR.width, parapet - DOOR.height, bx, (parapet + DOOR.height) / 2, HALL.maxZ + 0.12);
  b.panel(m.headerSign, 8, 1, 0, 6.1, HALL.maxZ + 0.15);
}

function clerestory(b: MeshBatcher, m: ShopMaterials): void {
  const pane = m.glow.clerestory.material;
  /** A band of windows along a wall. `axis` is the direction the band runs. */
  const band = (axis: 'x' | 'z', fixed: number, facing: 1 | -1, from: number, to: number, y: number, h: number) => {
    const count = Math.max(1, Math.round((to - from) / 2.7));
    const step = (to - from) / count;
    const w = step - 0.34;
    for (let i = 0; i < count; i++) {
      const c = from + step * (i + 0.5);
      if (axis === 'x') {
        const z = fixed + facing * 0.03;
        b.panel(pane, w, h, c, y, z, facing === 1 ? 0 : Math.PI);
        b.box(m.steel, w + 0.12, 0.07, 0.07, c, y + h / 2, z);
        b.box(m.steel, w + 0.12, 0.07, 0.07, c, y - h / 2, z);
        b.box(m.steel, 0.07, h, 0.07, c - w / 2, y, z);
        b.box(m.steel, 0.07, h, 0.07, c + w / 2, y, z);
        b.box(m.steel, 0.04, h, 0.05, c, y, z);
      } else {
        const x = fixed + facing * 0.03;
        b.panel(pane, w, h, x, y, c, (facing * Math.PI) / 2);
        b.box(m.steel, 0.07, 0.07, w + 0.12, x, y + h / 2, c);
        b.box(m.steel, 0.07, 0.07, w + 0.12, x, y - h / 2, c);
        b.box(m.steel, 0.07, h, 0.07, x, y, c - w / 2);
        b.box(m.steel, 0.07, h, 0.07, x, y, c + w / 2);
        b.box(m.steel, 0.05, h, 0.04, x, y, c);
      }
    }
  };
  band('z', HALL.minX, 1, HALL.minZ + 1.2, HALL.maxZ - 1.2, 5.3, 1.6);
  band('z', HALL.maxX, -1, HALL.minZ + 1.2, HALL.maxZ - 1.2, 5.3, 1.6);
  band('x', HALL.maxZ, -1, HALL.minX + 1, HALL.maxX - 1, 6.0, 1.2);
  band('x', HALL.minZ, 1, HALL.minX + 1, -BOOTH.mouthHalfWidth - 1.2, 5.5, 1.5);
  band('x', HALL.minZ, 1, BOOTH.mouthHalfWidth + 1.2, HALL.maxX - 1, 5.5, 1.5);
}

function roof(b: MeshBatcher, m: ShopMaterials): void {
  const slopeLength = Math.hypot(HALL.ridgeZ - HALL.minZ, HALL.ridge - HALL.eave);
  const midY = (HALL.eave + HALL.ridge) / 2;
  const backZ = (HALL.minZ + HALL.ridgeZ) / 2;
  const frontZ = (HALL.ridgeZ + HALL.maxZ) / 2;
  // Two insulated slopes, lit side facing down into the hall.
  b.add(m.ceiling, new THREE.PlaneGeometry(HALL_W, slopeLength), 0, midY, backZ, [Math.PI / 2 - SLOPE, 0, 0]);
  b.add(m.ceiling, new THREE.PlaneGeometry(HALL_W, slopeLength), 0, midY, frontZ, [Math.PI / 2 + SLOPE, 0, 0]);

  // Purlins run the length of the hall under the insulation.
  for (let z = HALL.minZ + 1; z <= HALL.maxZ - 0.9; z += 2) {
    const tilt = z < HALL.ridgeZ ? -SLOPE : z > HALL.ridgeZ ? SLOPE : 0;
    b.box(m.steel, HALL_W, 0.16, 0.09, 0, roofY(z) - 0.1, z, [tilt, 0, 0]);
  }

  // Skylights over each bay, one on either slope.
  const sky = m.glow.skylight.material;
  for (const x of [-8.145, -2.715, 2.715, 8.145]) {
    for (const [z, rot] of [
      [-4.2, Math.PI / 2 - SLOPE],
      [6.0, Math.PI / 2 + SLOPE],
    ] as const) {
      const y = roofY(z) - 0.035;
      b.add(sky, new THREE.PlaneGeometry(3.7, 3.9), x, y, z, [rot, 0, 0]);
      const frame = (w: number, d: number, ox: number, oz: number) => {
        const zz = z + oz;
        b.box(m.steel, w, 0.1, d, x + ox, roofY(zz) - 0.07, zz, [z < HALL.ridgeZ ? -SLOPE : SLOPE, 0, 0]);
      };
      frame(3.9, 0.1, 0, -1.95);
      frame(3.9, 0.1, 0, 1.95);
      frame(0.1, 3.9, -1.85, 0);
      frame(0.1, 3.9, 1.85, 0);
      frame(0.06, 3.9, 0, 0);
    }
  }
}

function structure(b: MeshBatcher, m: ShopMaterials): void {
  const chordY = HALL.eave - 0.12;
  const topDrop = 0.28;
  for (const x of TRUSS_X) {
    // Bottom chord, two top chords, and a Pratt web between them.
    b.box(m.steel, 0.14, 0.2, HALL_D - 0.3, x, chordY, HALL_CZ);
    b.beam(m.steel, [x, HALL.eave - 0.05, HALL.minZ + 0.15], [x, HALL.ridge - topDrop, HALL.ridgeZ], 0.12, 0.16);
    b.beam(m.steel, [x, HALL.ridge - topDrop, HALL.ridgeZ], [x, HALL.eave - 0.05, HALL.maxZ - 0.15], 0.12, 0.16);
    const panel = 2.2;
    for (let z = HALL.minZ + panel; z < HALL.maxZ - 0.5; z += panel) {
      const top = roofY(z) - topDrop - 0.04;
      b.beam(m.steel, [x, chordY, z], [x, top, z], 0.07, 0.09);
      const next = z < HALL.ridgeZ ? z - panel : z + panel;
      if (next > HALL.minZ && next < HALL.maxZ) b.beam(m.steel, [x, top, z], [x, chordY, next], 0.06, 0.08);
    }
    // Gusset plates at the ridge and the heels.
    b.box(m.steel, 0.16, 0.5, 0.6, x, HALL.ridge - topDrop - 0.2, HALL.ridgeZ);
  }

  // Eave girders carry the trusses to the columns, which stand clear of every opening.
  for (const z of [HALL.minZ + 0.16, HALL.maxZ - 0.16]) b.box(m.steel, HALL_W, 0.4, 0.24, 0, HALL.eave - 0.36, z);
  const column = (x: number, z: number, guard: boolean) => {
    b.slab(m.steel, 0.26, HALL.eave - 0.5, 0.26, x, 0, z);
    b.slab(m.steel, 0.46, 0.03, 0.46, x, 0, z);
    if (guard) b.slab(m.hazard, 0.32, 1.1, 0.32, x, 0.03, z);
  };
  for (const x of [-18.8, -15.75, -5.25, 5.25, 15.75, 18.8]) column(x, HALL.maxZ - 0.18, Math.abs(x) < 16);
  for (const x of [-18.8, -11.6, -(BOOTH.mouthHalfWidth + 0.2), BOOTH.mouthHalfWidth + 0.2, 11.6, 18.8]) column(x, HALL.minZ + 0.18, false);

  // Sway bracing in the roof plane between the outer trusses.
  for (const [xa, xb] of [
    [TRUSS_X[0], TRUSS_X[1]],
    [TRUSS_X[5], TRUSS_X[6]],
  ]) {
    b.beam(m.galvanized, [xa, chordY, HALL.minZ + 0.4], [xb, chordY, HALL.minZ + 5.9], 0.035);
    b.beam(m.galvanized, [xb, chordY, HALL.minZ + 0.4], [xa, chordY, HALL.minZ + 5.9], 0.035);
    b.beam(m.galvanized, [xa, chordY, HALL.maxZ - 0.4], [xb, chordY, HALL.maxZ - 5.9], 0.035);
    b.beam(m.galvanized, [xb, chordY, HALL.maxZ - 0.4], [xa, chordY, HALL.maxZ - 5.9], 0.035);
  }

  // Header over the photo bay opening, with the shop sign above it.
  b.box(m.steel, BOOTH.mouthHalfWidth * 2 + 0.6, 0.42, 0.3, 0, BOOTH.mouthHeight + 0.21, HALL.minZ + 0.14);
  for (const side of [-1, 1]) b.slab(m.hazard, 0.16, 1.2, 0.12, side * (BOOTH.mouthHalfWidth + 0.02), 0, HALL.minZ + 0.07);
  b.panel(m.headerSign, 8.4, 1.05, 0, BOOTH.mouthHeight + 1.2, HALL.minZ + 0.06);
  b.box(m.steel, 8.6, 1.2, 0.04, 0, BOOTH.mouthHeight + 1.2, HALL.minZ + 0.03);
}

function rollUpDoor(b: MeshBatcher, m: ShopMaterials, bx: number, open: boolean): void {
  const z = HALL.maxZ - 0.07;
  const w = DOOR.width;
  const sections = 5;
  const sh = DOOR.height / sections;

  // Frame, vertical tracks, overhead tracks and their hangers.
  for (const side of [-1, 1]) {
    const x = bx + side * (w / 2 + 0.07);
    b.slab(m.steel, 0.14, DOOR.height, 0.3, x, 0, HALL.maxZ - 0.02);
    b.slab(m.galvanized, 0.06, DOOR.height + 0.25, 0.08, x - side * 0.1, 0, z - 0.1);
    b.box(m.galvanized, 0.06, 0.07, 4.4, x - side * 0.1, DOOR.height + 0.28, z - 2.35);
    b.beam(m.galvanized, [x - side * 0.1, DOOR.height + 0.3, z - 4.4], [x - side * 0.1, roofY(z - 4.4) - 0.3, z - 4.4], 0.035);
    b.beam(m.galvanized, [x - side * 0.1, DOOR.height + 0.3, z - 2.2], [x - side * 0.1, roofY(z - 2.2) - 0.3, z - 2.2], 0.035);
  }
  b.box(m.steel, w + 0.42, 0.22, 0.3, bx, DOOR.height + 0.11, HALL.maxZ - 0.02);
  // Torsion spring shaft and opener.
  b.cyl(m.galvanized, 0.03, w + 0.3, bx, DOOR.height + 0.48, z - 0.14, 'x', { segments: 10 });
  b.cyl(m.castIron, 0.075, 1.5, bx, DOOR.height + 0.48, z - 0.14, 'x', { segments: 14 });
  for (const side of [-1, 1]) b.cyl(m.alloy, 0.11, 0.07, bx + side * (w / 2 + 0.02), DOOR.height + 0.48, z - 0.14, 'x', { segments: 16 });
  b.box(m.galvanized, 0.07, 0.07, 4.2, bx, DOOR.height + 0.62, z - 2.3);
  b.box(m.grey, 0.36, 0.26, 0.56, bx, DOOR.height + 0.6, z - 4.5);

  const section = (y: number, cz: number, flat: boolean, glazed: boolean) => {
    const rot: [number, number, number] = flat ? [Math.PI / 2, 0, 0] : [0, 0, 0];
    if (!glazed) {
      b.box(m.doorPanel, w - 0.04, sh - 0.02, 0.045, bx, y, cz, rot);
      for (const o of [-sh / 6, sh / 6]) {
        if (flat) b.box(m.steel, w - 0.04, 0.012, 0.014, bx, y - 0.03, cz + o);
        else b.box(m.steel, w - 0.04, 0.014, 0.012, bx, y + o, cz - 0.03);
      }
      return;
    }
    // Glazed section: four panes in an aluminum frame.
    const panes = 4;
    const pw = (w - 0.04) / panes;
    for (let i = 0; i < panes; i++) {
      const x = bx - (w - 0.04) / 2 + pw * (i + 0.5);
      b.add(m.glow.doorGlass.material, new THREE.PlaneGeometry(pw - 0.14, sh - 0.2), x, y, cz, flat ? [Math.PI / 2, 0, 0] : [0, Math.PI, 0]);
      for (const sx of [-1, 1]) b.box(m.alloy, 0.07, sh - 0.02, 0.05, x + (sx * (pw - 0.07)) / 2, y, cz, rot);
    }
    for (const sy of [-1, 1]) {
      if (flat) b.box(m.alloy, w - 0.04, 0.05, 0.09, bx, y, cz + (sy * (sh - 0.09)) / 2);
      else b.box(m.alloy, w - 0.04, 0.09, 0.05, bx, y + (sy * (sh - 0.09)) / 2, cz);
    }
  };

  if (open) {
    // Rolled up: the top of the curtain still hangs in the opening, the rest lies along the tracks.
    section(DOOR.height - sh * 0.3, z - 0.02, false, false);
    for (let i = 1; i < sections; i++) section(DOOR.height + 0.3, z - 0.45 - sh * (i - 0.5), true, i === 2);
  } else {
    for (let i = 0; i < sections; i++) section(sh * (i + 0.5), z, false, i === 3);
    b.box(m.rubber, w - 0.04, 0.05, 0.07, bx, 0.025, z);
    b.box(m.black, 0.3, 0.08, 0.06, bx, sh * 1.5, z - 0.05);
  }
}

/**
 * The photo bay's backdrop: one continuous wall that sweeps round the back of the room on wide
 * corners and curves into the floor, so there is no edge anywhere behind the car.
 */
function cycloramaGeometry(): THREE.BufferGeometry {
  const corner = 4.2;
  const cove = 1.3;
  // Plan-view path along the foot of the wall, with the direction that points into the room.
  const path: { x: number; z: number; mx: number; mz: number }[] = [];
  const straight = (x0: number, z0: number, x1: number, z1: number, mx: number, mz: number) => {
    path.push({ x: x0, z: z0, mx, mz }, { x: x1, z: z1, mx, mz });
  };
  const arc = (cx: number, cz: number, from: number, to: number) => {
    for (let i = 1; i < 18; i++) {
      const a = from + ((to - from) * i) / 18;
      path.push({ x: cx + Math.cos(a) * corner, z: cz + Math.sin(a) * corner, mx: -Math.cos(a), mz: -Math.sin(a) });
    }
  };
  straight(BOOTH.minX, BOOTH.maxZ, BOOTH.minX, BOOTH.minZ + corner, 1, 0);
  arc(BOOTH.minX + corner, BOOTH.minZ + corner, Math.PI, Math.PI * 1.5);
  straight(BOOTH.minX + corner, BOOTH.minZ, BOOTH.maxX - corner, BOOTH.minZ, 0, 1);
  arc(BOOTH.maxX - corner, BOOTH.minZ + corner, Math.PI * 1.5, Math.PI * 2);
  straight(BOOTH.maxX, BOOTH.minZ + corner, BOOTH.maxX, BOOTH.maxZ, -1, 0);

  // Cross-section: `u` is the distance in from the wall, `nu`/`ny` the surface normal.
  const section: { u: number; y: number; nu: number; ny: number }[] = [];
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * (Math.PI / 2);
    section.push({ u: cove - cove * Math.sin(a), y: cove - cove * Math.cos(a), nu: Math.sin(a), ny: Math.cos(a) });
  }
  section.push({ u: 0, y: BOOTH.height, nu: 1, ny: 0 });

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const p of path) {
    for (const c of section) {
      positions.push(p.x + p.mx * c.u, c.y, p.z + p.mz * c.u);
      normals.push(p.mx * c.nu, c.ny, p.mz * c.nu);
    }
  }
  const rows = section.length;
  for (let i = 0; i < path.length - 1; i++) {
    for (let j = 0; j < rows - 1; j++) {
      const a = i * rows + j;
      const c = a + rows;
      indices.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setIndex(indices);
  return g;
}

function photoBay(b: MeshBatcher, m: ShopMaterials): void {
  const wall = m.boothWall;
  const mouth = BOOTH.mouthHalfWidth;
  b.add(wall, cycloramaGeometry());
  // Ceiling, and the wall that faces back toward the hall.
  b.add(wall, new THREE.PlaneGeometry(BOOTH_W, BOOTH_D), 0, BOOTH.height, BOOTH_CZ, [Math.PI / 2, 0, 0]);
  const inner = BOOTH.maxZ - 0.04;
  b.panel(wall, BOOTH.maxX - mouth, BOOTH.height, (BOOTH.minX - mouth) / 2, BOOTH.height / 2, inner, Math.PI);
  b.panel(wall, BOOTH.maxX - mouth, BOOTH.height, (BOOTH.maxX + mouth) / 2, BOOTH.height / 2, inner, Math.PI);
  b.panel(wall, mouth * 2, BOOTH.height - BOOTH.mouthHeight, 0, (BOOTH.height + BOOTH.mouthHeight) / 2, inner, Math.PI);

  // Overhead softboxes in a 3 x 3 grid. Nothing is hung on the walls, so the backdrop stays clean.
  const soft = m.glow.softbox.material;
  for (const x of [-5.5, 0, 5.5]) {
    for (const z of [-24.4, -19.25, -14.1]) {
      b.add(soft, new THREE.PlaneGeometry(4.7, 4.5), x, BOOTH.height - 0.06, z, [Math.PI / 2, 0, 0]);
      b.box(m.black, 4.84, 0.1, 0.07, x, BOOTH.height - 0.05, z - 2.285);
      b.box(m.black, 4.84, 0.1, 0.07, x, BOOTH.height - 0.05, z + 2.285);
      b.box(m.black, 0.07, 0.1, 4.5, x - 2.385, BOOTH.height - 0.05, z);
      b.box(m.black, 0.07, 0.1, 4.5, x + 2.385, BOOTH.height - 0.05, z);
    }
  }

  // Fixed ring around the turntable.
  b.add(m.galvanized, new THREE.RingGeometry(BOOTH.turntableRadius, BOOTH.turntableRadius + 0.14, 96), 0, 0.006, BOOTH.turntableZ, [-Math.PI / 2, 0, 0]);
}

function outside(b: MeshBatcher, m: ShopMaterials): void {
  // A hedge and two lamp posts close off the far side of the apron.
  for (let x = -40; x <= 40; x += 4) b.slab(m.hedge, 4.2, 2.2 + ((x * 7) % 5) * 0.12, 1.6, x, 0, HALL.maxZ + 36);
  for (const x of [-9, 9]) {
    b.slab(m.steel, 0.16, 6.2, 0.16, x, 0, HALL.maxZ + 22);
    b.box(m.steel, 0.14, 0.1, 1.5, x, 6.2, HALL.maxZ + 21.3);
    b.box(m.glow.streetLamp.material, 0.34, 0.06, 0.6, x, 6.13, HALL.maxZ + 20.7);
  }
  // Concrete bollards beside the hero door.
  for (const side of [-1, 1]) b.cyl(m.yellow, 0.11, 1.0, side * (DOOR.width / 2 + 0.5), 0.5, HALL.maxZ + 0.8, 'y', { segments: 14 });
}

/** Everything fixed about the building itself: floors, walls, roof, steel, doors and the photo bay. */
export function buildBuilding(b: MeshBatcher, m: ShopMaterials): void {
  floorsAndMarkings(b, m);
  walls(b, m);
  clerestory(b, m);
  roof(b, m);
  structure(b, m);
  BAY_X.forEach((bx, i) => rollUpDoor(b, m, bx, i === 1));
  photoBay(b, m);
  outside(b, m);
}
