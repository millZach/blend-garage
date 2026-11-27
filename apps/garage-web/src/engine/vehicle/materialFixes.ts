import * as THREE from 'three';
import type { GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { PaintZoneRole, VehicleManifest } from '@blend-garage/vehicle-core';

/** Every texture slot a physical material can carry. */
const TEXTURE_SLOTS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
  'alphaMap',
  'bumpMap',
  'clearcoatMap',
  'clearcoatNormalMap',
  'clearcoatRoughnessMap',
  'iridescenceMap',
  'iridescenceThicknessMap',
  'sheenColorMap',
  'sheenRoughnessMap',
  'specularColorMap',
  'specularIntensityMap',
  'transmissionMap',
  'thicknessMap',
  'anisotropyMap',
] as const;

const GLASS_WORDS = /(glass|windscreen|windshield|window|glazing|backlight|\bpane(?:[_ -]?(?:ws|side|qtr|ec|rear|front|roof))?\b)/;
const LENS_WORDS = /(lens|clear[ _-]?cover|clear[ _-]?shell|lamp[ _-]?cover|bulb|perspex|visor)/;
/** Dark, solid things that sit around glass and get glass-like names without being see-through. */
const NOT_GLASS = /(bezel|gasket|seal|frame|surround|edge|rubber|frit|shadow|channel|rebate|ceramic|housing|enclosure|polymer|carbon|conductor|demister|warning|shutter|instrument|pcm|display|perimeter|filament)/;
/** Explicit dark trim/frit keywords so blank-exported black trim never stays white. */
const DARK_SOLID_WORDS = /(black|dark|shadow|epdm|rubber|gasket|seal|channel|ceramic|frit|carbon|charcoal|graphite)/;

export function texturesOf(material: THREE.Material): THREE.Texture[] {
  const found: THREE.Texture[] = [];
  const slots = material as unknown as Record<string, unknown>;
  for (const slot of TEXTURE_SLOTS) {
    const value = slots[slot];
    if (value instanceof THREE.Texture) found.push(value);
  }
  return found;
}

function luminance(c: THREE.Color): number {
  return c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
}

function saturation(c: THREE.Color): number {
  const max = Math.max(c.r, c.g, c.b);
  return max < 1e-4 ? 0 : (max - Math.min(c.r, c.g, c.b)) / max;
}

function toPhysical(material: THREE.Material): THREE.Material {
  if (material instanceof THREE.MeshPhysicalMaterial || !(material instanceof THREE.MeshStandardMaterial)) return material;
  const physical = new THREE.MeshPhysicalMaterial();
  THREE.MeshStandardMaterial.prototype.copy.call(physical, material);
  material.dispose();
  return physical;
}

/**
 * Makes a car's exported materials safe and good-looking in WebGL, without changing what the
 * artist authored beyond what the renderer cannot do:
 *
 *  1. Textures bound to a UV channel above 3 (Blender happily exports `uv5`) crash Three.js vertex
 *     shader compilation, so those are moved to channel 0.
 *  2. `KHR_materials_transmission` glass renders as opaque milky white and costs a second full pass
 *     of a multi-million-triangle car, so glazing becomes thin tinted reflective glass and every
 *     other material has its transmission switched off.
 *  3. Every standard material is upgraded to a physical one, so any zone can take clearcoat or pearl.
 */
export function prepareMaterials(root: THREE.Object3D, manifest: VehicleManifest, maxAnisotropy: number): Map<string, THREE.Material[]> {
  const zones = new Map<string, { role: PaintZoneRole; defaultColor: string }>();
  for (const zone of manifest.materialZones) zones.set(zone.materialName, zone);

  const replaced = new Map<THREE.Material, THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    // glTF primitives carry one material each; anything else is collapsed to its first.
    const source: THREE.Material = Array.isArray(object.material) ? object.material[0] : object.material;
    let fixed = replaced.get(source);
    if (!fixed) {
      fixed = toPhysical(source);
      fixMaterial(fixed, zones.get(fixed.name), maxAnisotropy);
      replaced.set(source, fixed);
    }
    object.material = fixed;
  });

  const byName = new Map<string, THREE.Material[]>();
  for (const material of replaced.values()) {
    const list = byName.get(material.name);
    if (list) list.push(material);
    else byName.set(material.name, [material]);
  }
  return byName;
}

/** Blender's untouched default base color (0.8 grey), which says nothing about the material. */
const BLENDER_DEFAULT_GREY = '#e7e7e7';

