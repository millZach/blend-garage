import * as THREE from 'three';
import { clamp } from '../math';

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

const SKY_DOME_RADIUS = 1120;
const SHADOW_MAP_SIZE = 2048;
/** Half-size of the car-following sun shadow frustum (76m total width for crisp contact shadows). */
const SHADOW_EXTENT = 38;
const SHADOW_TEXEL_WORLD = (SHADOW_EXTENT * 2) / SHADOW_MAP_SIZE;
const SUN_LIGHT_DISTANCE = 95;
const FOG_DENSITY = 0.00118;

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

const SKY_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldDir;

  void main() {
    vWorldDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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
  uniform float uTime;
  uniform float uEnvMode;

  varying vec3 vWorldDir;

  const mat2 FBM_ROT = mat2(0.80, -0.60, 0.60, 0.80);

  // Guarded pow() to guarantee zero NaN pixels on ANGLE/D3D11 drivers when base == 0.
  float safePow(float x, float e) {
    return x > 1e-5 ? pow(x, e) : 0.0;
  }

  // Precision-stable hash without trig artifacts across WebGL2/ANGLE drivers.
  float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  // Exact ray distance to an Earth-curved atmospheric shell at altitude h above planet radius R.
  float curvedShellDist(float elev, float planetR, float shellH) {
    float b = planetR * max(elev, 0.0);
    return -b + sqrt(b * b + 2.0 * planetR * shellH + shellH * shellH);
  }

  // Multi-octave billowing fair-weather California cumulus cloud density.
  float cumulusDensity(vec2 uv) {
    vec2 warp = vec2(
      vnoise(uv * 0.42 + vec2(1.7, 9.2)),
      vnoise(uv * 0.42 + vec2(8.3, 2.8))
    ) - 0.5;
    vec2 p = uv + warp * 0.62;

    float macro = vnoise(p * 0.30 + vec2(4.1, -2.9));

    float n = 0.0;
    float amp = 0.52;
    vec2 q = p * 0.92;
    for (int i = 0; i < 5; i++) {
      n += amp * vnoise(q);
      q = FBM_ROT * q * 2.04 + vec2(17.1, 31.7);
      amp *= 0.50;
    }

    float shape = n * 0.78 + macro * 0.34;
    return smoothstep(0.57, 0.85, shape);
  }

  // Feathery high-altitude cirrus wisps stretched along upper-level winds.
  float cirrusDensity(vec2 uv) {
    vec2 p = vec2(uv.x * 0.62 + uv.y * 0.24, uv.y * 2.15 - uv.x * 0.38);
    vec2 w = vec2(
      vnoise(p * 0.58 + vec2(3.1, 7.4)),
      vnoise(p * 0.58 + vec2(9.2, 1.3))
    ) - 0.5;
    p += w * 0.92;

    float c = 0.0;
    float amp = 0.54;
    for (int i = 0; i < 4; i++) {
      c += amp * vnoise(p);
      p = FBM_ROT * p * 2.08 + vec2(11.3, 5.7);
      amp *= 0.48;
    }
    return smoothstep(0.62, 0.90, c);
  }

  void main() {
    vec3 dir = normalize(vWorldDir);
    float elev = dir.y;
    float sunDot = dot(dir, uSunDir);
    float sunPos = max(sunDot, 0.0);

    // ------------------------------------------------------------------ 1. Atmospheric Rayleigh + Mie Sky
    float up = clamp(elev, 0.0, 1.0);
    // Rayleigh vertical gradient: warm luminous horizon -> crisp azure -> deep cerulean zenith.
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
    // Pin exact horizon edge (elev -> 0) closely to uHorizonColor for seamless mountain fog blend.
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
        // 2-tap directional self-shadowing toward the sun for 3D sunlit tops & cool undersides.
        vec2 sunProj = normalize(uSunDir.xz + vec2(1e-4));
        float dSun1 = cumulusDensity(cloudUV + sunProj * 0.14);
        float dSun2 = cumulusDensity(cloudUV + sunProj * 0.36);
        float opticalDepth = dSun1 * 0.65 + dSun2 * 0.95;

        float transmittance = exp(-opticalDepth * 2.15);
        float edgeSlope = clamp((d - dSun1) * 1.85 + 0.52, 0.0, 1.0);
        float litFactor = clamp(transmittance * 0.76 + edgeSlope * 0.28, 0.0, 1.0);

        // Beer-powder / Henyey-Greenstein-inspired silver lining around the sun.
        float powder = 1.0 - exp(-d * 3.4);
        float silverLining = (safePow(sunPos, 10.0) * 0.65 + safePow(sunPos, 44.0) * 1.15) * (1.0 - d * 0.58);

        // Sunlit luminous warm-white tops vs cool sky-tinted slate-blue undersides + warm earth bounce.
        vec3 cloudLit = mix(vec3(1.56, 1.46, 1.32), uSunColor * vec3(1.52, 1.48, 1.44), 0.35);
        vec3 cloudShadowCool = mix(
          uZenithColor * 0.58 + vec3(0.24, 0.27, 0.31),
          uGroundWarmColor * 1.15 + vec3(0.14, 0.12, 0.10),
          0.30
        );
        vec3 cloudCol = mix(cloudShadowCool, cloudLit, litFactor);
        cloudCol += mix(vec3(1.0, 0.94, 0.84), uSunColor, 0.5) * silverLining * (0.45 + 0.55 * powder);

        // Natural aerial perspective: distant low clouds fade softly into warm horizon haze.
        float horizonFade = smoothstep(0.015, 0.16, elev);
        float aerialMix = 1.0 - smoothstep(0.02, 0.24, elev);
        vec3 aerialCloudCol = mix(cloudCol, warmHorizon * 1.02, aerialMix * 0.72);

        // Keep HDR solar specular core bright for PMREM baking and crisp sunlit punch on screen.
        float cloudAlpha = clamp(d * 1.12, 0.0, 0.95) * horizonFade;
        cloudAlpha *= 1.0 - sunDisc * mix(0.45, 0.92, uEnvMode);
        skyCol = mix(skyCol, aerialCloudCol, cloudAlpha);
      }
    }

    // ------------------------------------------------------------------ 3. Lower Hemisphere & PMREM Horizon Cues
    if (uEnvMode > 0.5) {
      // Seamless 360-degree distant mountain ridge silhouette for organic car-side reflection lines.
      vec2 horizDir = normalize(dir.xz + vec2(1e-5, 0.0));
      float ridgeNoise = vnoise(horizDir * 2.4 + vec2(2.1, 1.4)) * 0.65
                       + vnoise(horizDir * 6.2 + vec2(-4.3, 3.7)) * 0.35;
      float ridgeTop = 0.012 + ridgeNoise * 0.032;
      float ridgeMask = 1.0 - smoothstep(ridgeTop - 0.008, ridgeTop + 0.010, elev);
      vec3 ridgeCol = mix(vec3(0.20, 0.24, 0.31), vec3(0.46, 0.39, 0.31), sunPos * 0.75 + 0.15);
      ridgeCol = mix(ridgeCol, uHorizonColor * 0.86, 0.45);
      skyCol = mix(skyCol, ridgeCol, ridgeMask * smoothstep(-0.04, 0.005, elev));
    }

    if (elev < 0.0) {
      float down = clamp(-elev, 0.0, 1.0);
      // Warm sunlit dry-grass/earth valley transitioning down to dark charcoal asphalt beneath the car.
      vec3 valleyBounce = uGroundWarmColor * mix(0.72, 1.16, sunPos * 0.65 + 0.2);
      vec3 lowerCol = mix(uHorizonColor * 0.92, valleyBounce, smoothstep(0.0, 0.11, down));
      lowerCol = mix(lowerCol, uGroundRoadColor, smoothstep(0.14, 0.52, down));
      skyCol = lowerCol;
    }

    // Subtle 8-bit gradient dithering on screen to prevent any blue sky banding.
    if (uEnvMode < 0.5) {
      skyCol += (hash21(gl_FragCoord.xy) - 0.5) / 255.0;
    }

    gl_FragColor = vec4(max(skyCol, vec3(0.0)), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function createSkyShaderMaterial(envMode: number): THREE.ShaderMaterial {
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
      uTime: { value: 0 },
      uEnvMode: { value: envMode },
    },
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: true,
  });
}

