import type { BoxColliderDef, HeightfieldColliderDef, WorldColliderDef } from '@blend-garage/world-racing';
import { TERRAIN_SEGMENTS, WORLD_SIZE, type TerrainData } from './terrain';

const PERIMETER_HALF_EXTENT = 540;
const PERIMETER_WALL_HEIGHT = 40;
const PERIMETER_WALL_THICKNESS = 6;

/**
 * Converts the row-major TerrainData height grid into Rapier 3D's exact column-major
 * `HeightfieldColliderDef`:
 *   heights[col * (nrows + 1) + row]
 * where `col` spans X [-scale[0]/2, +scale[0]/2] and `row` spans Z [-scale[2]/2, +scale[2]/2].
 */
export function buildTerrainHeightfieldCollider(terrain: TerrainData): HeightfieldColliderDef {
  const nrows = TERRAIN_SEGMENTS;
  const ncols = TERRAIN_SEGMENTS;
  const strideZ = nrows + 1;
  const columnMajor = new Float32Array((nrows + 1) * (ncols + 1));

  for (let col = 0; col <= ncols; col++) {
    for (let row = 0; row <= nrows; row++) {
      columnMajor[col * strideZ + row] = terrain.physicsHeights[row * terrain.cols + col];
    }
  }

  return {
    type: 'heightfield',
    id: 'world-terrain-heightfield',
    tag: 'terrain',
    surface: 'asphalt',
    position: [0, 0, 0],
    nrows,
    ncols,
    heights: columnMajor,
    scale: [WORLD_SIZE, 1, WORLD_SIZE],
    friction: 0.92,
    restitution: 0.04,
  };
}

/**
 * Builds 4 invisible perimeter boundary walls framing the outer mountain rim so vehicles
 * can never leave the 1200x1200m heightfield bounds.
 */
export function buildPerimeterBoundaryColliders(): BoxColliderDef[] {
  const span = PERIMETER_HALF_EXTENT * 2 + PERIMETER_WALL_THICKNESS;
  const hy = PERIMETER_WALL_HEIGHT * 0.5;
  const ht = PERIMETER_WALL_THICKNESS * 0.5;
  const hs = span * 0.5;

  return [
    {
      type: 'box',
      id: 'world-boundary-north',
      tag: 'boundary',
      surface: 'concrete',
      position: [0, hy, -PERIMETER_HALF_EXTENT - ht],
      halfExtents: [hs, hy, ht],
      friction: 0.4,
      restitution: 0.1,
    },
    {
      type: 'box',
      id: 'world-boundary-south',
      tag: 'boundary',
      surface: 'concrete',
      position: [0, hy, PERIMETER_HALF_EXTENT + ht],
      halfExtents: [hs, hy, ht],
      friction: 0.4,
      restitution: 0.1,
    },
    {
      type: 'box',
      id: 'world-boundary-west',
      tag: 'boundary',
      surface: 'concrete',
      position: [-PERIMETER_HALF_EXTENT - ht, hy, 0],
      halfExtents: [ht, hy, hs],
      friction: 0.4,
      restitution: 0.1,
    },
    {
      type: 'box',
      id: 'world-boundary-east',
      tag: 'boundary',
      surface: 'concrete',
      position: [PERIMETER_HALF_EXTENT + ht, hy, 0],
      halfExtents: [ht, hy, hs],
      friction: 0.4,
      restitution: 0.1,
    },
  ];
}

/**
 * Combines terrain heightfield, all static props/barriers/ramps/walls/pillars/guardrails,
 * and outer perimeter boundaries into the complete static `WorldColliderDef[]` array.
 */
export function assembleWorldColliders(
  terrain: TerrainData,
  propColliders: readonly WorldColliderDef[],
): WorldColliderDef[] {
  return [
    buildTerrainHeightfieldCollider(terrain),
    ...propColliders,
    ...buildPerimeterBoundaryColliders(),
  ];
}
