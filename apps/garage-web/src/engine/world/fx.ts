import * as THREE from 'three';
import { clamp } from '../math';
import type { WorldTextures } from './textures';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

const MAX_SPARKS = 240;
const MAX_SKID_QUADS = 420;
const MAX_SMOKE = 72;

interface SparkParticle {
  alive: boolean;
  age: number;
  life: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

interface SmokeParticle {
  alive: boolean;
  age: number;
  life: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  darkness: number;
}

interface SkidPrev {
  x: number;
  y: number;
  z: number;
  lx: number;
  lz: number;
  age: number;
}

/**
 * Lightweight zero-allocation pooled visual FX for open-world driving & crash feedback:
 * - Incandescent spark bursts on impact
 * - Tire skidmark ribbon pool on drifting / hard braking
 * - Engine smoke puffs when engineHealth < 0.6
 * Automatically hides inactive pools so idle FX consume zero draw calls and zero CPU loop work.
 */
export class WorldFX {
  readonly group = new THREE.Group();

  // Crash sparks
  private readonly sparks: SparkParticle[] = [];
  private sparkCursor = 0;
  private activeSparks = 0;
  private readonly sparkPos: Float32Array;
  private readonly sparkCol: Float32Array;
  private readonly sparkGeo: THREE.BufferGeometry;
  private readonly sparkMat: THREE.PointsMaterial;
  private readonly sparkPoints: THREE.Points;

  // Engine smoke
  private readonly smokes: SmokeParticle[] = [];
  private smokeCursor = 0;
  private activeSmokes = 0;
  private smokeEmitAccum = 0;
  private readonly smokePos: Float32Array;
  private readonly smokeCol: Float32Array;
  private readonly smokeSize: Float32Array;
  private readonly smokeAlpha: Float32Array;
  private readonly smokeGeo: THREE.BufferGeometry;
  private readonly smokeMat: THREE.ShaderMaterial;
  private readonly smokePoints: THREE.Points;

  // Skidmarks
  private skidCursor = 0;
  private hasSkids = false;
  private readonly skidPositions: Float32Array;
  private readonly skidColors: Float32Array;
  private readonly skidGeo: THREE.BufferGeometry;
  private readonly skidMat: THREE.MeshBasicMaterial;
  private readonly skidMesh: THREE.Mesh;
  private readonly prevWheelSkid = new Map<string, SkidPrev>();

  private sampleGroundY: (x: number, z: number) => number;
  private disposed = false;

