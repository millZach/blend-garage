import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../math';
import type { LightingMoodId } from '../types';
import { BOOTH, DOOR, HALL } from './layout';
import type { Glow, ShopMaterials } from './materials';
import { WORKLIGHTS } from './props';

type GlowKey = keyof ShopMaterials['glow'];
type Tone = readonly [color: number, intensity: number];

/** One complete lighting setup. Every value is numeric so two setups can be blended. */
interface MoodDef {
  exposure: number;
  hemi: readonly [sky: number, ground: number, intensity: number];
  key: Tone;
  /** Where the shadow-casting key light sits relative to the car. */
  keyOffset: readonly [number, number, number];
  work: Tone;
  rim: Tone;
  glow: Record<GlowKey, Tone>;
  sky: readonly [zenith: number, horizon: number];
  sunPatch: Tone;
  environment: number;
}

const MOODS: Record<LightingMoodId, MoodDef> = {
  daylight: {
    exposure: 1.0,
    hemi: [0xe3ecf7, 0xb9b5ab, 0.85],
    key: [0xfff3df, 2.3],
    keyOffset: [3.2, 9.5, 4.6],
    work: [0xffd9a8, 0],
    rim: [0xe9f1ff, 0],
    glow: {
      ledBay: [0xf3f6ff, 8],
      hexGrid: [0xeef3ff, 1.4],
      skylight: [0xdcebff, 2.4],
      clerestory: [0xc4dcfa, 1.45],
      doorGlass: [0xcfe2fb, 1.5],
      softbox: [0xffffff, 2.0],
      worklamp: [0xffd9a0, 0.12],
      liftLed: [0xeaf2ff, 0.7],
      streetLamp: [0xffffff, 0.05],
    },
    sky: [0x3f86d8, 0xb5d3f1],
    sunPatch: [0xfff4dc, 0.3],
    environment: 1.0,
  },
  studio: {
    exposure: 1.02,
    hemi: [0xe9eef5, 0x25272b, 0.3],
    key: [0xffffff, 1.5],
    keyOffset: [1.4, 10, 2.2],
    work: [0xffffff, 0],
    rim: [0xeaf2ff, 60],
    glow: {
      ledBay: [0xeef3ff, 0.7],
      hexGrid: [0xf3f7ff, 13],
      skylight: [0x0d1626, 0.3],
      clerestory: [0x101a2c, 0.3],
      doorGlass: [0x101a2c, 0.3],
      softbox: [0xffffff, 3.6],
      worklamp: [0xffd9a0, 0.02],
      liftLed: [0xdfeaff, 3],
      streetLamp: [0xffd8a0, 4],
    },
    sky: [0x070c18, 0x1b2a44],
    sunPatch: [0xbdd0ff, 0.03],
    environment: 1.1,
  },
  night: {
    exposure: 1.18,
    hemi: [0x34435f, 0x15120f, 0.2],
    key: [0x9db4dc, 0.3],
    keyOffset: [-3.5, 9.5, -2],
    work: [0xffb565, 150],
    rim: [0x9fc0ff, 34],
    glow: {
      ledBay: [0xffdcb4, 0.22],
      hexGrid: [0xdde8ff, 0.03],
      skylight: [0x0a1326, 0.3],
      clerestory: [0x101c35, 0.4],
      doorGlass: [0x101c35, 0.45],
      softbox: [0xdfe8ff, 0.03],
      worklamp: [0xffc67a, 20],
      liftLed: [0xbcd4ff, 5],
      streetLamp: [0xffcf8a, 12],
    },
    sky: [0x02050d, 0x0e1830],
    sunPatch: [0xffcf8a, 0.09],
    environment: 0.95,
  },
  golden: {
    exposure: 1.04,
    hemi: [0xffe6cc, 0x6a5444, 0.52],
    key: [0xffb46e, 2.9],
    keyOffset: [-2.6, 4.4, 9.5],
    work: [0xffd9a8, 0],
    rim: [0xffd0a0, 0],
    glow: {
      ledBay: [0xffecd8, 2.6],
      hexGrid: [0xffe9d0, 0.6],
      skylight: [0xffb877, 3.0],
      clerestory: [0xffa860, 3.4],
      doorGlass: [0xffb469, 3.8],
      softbox: [0xffe8cf, 0.9],
      worklamp: [0xffd9a0, 0.3],
      liftLed: [0xffe0c0, 0.8],
      streetLamp: [0xffd8a0, 0.4],
    },
    sky: [0x3f6fb0, 0xffb46b],
    sunPatch: [0xffab58, 0.62],
    environment: 1.0,
  },
};

