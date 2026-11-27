import * as THREE from 'three';
import { clamp, lerp, seededRandom } from '../math';

const SIGN_FONT = '"Archivo Variable", "Arial Black", "Segoe UI", sans-serif';

type DrawFn = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

function makeCanvasTexture(
  w: number,
  h: number,
  draw: DrawFn,
  options: { repeat?: boolean; srgb?: boolean; anisotropy?: number; clampU?: boolean } = {},
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx) draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = options.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  if (options.repeat) {
    tex.wrapS = options.clampU ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
  }
  tex.anisotropy = options.anisotropy ?? 1;
  return tex;
}

/** Deterministic periodic 2D value noise that tiles cleanly at integer period (px, py). */
function periodicHash(ix: number, iy: number, px: number, py: number, seed: number): number {
  const x = ((ix % px) + px) % px;
  const y = ((iy % py) + py) % py;
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  n = (n ^ (n >>> 13)) >>> 0;
  n = Math.imul(n, 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function periodicNoise(u: number, v: number, freqX: number, freqY: number, seed: number): number {
  const x = u * freqX;
  const y = v * freqY;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = periodicHash(ix, iy, freqX, freqY, seed);
  const b = periodicHash(ix + 1, iy, freqX, freqY, seed);
  const c = periodicHash(ix, iy + 1, freqX, freqY, seed);
  const d = periodicHash(ix + 1, iy + 1, freqX, freqY, seed);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
}

function periodicFbm(u: number, v: number, baseFreq: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = baseFreq;
  for (let i = 0; i < octaves; i++) {
    sum += periodicNoise(u, v, f, f, seed + i * 97) * amp;
    norm += amp;
    f *= 2;
    amp *= 0.5;
  }
  return sum / norm;
}

function parseHexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Fast direct ImageData mineral/aggregate speckle writer (30x+ faster than tens of thousands of
 * Canvas2D fillRect state calls during OpenWorld startup, with identical visual grain).
 */
function speckle(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  count: number,
  colors: readonly string[],
  size: readonly [number, number],
  alpha: readonly [number, number],
  seed: number,
  xRange: readonly [number, number] = [0, 1],
): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const palette = colors.map(parseHexRgb);
  const palLen = palette.length;
  const rand = seededRandom(seed);
  const x0 = xRange[0] * w;
  const xSpan = (xRange[1] - xRange[0]) * w;
  const sMin = size[0];
  const sSpan = size[1] - size[0];
  const aMin = alpha[0];
  const aSpan = alpha[1] - alpha[0];

  for (let i = 0; i < count; i++) {
    const rgb = palette[(rand() * palLen) | 0];
    const s = sMin + rand() * sSpan;
    const a = aMin + rand() * aSpan;
    const invA = 1 - a;
    const px = (x0 + rand() * xSpan) | 0;
    const py = (rand() * h) | 0;
    const rw = Math.max(1, (s + 0.5) | 0);
    const rh = Math.max(1, (s * (0.65 + rand() * 0.7) + 0.5) | 0);
    const xEnd = px + rw < w ? px + rw : w;
    const yEnd = py + rh < h ? py + rh : h;
    const sr = rgb[0] * a;
    const sg = rgb[1] * a;
    const sb = rgb[2] * a;

    for (let yy = py < 0 ? 0 : py; yy < yEnd; yy++) {
      let off = (yy * w + (px < 0 ? 0 : px)) * 4;
      for (let xx = px < 0 ? 0 : px; xx < xEnd; xx++) {
        d[off] = d[off] * invA + sr;
        d[off + 1] = d[off + 1] * invA + sg;
        d[off + 2] = d[off + 2] * invA + sb;
        off += 4;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Builds a seamlessly tileable tangent-space normal map from a height field evaluator. */
function makeNormalFromHeight(
  w: number,
  h: number,
  sample: (u: number, v: number) => number,
  strength: number,
  anisotropy = 4,
): THREE.DataTexture {
  const heights = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const v = y / h;
    for (let x = 0; x < w; x++) {
      heights[y * w + x] = sample(x / w, v);
    }
  }

  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const ym = (y - 1 + h) % h;
    const yp = (y + 1) % h;
    for (let x = 0; x < w; x++) {
      const xm = (x - 1 + w) % w;
      const xp = (x + 1) % w;
      const dx = (heights[y * w + xp] - heights[y * w + xm]) * strength;
      const dy = (heights[yp * w + x] - heights[ym * w + x]) * strength;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const idx = (y * w + x) * 4;
      data[idx] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      data[idx + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
      data[idx + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      data[idx + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

/** Draws rich weathered charcoal California asphalt with aggregate grain, patches, and subtle tar seams. */
function drawWeatheredAsphalt(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  seed: number,
  baseHex = '#323539',
  crackCount = 5,
): void {
  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, w, h);

  const rand = seededRandom(seed);

  // Broad sun-bleaching & subtle repair patch variation (wrapped seamlessly).
  for (let i = 0; i < 38; i++) {
    const x = rand() * w;
    const y = rand() * h;
    const r = 55 + rand() * 170;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const bright = rand() > 0.45;
    const tone = bright ? '225,220,210' : '16,18,22';
    const op = bright ? 0.045 + rand() * 0.035 : 0.05 + rand() * 0.045;
    g.addColorStop(0, `rgba(${tone},${op})`);
    g.addColorStop(1, `rgba(${tone},0)`);
    ctx.fillStyle = g;
    for (const ox of [-w, 0, w]) {
      for (const oy of [-h, 0, h]) {
        ctx.fillRect(x - r + ox, y - r + oy, r * 2, r * 2);
      }
    }
  }

  // Multi-scale crushed mineral aggregate (warm grey granite, dark basalt, pale quartz flecks).
  speckle(
    ctx,
    w,
    h,
    30000,
    ['#4b4e54', '#5c5e63', '#232529', '#1c1e22', '#424449', '#6e6c67', '#7b7870'],
    [0.9, 2.2],
    [0.18, 0.55],
    seed + 37,
  );
  // Coarser stone chips.
  speckle(
    ctx,
    w,
    h,
    4500,
    ['#66686c', '#202226', '#83807a', '#3d3f44'],
    [2.0, 3.8],
    [0.14, 0.35],
    seed + 83,
  );

  // Subtle meandering tar-sealed asphalt cracks.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let c = 0; c < crackCount; c++) {
    let cx = w * (0.14 + rand() * 0.72);
    let cy = rand() * h;
    const steps = 10 + Math.floor(rand() * 14);
    ctx.strokeStyle = 'rgba(18,19,21,0.68)';
    ctx.lineWidth = 1.4 + rand() * 1.6;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    for (let s = 0; s < steps; s++) {
      cx += (rand() - 0.5) * 34;
      cy += (rand() - 0.25) * 28;
      ctx.lineTo(cx, cy);
    }
    ctx.stroke();
  }
}

/** Draws natural gravel/dusty dirt road shoulder verges on both U edges with feathered organic break-up. */
function drawGravelShoulders(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  leftEdgeU: number,
  rightEdgeU: number,
  dustColor: string,
  gravelColors: readonly string[],
  seed: number,
): void {
  const rand = seededRandom(seed);
  const leftW = leftEdgeU * w;
  const rightX = rightEdgeU * w;
  const rightW = w - rightX;

  // Base dusty earth verge.
  ctx.fillStyle = dustColor;
  ctx.fillRect(0, 0, leftW, h);
  ctx.fillRect(rightX, 0, rightW, h);

  // Soft dusty feather spilling slightly onto the outer asphalt shoulder.
  const gLeft = ctx.createLinearGradient(leftW - 14, 0, leftW + 34, 0);
  gLeft.addColorStop(0, dustColor);
  gLeft.addColorStop(0.45, 'rgba(138,121,98,0.45)');
  gLeft.addColorStop(1, 'rgba(138,121,98,0)');
  ctx.fillStyle = gLeft;
  ctx.fillRect(leftW - 14, 0, 48, h);

  const gRight = ctx.createLinearGradient(rightX + 14, 0, rightX - 34, 0);
  gRight.addColorStop(0, dustColor);
  gRight.addColorStop(0.45, 'rgba(138,121,98,0.45)');
  gRight.addColorStop(1, 'rgba(138,121,98,0)');
  ctx.fillStyle = gRight;
  ctx.fillRect(rightX - 34, 0, 48, h);

  // Irregular chipped asphalt-to-gravel transition pebbles.
  speckle(ctx, w, h, 4200, gravelColors, [1.5, 4.2], [0.28, 0.72], seed + 13, [0, leftEdgeU + 0.03]);
  speckle(ctx, w, h, 4200, gravelColors, [1.5, 4.2], [0.28, 0.72], seed + 29, [rightEdgeU - 0.03, 1]);

  // Subtle loose gravel streaks & shoulder rumble impressions.
  for (let i = 0; i < 180; i++) {
    const onLeft = i % 2 === 0;
    const x = onLeft ? rand() * (leftW + 10) : rightX - 10 + rand() * (rightW + 10);
    const y = rand() * h;
    ctx.fillStyle = rand() > 0.5 ? 'rgba(65,58,48,0.22)' : 'rgba(182,168,145,0.22)';
    ctx.fillRect(x, y, 2 + rand() * 6, 4 + rand() * 14);
  }
}

/** Draws slightly weathered thermoplastic road paint (aggregate specks showing through edges). */
function drawWornStripe(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  seed: number,
): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
  const rand = seededRandom(seed);
  const specks = Math.min(480, Math.round((w * h) / 28));
  ctx.fillStyle = '#33363b';
  for (let i = 0; i < specks; i++) {
    ctx.globalAlpha = 0.14 + rand() * 0.28;
    const sx = x + rand() * w;
    const sy = y + rand() * h;
    ctx.fillRect(sx, sy, 1.2 + rand() * 2.0, 1.2 + rand() * 2.6);
  }
  ctx.globalAlpha = 1;
}

export interface WorldSigns {
  garageHeader: THREE.Texture;
  highwayGantry: THREE.Texture;
  provingEntry: THREE.Texture;
  canyonEntry: THREE.Texture;
  crashLabBanner: THREE.Texture;
  impactWallSign: THREE.Texture;
  rampSign: THREE.Texture;
  slalomSign: THREE.Texture;
}

export interface RunwayDecals {
  mark100m: THREE.Texture;
  mark50m: THREE.Texture;
  mark25m: THREE.Texture;
  markImpact: THREE.Texture;
}

export interface WorldTextures {
  highwayRoad: THREE.Texture;
  highwayRough: THREE.Texture;
  canyonRoad: THREE.Texture;
  canyonRough: THREE.Texture;
  plazaAsphalt: THREE.Texture;
  plazaRough: THREE.Texture;
  provingApron: THREE.Texture;
  asphaltNormal: THREE.Texture;
  concrete: THREE.Texture;
  concreteNormal: THREE.Texture;
  concreteRough: THREE.Texture;
  hazard: THREE.Texture;
  corrugated: THREE.Texture;
  buildingFacade: THREE.Texture;
  terrainDetail: THREE.Texture;
  terrainNormal: THREE.Texture;
  terrainRough: THREE.Texture;
  skidMark: THREE.Texture;
  smokePuff: THREE.Texture;
  spark: THREE.Texture;
  signs: WorldSigns;
  runwayDecals: RunwayDecals;
  all: THREE.Texture[];
}

export function makeSignTexture(
  w: number,
  h: number,
  aniso: number,
  bg: string,
  border: string,
  title: string,
  subtitle: string,
  accent = '#f4b938',
): THREE.CanvasTexture {
  return makeCanvasTexture(
    w,
    h,
    (ctx, cw, ch) => {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, cw, ch);

      // Subtle brushed metallic sheen.
      const grad = ctx.createLinearGradient(0, 0, 0, ch);
      grad.addColorStop(0, 'rgba(255,255,255,0.08)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0)');
      grad.addColorStop(1, 'rgba(0,0,0,0.18)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, cw, ch);

      // Outer border frame.
      ctx.strokeStyle = border;
      ctx.lineWidth = Math.max(6, Math.round(ch * 0.045));
      ctx.strokeRect(14, 14, cw - 28, ch - 28);

      // Top accent stripe.
      ctx.fillStyle = accent;
      ctx.fillRect(28, 28, cw - 56, Math.max(8, Math.round(ch * 0.055)));

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const maxTextWidth = cw - 96;

      const drawFittedText = (text: string, weight: number, idealPx: number, y: number, color: string) => {
        ctx.fillStyle = color;
        ctx.font = `${weight} ${idealPx}px ${SIGN_FONT}`;
        const measured = ctx.measureText(text).width;
        if (measured > maxTextWidth && measured > 0) {
          const fittedPx = Math.max(16, Math.floor((idealPx * maxTextWidth) / measured));
          ctx.font = `${weight} ${fittedPx}px ${SIGN_FONT}`;
        }
        ctx.fillText(text, cw / 2, y, maxTextWidth);
      };

      drawFittedText(title, 900, Math.round(ch * 0.32), subtitle ? ch * 0.49 : ch * 0.56, '#f6f8fa');
      if (subtitle) {
        drawFittedText(subtitle, 700, Math.round(ch * 0.16), ch * 0.77, accent);
      }
    },
    { anisotropy: aniso },
  );
}

function makeRunwayStencil(label: string, accent: string, aniso: number): THREE.CanvasTexture {
  return makeCanvasTexture(
    512,
    256,
    (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      // Weathered painted chevron bar + crisp stencil text.
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.88;
      ctx.fillRect(26, 20, w - 52, 16);
      ctx.fillRect(26, h - 36, w - 52, 16);

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `900 124px ${SIGN_FONT}`;
      const maxW = w - 64;
      const measured = ctx.measureText(label).width;
      if (measured > maxW && measured > 0) {
        ctx.font = `900 ${Math.floor((124 * maxW) / measured)}px ${SIGN_FONT}`;
      }
      ctx.fillText(label, w / 2, h / 2 + 4, maxW);

      // Subtle tire wear scuffs erasing thin streaks of the painted stencil.
      ctx.globalCompositeOperation = 'destination-out';
      const rand = seededRandom(label.length * 131 + 19);
      for (let i = 0; i < 420; i++) {
        ctx.globalAlpha = 0.08 + rand() * 0.22;
        ctx.fillRect(rand() * w, rand() * h, 2 + rand() * 8, 2 + rand() * 4);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    },
    { anisotropy: aniso },
  );
}

export function createWorldTextures(maxAnisotropy: number): WorldTextures {
  const aniso = Math.min(4, maxAnisotropy);
  const all: THREE.Texture[] = [];
  const track = <T extends THREE.Texture>(t: T): T => {
    all.push(t);
    return t;
  };

  // -------------------------------------------------------------------------
  // 1. 4-LANE CALIFORNIA HIGHWAY (1024px albedo + 256px roughness + 256px normal)
  // -------------------------------------------------------------------------
  const highwayRoad = track(
    makeCanvasTexture(
      1024,
      1024,
      (ctx, w, h) => {
        drawWeatheredAsphalt(ctx, w, h, 101, '#313439', 6);

        // Natural dusty California gravel shoulders on outer U edges (0..0.115 and 0.885..1.0).
        drawGravelShoulders(
          ctx,
          w,
          h,
          0.115,
          0.885,
          '#887962',
          ['#a3947c', '#6c6252', '#b3a58e', '#585247', '#7c715e'],
          109,
        );

        // Darkened rubber tire-wear ruts in all 4 lanes.
        const laneCenters = [0.225, 0.39, 0.61, 0.775];
        for (const cx of laneCenters) {
          for (const offset of [-0.04, 0.04]) {
            const x = (cx + offset) * w;
            const g = ctx.createLinearGradient(x - 22, 0, x + 22, 0);
            g.addColorStop(0, 'rgba(14,15,18,0)');
            g.addColorStop(0.5, 'rgba(14,15,18,0.28)');
            g.addColorStop(1, 'rgba(14,15,18,0)');
            ctx.fillStyle = g;
            ctx.fillRect(x - 22, 0, 44, h);
          }
        }

        // Subtle milled shoulder rumble-strip ticks just outside the white edge lines.
        ctx.fillStyle = 'rgba(18,20,24,0.42)';
        for (let y = 8; y < h; y += 26) {
          ctx.fillRect(w * 0.123, y, w * 0.015, 11);
          ctx.fillRect(w * 0.862, y, w * 0.015, 11);
        }

        // Solid weathered white outer edge lines.
        drawWornStripe(ctx, w * 0.146, 0, w * 0.013, h, '#e3e4e2', 121);
        drawWornStripe(ctx, w * 0.841, 0, w * 0.013, h, '#e3e4e2', 122);

        // Double weathered amber-yellow center divider.
        drawWornStripe(ctx, w * 0.486, 0, w * 0.011, h, '#d9a42a', 123);
        drawWornStripe(ctx, w * 0.503, 0, w * 0.011, h, '#d9a42a', 124);

        // Dashed white lane dividers.
        const dashCount = 4;
        const dashStep = h / dashCount;
        const dashLen = dashStep * 0.44;
        for (let i = 0; i < dashCount; i++) {
          const y = i * dashStep + dashStep * 0.14;
          drawWornStripe(ctx, w * 0.305, y, w * 0.011, dashLen, '#e1e2df', 130 + i);
          drawWornStripe(ctx, w * 0.684, y, w * 0.011, dashLen, '#e1e2df', 140 + i);
        }
      },
      { repeat: true, clampU: true, anisotropy: aniso },
    ),
  );

  // Highway roughness map: aggregate asphalt ~0.84, tire-polished ruts ~0.58 (catches warm low sun!), gravel shoulders ~0.96.
  const highwayRough = track(
    makeCanvasTexture(
      256,
      256,
      (ctx, w, h) => {
        ctx.fillStyle = '#d6d6d6'; // ~0.84
        ctx.fillRect(0, 0, w, h);
        speckle(ctx, w, h, 2400, ['#e8e8e8', '#c0c0c0', '#b4b4b4'], [1, 2], [0.25, 0.55], 151);

        // Polished smoother wheel ruts catch realistic grazing sunlight sheen.
        const laneCenters = [0.225, 0.39, 0.61, 0.775];
        for (const cx of laneCenters) {
          for (const offset of [-0.04, 0.04]) {
            const x = (cx + offset) * w;
            const g = ctx.createLinearGradient(x - 7, 0, x + 7, 0);
            g.addColorStop(0, 'rgba(138,138,138,0)');
            g.addColorStop(0.5, 'rgba(138,138,138,0.68)');
            g.addColorStop(1, 'rgba(138,138,138,0)');
            ctx.fillStyle = g;
            ctx.fillRect(x - 7, 0, 14, h);
          }
        }

        // Matte dusty gravel shoulders.
        ctx.fillStyle = '#f5f5f5';
        ctx.fillRect(0, 0, w * 0.12, h);
        ctx.fillRect(w * 0.88, 0, w * 0.12, h);
      },
      { repeat: true, clampU: true, srgb: false, anisotropy: aniso },
    ),
  );

  // -------------------------------------------------------------------------
  // 2. 2-LANE SCENIC CANYON ROAD (1024px albedo + 512px roughness)
  // -------------------------------------------------------------------------
  const canyonRoad = track(
    makeCanvasTexture(
      1024,
      1024,
      (ctx, w, h) => {
        drawWeatheredAsphalt(ctx, w, h, 211, '#393b3f', 9);

        // Warm dusty canyon sandstone/dirt verges on edges (0..0.13 and 0.87..1.0).
        drawGravelShoulders(
          ctx,
          w,
          h,
          0.13,
          0.87,
          '#948064',
          ['#ab977a', '#78674f', '#bdab8f', '#635643', '#8c7a60'],
          219,
        );

        // Worn tire tracks in both lanes.
        for (const cx of [0.33, 0.67]) {
          for (const offset of [-0.055, 0.055]) {
            const x = (cx + offset) * w;
            const g = ctx.createLinearGradient(x - 24, 0, x + 24, 0);
            g.addColorStop(0, 'rgba(16,17,20,0)');
            g.addColorStop(0.5, 'rgba(16,17,20,0.25)');
            g.addColorStop(1, 'rgba(16,17,20,0)');
            ctx.fillStyle = g;
            ctx.fillRect(x - 24, 0, 48, h);
          }
        }

        // Solid white edge lines.
        drawWornStripe(ctx, w * 0.155, 0, w * 0.015, h, '#dfdeda', 225);
        drawWornStripe(ctx, w * 0.83, 0, w * 0.015, h, '#dfdeda', 226);

        // Dashed amber-yellow centerline.
        const dashes = 4;
        const step = h / dashes;
        for (let i = 0; i < dashes; i++) {
          drawWornStripe(ctx, w * 0.491, i * step + step * 0.14, w * 0.018, step * 0.46, '#d9a42a', 230 + i);
        }
      },
      { repeat: true, clampU: true, anisotropy: aniso },
    ),
  );

  const canyonRough = track(
    makeCanvasTexture(
      256,
      256,
      (ctx, w, h) => {
        ctx.fillStyle = '#dcdcdc';
        ctx.fillRect(0, 0, w, h);
        speckle(ctx, w, h, 2400, ['#ebebeb', '#c6c6c6', '#bababa'], [1, 2], [0.25, 0.55], 251);
        for (const cx of [0.33, 0.67]) {
          const x = cx * w;
          const g = ctx.createLinearGradient(x - 18, 0, x + 18, 0);
          g.addColorStop(0, 'rgba(150,150,150,0)');
          g.addColorStop(0.5, 'rgba(150,150,150,0.52)');
          g.addColorStop(1, 'rgba(150,150,150,0)');
          ctx.fillStyle = g;
          ctx.fillRect(x - 18, 0, 36, h);
        }
        ctx.fillStyle = '#f6f6f6';
        ctx.fillRect(0, 0, w * 0.135, h);
        ctx.fillRect(w * 0.865, 0, w * 0.135, h);
      },
      { repeat: true, clampU: true, srgb: false, anisotropy: aniso },
    ),
  );

  // -------------------------------------------------------------------------
  // 3. GARAGE PLAZA & PROVING GROUNDS POURED CONCRETE / TARMAC (1024px PBR)
  // -------------------------------------------------------------------------
  const plazaAsphalt = track(
    makeCanvasTexture(
      1024,
      1024,
      (ctx, w, h) => {
        drawWeatheredAsphalt(ctx, w, h, 307, '#3f4247', 4);
        const rand = seededRandom(313);
        // Subtle 2x2 architectural slab tonal shifts.
        const half = w / 2;
        for (let gy = 0; gy < 2; gy++) {
          for (let gx = 0; gx < 2; gx++) {
            const shade = (rand() - 0.5) * 16;
            ctx.fillStyle = shade > 0 ? `rgba(255,250,242,${shade / 255})` : `rgba(10,12,15,${-shade / 255})`;
            ctx.fillRect(gx * half, gy * half, half, half);
          }
        }
        // Crisp saw-cut control joints with slight concrete lip highlight.
        ctx.strokeStyle = 'rgba(18,20,24,0.62)';
        ctx.lineWidth = 4;
        ctx.strokeRect(2, 2, w - 4, h - 4);
        ctx.beginPath();
        ctx.moveTo(half, 0);
        ctx.lineTo(half, h);
        ctx.moveTo(0, half);
        ctx.lineTo(w, half);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(215,212,205,0.12)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(half + 3, 0);
        ctx.lineTo(half + 3, h);
        ctx.moveTo(0, half + 3);
        ctx.lineTo(w, half + 3);
        ctx.stroke();

        // Faint oil & rubber turnaround marks.
        for (let i = 0; i < 6; i++) {
          const x = rand() * w;
          const y = rand() * h;
          const r = 30 + rand() * 70;
          const g = ctx.createRadialGradient(x, y, 2, x, y, r);
          g.addColorStop(0, 'rgba(15,16,18,0.16)');
          g.addColorStop(1, 'rgba(15,16,18,0)');
          ctx.fillStyle = g;
          ctx.fillRect(x - r, y - r, r * 2, r * 2);
        }
      },
      { repeat: true, anisotropy: aniso },
    ),
  );

  const plazaRough = track(
    makeCanvasTexture(
      256,
      256,
      (ctx, w, h) => {
        ctx.fillStyle = '#cfcfcf';
        ctx.fillRect(0, 0, w, h);
        speckle(ctx, w, h, 2600, ['#e4e4e4', '#bcbcbc', '#aeaeae'], [1, 2.2], [0.25, 0.5], 317);
        const rand = seededRandom(319);
        for (let i = 0; i < 10; i++) {
          const x = rand() * w;
          const y = rand() * h;
          const r = 12 + rand() * 28;
          const g = ctx.createRadialGradient(x, y, 0, x, y, r);
          g.addColorStop(0, 'rgba(120,120,120,0.45)');
          g.addColorStop(1, 'rgba(120,120,120,0)');
          ctx.fillStyle = g;
          ctx.fillRect(x - r, y - r, r * 2, r * 2);
        }
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.strokeRect(1, 1, w - 2, h - 2);
      },
      { repeat: true, srgb: false, anisotropy: aniso },
    ),
  );

  // Proving Grounds poured weathered test-track concrete slabs.
  const provingApron = track(
    makeCanvasTexture(
      1024,
      1024,
      (ctx, w, h) => {
        ctx.fillStyle = '#7c7b77';
        ctx.fillRect(0, 0, w, h);

        const rand = seededRandom(409);
        const cells = 4;
        const step = w / cells;
        for (let gy = 0; gy < cells; gy++) {
          for (let gx = 0; gx < cells; gx++) {
            const delta = (rand() - 0.5) * 18;
            ctx.fillStyle = delta > 0 ? `rgba(255,248,236,${delta / 255})` : `rgba(30,30,32,${-delta / 255})`;
            ctx.fillRect(gx * step, gy * step, step, step);
          }
        }

        // Brushed concrete aggregate grain & warm weathering.
        speckle(
          ctx,
          w,
          h,
          26000,
          ['#96948f', '#666562', '#aaa7a0', '#585754', '#86827a'],
          [1, 3.0],
          [0.18, 0.45],
          419,
        );

        // Tire scuff streaks across the test pad.
        ctx.strokeStyle = 'rgba(26,27,30,0.14)';
        for (let i = 0; i < 14; i++) {
          ctx.lineWidth = 6 + rand() * 10;
          ctx.beginPath();
          const sx = rand() * w;
          const sy = rand() * h;
          ctx.moveTo(sx, sy);
          ctx.quadraticCurveTo(sx + (rand() - 0.5) * 220, sy + (rand() - 0.5) * 180, sx + (rand() - 0.5) * 320, sy + (rand() - 0.5) * 240);
          ctx.stroke();
        }

        // Expansion joints.
        ctx.strokeStyle = 'rgba(34,35,38,0.52)';
        ctx.lineWidth = 3;
        for (let i = 0; i <= cells; i++) {
          const p = i * step;
          ctx.beginPath();
          ctx.moveTo(p, 0);
          ctx.lineTo(p, h);
          ctx.moveTo(0, p);
          ctx.lineTo(w, p);
          ctx.stroke();
        }
      },
      { repeat: true, anisotropy: aniso },
    ),
  );

  // Multi-scale asphalt aggregate + fine crack normal map (256x256).
  const asphaltNormal = track(
    makeNormalFromHeight(
      256,
      256,
      (u, v) => {
        const fine = periodicNoise(u, v, 64, 64, 511) * 0.45;
        const med = periodicNoise(u, v, 32, 32, 523) * 0.35;
        const macro = periodicFbm(u, v, 8, 3, 541) * 0.2;
        return fine + med + macro;
      },
      1.6,
      aniso,
    ),
  );

  // -------------------------------------------------------------------------
  // 4. CAST ARCHITECTURAL CONCRETE (512px albedo + 256px normal + 256px rough)
  // -------------------------------------------------------------------------
  const concrete = track(
    makeCanvasTexture(
      512,
      512,
      (ctx, w, h) => {
        ctx.fillStyle = '#aba79e';
        ctx.fillRect(0, 0, w, h);

        const rand = seededRandom(613);
        for (let i = 0; i < 20; i++) {
          const x = rand() * w;
          const y = rand() * h;
          const r = 35 + rand() * 95;
          const g = ctx.createRadialGradient(x, y, 0, x, y, r);
          const tone = rand() > 0.5 ? '235,228,216' : '72,68,62';
          g.addColorStop(0, `rgba(${tone},0.08)`);
          g.addColorStop(1, `rgba(${tone},0)`);
          ctx.fillStyle = g;
          for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) ctx.fillRect(x - r + ox, y - r + oy, r * 2, r * 2);
        }

        speckle(
          ctx,
          w,
          h,
          5500,
          ['#959189', '#beb9b0', '#7e7a72', '#cac5bc', '#8c867c'],
          [1.0, 2.4],
          [0.18, 0.44],
          619,
        );

        ctx.strokeStyle = 'rgba(62,59,54,0.34)';
        ctx.lineWidth = 1.5;
        for (let y = 128; y <= h; y += 128) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }
        for (let x = 128; x <= w; x += 128) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(56,53,48,0.35)';
        for (let y = 64; y < h; y += 128) {
          for (let x = 64; x < w; x += 128) {
            ctx.beginPath();
            ctx.arc(x, y, 3, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      },
      { repeat: true, anisotropy: aniso },
    ),
  );

  const concreteNormal = track(
    makeNormalFromHeight(
      256,
      256,
      (u, v) => {
        const grain = periodicNoise(u, v, 64, 64, 631) * 0.32 + periodicFbm(u, v, 12, 3, 643) * 0.45;
        const seamX = Math.min(Math.abs((u * 4) % 1), 1 - Math.abs((u * 4) % 1));
        const seamY = Math.min(Math.abs((v * 4) % 1), 1 - Math.abs((v * 4) % 1));
        const seam = seamX < 0.015 || seamY < 0.015 ? -0.35 : 0;
        return grain + seam;
      },
      1.35,
      aniso,
    ),
  );

  const concreteRough = track(
    makeCanvasTexture(
      256,
      256,
      (ctx, w, h) => {
        ctx.fillStyle = '#dfdfdf';
        ctx.fillRect(0, 0, w, h);
        speckle(ctx, w, h, 2200, ['#f2f2f2', '#c8c8c8', '#bababa'], [1, 2.5], [0.22, 0.48], 653);
      },
      { repeat: true, srgb: false, anisotropy: aniso },
    ),
  );

  // Scuffed industrial hazard chevrons (compact; crash-test walls use foliageTextures.crashHazard).
  const hazard = track(
    makeCanvasTexture(
      128,
      128,
      (ctx, w, h) => {
        ctx.fillStyle = '#e4ad26';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#1d1f22';
        const stripe = 16;
        for (let x = -h; x < w + h; x += stripe * 2) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x + stripe, 0);
          ctx.lineTo(x + stripe - h, h);
          ctx.lineTo(x - h, h);
          ctx.closePath();
          ctx.fill();
        }
      },
      { repeat: true, anisotropy: aniso },
    ),
  );

  // Corrugated industrial metal siding.
  const corrugated = track(
    makeCanvasTexture(
      256,
      256,
      (ctx, w, h) => {
        ctx.fillStyle = '#c5cbd1';
        ctx.fillRect(0, 0, w, h);
        const ribs = 16;
        const rw = w / ribs;
        for (let i = 0; i < ribs; i++) {
          const x = i * rw;
          const g = ctx.createLinearGradient(x, 0, x + rw, 0);
          g.addColorStop(0, '#8d949d');
          g.addColorStop(0.28, '#d9dfe6');
          g.addColorStop(0.55, '#bcc3cc');
          g.addColorStop(0.85, '#7e8690');
          g.addColorStop(1, '#8d949d');
          ctx.fillStyle = g;
          ctx.fillRect(x, 0, rw, h);
        }
        speckle(ctx, w, h, 900, ['#6a7078', '#dfe4ea'], [1, 2], [0.05, 0.14], 733);
      },
      { repeat: true, anisotropy: aniso },
    ),
  );

  // Compact facade texture preserved for WorldTextures compatibility.
  const buildingFacade = track(
    makeCanvasTexture(
      128,
      128,
      (ctx, w, h) => {
        ctx.fillStyle = '#383f48';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#2b3038';
        ctx.fillRect(0, 52, w, 76);
        ctx.fillStyle = '#dfa325';
        ctx.fillRect(0, 48, w, 4);
      },
      { repeat: true, anisotropy: aniso },
    ),
  );

  // -------------------------------------------------------------------------
  // 5. CALIFORNIA COASTAL TERRAIN DETAIL PBR SET (512px dual-scale albedo + 256px normal + rough)
  // -------------------------------------------------------------------------
  const terrainDetail = track(
    makeCanvasTexture(
      512,
      512,
      (ctx, w, h) => {
        ctx.fillStyle = '#e5e2db';
        ctx.fillRect(0, 0, w, h);

        const rand = seededRandom(881);
        for (let i = 0; i < 45; i++) {
          const x = rand() * w;
          const y = rand() * h;
          const r = 16 + rand() * 55;
          const g = ctx.createRadialGradient(x, y, 0, x, y, r);
          const bright = rand() > 0.48;
          const c = bright ? '255,252,244' : '125,118,104';
          g.addColorStop(0, `rgba(${c},${0.1 + rand() * 0.12})`);
          g.addColorStop(1, `rgba(${c},0)`);
          ctx.fillStyle = g;
          for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) ctx.fillRect(x - r + ox, y - r + oy, r * 2, r * 2);
        }

        speckle(
          ctx,
          w,
          h,
          9500,
          ['#f7f4ec', '#c9c4b8', '#b5afa2', '#dcd7cc', '#a49d8e'],
          [1.0, 2.6],
          [0.18, 0.44],
          887,
        );

        ctx.lineWidth = 1.0;
        for (let i = 0; i < 650; i++) {
          const x = rand() * w;
          const y = rand() * h;
          const len = 3 + rand() * 6;
          const ang = (rand() - 0.5) * 1.4;
          ctx.strokeStyle = rand() > 0.5 ? 'rgba(248,242,226,0.22)' : 'rgba(110,104,90,0.22)';
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
          ctx.stroke();
        }
      },
      { repeat: true, anisotropy: aniso },
    ),
  );

  const terrainNormal = track(
    makeNormalFromHeight(
      256,
      256,
      (u, v) => {
        const coarse = periodicFbm(u, v, 6, 4, 907) * 0.6;
        const pebbles = periodicNoise(u, v, 48, 48, 919) * 0.25;
        const grit = periodicNoise(u, v, 96, 96, 929) * 0.15;
        return clamp(coarse + pebbles + grit, 0, 1);
      },
      2.6,
      aniso,
    ),
  );

  const terrainRough = track(
    makeCanvasTexture(
      256,
      256,
      (ctx, w, h) => {
        ctx.fillStyle = '#ececec';
        ctx.fillRect(0, 0, w, h);
        speckle(ctx, w, h, 2400, ['#ffffff', '#dadada', '#c8c8c8'], [1.2, 3], [0.22, 0.5], 937);
      },
      { repeat: true, srgb: false, anisotropy: aniso },
    ),
  );

  // Soft feathered dual-track tire skidmark strip.
  const skidMark = track(
    makeCanvasTexture(
      128,
      128,
      (ctx, w, h) => {
        ctx.clearRect(0, 0, w, h);
        const g = ctx.createLinearGradient(0, 0, w, 0);
        g.addColorStop(0, 'rgba(15,15,16,0)');
        g.addColorStop(0.18, 'rgba(15,15,16,0.82)');
        g.addColorStop(0.45, 'rgba(18,18,20,0.65)');
        g.addColorStop(0.55, 'rgba(18,18,20,0.65)');
        g.addColorStop(0.82, 'rgba(15,15,16,0.82)');
        g.addColorStop(1, 'rgba(15,15,16,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(w * 0.28, 0, w * 0.06, h);
        ctx.fillRect(w * 0.66, 0, w * 0.06, h);
      },
      { anisotropy: 2 },
    ),
  );

  // Soft radial smoke puff sprite.
  const smokePuff = track(
    makeCanvasTexture(128, 128, (ctx, w, h) => {
      const g = ctx.createRadialGradient(w / 2, h / 2, 4, w / 2, h / 2, w / 2);
      g.addColorStop(0, 'rgba(220,224,230,0.92)');
      g.addColorStop(0.45, 'rgba(185,190,198,0.52)');
      g.addColorStop(1, 'rgba(160,165,172,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }),
  );

  // Bright spark sprite.
  const spark = track(
    makeCanvasTexture(64, 64, (ctx, w, h) => {
      const g = ctx.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
      g.addColorStop(0, 'rgba(255,255,235,1)');
      g.addColorStop(0.35, 'rgba(255,205,70,0.95)');
      g.addColorStop(0.75, 'rgba(255,115,20,0.45)');
      g.addColorStop(1, 'rgba(255,80,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }),
  );

  const signs: WorldSigns = {
    garageHeader: track(makeSignTexture(1024, 256, aniso, '#1d2229', '#e5a823', 'BLEND GARAGE', 'CUSTOM WORKS & PROVING GROUNDS', '#f4b938')),
    highwayGantry: track(makeSignTexture(1024, 256, aniso, '#14583c', '#f2f5f7', 'VALLEY HIGHWAY LOOP', 'TOP SPEED STRAIGHTAWAY  •  4 LANES', '#f2f5f7')),
    provingEntry: track(makeSignTexture(1024, 256, aniso, '#22262b', '#f2b824', 'CRASH PROVING GROUNDS', 'IMPACT WALLS  •  STUNT RAMP  •  SLALOM', '#f2b824')),
    canyonEntry: track(makeSignTexture(1024, 256, aniso, '#1a5a42', '#f0f4f7', 'CANYON PASS', 'WINDING HILLSIDE CURVES  •  ELEVATION', '#f4c44e')),
    crashLabBanner: track(makeSignTexture(1024, 256, aniso, '#242930', '#ef5a3c', 'CRASH TEST LAB', 'STRUCTURAL DEFORMATION FACILITY', '#f2b824')),
    impactWallSign: track(makeSignTexture(512, 256, aniso, '#1f2226', '#f2b824', 'IMPACT WALL', '100 KM/H TEST LANE', '#f2b824')),
    rampSign: track(makeSignTexture(512, 256, aniso, '#1f2226', '#38bdf8', 'STUNT RAMP', 'LAUNCH APRON AHEAD', '#38bdf8')),
    slalomSign: track(makeSignTexture(512, 256, aniso, '#1f2226', '#fb923c', 'SLALOM COURSE', 'CHICANE & HANDLING', '#fb923c')),
  };

  const runwayDecals: RunwayDecals = {
    mark100m: track(makeRunwayStencil('100M', '#ecece7', aniso)),
    mark50m: track(makeRunwayStencil('50M', '#f0c03e', aniso)),
    mark25m: track(makeRunwayStencil('25M', '#f29a2e', aniso)),
    markImpact: track(makeRunwayStencil('IMPACT', '#e44c3c', aniso)),
  };

  return {
    highwayRoad,
    highwayRough,
    canyonRoad,
    canyonRough,
    plazaAsphalt,
    plazaRough,
    provingApron,
    asphaltNormal,
    concrete,
    concreteNormal,
    concreteRough,
    hazard,
    corrugated,
    buildingFacade,
    terrainDetail,
    terrainNormal,
    terrainRough,
    skidMark,
    smokePuff,
    spark,
    signs,
    runwayDecals,
    all,
  };
}
