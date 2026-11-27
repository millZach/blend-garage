import * as THREE from 'three';
import { lerp } from '../math';
import { SUN_DIRECTION } from './environment';

/** Ocean water surface elevation in meters (coastal beach & inlet dip smoothly below this). */
export const OCEAN_LEVEL = -4.0;

/**
 * Analytic western California coastline X coordinate at any Z.
 * West of this X is Pacific Ocean (including a dramatic coastal inlet bay around Z = 0
 * spanned by the Steel-Arch Pacific Coast Bridge at X = -720).
 */
export function shorelineXAtZ(z: number): number {
  // Organic sweeping coastline around X ≈ -795 with headlands & coves.
  const baseCoast = -792 + Math.sin(z * 0.0042) * 34 + Math.cos(z * 0.0095 + 0.8) * 18;
  // Dramatic coastal bay/inlet carving eastward to X ≈ -595 under the coastal bridge at Z ∈ [-125, +125].
  const bayNorm = z / 138;
  const bayCarve = Math.exp(-bayNorm * bayNorm * 2.2) * 195;
  return baseCoast + bayCarve;
}

/** Tiny 128x128 tileable wave height/normal LUT for fast hardware-filtered animated water ripples. */
function createWaterNoiseTexture(): THREE.DataTexture {
  const size = 128;
  const data = new Uint8Array(size * size * 4);

  const hash = (ix: number, iy: number, period: number, seed: number): number => {
    const px = ((ix % period) + period) % period;
    const py = ((iy % period) + period) % period;
    let n = Math.imul(px, 374761393) + Math.imul(py, 668265263) + Math.imul(seed, 1442695041);
    n = (n ^ (n >>> 13)) >>> 0;
    n = Math.imul(n, 1274126177) >>> 0;
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };

  const sample = (u: number, v: number, period: number, seed: number): number => {
    const x = u * period;
    const y = v * period;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy, period, seed);
    const b = hash(ix + 1, iy, period, seed);
    const c = hash(ix, iy + 1, period, seed);
    const d = hash(ix + 1, iy + 1, period, seed);
    return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
  };

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const idx = (y * size + x) * 4;
      data[idx] = Math.round(sample(u, v, 8, 17) * 255);
      data[idx + 1] = Math.round(sample(u, v, 16, 53) * 255);
      data[idx + 2] = Math.round(sample(u, v, 32, 97) * 255);
      data[idx + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

const WATER_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldPos;
  varying float vFogDepth;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vec4 mvPos = viewMatrix * worldPos;
    vFogDepth = -mvPos.z;
    gl_Position = projectionMatrix * mvPos;
  }
