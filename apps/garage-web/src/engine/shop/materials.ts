import * as THREE from 'three';
import type { MeshBatcher } from '../MeshBatcher';
import type { ShopTextures } from './textures';

/** An unlit light-emitting surface whose brightness the lighting moods drive. */
export class Glow {
  readonly material: THREE.MeshBasicMaterial;

  constructor(name: string, options: { side?: THREE.Side; map?: THREE.Texture } = {}) {
    this.material = new THREE.MeshBasicMaterial({ color: 0xffffff, side: options.side ?? THREE.FrontSide, map: options.map ?? null });
    this.material.name = name;
  }

  /** `intensity` above 1 is HDR: it stays white on screen but shows up brighter in reflections. */
  set(color: THREE.Color, intensity: number): void {
    this.material.color.copy(color).multiplyScalar(intensity);
  }
}

function std(name: string, color: number, roughness: number, metalness = 0, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
  m.name = name;
  return m;
}

function enamel(name: string, color: number, roughness = 0.34): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({ color, roughness, metalness: 0.2, clearcoat: 0.7, clearcoatRoughness: 0.18 });
  m.name = name;
  return m;
}

const DECAL = { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 } as const;

function litDecal(name: string, params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ ...params, ...DECAL });
  m.name = name;
  return m;
}

function unlitDecal(name: string, params: THREE.MeshBasicMaterialParameters): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ ...params, ...DECAL });
  m.name = name;
  return m;
}

export interface ShopMaterials {
  floor: THREE.MeshStandardMaterial;
  boothFloor: THREE.MeshStandardMaterial;
  boothWall: THREE.MeshStandardMaterial;
  apron: THREE.MeshStandardMaterial;
  wallMetal: THREE.MeshStandardMaterial;
  wallBlock: THREE.MeshStandardMaterial;
  facade: THREE.MeshStandardMaterial;
  ceiling: THREE.MeshStandardMaterial;
  steel: THREE.MeshStandardMaterial;
  galvanized: THREE.MeshStandardMaterial;
  doorPanel: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  chrome: THREE.MeshStandardMaterial;
  alloy: THREE.MeshStandardMaterial;
  castIron: THREE.MeshStandardMaterial;
  red: THREE.MeshPhysicalMaterial;
  blue: THREE.MeshPhysicalMaterial;
  yellow: THREE.MeshPhysicalMaterial;
  black: THREE.MeshPhysicalMaterial;
  grey: THREE.MeshPhysicalMaterial;
  white: THREE.MeshPhysicalMaterial;
  green: THREE.MeshPhysicalMaterial;
  orange: THREE.MeshPhysicalMaterial;
  wood: THREE.MeshStandardMaterial;
  pegboard: THREE.MeshStandardMaterial;
  cardboard: THREE.MeshStandardMaterial;
  linePaint: THREE.MeshStandardMaterial;
  whitePaint: THREE.MeshStandardMaterial;
  hazard: THREE.MeshStandardMaterial;
  grate: THREE.MeshStandardMaterial;
  seam: THREE.MeshStandardMaterial;
  tread: THREE.MeshStandardMaterial;
  label: THREE.MeshStandardMaterial;
  turntable: THREE.MeshStandardMaterial;
  hedge: THREE.MeshStandardMaterial;
  headerSign: THREE.MeshStandardMaterial;
  liftLabel: THREE.MeshStandardMaterial;
  safetySign: THREE.MeshStandardMaterial;
  clock: THREE.MeshStandardMaterial;
  bayNumbers: THREE.Material[];
  blob: THREE.MeshBasicMaterial;
  sunPatch: THREE.MeshBasicMaterial;
  /** Light-emitting surfaces, driven by the lighting moods. */
  glow: {
    ledBay: Glow;
    hexGrid: Glow;
    skylight: Glow;
    clerestory: Glow;
    doorGlass: Glow;
    softbox: Glow;
    worklamp: Glow;
    liftLed: Glow;
    streetLamp: Glow;
  };
  sky: THREE.MeshBasicMaterial;
  all: THREE.Material[];
}

