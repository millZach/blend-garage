import type { BoxColliderDef, HeightfieldColliderDef, WorldColliderDef } from '@blend-garage/world-racing';
import { TERRAIN_SEGMENTS, WORLD_SIZE, type TerrainData } from './terrain';

const PERIMETER_NORTH = -1120;
const PERIMETER_SOUTH = 1120;
const PERIMETER_EAST = 1120;
/** West ocean barrier sits just off the sandy beach surf so cars cannot drive deep underwater. */
const PERIMETER_WEST = -835;
const PERIMETER_WALL_HEIGHT = 90;
const PERIMETER_WALL_THICKNESS = 8;

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
 * Builds 4 invisible perimeter boundary walls framing the 2400x2400m world (and Pacific Ocean edge)
 * so vehicles stay safely inside drivable bounds.
 */
export function buildPerimeterBoundaryColliders(): BoxColliderDef[] {
  const spanX = PERIMETER_EAST - PERIMETER_WEST + PERIMETER_WALL_THICKNESS * 2;
  const spanZ = PERIMETER_SOUTH - PERIMETER_NORTH + PERIMETER_WALL_THICKNESS * 2;
  const midX = (PERIMETER_WEST + PERIMETER_EAST) * 0.5;
  const midZ = (PERIMETER_NORTH + PERIMETER_SOUTH) * 0.5;
  const hy = PERIMETER_WALL_HEIGHT * 0.5;
  const ht = PERIMETER_WALL_THICKNESS * 0.5;

  return [
    {
      type: 'box',
      id: 'world-boundary-north',
      tag: 'boundary',
      surface: 'concrete',
      position: [midX, hy, PERIMETER_NORTH - ht],
      halfExtents: [spanX * 0.5, hy, ht],
      friction: 0.4,
      restitution: 0.08,
    },
    {
      type: 'box',
      id: 'world-boundary-south',
      tag: 'boundary',
      surface: 'concrete',
      position: [midX, hy, PERIMETER_SOUTH + ht],
      halfExtents: [spanX * 0.5, hy, ht],
      friction: 0.4,
      restitution: 0.08,
    },
    {
      type: 'box',
      id: 'world-boundary-west',
      tag: 'boundary',
      surface: 'concrete',
      position: [PERIMETER_WEST - ht, hy, midZ],
      halfExtents: [ht, hy, spanZ * 0.5],
      friction: 0.4,
      restitution: 0.08,
    },
    {
      type: 'box',
      id: 'world-boundary-east',
      tag: 'boundary',
      surface: 'concrete',
      position: [PERIMETER_EAST + ht, hy, midZ],
      halfExtents: [ht, hy, spanZ * 0.5],
      friction: 0.4,
      restitution: 0.08,
    },
  ];
}

/**
 * Combines terrain heightfield, all static props/barriers/ramps/walls/pillars/bridge/tunnel/guardrails,
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
