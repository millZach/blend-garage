import * as THREE from 'three';
import type { UniversalWheelOverlay } from '@blend-garage/vehicle-core';
import { MeshBatcher } from '../MeshBatcher';

export interface WheelFaceMaterials {
  /** Painted or machined metal of the wheel; follows the build's rim finish. */
  rim: THREE.MeshPhysicalMaterial;
  /** Dark dish behind the spokes that hides the stock wheel. */
  shadow: THREE.MeshStandardMaterial;
  bolt: THREE.MeshStandardMaterial;
}

export function createWheelFaceMaterials(): WheelFaceMaterials {
  const rim = new THREE.MeshPhysicalMaterial({ color: 0xd7dce2, metalness: 0.78, roughness: 0.24, clearcoat: 1, clearcoatRoughness: 0.06, side: THREE.DoubleSide });
  rim.name = 'wheel face';
  const shadow = new THREE.MeshStandardMaterial({ color: 0x0b0c0d, metalness: 0.4, roughness: 0.7 });
  shadow.name = 'wheel face dish';
  const bolt = new THREE.MeshStandardMaterial({ color: 0xdfe3e6, metalness: 1, roughness: 0.18 });
  bolt.name = 'wheel bolts';
  return { rim, shadow, bolt };
}

const HALF_PI = Math.PI / 2;

/** A spoke from radius r0 to r1 at angle `a`, lying in the wheel's face plane (the YZ plane). */
function spoke(b: MeshBatcher, material: THREE.Material, a: number, r0: number, r1: number, w0: number, w1: number, depth: number, x: number): void {
  const length = r1 - r0;
  const g = new THREE.BoxGeometry(depth, length, 1);
  // Taper the spoke from hub to rim.
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) * (p.getY(i) > 0 ? w1 : w0));
  g.translate(0, r0 + length / 2, 0);
  g.rotateX(a);
  g.computeVertexNormals();
  b.add(material, g, x, 0, 0);
}

/**
 * A replacement wheel face, built in the wheel's own frame: the axle is the X axis, and the face
 * looks toward +X. `radius` is the radius of the metal wheel it covers. The origin sits in the plane
 * of the outer lip; everything else is recessed behind it.
 */
export function buildWheelFace(style: Exclude<UniversalWheelOverlay, 'stock'>, radius: number, m: WheelFaceMaterials): THREE.Group {
  const b = new MeshBatcher();
  const R = radius;
  const dish = style === 'mesh-dish' ? 0.062 : style === 'five-spoke' ? 0.036 : 0.016;

  // Dark dish that hides the stock spokes, a short barrel wall, and the outer lip.
  b.add(m.shadow, new THREE.CircleGeometry(R * 0.99, 48), -dish - 0.004, 0, 0, [0, HALF_PI, 0]);
  b.cyl(m.rim, R * 0.985, dish + 0.008, -dish / 2, 0, 0, 'x', { segments: 48, open: true });
  b.add(m.rim, new THREE.TorusGeometry(R * 0.985, 0.009, 8, 56), 0, 0, 0, [0, HALF_PI, 0]);

  if (style === 'five-spoke') {
    for (let i = 0; i < 5; i++) spoke(b, m.rim, (i / 5) * Math.PI * 2, R * 0.16, R * 0.97, R * 0.3, R * 0.17, 0.026, -dish + 0.014);
    b.cyl(m.rim, R * 0.24, 0.03, -dish + 0.016, 0, 0, 'x', { segments: 28 });
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + Math.PI / 5;
      b.cyl(m.bolt, 0.011, 0.016, -dish + 0.034, Math.cos(a) * R * 0.15, Math.sin(a) * R * 0.15, 'x', { segments: 6 });
    }
    b.cyl(m.shadow, R * 0.085, 0.012, -dish + 0.036, 0, 0, 'x', { segments: 20 });
  } else if (style === 'mesh-dish') {
    // Cross-laced spokes behind a deep polished lip.
    b.add(m.rim, new THREE.RingGeometry(R * 0.8, R * 0.985, 56), -0.002, 0, 0, [0, HALF_PI, 0]);
    b.cyl(m.rim, R * 0.8, dish - 0.012, -dish / 2 - 0.004, 0, 0, 'x', { segments: 48, open: true });
    const pairs = 10;
    for (let i = 0; i < pairs; i++) {
      const a = (i / pairs) * Math.PI * 2;
      // Each pair leaves the hub together and crosses its neighbours on the way out to the lip.
      for (const twist of [-0.3, 0.3]) {
        const x = -dish + (twist > 0 ? 0.012 : 0.008);
        b.beam(m.rim, [x, Math.cos(a) * R * 0.2, Math.sin(a) * R * 0.2], [x, Math.cos(a + twist) * R * 0.81, Math.sin(a + twist) * R * 0.81], 0.014, R * 0.045);
      }
    }
    b.cyl(m.rim, R * 0.25, 0.024, -dish + 0.014, 0, 0, 'x', { segments: 28 });
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      b.cyl(m.bolt, 0.006, 0.006, 0.001, Math.cos(a) * R * 0.89, Math.sin(a) * R * 0.89, 'x', { segments: 6 });
    }
    b.cyl(m.shadow, R * 0.1, 0.012, -dish + 0.03, 0, 0, 'x', { segments: 20 });
  } else {
    // Aero disc: a nearly closed turbine face with short cooling slots.
    b.add(m.rim, new THREE.CircleGeometry(R * 0.97, 56), -dish + 0.004, 0, 0, [0, HALF_PI, 0]);
    for (let i = 0; i < 14; i++) spoke(b, m.shadow, (i / 14) * Math.PI * 2, R * 0.56, R * 0.9, R * 0.045, R * 0.11, 0.004, -dish + 0.006);
    b.add(m.rim, new THREE.TorusGeometry(R * 0.5, 0.006, 6, 40), -dish + 0.008, 0, 0, [0, HALF_PI, 0]);
    b.cyl(m.shadow, R * 0.16, 0.012, -dish + 0.01, 0, 0, 'x', { segments: 24 });
    b.cyl(m.bolt, R * 0.07, 0.008, -dish + 0.018, 0, 0, 'x', { segments: 16 });
  }
  const group = b.build(`wheel face ${style}`, { castShadow: false, receiveShadow: true });
  group.name = `wheel face ${style}`;
  return group;
}
