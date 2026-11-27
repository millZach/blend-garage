import * as THREE from 'three';
import type { BoxColliderDef, CylinderColliderDef, TrimeshColliderDef, WorldColliderDef } from '@blend-garage/world-racing';
import { seededRandom } from '../math';
import { MeshBatcher } from '../MeshBatcher';
import type { RoadNetwork } from './roads';
import type { TerrainData } from './terrain';
import type { WorldTextures } from './textures';

export interface WorldPropsResult {
  group: THREE.Group;
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
  colliders: WorldColliderDef[];
}

/**
 * Builds a watertight extruded ramp or speed-bump mesh along X (extruded across Z)
 * and simultaneously returns an exact TrimeshColliderDef from the same vertices & indices.
 */
function buildProfilePrism(
  profile: readonly [x: number, y: number][],
  centerZ: number,
  widthZ: number,
  id: string,
  tag: string,
  surface: 'concrete' | 'asphalt',
): { geometry: THREE.BufferGeometry; collider: TrimeshColliderDef } {
  const z0 = centerZ - widthZ * 0.5;
  const z1 = centerZ + widthZ * 0.5;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const pushTri = (
    ax: number, ay: number, az: number, au: number, av: number,
    bx: number, by: number, bz: number, bu: number, bv: number,
    cx: number, cy: number, cz: number, cu: number, cv: number,
  ) => {
    const base = positions.length / 3;
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    uvs.push(au, av, bu, bv, cu, cv);
    indices.push(base, base + 1, base + 2);
  };

  let runLen = 0;
  for (let i = 0; i < profile.length - 1; i++) {
    const [x0, y0] = profile[i];
    const [x1, y1] = profile[i + 1];
    const segLen = Math.hypot(x1 - x0, y1 - y0);
    const v0 = runLen / 4;
    const v1 = (runLen + segLen) / 4;
    runLen += segLen;

    // Top driveable face (CCW outward normal: +Y / -X facing approach).
    pushTri(x0, y0, z0, 0, v0, x0, y0, z1, widthZ / 4, v0, x1, y1, z0, 0, v1);
    pushTri(x1, y1, z0, 0, v1, x0, y0, z1, widthZ / 4, v0, x1, y1, z1, widthZ / 4, v1);

    // Side wall at z0 (-Z outward).
    if (y0 > 0.001 || y1 > 0.001) {
      pushTri(x0, 0, z0, x0 / 4, 0, x0, y0, z0, x0 / 4, y0 / 4, x1, 0, z0, x1 / 4, 0);
      pushTri(x1, 0, z0, x1 / 4, 0, x0, y0, z0, x0 / 4, y0 / 4, x1, y1, z0, x1 / 4, y1 / 4);

      // Side wall at z1 (+Z outward).
      pushTri(x0, 0, z1, x0 / 4, 0, x1, 0, z1, x1 / 4, 0, x0, y0, z1, x0 / 4, y0 / 4);
      pushTri(x1, 0, z1, x1 / 4, 0, x1, y1, z1, x1 / 4, y1 / 4, x0, y0, z1, x0 / 4, y0 / 4);
    }
  }

  // Close vertical end caps if elevated.
  const [xStart, yStart] = profile[0];
  if (yStart > 0.005) {
    // -X outward cap
    pushTri(xStart, 0, z0, 0, 0, xStart, 0, z1, widthZ / 4, 0, xStart, yStart, z0, 0, yStart / 4);
    pushTri(xStart, 0, z1, widthZ / 4, 0, xStart, yStart, z1, widthZ / 4, yStart / 4, xStart, yStart, z0, 0, yStart / 4);
  }
  const [xEnd, yEnd] = profile[profile.length - 1];
  if (yEnd > 0.005) {
    // +X outward cap
    pushTri(xEnd, 0, z0, 0, 0, xEnd, yEnd, z0, 0, yEnd / 4, xEnd, 0, z1, widthZ / 4, 0);
    pushTri(xEnd, 0, z1, widthZ / 4, 0, xEnd, yEnd, z0, 0, yEnd / 4, xEnd, yEnd, z1, widthZ / 4, yEnd / 4);
  }

  const vertices = new Float32Array(positions);
  const indexArray = new Uint32Array(indices);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
  geometry.computeVertexNormals();

  const collider: TrimeshColliderDef = {
    type: 'trimesh',
    id,
    tag,
    surface,
    friction: 0.9,
    restitution: 0.05,
    vertices: new Float32Array(vertices),
    indices: new Uint32Array(indexArray),
  };

  return { geometry, collider };
}

/**
 * Builds all roadside buildings, Blend Garage Exterior, Crash-Test & Stunt Proving Grounds obstacles,
 * highway overhead gantries, instanced trees/boulders/streetlamps/guardrails/cones, and returns their
 * exact matching physics colliders.
 */
