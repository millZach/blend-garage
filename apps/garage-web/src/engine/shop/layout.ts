import * as THREE from 'three';

/**
 * Floor plan of the shop, in meters. X runs along the row of bays, Z runs from the photo bay at the
 * back (-Z) to the roll-up doors at the front (+Z). Cars face +Z, toward the doors.
 */
export const HALL = {
  minX: -19,
  maxX: 19,
  minZ: -10,
  maxZ: 12,
  /** Wall height at the eaves and at the roof ridge (the ridge runs along X). */
  eave: 7.2,
  ridge: 9.0,
  ridgeZ: 1,
} as const;

/**
 * The photo bay behind the hero bay, where the Car Selector shows the car on a turntable. It is wide
 * enough that the selector camera can orbit all the way round without leaving it.
 */
export const BOOTH = {
  minX: -9.5,
  maxX: 9.5,
  minZ: -28.5,
  maxZ: HALL.minZ,
  height: 5.6,
  /** The opening between the photo bay and the hall. */
  mouthHalfWidth: 4.5,
  mouthHeight: 4.6,
  turntableZ: -19.25,
  turntableRadius: 3.15,
} as const;

/** Bay centers along X. The middle one is the hero bay with the working lift. */
export const BAY_X = [-10.5, 0, 10.5] as const;
export const HERO_BAY = new THREE.Vector3(0, 0, 0);
export const TURNTABLE = new THREE.Vector3(0, 0, BOOTH.turntableZ);

export const DOOR = { width: 5.0, height: 4.7 } as const;

/** Truss lines along X. */
export const TRUSS_X = [-16.29, -10.86, -5.43, 0, 5.43, 10.86, 16.29] as const;

export const LIFT = {
  /** Distance of each column's centerline from the bay center. */
  columnX: 2.0,
  columnHeight: 3.95,
  maxHeight: 1.85,
} as const;

/** Roof underside height at a given Z (gable roof). */
export function roofY(z: number): number {
  const half = z < HALL.ridgeZ ? HALL.ridgeZ - HALL.minZ : HALL.maxZ - HALL.ridgeZ;
  const t = 1 - Math.abs(z - HALL.ridgeZ) / half;
  return HALL.eave + (HALL.ridge - HALL.eave) * Math.max(0, t);
}

/** Keeps a free camera inside the hall, the photo bay, or the strip of apron outside the open door. */
export function clampToShop(p: THREE.Vector3, margin = 0.35): void {
  const clampTo = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  p.y = Math.max(0.12, p.y);
  const wall = 0.2;

  if (p.z < HALL.minZ - wall) {
    // Inside the photo bay.
    p.x = clampTo(p.x, BOOTH.minX + margin, BOOTH.maxX - margin);
    p.y = Math.min(BOOTH.height - margin, p.y);
    p.z = Math.max(BOOTH.minZ + margin, p.z);
    return;
  }
  if (p.z > HALL.maxZ + wall) {
    // Out on the apron: only the open hero door leads here.
    p.x = clampTo(p.x, BAY_X[1] - DOOR.width / 2 + margin, BAY_X[1] + DOOR.width / 2 - margin);
    p.y = Math.min(DOOR.height - margin, p.y);
    p.z = Math.min(HALL.maxZ + 9, p.z);
    return;
  }
  // In the hall, or passing through one of its two openings.
  const inBoothMouth = Math.abs(p.x) < BOOTH.mouthHalfWidth - margin && p.y < BOOTH.mouthHeight - margin;
  const inDoorway = Math.abs(p.x - BAY_X[1]) < DOOR.width / 2 - margin && p.y < DOOR.height - margin;
  if (!inBoothMouth) p.z = Math.max(HALL.minZ + margin, p.z);
  if (!inDoorway) p.z = Math.min(HALL.maxZ - margin, p.z);
  p.x = clampTo(p.x, HALL.minX + margin, HALL.maxX - margin);
  p.y = Math.min(roofY(p.z) - margin - 0.6, p.y);
}
