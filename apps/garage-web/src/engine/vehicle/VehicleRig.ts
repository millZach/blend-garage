import * as THREE from 'three';
import type { DamageStepResult, DeformableMeshPayload, MeshDamageUpdate } from '@blend-garage/damage-bridge';
import { RIM_FINISH_PRESETS, type CarBuild, type PaintZoneRole, type PaintZoneState, type VehicleManifest } from '@blend-garage/vehicle-core';
import { DEG, clamp } from '../math';
import type { RigSummary, WheelCorner } from '../types';
import { buildExhaustTips, buildRoofGear, buildSplitter, buildSpoiler, buildTowHook, createAeroMaterials, disposeGroup, slotsFromManifest, type AeroContext, type AeroMaterials } from './aero';
import { collectMeshes, detectFrontSign, detectWheels, findBodyPaintZone, reframe, type MeshRecord, type WheelFit } from './analysis';
import { HeightField, mergeByMaterial } from './batching';
import { CarLights } from './carLights';
import { prepareMaterials, texturesOf } from './materialFixes';
import { PaintBooth, copyPaintLook } from './paint';
import { buildWheelFace, createWheelFaceMaterials, type WheelFaceMaterials } from './wheelFaces';

/** How far the wheels hang below their normal position once the body is lifted off them. */
const SUSPENSION_DROOP = 0.065;
const FLASH_SECONDS = 0.75;
/** Above this vertex count, avoid O(N) full-mesh normal/bounds recomputations on every impact frame. */
const HIGH_POLY_VERTEX_THRESHOLD = 85_000;
/** Above this vertex count, rely on RealDamageSimulator's sparse normal backup instead of full restNormals copies. */
const SPARSE_NORMAL_VERTEX_THRESHOLD = 250_000;
/** Maximum vertex count for per-vertex paint-scuff color buffer darkening (keeps mega-poly memory flat). */
const SCUFF_VERTEX_LIMIT = 360_000;

export interface WheelDriveSpec {
  corner: WheelCorner;
  center: [number, number, number];
  radius: number;
  width: number;
  front: boolean;
  side: 1 | -1;
}

export interface WheelDriveState {
  corner: WheelCorner;
  /** Vertical suspension offset relative to rest height (meters; + up into arch, - drooping). */
  suspensionY: number;
  /** Front steering angle in radians. */
  steerRad: number;
  /** Cumulative wheel spin angle in radians. */
  spinRad: number;
  /** Instantaneous bent-axle wobble angle in radians (0 = healthy). */
  wobbleRad?: number;
  /** Permanent structural bent camber offset in radians from corner damage. */
  camberDamageRad?: number;
  /** Permanent structural bent toe offset in radians from corner damage. */
  toeDamageRad?: number;
}

export interface DetachedDebrisSpawn {
  group: THREE.Group;
  localPivot: THREE.Vector3;
  radius: number;
}

interface ScuffState {
  mesh: THREE.Mesh;
  origMaterial: THREE.Material;
  clonedMaterial: THREE.Material;
  hadColorAttr: boolean;
  restColors: Float32Array | null;
  colorItemSize: number;
}

export interface RigResources {
  maxAnisotropy: number;
  glowTexture: THREE.Texture;
  beamTexture: THREE.Texture;
}

export interface RigBuildHooks {
  /** Called with 0..1 as meshes are merged. */
  onProgress(fraction: number): void;
  /** Return true if the user has moved on to another car; the build then stops and cleans up. */
  isStale(): boolean;
}

interface WheelRig {
  fit: WheelFit;
  hub: THREE.Group;
  steer: THREE.Group;
  camber: THREE.Group;
  spin: THREE.Group;
  face: THREE.Group | null;
}

interface Deformable {
  id: string;
  mesh: THREE.Mesh;
  partId: string | null;
}

/**
 * Hands the main thread back to the browser for a moment. A message channel is used rather than
 * `setTimeout`, because timers are throttled to once a second in a tab or panel that is not in front,
 * which would turn a one-second load into a minute.
 */
const breathe = () =>
  new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });

function disposeMaterial(material: THREE.Material): void {
  for (const texture of texturesOf(material)) {
    texture.dispose();
    // glTF images are decoded to ImageBitmaps, which hold memory until closed explicitly.
    const image = texture.source?.data as { close?: () => void } | undefined;
    if (image && typeof image.close === 'function') image.close();
  }
  material.dispose();
}

/**
 * One loaded car, ready to be modified. Built from a parsed glTF and its manifest; owns every GPU
 * resource the car uses and releases all of them in `dispose()`.
 *
 * Everything inside is in the car frame: origin on the floor under the middle of the car, +Z out of
 * the nose, +X to the car's left. Whoever owns the rig moves `root` around the shop.
 */
export class VehicleRig {
  readonly root = new THREE.Group();
  readonly summary: RigSummary;
  readonly bounds: THREE.Box3;
  readonly size: THREE.Vector3;
  /** True when something changed that the shadow map has to pick up. Cleared by `consumeShadowDirty`. */
  private shadowDirty = true;

