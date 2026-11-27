import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { UniversalRoofAccessory, UniversalSpoilerStyle, VehicleManifest } from '@blend-garage/vehicle-core';
import { MeshBatcher } from '../MeshBatcher';
import { clamp } from '../math';
import type { HeightField } from './batching';

/** Materials shared by every bolt-on part of one car. Owned (and disposed) by the rig. */
export interface AeroMaterials {
  /** Follows the car's primary paint. */
  body: THREE.MeshPhysicalMaterial;
  carbon: THREE.MeshPhysicalMaterial;
  satin: THREE.MeshStandardMaterial;
  alloy: THREE.MeshStandardMaterial;
  chrome: THREE.MeshStandardMaterial;
  red: THREE.MeshPhysicalMaterial;
  /** Dark inside of exhaust tips. */
  soot: THREE.MeshStandardMaterial;
  /** Lens of the roof lightbar lamps; the car's light switch drives its brightness. */
  lamp: THREE.MeshBasicMaterial;
}

export function createAeroMaterials(): AeroMaterials {
  const body = new THREE.MeshPhysicalMaterial({ color: 0x888888, metalness: 0.6, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.05 });
  body.name = 'bolt-on body color';
  const carbon = new THREE.MeshPhysicalMaterial({ color: 0x15171a, metalness: 0.35, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08, side: THREE.DoubleSide });
  carbon.name = 'bolt-on carbon';
  const satin = new THREE.MeshStandardMaterial({ color: 0x17191b, metalness: 0.3, roughness: 0.55 });
  satin.name = 'bolt-on satin black';
  const alloy = new THREE.MeshStandardMaterial({ color: 0xb9bfc5, metalness: 0.9, roughness: 0.28 });
  alloy.name = 'bolt-on alloy';
  const chrome = new THREE.MeshStandardMaterial({ color: 0xe9ecee, metalness: 1, roughness: 0.1, side: THREE.DoubleSide });
  chrome.name = 'bolt-on chrome';
  const red = new THREE.MeshPhysicalMaterial({ color: 0xc41a14, metalness: 0.3, roughness: 0.35, clearcoat: 0.6 });
  red.name = 'tow hook red';
  const soot = new THREE.MeshStandardMaterial({ color: 0x0a0a0b, metalness: 0.2, roughness: 0.9, side: THREE.BackSide });
  soot.name = 'exhaust soot';
  const lamp = new THREE.MeshBasicMaterial({ color: 0x3a3d40 });
  lamp.name = 'lightbar lens';
  return { body, carbon, satin, alloy, chrome, red, soot, lamp };
}

/** What the part builders know about the car: its box, its surface map, and any artist-placed mounts. */
export interface AeroContext {
  bounds: THREE.Box3;
  field: HeightField;
  /** `slot_*` empties from the .blend, keyed by category, already in the car frame. */
  slots: Map<string, THREE.Vector3>;
  materials: AeroMaterials;
}

export function slotsFromManifest(manifest: VehicleManifest, frontSign: 1 | -1): Map<string, THREE.Vector3> {
  const slots = new Map<string, THREE.Vector3>();
  for (const slot of manifest.slots) {
    const key = slot.category.split(/[_\-\s]/)[0];
    if (!slots.has(key)) slots.set(key, new THREE.Vector3(slot.position[0] * frontSign, slot.position[1], slot.position[2] * frontSign));
  }
  return slots;
}

function finish(b: MeshBatcher, name: string): THREE.Group {
  return b.build(name, { castShadow: true, receiveShadow: true });
}

/**
 * A surface lofted across the car from rows of points. Each row runs from the car's right to its left
 * (-X to +X); the lit side faces up when the rows run nose to tail.
 */
