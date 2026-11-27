import * as THREE from 'three';
import { seededRandom } from '../math';

const SIGN_FONT = '"Archivo Variable", "Arial Black", "Segoe UI", sans-serif';

type Draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

function canvasTexture(w: number, h: number, draw: Draw, options: { repeat?: boolean; srgb?: boolean; anisotropy?: number } = {}): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx) draw(ctx, w, h);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = options.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  if (options.repeat) texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = options.anisotropy ?? 1;
  return texture;
}

/** Builds a tangent-space normal map from a height function sampled on a wrapping grid. */
function normalMapFromHeight(w: number, h: number, height: (u: number, v: number) => number, strength: number): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const v = y / h;
      const dx = (height(u + 1 / w, v) - height(u - 1 / w, v)) * strength;
      const dy = (height(u, v + 1 / h) - height(u, v - 1 / h)) * strength;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      data[i] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function speckle(ctx: CanvasRenderingContext2D, w: number, h: number, count: number, colors: string[], size: [number, number], seed: number): void {
  const rand = seededRandom(seed);
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[Math.floor(rand() * colors.length)];
    const s = size[0] + rand() * (size[1] - size[0]);
    ctx.globalAlpha = 0.25 + rand() * 0.6;
    ctx.fillRect(rand() * w, rand() * h, s, s * (0.6 + rand() * 0.8));
  }
  ctx.globalAlpha = 1;
}

function signTexture(w: number, h: number, anisotropy: number, draw: Draw): THREE.CanvasTexture {
  return canvasTexture(w, h, draw, { anisotropy });
}

export interface ShopTextures {
  floorColor: THREE.Texture;
  floorRough: THREE.Texture;
  apronColor: THREE.Texture;
  corrugatedNormal: THREE.Texture;
  blockColor: THREE.Texture;
  insulationNormal: THREE.Texture;
  pegboard: THREE.Texture;
  wood: THREE.Texture;
  hazard: THREE.Texture;
  grate: THREE.Texture;
  tread: THREE.Texture;
  blob: THREE.Texture;
  sunPatch: THREE.Texture;
  glow: THREE.Texture;
  beam: THREE.Texture;
  headerSign: THREE.Texture;
  bayNumbers: THREE.Texture[];
  liftLabel: THREE.Texture;
  safetySign: THREE.Texture;
  clock: THREE.Texture;
  bottleLabels: THREE.Texture;
  turntable: THREE.Texture;
  all: THREE.Texture[];
}