  private readonly body = new THREE.Group();
  private readonly partGroups = new Map<string, THREE.Group>();
  private readonly wheels: WheelRig[] = [];
  private readonly wheelByCorner = new Map<WheelCorner, WheelRig>();
  private readonly deformables: Deformable[] = [];
  private readonly restPositions = new Map<string, Float32Array>();
  private readonly restNormals = new Map<string, Float32Array>();
  private readonly paddedBounds = new Set<string>();
  private readonly scuffStates = new Map<string, ScuffState>();
  private readonly savedCastShadow = new Map<THREE.Mesh, boolean>();
  private driveShadowProxy: THREE.Group | null = null;
  private driveContactTexture: THREE.CanvasTexture | null = null;
  private driveShadowMode = false;
  private readonly aeroMaterials: AeroMaterials;
  private readonly faceMaterials: WheelFaceMaterials;
  private readonly aeroContext: AeroContext;
  private readonly aero: Record<'spoiler' | 'roof' | 'splitter' | 'towHook' | 'exhaustTips', THREE.Group | null> = { spoiler: null, roof: null, splitter: null, towHook: null, exhaustTips: null };
  private readonly lights: CarLights;
  private applied: CarBuild | null = null;
  private spinSpeed = 0;
  private liftHeight = 0;
  private driving = false;
  private driveLightsOn = false;
  private headlightsIntact = true;
  private taillightsIntact = true;
  private flash: { zoneId: string; t: number } | null = null;
  private disposed = false;

  private constructor(
    readonly manifest: VehicleManifest,
    private readonly booth: PaintBooth,
    private readonly materialsByName: Map<string, THREE.Material[]>,
    private readonly field: HeightField,
    records: MeshRecord[],
    frontSign: 1 | -1,
    resources: RigResources,
    fits: WheelFit[],
    bodyZoneId: string | null,
    stats: { triangles: number; sourceMeshes: number },
  ) {
    this.root.name = `car:${manifest.id}`;
    this.body.name = 'body';
    this.root.add(this.body);
    this.bounds = field.bounds.clone();
    this.size = this.bounds.getSize(new THREE.Vector3());

    this.aeroMaterials = createAeroMaterials();
    this.faceMaterials = createWheelFaceMaterials();
    this.aeroContext = { bounds: this.bounds, field, slots: slotsFromManifest(manifest, frontSign), materials: this.aeroMaterials };
    this.lights = new CarLights({
      manifest,
      records,
      booth,
      materialsByName,
      bounds: this.bounds,
      glowTexture: resources.glowTexture,
      beamTexture: resources.beamTexture,
      barLens: this.aeroMaterials.lamp,
    });
    this.body.add(this.lights.effects);

    const zoneRoles: Record<string, PaintZoneRole> = {};
    const roleZones: Partial<Record<PaintZoneRole, string[]>> = {};
    const roleLeads: Partial<Record<PaintZoneRole, string>> = {};
    const LAMP_NOT_PRIMARY = /(rear[ _-]?lamp|tail[ _-]?lamp|head[ _-]?lamp|ruby|light[ _-]?guide|emitter|optical[ _-]?cover|clear[ _-]?shell)/i;
    for (const zone of manifest.materialZones) {
      if (!booth.has(zone.id)) continue;
      const isBody = zone.id === bodyZoneId;
      const mats = booth.materialsOf(zone.id);
      const isGlass = mats.length > 0 && mats.every((m) => Boolean(m.userData.glass));
      let role: PaintZoneRole = isBody ? 'primary' : zone.role;
      if (!isBody && isGlass) {
        role = 'glass';
      } else if (!isBody && role === 'primary' && LAMP_NOT_PRIMARY.test(zone.materialName)) {
        role = /head[ _-]?lamp/i.test(zone.materialName) ? 'headlight' : 'taillight';
      }
      zoneRoles[zone.id] = role;
      const list = (roleZones[role] ??= []);
      // The real body paint leads the body zones, wherever the manifest happened to list it.
      if (isBody) list.unshift(zone.id);
      else list.push(zone.id);
    }
    for (const role of Object.keys(roleZones) as PaintZoneRole[]) roleLeads[role] = roleZones[role]![0];
    const front = fits.filter((w) => w.front);
    const rear = fits.filter((w) => !w.front);
    const mean = (list: WheelFit[]) => list.reduce((sum, w) => sum + w.center.z, 0) / list.length;
    this.summary = {
      size: [this.size.x, this.size.y, this.size.z],
      wheels: fits.map((w) => ({ corner: w.corner, radius: w.radius, width: w.width })),
      wheelbase: front.length && rear.length ? mean(front) - mean(rear) : null,
      sourceMeshes: stats.sourceMeshes,
      drawCalls: 0,
      triangles: stats.triangles,
      zoneRoles,
      roleLeads,
      roleZones,
      caliperZones: manifest.materialZones.filter((z) => booth.has(z.id) && /caliper/i.test(z.materialName)).map((z) => z.id),
      stockSpoilerParts: manifest.parts.filter((p) => p.category === 'spoiler').length,
      hasHeadlights: this.lights.hasHeadlights,
      hasTaillights: this.lights.hasTaillights,
    };
  }

