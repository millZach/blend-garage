import * as THREE from 'three';
import type { RoadNetwork } from './roads';
import type { TerrainData } from './terrain';
import type { WorldTextures } from './textures';

/** Exact shared contract with `@blend-garage/world-racing` for knockable dynamic rigid-body props. */
export type DynamicPropKind = 'barrel' | 'crate' | 'barrier' | 'cone' | 'tire-stack';

export interface DynamicWorldPropDef {
  id: string;
  kind: DynamicPropKind;
  shape: 'box' | 'cylinder';
  /** Half-extents [hx, hy, hz] for box; for cylinder [radius, halfHeight, radius]. */
  halfExtents: [number, number, number];
  position: [number, number, number];
  rotationY?: number;
  mass: number;
  restitution?: number;
  friction?: number;
}

export interface DynamicPropTransformInput {
  id: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

export interface DynamicPropsSystem {
  group: THREE.Group;
  defs: readonly DynamicWorldPropDef[];
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
  /** Zero-allocation per-frame matrix sync from Rapier dynamic rigid body transforms. */
  sync(transforms: readonly DynamicPropTransformInput[]): void;
}

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _mat = new THREE.Matrix4();

/**
 * Builds ~88 scatterable, knockable dynamic props (red/white crash barrels, wooden smash crates,
 * movable concrete Jersey barriers, rubber tire stacks, traffic cones) rendered via 5 lightweight
 * `InstancedMesh`es (`castShadow = false` for 60 fps) with zero-allocation pose syncing.
 */
export function buildDynamicPropsSystem(
  network: RoadNetwork,
  terrain: TerrainData,
  textures: WorldTextures,
): DynamicPropsSystem {
  const group = new THREE.Group();
  group.name = 'world-dynamic-props';
  const defs: DynamicWorldPropDef[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  let seq = 0;
  const addProp = (
    kind: DynamicPropKind,
    x: number,
    z: number,
    yOffsetBottom = 0,
    rotationY = 0,
  ) => {
    const gy = terrain.sampleHeight(x, z);
    const id = `dyn-${kind}-${seq++}`;
    switch (kind) {
      case 'barrel':
        defs.push({
          id,
          kind,
          shape: 'cylinder',
          halfExtents: [0.34, 0.48, 0.34],
          position: [x, gy + yOffsetBottom + 0.48, z],
          rotationY,
          mass: 28,
          restitution: 0.28,
          friction: 0.55,
        });
        break;
      case 'crate':
        defs.push({
          id,
          kind,
          shape: 'box',
          halfExtents: [0.52, 0.52, 0.52],
          position: [x, gy + yOffsetBottom + 0.52, z],
          rotationY,
          mass: 36,
          restitution: 0.22,
          friction: 0.65,
        });
        break;
      case 'barrier':
        defs.push({
          id,
          kind,
          shape: 'box',
          halfExtents: [0.38, 0.46, 1.35],
          position: [x, gy + yOffsetBottom + 0.46, z],
          rotationY,
          mass: 195,
          restitution: 0.14,
          friction: 0.78,
        });
        break;
      case 'cone':
        defs.push({
          id,
          kind,
          shape: 'cylinder',
          halfExtents: [0.24, 0.38, 0.24],
          position: [x, gy + yOffsetBottom + 0.38, z],
          rotationY,
          mass: 6,
          restitution: 0.35,
          friction: 0.55,
        });
        break;
      case 'tire-stack':
        defs.push({
          id,
          kind,
          shape: 'cylinder',
          halfExtents: [0.46, 0.55, 0.46],
          position: [x, gy + yOffsetBottom + 0.55, z],
          rotationY,
          mass: 58,
          restitution: 0.42,
          friction: 0.82,
        });
        break;
    }
  };

  // -------------------------------------------------------------------------
  // 1. CRASH TEST ARENA & AIRFIELD STUNT PARK (X: -540..-140, Z: 440..940)
  // -------------------------------------------------------------------------
  // (a) Barrel Bowling Triangle right on the Target Wall approach (X = -385, Z = 620) — 10 barrels!
  const bowlingRows = 4;
  for (let row = 0; row < bowlingRows; row++) {
    const bx = -386 + row * 1.15;
    for (let col = 0; col <= row; col++) {
      const bz = 620 + (col - row * 0.5) * 1.15;
      addProp('barrel', bx, bz);
    }
  }

  // (b) Wooden Smash-Crate Pyramid wall right after the Small Ramp landing zone (X = -352, Z = 505) — 10 crates!
  for (let i = 0; i < 4; i++) addProp('crate', -352, 505 + (i - 1.5) * 1.12, 0);
  for (let i = 0; i < 3; i++) addProp('crate', -352, 505 + (i - 1.0) * 1.12, 1.05);
  for (let i = 0; i < 2; i++) addProp('crate', -352, 505 + (i - 0.5) * 1.12, 2.1);
  addProp('crate', -352, 505, 3.15);

  // (c) Second Wooden Smash-Crate Wall after Medium Ramp landing (X = -326, Z = 540) — 6 crates!
  for (let i = 0; i < 4; i++) addProp('crate', -326, 540 + (i - 1.5) * 1.12, 0);
  for (let i = 0; i < 2; i++) addProp('crate', -326, 540 + (i - 0.5) * 1.12, 1.05);

  // (d) Movable Concrete Jersey Barriers forming smashable chicane gates (X = -460..-320, Z = 668) — 8 barriers!
  for (let i = 0; i < 4; i++) {
    addProp('barrier', -452 + i * 28, 662, 0, 0);
    addProp('barrier', -438 + i * 28, 675, 0, 0);
  }

  // (e) Rubber Tire-Stack Apex Walls around the Figure-8 Drift Skidpad (centers (-402, 760) & (-278, 760)) — 14 stacks!
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    addProp('tire-stack', -402 + Math.cos(a) * 16.5, 760 + Math.sin(a) * 16.5);
    addProp('tire-stack', -278 + Math.cos(a) * 16.5, 760 + Math.sin(a) * 16.5);
  }
  // Cushion stacks flanking the main Target Crash Wall.
  addProp('tire-stack', -222, 608.5);
  addProp('tire-stack', -222, 631.5);

  // (f) Knockable Safety Cones outlining the drift crossover & stunt ramp entrances — 16 cones!
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    addProp('cone', -340 + Math.cos(a) * 14, 760 + Math.sin(a) * 14);
  }
  for (const rz of [505, 540, 576]) {
    addProp('cone', -432, rz - 6.8);
    addProp('cone', -432, rz + 6.8);
  }
  addProp('cone', -340, 456);
  addProp('cone', -340, 472);