export function buildWorldProps(
  network: RoadNetwork,
  terrain: TerrainData,
  textures: WorldTextures,
): WorldPropsResult {
  const group = new THREE.Group();
  group.name = 'world-props';
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const colliders: WorldColliderDef[] = [];

  const trackMat = <T extends THREE.Material>(m: T): T => {
    materials.push(m);
    return m;
  };
  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    geometries.push(g);
    return g;
  };

  // --- Shared Materials ---
  const concreteMat = trackMat(new THREE.MeshStandardMaterial({ name: 'concrete', map: textures.concrete, roughness: 0.88, metalness: 0.04 }));
  const hazardMat = trackMat(new THREE.MeshStandardMaterial({ name: 'hazard', map: textures.hazard, roughness: 0.58, metalness: 0.08 }));
  const corrugatedMat = trackMat(new THREE.MeshStandardMaterial({ name: 'corrugated', map: textures.corrugated, color: 0xb9c0c8, roughness: 0.62, metalness: 0.35 }));
  const facadeMat = trackMat(new THREE.MeshStandardMaterial({ name: 'facade', map: textures.buildingFacade, roughness: 0.55, metalness: 0.25 }));
  const steelDarkMat = trackMat(new THREE.MeshStandardMaterial({ name: 'steel-dark', color: 0x2a3038, roughness: 0.48, metalness: 0.68 }));
  const steelGalvMat = trackMat(new THREE.MeshStandardMaterial({ name: 'steel-galv', color: 0x9aa2ab, roughness: 0.42, metalness: 0.78 }));
  const accentAmberMat = trackMat(new THREE.MeshStandardMaterial({ name: 'accent-amber', color: 0xe5a823, roughness: 0.44, metalness: 0.18 }));
  const roofDarkMat = trackMat(new THREE.MeshStandardMaterial({ name: 'roof-dark', color: 0x353b44, roughness: 0.78, metalness: 0.2 }));
  const glassMat = trackMat(new THREE.MeshStandardMaterial({ name: 'arch-glass', color: 0x628fb2, roughness: 0.16, metalness: 0.45 }));
  const coneOrangeMat = trackMat(new THREE.MeshStandardMaterial({ name: 'cone-orange', color: 0xf96316, roughness: 0.52, metalness: 0.04 }));
  const lampGlowMat = trackMat(new THREE.MeshStandardMaterial({ name: 'lamp-glow', color: 0xfff3d4, emissive: 0xffd996, emissiveIntensity: 1.6, roughness: 0.3 }));

  const barkMat = trackMat(new THREE.MeshStandardMaterial({ name: 'tree-bark', color: 0x5c4432, roughness: 0.94 }));
  const pineMat = trackMat(new THREE.MeshStandardMaterial({ name: 'pine-foliage', color: 0x2f5935, roughness: 0.88 }));
  const oakMat = trackMat(new THREE.MeshStandardMaterial({ name: 'oak-foliage', color: 0x4b7738, roughness: 0.86 }));
  const boulderMat = trackMat(new THREE.MeshStandardMaterial({ name: 'boulder-rock', color: 0x77736b, roughness: 0.94 }));

  const batcher = new MeshBatcher();
  batcher.useWorldUv(concreteMat, 4);
  batcher.useWorldUv(hazardMat, 2.6);
  batcher.useWorldUv(corrugatedMat, 5);

  const addSolidBox = (
    id: string,
    tag: string,
    surface: BoxColliderDef['surface'],
    w: number,
    h: number,
    d: number,
    cx: number,
    cy: number,
    cz: number,
    yaw = 0,
  ) => {
    const col: BoxColliderDef = {
      type: 'box',
      id,
      tag,
      surface,
      position: [cx, cy, cz],
      halfExtents: [w * 0.5, h * 0.5, d * 0.5],
      friction: surface === 'metal' ? 0.45 : 0.75,
      restitution: 0.08,
    };
    if (Math.abs(yaw) > 1e-4) col.euler = [0, yaw, 0];
    colliders.push(col);
  };

  // -------------------------------------------------------------------------
  // 1. BLEND GARAGE EXTERIOR FLAGSHIP BUILDING (behind spawn at Z = -34)
  // -------------------------------------------------------------------------
  {
    const gx = 0;
    const gz = -34;
    const gw = 44;
    const gh = 10.5;
    const gd = 20;

    // Main workshop shell + corrugated upper fascia + roof parapet.
    batcher.slab(corrugatedMat, gw, gh, gd, gx, 0, gz);
    batcher.slab(steelDarkMat, gw + 1.2, 1.3, gd + 1.2, gx, gh, gz);
    batcher.slab(accentAmberMat, gw + 1.4, 0.45, gd + 1.4, gx, gh - 0.55, gz);

    // Front workshop bay facade facing +Z toward the Spawn Plaza.
    batcher.slab(facadeMat, gw - 2, 7.6, 0.4, gx, 0, gz + gd * 0.5 + 0.12);

    // Cantilevered entrance canopy over the bays.
    batcher.slab(steelDarkMat, 36, 0.55, 5.5, gx, 5.4, gz + gd * 0.5 + 2.7);
    for (const px of [-16, -5.5, 5.5, 16]) {
      batcher.slab(steelDarkMat, 0.45, 5.4, 0.45, px, 0, gz + gd * 0.5 + 5.1);
    }

    // Illuminated Blend Garage header sign on top of the front fascia.
    const signMat = trackMat(new THREE.MeshStandardMaterial({ map: textures.signs.garageHeader, roughness: 0.4, metalness: 0.15 }));
    const signGeo = trackGeo(new THREE.PlaneGeometry(18, 4.2));
    const signMesh = new THREE.Mesh(signGeo, signMat);
    signMesh.position.set(gx, 9.2, gz + gd * 0.5 + 0.75);
    signMesh.updateMatrix();
    signMesh.matrixAutoUpdate = false;
    group.add(signMesh);

    addSolidBox('building-blend-garage', 'building', 'concrete', gw, gh + 1.5, gd, gx, (gh + 1.5) * 0.5, gz);

    // Side Service Canopy (west side of plaza at X = -34, Z = -14).
    batcher.slab(steelDarkMat, 14, 0.6, 18, -34, 4.9, -14);
    batcher.slab(accentAmberMat, 14.3, 0.3, 18.3, -34, 5.5, -14);
    for (const px of [-40, -28]) {
      for (const pz of [-21, -7]) {
        batcher.slab(steelDarkMat, 0.55, 4.9, 0.55, px, 0, pz);
        addSolidBox(`canopy-col-${px}-${pz}`, 'pillar', 'metal', 0.65, 4.9, 0.65, px, 2.45, pz);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 2. CRASH-TEST & STUNT PROVING GROUNDS (X: 74..242, Z: -78..124)
  // -------------------------------------------------------------------------
  {
    // (a) Main Frontal Crash Impact Wall at X = 208, Z = +20.
    batcher.slab(concreteMat, 2.6, 3.4, 14.4, 208, 0, 20);
    // Hazard-striped impact face facing oncoming traffic (-X).
    batcher.slab(hazardMat, 0.16, 3.1, 13.8, 206.64, 0.15, 20);
    // Heavy rear concrete buttresses.
    for (const bz of [14.5, 20, 25.5]) {
      batcher.slab(concreteMat, 3.2, 2.4, 1.1, 210.8, 0, bz);
    }
    addSolidBox('pg-main-crash-wall', 'wall', 'concrete', 2.8, 3.4, 14.4, 208, 1.7, 20);

    // Impact Wall overhead sign.
    const wallSignMat = trackMat(new THREE.MeshStandardMaterial({ map: textures.signs.impactWallSign, roughness: 0.45 }));
    const wallSign = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(7.2, 3.4)), wallSignMat);
    wallSign.position.set(206.5, 5.4, 20);
    wallSign.rotation.y = -Math.PI / 2;
    wallSign.updateMatrix();
    wallSign.matrixAutoUpdate = false;
    group.add(wallSign);
    batcher.slab(steelDarkMat, 0.3, 4.2, 0.3, 207.2, 3.2, 16.8);
    batcher.slab(steelDarkMat, 0.3, 4.2, 0.3, 207.2, 3.2, 23.2);

    // (b) Offset Small-Overlap Concrete Barrier Block at X = 208, Z = +52.
    batcher.slab(concreteMat, 2.6, 2.8, 4.8, 208, 0, 52);
    batcher.slab(hazardMat, 0.16, 2.5, 4.4, 206.64, 0.15, 52);
    addSolidBox('pg-offset-crash-wall', 'wall', 'concrete', 2.8, 2.8, 4.8, 208, 1.4, 52);

    // (c) 3 Heavy Hazard-Striped Crash-Test Steel/Concrete Pillars (Pole Impact Test Zone).
    const pillarCoords: readonly [number, number][] = [
      [154, 44],
      [174, 57],
      [191, 46],
    ];
    for (let i = 0; i < pillarCoords.length; i++) {
      const [px, pz] = pillarCoords[i];
      batcher.cyl(hazardMat, 0.56, 3.6, px, 1.8, pz, 'y', { segments: 18 });
      batcher.cyl(steelDarkMat, 0.72, 0.25, px, 0.125, pz, 'y', { segments: 18 });
      batcher.cyl(accentAmberMat, 0.6, 0.18, px, 3.65, pz, 'y', { segments: 18 });
      const cylCol: CylinderColliderDef = {
        type: 'cylinder',
        id: `pg-crash-pillar-${i}`,
        tag: 'pillar',
        surface: 'metal',
        position: [px, 1.8, pz],
        radius: 0.58,
        halfHeight: 1.8,
        friction: 0.5,
        restitution: 0.12,
      };
      colliders.push(cylCol);
    }

    // (d) Smooth Curved Stunt Launch Ramp + Landing Wedge at Z = -24.
    const launchProfile: [number, number][] = [];
    const launchSteps = 10;
    const launchStart = 104;
    const launchLen = 22;
    const launchHeight = 2.85;
    for (let i = 0; i <= launchSteps; i++) {
      const t = i / launchSteps;
      // Gentle lead-in curve so low-slung supercars glide smoothly without nose scrape.
      launchProfile.push([launchStart + t * launchLen, launchHeight * Math.pow(t, 1.42)]);
    }
    const launchBuilt = buildProfilePrism(launchProfile, -24, 10.4, 'pg-launch-ramp', 'ramp', 'concrete');
    trackGeo(launchBuilt.geometry);
    const launchMesh = new THREE.Mesh(launchBuilt.geometry, concreteMat);
    launchMesh.name = 'pg-launch-ramp';
    launchMesh.castShadow = true;
    launchMesh.receiveShadow = true;
    launchMesh.matrixAutoUpdate = false;
    group.add(launchMesh);
    colliders.push(launchBuilt.collider);

    // Hazard stripe trim along launch ramp top edges.
    batcher.slab(hazardMat, 0.4, launchHeight + 0.12, 10.6, launchStart + launchLen + 0.18, 0, -24);

    // Landing down-ramp (X = 148 -> 178) so airtime lands butter-smoothly.
    const landProfile: [number, number][] = [
      [148, 2.25],
      [152, 2.25],
      [165, 1.1],
      [178, 0.0],
    ];
    const landBuilt = buildProfilePrism(landProfile, -24, 11.4, 'pg-landing-ramp', 'ramp', 'concrete');
    trackGeo(landBuilt.geometry);
    const landMesh = new THREE.Mesh(landBuilt.geometry, concreteMat);
    landMesh.name = 'pg-landing-ramp';
    landMesh.castShadow = true;
    landMesh.receiveShadow = true;
    landMesh.matrixAutoUpdate = false;
    group.add(landMesh);
    colliders.push(landBuilt.collider);

    // Ramp directional sign beside approach.
    const rampSignMat = trackMat(new THREE.MeshStandardMaterial({ map: textures.signs.rampSign, roughness: 0.45 }));
    const rampSign = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(4.4, 2.2)), rampSignMat);
    rampSign.position.set(100, 3.0, -32);
    rampSign.rotation.y = -Math.PI / 2;
    rampSign.updateMatrix();
    rampSign.matrixAutoUpdate = false;
    group.add(rampSign);
    batcher.slab(steelDarkMat, 0.22, 3.2, 0.22, 100.15, 0, -32);

    // (e) Suspension Rumble & Speed-Bump Strip at Z = -56.
    // 8 smooth full-width speed bumps + 6 staggered left/right wheel articulation bumps,
    // combined into one single mesh and one combined TrimeshColliderDef.
    const bumpSpecs: { x: number; z: number; w: number; h: number }[] = [];
    for (let i = 0; i < 8; i++) {
      bumpSpecs.push({ x: 102 + i * 8.5, z: -56, w: 9.6, h: 0.15 });
    }
    for (let i = 0; i < 6; i++) {
      bumpSpecs.push({ x: 172 + i * 5.2, z: i % 2 === 0 ? -53.8 : -58.2, w: 4.4, h: 0.18 });
    }

    const bumpVerts: number[] = [];
    const bumpUvs: number[] = [];
    const bumpIndices: number[] = [];
    let bumpVertOffset = 0;
    for (let i = 0; i < bumpSpecs.length; i++) {
      const b = bumpSpecs[i];
      const profile: [number, number][] = [
        [b.x - 1.2, 0],
        [b.x - 0.45, b.h],
        [b.x + 0.45, b.h],
        [b.x + 1.2, 0],
      ];
      const built = buildProfilePrism(profile, b.z, b.w, `pg-bump-${i}`, 'bump', 'asphalt');
      const posArr = built.geometry.attributes.position.array as Float32Array;
      const uvArr = built.geometry.attributes.uv.array as Float32Array;
      const idxArr = built.collider.indices;
      for (let k = 0; k < posArr.length; k++) bumpVerts.push(posArr[k]);
      for (let k = 0; k < uvArr.length; k++) bumpUvs.push(uvArr[k]);
      for (let k = 0; k < idxArr.length; k++) bumpIndices.push(idxArr[k] + bumpVertOffset);
      bumpVertOffset += posArr.length / 3;
      built.geometry.dispose();
    }

    const combinedBumpVerts = new Float32Array(bumpVerts);
    const combinedBumpIdx = new Uint32Array(bumpIndices);
    const combinedBumpGeo = trackGeo(new THREE.BufferGeometry());
    combinedBumpGeo.setAttribute('position', new THREE.BufferAttribute(combinedBumpVerts, 3));
    combinedBumpGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(bumpUvs), 2));
    combinedBumpGeo.setIndex(new THREE.BufferAttribute(combinedBumpIdx, 1));
    combinedBumpGeo.computeVertexNormals();

    const bumpMesh = new THREE.Mesh(combinedBumpGeo, hazardMat);
    bumpMesh.name = 'pg-suspension-bumps';
    bumpMesh.receiveShadow = true;
    bumpMesh.matrixAutoUpdate = false;
    group.add(bumpMesh);

    colliders.push({
      type: 'trimesh',
      id: 'pg-suspension-bumps',
      tag: 'bump',
      surface: 'asphalt',
      friction: 0.9,
      restitution: 0.04,
      vertices: new Float32Array(combinedBumpVerts),
      indices: new Uint32Array(combinedBumpIdx),
    });

    // (f) Slalom Chicane Jersey Barriers at Z = +88 (5 alternating chicane gates).
    const slalomXs = [106, 130, 154, 178, 202];
    for (let i = 0; i < slalomXs.length; i++) {
      const bx = slalomXs[i];
      const bz = i % 2 === 0 ? 82.5 : 93.5;
      batcher.slab(concreteMat, 1.0, 1.1, 7.6, bx, 0, bz);
      batcher.slab(hazardMat, 1.06, 0.22, 7.64, bx, 0.88, bz);
      addSolidBox(`pg-slalom-barrier-${i}`, 'barrier', 'concrete', 1.05, 1.15, 7.65, bx, 0.575, bz);
    }

    const slalomSignMat = trackMat(new THREE.MeshStandardMaterial({ map: textures.signs.slalomSign, roughness: 0.45 }));
    const slalomSign = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(4.4, 2.2)), slalomSignMat);
    slalomSign.position.set(92, 3.0, 74);
    slalomSign.rotation.y = -Math.PI / 2;
    slalomSign.updateMatrix();
    slalomSign.matrixAutoUpdate = false;
    group.add(slalomSign);
    batcher.slab(steelDarkMat, 0.22, 3.2, 0.22, 92.15, 0, 74);

    // (g) Crash Test Lab & Observation Tower at X = 229, Z = -24.
    batcher.slab(corrugatedMat, 18, 9.5, 36, 229, 0, -24);
    batcher.slab(steelDarkMat, 18.8, 1.1, 36.8, 229, 9.5, -24);
    // Glazed observation deck overlooking the ramp & crash wall.
    batcher.slab(glassMat, 7.5, 3.4, 14, 222.5, 10.6, -24);
    batcher.slab(roofDarkMat, 8.6, 0.7, 15.2, 222.5, 14.0, -24);
    addSolidBox('building-crash-lab', 'building', 'concrete', 18.4, 11, 36.4, 229, 5.5, -24);

    const labSignMat = trackMat(new THREE.MeshStandardMaterial({ map: textures.signs.crashLabBanner, roughness: 0.4 }));
    const labSign = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(16, 3.8)), labSignMat);
    labSign.position.set(219.7, 7.6, -24);
    labSign.rotation.y = -Math.PI / 2;
    labSign.updateMatrix();
    labSign.matrixAutoUpdate = false;
    group.add(labSign);

    // Proving Grounds North perimeter concrete barrier wall (Z = -74, X = 80..236).
    batcher.slab(concreteMat, 156, 1.35, 1.0, 158, 0, -74.5);
    addSolidBox('pg-north-wall', 'barrier', 'concrete', 156, 1.4, 1.1, 158, 0.7, -74.5);
  }

  // -------------------------------------------------------------------------
  // 3. ROADSIDE BUILDINGS & HIGHWAY SERVICE STATION
  // -------------------------------------------------------------------------
  {
    // Highway Service Station & Pit Canopy along South Straightaway (X = -125, Z = 224).
    batcher.slab(corrugatedMat, 22, 6.4, 11, -125, 0, 214);
    batcher.slab(facadeMat, 20, 5.2, 0.35, -125, 0, 219.6);
    batcher.slab(steelDarkMat, 26, 0.7, 11, -125, 5.2, 232);
    batcher.slab(accentAmberMat, 26.4, 0.35, 11.4, -125, 5.9, 232);
    for (const px of [-135, -125, -115]) {
      batcher.slab(steelDarkMat, 0.55, 5.2, 0.55, px, 0, 232);
      addSolidBox(`service-col-${px}`, 'pillar', 'metal', 0.65, 5.2, 0.65, px, 2.6, 232);
    }
    addSolidBox('building-service-station', 'building', 'concrete', 22.4, 6.8, 11.4, -125, 3.4, 214);

    // Two industrial warehouses framing the valley landscape.
    const warehouses: readonly { id: string; x: number; z: number; w: number; h: number; d: number; yaw: number }[] = [
      { id: 'warehouse-east', x: 295, z: 165, w: 30, h: 10, d: 18, yaw: 0 },
      { id: 'warehouse-west', x: -190, z: 155, w: 28, h: 9.2, d: 18, yaw: 0.12 },
    ];
    for (const wh of warehouses) {
      const groundY = terrain.sampleHeight(wh.x, wh.z);
      batcher.at(wh.x, groundY, wh.z, wh.yaw, () => {
        batcher.slab(corrugatedMat, wh.w, wh.h, wh.d, 0, -0.8, 0);
        batcher.slab(roofDarkMat, wh.w + 0.8, 0.8, wh.d + 0.8, 0, wh.h - 0.8, 0);
        batcher.slab(accentAmberMat, wh.w + 0.9, 0.35, wh.d + 0.9, 0, wh.h - 1.4, 0);
      });
      addSolidBox(wh.id, 'building', 'concrete', wh.w, wh.h, wh.d, wh.x, groundY + wh.h * 0.5 - 0.8, wh.z, wh.yaw);
    }
  }

  // -------------------------------------------------------------------------
  // 4. OVERHEAD HIGHWAY & DIRECTIONAL SIGN GANTRIES
  // -------------------------------------------------------------------------
  const addSignGantry = (
    id: string,
    cx: number,
    cz: number,
    yaw: number,
    span: number,
    signTex: THREE.Texture,
    doubleSided = false,
  ) => {
    const baseY = terrain.sampleHeight(cx, cz);
    const clearance = 6.8;
    const halfSpan = span * 0.5;

    batcher.at(cx, baseY, cz, yaw, () => {
      // Left & right steel support towers outside the road.
      batcher.slab(steelGalvMat, 0.55, clearance + 1.8, 0.55, -halfSpan, -0.3, 0);
      batcher.slab(steelGalvMat, 0.55, clearance + 1.8, 0.55, halfSpan, -0.3, 0);
      // Overhead steel truss beam.
      batcher.slab(steelGalvMat, span + 1.0, 0.55, 0.55, 0, clearance + 0.6, 0);
      batcher.slab(steelGalvMat, span + 1.0, 0.35, 0.35, 0, clearance + 1.4, 0);
    });

    // Sign board facing local -Z (towards approaching driver when yaw aligns with approach) and optionally +Z.
    const sMat = trackMat(new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.42, metalness: 0.1 }));
    const sGeo = trackGeo(new THREE.PlaneGeometry(Math.min(13, span * 0.65), 3.1));
    const front = new THREE.Mesh(sGeo, sMat);
    front.position.set(cx, baseY + clearance + 1.0, cz);
    front.rotation.y = yaw + Math.PI;
    front.translateZ(0.36);
    front.updateMatrix();
    front.matrixAutoUpdate = false;
    group.add(front);

    if (doubleSided) {
      const back = new THREE.Mesh(sGeo, sMat);
      back.position.set(cx, baseY + clearance + 1.0, cz);
      back.rotation.y = yaw;
      back.translateZ(0.36);
      back.updateMatrix();
      back.matrixAutoUpdate = false;
      group.add(back);
    }

    // Colliders ONLY on the two side support legs (roadway remains 100% clear!).
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    for (const side of [-1, 1]) {
      const lx = cx + side * halfSpan * cos;
      const lz = cz - side * halfSpan * sin;
      addSolidBox(`${id}-leg-${side > 0 ? 'L' : 'R'}`, 'pillar', 'metal', 0.75, clearance + 1.8, 0.75, lx, baseY + (clearance + 1.8) * 0.5, lz, yaw);
    }
  };

  // Plaza -> Highway gantry (visible straight ahead from spawn!).
  addSignGantry('gantry-plaza-highway', 0, 56, 0, 17.5, textures.signs.highwayGantry, true);
  // Plaza -> Proving Grounds gantry (visible to the front-left / east from spawn!).
  addSignGantry('gantry-plaza-proving', 58, 20, Math.PI / 2, 18.0, textures.signs.provingEntry, true);
  // Plaza -> Canyon Pass gantry (west exit of plaza).
  addSignGantry('gantry-plaza-canyon', -58, 8, -Math.PI / 2, 15.0, textures.signs.canyonEntry, true);
  // Highway South Straightaway overhead gantry.
  addSignGantry('gantry-highway-straight', -20, 260, Math.PI / 2, 21.5, textures.signs.highwayGantry, true);

  // Merge all static architectural & proving-ground geometry into ~10 draw calls!
  const batchedGroup = batcher.build('world-structures', { castShadow: true, receiveShadow: true });
  batchedGroup.traverse((obj) => {
    if (obj instanceof THREE.Mesh) geometries.push(obj.geometry);
  });
  group.add(batchedGroup);

  // -------------------------------------------------------------------------
  // 5. INSTANCED ROADSIDE PROPS (Trees, Boulders, Streetlamps, Guardrails, Cones)
  // -------------------------------------------------------------------------
  const dummy = new THREE.Object3D();

  // --- Guardrails along Main Highway Outer Edge & Canyon Cliff Dropoffs ---
  const railBeamMats: THREE.Matrix4[] = [];
  const railPostMats: THREE.Matrix4[] = [];
  let guardrailColliderIndex = 0;

  for (const road of network.roads) {
    if (road.kind !== 'highway' && road.kind !== 'canyon') continue;
    const samples = road.samples;
    const step = road.kind === 'highway' ? 3 : 2; // ~7-10m rail spans

    for (let i = 0; i < samples.length - step; i += step) {
      const a = samples[i];
      const b = samples[(i + step) % samples.length];
      // Leave clean intersections open where connectors meet the highway.
      if (road.kind === 'highway') {
        if (Math.abs(a.z - 260) < 16 && (Math.abs(a.x) < 20 || Math.abs(a.x - 160) < 20)) continue;
        if (Math.abs(a.x + 405) < 30 && Math.abs(a.z - 15) < 25) continue;
        if (Math.abs(a.x + 260) < 35 && Math.abs(a.z + 245) < 35) continue;
      }

      const segLen = Math.hypot(b.x - a.x, b.z - a.z);
      if (segLen < 2 || segLen > 18) continue;

      const mx = (a.x + b.x) * 0.5;
      const my = (a.y + b.y) * 0.5;
      const mz = (a.z + b.z) * 0.5;
      const yaw = Math.atan2(b.x - a.x, b.z - a.z);
      const lx = (b.z - a.z) / segLen;
      const lz = -(b.x - a.x) / segLen;

      // On highway: place guardrail along outer edge (-1 = outside of loop) so valley connectors stay open.
      // On canyon: place along elevated sections (> 3.5m) on both outer cliff sides.
      const sides = road.kind === 'highway' ? [-1] : a.y > 3.5 ? [-1, 1] : [];
      for (const side of sides) {
        const offset = (road.halfWidth + 0.85) * side;
        const rx = mx + lx * offset;
        const rz = mz + lz * offset;

        // Skip if overlapping another road or flat pad.
        const q = network.query(rx, rz);
        if (q.onRoad) continue;

        // W-beam rail
        dummy.position.set(rx, my + 0.62, rz);
        dummy.rotation.set(0, yaw, 0);
        dummy.scale.set(0.14, 0.34, segLen + 0.15);
        dummy.updateMatrix();
        railBeamMats.push(dummy.matrix.clone());

        // Support post at start of segment
        dummy.position.set(a.x + lx * offset, a.y + 0.38, a.z + lz * offset);
        dummy.rotation.set(0, yaw, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        railPostMats.push(dummy.matrix.clone());

        // Add matching static guardrail collider for every span!
        addSolidBox(
          `guardrail-${guardrailColliderIndex++}`,
          'barrier',
          'metal',
          0.35,
          0.95,
          segLen + 0.1,
          rx,
          my + 0.48,
          rz,
          yaw,
        );
      }
    }
  }

  if (railBeamMats.length > 0) {
    const beamGeo = trackGeo(new THREE.BoxGeometry(1, 1, 1));
    const beamInst = new THREE.InstancedMesh(beamGeo, steelGalvMat, railBeamMats.length);
    beamInst.name = 'inst-guardrail-beams';
    beamInst.castShadow = true;
    beamInst.receiveShadow = true;
    railBeamMats.forEach((m, i) => beamInst.setMatrixAt(i, m));
    beamInst.instanceMatrix.needsUpdate = true;
    group.add(beamInst);

    const postGeo = trackGeo(new THREE.BoxGeometry(0.12, 0.85, 0.12));
    const postInst = new THREE.InstancedMesh(postGeo, steelDarkMat, railPostMats.length);
    postInst.name = 'inst-guardrail-posts';
    railPostMats.forEach((m, i) => postInst.setMatrixAt(i, m));
    postInst.instanceMatrix.needsUpdate = true;
    group.add(postInst);
  }

  // --- Streetlamps lining Plaza, Proving Grounds, and Highway South Straightaway ---
  const lampTransforms: { x: number; y: number; z: number; yaw: number }[] = [];
  // Highway South Straightaway both sides.
  for (let x = -280; x <= 280; x += 38) {
    if (Math.abs(x) < 16 || Math.abs(x - 160) < 16) continue;
    lampTransforms.push({ x, y: 0, z: 249.5, yaw: 0 });
    lampTransforms.push({ x, y: 0, z: 270.5, yaw: Math.PI });
  }
  // Plaza & Connector lamps.
  for (let z = 68; z <= 232; z += 34) {
    lampTransforms.push({ x: -9.5, y: 0, z, yaw: Math.PI / 2 });
    lampTransforms.push({ x: 9.5, y: 0, z, yaw: -Math.PI / 2 });
  }
  // Proving Grounds perimeter floodlamps.
  for (const x of [95, 145, 195]) {
    lampTransforms.push({ x, y: 0, z: -72, yaw: 0 });
    lampTransforms.push({ x, y: 0, z: 118, yaw: Math.PI });
  }

  if (lampTransforms.length > 0) {
    const poleGeo = trackGeo(new THREE.CylinderGeometry(0.09, 0.14, 7.6, 8));
    poleGeo.translate(0, 3.8, 0);
    const armGeo = trackGeo(new THREE.BoxGeometry(0.12, 0.12, 1.9));
    armGeo.translate(0, 7.55, 0.9);
    const headGeo = trackGeo(new THREE.BoxGeometry(0.38, 0.12, 0.72));
    headGeo.translate(0, 7.46, 1.75);

    const poleInst = new THREE.InstancedMesh(poleGeo, steelDarkMat, lampTransforms.length);
    const armInst = new THREE.InstancedMesh(armGeo, steelDarkMat, lampTransforms.length);
    const headInst = new THREE.InstancedMesh(headGeo, lampGlowMat, lampTransforms.length);
    poleInst.name = 'inst-lamp-poles';
    armInst.name = 'inst-lamp-arms';
    headInst.name = 'inst-lamp-heads';

    lampTransforms.forEach((l, i) => {
      dummy.position.set(l.x, l.y, l.z);
      dummy.rotation.set(0, l.yaw, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      poleInst.setMatrixAt(i, dummy.matrix);
      armInst.setMatrixAt(i, dummy.matrix);
      headInst.setMatrixAt(i, dummy.matrix);
    });
    poleInst.instanceMatrix.needsUpdate = true;
    armInst.instanceMatrix.needsUpdate = true;
    headInst.instanceMatrix.needsUpdate = true;
    group.add(poleInst, armInst, headInst);
  }

  // --- Instanced Traffic Cones framing Proving Grounds lanes & Slalom Gates ---
  const conePositions: [number, number][] = [];
  // Flanking slalom chicane edges.
  for (let x = 96; x <= 212; x += 12) {
    conePositions.push([x, 76.4], [x, 99.6]);
  }
  // Flanking impact wall runway entry.
  for (let x = 96; x <= 186; x += 18) {
    conePositions.push([x, 12.6], [x, 27.4]);
  }
  // Flanking launch ramp entry.
  for (let x = 88; x <= 102; x += 7) {
    conePositions.push([x, -30.4], [x, -17.6]);
  }
  if (conePositions.length > 0) {
    const coneGeo = trackGeo(new THREE.ConeGeometry(0.24, 0.76, 10));
    coneGeo.translate(0, 0.38, 0);
    const coneInst = new THREE.InstancedMesh(coneGeo, coneOrangeMat, conePositions.length);
    coneInst.name = 'inst-traffic-cones';
    conePositions.forEach(([x, z], i) => {
      dummy.position.set(x, 0, z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      coneInst.setMatrixAt(i, dummy.matrix);
    });
    coneInst.instanceMatrix.needsUpdate = true;
    group.add(coneInst);
  }

  // --- Instanced Trees (Pines & Deciduous) + Canyon Boulders ---
  const rand = seededRandom(4242);
  const pineList: { x: number; y: number; z: number; s: number; yaw: number }[] = [];
  const oakList: { x: number; y: number; z: number; s: number; yaw: number }[] = [];
  const boulderList: { x: number; y: number; z: number; sx: number; sy: number; sz: number; rx: number; ry: number }[] = [];

  const isClearOfBuildings = (x: number, z: number): boolean => {
    if (x > -60 && x < 60 && z > -58 && z < 56) return false; // Plaza
    if (x > 68 && x < 248 && z > -82 && z < 128) return false; // Proving grounds
    if (x > -150 && x < -100 && z > 202 && z < 245) return false; // Service station
    if (x > 272 && x < 318 && z > 148 && z < 182) return false; // East warehouse
    if (x > -212 && x < -168 && z > 138 && z < 172) return false; // West warehouse
    return true;
  };

  // Scatter ~290 pines (preferring canyon slopes, valley edges, and mountain foothills).
  for (let attempt = 0; attempt < 1100 && pineList.length < 290; attempt++) {
    const x = (rand() * 2 - 1) * 510;
    const z = (rand() * 2 - 1) * 510;
    if (!isClearOfBuildings(x, z)) continue;
    const q = network.query(x, z);
    if (q.distance < 10.5) continue;
    const y = terrain.sampleHeight(x, z);
    if (y > 46) continue;
    pineList.push({ x, y: y - 0.15, z, s: 0.8 + rand() * 0.85, yaw: rand() * Math.PI * 2 });
  }

  // Scatter ~120 valley deciduous trees (lower elevations near meadows & plaza perimeter).
  for (let attempt = 0; attempt < 600 && oakList.length < 120; attempt++) {
    const x = (rand() * 2 - 1) * 440;
    const z = (rand() * 2 - 1) * 440;
    if (!isClearOfBuildings(x, z)) continue;
    const q = network.query(x, z);
    if (q.distance < 11.5) continue;
    const y = terrain.sampleHeight(x, z);
    if (y > 14) continue;
    oakList.push({ x, y: y - 0.15, z, s: 0.85 + rand() * 0.75, yaw: rand() * Math.PI * 2 });
  }

  // Scatter ~125 canyon boulders & roadside rock outcrops.
  for (let attempt = 0; attempt < 650 && boulderList.length < 125; attempt++) {
    const x = (rand() * 2 - 1) * 500;
    const z = (rand() * 2 - 1) * 500;
    if (!isClearOfBuildings(x, z)) continue;
    const q = network.query(x, z);
    if (q.distance < 8.5) continue;
    const y = terrain.sampleHeight(x, z);
    if (y < 2.2 && rand() < 0.72) continue; // Bias boulders onto hills & canyon cuts
    const base = 1.1 + rand() * 2.8;
    boulderList.push({
      x,
      y: y - base * 0.25,
      z,
      sx: base * (0.8 + rand() * 0.6),
      sy: base * (0.55 + rand() * 0.55),
      sz: base * (0.8 + rand() * 0.6),
      rx: rand() * Math.PI,
      ry: rand() * Math.PI * 2,
    });
  }

  if (pineList.length > 0) {
    const trunkGeo = trackGeo(new THREE.CylinderGeometry(0.22, 0.38, 3.2, 7));
    trunkGeo.translate(0, 1.6, 0);
    const tier1Geo = trackGeo(new THREE.ConeGeometry(2.35, 5.2, 8));
    tier1Geo.translate(0, 4.8, 0);
    const tier2Geo = trackGeo(new THREE.ConeGeometry(1.75, 4.4, 8));
    tier2Geo.translate(0, 7.6, 0);

    const trunkInst = new THREE.InstancedMesh(trunkGeo, barkMat, pineList.length);
    const t1Inst = new THREE.InstancedMesh(tier1Geo, pineMat, pineList.length);
    const t2Inst = new THREE.InstancedMesh(tier2Geo, pineMat, pineList.length);
    trunkInst.name = 'inst-pine-trunks';
    t1Inst.name = 'inst-pine-lower';
    t2Inst.name = 'inst-pine-upper';
    t1Inst.castShadow = true;
    t2Inst.castShadow = true;

    pineList.forEach((p, i) => {
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, p.yaw, 0);
      dummy.scale.set(p.s, p.s, p.s);
      dummy.updateMatrix();
      trunkInst.setMatrixAt(i, dummy.matrix);
      t1Inst.setMatrixAt(i, dummy.matrix);
      t2Inst.setMatrixAt(i, dummy.matrix);
    });
    trunkInst.instanceMatrix.needsUpdate = true;
    t1Inst.instanceMatrix.needsUpdate = true;
    t2Inst.instanceMatrix.needsUpdate = true;
    group.add(trunkInst, t1Inst, t2Inst);
  }

  if (oakList.length > 0) {
    const trunkGeo = trackGeo(new THREE.CylinderGeometry(0.26, 0.42, 3.4, 7));
    trunkGeo.translate(0, 1.7, 0);
    const crownGeo = trackGeo(new THREE.DodecahedronGeometry(2.75, 1));
    crownGeo.translate(0, 5.4, 0);

    const trunkInst = new THREE.InstancedMesh(trunkGeo, barkMat, oakList.length);
    const crownInst = new THREE.InstancedMesh(crownGeo, oakMat, oakList.length);
    trunkInst.name = 'inst-oak-trunks';
    crownInst.name = 'inst-oak-crowns';
    crownInst.castShadow = true;

    oakList.forEach((o, i) => {
      dummy.position.set(o.x, o.y, o.z);
      dummy.rotation.set(0, o.yaw, 0);
      dummy.scale.set(o.s, o.s * 0.92, o.s);
      dummy.updateMatrix();
      trunkInst.setMatrixAt(i, dummy.matrix);
      crownInst.setMatrixAt(i, dummy.matrix);
    });
    trunkInst.instanceMatrix.needsUpdate = true;
    crownInst.instanceMatrix.needsUpdate = true;
    group.add(trunkInst, crownInst);
  }

  if (boulderList.length > 0) {
    const rockGeo = trackGeo(new THREE.DodecahedronGeometry(1.0, 0));
    const rockInst = new THREE.InstancedMesh(rockGeo, boulderMat, boulderList.length);
    rockInst.name = 'inst-boulders';
    rockInst.receiveShadow = true;

    boulderList.forEach((b, i) => {
      dummy.position.set(b.x, b.y, b.z);
      dummy.rotation.set(b.rx, b.ry, 0);
      dummy.scale.set(b.sx, b.sy, b.sz);
      dummy.updateMatrix();
      rockInst.setMatrixAt(i, dummy.matrix);
    });
    rockInst.instanceMatrix.needsUpdate = true;
    group.add(rockInst);
  }

  return { group, geometries, materials, colliders };
}