  /**
   * Turns a parsed glTF scene into a rig. The scene's own meshes are consumed (merged and disposed);
   * nothing of it is added to the scene graph. Resolves to `null` if `hooks.isStale()` turned true.
   */
  static async build(scene: THREE.Object3D, manifest: VehicleManifest, resources: RigResources, hooks: RigBuildHooks): Promise<VehicleRig | null> {
    const materialsByName = prepareMaterials(scene, manifest, resources.maxAnisotropy);
    const records = collectMeshes(scene, manifest);
    const abandon = () => {
      for (const r of records) r.mesh.geometry.dispose();
      for (const list of materialsByName.values()) list.forEach(disposeMaterial);
      return null;
    };
    if (!records.length) {
      abandon();
      throw new Error('This model has no meshes to show.');
    }

    const frontSign = detectFrontSign(records, manifest);
    if (frontSign === -1) reframe(records, new THREE.Matrix4().makeRotationY(Math.PI));
    const bounds = new THREE.Box3();
    for (const r of records) bounds.union(r.box);
    const fits = detectWheels(records, manifest, frontSign);
    const bodyZoneId = findBodyPaintZone(records, manifest, bounds);
    const field = new HeightField(bounds);

    const spinOf = new Map<MeshRecord, WheelFit>();
    const carriedOf = new Map<MeshRecord, WheelFit>();
    for (const fit of fits) {
      for (const r of fit.spin) spinOf.set(r, fit);
      for (const r of fit.carried) carriedOf.set(r, fit);
    }
    const spoilerParts = new Set(manifest.parts.filter((p) => p.category === 'spoiler').map((p) => p.id));
    const bodyRecords: MeshRecord[] = [];
    const partRecords = new Map<string, MeshRecord[]>();
    for (const r of records) {
      if (spinOf.has(r) || carriedOf.has(r)) continue;
      if (r.partId) {
        const list = partRecords.get(r.partId);
        if (list) list.push(r);
        else partRecords.set(r.partId, [r]);
      } else bodyRecords.push(r);
    }

    const booth = new PaintBooth(manifest, materialsByName);
    let triangles = 0;
    const rig = new VehicleRig(manifest, booth, materialsByName, field, records, frontSign, resources, fits, bodyZoneId, { triangles: 0, sourceMeshes: records.length });

    // Merge in slices so the page keeps painting (and can be cancelled) while a big car is prepared.
    let done = 0;
    let lastYield = performance.now();
    const identity = new THREE.Matrix4();
    const merge = async (list: MeshRecord[], inverse: THREE.Matrix4, name: string, parent: THREE.Object3D, partId: string | null, mapSurface: boolean, deformable: boolean): Promise<boolean> => {
      const byMaterial = new Map<THREE.Material, MeshRecord[]>();
      for (const r of list) {
        const key = r.mesh.material as THREE.Material;
        const group = byMaterial.get(key);
        if (group) group.push(r);
        else byMaterial.set(key, [r]);
      }
      for (const group of byMaterial.values()) {
        const result = mergeByMaterial(group, inverse, name, mapSurface ? field : undefined);
        for (const r of group) r.mesh.geometry.dispose();
        triangles += result.triangles;
        for (const mesh of result.meshes) {
          parent.add(mesh);
          if (deformable) {
            const uniqueId = `${name}/${rig.deformables.length}:${(mesh.material as THREE.Material).name}`;
            rig.deformables.push({ id: uniqueId, mesh, partId });
          }
        }
        done += group.length;
        if (performance.now() - lastYield > 14) {
          hooks.onProgress(done / records.length);
          await breathe();
          lastYield = performance.now();
          if (hooks.isStale()) return false;
        }
      }
      return true;
    };

    const stop = () => {
      // Geometries that were never merged still need releasing; the rig releases everything else.
      for (const r of records) r.mesh.geometry.dispose();
      rig.dispose();
      return null;
    };

    if (!(await merge(bodyRecords, identity, 'body', rig.body, null, true, true))) return stop();
    for (const part of manifest.parts) {
      const list = partRecords.get(part.id);
      if (!list) continue;
      const group = new THREE.Group();
      group.name = `part:${part.id}`;
      rig.body.add(group);
      rig.partGroups.set(part.id, group);
      if (!(await merge(list, identity, part.id, group, part.id, !spoilerParts.has(part.id), true))) return stop();
    }
    for (const fit of fits) {
      const hub = new THREE.Group();
      hub.name = `wheel:${fit.corner}`;
      hub.position.set(fit.center.x, 0, fit.center.z);
      const steer = new THREE.Group();
      const camber = new THREE.Group();
      const spin = new THREE.Group();
      spin.position.y = fit.center.y;
      hub.add(steer);
      steer.add(camber);
      camber.add(spin);
      rig.root.add(hub);
      const wheelRig: WheelRig = { fit, hub, steer, camber, spin, face: null };
      rig.wheels.push(wheelRig);
      rig.wheelByCorner.set(fit.corner, wheelRig);
      const toSpin = new THREE.Matrix4().makeTranslation(-fit.center.x, -fit.center.y, -fit.center.z);
      const toHub = new THREE.Matrix4().makeTranslation(-fit.center.x, 0, -fit.center.z);
      if (!(await merge(fit.spin, toSpin, `wheel ${fit.corner}`, spin, null, false, false))) return stop();
      if (!(await merge(fit.carried, toHub, `brake ${fit.corner}`, camber, null, false, false))) return stop();
    }

    let drawCalls = 0;
    rig.root.traverse((o) => {
      if (o instanceof THREE.Mesh) drawCalls += 1;
    });
    rig.summary.triangles = triangles;
    rig.summary.drawCalls = drawCalls;
    hooks.onProgress(1);
    return rig;
  }

  /** The stock look of every zone as paint states, for zones the user has not touched. */
  stockZoneStates(): Record<string, PaintZoneState> {
    const states: Record<string, PaintZoneState> = {};
    for (const zone of this.manifest.materialZones) {
      const state = this.booth.stockState(zone.id);
      if (state) states[zone.id] = state;
    }
    return states;
  }

  /** Lowest point of the body within a hand's width of (x, z), with the current ride height applied. */
  undersideAt(x: number, z: number): number {
    return this.field.bottomAt(x, z, 0.07, 0.15) + this.body.position.y;
  }

  /** World-space center of a wheel, for the wheel close-up camera. */
  wheelPosition(preferred: 'FL' | 'FR' | 'RL' | 'RR' = 'FL'): THREE.Vector3 | null {
    const wheel = this.wheels.find((w) => w.fit.corner === preferred) ?? this.wheels[0];
    return wheel ? wheel.spin.getWorldPosition(new THREE.Vector3()) : null;
  }

  /** Objects that must be hidden while reflections are baked. */
  get lightEffects(): THREE.Object3D {
    return this.lights.effects;
  }

  consumeShadowDirty(): boolean {
    const dirty = this.shadowDirty;
    this.shadowDirty = false;
    return dirty;
  }