function fixMaterial(material: THREE.Material, zone: { role: PaintZoneRole; defaultColor: string } | undefined, maxAnisotropy: number): void {
  for (const texture of texturesOf(material)) {
    if (texture.channel > 3) texture.channel = 0;
    texture.anisotropy = Math.min(8, maxAnisotropy);
  }
  if (!(material instanceof THREE.MeshPhysicalMaterial)) return;
  const role = zone?.role;

  // A procedural Blender shader cannot be exported, so its material arrives pure white and untextured.
  // The importer recorded the color the artist set on the shader; that is the truer base color.
  const exportedBlank = !material.map && material.color.r > 0.99 && material.color.g > 0.99 && material.color.b > 0.99;
  if (exportedBlank && zone && /^#[0-9a-f]{6}$/i.test(zone.defaultColor) && zone.defaultColor.toLowerCase() !== BLENDER_DEFAULT_GREY) {
    material.color.set(zone.defaultColor);
  }

  // Blender exports a mesh's active color attribute whether or not the shader uses it, and glTF then
  // multiplies it into the base color, which mottles the paint. Vertex colors are only kept where
  // they are plainly the surface's color: on a material that has no color of its own.
  if (material.vertexColors && !exportedBlank) {
    material.vertexColors = false;
    material.needsUpdate = true;
  }

  const name = material.name.toLowerCase();
  const transmission = material.transmission;
  const glazing = role === 'glass' || GLASS_WORDS.test(name);
  const whiteGlow = !material.emissiveMap && material.emissive.r > 0.95 && material.emissive.g > 0.95 && material.emissive.b > 0.95;
  // Unexportable Blender Glass+Glossy mix shaders export as black baseColor + neutral emissive (0.2..1.0).
  const neutralGlassGlow =
    !material.map &&
    !material.emissiveMap &&
    material.color.r < 0.02 &&
    material.color.g < 0.02 &&
    material.color.b < 0.02 &&
    material.emissive.r > 0.2 &&
    material.emissive.g > 0.2 &&
    material.emissive.b > 0.2 &&
    saturation(material.emissive) < 0.08;
  const explicitWindowPane = /(windscreen|windshield|window|backlight|\bpane(?:[_ -]?(?:ws|side|qtr|ec|rear|front|roof))?\b|soft-ray|solar.*glass|laminated.*glass|smoked.*glass|hatch glass|drop glass|quarter glass|optical stack)/.test(name);
  const coloredLens = LENS_WORDS.test(name) && saturation(material.color) > 0.3 && !/chrome|shoulder|cut ends|prism|satin|plated/.test(name);
  const looksClear = exportedBlank || transmission > 0 || whiteGlow || neutralGlassGlow || explicitWindowPane || coloredLens || luminance(material.color) > 0.5 || material.roughness < 0.2;
  const solid = NOT_GLASS.test(name) && transmission < 0.35 && !whiteGlow && !neutralGlassGlow && !/optical stack/.test(name);
  const mirror = /mirror/.test(name) && glazing;

  if (solid && exportedBlank && DARK_SOLID_WORDS.test(name)) {
    material.color.set(0x121418);
    material.roughness = Math.min(material.roughness, 0.42);
    material.metalness = 0.08;
  }

  if (mirror) {
    material.metalness = 1;
    material.roughness = 0.04;
    material.color.set(0xdfe5ea);
    material.emissive.set(0x000000);
  } else if (!material.map && !solid && (transmission > 0.35 || neutralGlassGlow || ((glazing || LENS_WORDS.test(name)) && looksClear))) {
    const colored = saturation(material.color) > 0.3;
    if (colored) {
      // Red and amber lamp lenses keep their color.
      material.opacity = 0.74;
    } else if (glazing) {
      material.color.multiplyScalar(0.12).add(new THREE.Color(0x0c1216));
      material.opacity = 0.36;
    } else {
      // Clear lamp covers: nearly invisible, so the lamp internals show.
      material.color.set(0xe8eef2);
      material.opacity = 0.14;
    }
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.roughness = 0.05;
    material.metalness = 0;
    material.clearcoat = 1;
    material.clearcoatRoughness = 0.03;
    material.envMapIntensity = 1.35;
    if (whiteGlow || neutralGlassGlow || !colored) material.emissive.set(0x000000);
    material.userData.glass = true;
  }
  // No material keeps real transmission: it would add a second full render of the car every frame.
  material.transmission = 0;
  material.thickness = 0;
}

interface TextureRef {
  texCoord?: number;
}
interface MaterialDef {
  pbrMetallicRoughness?: { baseColorTexture?: TextureRef; metallicRoughnessTexture?: TextureRef };
  normalTexture?: TextureRef;
  occlusionTexture?: TextureRef;
  emissiveTexture?: TextureRef;
}

