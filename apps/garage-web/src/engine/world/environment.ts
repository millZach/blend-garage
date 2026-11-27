import * as THREE from 'three';
import { clamp, lerp } from '../math';

/** Late-afternoon California sun: 25° elevation, 36° right of +Z for dramatic golden 3/4 light. */
const SUN_ELEVATION_RAD = 25 * (Math.PI / 180);
const SUN_AZIMUTH_RAD = -36 * (Math.PI / 180);

export const SUN_DIRECTION = new THREE.Vector3(
  Math.sin(SUN_AZIMUTH_RAD) * Math.cos(SUN_ELEVATION_RAD),
  Math.sin(SUN_ELEVATION_RAD),
  Math.cos(SUN_AZIMUTH_RAD) * Math.cos(SUN_ELEVATION_RAD),
).normalize();

const SKY_ZENITH = new THREE.Color(0x2b66b8);
const SKY_MID = new THREE.Color(0x5b96d8);
const SKY_HORIZON = new THREE.Color(0xe8d8c4);
const SKY_GROUND_WARM = new THREE.Color(0x6b5d4a);
const SKY_GROUND_ROAD = new THREE.Color(0x222428);
const SUN_KEY_COLOR = new THREE.Color(0xffe6c2);

const SKY_DOME_RADIUS = 2250;
/**
 * 1024x1024 shadow map over a tight 64m car-following frustum (~6.25cm/texel):
 * 4x fewer shadow fragments than 2048x2048 while keeping crisp contact shadows on tires,
 * guardrails, and nearby trees across the 2400m open world.
 */
const SHADOW_MAP_SIZE = 1024;
const SHADOW_EXTENT = 32;
const SHADOW_TEXEL_WORLD = (SHADOW_EXTENT * 2) / SHADOW_MAP_SIZE;
const SUN_LIGHT_DISTANCE = 76;
/** Gentle warm California aerial-perspective haze tuned for the 2400m ocean-to-mountain vista. */
const FOG_DENSITY = 0.00062;

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const SUN_RIGHT = new THREE.Vector3().crossVectors(WORLD_UP, SUN_DIRECTION).normalize();
const SUN_UP = new THREE.Vector3().crossVectors(SUN_DIRECTION, SUN_RIGHT).normalize();

const _focusVec = new THREE.Vector3();
const _snappedTarget = new THREE.Vector3();

interface SavedSceneState {
  background: THREE.Color | THREE.Texture | THREE.CubeTexture | null;
  fog: THREE.Fog | THREE.FogExp2 | null;
  environment: THREE.Texture | null;
  environmentIntensity: number;
  exposure: number;
}

/**
 * Generates a tileable 256x256 RGBA value-noise texture so the sky cloud shader uses fast
 * hardware-bilinear texture fetches instead of 30+ ALU hash/quintic evaluations per pixel.
 *  - R: smooth tileable value noise (period 16)
 *  - G: independent offset tileable noise (period 16, lets vec2 warp sample in 1 fetch)
 *  - B: 2x higher-frequency tileable noise (period 32)
 *  - A: 4x fine wispy tileable noise (period 64)
 */