function loft(rows: THREE.Vector3[][]): THREE.BufferGeometry {
  const n = rows[0].length;
  const positions: number[] = [];
  const indices: number[] = [];
  for (const row of rows) for (const p of row) positions.push(p.x, p.y, p.z);
  for (let r = 0; r < rows.length - 1; r++) {
    for (let i = 0; i < n - 1; i++) {
      const a = r * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

/** Stations across the car, with the outermost ones eased so tips taper instead of ending square. */
function stations(halfSpan: number, count: number): { x: number; taper: number }[] {
  return Array.from({ length: count + 1 }, (_, i) => {
    const t = (i / count) * 2 - 1;
    return { x: t * halfSpan, taper: Math.pow(Math.cos((t * Math.PI) / 2), 0.38) };
  });
}

function tailDeck(ctx: AeroContext): { z: number; y: number } {
  const slot = ctx.slots.get('spoiler');
  if (slot) return { z: slot.z, y: slot.y };
  const z = ctx.bounds.min.z + 0.2;
  return { z, y: ctx.field.topAt(0, z, 0.1, ctx.bounds.max.y * 0.7) };
}

/** Kicked-up lip that grows out of the tail deck and follows its outline. */
function tailLip(ctx: AeroContext, chord: number, height: number, name: string): THREE.Group {
  const { field, bounds, materials } = ctx;
  const b = new MeshBatcher();
  const halfSpan = (bounds.max.x - bounds.min.x) * 0.42;
  const deck = tailDeck(ctx);
  const front: THREE.Vector3[] = [];
  const crest: THREE.Vector3[] = [];
  const back: THREE.Vector3[] = [];
  for (const { x, taper } of stations(halfSpan, 26)) {
    // Follow the real tail edge at deck height, so the lip curves with the bodywork.
    const tailZ = field.edge(x, -1, deck.y - 0.22, deck.y + 0.4, 0.05) + 0.035;
    const rootZ = tailZ + chord * (0.55 + 0.45 * taper);
    const rootY = field.topAt(x, rootZ, 0.05, deck.y) - 0.012;
    const tailY = field.topAt(x, tailZ + 0.04, 0.05, deck.y);
    front.push(new THREE.Vector3(x, rootY, rootZ));
    crest.push(new THREE.Vector3(x, Math.max(tailY, rootY) + height * taper, tailZ));
    back.push(new THREE.Vector3(x, Math.min(tailY, rootY) - 0.03, tailZ - 0.012));
  }
  b.add(materials.body, loft([front, crest, back]));
  // Close the two ends.
  for (const i of [0, front.length - 1]) {
    const g = new THREE.BufferGeometry();
    const pts = i === 0 ? [front[i], crest[i], back[i]] : [front[i], back[i], crest[i]];
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flatMap((p) => [p.x, p.y, p.z]), 3));
    g.computeVertexNormals();
    b.add(materials.body, g);
  }
  return finish(b, name);
}

function gtWing(ctx: AeroContext): THREE.Group {
  const { field, bounds, materials } = ctx;
  const b = new MeshBatcher();
  const width = bounds.max.x - bounds.min.x;
  const span = width * 0.92;
  const chord = 0.3;
  const deck = tailDeck(ctx);
  const wingZ = bounds.min.z + 0.05 + chord / 2;
  const wingY = Math.min(deck.y + 0.36, bounds.max.y + 0.06);

  // Main plane: a cambered section swept across the car.
  const profile = new THREE.Shape();
  profile.moveTo(-chord / 2, 0.006);
  profile.bezierCurveTo(-chord * 0.3, 0.05, chord * 0.2, 0.04, chord / 2, -0.004);
  profile.lineTo(chord / 2, -0.014);
  profile.bezierCurveTo(chord * 0.15, -0.006, -chord * 0.3, -0.012, -chord / 2, -0.004);
  profile.closePath();
  const plane = new THREE.ExtrudeGeometry(profile, { depth: span, bevelEnabled: false, curveSegments: 10 });
  plane.translate(0, 0, -span / 2);
  // Shape X is the chord (pointing toward the tail), extrusion runs across the car.
  plane.rotateY(Math.PI / 2);
  b.add(materials.carbon, plane, 0, wingY, wingZ, [-0.14, 0, 0]);
  // Gurney flap along the trailing edge.
  b.box(materials.carbon, span, 0.022, 0.004, 0, wingY - 0.012, wingZ - chord / 2 - 0.004);

  for (const side of [-1, 1]) {
    // End plates.
    b.box(materials.carbon, 0.008, 0.2, chord + 0.07, side * (span / 2), wingY - 0.03, wingZ);
    // Swan-neck uprights from the deck to the top of the wing.
    const x = side * Math.min(0.46, width * 0.23);
    const footY = field.topAt(x, wingZ + 0.08, 0.06, deck.y);
    b.box(materials.satin, 0.07, 0.014, 0.24, x, footY + 0.004, wingZ + 0.08);
    b.beam(materials.alloy, [x, footY, wingZ + 0.16], [x, wingY + 0.05, wingZ + 0.1], 0.012, 0.09);
    b.beam(materials.alloy, [x, wingY + 0.05, wingZ + 0.12], [x, wingY + 0.03, wingZ - 0.06], 0.012, 0.05);
  }
  return finish(b, 'gt wing');
}

export function buildSpoiler(style: UniversalSpoilerStyle, ctx: AeroContext): THREE.Group | null {
  if (style === 'gt-wing') return gtWing(ctx);
  if (style === 'ducktail') return tailLip(ctx, 0.3, 0.11, 'ducktail');
  if (style === 'street-lip') return tailLip(ctx, 0.14, 0.042, 'street lip');
  return null;
}

/** Finds the flat of the roof along the centerline: where it starts, where it ends, and how high it is. */
function roofSpan(ctx: AeroContext): { front: number; rear: number; y: number } {
  const { field, bounds } = ctx;
  let y = -Infinity;
  for (let z = bounds.min.z + 0.9; z <= bounds.max.z - 1.0; z += 0.04) y = Math.max(y, field.topAt(0, z, 0.08, 0));
  let rear = 0;
  let front = 0;
  let seen = false;
  for (let z = bounds.min.z + 0.9; z <= bounds.max.z - 1.0; z += 0.04) {
    if (field.topAt(0, z, 0.08, 0) > y - 0.045) {
      if (!seen) rear = z;
      front = z;
      seen = true;
    }
  }
  return { front, rear, y };
}

function roofHalfWidth(ctx: AeroContext, z: number, roofY: number): number {
  const limit = (ctx.bounds.max.x - ctx.bounds.min.x) / 2;
  let x = 0.2;
  while (x < limit && ctx.field.topAt(x, z, 0.04, 0) > roofY - 0.11) x += 0.04;
  return clamp(x - 0.06, 0.38, 0.72);
}

function crossbar(b: MeshBatcher, ctx: AeroContext, z: number, roofY: number, lift: number): number {
  const { field, materials } = ctx;
  const half = roofHalfWidth(ctx, z, roofY);
  const y = field.topAt(0, z, 0.08, roofY) + lift;
  b.box(materials.satin, half * 2 + 0.12, 0.028, 0.065, 0, y, z);
  for (const side of [-1, 1]) {
    const footY = field.topAt(side * half, z, 0.05, roofY - 0.05);
    b.beam(materials.satin, [side * half, footY - 0.005, z], [side * half, y, z], 0.05, 0.08);
    b.box(materials.satin, 0.1, 0.02, 0.12, side * half, footY + 0.008, z);
  }
  return y;
}

function roofBox(ctx: AeroContext): THREE.Group {
  const b = new MeshBatcher();
  const roof = roofSpan(ctx);
  const slot = ctx.slots.get('roof');
  const mid = slot ? slot.z : (roof.front + roof.rear) / 2 - 0.05;
  const gap = clamp((roof.front - roof.rear) * 0.36, 0.26, 0.42);
  const barY = Math.max(crossbar(b, ctx, mid - gap, roof.y, 0.085), crossbar(b, ctx, mid + gap, roof.y, 0.085));

  // Touring box: a rounded shell, lower and narrower toward the nose.
  const length = 1.72;
  const shell = new RoundedBoxGeometry(0.82, 0.32, length, 5, 0.13);
  const p = shell.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = clamp(p.getZ(i) / (length / 2), -1, 1);
    const nose = t > 0 ? t * t : 0;
    p.setX(i, p.getX(i) * (1 - nose * 0.3) * (1 - (t < 0 ? t * t * 0.08 : 0)));
    p.setY(i, p.getY(i) > 0 ? p.getY(i) * (1 - nose * 0.55) : p.getY(i) * (1 - nose * 0.2));
  }
  shell.computeVertexNormals();
  const boxY = barY + 0.014 + 0.16;
  b.add(ctx.materials.carbon, shell, 0, boxY, mid - 0.04);
  // Lid seam and lock.
  b.box(ctx.materials.satin, 0.83, 0.008, length * 0.9, 0, boxY - 0.03, mid - 0.1);
  b.box(ctx.materials.alloy, 0.07, 0.03, 0.012, 0.415, boxY - 0.03, mid - 0.2, [0, Math.PI / 2, 0]);
  return finish(b, 'roof box');
}

