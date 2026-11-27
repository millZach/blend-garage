import * as THREE from 'three';
import { smoothstep } from '../math';

const SUN_DIR = new THREE.Vector3(0.48, 0.72, 0.5).normalize();
const SKY_ZENITH = new THREE.Color(0x2d74d6);
const SKY_MID = new THREE.Color(0x74b2ee);
const SKY_HORIZON = new THREE.Color(0xd2e4f6);
const SKY_GROUND = new THREE.Color(0x889381);
const SUN_GLOW = new THREE.Color(0xfff4d6);

interface SavedSceneState {
  background: THREE.Color | THREE.Texture | THREE.CubeTexture | null;
  fog: THREE.Fog | THREE.FogExp2 | null;
  environment: THREE.Texture | null;
  environmentIntensity: number;
  exposure: number;
}

/**
 * Builds the vertex-colored daylight sky dome with a warm solar halo along `SUN_DIR`.
 */
function createSkyDomeGeometry(radius: number): THREE.SphereGeometry {
  const geo = new THREE.SphereGeometry(radius, 36, 20);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const dir = new THREE.Vector3();
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    dir.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
    const y = dir.y;
    if (y >= 0) {
      c.copy(SKY_HORIZON).lerp(SKY_MID, smoothstep(0.0, 0.28, y));
      c.lerp(SKY_ZENITH, smoothstep(0.24, 0.88, y));
    } else {
      c.copy(SKY_HORIZON).lerp(SKY_GROUND, smoothstep(0.0, -0.25, y));
    }

    // Soft sun halo & crisp solar core.
    const sunDot = Math.max(0, dir.dot(SUN_DIR));
    const halo = Math.pow(sunDot, 16) * 0.45 + Math.pow(sunDot, 220) * 1.15;
    if (halo > 0.001) {
      c.lerp(SUN_GLOW, Math.min(1, halo));
    }

    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

/**
 * Outdoor daylight lighting, sky dome, atmospheric distance fog, car-following directional sun
 * shadows, and a baked outdoor PMREM reflection environment for glossy car paint.
 */
export class WorldEnvironment {
  readonly group = new THREE.Group();

  private readonly sunLight: THREE.DirectionalLight;
  private readonly hemiLight: THREE.HemisphereLight;
  private readonly skyDome: THREE.Mesh;
  private readonly skyGeo: THREE.SphereGeometry;
  private readonly skyMat: THREE.MeshBasicMaterial;
  private readonly fog: THREE.Fog;
  private readonly envTarget: THREE.WebGLRenderTarget;

  private readonly saved: SavedSceneState;
  private readonly scene: THREE.Scene;
  private readonly renderer: THREE.WebGLRenderer;
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

    // Sky dome follows camera XZ so the horizon never clips.
    this.skyGeo = createSkyDomeGeometry(920);
    this.skyMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.skyDome = new THREE.Mesh(this.skyGeo, this.skyMat);
    this.skyDome.name = 'world-sky-dome';
    this.skyDome.renderOrder = -20;
    this.skyDome.frustumCulled = false;
    this.group.add(this.skyDome);

    // Bright outdoor hemisphere fill (blue sky + warm earth bounce).
    this.hemiLight = new THREE.HemisphereLight(0xd4e8ff, 0x706c5c, 0.92);
    this.group.add(this.hemiLight);

    // Crisp sunlight with tight car-following shadow frustum.
    this.sunLight = new THREE.DirectionalLight(0xfff5e0, 2.75);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    const cam = this.sunLight.shadow.camera;
    const extent = 34;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = 2;
    cam.far = 160;
    this.sunLight.shadow.bias = -0.00035;
    this.sunLight.shadow.normalBias = 0.04;
    this.sunLight.shadow.radius = 2.4;
    this.sunLight.position.copy(SUN_DIR).multiplyScalar(75);
    this.group.add(this.sunLight, this.sunLight.target);

    this.fog = new THREE.Fog(0xcadff5, 240, 880);
    this.envTarget = this.bakeOutdoorEnvironment(renderer);

    scene.background = SKY_HORIZON.clone();
    scene.fog = this.fog;
    scene.environment = this.envTarget.texture;
    scene.environmentIntensity = 1.05;
    renderer.toneMappingExposure = 1.02;
    scene.add(this.group);
  }

  /** Keeps directional sun shadows crisp around the car and sky centered in XZ. */
  update(focusX: number, focusY: number, focusZ: number): void {
    if (this.disposed) return;

    // Snap shadow center to 0.25m texel increments to prevent shadow edge shimmer while driving.
    const snap = 0.25;
    const sx = Math.round(focusX / snap) * snap;
    const sy = Math.round(focusY / snap) * snap;
    const sz = Math.round(focusZ / snap) * snap;

    this.sunLight.target.position.set(sx, sy, sz);
    this.sunLight.position.set(
      sx + SUN_DIR.x * 75,
      sy + SUN_DIR.y * 75,
      sz + SUN_DIR.z * 75,
    );
    this.sunLight.target.updateMatrixWorld();

    this.skyDome.position.set(focusX, 0, focusZ);
    this.renderer.shadowMap.needsUpdate = true;
  }

  private bakeOutdoorEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();

    const envSkyGeo = createSkyDomeGeometry(50);
    const envSkyMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
    envScene.add(new THREE.Mesh(envSkyGeo, envSkyMat));

    // Bright specular sun card + soft horizon bounce strips for rich metallic/clearcoat highlights.
    const sunCardGeo = new THREE.CircleGeometry(6.5, 24);
    const sunCardMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4.5, 4.1, 3.3), side: THREE.DoubleSide });
    const sunCard = new THREE.Mesh(sunCardGeo, sunCardMat);
    sunCard.position.copy(SUN_DIR).multiplyScalar(38);
    sunCard.lookAt(0, 0, 0);
    envScene.add(sunCard);

    const groundGeo = new THREE.PlaneGeometry(120, 120);
    groundGeo.rotateX(-Math.PI / 2);
    const groundMat = new THREE.MeshBasicMaterial({ color: 0x5c6158 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.position.y = -4;
    envScene.add(ground);

    const target = pmrem.fromScene(envScene, 0.032, 0.1, 120);
    pmrem.dispose();
    envSkyGeo.dispose();
    envSkyMat.dispose();
    sunCardGeo.dispose();
    sunCardMat.dispose();
    groundGeo.dispose();
    groundMat.dispose();
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

    this.sunLight.shadow.map?.dispose();
    this.envTarget.dispose();
    this.skyGeo.dispose();
    this.skyMat.dispose();
    this.group.removeFromParent();
  }
}