/** Clean studio lighting used while the car is on the turntable, whatever mood the hall is in. */
const PHOTO_BAY = {
  exposure: 1.0,
  hemi: [0xffffff, 0x2e3237, 0.5] as const,
  key: [0xffffff, 2.3] as Tone,
  keyOffset: [2.6, 9, 4.2] as const,
  softbox: [0xffffff, 2.6] as Tone,
  environment: 0.9,
};

/** A blendable, fully resolved lighting state. */
class LightState {
  exposure = 1;
  hemiSky = new THREE.Color();
  hemiGround = new THREE.Color();
  hemiIntensity = 0;
  keyColor = new THREE.Color();
  keyIntensity = 0;
  keyOffset = new THREE.Vector3();
  workColor = new THREE.Color();
  workIntensity = 0;
  rimColor = new THREE.Color();
  rimIntensity = 0;
  glow = new Map<GlowKey, { color: THREE.Color; intensity: number }>();
  zenith = new THREE.Color();
  horizon = new THREE.Color();
  sunColor = new THREE.Color();
  sunOpacity = 0;
  environment = 1;

  setFromMood(def: MoodDef, photoBay: number): this {
    const p = photoBay;
    this.exposure = lerp(def.exposure, PHOTO_BAY.exposure, p);
    this.hemiSky.setHex(def.hemi[0]).lerp(_c.setHex(PHOTO_BAY.hemi[0]), p);
    this.hemiGround.setHex(def.hemi[1]).lerp(_c.setHex(PHOTO_BAY.hemi[1]), p);
    this.hemiIntensity = lerp(def.hemi[2], PHOTO_BAY.hemi[2], p);
    this.keyColor.setHex(def.key[0]).lerp(_c.setHex(PHOTO_BAY.key[0]), p);
    this.keyIntensity = lerp(def.key[1], PHOTO_BAY.key[1], p);
    this.keyOffset.set(...def.keyOffset).lerp(_v.set(...PHOTO_BAY.keyOffset), p);
    this.workColor.setHex(def.work[0]);
    this.workIntensity = def.work[1] * (1 - p);
    this.rimColor.setHex(def.rim[0]);
    this.rimIntensity = def.rim[1] * (1 - p);
    for (const key of Object.keys(def.glow) as GlowKey[]) {
      const entry = this.glow.get(key) ?? { color: new THREE.Color(), intensity: 0 };
      entry.color.setHex(def.glow[key][0]);
      entry.intensity = def.glow[key][1];
      if (key === 'softbox') {
        entry.color.lerp(_c.setHex(PHOTO_BAY.softbox[0]), p);
        entry.intensity = lerp(entry.intensity, PHOTO_BAY.softbox[1], p);
      }
      this.glow.set(key, entry);
    }
    this.zenith.setHex(def.sky[0]);
    this.horizon.setHex(def.sky[1]);
    this.sunColor.setHex(def.sunPatch[0]);
    this.sunOpacity = def.sunPatch[1];
    this.environment = lerp(def.environment, PHOTO_BAY.environment, p);
    return this;
  }

  /** Moves this state toward `to` by `t`. */
  approach(to: LightState, t: number): void {
    this.exposure = lerp(this.exposure, to.exposure, t);
    this.hemiSky.lerp(to.hemiSky, t);
    this.hemiGround.lerp(to.hemiGround, t);
    this.hemiIntensity = lerp(this.hemiIntensity, to.hemiIntensity, t);
    this.keyColor.lerp(to.keyColor, t);
    this.keyIntensity = lerp(this.keyIntensity, to.keyIntensity, t);
    this.keyOffset.lerp(to.keyOffset, t);
    this.workColor.lerp(to.workColor, t);
    this.workIntensity = lerp(this.workIntensity, to.workIntensity, t);
    this.rimColor.lerp(to.rimColor, t);
    this.rimIntensity = lerp(this.rimIntensity, to.rimIntensity, t);
    for (const [key, target] of to.glow) {
      const entry = this.glow.get(key);
      if (!entry) {
        this.glow.set(key, { color: target.color.clone(), intensity: target.intensity });
        continue;
      }
      entry.color.lerp(target.color, t);
      entry.intensity = lerp(entry.intensity, target.intensity, t);
    }
    this.zenith.lerp(to.zenith, t);
    this.horizon.lerp(to.horizon, t);
    this.sunColor.lerp(to.sunColor, t);
    this.sunOpacity = lerp(this.sunOpacity, to.sunOpacity, t);
    this.environment = lerp(this.environment, to.environment, t);
  }
}

const _c = new THREE.Color();
const _v = new THREE.Vector3();

export type EnvStage = 'photo-bay' | 'hero-bay';

