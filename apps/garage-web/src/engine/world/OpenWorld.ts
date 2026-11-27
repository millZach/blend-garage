import * as THREE from 'three';
import type { Vec3 } from '@blend-garage/vehicle-core';
import type { WorldColliderDef } from '@blend-garage/world-racing';
import { assembleWorldColliders } from './colliders';
import { WorldEnvironment } from './environment';
import { WorldFX, type Vec3Like } from './fx';
import { buildWorldProps } from './props';
import { buildRoadVisuals, RoadNetwork, type SpawnName, type WorldSpawnPose } from './roads';
import { buildTerrain, type TerrainData } from './terrain';
import { createWorldTextures, type WorldTextures } from './textures';

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

function toVec3Like(v: WorldPointInput): Vec3Like {
  return Array.isArray(v) ? { x: v[0], y: v[1], z: v[2] } : v;
}

/**
 * Self-contained pure-TypeScript 3D Open World for Blend Garage Drive Mode:
 * - Sculpted 1200x1200m valley + canyon terrain seamlessly blended to paved roads
 * - Blend Garage Exterior Spawn Plaza, 4-lane Highway Loop & Straightaway, Winding Canyon Pass,
 *   and Crash-Test & Stunt Proving Grounds (impact walls, crash pillars, stunt ramp, slalom, speed bumps)
 * - Exact matching `@blend-garage/world-racing` `WorldColliderDef[]`
 * - Daylight sky dome, car-following directional sun shadows, outdoor PMREM reflection map & fog
 * - Pooled crash sparks, tire skidmarks, and engine smoke visual FX
 */
export class OpenWorld {
  readonly group = new THREE.Group();
  readonly roadNetwork: RoadNetwork;