function createSkyNoiseTexture(): THREE.DataTexture {
  const size = 256;
  const data = new Uint8Array(size * size * 4);

  const periodicHash = (ix: number, iy: number, period: number, seed: number): number => {
    const px = ((ix % period) + period) % period;
    const py = ((iy % period) + period) % period;
    let n = Math.imul(px, 374761393) + Math.imul(py, 668265263) + Math.imul(seed, 1442695041);
    n = (n ^ (n >>> 13)) >>> 0;
    n = Math.imul(n, 1274126177) >>> 0;
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };

  const samplePeriodic = (u: number, v: number, period: number, seed: number): number => {
    const x = u * period;
    const y = v * period;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const a = periodicHash(ix, iy, period, seed);
    const b = periodicHash(ix + 1, iy, period, seed);
    const c = periodicHash(ix, iy + 1, period, seed);
    const d = periodicHash(ix + 1, iy + 1, period, seed);
    return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
  };

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const idx = (y * size + x) * 4;
      data[idx] = Math.round(samplePeriodic(u, v, 16, 11) * 255);
      data[idx + 1] = Math.round(samplePeriodic(u, v, 16, 47) * 255);
      data[idx + 2] = Math.round(samplePeriodic(u, v, 32, 83) * 255);
      data[idx + 3] = Math.round(samplePeriodic(u, v, 64, 131) * 255);
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

const SKY_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldDir;

  void main() {
    vWorldDir = position;
    vec4 clipPos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    // Pin sky dome cleanly to the far plane (ndc.z = 1.0) so hardware Early-Z rejects 100% of
    // screen pixels already covered by terrain, mountains, buildings, trees, and the car!
    gl_Position = clipPos.xyww;
  }
`;

const SKY_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uZenithColor;
  uniform vec3 uMidSkyColor;
  uniform vec3 uHorizonColor;
  uniform vec3 uGroundWarmColor;
  uniform vec3 uGroundRoadColor;
  uniform vec3 uSunColor;
  uniform sampler2D uNoiseTex;
  uniform float uTime;
  uniform float uEnvMode;

  varying vec3 vWorldDir;

  const mat2 FBM_ROT = mat2(0.80, -0.60, 0.60, 0.80);

  // Guarded pow() to guarantee zero NaN pixels on ANGLE/D3D11 drivers when base == 0.
  float safePow(float x, float e) {
    return x > 1e-5 ? pow(x, e) : 0.0;
  }

  float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  // Exact ray distance to an Earth-curved atmospheric shell at altitude h above planet radius R.
  float curvedShellDist(float elev, float planetR, float shellH) {
    float b = planetR * max(elev, 0.0);
    return -b + sqrt(b * b + 2.0 * planetR * shellH + shellH * shellH);
  }

  // Texture-accelerated multi-octave billowing California cumulus cloud density (4 bilinear taps).
  float cumulusDensity(vec2 uv) {
    vec2 warp = texture2D(uNoiseTex, uv * 0.026 + vec2(0.11, 0.57)).rg - 0.5;
    vec2 p = uv + warp * 0.62;

    vec4 sMacro = texture2D(uNoiseTex, p * 0.019 + vec2(0.25, -0.18));
    vec4 sMid = texture2D(uNoiseTex, p * 0.058 + vec2(0.13, 0.37));
    vec4 sFine = texture2D(uNoiseTex, (FBM_ROT * p) * 0.145 + vec2(0.61, 0.29));

    // Combines 5 effective FBM octaves from just 3 multi-channel noise fetches.
    float n = sMid.r * 0.52 + sMid.b * 0.26 + sFine.r * 0.14 + sFine.b * 0.07 + sFine.a * 0.035;
    float shape = n * 0.78 + sMacro.r * 0.34;
    return smoothstep(0.57, 0.85, shape);
  }

  // Texture-accelerated feathery high-altitude cirrus wisps (2 bilinear taps).
  float cirrusDensity(vec2 uv) {
    vec2 p = vec2(uv.x * 0.62 + uv.y * 0.24, uv.y * 2.15 - uv.x * 0.38);
    vec2 w = texture2D(uNoiseTex, p * 0.036 + vec2(0.19, 0.46)).rg - 0.5;
    p += w * 0.92;
    vec4 s = texture2D(uNoiseTex, p * 0.062 + vec2(0.31, 0.17));
    float c = s.r * 0.54 + s.b * 0.27 + s.a * 0.14 + s.g * 0.07;
    return smoothstep(0.62, 0.90, c);
  }

  void main() {
    vec3 dir = normalize(vWorldDir);
    float elev = dir.y;
    float sunDot = dot(dir, uSunDir);
    float sunPos = max(sunDot, 0.0);

    // ------------------------------------------------------------------ 1. Atmospheric Rayleigh + Mie Sky
    float up = clamp(elev, 0.0, 1.0);
    float midBlend = smoothstep(0.0, 0.30, up);
    float zenithBlend = safePow(smoothstep(0.08, 0.92, up), 0.78);
    vec3 skyCol = mix(uMidSkyColor, uZenithColor, zenithBlend);

    // Rayleigh opposition darkening: sky away from sun is slightly deeper, richer cobalt.
    float antiSun = clamp(-sunDot * 0.5 + 0.5, 0.0, 1.0);
    skyCol *= mix(1.06, 0.86, antiSun * smoothstep(0.08, 0.65, up));

    // Optical airmass horizon veil smoothly matching THREE.FogExp2 color right at elev = 0.
    float horizonTight = safePow(1.0 - up, 4.6);
    float horizonBroad = safePow(1.0 - up, 2.05) * 0.34;
    float horizonWeight = clamp(horizonTight + horizonBroad * (1.0 - midBlend * 0.55), 0.0, 1.0);

    // Subtle golden-peach forward-scattered horizon warmth toward sun azimuth.
    vec3 warmHorizon = uHorizonColor * mix(vec3(0.98, 0.99, 1.02), vec3(1.14, 1.04, 0.93), safePow(sunPos, 3.0));
    skyCol = mix(skyCol, warmHorizon, horizonWeight);
    skyCol = mix(skyCol, uHorizonColor, safePow(1.0 - up, 11.0) * 0.82);

    // Soft Mie atmospheric sun aureole + luminous forward-scattering halo.
    float aboveHorizon = smoothstep(-0.025, 0.045, elev);
    float horizonDamp = mix(0.45, 1.0, smoothstep(0.0, 0.14, up));
    float mieBroad = safePow(sunPos, 6.0) * 0.22 * horizonDamp;
    float mieMid = safePow(sunPos, 38.0) * 0.58 * horizonDamp;
    float mieTight = safePow(sunPos, 320.0) * 1.95;

    vec3 mieTint = mix(vec3(1.0, 0.86, 0.68), uSunColor, 0.55);
    skyCol += mieTint * (mieBroad + mieMid + mieTight) * aboveHorizon;

    // Crisp incandescent solar disc (slightly wider & higher HDR radiance when baking PMREM).
    float discInner = mix(0.99982, 0.9990, uEnvMode);
    float discOuter = mix(0.99935, 0.9950, uEnvMode);
    float sunDisc = smoothstep(discOuter, discInner, sunDot) * aboveHorizon;
    float discRadiance = mix(10.5, 24.0, uEnvMode);
    skyCol += uSunColor * vec3(1.12, 1.04, 0.92) * sunDisc * discRadiance;

    // ------------------------------------------------------------------ 2. Layered Procedural Clouds
    if (elev > 0.008) {
      // High-altitude cirrus wisps on upper curved atmospheric shell.
      float tCirrus = curvedShellDist(elev, 26.0, 2.7);
      vec2 cirrusUV = dir.xz * tCirrus * 0.28 + uTime * vec2(0.0085, 0.0038);
      float cirrus = cirrusDensity(cirrusUV);
      if (cirrus > 0.002) {
        float cirrusFade = smoothstep(0.03, 0.22, elev) * (1.0 - smoothstep(0.75, 1.0, elev) * 0.25);
        vec3 cirrusCol = mix(uHorizonColor * 1.15, uSunColor * 1.32, 0.55 + safePow(sunPos, 4.0) * 0.45);
        skyCol = mix(skyCol, cirrusCol, cirrus * cirrusFade * 0.30);
      }

      // Main volumetric-look California afternoon cumulus deck.
      float tCumulus = curvedShellDist(elev, 26.0, 1.15);
      vec2 cloudUV = dir.xz * tCumulus * 0.56 + uTime * vec2(0.0044, 0.0021);
      float d = cumulusDensity(cloudUV);

      if (d > 0.004) {
        // Single-tap directional self-shadowing toward sun for 3D sunlit tops & cool undersides.
        vec2 sunProj = normalize(uSunDir.xz + vec2(1e-4));
        float dSun = cumulusDensity(cloudUV + sunProj * 0.22);
        float opticalDepth = dSun * 1.35 + d * 0.25;

        float transmittance = exp(-opticalDepth * 2.05);
        float edgeSlope = clamp((d - dSun) * 1.85 + 0.52, 0.0, 1.0);
        float litFactor = clamp(transmittance * 0.76 + edgeSlope * 0.28, 0.0, 1.0);

        float powder = 1.0 - exp(-d * 3.4);
        float silverLining = (safePow(sunPos, 10.0) * 0.65 + safePow(sunPos, 44.0) * 1.15) * (1.0 - d * 0.58);

        vec3 cloudLit = mix(vec3(1.56, 1.46, 1.32), uSunColor * vec3(1.52, 1.48, 1.44), 0.35);
        vec3 cloudShadowCool = mix(
          uZenithColor * 0.58 + vec3(0.24, 0.27, 0.31),
          uGroundWarmColor * 1.15 + vec3(0.14, 0.12, 0.10),
          0.30
        );
        vec3 cloudCol = mix(cloudShadowCool, cloudLit, litFactor);
        cloudCol += mix(vec3(1.0, 0.94, 0.84), uSunColor, 0.5) * silverLining * (0.45 + 0.55 * powder);

        float horizonFade = smoothstep(0.015, 0.16, elev);
        float aerialMix = 1.0 - smoothstep(0.02, 0.24, elev);
        vec3 aerialCloudCol = mix(cloudCol, warmHorizon * 1.02, aerialMix * 0.72);

        float cloudAlpha = clamp(d * 1.12, 0.0, 0.95) * horizonFade;
        cloudAlpha *= 1.0 - sunDisc * mix(0.45, 0.92, uEnvMode);
        skyCol = mix(skyCol, aerialCloudCol, cloudAlpha);
      }
    }

    // ------------------------------------------------------------------ 3. Lower Hemisphere & PMREM Horizon Cues
    if (uEnvMode > 0.5) {
      vec2 horizDir = normalize(dir.xz + vec2(1e-5, 0.0));
      vec4 rn = texture2D(uNoiseTex, horizDir * 0.16 + vec2(0.13, 0.09));
      float ridgeNoise = rn.r * 0.65 + rn.b * 0.35;
      float ridgeTop = 0.012 + ridgeNoise * 0.032;
      float ridgeMask = 1.0 - smoothstep(ridgeTop - 0.008, ridgeTop + 0.010, elev);
      vec3 ridgeCol = mix(vec3(0.20, 0.24, 0.31), vec3(0.46, 0.39, 0.31), sunPos * 0.75 + 0.15);
      ridgeCol = mix(ridgeCol, uHorizonColor * 0.86, 0.45);
      skyCol = mix(skyCol, ridgeCol, ridgeMask * smoothstep(-0.04, 0.005, elev));
    }

    if (elev < 0.0) {
      float down = clamp(-elev, 0.0, 1.0);
      vec3 valleyBounce = uGroundWarmColor * mix(0.72, 1.16, sunPos * 0.65 + 0.2);
      vec3 lowerCol = mix(uHorizonColor * 0.92, valleyBounce, smoothstep(0.0, 0.11, down));
      lowerCol = mix(lowerCol, uGroundRoadColor, smoothstep(0.14, 0.52, down));
      skyCol = lowerCol;
    }

    if (uEnvMode < 0.5) {
      skyCol += (hash21(gl_FragCoord.xy) - 0.5) / 255.0;
    }

    gl_FragColor = vec4(max(skyCol, vec3(0.0)), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function createSkyShaderMaterial(envMode: number, noiseTex: THREE.DataTexture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: SKY_VERTEX_SHADER,
    fragmentShader: SKY_FRAGMENT_SHADER,
    uniforms: {
      uSunDir: { value: SUN_DIRECTION.clone() },
      uZenithColor: { value: SKY_ZENITH.clone() },
      uMidSkyColor: { value: SKY_MID.clone() },
      uHorizonColor: { value: SKY_HORIZON.clone() },
      uGroundWarmColor: { value: SKY_GROUND_WARM.clone() },
      uGroundRoadColor: { value: SKY_GROUND_ROAD.clone() },
      uSunColor: { value: SUN_KEY_COLOR.clone() },
      uNoiseTex: { value: noiseTex },
      uTime: { value: 0 },
      uEnvMode: { value: envMode },
    },
    side: THREE.BackSide,
    depthTest: envMode < 0.5,
    depthWrite: false,
    depthFunc: THREE.LessEqualDepth,
    fog: false,
    toneMapped: true,
  });
}

/**
 * Photorealistic California late-afternoon outdoor environment:
 * - Hardware-Early-Z far-plane Rayleigh/Mie sky dome with texture-accelerated drifting clouds
 * - HDR PMREM reflection environment baked from the sky dome + valley/asphalt lower hemisphere
 * - Warm golden sun with light-space texel-snapped car-following 1024x1024 shadows & idle dirty-tracking
 * - Cool cerulean sky hemisphere + opposite-azimuth shadow-fill bounce light
 * - Warm horizon-matched exponential aerial perspective fog (`FogExp2`)
 */
export class WorldEnvironment {
  readonly group = new THREE.Group();

  private readonly sunLight: THREE.DirectionalLight;
  private readonly fillLight: THREE.DirectionalLight;
  private readonly hemiLight: THREE.HemisphereLight;
  private readonly skyDome: THREE.Mesh;
  private readonly skyGeo: THREE.SphereGeometry;
  private readonly skyMat: THREE.ShaderMaterial;
  private readonly noiseTex: THREE.DataTexture;
  private readonly fog: THREE.FogExp2;
  private readonly envTarget: THREE.WebGLRenderTarget;

  private readonly saved: SavedSceneState;
  private readonly scene: THREE.Scene;
  private readonly renderer: THREE.WebGLRenderer;
  private cloudTime = 0;
  private lastUpdateMs = -1;
  private lastShadowX = Number.NaN;
  private lastShadowY = Number.NaN;
  private lastShadowZ = Number.NaN;
  private lastShadowHeading = Number.NaN;
  private forceShadowFrames = 3;
  private disposed = false;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.group.name = 'world-environment';

    this.saved = {
      background: scene.background,
      fog: scene.fog,
      environment: scene.environment,
      environmentIntensity: scene.environmentIntensity,
      exposure: renderer.toneMappingExposure,
    };

    // 1. Tileable noise LUT + far-plane Early-Z atmospheric sky dome with drifting clouds.
    this.noiseTex = createSkyNoiseTexture();
    this.skyGeo = new THREE.SphereGeometry(SKY_DOME_RADIUS, 32, 20);
    this.skyMat = createSkyShaderMaterial(0.0, this.noiseTex);
    this.skyDome = new THREE.Mesh(this.skyGeo, this.skyMat);
    this.skyDome.name = 'world-sky-dome';
    // Render AFTER all opaque terrain/buildings/trees/car (before transparents) so Early-Z skips occluded sky pixels!
    this.skyDome.renderOrder = 50;
    this.skyDome.frustumCulled = false;
    this.group.add(this.skyDome);

    // 2. Cool California sky / warm sunlit earth bounce hemisphere light.
    this.hemiLight = new THREE.HemisphereLight(0x88b8f0, 0x8a7459, 0.78);
    this.group.add(this.hemiLight);

    // 3. Warm late-afternoon golden sun with crisp texel-snapped car-following shadows.
    this.sunLight = new THREE.DirectionalLight(SUN_KEY_COLOR.getHex(), 3.35);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    const cam = this.sunLight.shadow.camera;
    cam.left = -SHADOW_EXTENT;
    cam.right = SHADOW_EXTENT;
    cam.top = SHADOW_EXTENT;
    cam.bottom = -SHADOW_EXTENT;
    cam.near = 6;
    cam.far = 178;
    cam.updateProjectionMatrix();
    this.sunLight.shadow.bias = -0.00035;
    this.sunLight.shadow.normalBias = 0.032;
    this.sunLight.shadow.radius = 1.8;
    this.sunLight.position.copy(SUN_DIRECTION).multiplyScalar(SUN_LIGHT_DISTANCE);
    this.group.add(this.sunLight, this.sunLight.target);

    // 4. Subtle cool shadowless sky-bounce fill from opposite the sun for rich shadow color separation.
    this.fillLight = new THREE.DirectionalLight(0x9bc2f0, 0.42);
    this.fillLight.castShadow = false;
    this.fillLight.position.set(-SUN_DIRECTION.x * 60, 34, -SUN_DIRECTION.z * 60);
    this.group.add(this.fillLight, this.fillLight.target);

    // 5. Warm horizon-matched exponential aerial perspective fog.
    this.fog = new THREE.FogExp2(SKY_HORIZON.getHex(), FOG_DENSITY);

    // 6. HDR PMREM environment map baked from the upgraded sky + clouds + ground hemisphere.
    this.envTarget = this.bakeOutdoorEnvironment(renderer);

    scene.background = SKY_HORIZON.clone();
    scene.fog = this.fog;
    scene.environment = this.envTarget.texture;
    scene.environmentIntensity = 1.12;
    renderer.toneMappingExposure = 1.05;
    scene.add(this.group);
  }

  /** Requests a shadow map refresh on the next frame (e.g. after car warp/repair). */
  invalidateShadows(): void {
    this.forceShadowFrames = Math.max(this.forceShadowFrames, 2);
  }

  /**
   * Advances drifting sky clouds, centers the sky dome around the focus point, snaps the
   * directional sun shadow frustum in light-space texel increments, and skips redundant
   * shadow map passes while the car is stationary.
   */
  update(focusX: number, focusY: number, focusZ: number, dt?: number, headingRad?: number): void {
    if (this.disposed) return;

    let stepDt = 0;
    if (typeof dt === 'number' && Number.isFinite(dt)) {
      stepDt = clamp(dt, 0, 0.1);
    } else {
      const now = typeof performance !== 'undefined' ? performance.now() : 0;
      if (this.lastUpdateMs >= 0 && now > this.lastUpdateMs) {
        stepDt = clamp((now - this.lastUpdateMs) * 0.001, 0, 0.1);
      }
      this.lastUpdateMs = now;
    }
    this.cloudTime += stepDt;
    this.skyMat.uniforms.uTime.value = this.cloudTime;

    this.skyDome.position.set(focusX, focusY, focusZ);

    const heading = typeof headingRad === 'number' && Number.isFinite(headingRad) ? headingRad : 0;
    const dx = focusX - this.lastShadowX;
    const dy = focusY - this.lastShadowY;
    const dz = focusZ - this.lastShadowZ;
    const moved =
      !Number.isFinite(this.lastShadowX) ||
      dx * dx + dy * dy + dz * dz > 0.000016 ||
      Math.abs(heading - this.lastShadowHeading) > 0.002;

    if (moved || this.forceShadowFrames > 0) {
      if (this.forceShadowFrames > 0) this.forceShadowFrames -= 1;
      this.lastShadowX = focusX;
      this.lastShadowY = focusY;
      this.lastShadowZ = focusZ;
      this.lastShadowHeading = heading;

      // Light-space texel snapping eliminates shadow edge crawling across tires, guardrails, and trees.
      _focusVec.set(focusX, focusY, focusZ);
      const snappedRight = Math.round(_focusVec.dot(SUN_RIGHT) / SHADOW_TEXEL_WORLD) * SHADOW_TEXEL_WORLD;
      const snappedUp = Math.round(_focusVec.dot(SUN_UP) / SHADOW_TEXEL_WORLD) * SHADOW_TEXEL_WORLD;
      const snappedFwd = Math.round(_focusVec.dot(SUN_DIRECTION) / 0.5) * 0.5;

      _snappedTarget
        .copy(SUN_RIGHT)
        .multiplyScalar(snappedRight)
        .addScaledVector(SUN_UP, snappedUp)
        .addScaledVector(SUN_DIRECTION, snappedFwd);

      this.sunLight.target.position.copy(_snappedTarget);
      this.sunLight.position.copy(_snappedTarget).addScaledVector(SUN_DIRECTION, SUN_LIGHT_DISTANCE);
      this.sunLight.target.updateMatrixWorld();
      this.renderer.shadowMap.needsUpdate = true;
    }
  }

  private bakeOutdoorEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();

    const envSkyGeo = new THREE.SphereGeometry(60, 24, 16);
    const envSkyMat = createSkyShaderMaterial(1.0, this.noiseTex);
    envScene.add(new THREE.Mesh(envSkyGeo, envSkyMat));

    const target = pmrem.fromScene(envScene, 0.014, 0.1, 140);

    pmrem.dispose();
    envSkyGeo.dispose();
    envSkyMat.dispose();
    return target;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.scene.background = this.saved.background;
    this.scene.fog = this.saved.fog;
    this.scene.environment = this.saved.environment;
    this.scene.environmentIntensity = this.saved.environmentIntensity;
    this.renderer.toneMappingExposure = this.saved.exposure;
    this.renderer.shadowMap.needsUpdate = true;

    this.sunLight.shadow.map?.dispose();
    this.envTarget.dispose();
    this.skyGeo.dispose();
    this.skyMat.dispose();
    this.noiseTex.dispose();
    this.group.removeFromParent();
  }
}
