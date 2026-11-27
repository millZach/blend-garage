import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { angleDelta, clamp, damp, easeInOutCubic, lerp } from '../math';
import { clampToShop } from '../shop/layout';
import type { CameraMode, ViewInsets } from '../types';

const EYE_HEIGHT = 1.68;
const WALK_SPEED = 2.7;
const FLY_SPEED = 5.2;
const SPRINT = 2.4;
const LOOK_SPEED = 0.0032;
/** Vertical field of view for every angle except the ones that ask for a wider lens. */
export const BASE_FOV = 34;
/** Walking and flying use a wider lens, the way a first-person view normally does. */
const FIRST_PERSON_FOV = 56;

const MOVE_KEYS: Record<string, readonly [x: number, y: number, z: number]> = {
  KeyW: [0, 0, 1],
  ArrowUp: [0, 0, 1],
  KeyS: [0, 0, -1],
  ArrowDown: [0, 0, -1],
  KeyA: [-1, 0, 0],
  ArrowLeft: [-1, 0, 0],
  KeyD: [1, 0, 0],
  ArrowRight: [1, 0, 0],
  KeyE: [0, 1, 0],
  KeyQ: [0, -1, 0],
};

interface Flight {
  t: number;
  duration: number;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  from: THREE.Spherical;
  to: THREE.Spherical;
  fromFov: number;
  toFov: number;
  resolve: () => void;
}

export interface OrbitLimits {
  minDistance: number;
  maxDistance: number;
  maxPolar: number;
  /** How far the orbit target may be panned away from `center`. */
  panRadius: number;
  center: THREE.Vector3;
}

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * The one camera and its three ways of moving: orbit, first-person walk (WASD, drag to look) and
 * free-fly (WASD plus Q/E). Also runs the smooth flights between camera angles, and keeps the picture
 * centered in whatever part of the window the HUD leaves uncovered.
 */
