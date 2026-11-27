import * as THREE from 'three';
import type { Vec3 } from '@blend-garage/vehicle-core';
import type { WorldColliderDef } from '@blend-garage/world-racing';
import { assembleWorldColliders } from './colliders';
import {
  buildDynamicPropsSystem,
  type DynamicPropKind,
  type DynamicPropsSystem,
  type DynamicPropTransformInput,
  type DynamicWorldPropDef,
} from './dynamicProps';
import { WorldEnvironment } from './environment';
import { WorldFX, type Vec3Like } from './fx';
import { buildWorldProps, type DistanceCullSector } from './props';
import {
  buildRoadVisuals,
  isInsideTunnelCoords,
  RoadNetwork,
  type SpawnName,
  type WorldSpawnPose,
  type WorldSurfaceKind,
} from './roads';
import { buildTerrain, type TerrainData } from './terrain';
import { createWorldTextures, type WorldTextures } from './textures';
import { buildPacificOcean, type OceanWater } from './water';

export type { DynamicPropKind, DynamicPropTransformInput, DynamicWorldPropDef };

export type WorldPointInput = Vec3 | Vec3Like;

export interface WorldCarPoseInput {
  position: WorldPointInput;
  headingRad?: number;
}

export interface WorldSkidInput {
  wheelKey: string;
  contactPoint: WorldPointInput;
  headingRad: number;
  width?: number;
  opacity?: number;
}

export interface WorldFxInputs {
  /** World-space hood position for engine smoke when `engineHealth < 0.6`. */
  hoodWorldPos?: WorldPointInput;
  /** Engine health in 0..1; smoke emits below 0.6. */
  engineHealth?: number;
  /** Active slipping/drifting tire contacts for skidmark quads this frame. */
  skidMarks?: readonly WorldSkidInput[];
}

const _carScratch: Vec3Like = { x: 0, y: 0, z: 0 };
const _hoodScratch: Vec3Like = { x: 0, y: 0, z: 0 };
const _skidScratch: Vec3Like = { x: 0, y: 0, z: 0 };
const _sparkPtScratch: Vec3Like = { x: 0, y: 0, z: 0 };
const _sparkNrmScratch: Vec3Like = { x: 0, y: 0, z: 0 };
const _tunnelScratch: Vec3Like = { x: 0, y: 0, z: 0 };

function writeVec3Like(v: WorldPointInput, out: Vec3Like): Vec3Like {
  if (Array.isArray(v)) {
    out.x = v[0];
    out.y = v[1];
    out.z = v[2];
  } else {
    out.x = v.x;
    out.y = v.y;
    out.z = v.z;
  }
  return out;
}

/**
 * Self-contained pure-TypeScript 2400×2400m Multi-Biome 3D Open World for Blend Garage Drive Mode:
 * - 6 connected California biomes: Blend Garage HQ Plaza, Pacific Coast Highway & Steel-Arch Bridge
 *   with animated ocean surf, Valley Expressway & 280m Illuminated Mountain Tunnel, +64m Redwood &
 *   Alpine Switchbacks, Red-Rock Mesa & Packed-Dirt Rally Loop, and Expanded Airfield Crash & Stunt Park
 * - 6×6 (36) frustum-cullable seamless terrain tiles + bit-exact Rapier heightfield & static colliders
 * - ~88 dynamic knockable rigid-body crash props synced at zero per-frame allocation
 * - Early-Z LUT atmospheric sky dome, car-following 1024px sun shadows, outdoor PMREM & aerial fog
 */
export class OpenWorld {
  readonly group = new THREE.Group();
  readonly roadNetwork: RoadNetwork;

