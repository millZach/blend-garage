import * as THREE from 'three';
import { clamp, lerp, seededRandom } from '../math';

export interface FoliageAndPropTextures {
  pineBough: THREE.CanvasTexture;
  oakLeaf: THREE.CanvasTexture;
  grassTuft: THREE.CanvasTexture;
  bark: THREE.CanvasTexture;
  barkNormal: THREE.DataTexture;
  rock: THREE.CanvasTexture;
  rockNormal: THREE.DataTexture;
  archConcrete: THREE.CanvasTexture;
  archConcreteNormal: THREE.DataTexture;
  cladding: THREE.CanvasTexture;
  claddingNormal: THREE.DataTexture;
  bayDoor: THREE.CanvasTexture;
  glassWindow: THREE.CanvasTexture;
  crashHazard: THREE.CanvasTexture;
  guardrail: THREE.CanvasTexture;
  chevronSign: THREE.CanvasTexture;
  all: THREE.Texture[];
}

type DrawFn = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

function makeCanvasTexture(
  w: number,
  h: number,
  draw: DrawFn,
  options: { repeat?: boolean; srgb?: boolean; anisotropy?: number; clampU?: boolean; clampV?: boolean } = {},
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx) draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = options.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  if (options.repeat) {
    tex.wrapS = options.clampU ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    tex.wrapT = options.clampV ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  } else {
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
  }
  tex.anisotropy = options.anisotropy ?? 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Fast frontier-BFS RGB dilation into transparent pixels while preserving alpha = 0.
 * Eliminates dark/black mipmap fringes around alpha-tested pine needles, leaves, and grass blades
 * (~12x faster than full-image multi-pass scanning during OpenWorld mount).
 */
function dilateAlphaRgb(ctx: CanvasRenderingContext2D, w: number, h: number, passes = 6): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const count = w * h;
  const state = new Uint8Array(count); // 0 = empty, 1 = filled, 2 = queued
  let frontier = new Int32Array(count);
  let nextFrontier = new Int32Array(count);
  let frontierLen = 0;

  for (let i = 0; i < count; i++) {
    if (d[i * 4 + 3] >= 48) state[i] = 1;
  }

  // Seed initial frontier: transparent pixels directly touching opaque pixels.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const idx = row + x;
      if (state[idx] !== 0) continue;
      if (
        (x > 0 && state[idx - 1] === 1) ||
        (x + 1 < w && state[idx + 1] === 1) ||
        (y > 0 && state[idx - w] === 1) ||
        (y + 1 < h && state[idx + w] === 1)
      ) {
        state[idx] = 2;
        frontier[frontierLen++] = idx;
      }
    }
  }

  for (let pass = 0; pass < passes && frontierLen > 0; pass++) {
    let nextLen = 0;
    for (let f = 0; f < frontierLen; f++) {
      const idx = frontier[f];
      const y = (idx / w) | 0;
      const x = idx - y * w;
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let n = 0;

      const y0 = y > 0 ? y - 1 : 0;
      const y1 = y + 1 < h ? y + 1 : h - 1;
      const x0 = x > 0 ? x - 1 : 0;
      const x1 = x + 1 < w ? x + 1 : w - 1;
      for (let ny = y0; ny <= y1; ny++) {
        const nrow = ny * w;
        for (let nx = x0; nx <= x1; nx++) {
          const ni = nrow + nx;
          if (state[ni] === 1) {
            const o = ni * 4;
            rSum += d[o];
            gSum += d[o + 1];
            bSum += d[o + 2];
            n++;
          }
        }
      }
      if (n > 0) {
        const o = idx * 4;
        d[o] = (rSum / n + 0.5) | 0;
        d[o + 1] = (gSum / n + 0.5) | 0;
        d[o + 2] = (bSum / n + 0.5) | 0;
      }
    }

    // Mark processed frontier as filled and enqueue newly adjacent empty pixels.
    for (let f = 0; f < frontierLen; f++) {
      state[frontier[f]] = 1;
    }
    if (pass + 1 < passes) {
      for (let f = 0; f < frontierLen; f++) {
        const idx = frontier[f];
        const y = (idx / w) | 0;
        const x = idx - y * w;
        if (x > 0 && state[idx - 1] === 0) {
          state[idx - 1] = 2;
          nextFrontier[nextLen++] = idx - 1;
        }
        if (x + 1 < w && state[idx + 1] === 0) {
          state[idx + 1] = 2;
          nextFrontier[nextLen++] = idx + 1;
        }
        if (y > 0 && state[idx - w] === 0) {
          state[idx - w] = 2;
          nextFrontier[nextLen++] = idx - w;
        }
        if (y + 1 < h && state[idx + w] === 0) {
          state[idx + w] = 2;
          nextFrontier[nextLen++] = idx + w;
        }
      }
    }

    const tmp = frontier;
    frontier = nextFrontier;
    nextFrontier = tmp;
    frontierLen = nextLen;
  }

  ctx.putImageData(img, 0, 0);
}

