import * as THREE from 'three';
import type { GlassTintConfig, MaterialZoneInfo, PaintFinishType, PaintZoneRole, PaintZoneState, VehicleManifest } from '@blend-garage/vehicle-core';

/** Everything paint can change on a material, captured once so a zone can always go back to stock. */
interface StockLook {
  color: THREE.Color;
  metalness: number;
  roughness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  iridescence: number;
  iridescenceIOR: number;
  map: THREE.Texture | null;
  metalnessMap: THREE.Texture | null;
  roughnessMap: THREE.Texture | null;
  opacity: number;
  emissive: THREE.Color;
}

interface Zone {
  info: MaterialZoneInfo;
  materials: THREE.MeshPhysicalMaterial[];
  stock: StockLook[];
  /** What is applied right now: a paint state, or `null` for stock. */
  applied: PaintZoneState | null;
}

const HIGHLIGHT = new THREE.Color(1.0, 0.72, 0.05);
const _color = new THREE.Color();

function guessFinish(m: THREE.MeshPhysicalMaterial): PaintFinishType {
  if (m.iridescence > 0.4) return 'pearlescent';
  if (m.metalness > 0.9 && m.roughness < 0.12) return 'chrome';
  if (m.roughness > 0.55) return 'matte';
  if (m.roughness > 0.3) return 'satin';
  if (m.metalness > 0.5) return 'metallic';
  return 'gloss';
}

/**
 * Binds the manifest's material zones to the live Three.js materials and applies paint to them.
 *
 * A zone that has not been modified keeps the exact material the artist exported: its textures,
 * its PBR values, everything. Only a zone the user has actually painted is overridden, and resetting
 * it restores the original untouched.
 */
export class PaintBooth {
  private readonly zones = new Map<string, Zone>();
  private readonly lamp = new Map<THREE.Material, THREE.Color>();
  private readonly highlight = new Map<string, number>();
  /** Which zone (and which slot in it) each material belongs to. */
  private readonly owner = new Map<THREE.Material, { zone: Zone; index: number }>();

  constructor(manifest: VehicleManifest, materialsByName: Map<string, THREE.Material[]>) {
    for (const info of manifest.materialZones) {
      const materials = (materialsByName.get(info.materialName) ?? []).filter((m): m is THREE.MeshPhysicalMaterial => m instanceof THREE.MeshPhysicalMaterial);
      this.zones.set(info.id, {
        info,
        materials,
        stock: materials.map((m) => ({
          color: m.color.clone(),
          metalness: m.metalness,
          roughness: m.roughness,
          clearcoat: m.clearcoat,
          clearcoatRoughness: m.clearcoatRoughness,
          iridescence: m.iridescence,
          iridescenceIOR: m.iridescenceIOR,
          map: m.map,
          metalnessMap: m.metalnessMap,
          roughnessMap: m.roughnessMap,
          opacity: m.opacity,
          emissive: m.emissive.clone().multiplyScalar(m.emissiveIntensity),
        })),
        applied: null,
      });
      const zone = this.zones.get(info.id)!;
      // Emissive is mixed here from stock, lamp state and highlight, so intensity is folded into the color.
      materials.forEach((m, index) => {
        m.emissive.copy(zone.stock[index].emissive);
        m.emissiveIntensity = 1;
        this.owner.set(m, { zone, index });
      });
    }
  }

  has(zoneId: string): boolean {
    return (this.zones.get(zoneId)?.materials.length ?? 0) > 0;
  }

  role(zoneId: string): PaintZoneRole | undefined {
    return this.zones.get(zoneId)?.info.role;
  }

  materialsOf(zoneId: string): THREE.MeshPhysicalMaterial[] {
    return this.zones.get(zoneId)?.materials ?? [];
  }

  /** The zone's stock look expressed as a paint state, so the HUD's sliders start where the car really is. */
  stockState(zoneId: string): PaintZoneState | null {
    const zone = this.zones.get(zoneId);
    const m = zone?.materials[0];
    const stock = zone?.stock[0];
    if (!zone || !m || !stock) return null;
    // A textured zone has no single color; the importer's sampled default is the closest honest answer.
    const color = stock.map ? zone.info.defaultColor : `#${stock.color.getHexString()}`;
    return {
      color: /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : '#808080',
      finish: guessFinish(m),
      metalness: stock.metalness,
      roughness: stock.roughness,
      clearcoat: stock.clearcoat,
      clearcoatRoughness: stock.clearcoatRoughness,
      iridescence: stock.iridescence,
    };
  }