export function createShopMaterials(tex: ShopTextures, batcher: MeshBatcher): ShopMaterials {
  const floor = std('epoxy floor', 0xffffff, 0.6, 0, { map: tex.floorColor, roughnessMap: tex.floorRough, envMapIntensity: 0.9 });
  const boothFloor = std('photo bay floor', 0x3b4045, 0.3, 0, { envMapIntensity: 0.8 });
  const boothWall = std('photo bay cyclorama', 0x33373c, 0.94, 0, { side: THREE.DoubleSide, envMapIntensity: 0.3 });
  const apron = std('apron asphalt', 0xffffff, 0.95, 0, { map: tex.apronColor, envMapIntensity: 0.3 });
  const wallMetal = std('wall cladding', 0xc3c9cd, 0.5, 0.35, { normalMap: tex.corrugatedNormal, envMapIntensity: 0.6 });
  const wallBlock = std('painted block', 0xffffff, 0.86, 0, { map: tex.blockColor, envMapIntensity: 0.4 });
  const facade = std('shop front', 0x2c3540, 0.6, 0.3, { normalMap: tex.corrugatedNormal });
  const ceiling = std('roof insulation', 0xdcdedc, 0.92, 0, { normalMap: tex.insulationNormal, envMapIntensity: 0.3 });
  const steel = std('structural steel', 0x30363c, 0.58, 0.55);
  const galvanized = std('galvanized', 0xa9b0b5, 0.36, 0.85);
  const doorPanel = std('roll-up door', 0xd2d5d6, 0.55, 0.25);
  const rubber = std('rubber', 0x17181a, 0.9);
  const chrome = std('chrome', 0xe9ebed, 0.14, 1);
  const alloy = std('alloy', 0xb7bdc3, 0.3, 0.9);
  const castIron = std('cast iron', 0x3d4145, 0.62, 0.7);
  const red = enamel('tool chest red', 0xb5201a);
  const blue = enamel('lift blue', 0x1c4fa3);
  const yellow = enamel('safety yellow', 0xefb50c);
  const black = enamel('black enamel', 0x1c1e20, 0.4);
  const grey = enamel('cabinet grey', 0x5b636a, 0.42);
  const white = enamel('white enamel', 0xe6e8e6, 0.4);
  const green = enamel('green enamel', 0x1f6b47, 0.4);
  const orange = enamel('orange', 0xe5601a, 0.5);
  const wood = std('butcher block', 0xffffff, 0.62, 0, { map: tex.wood });
  const pegboard = std('pegboard', 0xffffff, 0.82, 0, { map: tex.pegboard });
  const cardboard = std('cardboard', 0xa98356, 0.9);
  const linePaint = std('floor line paint', 0xe1ae0c, 0.62, 0, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const whitePaint = std('white line paint', 0xdfe1df, 0.7, 0, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const hazard = std('hazard stripe', 0xffffff, 0.55, 0.1, { map: tex.hazard });
  const grate = std('drain grate', 0xffffff, 0.5, 0.7, { map: tex.grate, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const tread = std('tread plate', 0xffffff, 0.42, 0.8, { map: tex.tread });
  const label = std('product label', 0xffffff, 0.6, 0, { map: tex.bottleLabels });
  const turntable = std('turntable', 0xffffff, 0.42, 0.55, { map: tex.turntable, envMapIntensity: 0.7 });
  const hedge = std('hedge', 0x27412c, 1);
  const headerSign = std('header sign', 0xffffff, 0.35, 0.1, { map: tex.headerSign });
  const liftLabel = std('lift label', 0xffffff, 0.5, 0, { map: tex.liftLabel });
  const safetySign = std('safety sign', 0xffffff, 0.5, 0, { map: tex.safetySign });
  const clock = std('wall clock', 0xffffff, 0.4, 0, { map: tex.clock, transparent: true });
  const bayNumbers = tex.bayNumbers.map((map, i) => litDecal(`bay number ${i + 1}`, { map, roughness: 0.65 }));
  const blob = unlitDecal('contact shadow', { map: tex.blob, color: 0x000000, opacity: 0.6 });
  const sunPatch = unlitDecal('sun patch', { map: tex.sunPatch, color: 0xffffff, opacity: 0.35, blending: THREE.AdditiveBlending });
  const seam = std('floor seam', 0x34383b, 0.9, 0, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });

  const glow = {
    ledBay: new Glow('LED bay light'),
    hexGrid: new Glow('hex grid light'),
    skylight: new Glow('skylight', { side: THREE.DoubleSide }),
    clerestory: new Glow('clerestory glazing'),
    doorGlass: new Glow('door glazing', { side: THREE.DoubleSide }),
    softbox: new Glow('photo bay softbox'),
    worklamp: new Glow('worklamp'),
    liftLed: new Glow('lift LED'),
    streetLamp: new Glow('street lamp'),
  };
  const sky = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false });
  sky.name = 'sky';

  // Tiling textures are laid out in world units so they keep the same scale on every surface.
  batcher
    .useWorldUv(floor, 3)
    .useWorldUv(apron, 2.5)
    .useWorldUv(wallMetal, 0.24)
    .useWorldUv(facade, 0.3)
    .useWorldUv(wallBlock, 1.6)
    .useWorldUv(ceiling, 1.5)
    .useWorldUv(pegboard, 0.2)
    .useWorldUv(wood, 1.1)
    .useWorldUv(hazard, 0.5)
    .useWorldUv(grate, 0.25)
    .useWorldUv(tread, 0.3)
    .useWorldUv(label, 0.26);

  const materials: ShopMaterials = {
    floor,
    boothFloor,
    boothWall,
    apron,
    wallMetal,
    wallBlock,
    facade,
    ceiling,
    steel,
    galvanized,
    doorPanel,
    rubber,
    chrome,
    alloy,
    castIron,
    red,
    blue,
    yellow,
    black,
    grey,
    white,
    green,
    orange,
    wood,
    pegboard,
    cardboard,
    linePaint,
    whitePaint,
    hazard,
    grate,
    seam,
    tread,
    label,
    turntable,
    hedge,
    headerSign,
    liftLabel,
    safetySign,
    clock,
    bayNumbers,
    blob,
    sunPatch,
    glow,
    sky,
    all: [],
  };
  materials.all = [
    floor,
    boothFloor,
    boothWall,
    apron,
    wallMetal,
    wallBlock,
    facade,
    ceiling,
    steel,
    galvanized,
    doorPanel,
    rubber,
    chrome,
    alloy,
    castIron,
    red,
    blue,
    yellow,
    black,
    grey,
    white,
    green,
    orange,
    wood,
    pegboard,
    cardboard,
    linePaint,
    whitePaint,
    hazard,
    grate,
    seam,
    tread,
    label,
    turntable,
    hedge,
    headerSign,
    liftLabel,
    safetySign,
    clock,
    ...bayNumbers,
    blob,
    sunPatch,
    ...Object.values(glow).map((g) => g.material),
    sky,
  ];
  return materials;
}