  constructor(textures: WorldTextures, sampleGroundY: (x: number, z: number) => number) {
    this.sampleGroundY = sampleGroundY;
    this.group.name = 'world-fx';

    // --- Crash Sparks ---
    for (let i = 0; i < MAX_SPARKS; i++) {
      this.sparks.push({ alive: false, age: 0, life: 0.4, x: 0, y: -999, z: 0, vx: 0, vy: 0, vz: 0 });
    }
    this.sparkPos = new Float32Array(MAX_SPARKS * 3);
    this.sparkCol = new Float32Array(MAX_SPARKS * 3);
    for (let i = 0; i < MAX_SPARKS; i++) this.sparkPos[i * 3 + 1] = -999;

    this.sparkGeo = new THREE.BufferGeometry();
    this.sparkGeo.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3));
    this.sparkGeo.setAttribute('color', new THREE.BufferAttribute(this.sparkCol, 3));
    this.sparkMat = new THREE.PointsMaterial({
      size: 0.34,
      map: textures.spark,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.sparkPoints = new THREE.Points(this.sparkGeo, this.sparkMat);
    this.sparkPoints.name = 'fx-crash-sparks';
    this.sparkPoints.frustumCulled = false;
    this.sparkPoints.visible = false;
    this.group.add(this.sparkPoints);

    // --- Engine Smoke (expanding & smoothly alpha-fading sprite puffs) ---
    for (let i = 0; i < MAX_SMOKE; i++) {
      this.smokes.push({ alive: false, age: 0, life: 1.5, x: 0, y: -999, z: 0, vx: 0, vy: 0, vz: 0, darkness: 0.5 });
    }
    this.smokePos = new Float32Array(MAX_SMOKE * 3);
    this.smokeCol = new Float32Array(MAX_SMOKE * 3);
    this.smokeSize = new Float32Array(MAX_SMOKE);
    this.smokeAlpha = new Float32Array(MAX_SMOKE);
    for (let i = 0; i < MAX_SMOKE; i++) this.smokePos[i * 3 + 1] = -999;

    this.smokeGeo = new THREE.BufferGeometry();
    this.smokeGeo.setAttribute('position', new THREE.BufferAttribute(this.smokePos, 3));
    this.smokeGeo.setAttribute('color', new THREE.BufferAttribute(this.smokeCol, 3));
    this.smokeGeo.setAttribute('aSize', new THREE.BufferAttribute(this.smokeSize, 1));
    this.smokeGeo.setAttribute('aAlpha', new THREE.BufferAttribute(this.smokeAlpha, 1));
    this.smokeMat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: textures.smokePuff },
      },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = color;
          vAlpha = aAlpha;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (360.0 / max(1.0, -mvPosition.z));
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec4 tex = texture2D(uMap, gl_PointCoord);
          float alpha = tex.a * vAlpha;
          if (alpha < 0.01) discard;
          gl_FragColor = vec4(vColor * tex.rgb, alpha);
        }
      `,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    });
    this.smokePoints = new THREE.Points(this.smokeGeo, this.smokeMat);
    this.smokePoints.name = 'fx-engine-smoke';
    this.smokePoints.frustumCulled = false;
    this.smokePoints.visible = false;
    this.group.add(this.smokePoints);

    // --- Skidmarks (ring buffer of 2-triangle quads) ---
    const verts = MAX_SKID_QUADS * 4;
    this.skidPositions = new Float32Array(verts * 3);
    this.skidColors = new Float32Array(verts * 4);
    const skidUvs = new Float32Array(verts * 2);
    const skidIndices = new Uint32Array(MAX_SKID_QUADS * 6);

    for (let q = 0; q < MAX_SKID_QUADS; q++) {
      const v0 = q * 4;
      skidPositionsInit(this.skidPositions, v0);
      skidUvs[v0 * 2] = 0;
      skidUvs[v0 * 2 + 1] = 0;
      skidUvs[(v0 + 1) * 2] = 1;
      skidUvs[(v0 + 1) * 2 + 1] = 0;
      skidUvs[(v0 + 2) * 2] = 0;
      skidUvs[(v0 + 2) * 2 + 1] = 1;
      skidUvs[(v0 + 3) * 2] = 1;
      skidUvs[(v0 + 3) * 2 + 1] = 1;

      const idx = q * 6;
      skidIndices[idx] = v0;
      skidIndices[idx + 1] = v0 + 1;
      skidIndices[idx + 2] = v0 + 2;
      skidIndices[idx + 3] = v0 + 1;
      skidIndices[idx + 4] = v0 + 3;
      skidIndices[idx + 5] = v0 + 2;
    }

    this.skidGeo = new THREE.BufferGeometry();
    this.skidGeo.setAttribute('position', new THREE.BufferAttribute(this.skidPositions, 3));
    this.skidGeo.setAttribute('uv', new THREE.BufferAttribute(skidUvs, 2));
    this.skidGeo.setAttribute('color', new THREE.BufferAttribute(this.skidColors, 4));
    this.skidGeo.setIndex(new THREE.BufferAttribute(skidIndices, 1));

    this.skidMat = new THREE.MeshBasicMaterial({
      map: textures.skidMark,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    this.skidMesh = new THREE.Mesh(this.skidGeo, this.skidMat);
    this.skidMesh.name = 'fx-skidmarks';
    this.skidMesh.renderOrder = 2;
    this.skidMesh.frustumCulled = false;
    this.skidMesh.visible = false;
    this.group.add(this.skidMesh);
  }

  /** Emits a pooled spark burst at a world impact point along `worldNormal`. `intensity` in ~0.2..2.0. */
  emitCrashSparks(worldPoint: Vec3Like, worldNormal: Vec3Like, intensity: number): void {
    if (this.disposed) return;
    const clamped = clamp(intensity, 0.15, 2.5);
    const count = Math.round(14 + clamped * 28);

    const nLen = Math.hypot(worldNormal.x, worldNormal.y, worldNormal.z) || 1;
    const nx = worldNormal.x / nLen;
    const ny = worldNormal.y / nLen;
    const nz = worldNormal.z / nLen;

    for (let i = 0; i < count; i++) {
      const p = this.sparks[this.sparkCursor];
      this.sparkCursor = (this.sparkCursor + 1) % MAX_SPARKS;

      const spread = 2.5 + Math.random() * 5.5 * clamped;
      const rx = (Math.random() - 0.5) * 2;
      const ry = Math.random() * 1.4;
      const rz = (Math.random() - 0.5) * 2;

      if (!p.alive) this.activeSparks += 1;
      p.alive = true;
      p.age = 0;
      p.life = 0.28 + Math.random() * 0.42;
      p.x = worldPoint.x + (Math.random() - 0.5) * 0.16;
      p.y = worldPoint.y + (Math.random() - 0.5) * 0.12;
      p.z = worldPoint.z + (Math.random() - 0.5) * 0.16;
      p.vx = (nx * 0.75 + rx) * spread;
      p.vy = (Math.max(0.25, ny) * 0.65 + ry) * spread * 0.75;
      p.vz = (nz * 0.75 + rz) * spread;
    }
    this.sparkPoints.visible = this.activeSparks > 0;
  }

  /**
   * Appends a tire skidmark quad segment for a specific wheel (`wheelKey` e.g. `'FL'`, `'RL'`).
   * Call on frames where the wheel is slipping/braking heavily.
   */
  addSkidMark(
    wheelKey: string,
    worldPos: Vec3Like,
    headingRad: number,
    width = 0.28,
    opacity = 0.65,
  ): void {
    if (this.disposed) return;

    const halfW = width * 0.5;
    const lx = Math.cos(headingRad) * halfW;
    const lz = -Math.sin(headingRad) * halfW;
    const y = worldPos.y + 0.03;

    const prev = this.prevWheelSkid.get(wheelKey);
    if (!prev || prev.age > 0.22) {
      this.prevWheelSkid.set(wheelKey, { x: worldPos.x, y, z: worldPos.z, lx, lz, age: 0 });
      return;
    }

    const dist = Math.hypot(worldPos.x - prev.x, worldPos.z - prev.z);
    if (dist < 0.22) return;
    if (dist > 4.0) {
      prev.x = worldPos.x;
      prev.y = y;
      prev.z = worldPos.z;
      prev.lx = lx;
      prev.lz = lz;
      prev.age = 0;
      return;
    }

    const q = this.skidCursor;
    this.skidCursor = (this.skidCursor + 1) % MAX_SKID_QUADS;
    const v0 = q * 4;
    const pos = this.skidPositions;
    const col = this.skidColors;

    pos[v0 * 3] = prev.x + prev.lx;
    pos[v0 * 3 + 1] = prev.y;
    pos[v0 * 3 + 2] = prev.z + prev.lz;

    pos[(v0 + 1) * 3] = prev.x - prev.lx;
    pos[(v0 + 1) * 3 + 1] = prev.y;
    pos[(v0 + 1) * 3 + 2] = prev.z - prev.lz;

    pos[(v0 + 2) * 3] = worldPos.x + lx;
    pos[(v0 + 2) * 3 + 1] = y;
    pos[(v0 + 2) * 3 + 2] = worldPos.z + lz;

    pos[(v0 + 3) * 3] = worldPos.x - lx;
    pos[(v0 + 3) * 3 + 1] = y;
    pos[(v0 + 3) * 3 + 2] = worldPos.z - lz;

    const alpha = clamp(opacity, 0.1, 0.9);
    for (let k = 0; k < 4; k++) {
      const ci = (v0 + k) * 4;
      col[ci] = 0.08;
      col[ci + 1] = 0.08;
      col[ci + 2] = 0.09;
      col[ci + 3] = alpha;
    }

    prev.x = worldPos.x;
    prev.y = y;
    prev.z = worldPos.z;
    prev.lx = lx;
    prev.lz = lz;
    prev.age = 0;

    if (!this.hasSkids) {
      this.hasSkids = true;
      this.skidMesh.visible = true;
    }

    (this.skidGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.skidGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Spawns engine hood smoke puffs whenever `engineHealth < 0.6`. */
  updateEngineSmoke(dt: number, hoodWorldPos: Vec3Like, engineHealth: number): void {
    if (this.disposed || engineHealth >= 0.6) return;

    const damageSeverity = clamp((0.6 - engineHealth) / 0.6, 0, 1);
    const rate = 6 + damageSeverity * 18;
    this.smokeEmitAccum += dt * rate;

    while (this.smokeEmitAccum >= 1) {
      this.smokeEmitAccum -= 1;
      const p = this.smokes[this.smokeCursor];
      this.smokeCursor = (this.smokeCursor + 1) % MAX_SMOKE;

      if (!p.alive) this.activeSmokes += 1;
      p.alive = true;
      p.age = 0;
      p.life = 1.0 + Math.random() * 0.9;
      p.x = hoodWorldPos.x + (Math.random() - 0.5) * 0.45;
      p.y = hoodWorldPos.y + 0.15 + Math.random() * 0.15;
      p.z = hoodWorldPos.z + (Math.random() - 0.5) * 0.45;
      p.vx = (Math.random() - 0.5) * 0.9;
      p.vy = 1.6 + Math.random() * 1.4;
      p.vz = (Math.random() - 0.5) * 0.9;
      p.darkness = 0.72 - damageSeverity * 0.5;
    }
    this.smokePoints.visible = this.activeSmokes > 0;
  }

  /** Advances all active sparks, smoke puffs, and skid trail timeouts. */
  update(dt: number): void {
    if (this.disposed || dt <= 0) return;
    const step = Math.min(dt, 0.05);

    if (this.prevWheelSkid.size > 0) {
      for (const prev of this.prevWheelSkid.values()) {
        prev.age += step;
      }
    }

    if (this.activeSparks > 0) {
      let aliveCount = 0;
      for (let i = 0; i < MAX_SPARKS; i++) {
        const p = this.sparks[i];
        if (!p.alive) continue;
        p.age += step;
        if (p.age >= p.life) {
          p.alive = false;
          this.sparkPos[i * 3 + 1] = -999;
          this.sparkCol[i * 3] = 0;
          this.sparkCol[i * 3 + 1] = 0;
          this.sparkCol[i * 3 + 2] = 0;
          continue;
        }
        aliveCount += 1;

        p.vy -= 18.0 * step;
        const drag = Math.max(0, 1 - 1.6 * step);
        p.vx *= drag;
        p.vz *= drag;
        p.x += p.vx * step;
        p.y += p.vy * step;
        p.z += p.vz * step;

        const ground = this.sampleGroundY(p.x, p.z) + 0.04;
        if (p.y < ground) {
          p.y = ground;
          p.vy = Math.abs(p.vy) * 0.42;
          p.vx *= 0.72;
          p.vz *= 0.72;
        }

        const fade = 1 - p.age / p.life;
        this.sparkPos[i * 3] = p.x;
        this.sparkPos[i * 3 + 1] = p.y;
        this.sparkPos[i * 3 + 2] = p.z;
        this.sparkCol[i * 3] = 1.0 * fade;
        this.sparkCol[i * 3 + 1] = (0.55 + 0.45 * fade) * fade;
        this.sparkCol[i * 3 + 2] = 0.25 * fade * fade;
      }

      this.activeSparks = aliveCount;
      this.sparkPoints.visible = aliveCount > 0;
      (this.sparkGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (this.sparkGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    }

    if (this.activeSmokes > 0) {
      let aliveCount = 0;
      for (let i = 0; i < MAX_SMOKE; i++) {
        const p = this.smokes[i];
        if (!p.alive) continue;
        p.age += step;
        if (p.age >= p.life) {
          p.alive = false;
          this.smokePos[i * 3 + 1] = -999;
          this.smokeAlpha[i] = 0;
          this.smokeSize[i] = 0;
          continue;
        }
        aliveCount += 1;

        p.x += p.vx * step;
        p.y += p.vy * step;
        p.z += p.vz * step;
        p.vx *= 1 - 1.2 * step;
        p.vz *= 1 - 1.2 * step;
        p.vy *= 1 - 0.5 * step;

        const t = p.age / p.life;
        const alpha = Math.sin(t * Math.PI) * 0.62 * (1 - t * 0.35);
        const shade = p.darkness;
        this.smokePos[i * 3] = p.x;
        this.smokePos[i * 3 + 1] = p.y;
        this.smokePos[i * 3 + 2] = p.z;
        this.smokeCol[i * 3] = shade;
        this.smokeCol[i * 3 + 1] = shade;
        this.smokeCol[i * 3 + 2] = shade * 1.04;
        this.smokeSize[i] = 0.55 + t * 2.1;
        this.smokeAlpha[i] = alpha;
      }

      this.activeSmokes = aliveCount;
      this.smokePoints.visible = aliveCount > 0;
      (this.smokeGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (this.smokeGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
      (this.smokeGeo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
      (this.smokeGeo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  /** Clears transient trails and particles (e.g. on car warp or repair). */
  clear(): void {
    this.prevWheelSkid.clear();
    this.activeSparks = 0;
    this.activeSmokes = 0;
    this.hasSkids = false;
    this.skidCursor = 0;
    this.sparkPoints.visible = false;
    this.smokePoints.visible = false;
    this.skidMesh.visible = false;

    for (let i = 0; i < MAX_SPARKS; i++) {
      this.sparks[i].alive = false;
      this.sparkPos[i * 3 + 1] = -999;
    }
    for (let i = 0; i < MAX_SMOKE; i++) {
      this.smokes[i].alive = false;
      this.smokePos[i * 3 + 1] = -999;
      this.smokeAlpha[i] = 0;
    }
    for (let q = 0; q < MAX_SKID_QUADS; q++) {
      skidPositionsInit(this.skidPositions, q * 4);
    }
    (this.sparkGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.smokeGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.smokeGeo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
    (this.skidGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sparkGeo.dispose();
    this.sparkMat.dispose();
    this.smokeGeo.dispose();
    this.smokeMat.dispose();
    this.skidGeo.dispose();
    this.skidMat.dispose();
    this.group.removeFromParent();
  }
}

function skidPositionsInit(arr: Float32Array, v0: number): void {
  for (let k = 0; k < 4; k++) {
    arr[(v0 + k) * 3] = 0;
    arr[(v0 + k) * 3 + 1] = -999;
    arr[(v0 + k) * 3 + 2] = 0;
  }
}