  /** Paints a zone, or with `null` returns it to the material the car was imported with. */
  apply(zoneId: string, state: PaintZoneState | null): void {
    const zone = this.zones.get(zoneId);
    if (!zone || zone.applied === state) return;
    zone.applied = state;
    zone.materials.forEach((m, i) => {
      const stock = zone.stock[i];
      const hadMaps = Boolean(m.map) || Boolean(m.metalnessMap) || Boolean(m.roughnessMap);
      if (state) {
        // Base color and metal/roughness textures would fight the chosen paint; surface detail (normals) stays.
        m.map = null;
        m.metalnessMap = null;
        m.roughnessMap = null;
        m.color.set(state.color);
        m.metalness = state.metalness;
        m.roughness = state.roughness;
        m.clearcoat = state.clearcoat;
        m.clearcoatRoughness = state.clearcoatRoughness;
        m.iridescence = state.iridescence;
        m.iridescenceIOR = 1.7;
      } else {
        m.map = stock.map;
        m.metalnessMap = stock.metalnessMap;
        m.roughnessMap = stock.roughnessMap;
        m.color.copy(stock.color);
        m.metalness = stock.metalness;
        m.roughness = stock.roughness;
        m.clearcoat = stock.clearcoat;
        m.clearcoatRoughness = stock.clearcoatRoughness;
        m.iridescence = stock.iridescence;
        m.iridescenceIOR = stock.iridescenceIOR;
        m.opacity = stock.opacity;
      }
      const hasMaps = Boolean(m.map) || Boolean(m.metalnessMap) || Boolean(m.roughnessMap);
      if (hadMaps !== hasMaps) m.needsUpdate = true;
    });
  }

  /** Tints glass. Only called for glass-role zones the user has not painted individually. */
  applyGlassTint(zoneId: string, tint: GlassTintConfig | null): void {
    const zone = this.zones.get(zoneId);
    if (!zone) return;
    zone.materials.forEach((m, i) => {
      if (!m.userData.glass) return;
      const stock = zone.stock[i];
      if (tint) {
        m.color.set(tint.color).multiplyScalar(0.55 - tint.darkness * 0.4);
        m.opacity = 0.2 + tint.darkness * 0.72;
      } else {
        m.color.copy(stock.color);
        m.opacity = stock.opacity;
      }
    });
  }

  /** Makes lamp materials glow (`color` is premultiplied HDR), or returns them to stock with `null`. */
  setLamp(material: THREE.Material, color: THREE.Color | null): void {
    if (color) this.lamp.set(material, color);
    else this.lamp.delete(material);
    this.mixEmissive(material);
  }

  /** 0..1 pulse that lights a zone up so the user can see which surfaces it covers. */
  setHighlight(zoneId: string, amount: number): void {
    if (amount > 0.001) this.highlight.set(zoneId, amount);
    else this.highlight.delete(zoneId);
    for (const m of this.zones.get(zoneId)?.materials ?? []) this.mixEmissive(m);
  }

  private mixEmissive(material: THREE.Material): void {
    if (!(material instanceof THREE.MeshPhysicalMaterial)) return;
    const owner = this.owner.get(material);
    const stock = owner ? owner.zone.stock[owner.index].emissive : _color.set(0x000000);
    material.emissive.copy(this.lamp.get(material) ?? stock);
    const glow = owner ? (this.highlight.get(owner.zone.info.id) ?? 0) : 0;
    if (glow > 0) material.emissive.add(_color.copy(HIGHLIGHT).multiplyScalar(glow * 0.9));
  }
}

/** Reads the look of a material into a fresh physical material, without its textures. */
export function copyPaintLook(from: THREE.MeshPhysicalMaterial, to: THREE.MeshPhysicalMaterial, fallbackColor: string): void {
  if (from.map) to.color.set(fallbackColor);
  else to.color.copy(from.color);
  to.metalness = from.metalness;
  to.roughness = from.metalnessMap || from.roughnessMap ? Math.min(from.roughness, 0.35) : from.roughness;
  to.clearcoat = from.clearcoat;
  to.clearcoatRoughness = from.clearcoatRoughness;
  to.iridescence = from.iridescence;
  to.iridescenceIOR = from.iridescenceIOR;
}