/**
 * Owns every light in the shop, the four moods, and the reflection environment. Reflections are baked
 * from the shop itself (PMREM), so the car's clearcoat mirrors the real light fixtures around it.
 */
export class LightingRig {
  readonly group = new THREE.Group();
  mood: LightingMoodId = 'daylight';

  private readonly hemi = new THREE.HemisphereLight();
  private readonly key = new THREE.DirectionalLight();
  private readonly work: THREE.SpotLight[] = [];
  private readonly rim = new THREE.SpotLight(0xffffff, 0, 30, 0.5, 0.8, 2);
  private readonly under = new THREE.PointLight(0xeaf2ff, 0, 7, 2);
  private readonly skyDome: THREE.Mesh;
  private readonly sunPatch: THREE.Mesh;
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly environments = new Map<string, THREE.WebGLRenderTarget>();

  private readonly current = new LightState();
  private readonly target = new LightState();
  private readonly scratch = new LightState();
  private photoBay = 1;
  private photoBayTarget = 1;
  private settled = false;
  private envStage: EnvStage = 'photo-bay';
  private appliedEnv = '';
  private readonly focus = new THREE.Vector3();
  private liftHeight = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly renderer: THREE.WebGLRenderer,
    private readonly materials: ShopMaterials,
  ) {
    this.group.name = 'lighting';
    this.pmrem = new THREE.PMREMGenerator(renderer);

    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    const cam = this.key.shadow.camera;
    cam.left = -6.2;
    cam.right = 6.2;
    cam.top = 6.2;
    cam.bottom = -6.2;
    cam.near = 1;
    cam.far = 40;
    this.key.shadow.bias = -0.00025;
    this.key.shadow.normalBias = 0.03;
    this.key.shadow.radius = 3.5;
    this.group.add(this.hemi, this.key, this.key.target);

    for (const spot of WORKLIGHTS) {
      const light = new THREE.SpotLight(0xffffff, 0, 18, 0.66, 0.75, 2);
      light.position.set(spot.x, spot.height, spot.z);
      this.work.push(light);
      this.group.add(light, light.target);
    }
    this.rim.position.set(-1.5, 6.4, -8.2);
    this.group.add(this.rim, this.rim.target, this.under);

    // Sky seen through the open door: a dome whose vertex colors run horizon to zenith.
    const dome = new THREE.SphereGeometry(190, 24, 12);
    dome.setAttribute('color', new THREE.BufferAttribute(new Float32Array(dome.attributes.position.count * 3), 3));
    this.skyDome = new THREE.Mesh(dome, materials.sky);
    this.skyDome.name = 'sky';
    this.skyDome.renderOrder = -10;
    this.skyDome.frustumCulled = false;

    // Light spilling across the floor from the open door.
    const patch = new THREE.PlaneGeometry(DOOR.width + 0.6, 8.5);
    patch.rotateX(-Math.PI / 2);
    this.sunPatch = new THREE.Mesh(patch, materials.sunPatch);
    this.sunPatch.position.set(0, 0.008, HALL.maxZ - 4.25);
    this.sunPatch.renderOrder = 2;
    this.group.add(this.skyDome, this.sunPatch);

    this.target.setFromMood(MOODS[this.mood], this.photoBay);
    this.current.setFromMood(MOODS[this.mood], this.photoBay);
    this.apply(this.current);
  }

  setMood(mood: LightingMoodId): void {
    this.mood = mood;
    this.settled = false;
  }

  /** 1 while the car is on the turntable, 0 once it is in the hero bay. */
  setPhotoBay(amount: number, immediate = false): void {
    this.photoBayTarget = clamp(amount, 0, 1);
    if (immediate) this.photoBay = this.photoBayTarget;
    this.settled = false;
  }

  /** Which place the reflections should be baked from. */
  setEnvStage(stage: EnvStage): void {
    if (stage !== this.envStage) {
      this.envStage = stage;
      this.settled = false;
    }
  }

  /** The car's position: the key light, its shadow and the worklights all aim here. */
  setFocus(position: THREE.Vector3, liftHeight: number): void {
    this.focus.copy(position);
    this.liftHeight = liftHeight;
  }

  /**
   * Advances mood transitions and re-aims the lights. `hidden` lists objects (the car, its light
   * effects) that must not appear in baked reflections. Returns true while the lighting is changing.
   */
  update(dt: number, hidden: THREE.Object3D[]): boolean {
    let changing = false;
    if (this.photoBay !== this.photoBayTarget) {
      const step = dt / 1.6;
      this.photoBay = this.photoBayTarget > this.photoBay ? Math.min(this.photoBayTarget, this.photoBay + step) : Math.max(this.photoBayTarget, this.photoBay - step);
      this.settled = false;
    }
    if (!this.settled) {
      this.target.setFromMood(MOODS[this.mood], smoothstep(0, 1, this.photoBay));
      this.current.approach(this.target, 1 - Math.exp(-dt * 5.5));
      const close = Math.abs(this.current.exposure - this.target.exposure) < 0.002 && Math.abs(this.current.keyIntensity - this.target.keyIntensity) < 0.01 && this.photoBay === this.photoBayTarget;
      if (close) {
        this.current.approach(this.target, 1);
        this.settled = true;
      }
      this.apply(this.current);
      changing = true;
    }

    const envKey = `${this.mood}:${this.envStage}`;
    if (envKey !== this.appliedEnv) {
      this.scene.environment = this.environmentFor(this.mood, this.envStage, hidden);
      this.appliedEnv = envKey;
      changing = true;
    }

    // Aim at the car.
    const carY = this.focus.y + this.liftHeight;
    this.key.target.position.set(this.focus.x, carY * 0.5, this.focus.z);
    this.key.position.copy(this.key.target.position).add(this.current.keyOffset);
    for (const light of this.work) light.target.position.set(this.focus.x, carY + 0.55, this.focus.z);
    this.rim.target.position.set(this.focus.x, carY + 0.6, this.focus.z);
    // Under-car inspection light fades up as the lift rises.
    this.under.position.set(this.focus.x, Math.max(0.3, this.liftHeight - 0.95), this.focus.z + 0.2);
    this.under.intensity = smoothstep(0.35, 1.3, this.liftHeight) * 24;
    this.materials.glow.liftLed.set(_c.copy(this.current.glow.get('liftLed')!.color), this.current.glow.get('liftLed')!.intensity + smoothstep(0.3, 1.2, this.liftHeight) * 4);
    return changing;
  }

  dispose(): void {
    for (const target of this.environments.values()) target.dispose();
    this.environments.clear();
    this.pmrem.dispose();
    this.skyDome.geometry.dispose();
    this.sunPatch.geometry.dispose();
    this.key.shadow.map?.dispose();
    this.scene.environment = null;
    this.group.removeFromParent();
  }

  private apply(s: LightState): void {
    this.renderer.toneMappingExposure = s.exposure;
    this.hemi.color.copy(s.hemiSky);
    this.hemi.groundColor.copy(s.hemiGround);
    this.hemi.intensity = s.hemiIntensity;
    this.key.color.copy(s.keyColor);
    this.key.intensity = s.keyIntensity;
    for (const light of this.work) {
      light.color.copy(s.workColor);
      light.intensity = s.workIntensity;
    }
    this.rim.color.copy(s.rimColor);
    this.rim.intensity = s.rimIntensity;
    for (const [key, value] of s.glow) (this.materials.glow[key] as Glow).set(value.color, value.intensity);
    this.materials.sunPatch.color.copy(s.sunColor);
    this.materials.sunPatch.opacity = s.sunOpacity;
    this.scene.environmentIntensity = s.environment;

    const colors = this.skyDome.geometry.attributes.color as THREE.BufferAttribute;
    const positions = this.skyDome.geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      const t = smoothstep(-0.02, 0.55, positions.getY(i) / 190);
      _c.copy(s.horizon).lerp(s.zenith, t);
      colors.setXYZ(i, _c.r, _c.g, _c.b);
    }
    colors.needsUpdate = true;
  }

  /** Bakes (once per mood and place) what the car would mirror: the shop as it is lit right now. */
  private environmentFor(mood: LightingMoodId, stage: EnvStage, hidden: THREE.Object3D[]): THREE.Texture {
    const cacheKey = `${mood}:${stage}`;
    let baked = this.environments.get(cacheKey);
    if (!baked) {
      const inBooth = stage === 'photo-bay';
      // Light the shop exactly as it will be once the transition has finished, bake, then restore.
      this.apply(this.scratch.setFromMood(MOODS[mood], inBooth ? 1 : 0));
      const visibility = hidden.map((o) => o.visible);
      for (const o of hidden) o.visible = false;
      const previous = this.scene.environment;
      this.scene.environment = null;
      const position = new THREE.Vector3(0, 1.15, inBooth ? BOOTH.turntableZ : 0);
      // A little blur keeps mirror-sharp light fixtures from exaggerating every ripple in a car's panels.
      baked = this.pmrem.fromScene(this.scene, 0.036, 0.1, 400, { size: 256, position });
      this.scene.environment = previous;
      hidden.forEach((o, i) => (o.visible = visibility[i]));
      this.environments.set(cacheKey, baked);
      this.apply(this.current);
    }
    return baked.texture;
  }
}