export function createShopTextures(maxAnisotropy: number): ShopTextures {
  const aniso = Math.min(8, maxAnisotropy);

  // Sealed epoxy floor with decorative flake, tiled every 3 m.
  const floorColor = canvasTexture(
    1024,
    1024,
    (ctx, w, h) => {
      ctx.fillStyle = '#8d9193';
      ctx.fillRect(0, 0, w, h);
      const rand = seededRandom(11);
      for (let i = 0; i < 26; i++) {
        const x = rand() * w;
        const y = rand() * h;
        const r = 120 + rand() * 260;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        const tone = rand() > 0.5 ? '255,255,255' : '40,44,48';
        g.addColorStop(0, `rgba(${tone},0.07)`);
        g.addColorStop(1, `rgba(${tone},0)`);
        ctx.fillStyle = g;
        // Draw wrapped so the tile repeats without seams.
        for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) ctx.fillRect(x - r + ox, y - r + oy, r * 2, r * 2);
      }
      speckle(ctx, w, h, 15000, ['#c9cdd0', '#eef0f1', '#5b6166', '#3a3f44', '#a7adb1', '#7f8f9c'], [1.2, 3.4], 5);
    },
    { repeat: true, anisotropy: aniso },
  );
  const floorRough = canvasTexture(
    512,
    512,
    (ctx, w, h) => {
      ctx.fillStyle = '#6a6a6a';
      ctx.fillRect(0, 0, w, h);
      const rand = seededRandom(23);
      for (let i = 0; i < 60; i++) {
        const x = rand() * w;
        const y = rand() * h;
        const r = 40 + rand() * 130;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        const v = rand() > 0.55 ? 150 : 60;
        g.addColorStop(0, `rgba(${v},${v},${v},0.3)`);
        g.addColorStop(1, `rgba(${v},${v},${v},0)`);
        ctx.fillStyle = g;
        for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) ctx.fillRect(x - r + ox, y - r + oy, r * 2, r * 2);
      }
    },
    { repeat: true, srgb: false, anisotropy: aniso },
  );

  const apronColor = canvasTexture(
    512,
    512,
    (ctx, w, h) => {
      ctx.fillStyle = '#5e6062';
      ctx.fillRect(0, 0, w, h);
      speckle(ctx, w, h, 9000, ['#7a7c7e', '#48494b', '#8c8d8e', '#3c3d3f'], [1, 3], 41);
    },
    { repeat: true, anisotropy: aniso },
  );

  // Ribbed metal wall cladding: one rib per tile, repeated horizontally.
  const corrugatedNormal = normalMapFromHeight(
    64,
    4,
    (u) => {
      const t = ((u % 1) + 1) % 1;
      const ramp = 0.14;
      if (t < ramp) return t / ramp;
      if (t < 0.5 - ramp) return 1;
      if (t < 0.5) return (0.5 - t) / ramp;
      return 0;
    },
    5.5,
  );

  // Painted concrete block for the lower wall.
  const blockColor = canvasTexture(
    512,
    512,
    (ctx, w, h) => {
      ctx.fillStyle = '#39424c';
      ctx.fillRect(0, 0, w, h);
      speckle(ctx, w, h, 5000, ['#434d58', '#303841', '#4a545f'], [1, 3], 77);
      ctx.strokeStyle = 'rgba(18,22,26,0.55)';
      ctx.lineWidth = 3;
      const rows = 4;
      const bh = h / rows;
      for (let r = 0; r < rows; r++) {
        ctx.beginPath();
        ctx.moveTo(0, r * bh);
        ctx.lineTo(w, r * bh);
        ctx.stroke();
        for (let c = 0; c < 2; c++) {
          const x = (c + (r % 2) * 0.5) * (w / 2);
          ctx.beginPath();
          ctx.moveTo(x, r * bh);
          ctx.lineTo(x, (r + 1) * bh);
          ctx.stroke();
        }
      }
    },
    { repeat: true, anisotropy: aniso },
  );

  // Faced roof insulation that pillows between the purlins.
  const insulationNormal = normalMapFromHeight(
    128,
    128,
    (u, v) => {
      const a = Math.sin(Math.PI * (((u % 1) + 1) % 1));
      const b = Math.sin(Math.PI * (((v % 1) + 1) % 1));
      return Math.pow(Math.max(0, a), 0.45) * Math.pow(Math.max(0, b), 0.45);
    },
    9,
  );

  const pegboard = canvasTexture(
    256,
    256,
    (ctx, w, h) => {
      ctx.fillStyle = '#d9d2c2';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#4b4336';
      const n = 8;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          ctx.beginPath();
          ctx.arc((x + 0.5) * (w / n), (y + 0.5) * (h / n), 3.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    },
    { repeat: true, anisotropy: aniso },
  );

  const wood = canvasTexture(
    512,
    512,
    (ctx, w, h) => {
      const rand = seededRandom(3);
      const planks = 8;
      for (let i = 0; i < planks; i++) {
        const l = 34 + rand() * 9;
        ctx.fillStyle = `hsl(${28 + rand() * 6}, ${38 + rand() * 10}%, ${l}%)`;
        ctx.fillRect(0, (i * h) / planks, w, h / planks + 1);
        ctx.strokeStyle = 'rgba(40,24,10,0.28)';
        for (let g = 0; g < 9; g++) {
          const y = (i + rand()) * (h / planks);
          ctx.lineWidth = 0.6 + rand();
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.bezierCurveTo(w * 0.3, y + rand() * 6 - 3, w * 0.7, y + rand() * 6 - 3, w, y);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(25,14,6,0.5)';
        ctx.fillRect(0, (i * h) / planks, w, 2);
      }
    },
    { repeat: true, anisotropy: aniso },
  );

  const hazard = canvasTexture(
    128,
    128,
    (ctx, w, h) => {
      ctx.fillStyle = '#f2c214';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#17181a';
      for (let i = -2; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(i * 64, 0);
        ctx.lineTo(i * 64 + 32, 0);
        ctx.lineTo(i * 64 + 32 + h, h);
        ctx.lineTo(i * 64 + h, h);
        ctx.closePath();
        ctx.fill();
      }
    },
    { repeat: true, anisotropy: aniso },
  );

  const grate = canvasTexture(
    64,
    64,
    (ctx, w, h) => {
      ctx.fillStyle = '#2b2e31';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#07080a';
      for (let i = 0; i < 4; i++) ctx.fillRect(6, 4 + i * 16, w - 12, 8);
      ctx.fillStyle = '#4a4e52';
      ctx.fillRect(0, 0, 3, h);
      ctx.fillRect(w - 3, 0, 3, h);
    },
    { repeat: true, anisotropy: aniso },
  );

  // Diamond tread plate for the lift arm pads and turntable rim.
  const tread = canvasTexture(
    128,
    128,
    (ctx, w, h) => {
      ctx.fillStyle = '#6f757a';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#a9b0b6';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          const cx = x * 32 + 16;
          const cy = y * 32 + 16;
          const flip = (x + y) % 2 === 0 ? 1 : -1;
          ctx.beginPath();
          ctx.moveTo(cx - 8, cy - 8 * flip);
          ctx.lineTo(cx + 8, cy + 8 * flip);
          ctx.stroke();
        }
      }
    },
    { repeat: true, anisotropy: aniso },
  );

  // Soft contact shadow, used under props and under the car.
  const blob = canvasTexture(128, 128, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.92)');
    g.addColorStop(0.55, 'rgba(0,0,0,0.5)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });

  // Daylight falling through the open door onto the floor.
  const sunPatch = canvasTexture(256, 256, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, h, 0, 0);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const side = ctx.createLinearGradient(0, 0, w, 0);
    side.addColorStop(0, 'rgba(0,0,0,1)');
    side.addColorStop(0.16, 'rgba(0,0,0,0)');
    side.addColorStop(0.84, 'rgba(0,0,0,0)');
    side.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = side;
    ctx.fillRect(0, 0, w, h);
  });

  const glow = canvasTexture(128, 128, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, 'rgba(255,255,255,0.75)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.18)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });

  // Fading gradient along a light cone (bright at the lamp, gone at the far end).
  const beam = canvasTexture(8, 128, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.22)');
    g.addColorStop(1, 'rgba(255,255,255,0.9)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });

  const headerSign = signTexture(2048, 256, aniso, (ctx, w, h) => {
    ctx.fillStyle = '#14233d';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#f2c214';
    ctx.fillRect(0, h - 26, w, 10);
    ctx.fillRect(0, 16, w, 10);
    ctx.fillStyle = '#f4f2ea';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 150px ${SIGN_FONT}`;
    ctx.save();
    ctx.translate(w / 2, h / 2 + 6);
    ctx.scale(1.28, 1);
    ctx.fillText('BLEND GARAGE', 0, 0);
    ctx.restore();
  });

  const bayNumbers = [1, 2, 3].map((n) =>
    signTexture(256, 256, aniso, (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = '#f2c214';
      ctx.lineWidth = 14;
      ctx.strokeRect(14, 14, w - 28, h - 28);
      ctx.fillStyle = '#f2c214';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `900 170px ${SIGN_FONT}`;
      ctx.fillText(String(n), w / 2, h / 2 + 10);
      // Scuff the paint so it reads as a worn floor marking.
      ctx.globalCompositeOperation = 'destination-out';
      const rand = seededRandom(90 + n);
      for (let i = 0; i < 260; i++) {
        ctx.globalAlpha = 0.5 * rand();
        ctx.fillRect(rand() * w, rand() * h, 2 + rand() * 9, 1 + rand() * 3);
      }
    }),
  );

  const liftLabel = signTexture(256, 512, aniso, (ctx, w, h) => {
    ctx.fillStyle = '#f2c214';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#17181a';
    ctx.fillRect(0, 0, w, 78);
    ctx.fillStyle = '#f2c214';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 40px ${SIGN_FONT}`;
    ctx.fillText('CAUTION', w / 2, 42);
    ctx.fillStyle = '#17181a';
    ctx.font = `700 30px ${SIGN_FONT}`;
    ctx.fillText('LIFT CAPACITY', w / 2, 140);
    ctx.font = `900 76px ${SIGN_FONT}`;
    ctx.fillText('4500', w / 2, 226);
    ctx.font = `700 34px ${SIGN_FONT}`;
    ctx.fillText('KG', w / 2, 290);
    ctx.font = `600 24px ${SIGN_FONT}`;
    ctx.fillText('Set arm locks', w / 2, 380);
    ctx.fillText('before raising', w / 2, 414);
  });

  const safetySign = signTexture(512, 256, aniso, (ctx, w, h) => {
    ctx.fillStyle = '#f4f2ea';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#1c4fa3';
    ctx.fillRect(0, 0, w, 84);
    ctx.fillStyle = '#f4f2ea';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 48px ${SIGN_FONT}`;
    ctx.fillText('NOTICE', w / 2, 46);
    ctx.fillStyle = '#17181a';
    ctx.font = `700 40px ${SIGN_FONT}`;
    ctx.fillText('Eye protection', w / 2, 140);
    ctx.fillText('in the bays', w / 2, 192);
  });

  const clock = signTexture(256, 256, aniso, (ctx, w, h) => {
    ctx.fillStyle = '#f4f2ea';
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 122, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#17181a';
    ctx.lineCap = 'round';
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ctx.lineWidth = i % 3 === 0 ? 8 : 4;
      ctx.beginPath();
      ctx.moveTo(w / 2 + Math.sin(a) * 96, h / 2 - Math.cos(a) * 96);
      ctx.lineTo(w / 2 + Math.sin(a) * 110, h / 2 - Math.cos(a) * 110);
      ctx.stroke();
    }
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(w / 2, h / 2);
    ctx.lineTo(w / 2 + 44, h / 2 - 38);
    ctx.stroke();
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(w / 2, h / 2);
    ctx.lineTo(w / 2 - 22, h / 2 - 84);
    ctx.stroke();
  });

  // One strip of generic product labels, wrapped around every bottle and can on the shelves.
  const bottleLabels = canvasTexture(
    256,
    64,
    (ctx, w, h) => {
      ctx.fillStyle = '#f4f2ea';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#17181a';
      ctx.fillRect(0, 0, w, 12);
      ctx.fillRect(0, h - 8, w, 8);
      ctx.font = `800 22px ${SIGN_FONT}`;
      ctx.textBaseline = 'middle';
      ctx.fillText('5W-30', 12, 34);
      ctx.fillText('ATF', 150, 34);
    },
    { repeat: true, anisotropy: aniso },
  );

  const turntable = canvasTexture(
    1024,
    1024,
    (ctx, w, h) => {
      const c = w / 2;
      ctx.fillStyle = '#4a4f54';
      ctx.fillRect(0, 0, w, h);
      // Brushed plates laid in a ring, with seams the eye can follow as the table turns.
      const g = ctx.createRadialGradient(c, c, 60, c, c, c);
      g.addColorStop(0, '#70767b');
      g.addColorStop(0.78, '#62686d');
      g.addColorStop(0.8, '#3d4246');
      g.addColorStop(0.83, '#5a6065');
      g.addColorStop(0.97, '#50565b');
      g.addColorStop(1, '#383c40');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c, c, c, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(30,33,36,0.6)';
      ctx.lineWidth = 3;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * 70, c + Math.sin(a) * 70);
        ctx.lineTo(c + Math.cos(a) * c * 0.79, c + Math.sin(a) * c * 0.79);
        ctx.stroke();
      }
      ctx.fillStyle = '#f2c214';
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        ctx.save();
        ctx.translate(c + Math.cos(a) * c * 0.9, c + Math.sin(a) * c * 0.9);
        ctx.rotate(a);
        ctx.fillRect(-16, -3, i % 4 === 0 ? 38 : 20, 6);
        ctx.restore();
      }
    },
    { anisotropy: aniso },
  );

  const textures: ShopTextures = {
    floorColor,
    floorRough,
    apronColor,
    corrugatedNormal,
    blockColor,
    insulationNormal,
    pegboard,
    wood,
    hazard,
    grate,
    tread,
    blob,
    sunPatch,
    glow,
    beam,
    headerSign,
    bayNumbers,
    liftLabel,
    safetySign,
    clock,
    bottleLabels,
    turntable,
    all: [],
  };
  textures.all = [
    floorColor,
    floorRough,
    apronColor,
    corrugatedNormal,
    blockColor,
    insulationNormal,
    pegboard,
    wood,
    hazard,
    grate,
    tread,
    blob,
    sunPatch,
    glow,
    beam,
    headerSign,
    ...bayNumbers,
    liftLabel,
    safetySign,
    clock,
    bottleLabels,
    turntable,
  ];
  return textures;
}
