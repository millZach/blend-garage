import * as THREE from 'three';
import { angleDelta, clamp, lerp, smoothstep } from '../math';
import { MeshBatcher } from '../MeshBatcher';
import { LIFT } from './layout';
import type { ShopMaterials } from './materials';

/** What the lift needs to know about the car standing between its columns. */
export interface LiftLoad {
  /** Half the body width, meters. */
  halfWidth: number;
  /** Distance between the axles, meters. */
  wheelbase: number;
  /** Height of the sills above the floor where the pads meet them. */
  sillHeight: number;
}

const ARM_REST = 0.085; // pad-top height with the arms resting on the floor
const ARM_OUTER = 0.8;
const ARM_INNER = 0.8;
const ARM_PARKED_REACH = 0.86;
const ARM_MAX_REACH = 1.55;
const PIVOT_INSET = 0.24;
const PIVOT_Z = 0.17;
const ARM_TUBE_Y = 0.045; // center height of an arm tube resting on the floor
const PAD_BASE = 0.03; // where the screw pad starts, above the tube's center
const CARRIAGE_DROP = 0.22; // carriage center above the arm tubes

interface Arm {
  root: THREE.Group;
  inner: THREE.Mesh;
  pad: THREE.Group;
  stem: THREE.Mesh;
  /** Pad plate and its rubber face, which ride on top of the stem. */
  plate: THREE.Group;
  side: 1 | -1;
  end: 1 | -1;
}

/** The pieces of the lift that can block the view of the car: the +X column, the -X column, the overhead beam. */
export type LiftPart = 'left' | 'right' | 'beam';

/**
 * Clear-floor two-post lift: two columns tied by an overhead beam, a carriage on each column, and four
 * telescoping swing arms that reach in under the car's sills. Animated; nothing here knows about cars
 * beyond the three numbers in `LiftLoad`.
 */
export class TwoPostLift {
  static readonly MAX_HEIGHT = LIFT.maxHeight;

  /** Where the four pads meet the sills, as distances out from the lift's center. */
  static padLayout(halfWidth: number, wheelbase: number): { x: number; z: number } {
    return { x: clamp(halfWidth - 0.3, 0.48, 1.12), z: clamp(wheelbase * 0.31, 0.55, 1.05) };
  }

  readonly group = new THREE.Group();
  readonly maxHeight = LIFT.maxHeight;
  /** Height of the car above the floor, meters. */
  height = 0;
  target = 0;

  private velocity = 0;
  private engage = 0;
  private engageTarget = 0;
  private load: LiftLoad | null = null;
  private readonly carriages: THREE.Group[] = [];
  private readonly arms: Arm[] = [];
  private readonly owned: THREE.BufferGeometry[] = [];
  /** Parts that can be ghosted when they stand between the camera and the car. */
  private readonly ghosts: Record<LiftPart, { materials: THREE.Material[]; opacity: number }> = {
    left: { materials: [], opacity: 1 },
    right: { materials: [], opacity: 1 },
    beam: { materials: [], opacity: 1 },
  };

  constructor(private readonly m: ShopMaterials) {
    this.group.name = 'two-post lift';
    this.buildStatic();
    this.buildCarriages();
    this.pose();
  }

  /** True once the arms are under the car and it can be raised. */
  get ready(): boolean {
    return this.engage > 0.995 && this.load !== null;
  }

  get moving(): boolean {
    return Math.abs(this.velocity) > 1e-3 || Math.abs(this.target - this.height) > 1e-3;
  }

  get armsMoving(): boolean {
    return Math.abs(this.engageTarget - this.engage) > 1e-3;
  }

  /** Swing the arms in under a car, or pass `null` to park them clear of the bay. */
  setLoad(load: LiftLoad | null): void {
    if (load) {
      this.load = load;
      this.engageTarget = 1;
    } else {
      this.engageTarget = 0;
      this.target = 0;
    }
  }

  /** Updates the sill height (it changes with ride height) without re-swinging the arms. */
  updateSill(sillHeight: number): void {
    if (this.load) this.load = { ...this.load, sillHeight };
  }

  setTarget(height: number): void {
    this.target = clamp(height, 0, this.maxHeight);
  }

  stop(): void {
    this.target = this.height;
  }

  /** Drops the lift and parks the arms immediately, for cut transitions. */
  reset(): void {
    this.height = this.target = this.velocity = 0;
    this.engage = this.engageTarget = 0;
    this.load = null;
    this.pose();
  }