  // -------------------------------------------------------------------------
  // 2. VALLEY EXPRESSWAY WORK-ZONE CHICANE (Z = 340, X = 120..205) — 10 props!
  // -------------------------------------------------------------------------
  for (let i = 0; i < 6; i++) {
    addProp('barrel', 120 + i * 14, 346.2);
  }
  addProp('barrier', 138, 347.2, 0, Math.PI / 2);
  addProp('barrier', 176, 347.2, 0, Math.PI / 2);
  addProp('cone', 108, 345.6);
  addProp('cone', 202, 345.6);

  // -------------------------------------------------------------------------
  // 3. RED-ROCK DESERT RALLY CHECKPOINT & SMASH GATES — 12 props!
  // -------------------------------------------------------------------------
  // Align flanking rally barrels, tire stacks & cones cleanly along the outer dirt shoulders
  // of the Rally Stage Start Arch (leaving the entire launch lane through the arch 100% clear!).
  const rallyRoad = network.roads.find((r) => r.id === 'desert-rally-loop');
  if (rallyRoad && rallyRoad.samples.length > 0) {
    const archS = rallyRoad.samples[Math.floor(rallyRoad.samples.length * 0.055)];
    const lx = archS.tz;
    const lz = -archS.tx;
    for (const side of [-1, 1]) {
      const shOff = (rallyRoad.halfWidth + 1.1) * side;
      addProp('barrel', archS.x + lx * shOff - archS.tx * 5.0, archS.z + lz * shOff - archS.tz * 5.0);
      addProp('barrel', archS.x + lx * shOff + archS.tx * 5.0, archS.z + lz * shOff + archS.tz * 5.0);
      addProp('tire-stack', archS.x + lx * (shOff + side * 0.9), archS.z + lz * (shOff + side * 0.9));
      addProp('cone', archS.x + lx * (shOff - side * 0.4) - archS.tx * 12.0, archS.z + lz * (shOff - side * 0.4) - archS.tz * 12.0);
    }
    // Fun smashable rally crate pairs further along the backstretch (~50% & ~65% around loop).
    const sBack = rallyRoad.samples[Math.floor(rallyRoad.samples.length * 0.48)];
    addProp('crate', sBack.x + sBack.tz * 4.2, sBack.z - sBack.tx * 4.2, 0, sBack.heading);
    addProp('crate', sBack.x + sBack.tz * 4.2, sBack.z - sBack.tx * 4.2, 1.05, sBack.heading);
    const sTurn = rallyRoad.samples[Math.floor(rallyRoad.samples.length * 0.64)];
    addProp('crate', sTurn.x - sTurn.tz * 4.2, sTurn.z + sTurn.tx * 4.2, 0, sTurn.heading);
    addProp('barrel', sTurn.x - sTurn.tz * 5.4, sTurn.z + sTurn.tx * 5.4);
  }