  private textures: WorldTextures | null = null;
  private terrain: TerrainData | null = null;
  private environment: WorldEnvironment | null = null;
  private fx: WorldFX | null = null;
  private colliders: WorldColliderDef[] = [];

  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];
  private mounted = false;
  private disposed = false;

  constructor() {
    this.group.name = 'open-world';
    this.roadNetwork = new RoadNetwork();
  }

  /**
   * Builds and mounts the entire Open World into `scene`, switching lighting, sky, fog,
   * and PMREM reflections cleanly to outdoor daylight.
   */
  mount(scene: THREE.Scene, renderer: THREE.WebGLRenderer): void {
    if (this.mounted || this.disposed) return;
    this.mounted = true;

    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    this.textures = createWorldTextures(maxAniso);

    // 1. Sculpted terrain + matching physics height grid.
    this.terrain = buildTerrain(this.roadNetwork, this.textures);
    this.ownedGeometries.push(this.terrain.geometry);
    this.ownedMaterials.push(this.terrain.material);
    this.group.add(this.terrain.mesh);

    // 2. Road ribbons, Spawn Plaza, Proving Grounds apron & markings.
    const roads = buildRoadVisuals(this.roadNetwork, this.textures);
    this.ownedGeometries.push(...roads.geometries);
    this.ownedMaterials.push(...roads.materials);
    this.group.add(roads.group);

    // 3. Architecture, Crash Proving Grounds, Gantries, Instanced Vegetation & Props.
    const props = buildWorldProps(this.roadNetwork, this.terrain, this.textures);
    this.ownedGeometries.push(...props.geometries);
    this.ownedMaterials.push(...props.materials);
    this.group.add(props.group);

    // 4. Assemble exact static physics colliders matching every visual surface & obstacle.
    this.colliders = assembleWorldColliders(this.terrain, props.colliders);

    // 5. Driving & crash visual FX pools.
    this.fx = new WorldFX(this.textures, (x, z) => this.sampleGroundHeight(x, z));
    this.group.add(this.fx.group);

    // 6. Outdoor daylight sky dome, directional sun, fog & PMREM environment map.
    this.environment = new WorldEnvironment(scene, renderer);
    scene.add(this.group);

    const start = this.getSpawnPoint('start');
    this.environment.update(start.position[0], start.position[1], start.position[2]);
  }

  /**
   * Advances dynamic world systems (sun shadow frustum tracking, sky centering, sparks, smoke, skidmarks).
   */
  update(dt: number, carWorldPose: WorldCarPoseInput, fxInputs?: WorldFxInputs): void {
    if (!this.mounted || this.disposed) return;

    const pos = toVec3Like(carWorldPose.position);
    this.environment?.update(pos.x, pos.y, pos.z);

    if (this.fx) {
      if (fxInputs?.hoodWorldPos && typeof fxInputs.engineHealth === 'number') {
        this.fx.updateEngineSmoke(dt, toVec3Like(fxInputs.hoodWorldPos), fxInputs.engineHealth);
      }
      if (fxInputs?.skidMarks) {
        for (let i = 0; i < fxInputs.skidMarks.length; i++) {
          const s = fxInputs.skidMarks[i];
          this.fx.addSkidMark(s.wheelKey, toVec3Like(s.contactPoint), s.headingRad, s.width, s.opacity);
        }
      }
      this.fx.update(dt);
    }
  }

  /** Triggers a pooled incandescent spark burst at a world crash impact point. */
  emitCrashSparks(worldPoint: WorldPointInput, worldNormal: WorldPointInput, intensity = 1.0): void {
    this.fx?.emitCrashSparks(toVec3Like(worldPoint), toVec3Like(worldNormal), intensity);
  }

  /** Appends a tire skidmark segment for a wheel contact point. */
  addSkidMark(
    wheelKey: string,
    worldPos: WorldPointInput,
    headingRad: number,
    width = 0.28,
    opacity = 0.65,
  ): void {
    this.fx?.addSkidMark(wheelKey, toVec3Like(worldPos), headingRad, width, opacity);
  }

  /** Emits hood smoke puffs when `engineHealth < 0.6`. */
  updateEngineSmoke(dt: number, hoodWorldPos: WorldPointInput, engineHealth: number): void {
    this.fx?.updateEngineSmoke(dt, toVec3Like(hoodWorldPos), engineHealth);
  }

  /** Clears transient spark/smoke/skid state (useful on car warp or repair). */
  clearFx(): void {
    this.fx?.clear();
  }

  /** Returns all static physics colliders matching `@blend-garage/world-racing`'s `WorldColliderDef[]`. */
  getColliders(): WorldColliderDef[] {
    return this.colliders;
  }

  /** Returns a named spawn point (`'start'`, `'highway'`, `'proving-grounds'`, `'canyon'`). */
  getSpawnPoint(name: SpawnName = 'start'): WorldSpawnPose {
    const sp = this.roadNetwork.spawnPoints[name] ?? this.roadNetwork.spawnPoints.start;
    return {
      name: sp.name,
      label: sp.label,
      position: [sp.position[0], sp.position[1], sp.position[2]],
      headingRad: sp.headingRad,
    };
  }

  /** Lists all available named quick-warp spawn points. */
  getAllSpawnPoints(): WorldSpawnPose[] {
    return (['start', 'highway', 'proving-grounds', 'canyon'] as const).map((name) => this.getSpawnPoint(name));
  }

  /** Returns the nearest clean asphalt pose aligned with the road direction (for Reset-to-Road). */
  nearestRoadPose(x: number, z: number): WorldSpawnPose {
    return this.roadNetwork.nearestRoadPose(x, z);
  }

  /** Evaluates exact physics ground height at any world `(x, z)`. */
  sampleGroundHeight(x: number, z: number): number {
    return this.terrain ? this.terrain.sampleHeight(x, z) : 0;
  }

  /**
   * Unmounts the Open World, restores the previous scene lighting/fog/environment cleanly,
   * and disposes every geometry, material, texture, shadow map, and PMREM render target.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.fx?.dispose();
    this.fx = null;

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

    this.colliders = [];
    this.terrain = null;
    this.group.removeFromParent();
    this.mounted = false;
  }
}
