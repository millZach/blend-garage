import * as THREE from 'three';
import {
  createDefaultBuild,
  STANCE_LIMITS,
  type CarBuild,
  type GlassTintConfig,
  type PaintZoneState,
  type StanceConfig,
  type UniversalPartsConfig,
} from '@blend-garage/vehicle-core';
import { clearSavedBuild, loadSavedBuild, loadSession, parseBuildFile, saveBuild, saveSession, type Session } from './builds';
import { CameraDirector } from './camera/CameraDirector';
import { fetchCatalog, fetchVehicleManifest } from './catalog';
import { DriveSession } from './DriveSession';
import { DEG, angleDelta, clamp, damp, easeInOutCubic, lerp, smoothstep } from './math';
import { ShopEnvironment } from './shop/ShopEnvironment';
import { HALL, HERO_BAY, LIFT, TURNTABLE, clampToShop } from './shop/layout';
import { TwoPostLift } from './shop/lift';
import { Store } from './store';
import type { CameraMode, CameraPresetId, CarLoadState, CatalogCar, EngineSnapshot, LightingMoodId, LoadPhase, ViewInsets } from './types';
import { VehicleLoader } from './vehicle/VehicleLoader';
import type { VehicleRig } from './vehicle/VehicleRig';

const MAX_PIXEL_RATIO = 1.5;
const ROLL_SECONDS = 3.6;
const SAVE_DELAY_MS = 450;
/** Rapid clicks through the selector only start a load once the user settles on a car. */
const SELECT_SETTLE_MS = 180;
const TURNTABLE_SPEED = 0.23;
const IDLE_BEFORE_SPIN = 3.2;
/** The top-down camera stays below the hex light grid and the ducting. */
const TOP_VIEW_HEIGHT = 4.95;

interface Tween {
  t: number;
  duration: number;
  step: (k: number) => void;
  resolve: () => void;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The 3D side of Blend Garage, with no UI framework in it. Owns the renderer, the shop, the camera
 * and the one car on stage; the HUD calls its methods and re-renders from `getSnapshot()`.
 */
export class GarageEngine {
  private readonly store: Store<EngineSnapshot>;
  private readonly scene = new THREE.Scene();
  private readonly loader = new VehicleLoader();
  private readonly session: Session = loadSession();
  private renderer: THREE.WebGLRenderer | null = null;
  private shop: ShopEnvironment | null = null;
  private director: CameraDirector | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private rig: VehicleRig | null = null;
  private build: CarBuild | null = null;
  private driveSession: DriveSession | null = null;
  private loadToken = 0;
  private selectTimer: ReturnType<typeof setTimeout> | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private noticeId = 0;

  private readonly tweens: Tween[] = [];
  private onTurntable = true;
  private turntableAngle = 0.6;
  private turntableSpeed = 0;
  private carZ = TURNTABLE.z;
  private lastPose = '';
  private lastLift = 0;
  private lastUserMove = -Infinity;
  private insets: ViewInsets = { left: 0, right: 0, top: 0, bottom: 0 };
  private now = 0;
  private lastFrame = 0;
  /** Recent frame times, for a frame rate that one long hitch (a car being unpacked) cannot skew. */
  private readonly frameTimes = new Float32Array(45);
  private frameIndex = 0;
  private statsSince = 0;
  private started = false;
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.store = new Store<EngineSnapshot>({
      screen: 'selector',
      busy: null,
      catalogStatus: 'loading',
      catalogError: null,
      cars: [],
      selectedCarId: null,
      load: null,
      manifest: null,
      rig: null,
      build: null,
      savedAt: null,
      lift: { height: 0, target: 0, max: TwoPostLift.MAX_HEIGHT, moving: false },
      mood: this.session.mood,
      cameraMode: 'orbit',
      cameraPreset: null,
      perf: { fps: 0, drawCalls: 0, triangles: 0 },
      notice: null,
      curtain: 0,
      drive: null,
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);
  readonly getSnapshot = (): EngineSnapshot => this.store.get();

  // ------------------------------------------------------------------ lifecycle

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.boot();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.selectTimer);
    clearTimeout(this.noticeTimer);
    this.flushSave();
    for (const tween of this.tweens.splice(0)) tween.resolve();
    this.driveSession?.dispose();
    this.driveSession = null;
    this.loader.dispose();
    this.rig?.dispose();
    this.rig = null;
    this.resizeObserver?.disconnect();
    this.director?.dispose();
    this.shop?.dispose();
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    if (this.renderer) {
      this.renderer.setAnimationLoop(null);
      this.renderer.dispose();
    }
  }