function rallyLightbar(ctx: AeroContext): THREE.Group {
  const { materials } = ctx;
  const b = new MeshBatcher();
  const roof = roofSpan(ctx);
  const z = (ctx.slots.get('roof')?.z ?? roof.front) - 0.07;
  const half = roofHalfWidth(ctx, z, roof.y);
  const barY = crossbar(b, ctx, z, roof.y, 0.07);
  const lamps = half > 0.56 ? 5 : 4;
  const pitch = Math.min(0.24, (half * 2 - 0.1) / lamps);
  for (let i = 0; i < lamps; i++) {
    const x = (i - (lamps - 1) / 2) * pitch;
    const y = barY + 0.118;
    b.box(materials.satin, 0.03, 0.05, 0.03, x, barY + 0.035, z);
    b.cyl(materials.satin, 0.1, 0.1, x, y, z - 0.012, 'z', { segments: 24, radiusTop: 0.086 });
    b.add(materials.chrome, new THREE.TorusGeometry(0.094, 0.009, 8, 28), x, y, z + 0.038);
    b.add(materials.lamp, new THREE.CircleGeometry(0.088, 28), x, y, z + 0.04);
  }
  return finish(b, 'rally lightbar');
}

export function buildRoofGear(kind: UniversalRoofAccessory, ctx: AeroContext): THREE.Group | null {
  if (kind === 'roof-box') return roofBox(ctx);
  if (kind === 'rally-lightbar') return rallyLightbar(ctx);
  return null;
}