/**
 * Photorealistic California late-afternoon outdoor environment:
 * - Physically-inspired Rayleigh/Mie atmospheric sky dome with drifting volumetric-look cumulus & cirrus clouds
 * - HDR PMREM reflection environment baked from the sky dome + realistic valley/asphalt lower hemisphere
 * - Warm golden sun with light-space texel-snapped car-following 2048x2048 shadows
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
  private readonly fog: THREE.FogExp2;
  private readonly envTarget: THREE.WebGLRenderTarget;

  private readonly saved: SavedSceneState;
  private readonly scene: THREE.Scene;
  private readonly renderer: THREE.WebGLRenderer;
  private cloudTime = 0;
  private lastUpdateMs = -1;
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

    // 1. Atmospheric GLSL sky dome with volumetric-look drifting clouds.
    this.skyGeo = new THREE.SphereGeometry(SKY_DOME_RADIUS, 48, 32);
    this.skyMat = createSkyShaderMaterial(0.0);
    this.skyDome = new THREE.Mesh(this.skyGeo, this.skyMat);
    this.skyDome.name = 'world-sky-dome';
    this.skyDome.renderOrder = -20;
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
    cam.near = 4;
    cam.far = 220;
    cam.updateProjectionMatrix();
    this.sunLight.shadow.bias = -0.00025;
    this.sunLight.shadow.normalBias = 0.028;
    this.sunLight.shadow.radius = 2.0;
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

  /**
   * Advances drifting sky clouds, centers the sky dome around the focus point, and snaps the
   * directional sun shadow frustum in light-space texel increments for shimmer-free contact shadows.
   */
  update(focusX: number, focusY: number, focusZ: number, dt?: number): void {
    if (this.disposed) return;

    // Advance cloud drift smoothly whether or not caller passes explicit dt.
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

    this.skyDome.position.set(focusX, focusY, focusZ);
    this.renderer.shadowMap.needsUpdate = true;
  }

  private bakeOutdoorEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();

    const envSkyGeo = new THREE.SphereGeometry(60, 48, 32);
    const envSkyMat = createSkyShaderMaterial(1.0);
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
    this.group.removeFromParent();
  }
}