export class CameraDirector {
  readonly camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.08, 500);
  mode: CameraMode = 'orbit';
  /** Called when the user moves the camera by hand (drag, scroll or keys). */
  onUserMove: (() => void) | null = null;
  /** Floor area the walking camera may not enter: the car's footprint while it is on the ground. */
  obstacle: THREE.Box2 | null = null;

  private readonly controls: OrbitControls;
  private readonly keys = new Set<string>();
  private readonly velocity = new THREE.Vector3();
  private yaw = 0;
  private pitch = 0;
  private dragging = false;
  private lastPointer = { x: 0, y: 0 };
  private flight: Flight | null = null;
  private fovGoal = BASE_FOV;
  private limits: OrbitLimits | null = null;
  private width = 1;
  private height = 1;
  private insets: ViewInsets = { left: 0, right: 0, top: 0, bottom: 0 };
  private readonly shift = new THREE.Vector2();
  private shiftSettled = false;

  constructor(private readonly dom: HTMLElement) {
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.085;
    this.controls.rotateSpeed = 0.6;
    this.controls.zoomSpeed = 0.85;
    this.controls.panSpeed = 0.7;
    this.controls.minPolarAngle = 0.03;
    this.controls.addEventListener('start', this.handleOrbitStart);

    dom.addEventListener('pointerdown', this.handlePointerDown);
    dom.addEventListener('pointermove', this.handlePointerMove);
    dom.addEventListener('pointerup', this.handlePointerUp);
    dom.addEventListener('pointercancel', this.handlePointerUp);
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
  }

  get target(): THREE.Vector3 {
    return this.controls.target;
  }

  get flying(): boolean {
    return this.flight !== null;
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.camera.aspect = this.width / this.height;
    this.shiftSettled = false;
    this.applyShift();
  }

  setInsets(insets: ViewInsets, immediate = false): void {
    this.insets = insets;
    this.shiftSettled = false;
    if (immediate) {
      this.shift.set((insets.right - insets.left) / 2, (insets.bottom - insets.top) / 2);
      this.applyShift();
    }
  }

  setOrbitLimits(limits: OrbitLimits): void {
    this.limits = limits;
    this.controls.minDistance = limits.minDistance;
    this.controls.maxDistance = limits.maxDistance;
    this.controls.maxPolarAngle = limits.maxPolar;
  }

  /** Moves the orbit pivot, for example to follow the car up the lift. */
  nudgeTarget(dy: number): void {
    this.controls.target.y += dy;
    if (this.flight) this.flight.toTarget.y += dy;
  }

  /**
   * Distance at which a box `width` wide and `height` tall fills the part of the view the HUD
   * leaves free.
   */
  distanceToFit(width: number, height: number, fov = BASE_FOV): number {
    const freeW = Math.max(0.25, 1 - (this.insets.left + this.insets.right) / this.width);
    const freeH = Math.max(0.25, 1 - (this.insets.top + this.insets.bottom) / this.height);
    const tan = Math.tan((fov * Math.PI) / 360);
    return Math.max(width / (2 * tan * this.camera.aspect * freeW * 0.9), height / (2 * tan * freeH * 0.82));
  }

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.keys.clear();
    this.velocity.set(0, 0, 0);
    if (mode === 'orbit') {
      // Pivot around whatever the camera was looking at, a comfortable distance ahead.
      this.camera.getWorldDirection(_forward);
      const reach = this.limits ? clamp(this.camera.position.distanceTo(this.limits.center), this.limits.minDistance, this.limits.maxDistance) : 6;
      this.controls.target.copy(this.camera.position).addScaledVector(_forward, reach);
      this.constrainTarget();
    } else {
      this.syncLookFromCamera();
      if (mode === 'walk') {
        // Stand up and look ahead, wherever the orbit camera happened to be pointing.
        this.camera.position.y = EYE_HEIGHT;
        this.pitch = clamp(this.pitch, -0.3, 0.25);
      }
    }
    this.fovGoal = mode === 'orbit' ? BASE_FOV : FIRST_PERSON_FOV;
    this.controls.enabled = mode === 'orbit' && !this.flight;
  }

  /** Puts the camera somewhere immediately. */
  jumpTo(position: THREE.Vector3, target: THREE.Vector3): void {
    this.flight?.resolve();
    this.flight = null;
    this.camera.fov = this.fovGoal = BASE_FOV;
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(position);
    this.controls.target.copy(target);
    this.camera.lookAt(target);
    this.syncLookFromCamera();
    this.controls.enabled = this.mode === 'orbit';
    this.controls.update();
  }

  /** Flies the camera to a new position and aim, swinging around the subject rather than cutting through it. */
  flyTo(position: THREE.Vector3, target: THREE.Vector3, seconds = 1.0, fov = BASE_FOV): Promise<void> {
    this.flight?.resolve();
    const fromTarget = this.mode === 'orbit' ? this.controls.target.clone() : this.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(position.distanceTo(target)).add(this.camera.position);
    const from = new THREE.Spherical().setFromVector3(_offset.subVectors(this.camera.position, fromTarget));
    const to = new THREE.Spherical().setFromVector3(_offset.subVectors(position, target));
    this.controls.enabled = false;
    this.fovGoal = fov;
    return new Promise((resolve) => {
      this.flight = { t: 0, duration: Math.max(0.05, seconds), fromTarget, toTarget: target.clone(), from, to, fromFov: this.camera.fov, toFov: fov, resolve };
    });
  }

  /** `dt` is the capped simulation step; `clock` is real elapsed time, which timed flights follow. */
  update(dt: number, clock = dt): void {
    if (this.flight) this.advanceFlight(clock);
    else if (this.mode === 'orbit') {
      this.controls.update();
      this.constrainTarget();
      const before = this.camera.position.y;
      clampToShop(this.camera.position, 0.3);
      if (this.camera.position.y !== before) this.camera.lookAt(this.controls.target);
    } else this.advanceWalk(dt);

    if (!this.flight && Math.abs(this.camera.fov - this.fovGoal) > 0.01) {
      this.camera.fov = Math.abs(this.camera.fov - this.fovGoal) < 0.1 ? this.fovGoal : damp(this.camera.fov, this.fovGoal, 6, dt);
      this.camera.updateProjectionMatrix();
    }

    if (!this.shiftSettled) {
      const goalX = (this.insets.right - this.insets.left) / 2;
      const goalY = (this.insets.bottom - this.insets.top) / 2;
      this.shift.x = damp(this.shift.x, goalX, 7, dt);
      this.shift.y = damp(this.shift.y, goalY, 7, dt);
      if (Math.abs(this.shift.x - goalX) < 0.5 && Math.abs(this.shift.y - goalY) < 0.5) {
        this.shift.set(goalX, goalY);
        this.shiftSettled = true;
      }
      this.applyShift();
    }
  }

  dispose(): void {
    this.flight?.resolve();
    this.controls.removeEventListener('start', this.handleOrbitStart);
    this.controls.dispose();
    this.dom.removeEventListener('pointerdown', this.handlePointerDown);
    this.dom.removeEventListener('pointermove', this.handlePointerMove);
    this.dom.removeEventListener('pointerup', this.handlePointerUp);
    this.dom.removeEventListener('pointercancel', this.handlePointerUp);
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
  }

  private applyShift(): void {
    this.camera.setViewOffset(this.width, this.height, this.shift.x, this.shift.y, this.width, this.height);
  }

  private constrainTarget(): void {
    if (!this.limits) return;
    const { center, panRadius } = this.limits;
    const t = this.controls.target;
    _offset.subVectors(t, center);
    _offset.y = 0;
    if (_offset.length() > panRadius) {
      _offset.setLength(panRadius);
      t.x = center.x + _offset.x;
      t.z = center.z + _offset.z;
    }
    t.y = clamp(t.y, center.y - 0.6, center.y + 2.6);
  }

  private advanceFlight(dt: number): void {
    const f = this.flight!;
    f.t = Math.min(1, f.t + dt / f.duration);
    const k = easeInOutCubic(f.t);
    const target = this.controls.target.lerpVectors(f.fromTarget, f.toTarget, k);
    const radius = lerp(f.from.radius, f.to.radius, k);
    const phi = lerp(f.from.phi, f.to.phi, k);
    const theta = f.from.theta + angleDelta(f.from.theta, f.to.theta) * k;
    this.camera.position.setFromSphericalCoords(radius, phi, theta).add(target);
    clampToShop(this.camera.position, 0.25);
    this.camera.lookAt(target);
    if (f.fromFov !== f.toFov) {
      this.camera.fov = lerp(f.fromFov, f.toFov, k);
      this.camera.updateProjectionMatrix();
    }
    if (f.t >= 1) {
      this.flight = null;
      this.syncLookFromCamera();
      this.controls.enabled = this.mode === 'orbit';
      if (this.mode === 'walk') this.camera.position.y = EYE_HEIGHT;
      f.resolve();
    }
  }

  private advanceWalk(dt: number): void {
    _euler.set(this.pitch, this.yaw, 0);
    this.camera.quaternion.setFromEuler(_euler);

    _move.set(0, 0, 0);
    for (const code of this.keys) {
      const axis = MOVE_KEYS[code];
      if (axis) _move.add(_offset.set(axis[0], axis[1], axis[2]));
    }
    const walking = this.mode === 'walk';
    this.camera.getWorldDirection(_forward);
    if (walking) {
      _forward.y = 0;
      _forward.normalize();
    }
    _right.crossVectors(_forward, this.camera.up).normalize();
    const speed = (walking ? WALK_SPEED : FLY_SPEED) * (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? SPRINT : 1);
    const wish = _offset.set(0, 0, 0).addScaledVector(_right, _move.x).addScaledVector(_forward, _move.z);
    if (!walking) wish.y += _move.y;
    if (wish.lengthSq() > 1) wish.normalize();
    wish.multiplyScalar(speed);
    this.velocity.lerp(wish, 1 - Math.exp(-dt * 11));
    if (this.velocity.lengthSq() < 1e-6) return;

    this.camera.position.addScaledVector(this.velocity, dt);
    if (walking) {
      this.camera.position.y = EYE_HEIGHT;
      this.avoidObstacle();
    }
    clampToShop(this.camera.position, walking ? 0.45 : 0.3);
    if (walking) this.camera.position.y = EYE_HEIGHT;
  }

  /** Pushes the walking camera out of the car's footprint through the nearest side. */
  private avoidObstacle(): void {
    const box = this.obstacle;
    const p = this.camera.position;
    if (!box || p.x <= box.min.x || p.x >= box.max.x || p.z <= box.min.y || p.z >= box.max.y) return;
    const exits = [p.x - box.min.x, box.max.x - p.x, p.z - box.min.y, box.max.y - p.z];
    const nearest = exits.indexOf(Math.min(...exits));
    if (nearest === 0) p.x = box.min.x;
    else if (nearest === 1) p.x = box.max.x;
    else if (nearest === 2) p.z = box.min.y;
    else p.z = box.max.y;
  }

  private syncLookFromCamera(): void {
    _euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.yaw = _euler.y;
    this.pitch = clamp(_euler.x, -1.45, 1.45);
  }

  private readonly handleOrbitStart = (): void => {
    this.onUserMove?.();
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (this.mode === 'orbit' || this.flight || event.button !== 0) return;
    this.dragging = true;
    this.lastPointer = { x: event.clientX, y: event.clientY };
    this.dom.setPointerCapture(event.pointerId);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!this.dragging) return;
    this.yaw -= (event.clientX - this.lastPointer.x) * LOOK_SPEED;
    this.pitch = clamp(this.pitch - (event.clientY - this.lastPointer.y) * LOOK_SPEED, -1.45, 1.45);
    this.lastPointer = { x: event.clientX, y: event.clientY };
    this.onUserMove?.();
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.dom.hasPointerCapture(event.pointerId)) this.dom.releasePointerCapture(event.pointerId);
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (this.mode === 'orbit' || event.ctrlKey || event.metaKey || event.altKey) return;
    const el = event.target as HTMLElement | null;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    if (MOVE_KEYS[event.code] || event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
      this.keys.add(event.code);
      if (MOVE_KEYS[event.code]) {
        event.preventDefault();
        this.onUserMove?.();
      }
    }
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private readonly handleBlur = (): void => {
    this.keys.clear();
    this.dragging = false;
  };
}