export function buildSplitter(ctx: AeroContext): THREE.Group {
  const { field, bounds, materials } = ctx;
  const b = new MeshBatcher();
  const halfSpan = (bounds.max.x - bounds.min.x) * 0.455;
  const noseY: number[] = [];
  const rows = stations(halfSpan, 30).map(({ x, taper }) => {
    const nose = field.edge(x, 1, 0, 0.42, 0.05);
    noseY.push(field.bottomAt(x, nose - 0.12, 0.06, 0.16));
    return { x, taper, nose };
  });
  // One flat blade just under the lowest point of the nose.
  const y = Math.max(0.045, [...noseY].sort((a, c) => a - c)[Math.floor(noseY.length * 0.2)] - 0.014);
  const leading: THREE.Vector3[] = [];
  const trailing: THREE.Vector3[] = [];
  const leadingLow: THREE.Vector3[] = [];
  const trailingLow: THREE.Vector3[] = [];
  for (const { x, taper, nose } of rows) {
    const lead = nose + 0.03 + 0.05 * taper;
    leading.push(new THREE.Vector3(x, y, lead));
    trailing.push(new THREE.Vector3(x, y, nose - 0.26));
    leadingLow.push(new THREE.Vector3(x, y - 0.012, lead));
    trailingLow.push(new THREE.Vector3(x, y - 0.012, nose - 0.26));
  }
  b.add(materials.carbon, loft([leading, trailing, trailingLow, leadingLow, leading]));
  for (const side of [-1, 1]) {
    // Canard-style end fences and adjustable support rods.
    const end = side === -1 ? rows[1] : rows[rows.length - 2];
    b.box(materials.carbon, 0.006, 0.07, 0.24, end.x, y + 0.03, end.nose - 0.1);
    const rodX = side * halfSpan * 0.42;
    const rodNose = field.edge(rodX, 1, 0, 0.42, 0.05);
    b.beam(materials.alloy, [rodX, y, rodNose + 0.055], [rodX, y + 0.15, rodNose - 0.01], 0.008);
    b.cyl(materials.alloy, 0.012, 0.02, rodX, y + 0.004, rodNose + 0.055, 'y', { segments: 8 });
  }
  return finish(b, 'front splitter');
}

export function buildTowHook(ctx: AeroContext): THREE.Group {
  const { field, bounds, materials } = ctx;
  const b = new MeshBatcher();
  const x = (bounds.max.x - bounds.min.x) * 0.2;
  const y = clamp(field.bottomAt(x, bounds.max.z - 0.2, 0.08, 0.2) + 0.2, 0.3, 0.5);
  const z = field.edge(x, 1, y - 0.06, y + 0.06, 0.04);
  b.cyl(materials.alloy, 0.03, 0.012, x, y, z - 0.004, 'z', { segments: 16 });
  b.cyl(materials.chrome, 0.011, 0.06, x, y, z + 0.03, 'z', { segments: 10 });
  b.add(materials.red, new THREE.TorusGeometry(0.036, 0.0095, 10, 28), x, y, z + 0.092, [0, Math.PI / 2, 0]);
  b.box(materials.red, 0.019, 0.024, 0.03, x, y, z + 0.052);
  return finish(b, 'tow hook');
}

export function buildExhaustTips(ctx: AeroContext): THREE.Group {
  const { field, bounds, materials } = ctx;
  const b = new MeshBatcher();
  const slot = ctx.slots.get('exhaust');
  const offset = slot ? Math.max(0.2, Math.abs(slot.x)) : (bounds.max.x - bounds.min.x) * 0.27;
  for (const side of [-1, 1]) {
    for (const pair of [-0.055, 0.055]) {
      const x = side * offset + pair;
      const tail = field.edge(x, -1, 0, 0.5, 0.05);
      const y = slot ? slot.y : clamp(field.bottomAt(x, tail + 0.14, 0.07, 0.2) + 0.075, 0.17, 0.42);
      const z = tail - 0.012;
      b.cyl(materials.chrome, 0.047, 0.2, x, y, z + 0.07, 'z', { segments: 22, open: true });
      b.cyl(materials.soot, 0.043, 0.2, x, y, z + 0.07, 'z', { segments: 22, open: true });
      b.add(materials.chrome, new THREE.TorusGeometry(0.0465, 0.0055, 8, 24), x, y, z - 0.03);
      b.add(materials.soot, new THREE.CircleGeometry(0.043, 18), x, y, z + 0.16);
    }
  }
  return finish(b, 'exhaust tips');
}

export function disposeGroup(group: THREE.Group | null): void {
  if (!group) return;
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) o.geometry.dispose();
  });
  group.removeFromParent();
}