  /** Advances the animation. Returns true while anything is still moving. */
  update(dt: number): boolean {
    let active = false;

    // Arms only swing while the car is on the floor.
    if (this.height < 0.005 && this.engage !== this.engageTarget) {
      const step = dt / 1.1;
      this.engage = this.engageTarget > this.engage ? Math.min(this.engageTarget, this.engage + step) : Math.max(this.engageTarget, this.engage - step);
      if (this.engage === 0 && this.engageTarget === 0) this.load = null;
      active = true;
    }

    const goal = this.ready ? this.target : 0;
    const distance = goal - this.height;
    if (Math.abs(distance) > 1e-4 || Math.abs(this.velocity) > 1e-4) {
      const accel = 0.85;
      const cruise = 0.44;
      const desired = Math.sign(distance) * Math.min(cruise, Math.sqrt(2 * accel * Math.abs(distance)));
      const dv = accel * 1.6 * dt;
      this.velocity = clamp(desired, this.velocity - dv, this.velocity + dv);
      this.height += this.velocity * dt;
      if (Math.abs(goal - this.height) < 0.0015 && Math.abs(this.velocity) < 0.03) {
        this.height = goal;
        this.velocity = 0;
      }
      this.height = clamp(this.height, 0, this.maxHeight);
      active = true;
    }

    if (active) this.pose();
    return active;
  }