`;

const WATER_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform sampler2D uNoiseTex;

  varying vec3 vWorldPos;
  varying float vFogDepth;

  float shorelineX(float z) {
    float baseCoast = -792.0 + sin(z * 0.0042) * 34.0 + cos(z * 0.0095 + 0.8) * 18.0;
    float bayNorm = z / 138.0;
    float bayCarve = exp(-bayNorm * bayNorm * 2.2) * 195.0;
    return baseCoast + bayCarve;
  }

  void main() {
    vec2 p = vWorldPos.xz;

    // Dual-layer scrolling wave ripples from tiny noise LUT (zero expensive ALU noise).
    vec2 uv1 = p * 0.011 + vec2(uTime * 0.018, uTime * 0.011);
    vec2 uv2 = p * 0.029 + vec2(-uTime * 0.024, uTime * 0.019);
    vec3 n1 = texture2D(uNoiseTex, uv1).rgb;
    vec3 n2 = texture2D(uNoiseTex, uv2).rgb;

    float hL = n1.r * 0.6 + n2.g * 0.4;
    float hR = texture2D(uNoiseTex, uv1 + vec2(0.015, 0.0)).r * 0.6 + texture2D(uNoiseTex, uv2 + vec2(0.022, 0.0)).g * 0.4;
    float hD = texture2D(uNoiseTex, uv1 + vec2(0.0, 0.015)).r * 0.6 + texture2D(uNoiseTex, uv2 + vec2(0.0, 0.022)).g * 0.4;

    vec3 normal = normalize(vec3((hL - hR) * 2.4, 1.0, (hL - hD) * 2.4));
    vec3 viewDir = normalize(cameraPosition - vWorldPos);

    // Distance from western California shoreline (positive = out at sea).
    float distSea = shorelineX(p.y) - p.x;
    float shallow = 1.0 - smoothstep(0.0, 95.0, distSea);

    // Rich Pacific Ocean depth palette: turquoise coastal shallows -> deep cobalt open ocean.
    vec3 deepOcean = vec3(0.045, 0.145, 0.255);
    vec3 shallowTurquoise = vec3(0.095, 0.325, 0.365);
    vec3 waterBase = mix(deepOcean, shallowTurquoise, shallow * 0.85);

    // Schlick Fresnel sky reflection tinted to warm California horizon & azure zenith.
    float ndotv = clamp(dot(normal, viewDir), 0.0, 1.0);
    float fresnel = 0.04 + 0.96 * pow(1.0 - ndotv, 4.2);
    vec3 skyRefl = mix(vec3(0.28, 0.49, 0.76), vec3(0.92, 0.82, 0.70), pow(1.0 - ndotv, 2.2));
    vec3 col = mix(waterBase, skyRefl, clamp(fresnel * 0.82, 0.08, 0.88));

    // Late-afternoon golden solar specular path shimmering across wavelets.
    vec3 halfVec = normalize(uSunDir + viewDir);
    float specBroad = pow(max(dot(normal, halfVec), 0.0), 48.0) * 0.55;
    float specGlint = pow(max(dot(normal, halfVec), 0.0), 420.0) * 3.8;
    col += vec3(1.0, 0.88, 0.68) * (specBroad + specGlint);

    // Animated Pacific surf shoreline foam waves lapping onto the golden beach.
    float surfWave = sin(distSea * 0.28 - uTime * 2.1 + n1.b * 4.5) * 0.5 + 0.5;
    float foamBand = (1.0 - smoothstep(0.0, 26.0, distSea)) * smoothstep(0.32, 0.82, surfWave + (1.0 - smoothstep(0.0, 10.0, distSea)) * 0.55);
    float whitecap = smoothstep(0.76, 0.92, n2.b * 0.65 + n1.r * 0.35) * (0.18 + shallow * 0.22);
    vec3 foamColor = vec3(0.95, 0.94, 0.90);
    col = mix(col, foamColor, clamp(foamBand * 0.82 + whitecap, 0.0, 0.92));

    // Match scene FogExp2 aerial perspective seamlessly into the western ocean horizon.
    float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
    col = mix(col, uFogColor, clamp(fogFactor, 0.0, 1.0));

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export interface OceanWater {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  material: THREE.ShaderMaterial;
  noiseTex: THREE.DataTexture;
  update(dt: number): void;
  dispose(): void;
}

/**
 * Creates the single-draw-call animated Pacific Ocean plane along the western coastline.
 */
export function buildPacificOcean(fogColorHex = 0xe8d8c4, fogDensity = 0.00062): OceanWater {
  // Extends from inland bay margin (X = -565) far out to the western horizon (X = -2650).
  const widthX = 2085;
  const depthZ = 4200;
  const centerX = -565 - widthX * 0.5;

  const geometry = new THREE.PlaneGeometry(widthX, depthZ, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(centerX, OCEAN_LEVEL, 0);

  const noiseTex = createWaterNoiseTexture();
  const material = new THREE.ShaderMaterial({
    name: 'pacific-ocean-water',
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: SUN_DIRECTION.clone() },
      uFogColor: { value: new THREE.Color(fogColorHex) },
      uFogDensity: { value: fogDensity },
      uNoiseTex: { value: noiseTex },
    },
    vertexShader: WATER_VERTEX_SHADER,
    fragmentShader: WATER_FRAGMENT_SHADER,
    depthWrite: true,
    fog: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'pacific-ocean';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;

  let elapsed = 0;
  return {
    mesh,
    geometry,
    material,
    noiseTex,
    update(dt: number) {
      elapsed += Math.min(Math.max(dt, 0), 0.1);
      material.uniforms.uTime.value = elapsed;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      noiseTex.dispose();
      mesh.removeFromParent();
    },
  };
}