  // -------------------------------------------------------------------------
  // 4. BUILD 5 LIGHTWEIGHT INSTANCED MESHES (ONE PER PROP KIND)
  // -------------------------------------------------------------------------
  const byKind: Record<DynamicPropKind, DynamicWorldPropDef[]> = {
    barrel: [],
    crate: [],
    barrier: [],
    cone: [],
    'tire-stack': [],
  };
  for (let i = 0; i < defs.length; i++) {
    byKind[defs[i].kind].push(defs[i]);
  }

  const barrelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.96, 12);
  const crateGeo = new THREE.BoxGeometry(1.04, 1.04, 1.04);
  const barrierGeo = new THREE.BoxGeometry(0.76, 0.92, 2.7);
  const coneGeo = new THREE.ConeGeometry(0.24, 0.76, 10);
  const tireGeo = new THREE.CylinderGeometry(0.46, 0.46, 1.1, 14);
  geometries.push(barrelGeo, crateGeo, barrierGeo, coneGeo, tireGeo);

  const barrelMat = new THREE.MeshStandardMaterial({
    name: 'dyn-barrel',
    map: textures.barrelStripe,
    roughness: 0.45,
    metalness: 0.12,
  });
  const crateMat = new THREE.MeshStandardMaterial({
    name: 'dyn-crate',
    map: textures.crateWood,
    roughness: 0.86,
    metalness: 0.02,
  });
  const barrierMat = new THREE.MeshStandardMaterial({
    name: 'dyn-barrier',
    map: textures.concrete,
    roughness: 0.88,
    metalness: 0.04,
  });
  const coneMat = new THREE.MeshStandardMaterial({
    name: 'dyn-cone',
    color: 0xf96316,
    roughness: 0.48,
    metalness: 0.04,
  });
  const tireMat = new THREE.MeshStandardMaterial({
    name: 'dyn-tire-stack',
    color: 0x222428,
    roughness: 0.88,
    metalness: 0.06,
  });
  materials.push(barrelMat, crateMat, barrierMat, coneMat, tireMat);

  const geoMap: Record<DynamicPropKind, THREE.BufferGeometry> = {
    barrel: barrelGeo,
    crate: crateGeo,
    barrier: barrierGeo,
    cone: coneGeo,
    'tire-stack': tireGeo,
  };
  const matMap: Record<DynamicPropKind, THREE.Material> = {
    barrel: barrelMat,
    crate: crateMat,
    barrier: barrierMat,
    cone: coneMat,
    'tire-stack': tireMat,
  };

  const lookup = new Map<string, { mesh: THREE.InstancedMesh; index: number }>();
  const touchedMeshes: THREE.InstancedMesh[] = [];
  const allMeshes: THREE.InstancedMesh[] = [];

  for (const kind of Object.keys(byKind) as DynamicPropKind[]) {
    const list = byKind[kind];
    if (list.length === 0) continue;
    const mesh = new THREE.InstancedMesh(geoMap[kind], matMap[kind], list.length);
    mesh.name = `inst-dyn-${kind}`;
    // Zero shadow-pass cost for dynamic scatter props; keep receiveShadow so they ground naturally!
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;

    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      _pos.set(d.position[0], d.position[1], d.position[2]);
      _quat.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, d.rotationY ?? 0);
      _mat.compose(_pos, _quat, _scale);
      mesh.setMatrixAt(i, _mat);
      lookup.set(d.id, { mesh, index: i });
    }
    mesh.instanceMatrix.needsUpdate = true;
    allMeshes.push(mesh);
    group.add(mesh);
  }

  const sync = (transforms: readonly DynamicPropTransformInput[]): void => {
    touchedMeshes.length = 0;
    for (let i = 0; i < transforms.length; i++) {
      const t = transforms[i];
      const entry = lookup.get(t.id);
      if (!entry) continue;
      _pos.set(t.position[0], t.position[1], t.position[2]);
      _quat.set(t.quaternion[0], t.quaternion[1], t.quaternion[2], t.quaternion[3]);
      _mat.compose(_pos, _quat, _scale);
      entry.mesh.setMatrixAt(entry.index, _mat);
      if (!touchedMeshes.includes(entry.mesh)) touchedMeshes.push(entry.mesh);
    }
    for (let i = 0; i < touchedMeshes.length; i++) {
      touchedMeshes[i].instanceMatrix.needsUpdate = true;
    }
  };

  return { group, defs, geometries, materials, sync };
}