  /**
   * Makes the car match a build. Cheap to call on every slider tick: sections of the build that are
   * the same object as last time are skipped, so callers must replace (not mutate) what they change.
   */
  applyBuild(build: CarBuild): void {
    const prev = this.applied;
    this.applied = build;

    if (!prev || prev.paintZones !== build.paintZones || prev.rimFinish !== build.rimFinish || prev.glassTint !== build.glassTint) {
      for (const zoneId of Object.keys(build.paintZones)) {
        const state = build.paintZones[zoneId];
        const role = this.booth.role(zoneId);
        if (state.modified) this.booth.apply(zoneId, state);
        else if (role === 'rim' && build.rimFinish) this.booth.apply(zoneId, build.rimFinish);
        else {
          this.booth.apply(zoneId, null);
          if (role === 'glass') this.booth.applyGlassTint(zoneId, build.glassTint);
        }
      }
      this.syncDerivedPaint(build);
    }

    const parts = build.universalParts;
    const before = prev?.universalParts;
    if (!prev || prev.partVisibility !== build.partVisibility || before?.spoiler !== parts.spoiler) {
      for (const part of this.manifest.parts) {
        const group = this.partGroups.get(part.id);
        // Choosing anything but the stock spoiler takes the car's own wing off.
        if (group) group.visible = build.partVisibility[part.id] !== false && !(part.category === 'spoiler' && parts.spoiler !== 'stock');
      }
      this.shadowDirty = true;
    }

    if (before?.spoiler !== parts.spoiler) this.swapAero('spoiler', buildSpoiler(parts.spoiler, this.aeroContext));
    if (before?.roof !== parts.roof) {
      this.swapAero('roof', buildRoofGear(parts.roof, this.aeroContext));
      this.lights.setLightbar(parts.roof === 'rally-lightbar');
    }
    if (before?.frontSplitter !== parts.frontSplitter) this.swapAero('splitter', parts.frontSplitter ? buildSplitter(this.aeroContext) : null);
    if (before?.towHook !== parts.towHook) this.swapAero('towHook', parts.towHook ? buildTowHook(this.aeroContext) : null);
    if (before?.exhaustTips !== parts.exhaustTips) this.swapAero('exhaustTips', parts.exhaustTips ? buildExhaustTips(this.aeroContext) : null);

    if (before?.wheelStyle !== parts.wheelStyle) {
      for (const wheel of this.wheels) {
        disposeGroup(wheel.face);
        wheel.face = null;
        if (parts.wheelStyle === 'stock') continue;
        const face = buildWheelFace(parts.wheelStyle, wheel.fit.rimRadius + 0.004, this.faceMaterials);
        face.position.x = wheel.fit.side * (wheel.fit.faceOffset + 0.004);
        if (wheel.fit.side === -1) face.rotation.y = Math.PI;
        wheel.spin.add(face);
        wheel.face = face;
      }
    }

    if (!prev || prev.stance !== build.stance) {
      const s = build.stance;
      this.body.position.y = s.rideHeightOffset;
      this.spinSpeed = s.wheelSpinSpeed;
      for (const wheel of this.wheels) {
        wheel.hub.position.x = wheel.fit.center.x + wheel.fit.side * s.trackOffset;
        wheel.steer.rotation.y = wheel.fit.front ? s.frontSteerAngle * DEG : 0;
        wheel.camber.rotation.z = -wheel.fit.side * s.camberDeg * DEG;
      }
      this.shadowDirty = true;
    }

    if (!prev || prev.lightsOn !== build.lightsOn) this.lights.setOn(build.lightsOn);
  }

  /** Tells the rig how high the lift is holding it, so the wheels can hang on their suspension. */
  setLiftHeight(height: number): void {
    if (height === this.liftHeight) return;
    this.liftHeight = height;
    const droop = -clamp(height, 0, SUSPENSION_DROOP);
    for (const wheel of this.wheels) wheel.hub.position.y = droop;
    this.shadowDirty = true;
  }

  /** Rolls the wheels as if the car had travelled `distance` meters forward. */
  roll(distance: number): void {
    for (const wheel of this.wheels) wheel.spin.rotation.x += distance / wheel.fit.radius;
  }

  /** Briefly lights a zone up so the user can see which surfaces it covers. */
  flashZone(zoneId: string): void {
    if (this.flash) this.booth.setHighlight(this.flash.zoneId, 0);
    this.flash = this.booth.has(zoneId) ? { zoneId, t: 0 } : null;
  }

  update(dt: number): void {
    if (!this.driving && this.spinSpeed) for (const wheel of this.wheels) wheel.spin.rotation.x += this.spinSpeed * dt;
    this.lights.update(dt);
    if (this.flash) {
      this.flash.t += dt;
      const k = this.flash.t / FLASH_SECONDS;
      this.booth.setHighlight(this.flash.zoneId, k >= 1 ? 0 : Math.sin(Math.PI * k));
      if (k >= 1) this.flash = null;
    }
  }

  // ---------------------------------------------------------------- Phase 3: open-world driving hooks

  /** Wheel geometry in the car's local frame (including current shop trackOffset) for the physics vehicle. */
  getWheelSpecs(): WheelDriveSpec[] {
    const trackOffset = this.applied?.stance.trackOffset ?? 0;
    return this.wheels.map(({ fit }) => ({
      corner: fit.corner,
      center: [fit.center.x + fit.side * trackOffset, fit.center.y, fit.center.z],
      radius: fit.radius,
      width: fit.width,
      front: fit.front,
      side: fit.side,
    }));
  }

