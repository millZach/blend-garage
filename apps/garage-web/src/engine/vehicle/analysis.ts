import * as THREE from 'three';
import type { VehicleManifest } from '@blend-garage/vehicle-core';
import type { WheelCorner } from '../types';

/** One renderable mesh of the imported car, measured in the car's own frame (front = +Z, left = +X). */
export interface MeshRecord {
  mesh: THREE.Mesh;
  /** Local-to-car-frame transform. */
  matrix: THREE.Matrix4;
  /** The Blender object name this mesh came from. */
  name: string;
  lower: string;
  materialLower: string;
  box: THREE.Box3;
  center: THREE.Vector3;
  size: THREE.Vector3;
  /** Blender object name of the `wheel_assembly_*` node this mesh sits under, if any. */
  wheelAssembly: string | null;
  partId: string | null;
}

export interface WheelFit {
  corner: WheelCorner;
  center: THREE.Vector3;
  radius: number;
  width: number;
  /** +1 for a wheel on the car's left (+X), -1 on the right. */
  side: 1 | -1;
  front: boolean;
  /** Meshes that turn with the wheel. */
  spin: MeshRecord[];
  /** Meshes inside the wheel (calipers, hub carriers) that steer and camber with it but do not turn. */
  carried: MeshRecord[];
  /** Radius of the wheel's metal face, used to size replacement wheel faces. */
  rimRadius: number;
  /** How far the metal face sits from the wheel center along the axle, toward the outside of the car. */
  faceOffset: number;
}

const FRONT_WORDS = /(front|headl|head_l|hood|bonnet|windscreen|windshield|grille|drl)/;
const REAR_WORDS = /(rear|tail|trunk|boot|exhaust|diffuser|spoiler|backlight|back-up|backup)/;
const FRONT_CORNER = /(^|[_\-\s.])(fl|fr|front[_\-\s]?(l|r|left|right))($|[_\-\s.])/;
const REAR_CORNER = /(^|[_\-\s.])(rl|rr|bl|br|rear[_\-\s]?(l|r|left|right)|back[_\-\s]?(l|r|left|right))($|[_\-\s.])/;
const WHEEL_WORDS = /(wheel|tire|tyre|rim|hub|lug|spoke)/;
const NOT_SPINNING = /(caliper|brake[ _-]?pad|knuckle|upright|strut|spring|damper|shock|suspension|control[ _-]?arm|wishbone|tie[ _-]?rod|liner|wheelhouse|wheel[ _-]?well|arch|tub|splash|mudguard|housing|steering)/;

function sourceName(object: THREE.Object3D): string {
  for (let o: THREE.Object3D | null = object; o; o = o.parent) {
    const name = o.userData.name;
    if (typeof name === 'string' && name) return name;
  }
  return object.name;
}

/**
 * Lists every mesh of a loaded glTF scene with its bounds in the scene's frame. Bounds come from the
 * accessor min/max that glTF stores, so this never touches vertex data.
 */
export function collectMeshes(scene: THREE.Object3D, manifest: VehicleManifest): MeshRecord[] {
  scene.updateMatrixWorld(true);
  const partIds = new Map(manifest.parts.map((p) => [p.objectName, p.id]));
  const assemblies = new Set(manifest.wheels.map((w) => w.objectName));
  const records: MeshRecord[] = [];
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || !object.geometry.attributes.position) return;
    const geometry = object.geometry as THREE.BufferGeometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox!.clone().applyMatrix4(object.matrixWorld);
    let wheelAssembly: string | null = null;
    let partId: string | null = null;
    for (let o: THREE.Object3D | null = object; o; o = o.parent) {
      const name = o.userData.name;
      if (typeof name !== 'string') continue;
      if (!partId && partIds.has(name)) partId = partIds.get(name)!;
      if (!wheelAssembly && (assemblies.has(name) || name.startsWith('wheel_assembly_'))) wheelAssembly = name;
    }
    const name = sourceName(object);
    const material = object.material as THREE.Material;
    records.push({
      mesh: object,
      matrix: object.matrixWorld.clone(),
      name,
      lower: name.toLowerCase(),
      materialLower: material.name.toLowerCase(),
      box,
      center: box.getCenter(new THREE.Vector3()),
      size: box.getSize(new THREE.Vector3()),
      wheelAssembly,
      partId,
    });
  });
  return records;
}

function meanZ(records: MeshRecord[]): number | null {
  if (!records.length) return null;
  let sum = 0;
  for (const r of records) sum += r.center.z;
  return sum / records.length;
}

