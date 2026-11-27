import type { DamagePartCategory } from './types.js';

export interface PartClassification {
  logicalId: string;
  category: DamagePartCategory;
  detachable: boolean;
  thresholdJoules: number;
}

const CORE_BODY_PATTERN = /(^|[_\-\s])(body|body_shell|chassis|frame|unibody|monocoque|tub|cabin|interior|floor|firewall|pillar|glass|windshield|windscreen|window|backlight)($|[_\-\s])/;
const ROOF_RACK_PATTERN = /(roof[_\-\s]?rack|rack|lightbar|cargo|basket)/;
const TOW_HOOK_PATTERN = /(tow[_\-\s]?hook)/;
const MIRROR_PATTERN = /(mirror|wingmirror|side[_\-\s]?mirror)/;
const SPOILER_PATTERN = /(spoiler|wing|diffuser|splitter|lip|canard|aero|blade)/;
const BUMPER_PATTERN = /(bumper|grille|grill|fascia|valance|chin)/;
const EXHAUST_PATTERN = /(exhaust|muffler|tailpipe|tip)/;
const HOOD_PATTERN = /(hood|bonnet)/;
const TRUNK_PATTERN = /(trunk|boot|tailgate|hatch|decklid)/;
const FENDER_PATTERN = /(fender|quarter|arch|skirt|rocker|flare)/;
const DOOR_PATTERN = /(door)/;

const GLASS_MESH_PATTERN = /(glass|window|windscreen|windshield|backlight|glazing|visor)/i;

/** Returns true if a mesh id/material represents glass or glazing (damped deformation). */
export function isGlassMeshId(meshPartId: string): boolean {
  return GLASS_MESH_PATTERN.test(meshPartId);
}

/**
 * Extracts the logical part name from a `VehicleRig` deformable id.
 * Example: `"part-spoiler/Carbon"` -> `"part-spoiler"`, `"body/Paint"` -> `"body"`.
 */
export function extractLogicalPartId(meshPartId: string): string {
  const slashIdx = meshPartId.indexOf('/');
  return slashIdx >= 0 ? meshPartId.slice(0, slashIdx) : meshPartId;
}

/**
 * Classifies a mesh/part id into a damage category and structural detachment threshold.
 *
 * Core structural panels (`body`, `hood`, `trunk`, `fender`, `quarter`, `door`, `roof`) NEVER detach,
 * preventing hollow black holes in open-shell Blender car meshes.
 * Only genuine bolt-on exterior attachments (`spoiler`, `wing`, `splitter`, `diffuser`, `bumper`,
 * `exhaust`, `mirror`, `tow_hook`, `roof_rack`) detach on heavy localized impacts (>= 40–55 kJ).
 */
export function classifyDamagePart(
  meshPartId: string,
  thresholdOverrides?: Record<string, number>,
): PartClassification {
  const logicalId = extractLogicalPartId(meshPartId);
  const override = thresholdOverrides?.[meshPartId] ?? thresholdOverrides?.[logicalId];
  const lower = logicalId.toLowerCase();

  if (override !== undefined) {
    return {
      logicalId,
      category: inferCategory(lower),
      detachable: Number.isFinite(override) && override > 0,
      thresholdJoules: override,
    };
  }

  // Genuine bolt-on exterior attachments (heavy localized hit thresholds: 40–55 kJ).
  if (ROOF_RACK_PATTERN.test(lower)) {
    return { logicalId, category: 'spoiler', detachable: true, thresholdJoules: 42_000 };
  }
  if (TOW_HOOK_PATTERN.test(lower)) {
    return { logicalId, category: 'other', detachable: true, thresholdJoules: 42_000 };
  }

  // Core body shell / chassis never detaches.
  if (lower === 'body' || lower === 'roof' || CORE_BODY_PATTERN.test(lower)) {
    return { logicalId, category: 'body', detachable: false, thresholdJoules: Number.POSITIVE_INFINITY };
  }

  if (MIRROR_PATTERN.test(lower)) {
    return { logicalId, category: 'mirror', detachable: true, thresholdJoules: 40_000 };
  }
  if (SPOILER_PATTERN.test(lower)) {
    return { logicalId, category: 'spoiler', detachable: true, thresholdJoules: 45_000 };
  }
  if (EXHAUST_PATTERN.test(lower)) {
    return { logicalId, category: 'exhaust', detachable: true, thresholdJoules: 48_000 };
  }
  if (BUMPER_PATTERN.test(lower)) {
    return { logicalId, category: 'bumper', detachable: true, thresholdJoules: 55_000 };
  }

  // Structural body panels stay permanently attached so crashes dent cleanly without hollow holes.
  if (HOOD_PATTERN.test(lower)) {
    return { logicalId, category: 'hood', detachable: false, thresholdJoules: Number.POSITIVE_INFINITY };
  }
  if (TRUNK_PATTERN.test(lower)) {
    return { logicalId, category: 'trunk', detachable: false, thresholdJoules: Number.POSITIVE_INFINITY };
  }
  if (FENDER_PATTERN.test(lower)) {
    return { logicalId, category: 'fender', detachable: false, thresholdJoules: Number.POSITIVE_INFINITY };
  }
  if (DOOR_PATTERN.test(lower)) {
    return { logicalId, category: 'door', detachable: false, thresholdJoules: Number.POSITIVE_INFINITY };
  }

  // Unknown/generic panels default to attached bodywork so random structural meshes never tear off.
  return { logicalId, category: 'body', detachable: false, thresholdJoules: Number.POSITIVE_INFINITY };
}

function inferCategory(lower: string): DamagePartCategory {
  if (MIRROR_PATTERN.test(lower)) return 'mirror';
  if (SPOILER_PATTERN.test(lower) || ROOF_RACK_PATTERN.test(lower)) return 'spoiler';
  if (EXHAUST_PATTERN.test(lower)) return 'exhaust';
  if (BUMPER_PATTERN.test(lower)) return 'bumper';
  if (HOOD_PATTERN.test(lower)) return 'hood';
  if (TRUNK_PATTERN.test(lower)) return 'trunk';
  if (FENDER_PATTERN.test(lower)) return 'fender';
  if (DOOR_PATTERN.test(lower)) return 'door';
  if (lower === 'body' || CORE_BODY_PATTERN.test(lower)) return 'body';
  return 'other';
}
