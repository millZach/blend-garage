import * as THREE from 'three';
import { seededRandom } from '../math';

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

function speckle(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  count: number,
  colors: readonly string[],
  size: readonly [number, number],
  alpha: readonly [number, number],
  seed: number,
): void {
  const rand = seededRandom(seed);
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[Math.floor(rand() * colors.length)];
    const s = size[0] + rand() * (size[1] - size[0]);
    ctx.globalAlpha = alpha[0] + rand() * (alpha[1] - alpha[0]);
    ctx.fillRect(rand() * w, rand() * h, s, s * (0.7 + rand() * 0.6));
  }
  ctx.globalAlpha = 1;
}

function drawAsphaltBase(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number, baseColor = '#34383d'): void {
  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, w, h);

  // Subtle macro variation for worn aggregate feel.
  const rand = seededRandom(seed);
  for (let i = 0; i < 24; i++) {
    const x = rand() * w;
    const y = rand() * h;
    const r = 60 + rand() * 140;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const tone = rand() > 0.5 ? '255,255,255' : '12,14,18';
    g.addColorStop(0, `rgba(${tone},0.055)`);
    g.addColorStop(1, `rgba(${tone},0)`);
    ctx.fillStyle = g;
    for (const ox of [-w, 0, w]) {
      for (const oy of [-h, 0, h]) {
        ctx.fillRect(x - r + ox, y - r + oy, r * 2, r * 2);
      }
    }
  }

  // Fine stone aggregate speckle.
  speckle(
    ctx,
    w,
    h,
    18000,
    ['#4f545b', '#636870', '#23262a', '#1b1d21', '#45494f', '#72767d'],
    [1, 2.6],
    [0.2, 0.55],
    seed + 37,
  );
}