/**
 * Works out which way the car is pointing: +1 if its nose is toward +Z, -1 if toward -Z.
 *
 * The importer only guarantees that the car lies lengthwise along Z, and the FL/FR/RL/RR labels in
 * the manifest assume a nose direction that is wrong for about half of real .blend files. So this
 * takes a vote: part names that say front or rear, where the headlight and taillight materials are,
 * explicit corner suffixes on wheel parts, and (weakest) the manifest's own labels.
 */
export function detectFrontSign(records: MeshRecord[], manifest: VehicleManifest): 1 | -1 {
  let score = 0;
  const vote = (front: number | null, rear: number | null, weight: number) => {
    if (front !== null && rear !== null && Math.abs(front - rear) > 0.3) score += weight * Math.sign(front - rear);
  };

  vote(meanZ(records.filter((r) => FRONT_WORDS.test(r.lower) && !REAR_WORDS.test(r.lower))), meanZ(records.filter((r) => REAR_WORDS.test(r.lower) && !FRONT_WORDS.test(r.lower))), 3);

  const lampMaterials = (role: 'headlight' | 'taillight') => new Set(manifest.materialZones.filter((z) => z.role === role).map((z) => z.materialName.toLowerCase()));
  const heads = lampMaterials('headlight');
  const tails = lampMaterials('taillight');
  const headZ = meanZ(records.filter((r) => heads.has(r.materialLower)));
  const tailZ = meanZ(records.filter((r) => tails.has(r.materialLower)));
  if (headZ !== null && tailZ !== null) vote(headZ, tailZ, 3);
  else if (headZ !== null && Math.abs(headZ) > 0.5) score += 2 * Math.sign(headZ);
  else if (tailZ !== null && Math.abs(tailZ) > 0.5) score -= 2 * Math.sign(tailZ);

  const wheelParts = records.filter((r) => WHEEL_WORDS.test(r.lower));
  vote(meanZ(wheelParts.filter((r) => FRONT_CORNER.test(r.lower))), meanZ(wheelParts.filter((r) => REAR_CORNER.test(r.lower))), 3);

  const plausible = manifest.wheels.filter((w) => w.radius > 0.2 && w.radius < 0.55 && Math.abs(w.center[0]) > 0.3);
  const labelled = (prefix: string) => {
    const zs = plausible.filter((w) => w.corner.startsWith(prefix)).map((w) => w.center[2]);
    return zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : null;
  };
  vote(labelled('F'), labelled('R'), 1);

  return score >= 0 ? 1 : -1;
}

const NEVER_BODY_PAINT = new Set(['glass', 'trim', 'rim', 'headlight', 'taillight']);

/**
 * Picks the material zone that is the car's body paint, by what it covers rather than what it is
 * called: the paint is the big clearcoated surface that runs the whole length and width of the car.
 *
 * The manifest's "primary" role goes to whichever material has "paint" or "body" in its name, which on
 * real .blend files is sometimes painted wheel steel or a gauge face while the actual lacquer is named
 * for its color ("Monza Red") and filed under "other". Returns `null` if nothing looks like bodywork.
 */
export function findBodyPaintZone(records: MeshRecord[], manifest: VehicleManifest, bounds: THREE.Box3): string | null {
  const zones = new Map(manifest.materialZones.map((z) => [z.materialName, z]));
  const stats = new Map<string, { area: number; box: THREE.Box3; clearcoat: number; primary: boolean }>();
  for (const r of records) {
    const material = r.mesh.material as THREE.Material;
    const zone = zones.get(material.name);
    if (!zone || NEVER_BODY_PAINT.has(zone.role) || material.transparent) continue;
    let s = stats.get(zone.id);
    if (!s) {
      s = { area: 0, box: new THREE.Box3(), clearcoat: 0, primary: zone.role === 'primary' };
      stats.set(zone.id, s);
    }
    s.area += 2 * (r.size.x * r.size.y + r.size.y * r.size.z + r.size.x * r.size.z);
    s.box.union(r.box);
    if (material instanceof THREE.MeshPhysicalMaterial) s.clearcoat = Math.max(s.clearcoat, material.clearcoat);
  }
  const car = bounds.getSize(new THREE.Vector3());
  const span = new THREE.Vector3();
  let best: string | null = null;
  let bestScore = 0;
  for (const [zoneId, s] of stats) {
    s.box.getSize(span);
    if (span.x < car.x * 0.8 || span.z < car.z * 0.8 || span.y < car.y * 0.5) continue;
    const score = s.area * (0.25 + s.clearcoat) * (s.primary ? 1.5 : 1);
    if (score > bestScore) {
      bestScore = score;
      best = zoneId;
    }
  }
  return best;
}

/** Re-expresses the records in the car frame by composing `frame` onto every transform and box. */
export function reframe(records: MeshRecord[], frame: THREE.Matrix4): void {
  for (const r of records) {
    r.matrix.premultiply(frame);
    r.box.applyMatrix4(frame);
    r.box.getCenter(r.center);
    r.box.getSize(r.size);
  }
}