  private async boot(): Promise<void> {
    // The shop's painted signs are drawn with the HUD's typeface, so wait (briefly) for it.
    try {
      await Promise.race([document.fonts.load('900 64px "Archivo Variable"'), new Promise((resolve) => setTimeout(resolve, 1500))]);
    } catch {
      // Signs fall back to a system face.
    }
    if (this.disposed) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    } catch (error) {
      this.store.set({ catalogStatus: 'error', catalogError: `This browser could not start WebGL 2, which the garage needs to draw in 3D. (${describe(error)})` });
      return;
    }
    this.renderer = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Shadows are only redrawn on frames where something that casts one has moved.
    renderer.shadowMap.autoUpdate = false;
    this.canvas.addEventListener('webglcontextlost', this.handleContextLost);

    this.director = new CameraDirector(this.canvas);
    this.director.onUserMove = () => {
      this.lastUserMove = this.now;
      if (this.store.get().cameraPreset) this.store.set({ cameraPreset: null });
    };
    this.director.setInsets(this.insets, true);
    this.shop = new ShopEnvironment(this.scene, renderer);
    this.shop.lighting.setMood(this.session.mood);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
    this.resize();
    this.frameSelector(true);
    renderer.setAnimationLoop(this.frame);
    await this.refreshCatalog(true);
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.notify('The graphics driver reset. Reload the page to get the garage back.', 'error', true);
  };

  private resize(): void {
    if (!this.renderer || !this.director) return;
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.setSize(width, height, false);
    this.director.setSize(width, height);
    this.driveSession?.resize(width, height);
  }

  // ------------------------------------------------------------------ catalog and car selection

  /** Re-reads /cars/manifest.json. Call after importing new .blend files. */
  async refreshCatalog(initial = false): Promise<void> {
    if (this.store.get().busy) return;
    this.store.set({ catalogStatus: 'loading', catalogError: null });
    let cars: CatalogCar[];
    try {
      cars = await fetchCatalog();
    } catch (error) {
      if (!this.disposed) this.store.set({ catalogStatus: 'error', catalogError: describe(error) });
      return;
    }
    if (this.disposed) return;
    const known = new Map(this.store.get().cars.map((car) => [car.id, car.manifest]));
    cars = cars.map((car) => ({ ...car, manifest: known.get(car.id) ?? null }));
    this.store.set({ cars, catalogStatus: 'ready' });
    if (!initial) this.notify(cars.length === 1 ? '1 car in the garage.' : `${cars.length} cars in the garage.`);
    void this.fetchManifests(cars);

    const current = this.store.get().selectedCarId;
    if (current && cars.some((car) => car.id === current)) return;
    const first = cars.find((car) => car.id === this.session.lastCarId) ?? cars[0];
    if (first) this.selectCar(first.id);
    else {
      // The car on stage no longer exists in the catalog.
      this.loadToken += 1;
      this.loader.cancel();
      this.unloadRig();
      this.store.set({ selectedCarId: null, load: null });
    }
  }

  /** Fills in each car's small vehicle.json so the selector can show its size without loading the model. */
  private async fetchManifests(cars: CatalogCar[]): Promise<void> {
    for (const car of cars) {
      if (this.disposed) return;
      if (car.manifest) continue;
      try {
        const manifest = await fetchVehicleManifest(car);
        if (this.disposed) return;
        this.store.set({ cars: this.store.get().cars.map((c) => (c.id === car.id ? { ...c, manifest } : c)) });
      } catch {
        // The selector shows the car without specs; loading it will report what is wrong.
      }
    }
  }

  /** Puts a car on the turntable. Only one car is ever loaded; the previous one is released first. */
  selectCar(carId: string): void {
    const s = this.store.get();
    if (s.busy || s.screen !== 'selector' || !s.cars.some((car) => car.id === carId)) return;
    if (carId === s.selectedCarId && s.load?.phase !== 'error') return;
    this.loadToken += 1;
    this.loader.cancel();
    clearTimeout(this.selectTimer);
    this.store.set({ selectedCarId: carId, load: { carId, phase: 'manifest', progress: 0, error: null } });
    this.selectTimer = setTimeout(() => void this.loadCar(carId, this.loadToken), this.rig ? SELECT_SETTLE_MS : 0);
  }

  stepCar(delta: number): void {
    const { cars, selectedCarId } = this.store.get();
    if (!cars.length) return;
    const index = Math.max(0, cars.findIndex((car) => car.id === selectedCarId));
    this.selectCar(cars[(index + delta + cars.length) % cars.length].id);
  }

  /** Tries the selected car again after a failed load. */
  retryLoad(): void {
    const { selectedCarId } = this.store.get();
    if (selectedCarId) this.selectCar(selectedCarId);
  }

  private async loadCar(carId: string, token: number): Promise<void> {
    const current = () => token === this.loadToken && !this.disposed;
    const report = (phase: LoadPhase, progress: number, error: string | null = null) => {
      if (current()) this.store.set({ load: { carId, phase, progress, error } satisfies CarLoadState });
    };
    const car = this.store.get().cars.find((c) => c.id === carId);
    if (!car || !this.renderer || !this.shop || !this.director) return;
    try {
      const manifest = car.manifest ?? (await fetchVehicleManifest(car));
      if (!current()) return;
      // Release the outgoing car's GPU memory before any of the incoming car is allocated.
      this.flushSave();
      this.unloadRig();
      const rig = await this.loader.load(
        manifest,
        { maxAnisotropy: this.renderer.capabilities.getMaxAnisotropy(), glowTexture: this.shop.textures.glow, beamTexture: this.shop.textures.beam },
        report,
      );
      if (!rig) return;
      if (!current()) {
        rig.dispose();
        return;
      }

      const saved = loadSavedBuild(manifest);
      const build = this.withStockZones(saved ?? createDefaultBuild(manifest), rig);
      rig.applyBuild(build);
      try {
        // Compile the car's shaders off the main thread's critical path, so it appears without a hitch.
        await this.renderer.compileAsync(rig.root, this.director.camera, this.scene);
      } catch {
        // Compiling on first draw instead is only slower.
      }
      if (!current()) {
        rig.dispose();
        return;
      }

      this.rig = rig;
      this.build = build;
      this.scene.add(rig.root);
      this.onTurntable = true;
      this.carZ = TURNTABLE.z;
      this.lastPose = '';
      this.store.set({ manifest, rig: rig.summary, build, savedAt: saved ? Date.parse(saved.updatedAt) || null : null, load: { carId, phase: 'ready', progress: 1, error: null } });
      this.session.lastCarId = carId;
      saveSession(this.session);
    } catch (error) {
      report('error', 0, describe(error));
    }
  }

  private unloadRig(): void {
    if (!this.rig) return;
    this.rig.dispose();
    this.rig = null;
    this.build = null;
    this.shop?.lift.reset();
    this.shop?.setCarShadow(null, 0, null, 0);
    this.lastPose = '';
    if (this.renderer) this.renderer.shadowMap.needsUpdate = true;
    this.store.set({ manifest: null, rig: null, build: null, savedAt: null });
  }

  /** Unpainted zones report the car's real stock values, so the HUD's sliders start where the car is. */
  private withStockZones(build: CarBuild, rig: VehicleRig): CarBuild {
    const stock = rig.stockZoneStates();
    const paintZones = { ...build.paintZones };
    for (const zoneId of Object.keys(stock)) if (!paintZones[zoneId]?.modified) paintZones[zoneId] = stock[zoneId];
    return { ...build, paintZones };
  }

  // ------------------------------------------------------------------ selector <-> shop

  /** Rolls the car off the turntable, across the hall and onto the lift. */
  async enterShop(): Promise<void> {
    const { rig, shop, director } = this;
    const s = this.store.get();
    if (!rig || !shop || !director || s.busy || s.screen !== 'selector' || s.load?.phase !== 'ready') return;
    this.store.set({ busy: 'rolling-in' });

    // Square the car up on the turntable, nose toward the hall.
    const from = this.turntableAngle;
    const turn = angleDelta(from, 0);
    this.turntableSpeed = 0;
    await this.animate(clamp(Math.abs(turn) / 2.4, 0.2, 0.95), (k) => (this.turntableAngle = from + turn * easeInOutCubic(k)));
    if (this.disposed) return;
    this.turntableAngle = 0;

    this.onTurntable = false;
    this.store.set({ screen: 'shop', cameraPreset: 'hero', cameraMode: 'orbit' });
    director.setMode('orbit');
    this.applyOrbitLimits();
    shop.lighting.setPhotoBay(0);
    const hero = this.presetPose('hero', HERO_BAY, 0);
    void director.flyTo(hero.position, hero.target, ROLL_SECONDS + 0.35);

    let previous = TURNTABLE.z;
    await this.animate(ROLL_SECONDS, (k) => {
      const eased = 0.5 - Math.cos(Math.PI * k) / 2;
      const z = lerp(TURNTABLE.z, HERO_BAY.z, eased);
      rig.roll(z - previous);
      previous = z;
      this.carZ = z;
      if (z > HALL.minZ - 2) shop.lighting.setEnvStage('hero-bay');
    });
    if (this.disposed) return;
    this.carZ = HERO_BAY.z;
    this.setLiftLoad();
    this.store.set({ busy: null });
  }

  /** Back to the Car Selector. A quick cut: the lift is reset and the car is returned to the turntable. */
  async leaveShop(): Promise<void> {
    const { shop, director } = this;
    const s = this.store.get();
    if (!shop || !director || s.busy || s.screen !== 'shop') return;
    this.store.set({ busy: 'leaving' });
    await this.animate(0.26, (k) => this.store.set({ curtain: k }));
    if (this.disposed) return;

    director.setMode('orbit');
    shop.lift.reset();
    this.rig?.setLiftHeight(0);
    this.lastLift = 0;
    this.onTurntable = true;
    this.carZ = TURNTABLE.z;
    this.turntableAngle = 0.6;
    this.lastUserMove = -Infinity;
    shop.lighting.setPhotoBay(1, true);
    shop.lighting.setEnvStage('photo-bay');
    this.store.set({ screen: 'selector', cameraMode: 'orbit', cameraPreset: null });
    this.frameSelector(true);

    await this.animate(0.34, (k) => this.store.set({ curtain: 1 - k }));
    this.store.set({ busy: null, curtain: 0 });
  }

  // ------------------------------------------------------------------ shop <-> open-world drive

  /** Launches the current customized car from the Mechanics Shop straight into Open-World Drive Mode. */
  async enterDrive(): Promise<void> {
    const { rig, build, shop, director, renderer } = this;
    const s = this.store.get();
    if (!rig || !build || !shop || !director || !renderer || s.busy || s.screen !== 'shop') return;

    this.flushSave();
    this.store.set({ busy: 'entering-drive' });
    await this.animate(0.22, (k) => this.store.set({ curtain: k }));
    if (this.disposed) return;

    director.setMode('orbit');
    shop.group.visible = false;
    shop.lighting.group.visible = false;
    rig.setLiftHeight(0);

    try {
      const session = await DriveSession.create({
        scene: this.scene,
        renderer,
        canvas: this.canvas,
        rig,
        build,
        width: this.canvas.clientWidth || window.innerWidth,
        height: this.canvas.clientHeight || window.innerHeight,
        onExit: () => void this.exitDrive(),
        onNotify: (text) => this.notify(text),
      });
      if (this.disposed) {
        session.dispose();
        return;
      }
      this.driveSession = session;
      renderer.shadowMap.needsUpdate = true;
      this.store.set({ screen: 'drive', drive: session.getSnapshot() });
    } catch (error) {
      shop.group.visible = true;
      shop.lighting.group.visible = true;
      rig.restoreShopPose();
      this.notify(`Could not start Open-World Drive Mode: ${describe(error)}`, 'error');
      await this.animate(0.22, (k) => this.store.set({ curtain: 1 - k }));
      if (!this.disposed) this.store.set({ busy: null, curtain: 0 });
      return;
    }

    await this.animate(0.28, (k) => this.store.set({ curtain: 1 - k }));
    if (!this.disposed) this.store.set({ busy: null, curtain: 0 });
  }

  /** Exits Open-World Drive Mode, disposes world/physics/damage cleanly, and restores the Mechanics Shop. */
  async exitDrive(): Promise<void> {
    const { shop, director, renderer } = this;
    const s = this.store.get();
    if (!shop || !director || !renderer || s.busy || s.screen !== 'drive') return;

    this.store.set({ busy: 'exiting-drive' });
    await this.animate(0.22, (k) => this.store.set({ curtain: k }));
    if (this.disposed) return;

    this.driveSession?.dispose();
    this.driveSession = null;

    shop.group.visible = true;
    shop.lighting.group.visible = true;
    shop.lift.reset();
    this.rig?.restoreShopPose();
    this.lastLift = 0;
    this.onTurntable = false;
    this.carZ = HERO_BAY.z;
    this.lastPose = '';
    this.setLiftLoad();

    shop.lighting.setPhotoBay(0, true);
    shop.lighting.setEnvStage('hero-bay');
    shop.lighting.setMood(this.session.mood);

    director.setMode('orbit');
    this.applyOrbitLimits();
    const hero = this.presetPose('hero', HERO_BAY, 0);
    director.jumpTo(hero.position, hero.target);
    renderer.shadowMap.needsUpdate = true;

    this.store.set({ screen: 'shop', drive: null, cameraMode: 'orbit', cameraPreset: 'hero' });
    await this.animate(0.28, (k) => this.store.set({ curtain: 1 - k }));
    if (!this.disposed) this.store.set({ busy: null, curtain: 0 });
  }

  /** Repairs all visual mesh deformation and mechanical damage in Drive Mode. */
  repairDriveCar(): void {
    if (!this.driveSession || this.store.get().screen !== 'drive') return;
    this.driveSession.repairCar();
    this.store.set({ drive: this.driveSession.getSnapshot() });
    this.notify('Car repaired to 100%.');
  }

  /** Resets the car to the nearest road (no arg) or warps to a named open-world spot. */
  resetDriveCar(spawnName?: string): void {
    if (!this.driveSession || this.store.get().screen !== 'drive') return;
    this.driveSession.resetCar(spawnName);
    this.store.set({ drive: this.driveSession.getSnapshot() });
    if (!spawnName) this.notify('Reset onto nearest road.');
  }

  /** Cycles through the driving camera angles (`chase` -> `chase-far` -> `hood` -> `bumper` -> `orbit`). */
  cycleDriveCamera(): void {
    if (!this.driveSession || this.store.get().screen !== 'drive') return;
    this.driveSession.cycleCamera();
    this.store.set({ drive: this.driveSession.getSnapshot() });
  }

  /** Toggles headlights & taillights during Open-World Drive Mode. */
  toggleDriveLights(): void {
    if (!this.driveSession || this.store.get().screen !== 'drive') return;
    this.driveSession.toggleLights();
    this.store.set({ drive: this.driveSession.getSnapshot() });
  }

  /** Aims the selector camera at the turntable. */
  private frameSelector(immediate: boolean): void {
    const director = this.director;
    if (!director) return;
    const target = new THREE.Vector3(TURNTABLE.x, 0.62, TURNTABLE.z);
    director.setOrbitLimits({ minDistance: 3.4, maxDistance: 8.6, maxPolar: Math.PI * 0.492, panRadius: 0.9, center: target });
    const distance = clamp(director.distanceToFit(6.4, 2.3), 5.6, 8.4);
    const position = new THREE.Vector3().setFromSphericalCoords(distance, 80 * DEG, 34 * DEG).add(target);
    if (immediate) director.jumpTo(position, target);
    else void director.flyTo(position, target, 0.9);
  }

  private setLiftLoad(): void {
    const { rig, shop } = this;
    if (!rig || !shop) return;
    const halfWidth = rig.size.x / 2;
    const wheelbase = rig.summary.wheelbase ?? rig.size.z * 0.58;
    shop.lift.setLoad({ halfWidth, wheelbase, sillHeight: this.sillHeight(rig, halfWidth, wheelbase) });
  }

  private sillHeight(rig: VehicleRig, halfWidth: number, wheelbase: number): number {
    const pad = TwoPostLift.padLayout(halfWidth, wheelbase);
    let lowest = Infinity;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) lowest = Math.min(lowest, rig.undersideAt(sx * pad.x, sz * pad.z));
    return clamp(lowest, 0.07, 0.45);
  }

  // ------------------------------------------------------------------ build editing

  private commit(next: CarBuild): void {
    if (!this.rig) return;
    this.build = { ...next, updatedAt: new Date().toISOString() };
    this.rig.applyBuild(this.build);
    this.store.set({ build: this.build });
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), SAVE_DELAY_MS);
  }

  private flushSave(): void {
    if (this.saveTimer === undefined) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.build) return;
    if (saveBuild(this.build)) this.store.set({ savedAt: Date.now() });
    else this.notify('This browser would not save the build (storage is full or blocked). Export it to keep it.', 'error');
  }

  /** Paints one zone. Any change marks the zone as modified, which is what overrides its stock material. */
  paintZone(zoneId: string, patch: Partial<PaintZoneState>): void {
    const build = this.build;
    const current = build?.paintZones[zoneId];
    if (!build || !current) return;
    this.commit({ ...build, paintZones: { ...build.paintZones, [zoneId]: { ...current, ...patch, modified: true } } });
  }

  /** Paints every zone of a role at once, for example all the brake calipers. */
  paintZones(zoneIds: string[], patch: Partial<PaintZoneState>): void {
    const build = this.build;
    if (!build) return;
    const paintZones = { ...build.paintZones };
    for (const zoneId of zoneIds) if (paintZones[zoneId]) paintZones[zoneId] = { ...paintZones[zoneId], ...patch, modified: true };
    this.commit({ ...build, paintZones });
  }

  /** Returns zones to the materials the car was imported with. */
  resetZones(zoneIds: string[]): void {
    const build = this.build;
    const rig = this.rig;
    if (!build || !rig) return;
    const stock = rig.stockZoneStates();
    const paintZones = { ...build.paintZones };
    for (const zoneId of zoneIds) if (stock[zoneId]) paintZones[zoneId] = stock[zoneId];
    this.commit({ ...build, paintZones });
  }

  /** Pulses a zone on the car so the user can see which surfaces it covers. */
  flashZone(zoneId: string): void {
    this.rig?.flashZone(zoneId);
  }

  setRimFinish(finish: PaintZoneState | null): void {
    if (this.build) this.commit({ ...this.build, rimFinish: finish ? { ...finish, modified: true } : null });
  }

  setGlassTint(tint: GlassTintConfig | null): void {
    if (this.build) this.commit({ ...this.build, glassTint: tint });
  }

  setPartVisible(partId: string, visible: boolean): void {
    const build = this.build;
    if (build && partId in build.partVisibility) this.commit({ ...build, partVisibility: { ...build.partVisibility, [partId]: visible } });
  }

  setAllPartsVisible(visible: boolean): void {
    const build = this.build;
    if (!build) return;
    this.commit({ ...build, partVisibility: Object.fromEntries(Object.keys(build.partVisibility).map((id) => [id, visible])) });
  }

  setUniversalParts(patch: Partial<UniversalPartsConfig>): void {
    if (this.build) this.commit({ ...this.build, universalParts: { ...this.build.universalParts, ...patch } });
  }

  setStance(patch: Partial<StanceConfig>): void {
    const build = this.build;
    if (!build) return;
    const stance = { ...build.stance };
    for (const key of Object.keys(patch) as (keyof StanceConfig)[]) {
      const value = patch[key];
      if (typeof value === 'number' && Number.isFinite(value)) stance[key] = clamp(value, STANCE_LIMITS[key].min, STANCE_LIMITS[key].max);
    }
    this.commit({ ...build, stance });
    // Ride height moves the sills the lift pads sit under.
    if (patch.rideHeightOffset !== undefined && this.rig && this.shop && !this.onTurntable) {
      const wheelbase = this.rig.summary.wheelbase ?? this.rig.size.z * 0.58;
      this.shop.lift.updateSill(this.sillHeight(this.rig, this.rig.size.x / 2, wheelbase));
    }
  }

  setLights(on: boolean): void {
    if (this.build) this.commit({ ...this.build, lightsOn: on });
  }

  renameBuild(name: string): void {
    const trimmed = name.trim().slice(0, 80);
    if (this.build && trimmed) this.commit({ ...this.build, buildName: trimmed });
  }

  /** Puts the car back exactly as it was imported and forgets the saved build. */
  resetBuild(): void {
    const { rig, build } = this;
    if (!rig || !build) return;
    this.commit(this.withStockZones(createDefaultBuild(rig.manifest), rig));
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    clearSavedBuild(rig.manifest.id);
    this.store.set({ savedAt: null });
    this.notify('Reset to stock.');
  }

  /** The current build as a JSON file, or `null` when no car is loaded. */
  exportBuild(): { fileName: string; json: string } | null {
    if (!this.build) return null;
    const slug = this.build.buildName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'build';
    return { fileName: `${this.build.carId}.${slug}.build.json`, json: JSON.stringify(this.build, null, 2) };
  }

  /** Applies a build file. Returns an explanation when the file cannot be used, otherwise `null`. */
  importBuild(text: string): string | null {
    const rig = this.rig;
    if (!rig) return 'Load a car before importing a build.';
    const result = parseBuildFile(text, rig.manifest);
    if (!result.ok) return result.error;
    this.commit(this.withStockZones(result.build, rig));
    this.notify(`Imported "${result.build.buildName}".`);
    return null;
  }

  // ------------------------------------------------------------------ shop controls

  setLiftTarget(height: number): void {
    const s = this.store.get();
    if (!this.shop || s.screen !== 'shop' || s.busy) return;
    this.shop.lift.setTarget(height);
  }

  stopLift(): void {
    this.shop?.lift.stop();
  }

  setMood(mood: LightingMoodId): void {
    this.shop?.lighting.setMood(mood);
    this.session.mood = mood;
    saveSession(this.session);
    this.store.set({ mood });
  }

  setCameraMode(mode: CameraMode): void {
    const s = this.store.get();
    if (!this.director || s.screen !== 'shop' || s.busy) return;
    this.director.setMode(mode);
    this.store.set({ cameraMode: mode, cameraPreset: null });
  }

  /** Flies to one of the named camera angles. The underside angle also sends the lift up. */
  goToPreset(preset: CameraPresetId): void {
    const { director, shop, rig } = this;
    const s = this.store.get();
    if (!director || !shop || !rig || s.screen !== 'shop' || s.busy) return;
    if (director.mode !== 'orbit') director.setMode('orbit');
    const liftGoal = preset === 'under' ? shop.lift.maxHeight : shop.lift.target;
    if (preset === 'under') shop.lift.setTarget(liftGoal);
    const pose = this.presetPose(preset, HERO_BAY, preset === 'under' ? liftGoal : shop.lift.height);
    void director.flyTo(pose.position, pose.target, 1.15, pose.fov);
    this.store.set({ cameraMode: 'orbit', cameraPreset: preset });
  }

  /** Tells the camera which parts of the window HUD panels cover, so the car is centered in the rest. */
  setViewInsets(insets: ViewInsets): void {
    this.insets = insets;
    this.director?.setInsets(insets);
  }

  dismissNotice(): void {
    this.store.set({ notice: null });
  }

  /** Renderer memory counters, for confirming that switching cars releases the previous one. */
  debugInfo(): { geometries: number; textures: number; programs: number; hasCar: boolean } {
    const info = this.renderer?.info;
    return { geometries: info?.memory.geometries ?? 0, textures: info?.memory.textures ?? 0, programs: info?.programs?.length ?? 0, hasCar: this.rig !== null };
  }

  /** The loaded car's rig, exposed for the Phase 2 damage simulator bridge. */
  get vehicle(): VehicleRig | null {
    return this.rig;
  }

  // ------------------------------------------------------------------ internals

  private notify(text: string, tone: 'info' | 'error' = 'info', sticky = false): void {
    this.noticeId += 1;
    const id = this.noticeId;
    this.store.set({ notice: { id, tone, text } });
    clearTimeout(this.noticeTimer);
    if (!sticky) this.noticeTimer = setTimeout(() => this.store.get().notice?.id === id && this.store.set({ notice: null }), tone === 'error' ? 7000 : 3200);
  }

  private animate(seconds: number, step: (k: number) => void): Promise<void> {
    return new Promise((resolve) => this.tweens.push({ t: 0, duration: Math.max(0.01, seconds), step, resolve }));
  }

  /** Where the camera goes for a named angle, for a car standing at `base` and raised `lift` meters. */
  private presetPose(preset: CameraPresetId, base: THREE.Vector3, lift: number): { position: THREE.Vector3; target: THREE.Vector3; fov?: number } {
    const director = this.director!;
    const size = this.rig?.size ?? new THREE.Vector3(2, 1.3, 4.6);
    const [w, h, l] = [size.x, size.y, size.z];
    const target = new THREE.Vector3(base.x, lift + h * 0.42, base.z);
    const position = new THREE.Vector3();
    const orbit = (distance: number, polarDeg: number, azimuthDeg: number) => position.setFromSphericalCoords(distance, polarDeg * DEG, azimuthDeg * DEG).add(target);

    switch (preset) {
      case 'hero':
        target.z += 0.15;
        orbit(director.distanceToFit(l * 0.92 + w * 0.6, h * 1.5), 79, 40);
        break;
      case 'front':
        target.y = lift + h * 0.46;
        orbit(l / 2 + director.distanceToFit(w * 1.2, h * 1.5), 84, 0);
        break;
      case 'rear':
        target.y = lift + h * 0.46;
        orbit(l / 2 + director.distanceToFit(w * 1.2, h * 1.5), 82, 180);
        break;
      case 'side':
        orbit(w / 2 + director.distanceToFit(l * 1.1, h * 1.6), 85, 90);
        break;
      case 'wheel': {
        const wheel = this.rig?.wheelPosition('FL');
        if (wheel) target.set(wheel.x, wheel.y - (this.shop?.lift.height ?? 0) + lift, wheel.z);
        else target.set(base.x + w * 0.45, lift + 0.34, base.z + l * 0.3);
        position.set(target.x + 1.75, target.y + 0.22, target.z + 1.05);
        break;
      }
      case 'under':
        // Down on the floor ahead of the car, looking up at the whole floorpan through a wider lens.
        target.set(base.x, lift + 0.1, base.z);
        position.set(base.x + 2.2, 0.36, base.z + l / 2 + 2.1);
        clampToShop(position, 0.3);
        return { position, target, fov: 46 };
      case 'top': {
        // Straight down through a wide lens, from just under the light grid, with the car lying across the frame.
        const fov = 64;
        target.y = lift + h * 0.3;
        const room = TOP_VIEW_HEIGHT - target.y;
        orbit(Math.min(room, director.distanceToFit(l * 1.1, w * 1.45, fov)), 1.2, 90);
        clampToShop(position, 0.3);
        return { position, target, fov };
      }
    }
    clampToShop(position, 0.3);
    return { position, target };
  }

  /**
   * Fades whichever part of the lift stands between the camera and the car. A two-post lift's columns
   * sit right beside the doors, so without this every side-on view has a post through the middle of it.
   */
  private ghostLift(dt: number, inShop: boolean): void {
    const { shop, director, rig } = this;
    if (!shop || !director) return;
    const lift = shop.lift;
    const cam = director.camera.position;
    const halfLength = (rig?.size.z ?? 4.6) / 2;
    const halfWidth = (rig?.size.x ?? 2) / 2;
    for (const [part, side] of [
      ['left', 1],
      ['right', -1],
    ] as const) {
      const cx = side * LIFT.columnX;
      let blocking = false;
      if (inShop && rig) {
        if (Math.hypot(cam.x - cx, cam.z) < 0.75) blocking = true;
        // Does any sight line from the camera to the near flank of the car pass through the column?
        for (let i = 0; i <= 6 && !blocking; i++) {
          for (const x of [side * halfWidth * 0.9, 0]) {
            const z = -halfLength + (i / 6) * halfLength * 2;
            const dx = x - cam.x;
            const dz = z - cam.z;
            const t = ((cx - cam.x) * dx + -cam.z * dz) / (dx * dx + dz * dz);
            if (t <= 0.02 || t >= 0.98) continue;
            if (Math.hypot(cam.x + dx * t - cx, cam.z + dz * t) < 0.27) blocking = true;
          }
        }
      }
      lift.setOpacity(part, damp(lift.opacityOf(part), blocking ? 0.14 : 1, 9, dt));
    }
    const above = inShop && cam.y > LIFT.columnHeight - 0.6 && Math.hypot(cam.x, cam.z) < 6.5;
    lift.setOpacity('beam', damp(lift.opacityOf('beam'), above ? 0.1 : 1, 9, dt));
  }

  private applyOrbitLimits(): void {
    const director = this.director;
    const lift = this.shop?.lift.height ?? 0;
    if (!director) return;
    director.setOrbitLimits({
      minDistance: 1.3,
      maxDistance: 26,
      // With the car in the air the camera may look up at it from underneath.
      maxPolar: Math.PI * lerp(0.494, 0.82, smoothstep(0.15, 1.0, lift)),
      panRadius: 4.5,
      center: new THREE.Vector3(HERO_BAY.x, lift + 0.6, HERO_BAY.z),
    });
  }

  private readonly frame = (timeMs: number): void => {
    const { renderer, shop, director } = this;
    if (!renderer || !shop || !director) return;
    this.now = timeMs / 1000;
    const elapsed = this.now - this.lastFrame;
    // Simulation steps are capped so a stall cannot fling anything. Timed moves (the roll-in, camera
    // flights, fades) follow the real clock instead, so they still take their set time when frames are
    // scarce, as they are in a browser panel that is not in front.
    const dt = clamp(elapsed, 0.001, 0.05);
    const clock = clamp(elapsed, 0.001, 1);
    this.lastFrame = this.now;
    this.frameTimes[this.frameIndex++ % this.frameTimes.length] = elapsed;
    const s = this.store.get();

    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const tween = this.tweens[i];
      tween.t = Math.min(1, tween.t + clock / tween.duration);
      tween.step(tween.t);
      if (tween.t >= 1) {
        this.tweens.splice(i, 1);
        tween.resolve();
      }
    }

    if (this.driveSession) {
      if (s.screen === 'drive' && s.busy !== 'exiting-drive') {
        const nextDrive = this.driveSession.update(dt);
        if (nextDrive) this.store.set({ drive: nextDrive });
      }
      renderer.render(this.scene, this.driveSession.camera);
      this.updatePerfStats(renderer);
      return;
    }

    // The turntable keeps turning unless the user has just been looking around.
    if (this.onTurntable && !s.busy) {
      const idle = this.now - this.lastUserMove > IDLE_BEFORE_SPIN;
      this.turntableSpeed = damp(this.turntableSpeed, idle && this.rig ? TURNTABLE_SPEED : 0, idle ? 1.4 : 6, dt);
      this.turntableAngle += this.turntableSpeed * dt;
    }
    shop.setTurntableAngle(this.turntableAngle);

    const liftMoving = shop.lift.update(dt);
    const lift = shop.lift.height;
    const rig = this.rig;
    let shadowsDirty = liftMoving;
    if (rig) {
      const heading = this.onTurntable ? this.turntableAngle : 0;
      rig.root.position.set(0, this.onTurntable ? 0 : lift, this.carZ);
      rig.root.rotation.y = heading;
      rig.setLiftHeight(this.onTurntable ? 0 : lift);
      rig.update(dt);
      shop.setCarShadow(rig.root.position, heading, { width: rig.size.x, length: rig.size.z }, this.onTurntable ? 0 : lift);
      const pose = `${heading.toFixed(4)}:${this.carZ.toFixed(3)}:${lift.toFixed(4)}`;
      if (pose !== this.lastPose) {
        this.lastPose = pose;
        shadowsDirty = true;
      }
      if (rig.consumeShadowDirty()) shadowsDirty = true;
    }

    if (s.screen === 'shop') {
      if (lift !== this.lastLift) {
        if (director.mode === 'orbit') director.nudgeTarget((lift - this.lastLift) * 0.85);
        this.applyOrbitLimits();
      }
      // Walking stops at the car while it is on the floor; raised, you can walk underneath it.
      director.obstacle = rig && lift < 1.3 ? new THREE.Box2(new THREE.Vector2(-rig.size.x / 2 - 0.3, -rig.size.z / 2 - 0.3), new THREE.Vector2(rig.size.x / 2 + 0.3, rig.size.z / 2 + 0.3)) : null;
    } else director.obstacle = null;
    this.lastLift = lift;
    this.ghostLift(dt, s.screen === 'shop');

    shop.lighting.setFocus(_focus.set(0, 0, this.carZ), this.onTurntable ? 0 : lift);
    if (shop.lighting.update(dt, rig ? [rig.root] : [])) shadowsDirty = true;
    director.update(dt, clock);

    if (shadowsDirty) renderer.shadowMap.needsUpdate = true;
    renderer.render(this.scene, director.camera);

    const liftState = s.lift;
    const height = Math.round(lift * 200) / 200;
    if (liftState.height !== height || liftState.moving !== shop.lift.moving || liftState.target !== shop.lift.target) {
      this.store.set({ lift: { height, target: shop.lift.target, max: shop.lift.maxHeight, moving: shop.lift.moving } });
    }

    this.updatePerfStats(renderer);
  };

  private updatePerfStats(renderer: THREE.WebGLRenderer): void {
    if (this.now - this.statsSince >= 0.5 && this.frameIndex >= this.frameTimes.length) {
      // The median frame time: what the picture actually runs at, ignoring one-off stalls.
      const median = Float32Array.from(this.frameTimes).sort()[this.frameTimes.length >> 1];
      const fps = Math.round(1 / Math.max(median, 1e-4));
      this.statsSince = this.now;
      const perf = this.store.get().perf;
      const drawCalls = renderer.info.render.calls;
      const triangles = renderer.info.render.triangles;
      if (perf.fps !== fps || perf.drawCalls !== drawCalls || perf.triangles !== triangles) this.store.set({ perf: { fps, drawCalls, triangles } });
    }
  }
}

const _focus = new THREE.Vector3();
