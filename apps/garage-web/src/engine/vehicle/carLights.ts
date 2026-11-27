import * as THREE from 'three';
import type { VehicleManifest } from '@blend-garage/vehicle-core';
import { damp } from '../math';
import type { MeshRecord } from './analysis';
import type { PaintBooth } from './paint';

/** Whole words only: a bare `led` would also match "molded", "sealed" and "pressed". */
const LAMP_WORDS = /(^|[^a-z])(lamps?|lights?|headlights?|taillights?|headlamps?|taillamps?|brakelights?|leds?|drl|optics?|reflectors?|bulbs?|projectors?|halo|hid|xenon|emitters?|ruby|tail)([^a-z]|$)/;
/** Parts of a lamp unit that hold or cover the light rather than being it. */
const NOT_A_LAMP = /(black|enclosure|bezel|housing|gasket|rubber|graphite|shadow|carrier|surround|trim|seal|bracket|frame|cover|shell|glass|smoked|dark|carbon|polymer|amber|indicator|interior|cabin)/;

const HEAD_ON = new THREE.Color(1.0, 0.95, 0.86).multiplyScalar(3.4);
const TAIL_ON = new THREE.Color(1.0, 0.05, 0.03).multiplyScalar(2.6);
const BAR_OFF = new THREE.Color(0x3a3d40);
const BAR_ON = new THREE.Color(1.0, 0.96, 0.88).multiplyScalar(6);

function isReddish(c: THREE.Color): boolean {
  return c.r > 0.05 && c.r > c.g * 1.8 && c.r > c.b * 1.8;
}

function isBright(c: THREE.Color): boolean {
  return c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722 > 0.28;
}

export interface CarLightsOptions {
  manifest: VehicleManifest;
  records: MeshRecord[];
  booth: PaintBooth;
  materialsByName: Map<string, THREE.Material[]>;
  bounds: THREE.Box3;
  /** Soft round sprite and the cone gradient, both shared with the shop. */
  glowTexture: THREE.Texture;
  beamTexture: THREE.Texture;
  /** Lens material of the optional roof lightbar. */
  barLens: THREE.MeshBasicMaterial;
}

/**
 * Headlights and taillights: makes the car's own lamp materials glow, and adds the things a material
 * alone cannot do (a soft halo on each lamp, a faint beam cone, and real light on the floor ahead).
 */
export class CarLights {
  /** Everything to hide while baking reflections, so the car's lights do not print onto itself. */
  readonly effects = new THREE.Group();
  readonly hasHeadlights: boolean;
  readonly hasTaillights: boolean;

  private readonly heads: THREE.Material[] = [];
  private readonly tails: THREE.Material[] = [];
  private readonly sprites: { sprite: THREE.Sprite; scale: number }[] = [];
  private readonly spriteMaterials: THREE.SpriteMaterial[] = [];
  private readonly cones: THREE.Mesh[] = [];
  private readonly coneMaterial: THREE.MeshBasicMaterial;
  private readonly spot = new THREE.SpotLight(0xfff1dc, 0, 24, 0.5, 0.85, 2);
  private readonly tailLight = new THREE.PointLight(0xff2a14, 0, 5, 2);
  private readonly booth: PaintBooth;
  private readonly barLens: THREE.MeshBasicMaterial;
  private level = 0;
  private goal = 0;
  private barFitted = false;