  dispose(): void {
    for (const g of this.owned) g.dispose();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh && !this.owned.includes(o.geometry)) o.geometry.dispose();
    });
    for (const ghost of Object.values(this.ghosts)) for (const material of ghost.materials) material.dispose();
    this.group.removeFromParent();
  }

  /**
   * Fades a column or the overhead beam, so it does not hide the car it is holding. 1 is solid.
   */
  setOpacity(part: LiftPart, opacity: number): void {
    const ghost = this.ghosts[part];
    if (Math.abs(ghost.opacity - opacity) < 0.003) return;
    ghost.opacity = opacity;
    for (const material of ghost.materials) {
      material.opacity = opacity;
      material.depthWrite = opacity > 0.97;
    }
  }

  opacityOf(part: LiftPart): number {
    return this.ghosts[part].opacity;
  }

  private mesh(geometry: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Object3D): THREE.Mesh {
    this.owned.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  private buildStatic(): void {
    const m = this.m;
    const cx = LIFT.columnX;
    const top = LIFT.columnHeight;

    // Each ghostable part gets its own copies of the materials, so it can fade on its own.
    const ghostly = (part: LiftPart) => {
      const copies = new Map<THREE.Material, THREE.Material>();
      return <T extends THREE.Material>(material: T): T => {
        let copy = copies.get(material);
        if (!copy) {
          copy = material.clone();
          copy.transparent = true;
          copies.set(material, copy);
          this.ghosts[part].materials.push(copy);
        }
        return copy as T;
      };
    };
    const finish = (b: MeshBatcher, name: string) => this.group.add(b.build(name, { castShadow: true, receiveShadow: true }));

    // Floor plates, hazard pads and the inspection LED strips never fade.
    const base = new MeshBatcher().useWorldUv(m.hazard, 0.5);
    for (const side of [-1, 1] as const) {
      const x = side * cx;
      base.slab(m.steel, 0.56, 0.025, 0.5, x + side * 0.04, 0, 0);
      base.decal(m.hazard, 1.0, 1.0, x + side * 0.12, 0.004, 0);
      base.box(m.glow.liftLed.material, 0.012, 2.6, 0.035, x - side * 0.142, 2.1, 0.19);
    }
    finish(base, 'lift base');

    for (const side of [-1, 1] as const) {
      const g = ghostly(side === 1 ? 'left' : 'right');
      const b = new MeshBatcher();
      const x = side * cx;
      // Column: a C-section, open toward the car, that the carriage runs in.
      b.slab(g(m.blue), 0.06, top, 0.3, x + side * 0.13, 0.025, 0);
      b.slab(g(m.blue), 0.28, top, 0.05, x, 0.025, -0.15);
      b.slab(g(m.blue), 0.28, top, 0.05, x, 0.025, 0.15);
      b.slab(g(m.black), 0.03, top - 0.3, 0.18, x - side * 0.02, 0.2, 0);
      b.box(g(m.black), 0.02, 2.7, 0.05, x - side * 0.135, 2.1, 0.19);
      // Gussets at the foot.
      b.beam(g(m.blue), [x + side * 0.3, 0.03, -0.2], [x + side * 0.15, 0.5, -0.16], 0.04, 0.012);
      b.beam(g(m.blue), [x + side * 0.3, 0.03, 0.2], [x + side * 0.15, 0.5, 0.16], 0.04, 0.012);
      // Equalizer cable up to the overhead beam, and the capacity label facing the door.
      b.cyl(g(m.galvanized), 0.006, top - 0.4, x - side * 0.05, top / 2 + 0.1, -0.06, 'y', { segments: 5 });
      b.panel(g(m.liftLabel), 0.2, 0.4, x, 1.65, 0.178);
      if (side === 1) {
        // Power unit: motor, reservoir and the lowering lever.
        const px = cx + 0.24;
        b.box(g(m.grey), 0.2, 0.34, 0.24, px, 1.52, -0.02);
        b.cyl(g(m.black), 0.085, 0.3, px, 1.86, -0.02, 'y', { segments: 14 });
        b.box(g(m.white), 0.18, 0.3, 0.2, px, 1.18, -0.02);
        b.beam(g(m.chrome), [px, 1.62, 0.1], [px + 0.04, 1.78, 0.26], 0.016);
        b.add(g(m.red), new THREE.SphereGeometry(0.024, 8, 6), px + 0.04, 1.79, 0.27);
        b.beam(g(m.black), [px - 0.08, 1.36, -0.02], [cx + 0.05, 0.4, -0.05], 0.018);
      }
      finish(b, side === 1 ? 'lift column left' : 'lift column right');
    }

    // Overhead beam with its hydraulic line and the padded shut-off bar.
    const g = ghostly('beam');
    const beam = new MeshBatcher();
    beam.box(g(m.blue), cx * 2 + 0.34, 0.16, 0.22, 0, top + 0.1, 0);
    beam.cyl(g(m.black), 0.014, cx * 2, 0, top - 0.02, 0.08, 'x', { segments: 6 });
    beam.box(g(m.yellow), cx * 2 - 0.9, 0.06, 0.06, 0, top - 0.22, 0);
    for (const side of [-1, 1]) beam.cyl(g(m.galvanized), 0.008, 0.26, side * (cx - 0.6), top - 0.1, 0, 'y', { segments: 5 });
    finish(beam, 'lift beam');
  }

  private buildCarriages(): void {
    const m = this.m;
    const carriageGeo = new THREE.BoxGeometry(0.2, 0.52, 0.42);
    const lugGeo = new THREE.BoxGeometry(0.2, 0.13, 0.16);
    const outerGeo = new THREE.BoxGeometry(0.105, 0.075, ARM_OUTER);
    outerGeo.translate(0, 0, ARM_OUTER / 2);
    const innerGeo = new THREE.BoxGeometry(0.08, 0.055, ARM_INNER);
    innerGeo.translate(0, 0, -ARM_INNER / 2);
    const pivotGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.12, 14);
    const stemGeo = new THREE.CylinderGeometry(0.02, 0.02, 1, 8);
    stemGeo.translate(0, 0.5, 0);
    const padGeo = new THREE.CylinderGeometry(0.068, 0.075, 0.03, 18);
    padGeo.translate(0, -0.027, 0);
    const padRubberGeo = new THREE.CylinderGeometry(0.062, 0.062, 0.012, 18);
    padRubberGeo.translate(0, -0.006, 0);

    for (const side of [-1, 1] as const) {
      const carriage = new THREE.Group();
      carriage.position.x = side * (LIFT.columnX - 0.13);
      this.group.add(carriage);
      this.carriages.push(carriage);
      this.mesh(carriageGeo, m.black, carriage);
      for (const end of [-1, 1] as const) {
        const lug = this.mesh(lugGeo, m.black, carriage);
        lug.position.set(-side * 0.12, -CARRIAGE_DROP + 0.02, end * PIVOT_Z);

        const root = new THREE.Group();
        root.position.set(-side * (PIVOT_INSET - 0.13), -CARRIAGE_DROP, end * PIVOT_Z);
        carriage.add(root);
        this.mesh(pivotGeo, m.castIron, root);
        this.mesh(outerGeo, m.yellow, root);
        const inner = this.mesh(innerGeo, m.castIron, root);
        const pad = new THREE.Group();
        root.add(pad);
        const stem = this.mesh(stemGeo, m.chrome, pad);
        const plate = new THREE.Group();
        pad.add(plate);
        this.mesh(padGeo, m.castIron, plate);
        this.mesh(padRubberGeo, m.rubber, plate);
        this.arms.push({ root, inner, pad, stem, plate, side, end });
      }
    }
  }

  /** Places every moving part for the current height and arm engagement. */
  private pose(): void {
    const load = this.load;
    const swing = smoothstep(0, 0.78, this.engage);
    const seat = smoothstep(0.72, 1, this.engage);
    const sill = load ? Math.max(ARM_REST + 0.005, load.sillHeight) : ARM_REST;
    // The arm tubes stay low; each screw pad winds up the rest of the way to meet the sill.
    const armY = ARM_TUBE_Y + this.height;
    const stem = Math.max(0.008, lerp(ARM_REST, sill, seat) - (ARM_TUBE_Y + PAD_BASE));
    for (const carriage of this.carriages) carriage.position.y = armY + CARRIAGE_DROP;

    const { x: padX, z: padZ } = load ? TwoPostLift.padLayout(load.halfWidth, load.wheelbase) : { x: 0.8, z: 0.8 };
    const pivotX = LIFT.columnX - PIVOT_INSET;
    for (const arm of this.arms) {
      // In the lift's frame the pivot sits at (side * pivotX, end * PIVOT_Z); the pad goes to (side * padX, end * padZ).
      const dx = arm.side * (padX - pivotX);
      const dz = arm.end * (padZ - PIVOT_Z);
      const parkedHeading = arm.end === 1 ? 0 : Math.PI;
      const heading = parkedHeading + angleDelta(parkedHeading, Math.atan2(dx, dz)) * swing;
      const reach = lerp(ARM_PARKED_REACH, clamp(Math.hypot(dx, dz), ARM_PARKED_REACH - 0.04, ARM_MAX_REACH), swing);
      arm.root.rotation.y = heading;
      arm.inner.position.z = reach;
      arm.pad.position.set(0, PAD_BASE, reach - 0.06);
      arm.stem.scale.y = stem;
      arm.plate.position.y = stem;
    }
  }
}
