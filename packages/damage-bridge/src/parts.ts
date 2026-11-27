import type { DamagePartCategory } from './types.js';

export interface PartClassification {
  logicalId: string;
  category: DamagePartCategory;
  detachable: boolean;
  thresholdJoules: number;
}

const CORE_BODY_PATTERN = /(^|[_\-\s])(body|body_shell|chassis|frame|unibody|monocoque|tub|cabin|interior|floor|firewall|pillar|glass|windshield|windscreen)($|[_\-\s])/;
const ROOF_RACK_PATTERN = /(roof[_\-\s]?rack|rack|lightbar|cargo|basket)/;
const MIRROR_PATTERN = /(mirror|wingmirror|side[_\-\s]?mirror)/;
const SPOILER_PATTERN = /(spoiler|wing|diffuser|splitter|lip|canard|aero|blade)/;
const BUMPER_PATTERN = /(bumper|grille|grill|fascia|valance|chin)/;
const EXHAUST_PATTERN = /(exhaust|muffler|tailpipe|tip)/;
const HOOD_PATTERN = /(hood|bonnet)/;
const TRUNK_PATTERN = /(trunk|boot|tailgate|hatch|decklid)/;
const FENDER_PATTERN = /(fender|quarter|arch|skirt|rocker|flare)/;
const DOOR_PATTERN = /(door)/;

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
 * Main body meshes (`body/...`, `body_shell`, `chassis`) never detach so the car cannot vanish;
 * external bolt-on panels (mirrors, spoilers, bumpers, hoods, fenders, doors) detach cleanly
 * once accumulated local crash energy exceeds their threshold.
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

  // Roof racks/lightbars are detachable even though they contain "roof".
  if (ROOF_RACK_PATTERN.test(lower)) {
    return { logicalId, category: 'spoiler', detachable: true, thresholdJoules: 16_000 };
  }

  // Core body shell / chassis never detaches as a whole.
  if (lower === 'body' || lower === 'roof' || CORE_BODY_PATTERN.test(lower)) {
    return { logicalId, category: 'body', detachable: false, thresholdJoules: Number.POSITIVE_INFINITY };
  }

  if (MIRROR_PATTERN.test(lower)) {
    return { logicalId, category: 'mirror', detachable: true, thresholdJoules: 10_000 };
  }
  if (SPOILER_PATTERN.test(lower)) {
    return { logicalId, category: 'spoiler', detachable: true, thresholdJoules: 18_000 };
  }
  if (EXHAUST_PATTERN.test(lower)) {
    return { logicalId, category: 'exhaust', detachable: true, thresholdJoules: 24_000 };
  }
  if (BUMPER_PATTERN.test(lower)) {
    return { logicalId, category: 'bumper', detachable: true, thresholdJoules: 26_000 };
  }
  if (HOOD_PATTERN.test(lower)) {
    return { logicalId, category: 'hood', detachable: true, thresholdJoules: 38_000 };
  }
  if (TRUNK_PATTERN.test(lower)) {
    return { logicalId, category: 'trunk', detachable: true, thresholdJoules: 38_000 };
  }
  if (FENDER_PATTERN.test(lower)) {
    return { logicalId, category: 'fender', detachable: true, thresholdJoules: 46_000 };
  }
  if (DOOR_PATTERN.test(lower)) {
    return { logicalId, category: 'door', detachable: true, thresholdJoules: 54_000 };
  }

  // Explicit Blender `part_` / `part-` convention defaults to detachable bolt-on part.
  if (lower.startsWith('part_') || lower.startsWith('part-')) {
    return { logicalId, category: 'other', detachable: true, thresholdJoules: 30_000 };
  }

  // Untagged / unknown meshes default to non-detachable bodywork for graceful fallback.
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