  constructor(options: CarLightsOptions) {
    const { manifest, records, booth, materialsByName, bounds } = options;
    this.booth = booth;
    this.barLens = options.barLens;
    this.effects.name = 'car light effects';
    const halfLength = (bounds.max.z - bounds.min.z) / 2;
    const roles = new Map(manifest.materialZones.map((z) => [z.materialName, z.role]));

    // Where each material sits on the car.
    const where = new Map<string, { z: number; n: number; left: THREE.Vector3; right: THREE.Vector3; nl: number; nr: number }>();
    for (const r of records) {
      const key = (r.mesh.material as THREE.Material).name;
      let w = where.get(key);
      if (!w) {
        w = { z: 0, n: 0, left: new THREE.Vector3(), right: new THREE.Vector3(), nl: 0, nr: 0 };
        where.set(key, w);
      }
      w.z += r.center.z;
      w.n += 1;
      if (r.center.x >= 0) {
        w.left.add(r.center);
        w.nl += 1;
      } else {
        w.right.add(r.center);
        w.nr += 1;
      }
    }

    const headAnchors = { left: new THREE.Vector3(), right: new THREE.Vector3(), nl: 0, nr: 0 };
    const tailAnchors = { left: new THREE.Vector3(), right: new THREE.Vector3(), nl: 0, nr: 0 };
    for (const [name, materials] of materialsByName) {
      const w = where.get(name);
      const physical = materials.find((m): m is THREE.MeshPhysicalMaterial => m instanceof THREE.MeshPhysicalMaterial);
      if (!w || !physical || physical.userData.glass) continue;
      // Split camelCase first so "RedLamp" reads as the two words it is.
      const lower = name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
      const role = roles.get(name);
      const z = w.z / w.n;
      const named = LAMP_WORDS.test(lower) && !NOT_A_LAMP.test(lower);
      const head = (role === 'headlight' || (named && z > halfLength * 0.5)) && !NOT_A_LAMP.test(lower) && isBright(physical.color) && !isReddish(physical.color);
      const tail = !head && (role === 'taillight' || (named && z < -halfLength * 0.5)) && !/(black|bezel|housing|gasket|rubber|graphite|shadow|glass|cover|shell)/.test(lower) && isReddish(physical.color);
      if (!head && !tail) continue;
      (head ? this.heads : this.tails).push(...materials);
      const anchors = head ? headAnchors : tailAnchors;
      anchors.left.add(w.left);
      anchors.nl += w.nl;
      anchors.right.add(w.right);
      anchors.nr += w.nr;
    }
    this.hasHeadlights = this.heads.length > 0;
    this.hasTaillights = this.tails.length > 0;

    // Halo positions: on the lamps when the car has identifiable ones, otherwise at the usual corners.
    const halfWidth = (bounds.max.x - bounds.min.x) / 2;
    const lampY = Math.min(0.72, bounds.max.y * 0.52);
    const place = (anchors: typeof headAnchors, side: 1 | -1, z: number): THREE.Vector3 => {
      const sum = side === 1 ? anchors.left : anchors.right;
      const n = side === 1 ? anchors.nl : anchors.nr;
      const p = n > 0 ? sum.clone().divideScalar(n) : new THREE.Vector3(side * halfWidth * 0.66, lampY, z);
      // Halos belong on the surface, not buried inside the lamp unit.
      p.z = z > 0 ? Math.max(p.z, z - 0.5) : Math.min(p.z, z + 0.5);
      return p;
    };
    const headL = place(headAnchors, 1, bounds.max.z - 0.12);
    const headR = place(headAnchors, -1, bounds.max.z - 0.12);
    const tailL = place(tailAnchors, 1, bounds.min.z + 0.08);
    const tailR = place(tailAnchors, -1, bounds.min.z + 0.08);

    const halo = (position: THREE.Vector3, color: number, scale: number) => {
      const material = new THREE.SpriteMaterial({ map: options.glowTexture, color, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
      const sprite = new THREE.Sprite(material);
      sprite.position.copy(position);
      sprite.scale.setScalar(0.001);
      sprite.renderOrder = 6;
      this.spriteMaterials.push(material);
      this.sprites.push({ sprite, scale });
      this.effects.add(sprite);
    };
    halo(headL, 0xfff0dc, 0.95);
    halo(headR, 0xfff0dc, 0.95);
    halo(tailL, 0xff2414, 0.62);
    halo(tailR, 0xff2414, 0.62);

    // Faint volumetric cones ahead of each headlight.
    this.coneMaterial = new THREE.MeshBasicMaterial({
      map: options.beamTexture,
      color: 0xfff1dc,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const coneGeometry = new THREE.CylinderGeometry(0.95, 0.07, 5.2, 24, 1, true);
    coneGeometry.translate(0, 2.6, 0);
    coneGeometry.rotateX(Math.PI / 2 + 0.07);
    for (const p of [headL, headR]) {
      const cone = new THREE.Mesh(coneGeometry, this.coneMaterial);
      cone.position.copy(p);
      cone.renderOrder = 5;
      this.cones.push(cone);
      this.effects.add(cone);
    }

    this.spot.position.set(0, (headL.y + headR.y) / 2, bounds.max.z - 0.05);
    this.spot.target.position.set(0, 0.1, bounds.max.z + 9);
    this.tailLight.position.set(0, (tailL.y + tailR.y) / 2, bounds.min.z - 0.25);
    this.effects.add(this.spot, this.spot.target, this.tailLight);
    this.effects.visible = false;
  }

  setOn(on: boolean): void {
    this.goal = on ? 1 : 0;
  }

  /** Tells the lights whether a roof lightbar is fitted, so its lenses light up with the headlights. */
  setLightbar(fitted: boolean): void {
    this.barFitted = fitted;
    this.paint();
  }

  /** Fades the lights. Returns true while they are changing. */
  update(dt: number): boolean {
    if (this.level === this.goal) return false;
    this.level = damp(this.level, this.goal, 9, dt);
    if (Math.abs(this.level - this.goal) < 0.004) this.level = this.goal;
    this.paint();
    return true;
  }

  dispose(): void {
    for (const m of this.spriteMaterials) m.dispose();
    this.coneMaterial.dispose();
    this.cones[0]?.geometry.dispose();
    this.effects.removeFromParent();
  }

  private paint(): void {
    const k = this.level;
    this.effects.visible = k > 0.001;
    for (const m of this.heads) this.booth.setLamp(m, k > 0.001 ? _lamp.copy(HEAD_ON).multiplyScalar(k).clone() : null);
    for (const m of this.tails) this.booth.setLamp(m, k > 0.001 ? _lamp.copy(TAIL_ON).multiplyScalar(k).clone() : null);
    for (const { sprite, scale } of this.sprites) {
      (sprite.material as THREE.SpriteMaterial).opacity = 0.85 * k;
      sprite.scale.setScalar(Math.max(0.001, scale * (0.6 + 0.4 * k)));
    }
    this.coneMaterial.opacity = 0.085 * k;
    this.spot.intensity = 170 * k;
    this.tailLight.intensity = 5 * k;
    this.barLens.color.copy(BAR_OFF).lerp(BAR_ON, this.barFitted ? k : 0);
  }
}

const _lamp = new THREE.Color();