function makeNormalFromNoise(w: number, h: number, seed: number, strength: number): THREE.DataTexture {
  const rand = seededRandom(seed);
  const grid = new Float32Array(w * h);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();

  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const ym = (y - 1 + h) % h;
    const yp = (y + 1) % h;
    for (let x = 0; x < w; x++) {
      const xm = (x - 1 + w) % w;
      const xp = (x + 1) % w;
      const dx = (grid[y * w + xp] - grid[y * w + xm]) * strength;
      const dy = (grid[yp * w + x] - grid[ym * w + x]) * strength;
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
  tex.needsUpdate = true;
  return tex;
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

export interface WorldTextures {
  highwayRoad: THREE.Texture;
  canyonRoad: THREE.Texture;
  plazaAsphalt: THREE.Texture;
  provingApron: THREE.Texture;
  asphaltNormal: THREE.Texture;
  concrete: THREE.Texture;
  hazard: THREE.Texture;
  corrugated: THREE.Texture;
  buildingFacade: THREE.Texture;
  terrainDetail: THREE.Texture;
  skidMark: THREE.Texture;
  smokePuff: THREE.Texture;
  spark: THREE.Texture;
  signs: WorldSigns;
  all: THREE.Texture[];
}

function makeSignTexture(
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

export function createWorldTextures(maxAnisotropy: number): WorldTextures {
  const aniso = Math.min(8, maxAnisotropy);
  const all: THREE.Texture[] = [];
  const track = <T extends THREE.Texture>(t: T): T => {
    all.push(t);
    return t;
  };

  // 4-lane highway road strip (U: 0..1 across width including shoulders, V: tiles along length every 24m).
  const highwayRoad = track(
    makeCanvasTexture(
      1024,
      1024,
      (ctx, w, h) => {
        drawAsphaltBase(ctx, w, h, 101, '#2f3338');

        // Gravel/concrete shoulder strips at U edges (0..0.075 and 0.925..1.0).
        ctx.fillStyle = '#5c5f63';
        ctx.fillRect(0, 0, w * 0.075, h);
        ctx.fillRect(w * 0.925, 0, w * 0.075, h);
        speckle(ctx, w * 0.075, h, 1200, ['#73777c', '#45484c', '#898b8d'], [1.5, 3.2], [0.3, 0.65], 103);

        // Tire wear dark bands in all 4 lanes.
        const laneCenters = [0.2, 0.38, 0.62, 0.8];
        for (const cx of laneCenters) {
          for (const offset of [-0.045, 0.045]) {
            const x = (cx + offset) * w;
            const g = ctx.createLinearGradient(x - 24, 0, x + 24, 0);
            g.addColorStop(0, 'rgba(15,17,20,0)');
            g.addColorStop(0.5, 'rgba(15,17,20,0.22)');
            g.addColorStop(1, 'rgba(15,17,20,0)');
            ctx.fillStyle = g;
            ctx.fillRect(x - 24, 0, 48, h);
          }
        }

        // Solid white outer edge lines.
        ctx.fillStyle = '#eceef0';
        ctx.fillRect(w * 0.092, 0, w * 0.015, h);
        ctx.fillRect(w * 0.893, 0, w * 0.015, h);

        // Double solid amber-yellow center divider.
        ctx.fillStyle = '#eab32e';
        ctx.fillRect(w * 0.484, 0, w * 0.012, h);
        ctx.fillRect(w * 0.504, 0, w * 0.012, h);

        // Dashed white lane dividers (left pair & right pair).
        ctx.fillStyle = '#e7ebee';
        const dashCount = 4;
        const dashStep = h / dashCount;
        const dashLen = dashStep * 0.46;
        for (let i = 0; i < dashCount; i++) {
          const y = i * dashStep + dashStep * 0.12;
          ctx.fillRect(w * 0.288, y, w * 0.012, dashLen);
          ctx.fillRect(w * 0.7, y, w * 0.012, dashLen);
        }
      },
      { repeat: true, clampU: true, anisotropy: aniso },
    ),
  );

  // 2-lane scenic canyon/hillside road (U: 0..1 across width, V: tiles every 18m).
  const canyonRoad = track(
    makeCanvasTexture(
      512,
      512,
      (ctx, w, h) => {
        drawAsphaltBase(ctx, w, h, 211, '#36393e');

        // Dusty rock shoulders at edges.
        ctx.fillStyle = '#6f695e';
        ctx.fillRect(0, 0, w * 0.085, h);
        ctx.fillRect(w * 0.915, 0, w * 0.085, h);

        // Subtle tire tracks in each lane.
        for (const cx of [0.3, 0.7]) {
          const x = cx * w;
          const g = ctx.createLinearGradient(x - 36, 0, x + 36, 0);
          g.addColorStop(0, 'rgba(15,17,20,0)');
          g.addColorStop(0.5, 'rgba(15,17,20,0.2)');
          g.addColorStop(1, 'rgba(15,17,20,0)');
          ctx.fillStyle = g;
          ctx.fillRect(x - 36, 0, 72, h);
        }

        // Solid white edge lines.
        ctx.fillStyle = '#e6e8ea';
        ctx.fillRect(w * 0.11, 0, w * 0.018, h);
        ctx.fillRect(w * 0.872, 0, w * 0.018, h);

        // Dashed yellow center line.
        ctx.fillStyle = '#eab32e';
        const dashes = 4;
        const step = h / dashes;
        for (let i = 0; i < dashes; i++) {
          ctx.fillRect(w * 0.49, i * step + step * 0.15, w * 0.02, step * 0.48);
        }
      },
      { repeat: true, clampU: true, anisotropy: aniso },
    ),
  );

  // Plaza asphalt with architectural expansion joints.
  const plazaAsphalt = track(
    makeCanvasTexture(
      512,
      512,
      (ctx, w, h) => {
        drawAsphaltBase(ctx, w, h, 307, '#3c4046');
        ctx.strokeStyle = 'rgba(20,23,28,0.45)';
        ctx.lineWidth = 3;
        ctx.strokeRect(1.5, 1.5, w - 3, h - 3);
        ctx.beginPath();
        ctx.moveTo(w / 2, 0);
        ctx.lineTo(w / 2, h);
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.stroke();
      },
      { repeat: true, anisotropy: aniso },
    ),
  );

  // Proving grounds lighter concrete-tarmac pad with crisp grid joints.
  const provingApron = track(
    makeCanvasTexture(
      512,
      512,
      (ctx, w, h) => {
        drawAsphaltBase(ctx, w, h, 409, '#54585d');
        ctx.strokeStyle = 'rgba(30,33,38,0.42)';
        ctx.lineWidth = 2.5;
        for (let i = 0; i <= 4; i++) {
          const p = (i * w) / 4;
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

  const asphaltNormal = track(makeNormalFromNoise(256, 256, 519, 0.45));

  // Weathered cast concrete for barriers, curbs, ramps, and foundations.
  const concrete = track(
    makeCanvasTexture(
      512,
      512,
      (ctx, w, h) => {
        ctx.fillStyle = '#adb0b3';
        ctx.fillRect(0, 0, w, h);
        speckle(ctx, w, h, 9000, ['#979b9f', '#c2c5c8', '#7e8286', '#cfd2d5'], [1.5, 4], [0.18, 0.45], 613);
        // Subtle formwork seams & tie holes.
        ctx.strokeStyle = 'rgba(70,74,78,0.28)';
        ctx.lineWidth = 2;
        for (let y = 128; y < h; y += 128) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }
      },
      { repeat: true, anisotropy: aniso },
    ),
  );

  // Bold yellow/black diagonal hazard stripes for crash-test walls & pillars.
  const hazard = track(
    makeCanvasTexture(
      512,
      512,
      (ctx, w, h) => {
        ctx.fillStyle = '#f2b824';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#1b1d20';
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
        // Mild industrial scuffing.
        speckle(ctx, w, h, 2400, ['#ffffff', '#121315', '#c99718'], [1.5, 3.5], [0.06, 0.18], 719);
      },
      { repeat: true, anisotropy: aniso },
    ),
  );

  // Corrugated industrial metal siding.
  const corrugated = track(
    makeCanvasTexture(
      512,
      512,
      (ctx, w, h) => {
        ctx.fillStyle = '#cfd4da';
        ctx.fillRect(0, 0, w, h);
        const ribs = 16;
        const rw = w / ribs;
        for (let i = 0; i < ribs; i++) {
          const x = i * rw;
          const g = ctx.createLinearGradient(x, 0, x + rw, 0);
          g.addColorStop(0, '#9aa1aa');
          g.addColorStop(0.28, '#dfe4ea');
          g.addColorStop(0.55, '#c4cbd3');
          g.addColorStop(0.85, '#899099');
          g.addColorStop(1, '#9aa1aa');
          ctx.fillStyle = g;
          ctx.fillRect(x, 0, rw, h);
        }
      },
      { repeat: true, anisotropy: aniso },
    ),
  );

  // Industrial workshop / garage facade with bay doors and windows.
  const buildingFacade = track(
    makeCanvasTexture(
      512,
      512,
      (ctx, w, h) => {
        ctx.fillStyle = '#3c434d';
        ctx.fillRect(0, 0, w, h);
        // Upper window band.
        ctx.fillStyle = '#7fa5c7';
        for (let i = 0; i < 4; i++) {
          const x = 22 + i * 122;
          ctx.fillRect(x, 46, 98, 110);
          ctx.strokeStyle = '#1f242b';
          ctx.lineWidth = 6;
          ctx.strokeRect(x, 46, 98, 110);
        }
        // Lower structural panels.
        ctx.fillStyle = '#2d323a';
        ctx.fillRect(0, 210, w, 302);
        ctx.fillStyle = '#e5a823';
        ctx.fillRect(0, 198, w, 14);
        // Roll-up bay doors.
        for (let i = 0; i < 2; i++) {
          const x = 36 + i * 236;
          ctx.fillStyle = '#606873';
          ctx.fillRect(x, 240, 204, 272);
          ctx.strokeStyle = '#383e46';
          ctx.lineWidth = 3;
          for (let y = 264; y < 512; y += 26) {
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + 204, y);
            ctx.stroke();
          }
        }
      },
      { repeat: true, anisotropy: aniso },
    ),
  );

  // Subtle neutral detail map multiplied onto vertex-colored grass/dirt/rock terrain.
  const terrainDetail = track(
    makeCanvasTexture(
      512,
      512,
      (ctx, w, h) => {
        ctx.fillStyle = '#e6e6e6';
        ctx.fillRect(0, 0, w, h);
        speckle(ctx, w, h, 14000, ['#ffffff', '#cfcfcf', '#bdbdbd', '#f2f2f2'], [1.5, 4.5], [0.22, 0.45], 881);
      },
      { repeat: true, anisotropy: aniso },
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
        // Subtle longitudinal tread grooves.
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

  return {
    highwayRoad,
    canyonRoad,
    plazaAsphalt,
    provingApron,
    asphaltNormal,
    concrete,
    hazard,
    corrugated,
    buildingFacade,
    terrainDetail,
    skidMark,
    smokePuff,
    spark,
    signs,
    all,
  };
}