/** Tileable 2D value noise on a periodic integer grid (periodX, periodY). */
function periodicNoise2D(x: number, y: number, periodX: number, periodY: number, seed: number): number {
  const hash = (ix: number, iy: number): number => {
    const px = ((ix % periodX) + periodX) % periodX;
    const py = ((iy % periodY) + periodY) % periodY;
    let n = Math.imul(px + seed * 31, 374761393) + Math.imul(py + seed * 17, 668265263);
    n = (n ^ (n >>> 13)) >>> 0;
    n = Math.imul(n, 1274126177) >>> 0;
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
}

function makeNormalFromHeight(height: Float32Array, w: number, h: number, strength: number, anisotropy: number): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const ym = (y - 1 + h) % h;
    const yp = (y + 1) % h;
    for (let x = 0; x < w; x++) {
      const xm = (x - 1 + w) % w;
      const xp = (x + 1) % w;
      const dx = (height[y * w + xp] - height[y * w + xm]) * strength;
      const dy = (height[yp * w + x] - height[ym * w + x]) * strength;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const idx = (y * w + x) * 4;
      data[idx] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      data[idx + 1] = Math.round((dy * inv * 0.5 + 0.5) * 255);
      data[idx + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      data[idx + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Draws a rich branching coastal pine / conifer bough spray with feathery needle fascicles,
 * woody stems, layered shadow-to-sunlit pine-olive needles, and fringe-free alpha dilation.
 */
function buildPineBoughTexture(anisotropy: number): THREE.CanvasTexture {
  return makeCanvasTexture(
    512,
    512,
    (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      const rand = seededRandom(8101);

      interface Shoot {
        x0: number;
        y0: number;
        cx: number;
        cy: number;
        x1: number;
        y1: number;
        thickness: number;
        needleLen: number;
        density: number;
      }

      const shoots: Shoot[] = [
        // Central main stem
        { x0: w * 0.5, y0: h * 0.96, cx: w * 0.49, cy: h * 0.52, x1: w * 0.5, y1: h * 0.08, thickness: 9, needleLen: 44, density: 135 },
        // Lower wide spreading lateral shoots
        { x0: w * 0.5, y0: h * 0.86, cx: w * 0.30, cy: h * 0.78, x1: w * 0.10, y1: h * 0.64, thickness: 6, needleLen: 46, density: 115 },
        { x0: w * 0.5, y0: h * 0.85, cx: w * 0.70, cy: h * 0.77, x1: w * 0.90, y1: h * 0.62, thickness: 6, needleLen: 46, density: 115 },
        // Lower-mid lateral shoots
        { x0: w * 0.5, y0: h * 0.70, cx: w * 0.28, cy: h * 0.60, x1: w * 0.09, y1: h * 0.42, thickness: 5.2, needleLen: 44, density: 115 },
        { x0: w * 0.5, y0: h * 0.68, cx: w * 0.72, cy: h * 0.58, x1: w * 0.91, y1: h * 0.40, thickness: 5.2, needleLen: 44, density: 115 },
        // Upper-mid lateral shoots
        { x0: w * 0.5, y0: h * 0.52, cx: w * 0.32, cy: h * 0.41, x1: w * 0.16, y1: h * 0.24, thickness: 4.5, needleLen: 40, density: 95 },
        { x0: w * 0.5, y0: h * 0.50, cx: w * 0.68, cy: h * 0.40, x1: w * 0.84, y1: h * 0.23, thickness: 4.5, needleLen: 40, density: 95 },
        // Crown upper forks
        { x0: w * 0.5, y0: h * 0.34, cx: w * 0.38, cy: h * 0.23, x1: w * 0.27, y1: h * 0.11, thickness: 3.6, needleLen: 34, density: 75 },
        { x0: w * 0.5, y0: h * 0.33, cx: w * 0.62, cy: h * 0.22, x1: w * 0.73, y1: h * 0.10, thickness: 3.6, needleLen: 34, density: 75 },
        // Secondary sub-twigs filling middle pockets organically
        { x0: w * 0.31, y0: h * 0.74, cx: w * 0.24, cy: h * 0.64, x1: w * 0.18, y1: h * 0.52, thickness: 3.2, needleLen: 36, density: 60 },
        { x0: w * 0.69, y0: h * 0.73, cx: w * 0.76, cy: h * 0.62, x1: w * 0.82, y1: h * 0.50, thickness: 3.2, needleLen: 36, density: 60 },
        { x0: w * 0.32, y0: h * 0.56, cx: w * 0.26, cy: h * 0.44, x1: w * 0.23, y1: h * 0.32, thickness: 3.0, needleLen: 34, density: 55 },
        { x0: w * 0.68, y0: h * 0.54, cx: w * 0.74, cy: h * 0.43, x1: w * 0.77, y1: h * 0.30, thickness: 3.0, needleLen: 34, density: 55 },
      ];

      const evalQuad = (s: Shoot, t: number) => {
        const mt = 1 - t;
        const x = mt * mt * s.x0 + 2 * mt * t * s.cx + t * t * s.x1;
        const y = mt * mt * s.y0 + 2 * mt * t * s.cy + t * t * s.y1;
        const dx = 2 * mt * (s.cx - s.x0) + 2 * t * (s.x1 - s.cx);
        const dy = 2 * mt * (s.cy - s.y0) + 2 * t * (s.y1 - s.cy);
        const ang = Math.atan2(dy, dx);
        return { x, y, ang };
      };

      const paintNeedleLayer = (
        colors: readonly string[],
        lenScale: number,
        widthRange: readonly [number, number],
        spreadMin: number,
        spreadMax: number,
        densityScale: number,
        tStart = 0.08,
      ) => {
        ctx.lineCap = 'round';
        for (const s of shoots) {
          const count = Math.round(s.density * densityScale);
          for (let i = 0; i < count; i++) {
            const t = tStart + rand() * (1 - tStart);
            const pt = evalQuad(s, t);
            const side = rand() > 0.5 ? 1 : -1;
            const spread = spreadMin + rand() * (spreadMax - spreadMin);
            const taper = 1 - t * 0.38;
            const len = s.needleLen * lenScale * taper * (0.65 + rand() * 0.58);
            const a = pt.ang + side * spread + (rand() - 0.5) * 0.16;
            const ox = pt.x + (rand() - 0.5) * 4;
            const oy = pt.y + (rand() - 0.5) * 4;
            const ex = ox + Math.cos(a) * len;
            const ey = oy + Math.sin(a) * len;
            const mx = (ox + ex) * 0.5 + Math.cos(a + side * 0.5) * len * 0.08;
            const my = (oy + ey) * 0.5 + Math.sin(a + side * 0.5) * len * 0.08;

            ctx.strokeStyle = colors[Math.floor(rand() * colors.length)];
            ctx.lineWidth = widthRange[0] + rand() * (widthRange[1] - widthRange[0]);
            ctx.beginPath();
            ctx.moveTo(ox, oy);
            ctx.quadraticCurveTo(mx, my, ex, ey);
            ctx.stroke();
          }
        }
      };

      // 1. Deep shadowed back needle tufts
      paintNeedleLayer(['#182716', '#1e301b', '#23381f', '#283f22'], 1.14, [2.6, 4.4], 0.22, 1.15, 1.05, 0.06);

      // 2. Woody brown-grey bough stems & sub-twigs
      ctx.lineCap = 'round';
      for (const s of shoots) {
        const steps = 12;
        for (let i = 0; i < steps; i++) {
          const t0 = i / steps;
          const t1 = (i + 1) / steps;
          const p0 = evalQuad(s, t0);
          const p1 = evalQuad(s, t1);
          ctx.strokeStyle = i % 2 === 0 ? '#4d3a2b' : '#5e4936';
          ctx.lineWidth = Math.max(1.5, s.thickness * (1 - t0 * 0.72));
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.stroke();
        }
      }

      // 3. Rich midtone coastal pine-olive needles
      paintNeedleLayer(['#2c4425', '#344e2b', '#3d5831', '#456136', '#314928'], 1.0, [2.0, 3.6], 0.16, 1.02, 1.45, 0.10);

      // 4. Sunlit warm olive-pine upper needle tips & fascicle highlights
      paintNeedleLayer(['#536d3a', '#637b42', '#73884b', '#4d6736'], 0.86, [1.5, 2.8], 0.08, 0.85, 0.95, 0.22);

      // 5. Tiny warm pine shoot buds at tips
      for (const s of shoots) {
        const tip = evalQuad(s, 0.97);
        ctx.fillStyle = '#755c3e';
        ctx.beginPath();
        ctx.ellipse(tip.x, tip.y, 4.2, 2.4, tip.ang, 0, Math.PI * 2);
        ctx.fill();
      }

      dilateAlphaRgb(ctx, w, h, 8);
    },
    { repeat: false, anisotropy },
  );
}

/**
 * Draws a clustered spray of individual California Live Oak / broadleaf foliage leaves
 * with interior twigs, layered shadow-to-sunlit olive leaves, and fringe-free alpha dilation.
 */
function buildOakLeafTexture(anisotropy: number): THREE.CanvasTexture {
  return makeCanvasTexture(
    512,
    512,
    (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      const rand = seededRandom(8203);

      const drawLeaf = (
        x: number,
        y: number,
        angle: number,
        len: number,
        wid: number,
        fillA: string,
        fillB: string,
        vein: string,
      ) => {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);

        // Upper/left lobe half
        ctx.fillStyle = fillA;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.bezierCurveTo(len * 0.25, -wid * 0.95, len * 0.72, -wid * 0.85, len, 0);
        ctx.bezierCurveTo(len * 0.72, wid * 0.85, len * 0.25, wid * 0.95, 0, 0);
        ctx.closePath();
        ctx.fill();

        // Sunlit upper half sheen
        ctx.fillStyle = fillB;
        ctx.beginPath();
        ctx.moveTo(len * 0.08, 0);
        ctx.bezierCurveTo(len * 0.3, -wid * 0.78, len * 0.7, -wid * 0.68, len * 0.96, 0);
        ctx.closePath();
        ctx.fill();

        // Subtle center vein
        ctx.strokeStyle = vein;
        ctx.lineWidth = Math.max(0.8, wid * 0.1);
        ctx.beginPath();
        ctx.moveTo(len * 0.06, 0);
        ctx.lineTo(len * 0.84, 0);
        ctx.stroke();

        ctx.restore();
      };

      // Organic sub-cluster centers leaving irregular serrated perimeter & air pockets
      const lobes: readonly [number, number, number][] = [
        [w * 0.50, h * 0.48, w * 0.17],
        [w * 0.30, h * 0.42, w * 0.15],
        [w * 0.70, h * 0.44, w * 0.15],
        [w * 0.43, h * 0.24, w * 0.14],
        [w * 0.62, h * 0.26, w * 0.13],
        [w * 0.27, h * 0.66, w * 0.14],
        [w * 0.71, h * 0.67, w * 0.14],
        [w * 0.50, h * 0.73, w * 0.13],
      ];

      // Subtle connecting woody twigs
      ctx.strokeStyle = '#47392b';
      ctx.lineCap = 'round';
      for (const [lx, ly] of lobes) {
        ctx.lineWidth = 4.2;
        ctx.beginPath();
        ctx.moveTo(w * 0.5, h * 0.88);
        ctx.quadraticCurveTo(lerp(w * 0.5, lx, 0.5) + (rand() - 0.5) * 30, lerp(h * 0.78, ly, 0.5), lx, ly);
        ctx.stroke();
      }

      const scatterLeaves = (
        countPerLobe: number,
        radScale: number,
        lenRange: readonly [number, number],
        palette: readonly [string, string, string][],
        yBias = 0,
      ) => {
        for (const [lx, ly, lr] of lobes) {
          for (let i = 0; i < countPerLobe; i++) {
            const a = rand() * Math.PI * 2;
            const r = Math.sqrt(rand()) * lr * radScale;
            const x = lx + Math.cos(a) * r;
            const y = ly + Math.sin(a) * r + yBias;
            // Keep safely inside canvas margin
            if (x < 24 || x > w - 24 || y < 24 || y > h - 24) continue;
            const leafAngle = a + (rand() - 0.5) * 1.15;
            const len = lenRange[0] + rand() * (lenRange[1] - lenRange[0]);
            const wid = len * (0.34 + rand() * 0.15);
            const [cA, cB, cV] = palette[Math.floor(rand() * palette.length)];
            drawLeaf(x, y, leafAngle, len, wid, cA, cB, cV);
          }
        }
      };

      // 1. Deep canopy shadow leaves
      scatterLeaves(22, 1.05, [28, 44], [
        ['#1c2a17', '#23331c', '#162111'],
        ['#23341c', '#2b3e22', '#1a2715'],
        ['#293b20', '#314626', '#202e19'],
      ], 6);

      // 2. Midtone California Live Oak olive-green foliage
      scatterLeaves(32, 1.02, [24, 40], [
        ['#354926', '#41582e', '#2a3a1e'],
        ['#3e542c', '#4c6535', '#324423'],
        ['#496033', '#58713d', '#3a4d28'],
        ['#526837', '#617941', '#42552c'],
      ], 0);

      // 3. Warm golden-sunlit upper crown leaf highlights
      scatterLeaves(18, 0.92, [20, 34], [
        ['#62773e', '#758b49', '#4f6231'],
        ['#708445', '#859852', '#5b6d37'],
        ['#7d8f4d', '#94a45c', '#66763d'],
      ], -8);

      dilateAlphaRgb(ctx, w, h, 8);
    },
    { repeat: false, anisotropy },
  );
}

/**
 * Draws coastal wild oat grass blades, dry golden stalks with seed panicles,
 * and low California sagebrush sprigs with root-to-tip shading and alpha dilation.
 */
function buildGrassTuftTexture(anisotropy: number): THREE.CanvasTexture {
  return makeCanvasTexture(
    512,
    512,
    (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      const rand = seededRandom(8307);

      // 1. Basal shadowed thatch blades
      ctx.lineCap = 'round';
      for (let i = 0; i < 65; i++) {
        const bx = w * (0.12 + rand() * 0.76);
        const height = h * (0.28 + rand() * 0.36);
        const lean = ((bx / w) - 0.5) * 190 + (rand() - 0.5) * 110;
        const grad = ctx.createLinearGradient(bx, h, bx + lean, h - height);
        grad.addColorStop(0, '#363320');
        grad.addColorStop(0.55, '#595535');
        grad.addColorStop(1, '#7c7648');
        ctx.strokeStyle = grad;
        ctx.lineWidth = 4.5 + rand() * 4.5;
        ctx.beginPath();
        ctx.moveTo(bx, h);
        ctx.quadraticCurveTo(bx + lean * 0.32, h - height * 0.58, bx + lean, h - height);
        ctx.stroke();
      }

      // 2. Main arcing wild coastal grass blades (olive + warm California gold)
      for (let i = 0; i < 105; i++) {
        const bx = w * (0.08 + rand() * 0.84);
        const height = h * (0.42 + rand() * 0.48);
        const lean = ((bx / w) - 0.5) * 230 + (rand() - 0.5) * 130;
        const isGolden = rand() > 0.38;
        const grad = ctx.createLinearGradient(bx, h, bx + lean, h - height);
        if (isGolden) {
          grad.addColorStop(0, '#4a4327');
          grad.addColorStop(0.42, '#9a8448');
          grad.addColorStop(0.82, '#c5ac65');
          grad.addColorStop(1, '#dcc780');
        } else {
          grad.addColorStop(0, '#3a4226');
          grad.addColorStop(0.45, '#687446');
          grad.addColorStop(0.85, '#8c975d');
          grad.addColorStop(1, '#adb472');
        }
        ctx.strokeStyle = grad;
        ctx.lineWidth = 3.2 + rand() * 3.8;
        ctx.beginPath();
        ctx.moveTo(bx, h + 4);
        ctx.quadraticCurveTo(bx + lean * 0.28, h - height * 0.62, bx + lean, h - height);
        ctx.stroke();
      }

      // 3. Tall slender wild oat seed stalks with golden nodding spikelets
      for (let i = 0; i < 20; i++) {
        const bx = w * (0.16 + rand() * 0.68);
        const height = h * (0.66 + rand() * 0.28);
        const lean = ((bx / w) - 0.5) * 195 + (rand() - 0.5) * 85;
        const tx = clamp(bx + lean, 28, w - 28);
        const ty = clamp(h - height, 28, h - 80);

        ctx.strokeStyle = '#b99f5b';
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(bx, h);
        ctx.quadraticCurveTo(bx + lean * 0.3, h - height * 0.58, tx, ty);
        ctx.stroke();

        // Cluster of tiny golden oat spikelets near stalk top
        for (let k = 0; k < 6; k++) {
          const sx = tx + (rand() - 0.5) * 26;
          const sy = ty + k * 7 + (rand() - 0.5) * 6;
          ctx.fillStyle = k % 2 === 0 ? '#dfc982' : '#c6ab60';
          ctx.beginPath();
          ctx.ellipse(sx, sy, 5.5, 2.4, (rand() - 0.5) * 0.9, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 4. Low California sagebrush sprigs at the base for rich shrubby density
      for (let i = 0; i < 38; i++) {
        const x = w * (0.14 + rand() * 0.72);
        const y = h * (0.64 + rand() * 0.32);
        ctx.fillStyle = rand() > 0.5 ? '#6d7c5a' : '#7f8d6a';
        ctx.beginPath();
        ctx.ellipse(x, y, 7 + rand() * 6, 3.5 + rand() * 2.5, (rand() - 0.5) * 1.4, 0, Math.PI * 2);
        ctx.fill();
      }

      dilateAlphaRgb(ctx, w, h, 8);
    },
    { repeat: false, anisotropy },
  );
}

/**
 * Tileable weathered furrowed tree bark albedo + matching tangent-space normal map.
 */
function buildBarkTextures(anisotropy: number): { bark: THREE.CanvasTexture; barkNormal: THREE.DataTexture } {
  const nw = 128;
  const nh = 128;
  const height = new Float32Array(nw * nh);

  for (let y = 0; y < nh; y++) {
    const v = y / nh;
    for (let x = 0; x < nw; x++) {
      const u = x / nw;
      const warp = periodicNoise2D(u * 4, v * 4, 4, 4, 31) * 0.14;
      const ridge1 = Math.abs(Math.sin((u + warp) * Math.PI * 10));
      const ridge2 = periodicNoise2D(u * 18, v * 5, 18, 5, 47);
      const fine = periodicNoise2D(u * 36, v * 16, 36, 16, 73);
      const plateCrack = Math.pow(periodicNoise2D(u * 10, v * 22, 10, 22, 91), 3);
      height[y * nw + x] = clamp(ridge1 * 0.52 + ridge2 * 0.28 + fine * 0.14 - plateCrack * 0.22, 0, 1);
    }
  }

  const bark = makeCanvasTexture(
    256,
    256,
    (ctx, w, h) => {
      const img = ctx.createImageData(w, h);
      const d = img.data;
      const rand = seededRandom(8401);
      for (let y = 0; y < h; y++) {
        const hy = Math.floor((y / h) * nh);
        for (let x = 0; x < w; x++) {
          const hx = Math.floor((x / w) * nw);
          const hv = height[hy * nw + hx];
          const warm = periodicNoise2D((x / w) * 6, (y / h) * 6, 6, 6, 107);
          const grain = (rand() - 0.5) * 14;
          const r = clamp(lerp(34, lerp(104, 124, warm), hv) + grain, 0, 255);
          const g = clamp(lerp(25, lerp(82, 102, warm), hv) + grain, 0, 255);
          const b = clamp(lerp(19, lerp(64, 84, warm), hv) + grain, 0, 255);
          const idx = (y * w + x) * 4;
          d[idx] = r;
          d[idx + 1] = g;
          d[idx + 2] = b;
          d[idx + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    },
    { repeat: true, anisotropy },
  );

  const barkNormal = makeNormalFromHeight(height, nw, nh, 2.8, anisotropy);
  return { bark, barkNormal };
}

/**
 * Tileable stratified California sandstone / granite canyon rock albedo + normal map.
 */
function buildRockTextures(anisotropy: number): { rock: THREE.CanvasTexture; rockNormal: THREE.DataTexture } {
  const nw = 128;
  const nh = 128;
  const height = new Float32Array(nw * nh);

  for (let y = 0; y < nh; y++) {
    const v = y / nh;
    for (let x = 0; x < nw; x++) {
      const u = x / nw;
      const warp = periodicNoise2D(u * 4, v * 4, 4, 4, 131) * 0.16;
      const strata = Math.sin((v + warp) * Math.PI * 12) * 0.5 + 0.5;
      const block = periodicNoise2D(u * 8, v * 12, 8, 12, 157);
      const grit = periodicNoise2D(u * 28, v * 28, 28, 28, 181);
      const crack = Math.abs(periodicNoise2D(u * 10, v * 6, 10, 6, 211) - 0.5) * 2;
      const fissure = crack < 0.09 ? (0.09 - crack) * 4.5 : 0;
      height[y * nw + x] = clamp(strata * 0.34 + block * 0.42 + grit * 0.24 - fissure, 0, 1);
    }
  }

  const rock = makeCanvasTexture(
    256,
    256,
    (ctx, w, h) => {
      const img = ctx.createImageData(w, h);
      const d = img.data;
      const rand = seededRandom(8509);
      for (let y = 0; y < h; y++) {
        const hy = Math.floor((y / h) * nh);
        const v = y / h;
        for (let x = 0; x < w; x++) {
          const hx = Math.floor((x / w) * nw);
          const hv = height[hy * nw + hx];
          const ochre = periodicNoise2D((x / w) * 5, v * 9, 5, 9, 233);
          const speckle = (rand() - 0.5) * 18;
          const r = clamp(lerp(56, lerp(144, 178, ochre), hv) + speckle, 0, 255);
          const g = clamp(lerp(51, lerp(134, 154, ochre), hv) + speckle, 0, 255);
          const b = clamp(lerp(45, lerp(118, 126, ochre), hv) + speckle, 0, 255);
          const idx = (y * w + x) * 4;
          d[idx] = r;
          d[idx + 1] = g;
          d[idx + 2] = b;
          d[idx + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    },
    { repeat: true, anisotropy },
  );

  const rockNormal = makeNormalFromHeight(height, nw, nh, 3.0, anisotropy);
  return { rock, rockNormal };
}

/**
 * Cast-in-place board-formed architectural concrete with panel seams, tie-holes & subtle weathering.
 */
function buildArchConcreteTextures(anisotropy: number): { archConcrete: THREE.CanvasTexture; archConcreteNormal: THREE.DataTexture } {
  const nw = 128;
  const nh = 128;
  const height = new Float32Array(nw * nh);

  for (let y = 0; y < nh; y++) {
    const v = y / nh;
    for (let x = 0; x < nw; x++) {
      const u = x / nw;
      const macro = periodicNoise2D(u * 4, v * 4, 4, 4, 301);
      const grain = periodicNoise2D(u * 24, v * 24, 24, 24, 313);
      let hVal = 0.55 + (macro - 0.5) * 0.16 + (grain - 0.5) * 0.18;
      if (y % 32 < 1 || x % 64 < 1) hVal -= 0.32;
      height[y * nw + x] = clamp(hVal, 0, 1);
    }
  }

  const archConcrete = makeCanvasTexture(
    256,
    256,
    (ctx, w, h) => {
      ctx.fillStyle = '#a4a29c';
      ctx.fillRect(0, 0, w, h);

      const rand = seededRandom(8603);
      for (let i = 0; i < 24; i++) {
        const cx = rand() * w;
        const cy = rand() * h;
        const rad = 24 + rand() * 56;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
        const shade = rand() > 0.5 ? '235,232,224' : '74,72,68';
        g.addColorStop(0, `rgba(${shade},0.09)`);
        g.addColorStop(1, `rgba(${shade},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
      }

      // Fast direct ImageData mineral aggregate speckle
      const img = ctx.getImageData(0, 0, w, h);
      const d = img.data;
      for (let i = 0; i < 3200; i++) {
        const shade = i % 3 === 0 ? 186 : i % 3 === 1 ? 133 : 110;
        const a = 0.16 + rand() * 0.28;
        const invA = 1 - a;
        const px = (rand() * w) | 0;
        const py = (rand() * h) | 0;
        const off = (py * w + px) * 4;
        d[off] = d[off] * invA + shade * a;
        d[off + 1] = d[off + 1] * invA + (shade - 2) * a;
        d[off + 2] = d[off + 2] * invA + (shade - 6) * a;
      }
      ctx.putImageData(img, 0, 0);

      ctx.strokeStyle = 'rgba(56,54,50,0.42)';
      ctx.lineWidth = 1.5;
      for (let y = 0; y < h; y += 64) {
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(w, y + 0.5);
        ctx.stroke();
        const streak = ctx.createLinearGradient(0, y + 1, 0, y + 14);
        streak.addColorStop(0, 'rgba(65,62,56,0.14)');
        streak.addColorStop(1, 'rgba(65,62,56,0)');
        ctx.fillStyle = streak;
        ctx.fillRect(0, y + 1, w, 13);
      }
      for (let x = 0; x < w; x += 128) {
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, h);
        ctx.stroke();
      }
      for (let py = 32; py < h; py += 64) {
        for (let px = 32; px < w; px += 64) {
          ctx.fillStyle = 'rgba(46,44,40,0.52)';
          ctx.beginPath();
          ctx.arc(px, py, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    },
    { repeat: true, anisotropy },
  );

  const archConcreteNormal = makeNormalFromHeight(height, nw, nh, 1.9, anisotropy);
  return { archConcrete, archConcreteNormal };
}

/**
 * Dark charcoal architectural ribbed steel cladding albedo + crisp rib normal map.
 */
function buildCladdingTextures(anisotropy: number): { cladding: THREE.CanvasTexture; claddingNormal: THREE.DataTexture } {
  const nw = 128;
  const nh = 128;
  const height = new Float32Array(nw * nh);
  const ribs = 16;

  for (let y = 0; y < nh; y++) {
    const v = y / nh;
    const seamDip = y % 64 < 1 ? 0.25 : 0;
    for (let x = 0; x < nw; x++) {
      const phase = ((x / nw) * ribs) % 1;
      let ribH = 0.15;
      if (phase > 0.18 && phase < 0.30) ribH = lerp(0.15, 0.92, (phase - 0.18) / 0.12);
      else if (phase >= 0.30 && phase <= 0.56) ribH = 0.92;
      else if (phase > 0.56 && phase < 0.68) ribH = lerp(0.92, 0.15, (phase - 0.56) / 0.12);
      const micro = periodicNoise2D((x / nw) * 16, v * 12, 16, 12, 409) * 0.04;
      height[y * nw + x] = clamp(ribH + micro - seamDip, 0, 1);
    }
  }

  const cladding = makeCanvasTexture(
    256,
    256,
    (ctx, w, h) => {
      const rw = w / ribs;
      for (let i = 0; i < ribs; i++) {
        const x = i * rw;
        const g = ctx.createLinearGradient(x, 0, x + rw, 0);
        g.addColorStop(0.0, '#2a3038');
        g.addColorStop(0.18, '#262b33');
        g.addColorStop(0.28, '#464e5a');
        g.addColorStop(0.55, '#373e48');
        g.addColorStop(0.68, '#1d2128');
        g.addColorStop(0.84, '#292f37');
        g.addColorStop(1.0, '#2a3038');
        ctx.fillStyle = g;
        ctx.fillRect(x, 0, rw + 1, h);
      }

      for (const sy of [128]) {
        ctx.fillStyle = 'rgba(12,14,18,0.55)';
        ctx.fillRect(0, sy, w, 2);
        ctx.fillStyle = 'rgba(130,142,158,0.22)';
        ctx.fillRect(0, sy + 2, w, 1.5);
      }

      const rand = seededRandom(8713);
      for (let i = 0; i < 450; i++) {
        ctx.fillStyle = rand() > 0.5 ? 'rgba(170,175,180,0.045)' : 'rgba(12,14,18,0.06)';
        ctx.fillRect(rand() * w, rand() * h, 1.5 + rand() * 3, 5 + rand() * 18);
      }
    },
    { repeat: true, anisotropy },
  );

  const claddingNormal = makeNormalFromHeight(height, nw, nh, 2.2, anisotropy);
  return { cladding, claddingNormal };
}

/**
 * Detailed sectional insulated steel roll-up motorsport garage bay door with upper vision glass lites.
 */
function buildBayDoorTexture(anisotropy: number): THREE.CanvasTexture {
  return makeCanvasTexture(
    512,
    512,
    (ctx, w, h) => {
      // Base brushed dark-graphite sectional door panels
      const bg = ctx.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, '#444b54');
      bg.addColorStop(0.55, '#525a64');
      bg.addColorStop(1, '#3d434b');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      const sections = 7;
      const sh = h / sections;

      for (let i = 0; i < sections; i++) {
        const y0 = i * sh;
        // Subtle vertical gradient per section
        const sg = ctx.createLinearGradient(0, y0, 0, y0 + sh);
        sg.addColorStop(0, 'rgba(255,255,255,0.09)');
        sg.addColorStop(0.14, 'rgba(255,255,255,0.02)');
        sg.addColorStop(0.86, 'rgba(0,0,0,0.04)');
        sg.addColorStop(1, 'rgba(0,0,0,0.28)');
        ctx.fillStyle = sg;
        ctx.fillRect(0, y0, w, sh);

        // Micro-rib lines inside each insulated section
        ctx.strokeStyle = 'rgba(28,32,38,0.25)';
        ctx.lineWidth = 1.5;
        for (let r = 1; r <= 3; r++) {
          const ry = y0 + (sh * r) / 4;
          ctx.beginPath();
          ctx.moveTo(10, ry);
          ctx.lineTo(w - 10, ry);
          ctx.stroke();
        }

        // Crisp shadow reveal between door panels
        ctx.fillStyle = '#1d2127';
        ctx.fillRect(0, y0, w, 3.5);
        ctx.fillStyle = 'rgba(185,196,210,0.16)';
        ctx.fillRect(0, y0 + 3.5, w, 1.5);
      }

      // Recessed frosted/tinted architectural vision glass lites on 2nd section from top
      const winY = sh * 1 + 11;
      const winH = sh - 22;
      const panes = 4;
      const marginX = 24;
      const gap = 16;
      const paneW = (w - marginX * 2 - gap * (panes - 1)) / panes;
      for (let p = 0; p < panes; p++) {
        const px = marginX + p * (paneW + gap);
        // Dark anodized rubber gasket frame
        ctx.fillStyle = '#1a1e24';
        ctx.fillRect(px - 4, winY - 4, paneW + 8, winH + 8);
        // Glass interior depth (dim warm garage shop light visible inside)
        const gg = ctx.createLinearGradient(px, winY, px, winY + winH);
        gg.addColorStop(0, '#3a4b5c');
        gg.addColorStop(0.45, '#596975');
        gg.addColorStop(0.75, '#7e7866');
        gg.addColorStop(1, '#313942');
        ctx.fillStyle = gg;
        ctx.fillRect(px, winY, paneW, winH);
        // Subtle diagonal sky specular reflection stripe
        ctx.fillStyle = 'rgba(218,232,245,0.22)';
        ctx.beginPath();
        ctx.moveTo(px + paneW * 0.14, winY);
        ctx.lineTo(px + paneW * 0.44, winY);
        ctx.lineTo(px + paneW * 0.18, winY + winH);
        ctx.lineTo(px, winY + winH);
        ctx.closePath();
        ctx.fill();
      }

      // Recessed lift handle on lower panel
      ctx.fillStyle = '#20242a';
      ctx.fillRect(w * 0.5 - 24, h - sh * 0.62, 48, 12);
      ctx.fillStyle = '#7c8591';
      ctx.fillRect(w * 0.5 - 20, h - sh * 0.62 + 3, 40, 5);

      // Heavy bottom rubber weather seal + subtle road dust gradient
      const dust = ctx.createLinearGradient(0, h - 80, 0, h - 18);
      dust.addColorStop(0, 'rgba(130,120,104,0)');
      dust.addColorStop(1, 'rgba(130,120,104,0.22)');
      ctx.fillStyle = dust;
      ctx.fillRect(0, h - 80, w, 62);
      ctx.fillStyle = '#181a1d';
      ctx.fillRect(0, h - 18, w, 18);

      // Side weather-stripping vertical shadow
      ctx.fillStyle = 'rgba(15,18,22,0.55)';
      ctx.fillRect(0, 0, 10, h);
      ctx.fillRect(w - 10, 0, 10, h);
    },
    { repeat: false, anisotropy },
  );
}

/**
 * Modern anodized aluminum curtain-wall glass window with subtle interior depth & reflections.
 */
function buildGlassWindowTexture(anisotropy: number): THREE.CanvasTexture {
  return makeCanvasTexture(
    512,
    512,
    (ctx, w, h) => {
      // Deep architectural charcoal glass base
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#2a3d52');
      g.addColorStop(0.35, '#3b5368');
      g.addColorStop(0.68, '#283846');
      g.addColorStop(1, '#1c2630');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      // Subtle warm interior ceiling light bars behind tinted glass
      for (const cy of [74, 330]) {
        const lg = ctx.createRadialGradient(w * 0.5, cy, 8, w * 0.5, cy, w * 0.42);
        lg.addColorStop(0, 'rgba(255,222,168,0.28)');
        lg.addColorStop(0.5, 'rgba(240,200,145,0.11)');
        lg.addColorStop(1, 'rgba(240,200,145,0)');
        ctx.fillStyle = lg;
        ctx.fillRect(0, cy - 80, w, 160);
      }

      // Soft oblique California sky reflection streak across glass
      ctx.fillStyle = 'rgba(232,226,214,0.16)';
      ctx.beginPath();
      ctx.moveTo(w * 0.12, 0);
      ctx.lineTo(w * 0.42, 0);
      ctx.lineTo(w * 0.14, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = 'rgba(232,226,214,0.09)';
      ctx.beginPath();
      ctx.moveTo(w * 0.62, 0);
      ctx.lineTo(w * 0.78, 0);
      ctx.lineTo(w * 0.50, h);
      ctx.lineTo(w * 0.36, h);
      ctx.closePath();
      ctx.fill();

      // Dark anodized aluminum mullions (3x2 curtain wall grid)
      ctx.fillStyle = '#1b2027';
      ctx.fillRect(0, 0, w, 14);
      ctx.fillRect(0, h - 14, w, 14);
      ctx.fillRect(0, 0, 14, h);
      ctx.fillRect(w - 14, 0, 14, h);
      ctx.fillRect(0, h * 0.5 - 7, w, 14);
      ctx.fillRect(w / 3 - 6, 0, 12, h);
      ctx.fillRect((w * 2) / 3 - 6, 0, 12, h);

      // Thin metallic specular bevel along mullions
      ctx.fillStyle = 'rgba(160,175,192,0.25)';
      ctx.fillRect(14, h * 0.5 - 8, w - 28, 2);
      ctx.fillRect(w / 3 + 6, 14, 2, h - 28);
      ctx.fillRect((w * 2) / 3 + 6, 14, 2, h - 28);
    },
    { repeat: true, anisotropy },
  );
}

/**
 * Weathered crash-test wall yellow/black hazard chevron apron with realistic rubber tire scuffs & scrapes.
 */
function buildCrashHazardTexture(anisotropy: number): THREE.CanvasTexture {
  return makeCanvasTexture(
    512,
    512,
    (ctx, w, h) => {
      ctx.fillStyle = '#e5a91a';
      ctx.fillRect(0, 0, w, h);

      ctx.fillStyle = '#1b1d21';
      const stripe = 64;
      for (let x = -h; x < w + h; x += stripe * 2) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + stripe, 0);
        ctx.lineTo(x + stripe - h, h);
        ctx.lineTo(x - h, h);
        ctx.closePath();
        ctx.fill();
      }

      const rand = seededRandom(8819);
      // Heavy rubber tire scuff marks & crash scrapes across lower/mid impact zone
      for (let i = 0; i < 48; i++) {
        const sx = rand() * w;
        const sy = h * (0.22 + rand() * 0.72);
        const len = 35 + rand() * 110;
        const ang = (rand() - 0.5) * 0.45;
        ctx.strokeStyle = rand() > 0.25 ? 'rgba(20,21,24,0.34)' : 'rgba(178,175,168,0.38)';
        ctx.lineWidth = 3 + rand() * 11;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + Math.cos(ang) * len, sy + Math.sin(ang) * len);
        ctx.stroke();
      }

      // Chipped concrete flecks + industrial dust
      for (let i = 0; i < 3200; i++) {
        ctx.fillStyle = i % 3 === 0 ? '#b7b3a8' : i % 3 === 1 ? '#181a1d' : '#c79318';
        ctx.globalAlpha = 0.08 + rand() * 0.22;
        const s = 1.5 + rand() * 4;
        ctx.fillRect(rand() * w, rand() * h, s, s * 0.7);
      }
      ctx.globalAlpha = 1;

      // Ground grime along bottom
      const grime = ctx.createLinearGradient(0, h * 0.75, 0, h);
      grime.addColorStop(0, 'rgba(72,66,56,0)');
      grime.addColorStop(1, 'rgba(54,50,44,0.42)');
      ctx.fillStyle = grime;
      ctx.fillRect(0, h * 0.75, w, h * 0.25);
    },
    { repeat: true, anisotropy },
  );
}

/**
 * Hot-dip galvanized corrugated W-beam highway guardrail steel texture with splice bolts & zinc spangle.
 */
function buildGuardrailTexture(anisotropy: number): THREE.CanvasTexture {
  return makeCanvasTexture(
    256,
    256,
    (ctx, w, h) => {
      // Horizontal W-beam specular & trough shading across V
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0.0, '#788088');
      g.addColorStop(0.18, '#b6bec6');
      g.addColorStop(0.32, '#949ca4');
      g.addColorStop(0.50, '#6c747d');
      g.addColorStop(0.68, '#b8c0c8');
      g.addColorStop(0.84, '#929aa2');
      g.addColorStop(1.0, '#6a7078');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      // Zinc spangle mottling
      const rand = seededRandom(8923);
      for (let i = 0; i < 2400; i++) {
        ctx.fillStyle = rand() > 0.5 ? '#cfd6de' : '#6e767e';
        ctx.globalAlpha = 0.08 + rand() * 0.14;
        ctx.fillRect(rand() * w, rand() * h, 2 + rand() * 5, 2 + rand() * 5);
      }
      ctx.globalAlpha = 1;

      // Vertical splice lap & carriage bolts
      ctx.fillStyle = 'rgba(35,39,44,0.42)';
      ctx.fillRect(w * 0.5 - 2, 0, 4, h);
      for (const by of [h * 0.24, h * 0.5, h * 0.76]) {
        for (const bx of [w * 0.5 - 10, w * 0.5 + 10]) {
          ctx.fillStyle = '#535a62';
          ctx.beginPath();
          ctx.arc(bx, by, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#cfd6de';
          ctx.beginPath();
          ctx.arc(bx - 1, by - 1, 1.8, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Subtle warm road-spray weathering along bottom lip
      const spray = ctx.createLinearGradient(0, h * 0.78, 0, h);
      spray.addColorStop(0, 'rgba(92,82,66,0)');
      spray.addColorStop(1, 'rgba(92,82,66,0.28)');
      ctx.fillStyle = spray;
      ctx.fillRect(0, h * 0.78, w, h * 0.22);
    },
    { repeat: true, clampV: true, anisotropy },
  );
}

/**
 * Crisp MUTCD yellow/black highway chevron curve-warning sign.
 */
function buildChevronSignTexture(anisotropy: number): THREE.CanvasTexture {
  return makeCanvasTexture(
    256,
    256,
    (ctx, w, h) => {
      // Retroreflective highway warning amber-yellow
      ctx.fillStyle = '#f2b718';
      ctx.fillRect(0, 0, w, h);

      // Subtle vertical retroreflective metallic sheen
      const sheen = ctx.createLinearGradient(0, 0, w, h);
      sheen.addColorStop(0, 'rgba(255,255,255,0.14)');
      sheen.addColorStop(0.5, 'rgba(255,255,255,0)');
      sheen.addColorStop(1, 'rgba(0,0,0,0.12)');
      ctx.fillStyle = sheen;
      ctx.fillRect(0, 0, w, h);

      // Outer black border inset
      ctx.strokeStyle = '#181a1d';
      ctx.lineWidth = 10;
      ctx.strokeRect(11, 11, w - 22, h - 22);

      // Bold sharp black chevron arrow pointing right (>); flipped via mesh facing for left/right curves
      ctx.fillStyle = '#17191c';
      ctx.beginPath();
      ctx.moveTo(w * 0.26, h * 0.14);
      ctx.lineTo(w * 0.56, h * 0.14);
      ctx.lineTo(w * 0.84, h * 0.50);
      ctx.lineTo(w * 0.56, h * 0.86);
      ctx.lineTo(w * 0.26, h * 0.86);
      ctx.lineTo(w * 0.54, h * 0.50);
      ctx.closePath();
      ctx.fill();

      // Subtle mounting rivets
      ctx.fillStyle = '#8b9098';
      ctx.beginPath();
      ctx.arc(w * 0.5, 24, 3.2, 0, Math.PI * 2);
      ctx.arc(w * 0.5, h - 24, 3.2, 0, Math.PI * 2);
      ctx.fill();
    },
    { repeat: false, anisotropy },
  );
}

/**
 * Generates all bespoke procedural foliage, botanical, rock, architectural, and roadside textures.
 */
export function createFoliageAndPropTextures(anisotropy = 4): FoliageAndPropTextures {
  const aniso = clamp(anisotropy, 1, 4);
  const pineBough = buildPineBoughTexture(aniso);
  const oakLeaf = buildOakLeafTexture(aniso);
  const grassTuft = buildGrassTuftTexture(aniso);
  const { bark, barkNormal } = buildBarkTextures(aniso);
  const { rock, rockNormal } = buildRockTextures(aniso);
  const { archConcrete, archConcreteNormal } = buildArchConcreteTextures(aniso);
  const { cladding, claddingNormal } = buildCladdingTextures(aniso);
  const bayDoor = buildBayDoorTexture(aniso);
  const glassWindow = buildGlassWindowTexture(aniso);
  const crashHazard = buildCrashHazardTexture(aniso);
  const guardrail = buildGuardrailTexture(aniso);
  const chevronSign = buildChevronSignTexture(aniso);

  const all: THREE.Texture[] = [
    pineBough,
    oakLeaf,
    grassTuft,
    bark,
    barkNormal,
    rock,
    rockNormal,
    archConcrete,
    archConcreteNormal,
    cladding,
    claddingNormal,
    bayDoor,
    glassWindow,
    crashHazard,
    guardrail,
    chevronSign,
  ];

  return {
    pineBough,
    oakLeaf,
    grassTuft,
    bark,
    barkNormal,
    rock,
    rockNormal,
    archConcrete,
    archConcreteNormal,
    cladding,
    claddingNormal,
    bayDoor,
    glassWindow,
    crashHazard,
    guardrail,
    chevronSign,
    all,
  };
}