function isTireLike(r: MeshRecord): boolean {
  const { x: sx, y: sy, z: sz } = r.size;
  const d = Math.max(sy, sz);
  return (
    d > 0.42 &&
    d < 1.0 &&
    Math.abs(sy - sz) / d < 0.09 &&
    sx > 0.1 &&
    sx < 0.55 &&
    sx < 0.8 * d &&
    r.box.min.y < 0.1 &&
    r.box.min.y > -0.08 &&
    Math.abs(r.center.x) > 0.3 &&
    Math.abs(r.center.z) > 0.45
  );
}

const CORNERS: { corner: WheelCorner; sx: 1 | -1; sz: 1 | -1 }[] = [
  { corner: 'FL', sx: 1, sz: 1 },
  { corner: 'FR', sx: -1, sz: 1 },
  { corner: 'RL', sx: 1, sz: -1 },
  { corner: 'RR', sx: -1, sz: -1 },
];

/**
 * Finds the four road wheels by shape rather than by name: a tire is a round thing of plausible size,
 * out at a corner of the car, touching the ground. Everything that shares its axis and fits inside it
 * turns with it. The manifest's wheel boxes are only a fallback, because on real .blend files they
 * often swallow wheel-arch liners, lamps or half the car.
 */
export function detectWheels(records: MeshRecord[], manifest: VehicleManifest, frontSign: 1 | -1): WheelFit[] {
  const tires = records.filter(isTireLike);
  const wheels: WheelFit[] = [];
  for (const { corner, sx, sz } of CORNERS) {
    let center: THREE.Vector3 | null = null;
    let radius = 0;
    let width = 0;
    const best = tires.filter((r) => Math.sign(r.center.x) === sx && Math.sign(r.center.z) === sz).sort((a, b) => b.size.y + b.size.z - (a.size.y + a.size.z))[0];
    if (best) {
      center = best.center.clone();
      radius = (best.size.y + best.size.z) / 4;
      width = best.size.x;
    } else {
      // Fall back to a manifest wheel in this quadrant, if it describes something wheel-sized.
      const guess = manifest.wheels.find((w) => w.radius > 0.2 && w.radius < 0.55 && Math.sign(w.center[0] * frontSign) === sx && Math.sign(w.center[2] * frontSign) === sz && Math.abs(w.center[0]) > 0.3);
      if (guess) {
        center = new THREE.Vector3(guess.center[0] * frontSign, guess.center[1], guess.center[2] * frontSign);
        radius = guess.radius;
        width = Math.min(0.4, Math.max(0.16, guess.width));
      }
    }
    if (!center) continue;

    const half = width / 2;
    const spin: MeshRecord[] = [];
    const carried: MeshRecord[] = [];
    for (const r of records) {
      if (r.box.min.x < center.x - half - 0.07 || r.box.max.x > center.x + half + 0.07) continue;
      const offAxis = Math.hypot(r.center.y - center.y, r.center.z - center.z);
      const reach = offAxis + Math.max(r.size.y, r.size.z) / 2;
      if (reach > radius * 1.04) continue;
      const round = Math.abs(r.size.y - r.size.z) / Math.max(r.size.y, r.size.z, 1e-3) < 0.12;
      const concentric = offAxis < 0.035 && round;
      const blocked = NOT_SPINNING.test(r.lower) || NOT_SPINNING.test(r.materialLower);
      if (r === best || (!blocked && (r.wheelAssembly !== null || concentric))) spin.push(r);
      else if (reach < radius * 0.98) carried.push(r);
    }

    // The metal face is the largest turning piece that is clearly smaller than the tire.
    let rimRadius = 0;
    let faceOffset = -Infinity;
    for (const r of spin) {
      const reach = Math.hypot(r.center.y - center.y, r.center.z - center.z) + Math.max(r.size.y, r.size.z) / 2;
      if (reach >= radius * 0.88) continue;
      if (reach > radius * 0.45) rimRadius = Math.max(rimRadius, reach);
      // Center caps and spokes can stand proud of the barrel; a replacement face has to clear them all.
      faceOffset = Math.max(faceOffset, sx > 0 ? r.box.max.x - center.x : center.x - r.box.min.x);
    }
    if (!rimRadius) rimRadius = radius * 0.7;
    faceOffset = Number.isFinite(faceOffset) ? Math.min(faceOffset, half + 0.012) : half - 0.02;

    wheels.push({ corner, center, radius, width, side: sx, front: sz > 0, spin, carried, rimRadius, faceOffset });
  }
  return wheels;
}
