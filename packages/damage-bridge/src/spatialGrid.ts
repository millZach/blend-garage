/**
 * Compact, zero-GC flat CSR 3D uniform spatial grid built over a mesh's rest vertex positions.
 *
 * Allows `RealDamageSimulator.applyImpact()` to skip untouched meshes via O(1) AABB-sphere
 * rejection and visit only the spatial cells intersecting the impact sphere, achieving
 * sub-millisecond impacts on 250k–5M+ vertex meshes.
 */

const GRID_VERTEX_THRESHOLD = 512;
const MAX_CELLS_PER_AXIS = 24;

export class MeshSpatialIndex {
  readonly vertexCount: number;
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
  readonly valid: boolean;

  readonly useGrid: boolean;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly invCellX: number;
  readonly invCellY: number;
  readonly invCellZ: number;
  /** Length = nx * ny * nz + 1. Cell `c` holds vertices `cellVertices[cellOffsets[c] .. cellOffsets[c + 1] - 1]`. */
  readonly cellOffsets: Uint32Array;
  /** Flat array of vertex indices (0 .. vertexCount - 1) grouped by grid cell. */
  readonly cellVertices: Uint32Array;

  constructor(restPositions: Float32Array, targetCellSize = 0.25) {
    const vertexCount = Math.floor(restPositions.length / 3);
    this.vertexCount = vertexCount;

    if (vertexCount === 0) {
      this.minX = 0;
      this.minY = 0;
      this.minZ = 0;
      this.maxX = 0;
      this.maxY = 0;
      this.maxZ = 0;
      this.valid = false;
      this.useGrid = false;
      this.nx = 0;
      this.ny = 0;
      this.nz = 0;
      this.invCellX = 0;
      this.invCellY = 0;
      this.invCellZ = 0;
      this.cellOffsets = new Uint32Array(0);
      this.cellVertices = new Uint32Array(0);
      return;
    }

    let minX = restPositions[0];
    let minY = restPositions[1];
    let minZ = restPositions[2];
    let maxX = minX;
    let maxY = minY;
    let maxZ = minZ;

    for (let i = 3; i < vertexCount * 3; i += 3) {
      const x = restPositions[i];
      const y = restPositions[i + 1];
      const z = restPositions[i + 2];
      if (x < minX) minX = x;
      else if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      else if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      else if (z > maxZ) maxZ = z;
    }

    this.minX = minX;
    this.minY = minY;
    this.minZ = minZ;
    this.maxX = maxX;
    this.maxY = maxY;
    this.maxZ = maxZ;
    this.valid = true;

    if (vertexCount < GRID_VERTEX_THRESHOLD) {
      this.useGrid = false;
      this.nx = 0;
      this.ny = 0;
      this.nz = 0;
      this.invCellX = 0;
      this.invCellY = 0;
      this.invCellZ = 0;
      this.cellOffsets = new Uint32Array(0);
      this.cellVertices = new Uint32Array(0);
      return;
    }

    const safeCellSize = Math.max(0.05, targetCellSize);
    const spanX = Math.max(1e-4, maxX - minX);
    const spanY = Math.max(1e-4, maxY - minY);
    const spanZ = Math.max(1e-4, maxZ - minZ);

    const nx = Math.min(MAX_CELLS_PER_AXIS, Math.max(1, Math.ceil(spanX / safeCellSize)));
    const ny = Math.min(MAX_CELLS_PER_AXIS, Math.max(1, Math.ceil(spanY / safeCellSize)));
    const nz = Math.min(MAX_CELLS_PER_AXIS, Math.max(1, Math.ceil(spanZ / safeCellSize)));
    const totalCells = nx * ny * nz;

    const invCellX = nx / spanX;
    const invCellY = ny / spanY;
    const invCellZ = nz / spanZ;
    const nyNx = ny * nx;
    const maxIx = nx - 1;
    const maxIy = ny - 1;
    const maxIz = nz - 1;

    // Pass 1: count vertices per cell (store cell id in Uint16Array since totalCells <= 24^3 = 13824).
    const counts = new Uint32Array(totalCells);
    const vertexCells = new Uint16Array(vertexCount);

    for (let v = 0; v < vertexCount; v++) {
      const i3 = v * 3;
      let ix = ((restPositions[i3] - minX) * invCellX) | 0;
      let iy = ((restPositions[i3 + 1] - minY) * invCellY) | 0;
      let iz = ((restPositions[i3 + 2] - minZ) * invCellZ) | 0;
      if (ix < 0) ix = 0;
      else if (ix > maxIx) ix = maxIx;
      if (iy < 0) iy = 0;
      else if (iy > maxIy) iy = maxIy;
      if (iz < 0) iz = 0;
      else if (iz > maxIz) iz = maxIz;
      const cell = iz * nyNx + iy * nx + ix;
      vertexCells[v] = cell;
      counts[cell]++;
    }

    // Prefix sum -> cellOffsets (length totalCells + 1).
    const cellOffsets = new Uint32Array(totalCells + 1);
    let running = 0;
    for (let c = 0; c < totalCells; c++) {
      cellOffsets[c] = running;
      running += counts[c];
    }
    cellOffsets[totalCells] = running;

    // Pass 2: scatter vertex indices into contiguous CSR buckets.
    const cursors = new Uint32Array(cellOffsets.subarray(0, totalCells));
    const cellVertices = new Uint32Array(vertexCount);
    for (let v = 0; v < vertexCount; v++) {
      const cell = vertexCells[v];
      cellVertices[cursors[cell]++] = v;
    }

    this.useGrid = true;
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.invCellX = invCellX;
    this.invCellY = invCellY;
    this.invCellZ = invCellZ;
    this.cellOffsets = cellOffsets;
    this.cellVertices = cellVertices;
  }

  /** Fast O(1) AABB-sphere intersection test against the mesh rest bounds. */
  overlapsSphere(cx: number, cy: number, cz: number, radius: number): boolean {
    if (!this.valid) return false;
    let dx = 0;
    if (cx < this.minX) dx = this.minX - cx;
    else if (cx > this.maxX) dx = cx - this.maxX;

    let dy = 0;
    if (cy < this.minY) dy = this.minY - cy;
    else if (cy > this.maxY) dy = cy - this.maxY;

    let dz = 0;
    if (cz < this.minZ) dz = this.minZ - cz;
    else if (cz > this.maxZ) dz = cz - this.maxZ;

    return dx * dx + dy * dy + dz * dz <= radius * radius;
  }
}
