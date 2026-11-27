import * as THREE from 'three';
import { smoothstep } from '../math';
import { MeshBatcher } from '../MeshBatcher';
import { buildBuilding } from './building';
import { BAY_X, BOOTH, TURNTABLE } from './layout';
import { TwoPostLift } from './lift';
import { LightingRig } from './lighting';
import { createShopMaterials, type ShopMaterials } from './materials';
import { buildProps } from './props';
import { createShopTextures, type ShopTextures } from './textures';

/**
 * The whole mechanics shop: building, props, the working lift in the hero bay, the photo bay's
 * turntable, and the lighting. Built once and never rebuilt; only the lift, turntable and lights move.
 */
export class ShopEnvironment {
  readonly group = new THREE.Group();
  readonly lift: TwoPostLift;
  readonly lighting: LightingRig;
  readonly materials: ShopMaterials;
  readonly textures: ShopTextures;
  /** The rotating disc in the photo bay. The car is parented to the scene, not to this, and is turned in step. */
  readonly turntable: THREE.Mesh;

  private readonly spareLift: TwoPostLift;
  private readonly carShadow: THREE.Mesh;
  private readonly carShadowMaterial: THREE.MeshBasicMaterial;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.group.name = 'shop';
    this.textures = createShopTextures(renderer.capabilities.getMaxAnisotropy());
    const batcher = new MeshBatcher();
    this.materials = createShopMaterials(this.textures, batcher);

    buildBuilding(batcher, this.materials);
    buildProps(batcher, this.materials);
    this.group.add(batcher.build('shop'));

    this.turntable = new THREE.Mesh(new THREE.CircleGeometry(BOOTH.turntableRadius, 96), this.materials.turntable);
    this.turntable.name = 'turntable';
    this.turntable.rotation.x = -Math.PI / 2;
    this.turntable.position.set(TURNTABLE.x, 0.005, TURNTABLE.z);
    this.turntable.receiveShadow = true;
    this.group.add(this.turntable);

    this.lift = new TwoPostLift(this.materials);
    this.lift.group.position.set(BAY_X[1], 0, 0);
    this.spareLift = new TwoPostLift(this.materials);
    this.spareLift.group.position.set(BAY_X[2], 0, 0);
    this.group.add(this.lift.group, this.spareLift.group);

    // Soft ambient-occlusion shadow that keeps the car planted where the key light's shadow is faint.
    this.carShadowMaterial = new THREE.MeshBasicMaterial({
      map: this.textures.blob,
      color: 0x000000,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    const plane = new THREE.PlaneGeometry(1, 1);
    plane.rotateX(-Math.PI / 2);
    this.carShadow = new THREE.Mesh(plane, this.carShadowMaterial);
    this.carShadow.name = 'car contact shadow';
    this.carShadow.position.y = 0.011;
    this.carShadow.renderOrder = 3;
    this.carShadow.visible = false;
    this.group.add(this.carShadow);

    scene.add(this.group);
    this.lighting = new LightingRig(scene, renderer, this.materials);
    scene.add(this.lighting.group);
  }

  /** Turns the photo bay's turntable to `angle` radians (the engine turns the car by the same angle). */
  setTurntableAngle(angle: number): void {
    this.turntable.rotation.z = angle;
  }

  /**
   * Places the contact shadow under the car. `size` is the car's width and length; pass `null` when
   * there is no car on stage.
   */
  setCarShadow(position: THREE.Vector3 | null, heading: number, size: { width: number; length: number } | null, liftHeight: number): void {
    if (!position || !size) {
      this.carShadow.visible = false;
      return;
    }
    this.carShadow.visible = true;
    this.carShadow.position.x = position.x;
    this.carShadow.position.z = position.z;
    this.carShadow.rotation.y = heading;
    const spread = 1 + liftHeight * 0.35;
    this.carShadow.scale.set((size.width + 0.9) * spread, 1, (size.length + 0.9) * spread);
    this.carShadowMaterial.opacity = 0.62 * (1 - smoothstep(0.1, 1.7, liftHeight) * 0.72);
  }

  dispose(): void {
    this.lighting.dispose();
    this.lift.dispose();
    this.spareLift.dispose();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.carShadowMaterial.dispose();
    for (const material of this.materials.all) material.dispose();
    for (const texture of this.textures.all) texture.dispose();
    this.group.removeFromParent();
  }
}