const unmappable = (ref: TextureRef | undefined): boolean => typeof ref?.texCoord === 'number' && ref.texCoord < 0;

function closeTexture(texture: THREE.Texture): void {
  texture.dispose();
  const image = texture.source?.data as { close?: () => void } | undefined;
  if (image && typeof image.close === 'function') image.close();
}

/** Mean RGBA of a texture's image, each 0..1 in the image's own encoding. `null` if it cannot be read. */
function averageTexel(texture: THREE.Texture, cache: Map<unknown, [number, number, number, number] | null>): [number, number, number, number] | null {
  const image = texture.image as CanvasImageSource | undefined;
  if (!image) return null;
  if (cache.has(image)) return cache.get(image) ?? null;
  let mean: [number, number, number, number] | null = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 24;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) {
      ctx.drawImage(image, 0, 0, 24, 24);
      const { data } = ctx.getImageData(0, 0, 24, 24);
      const sum = [0, 0, 0, 0];
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3] / 255;
        sum[0] += (data[i] / 255) * a;
        sum[1] += (data[i + 1] / 255) * a;
        sum[2] += (data[i + 2] / 255) * a;
        sum[3] += a;
      }
      const pixels = data.length / 4;
      const weight = Math.max(sum[3], 1e-6);
      mean = [sum[0] / weight, sum[1] / weight, sum[2] / weight, sum[3] / pixels];
    }
  } catch {
    mean = null;
  }
  cache.set(image, mean);
  return mean;
}

/**
 * Deals with textures the Blender exporter could not give UVs to. When a texture is driven by
 * Object or Generated coordinates, the exporter still writes it but with `texCoord: -1`; Three.js then
 * samples it with whatever UVs the mesh happens to have, which paints random streaks over the panel.
 *
 * A texture like that cannot be shown where it belongs, so it is reduced to what it means for the
 * surface as a whole: a decal with a transparent background is dropped (the paint under it shows),
 * and an opaque material scan (suede, leather, carpet, carbon weave) becomes its average color and
 * average roughness and metalness.
 */
export function resolveUnmappableTextures(parser: GLTFParser): void {
  const defs = (parser.json as { materials?: MaterialDef[] }).materials ?? [];
  const cache = new Map<unknown, [number, number, number, number] | null>();
  const stripped = new Set<THREE.Texture>();
  const materials: THREE.MeshStandardMaterial[] = [];

  for (const [object, link] of parser.associations) {
    if (!(object instanceof THREE.MeshStandardMaterial)) continue;
    materials.push(object);
    const def = link.materials === undefined ? undefined : defs[link.materials];
    if (!def) continue;

    if (unmappable(def.pbrMetallicRoughness?.baseColorTexture) && object.map) {
      const mean = averageTexel(object.map, cache);
      if (mean && mean[3] > 0.9) object.color.multiply(new THREE.Color().setRGB(mean[0], mean[1], mean[2], THREE.SRGBColorSpace));
      stripped.add(object.map);
      object.map = null;
    }
    if (unmappable(def.pbrMetallicRoughness?.metallicRoughnessTexture) && (object.roughnessMap || object.metalnessMap)) {
      const map = (object.roughnessMap ?? object.metalnessMap)!;
      // glTF packs roughness in green and metalness in blue.
      const mean = averageTexel(map, cache);
      object.roughness *= mean ? mean[1] : 0.6;
      object.metalness *= mean ? mean[2] : 0;
      stripped.add(map);
      object.roughnessMap = null;
      object.metalnessMap = null;
    }
    for (const [ref, slot] of [
      [def.normalTexture, 'normalMap'],
      [def.occlusionTexture, 'aoMap'],
      [def.emissiveTexture, 'emissiveMap'],
    ] as const) {
      const map = object[slot];
      if (unmappable(ref) && map) {
        stripped.add(map);
        object[slot] = null;
      }
    }
  }

  // Release what nothing else still uses. Several textures can share one decoded image, so the
  // image is only closed when no surviving texture points at it.
  const texturesInUse = new Set<THREE.Texture>();
  const imagesInUse = new Set<unknown>();
  for (const material of materials) {
    for (const texture of texturesOf(material)) {
      texturesInUse.add(texture);
      imagesInUse.add(texture.source);
    }
  }
  for (const texture of stripped) {
    if (texturesInUse.has(texture)) continue;
    if (imagesInUse.has(texture.source)) texture.dispose();
    else closeTexture(texture);
  }
}