  /** Places the car root in world space during Open-World Drive Mode. */
  setDrivePose(position: THREE.Vector3 | readonly [number, number, number], quaternion: THREE.Quaternion | readonly [number, number, number, number]): void {
    this.driving = true;
    if (position instanceof THREE.Vector3) this.root.position.copy(position);
    else this.root.position.set(position[0], position[1], position[2]);
    if (quaternion instanceof THREE.Quaternion) this.root.quaternion.copy(quaternion);
    else this.root.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
    this.shadowDirty = true;
  }

  /** Syncs per-wheel suspension travel, steering, spin, structural camber/toe damage, and wobble during Drive Mode. */
  setWheelDriveState(states: readonly WheelDriveState[]): void {
    const camberDeg = this.applied?.stance.camberDeg ?? 0;
    const trackOffset = this.applied?.stance.trackOffset ?? 0;
    for (let i = 0; i < states.length; i++) {
      const state = states[i];
      const wheel = this.wheelByCorner.get(state.corner);
      if (!wheel) continue;
      const wobble = state.wobbleRad ?? 0;
      const camberDmg = state.camberDamageRad ?? 0;
      const toeDmg = state.toeDamageRad ?? 0;
      wheel.hub.position.x = wheel.fit.center.x + wheel.fit.side * trackOffset;
      wheel.hub.position.y = state.suspensionY;
      wheel.steer.rotation.y = (wheel.fit.front ? state.steerRad : 0) + toeDmg + wobble * 0.55;
      wheel.camber.rotation.z = -wheel.fit.side * camberDeg * DEG + camberDmg + wobble;
      wheel.spin.rotation.x = state.spinRad;
    }
    this.shadowDirty = true;
  }

  /**
   * Clones the meshes of a newly detached car part into an independent world-tumble `THREE.Group`
   * centered around its own bounding-box pivot. Caller owns and disposes the cloned geometries.
   */
  createDetachedDebrisGroup(meshIds: readonly string[], logicalPartId: string): DetachedDebrisSpawn | null {
    const idSet = new Set(meshIds);
    const matches = this.deformables.filter((d) => idSet.has(d.id) || (logicalPartId !== 'body' && d.partId === logicalPartId));
    if (matches.length === 0) return null;

    const combinedBox = new THREE.Box3();
    for (const { mesh } of matches) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (mesh.geometry.boundingBox) combinedBox.union(mesh.geometry.boundingBox);
    }
    if (combinedBox.isEmpty()) return null;

    const localPivot = combinedBox.getCenter(new THREE.Vector3());
    const size = combinedBox.getSize(new THREE.Vector3());
    const radius = clamp(size.length() * 0.32, 0.14, 0.85);

    const group = new THREE.Group();
    group.name = `debris:${logicalPartId}`;
    for (const { mesh } of matches) {
      const geo = mesh.geometry.clone();
      geo.translate(-localPivot.x, -localPivot.y, -localPivot.z);
      const clone = new THREE.Mesh(geo, mesh.material);
      clone.castShadow = false;
      clone.receiveShadow = true;
      group.add(clone);
    }