  private textures: WorldTextures | null = null;
  private terrain: TerrainData | null = null;
  private water: OceanWater | null = null;
  private dynamicProps: DynamicPropsSystem | null = null;
  private environment: WorldEnvironment | null = null;
  private fx: WorldFX | null = null;
  private colliders: WorldColliderDef[] = [];
  private cullableSectors: DistanceCullSector[] = [];
  private lastCullX = Number.NaN;
  private lastCullZ = Number.NaN;

  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];
  private mounted = false;
  private disposed = false;

  constructor() {
    this.group.name = 'open-world';
    this.roadNetwork = new RoadNetwork();
  }

  /**
   * Builds and mounts the entire 2400×2400m Open World into `scene`, switching lighting, sky, fog,
   * and PMREM reflections cleanly to golden late-afternoon California daylight.
   */
  mount(scene: THREE.Scene, renderer: THREE.WebGLRenderer): void {
    if (this.mounted || this.disposed) return;
    this.mounted = true;

    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    this.textures = createWorldTextures(maxAniso);

    // 1. Sculpted 6-biome terrain (6x6 frustum-cullable tiles) + distant mountain amphitheater.
    this.terrain = buildTerrain(this.roadNetwork, this.textures);
    this.ownedGeometries.push(...this.terrain.geometries, this.terrain.distantGeometry);
    this.ownedMaterials.push(this.terrain.material, this.terrain.distantMaterial);
    this.group.add(this.terrain.mesh, this.terrain.distantMesh);

    // 2. Animated Pacific Ocean water along western coastline & coastal bridge bay.
    this.water = buildPacificOcean(0xe8d8c4, 0.00062);
    this.group.add(this.water.mesh);

    // 3. Connected road ribbons (expressway, Pacific Coast, Alpine switchbacks, Red-Rock dirt rally).
    const roads = buildRoadVisuals(this.roadNetwork, this.textures);
    this.ownedGeometries.push(...roads.geometries);
    this.ownedMaterials.push(...roads.materials);
    this.group.add(roads.group);

    // 4. Architecture, Steel-Arch Bridge, Illuminated Mountain Tunnel, Stunt Park, Biome Foliage & Props.
    const props = buildWorldProps(this.roadNetwork, this.terrain, this.textures);
    this.ownedGeometries.push(...props.geometries);
    this.ownedMaterials.push(...props.materials);
    this.cullableSectors = props.cullableSectors;
    this.group.add(props.group);

    // 5. Dynamic knockable crash props (barrels, crates, barriers, tire stacks, cones).
    this.dynamicProps = buildDynamicPropsSystem(this.roadNetwork, this.terrain, this.textures);
    this.ownedGeometries.push(...this.dynamicProps.geometries);
    this.ownedMaterials.push(...this.dynamicProps.materials);
    this.group.add(this.dynamicProps.group);

    // 6. Assemble exact static physics colliders matching every visual surface & obstacle.
    this.colliders = assembleWorldColliders(this.terrain, props.colliders);

    // 7. Driving & crash visual FX pools.
    this.fx = new WorldFX(this.textures, (x, z) => this.sampleGroundHeight(x, z));
    this.group.add(this.fx.group);

    // 8. Outdoor daylight sky dome, directional sun, fog & PMREM environment map.
    this.environment = new WorldEnvironment(scene, renderer);
    scene.add(this.group);

    const start = this.getSpawnPoint('start');
    this.updateSectorVisibility(start.position[0], start.position[2], true);
    this.environment.update(start.position[0], start.position[1], start.position[2], 0, start.headingRad);
  }

  /**
   * Advances dynamic world systems (sun shadow frustum tracking, sky clouds, ocean waves,
   * sparks, smoke, skidmarks, and lightweight distance culling of micro ground-cover sectors).
   */
  update(dt: number, carWorldPose: WorldCarPoseInput, fxInputs?: WorldFxInputs): void {
    if (!this.mounted || this.disposed) return;

    const pos = writeVec3Like(carWorldPose.position, _carScratch);
    this.environment?.update(pos.x, pos.y, pos.z, dt, carWorldPose.headingRad);
    this.water?.update(dt);
    this.updateSectorVisibility(pos.x, pos.z, false);

    if (this.fx) {
      if (fxInputs?.hoodWorldPos && typeof fxInputs.engineHealth === 'number') {
        this.fx.updateEngineSmoke(dt, writeVec3Like(fxInputs.hoodWorldPos, _hoodScratch), fxInputs.engineHealth);
      }
      if (fxInputs?.skidMarks) {
        for (let i = 0; i < fxInputs.skidMarks.length; i++) {
          const s = fxInputs.skidMarks[i];
          this.fx.addSkidMark(s.wheelKey, writeVec3Like(s.contactPoint, _skidScratch), s.headingRad, s.width, s.opacity);
        }
      }
      this.fx.update(dt);
    }
  }

  private updateSectorVisibility(x: number, z: number, force: boolean): void {
    const sectors = this.cullableSectors;
    if (sectors.length === 0) return;
    if (!force && Number.isFinite(this.lastCullX)) {
      const dx = x - this.lastCullX;
      const dz = z - this.lastCullZ;
      if (dx * dx + dz * dz < 64) return;
    }
    this.lastCullX = x;
    this.lastCullZ = z;
    for (let i = 0; i < sectors.length; i++) {
      const s = sectors[i];
      const dx = s.cx - x;
      const dz = s.cz - z;
      s.object.visible = dx * dx + dz * dz <= s.maxDistSq;
    }
  }

  /** Triggers a pooled incandescent spark burst at a world crash impact point. */
  emitCrashSparks(worldPoint: WorldPointInput, worldNormal: WorldPointInput, intensity = 1.0): void {
    this.fx?.emitCrashSparks(
      writeVec3Like(worldPoint, _sparkPtScratch),
      writeVec3Like(worldNormal, _sparkNrmScratch),
      intensity,
    );
  }

  /** Appends a tire skidmark segment for a wheel contact point. */
  addSkidMark(
    wheelKey: string,
    worldPos: WorldPointInput,
    headingRad: number,
    width = 0.28,
    opacity = 0.65,
  ): void {
    this.fx?.addSkidMark(wheelKey, writeVec3Like(worldPos, _skidScratch), headingRad, width, opacity);
  }

  /** Emits hood smoke puffs when `engineHealth < 0.6`. */
  updateEngineSmoke(dt: number, hoodWorldPos: WorldPointInput, engineHealth: number): void {
    this.fx?.updateEngineSmoke(dt, writeVec3Like(hoodWorldPos, _hoodScratch), engineHealth);
  }

  /** Clears transient spark/smoke/skid state (useful on car warp or repair). */
  clearFx(): void {
    this.fx?.clear();
    this.environment?.invalidateShadows();
    this.lastCullX = Number.NaN;
    this.lastCullZ = Number.NaN;
  }

  /** Returns all static physics colliders matching `@blend-garage/world-racing`'s `WorldColliderDef[]`. */
  getColliders(): WorldColliderDef[] {
    return this.colliders;
  }

  /** Returns all knockable dynamic prop definitions matching `@blend-garage/world-racing`'s `DynamicWorldPropDef[]`. */
  getDynamicPropDefs(): readonly DynamicWorldPropDef[] {
    return this.dynamicProps ? this.dynamicProps.defs : [];
  }

  /** Syncs instanced dynamic prop transforms directly from Rapier physics with zero per-frame allocations. */
  syncDynamicProps(transforms: readonly DynamicPropTransformInput[]): void {
    this.dynamicProps?.sync(transforms);
  }

  /** Returns true when `pos` is inside the 280m Concrete Mountain Tunnel (drives tunnel exhaust reverb). */
  isInsideTunnel(pos: WorldPointInput): boolean {
    const p = writeVec3Like(pos, _tunnelScratch);
    return isInsideTunnelCoords(p.x, p.y, p.z);
  }

  /** Returns the ground/road surface material at world `(x, z)` (`'asphalt' | 'concrete' | 'gravel' | 'dirt' | 'grass'`). */
  getSurfaceAt(x: number, z: number): WorldSurfaceKind {
    return this.roadNetwork.getSurfaceAt(x, z);
  }

  /** Returns a named spawn point (`'start' | 'coast' | 'highway' | 'canyon' | 'desert' | 'proving-grounds'`). */
  getSpawnPoint(name: SpawnName = 'start'): WorldSpawnPose {
    const sp = this.roadNetwork.spawnPoints[name] ?? this.roadNetwork.spawnPoints.start;
    return {
      name: sp.name,
      label: sp.label,
      position: [sp.position[0], sp.position[1], sp.position[2]],
      headingRad: sp.headingRad,
    };
  }

  /** Lists all 6 named quick-warp biome spawn points. */
  getAllSpawnPoints(): WorldSpawnPose[] {
    return (['start', 'coast', 'highway', 'canyon', 'desert', 'proving-grounds'] as const).map((name) =>
      this.getSpawnPoint(name),
    );
  }

  /** Returns the nearest clean drivable road/pad pose aligned with the road direction (for Reset-to-Road). */
  nearestRoadPose(x: number, z: number): WorldSpawnPose {
    return this.roadNetwork.nearestRoadPose(x, z);
  }

  /** Evaluates exact physics ground height at any world `(x, z)`. */
  sampleGroundHeight(x: number, z: number): number {
    return this.terrain ? this.terrain.sampleHeight(x, z) : 0;
  }

  /**
   * Unmounts the Open World, restores the previous scene lighting/fog/environment cleanly,
   * and disposes every geometry, material, texture, shadow map, water shader, and PMREM render target.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.fx?.dispose();
    this.fx = null;

    this.water?.dispose();
    this.water = null;

    this.environment?.dispose();
    this.environment = null;

    for (const geo of this.ownedGeometries) geo.dispose();
    this.ownedGeometries.length = 0;

    for (const mat of this.ownedMaterials) mat.dispose();
    this.ownedMaterials.length = 0;

    if (this.textures) {
      for (const tex of this.textures.all) tex.dispose();
      this.textures = null;
    }

    this.dynamicProps = null;
    this.cullableSectors = [];
    this.colliders = [];
    this.terrain = null;
    this.group.removeFromParent();
    this.mounted = false;
  }
}