    return { group, localPivot, radius };
  }

  /**
   * Switches between full-detail shop shadow casting and a lightweight (~200-triangle) Drive Mode
   * shadow proxy + grounded contact-shadow blob. Eliminates rasterizing 700k–10M car triangles into
   * the dynamic shadow map every frame while keeping crisp car shadows on open-world asphalt.
   */
  setDriveShadowMode(enabled: boolean): void {
    if (enabled === this.driveShadowMode) return;
    this.driveShadowMode = enabled;

    if (enabled) {
      if (!this.driveShadowProxy) this.buildDriveShadowProxy();
      this.savedCastShadow.clear();
      this.root.traverse((obj) => {
        if (obj === this.driveShadowProxy || (this.driveShadowProxy && obj.parent === this.driveShadowProxy)) return;
        if (obj instanceof THREE.Mesh && obj.castShadow) {
          this.savedCastShadow.set(obj, true);
          obj.castShadow = false;
        }
      });
      if (this.driveShadowProxy) this.driveShadowProxy.visible = true;
    } else {
      for (const [mesh, wasCasting] of this.savedCastShadow) mesh.castShadow = wasCasting;
      this.savedCastShadow.clear();
      if (this.driveShadowProxy) this.driveShadowProxy.visible = false;
    }
    this.shadowDirty = true;
  }

  /** Toggles lights during Drive Mode without overwriting the saved shop build. */
  setDriveLights(on: boolean): void {
    this.driveLightsOn = on;
    this.syncLampVisibility();
  }

  /** Updates headlight/taillight working status after crash impacts. */
  setLampDamage(headlightsIntact: boolean, taillightsIntact: boolean): void {
    if (this.headlightsIntact === headlightsIntact && this.taillightsIntact === taillightsIntact) return;
    this.headlightsIntact = headlightsIntact;
    this.taillightsIntact = taillightsIntact;
    this.syncLampVisibility();
  }

  /** Restores all deformed meshes, scuffed paint/vertex colors, detached panels, and broken lamps to 100% mint condition. */
  resetAllDamage(): void {
    this.clearScuffStates();

    for (const { id, mesh } of this.deformables) {
      const restPos = this.restPositions.get(id);
      if (restPos) {
        const posAttr = mesh.geometry.attributes.position as THREE.BufferAttribute;
        const posArr = posAttr.array as Float32Array;
        if (posArr.length === restPos.length) {
          posArr.set(restPos);
          posAttr.clearUpdateRanges();
          posAttr.needsUpdate = true;
        }
      }
      const restNorm = this.restNormals.get(id);
      if (restNorm && mesh.geometry.attributes.normal) {
        const normAttr = mesh.geometry.attributes.normal as THREE.BufferAttribute;
        const normArr = normAttr.array as Float32Array;
        if (normArr.length === restNorm.length) {
          normArr.set(restNorm);
          normAttr.clearUpdateRanges();
          normAttr.needsUpdate = true;
        }
      }
      mesh.visible = true;
    }
    this.paddedBounds.clear();

    if (this.applied) {
      const parts = this.applied.universalParts;
      for (const part of this.manifest.parts) {
        const group = this.partGroups.get(part.id);
        if (group) {
          group.visible = this.applied.partVisibility[part.id] !== false && !(part.category === 'spoiler' && parts.spoiler !== 'stock');
        }
      }
    } else {
      for (const group of this.partGroups.values()) group.visible = true;
    }

    this.headlightsIntact = true;
    this.taillightsIntact = true;
    this.syncLampVisibility();
    this.shadowDirty = true;
  }

  private clearScuffStates(): void {
    for (const state of this.scuffStates.values()) {
      state.mesh.material = state.origMaterial;
      state.clonedMaterial.dispose();
      if (state.hadColorAttr && state.restColors) {
        const attr = state.mesh.geometry.attributes.color as THREE.BufferAttribute | undefined;
        if (attr && (attr.array as Float32Array).length === state.restColors.length) {
          (attr.array as Float32Array).set(state.restColors);
          attr.clearUpdateRanges();
          attr.needsUpdate = true;
        }
      } else if (!state.hadColorAttr) {
        state.mesh.geometry.deleteAttribute('color');
      }
    }
    this.scuffStates.clear();
  }

  /** Lazily darkens/scuffs scratched paint & exposed primer along crumpled vertices without mutating shared stock materials. */
  private applyMeshScuff(id: string, mesh: THREE.Mesh, update: MeshDamageUpdate): void {
    const posAttr = mesh.geometry.attributes.position as THREE.BufferAttribute;
    if (posAttr.count > SCUFF_VERTEX_LIMIT || update.mutatedCount <= 0) return;
    const mat = mesh.material as THREE.Material;
    if (mat.transparent || mat.userData?.glass) return;

    let state = this.scuffStates.get(id);
    if (!state) {
      const existingColor = mesh.geometry.attributes.color as THREE.BufferAttribute | undefined;
      const hadColorAttr = Boolean(existingColor);
      let colorAttr: THREE.BufferAttribute;
      let restColors: Float32Array | null = null;
      let colorItemSize = 3;

      if (existingColor && existingColor.array instanceof Float32Array) {
        colorItemSize = existingColor.itemSize;
        restColors = existingColor.array.slice();
        colorAttr = existingColor;
      } else {
        const buf = new Float32Array(posAttr.count * 3);
        buf.fill(1);
        colorAttr = new THREE.BufferAttribute(buf, 3);
        mesh.geometry.setAttribute('color', colorAttr);
      }

      const cloned = mat.clone() as THREE.MeshStandardMaterial;
      cloned.vertexColors = true;
      cloned.needsUpdate = true;
      mesh.material = cloned;

      state = {
        mesh,
        origMaterial: mat,
        clonedMaterial: cloned,
        hadColorAttr,
        restColors,
        colorItemSize,
      };
      this.scuffStates.set(id, state);
    }

    const colorAttr = mesh.geometry.attributes.color as THREE.BufferAttribute | undefined;
    if (!colorAttr || !(colorAttr.array instanceof Float32Array)) return;
    const colors = colorAttr.array;
    const stride = state.colorItemSize;
    const rest = state.restColors;
    const intensity = update.damageIntensity;
    const minV = Math.max(0, update.dirtyVertexMin);
    const maxV = Math.min(posAttr.count - 1, update.dirtyVertexMax);
    if (maxV < minV) return;

    // Exposed dark primer / scuffed steel tint for crumpled creases
    const primerR = 0.24;
    const primerG = 0.23;
    const primerB = 0.22;
    for (let v = minV; v <= maxV; v++) {
      const d = intensity[v];
      if (d <= 0.005) continue;
      const blend = Math.min(0.76, d * 0.82);
      const inv = 1 - blend;
      const o = v * stride;
      const r0 = rest ? rest[o] : 1;
      const g0 = rest ? rest[o + 1] : 1;
      const b0 = rest ? rest[o + 2] : 1;
      colors[o] = r0 * inv + primerR * blend;
      colors[o + 1] = g0 * inv + primerG * blend;
      colors[o + 2] = b0 * inv + primerB * blend;
    }

    colorAttr.clearUpdateRanges();
    colorAttr.addUpdateRange(minV * stride, (maxV - minV + 1) * stride);
    colorAttr.needsUpdate = true;
  }

  /** Exits Drive Mode cleanly: repairs damage and restores shop root transform, stance, and lights. */
  restoreShopPose(): void {
    this.driving = false;
    this.setDriveShadowMode(false);
    this.resetAllDamage();
    this.root.position.set(0, 0, 0);
    this.root.quaternion.identity();
    this.root.rotation.set(0, 0, 0);
    this.liftHeight = 0;

    const stance = this.applied?.stance;
    this.body.position.y = stance?.rideHeightOffset ?? 0;
    this.spinSpeed = stance?.wheelSpinSpeed ?? 0;
    for (const wheel of this.wheels) {
      wheel.hub.position.set(wheel.fit.center.x + wheel.fit.side * (stance?.trackOffset ?? 0), 0, wheel.fit.center.z);
      wheel.steer.rotation.set(0, wheel.fit.front ? (stance?.frontSteerAngle ?? 0) * DEG : 0, 0);
      wheel.camber.rotation.set(0, 0, -wheel.fit.side * (stance?.camberDeg ?? 0) * DEG);
      wheel.spin.rotation.set(0, 0, 0);
    }
    this.driveLightsOn = this.applied?.lightsOn ?? false;
    this.syncLampVisibility();
    this.shadowDirty = true;
  }

  private buildDriveShadowProxy(): void {
    const proxy = new THREE.Group();
    proxy.name = 'drive-shadow-proxy';
    proxy.visible = false;

    // Shadow-only material: writes nothing in the main color/depth pass, casts crisp silhouette in the shadow pass.
    const casterMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    const cx = (this.bounds.min.x + this.bounds.max.x) * 0.5;
    const cz = (this.bounds.min.z + this.bounds.max.z) * 0.5;
    const w = Math.max(1.2, this.size.x);
    const h = Math.max(0.9, this.size.y);
    const l = Math.max(3.0, this.size.z);

    const lowerH = h * 0.42;
    const lowerY = Math.max(0.18, this.bounds.min.y + 0.14) + lowerH * 0.5;
    const lowerMesh = new THREE.Mesh(new THREE.BoxGeometry(w * 0.88, lowerH, l * 0.92), casterMat);
    lowerMesh.position.set(cx, lowerY, cz);
    lowerMesh.castShadow = true;
    lowerMesh.receiveShadow = false;
    proxy.add(lowerMesh);

    const cabinH = h * 0.36;
    const cabinY = lowerY + lowerH * 0.5 + cabinH * 0.42;
    const cabinMesh = new THREE.Mesh(new THREE.BoxGeometry(w * 0.68, cabinH, l * 0.46), casterMat);
    cabinMesh.position.set(cx, cabinY, cz - l * 0.05);
    cabinMesh.castShadow = true;
    cabinMesh.receiveShadow = false;
    proxy.add(cabinMesh);

    for (const { fit } of this.wheels) {
      const wheelGeo = new THREE.CylinderGeometry(fit.radius * 0.95, fit.radius * 0.95, fit.width * 0.9, 10, 1);
      wheelGeo.rotateZ(Math.PI / 2);
      const wheelMesh = new THREE.Mesh(wheelGeo, casterMat);
      wheelMesh.position.copy(fit.center);
      wheelMesh.castShadow = true;
      wheelMesh.receiveShadow = false;
      proxy.add(wheelMesh);
    }

    // Soft grounded contact shadow right under the chassis for planted outdoor asphalt feel.
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const grad = ctx.createRadialGradient(32, 32, 6, 32, 32, 31);
      grad.addColorStop(0, 'rgba(0,0,0,0.72)');
      grad.addColorStop(0.58, 'rgba(0,0,0,0.44)');
      grad.addColorStop(0.84, 'rgba(0,0,0,0.14)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 64, 64);
    }
    const contactTex = new THREE.CanvasTexture(canvas);
    this.driveContactTexture = contactTex;
    const contactMat = new THREE.MeshBasicMaterial({
      map: contactTex,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const contactGeo = new THREE.PlaneGeometry(w + 0.55, l + 0.55);
    contactGeo.rotateX(-Math.PI / 2);
    const contactMesh = new THREE.Mesh(contactGeo, contactMat);
    contactMesh.position.set(cx, 0.028, cz);
    contactMesh.renderOrder = 2;
    contactMesh.castShadow = false;
    contactMesh.receiveShadow = false;
    proxy.add(contactMesh);

    this.driveShadowProxy = proxy;
    this.root.add(proxy);
  }

  private syncLampVisibility(): void {
    const requestedOn = this.driving ? this.driveLightsOn : (this.applied?.lightsOn ?? false);
    const anyIntact = this.headlightsIntact || this.taillightsIntact;
    this.lights.setOn(requestedOn && anyIntact);

    // CarLights.effects children layout: [headL, headR, tailL, tailR, coneL, coneR, spot, spot.target, tailLight]
    const children = this.lights.effects.children;
    if (children.length >= 9) {
      children[0].visible = this.headlightsIntact;
      children[1].visible = this.headlightsIntact;
      children[4].visible = this.headlightsIntact;
      children[5].visible = this.headlightsIntact;
      children[6].visible = this.headlightsIntact;
      children[2].visible = this.taillightsIntact;
      children[3].visible = this.taillightsIntact;
      children[8].visible = this.taillightsIntact;
    }
  }

  // ---------------------------------------------------------------- Phase 2: damage simulation bridge

  /**
   * Hands the body and panel vertex buffers (plus triangle indices & normals for exact O(k) creased
   * normals) to a `DamageSimulator` (see `@blend-garage/damage-bridge`).
   */
  extractDeformableMeshes(): DeformableMeshPayload[] {
    const cabinMinX = -this.size.x * 0.34;
    const cabinMaxX = this.size.x * 0.34;
    const cabinMinY = this.bounds.min.y + this.size.y * 0.24;
    const cabinMaxY = this.bounds.min.y + this.size.y * 0.80;
    const cabinMinZ = -this.size.z * 0.22;
    const cabinMaxZ = this.size.z * 0.16;

    const payloads: DeformableMeshPayload[] = [];
    for (const { id, mesh, partId } of this.deformables) {
      // Skip non-part interior meshes sitting strictly inside the rigid cabin safety cell.
      const box = mesh.geometry.boundingBox;
      if (
        !partId &&
        box &&
        box.min.x >= cabinMinX &&
        box.max.x <= cabinMaxX &&
        box.min.y >= cabinMinY &&
        box.max.y <= cabinMaxY &&
        box.min.z >= cabinMinZ &&
        box.max.z <= cabinMaxZ
      ) {
        continue;
      }

      const posAttr = mesh.geometry.attributes.position as THREE.BufferAttribute;
      const positions = posAttr.array as Float32Array;
      let restPositions = this.restPositions.get(id);
      if (!restPositions) {
        restPositions = positions.slice();
        this.restPositions.set(id, restPositions);
      }

      const normalAttr = mesh.geometry.attributes.normal as THREE.BufferAttribute | undefined;
      const normals = normalAttr ? (normalAttr.array as Float32Array) : undefined;
      // Above 250k verts, RealDamageSimulator maintains a zero-GC sparse normal backup and restores it on reset().
      if (normals && posAttr.count <= SPARSE_NORMAL_VERTEX_THRESHOLD && !this.restNormals.has(id)) {
        this.restNormals.set(id, normals.slice());
      }

      const idxAttr = mesh.geometry.index;
      const indices =
        idxAttr && (idxAttr.array instanceof Uint16Array || idxAttr.array instanceof Uint32Array)
          ? idxAttr.array
          : undefined;

      payloads.push({ partId: id, restPositions, positions, normals, indices });
    }
    return payloads;
  }

  /** Shows what a simulator step changed: sub-range GPU uploads for deformed positions/normals, scuff darkening, and panel detachment. */
  applyDamageResult(result: DamageStepResult): void {
    const dirty = new Set(result.dirtyPartIds);
    const detached = new Set(result.detachedPartIds);
    const updatesById = result.meshUpdates
      ? new Map(result.meshUpdates.map((u) => [u.partId, u]))
      : null;

    for (const { id, mesh, partId } of this.deformables) {
      if (dirty.has(id)) {
        const posAttr = mesh.geometry.attributes.position as THREE.BufferAttribute;
        const update = updatesById?.get(id);
        const hasSubRange =
          update !== undefined &&
          update.mutatedCount > 0 &&
          update.dirtyVertexMax >= update.dirtyVertexMin &&
          update.dirtyVertexMax < posAttr.count;

        posAttr.clearUpdateRanges();
        if (hasSubRange) {
          posAttr.addUpdateRange(update.dirtyVertexMin * 3, (update.dirtyVertexMax - update.dirtyVertexMin + 1) * 3);
        }
        posAttr.needsUpdate = true;

        const normalAttr = mesh.geometry.attributes.normal as THREE.BufferAttribute | undefined;
        if (normalAttr) {
          normalAttr.clearUpdateRanges();
          if (hasSubRange) {
            normalAttr.addUpdateRange(update.dirtyVertexMin * 3, (update.dirtyVertexMax - update.dirtyVertexMin + 1) * 3);
          }
          normalAttr.needsUpdate = true;
        } else if (posAttr.count <= HIGH_POLY_VERTEX_THRESHOLD) {
          mesh.geometry.computeVertexNormals();
        }

        if (update && update.mutatedCount > 0) {
          this.applyMeshScuff(id, mesh, update);
        }

        if (posAttr.count <= HIGH_POLY_VERTEX_THRESHOLD) {
          mesh.geometry.computeBoundingBox();
          mesh.geometry.computeBoundingSphere();
        } else if (!this.paddedBounds.has(id)) {
          this.paddedBounds.add(id);
          if (mesh.geometry.boundingBox) mesh.geometry.boundingBox.expandByScalar(1.0);
          if (mesh.geometry.boundingSphere) mesh.geometry.boundingSphere.radius += 1.0;
        }
      }
      if (detached.has(id)) mesh.visible = false;
      if (partId && detached.has(partId)) {
        const group = this.partGroups.get(partId);
        if (group) group.visible = false;
      }
    }
    this.setLampDamage(result.health.headlightsIntact, result.health.taillightsIntact);
    this.shadowDirty = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearScuffStates();
    this.lights.dispose();
    for (const key of Object.keys(this.aero) as (keyof VehicleRig['aero'])[]) disposeGroup(this.aero[key]);
    for (const wheel of this.wheels) disposeGroup(wheel.face);
    if (this.driveShadowProxy) {
      const proxyMats = new Set<THREE.Material>();
      this.driveShadowProxy.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          if (Array.isArray(o.material)) o.material.forEach((m) => proxyMats.add(m));
          else proxyMats.add(o.material as THREE.Material);
        }
      });
      proxyMats.forEach((m) => m.dispose());
      this.driveShadowProxy.removeFromParent();
      this.driveShadowProxy = null;
    }
    this.driveContactTexture?.dispose();
    this.driveContactTexture = null;
    this.savedCastShadow.clear();
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    for (const list of this.materialsByName.values()) list.forEach(disposeMaterial);
    for (const material of Object.values(this.aeroMaterials)) material.dispose();
    for (const material of Object.values(this.faceMaterials)) material.dispose();
    this.restPositions.clear();
    this.restNormals.clear();
    this.paddedBounds.clear();
    this.wheelByCorner.clear();
    this.root.removeFromParent();
  }

  private swapAero(slot: keyof VehicleRig['aero'], next: THREE.Group | null): void {
    disposeGroup(this.aero[slot]);
    this.aero[slot] = next;
    if (next) this.body.add(next);
    this.shadowDirty = true;
  }

  /** Bolt-on parts follow the body color, and replacement wheel faces follow the rim finish. */
  private syncDerivedPaint(build: CarBuild): void {
    const leadId = this.summary.roleLeads.primary;
    const lead = leadId ? this.booth.materialsOf(leadId)[0] : undefined;
    const zone = this.manifest.materialZones.find((z) => z.id === leadId);
    if (lead) copyPaintLook(lead, this.aeroMaterials.body, zone?.defaultColor ?? '#888888');
    const rim = build.rimFinish ?? RIM_FINISH_PRESETS[0].state;
    const face = this.faceMaterials.rim;
    face.color.set(rim.color);
    face.metalness = rim.metalness;
    face.roughness = rim.roughness;
    face.clearcoat = rim.clearcoat;
    face.clearcoatRoughness = rim.clearcoatRoughness;
    face.iridescence = rim.iridescence;
  }
}
