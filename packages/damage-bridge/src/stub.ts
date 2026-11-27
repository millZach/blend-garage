import {
  cloneMechanicalHealth,
  createHealthyMechanicalHealth,
  type DamageInitConfig,
  type DamageSimulator,
  type DamageStepResult,
  type DeformableMeshPayload,
  type ImpactEvent,
  type MechanicalHealth,
} from './types.js';

/**
 * Zero-cost no-op implementation of `DamageSimulator` for headless tests or
 * modes where visual/mechanical damage is disabled.
 */
export class NoopDamageSimulator implements DamageSimulator {
  readonly name = 'noop-damage';
  private health: MechanicalHealth = createHealthyMechanicalHealth();

  init(_config: DamageInitConfig): void {
    this.health = createHealthyMechanicalHealth();
  }

  applyImpact(_event: ImpactEvent): DamageStepResult {
    return {
      dirtyPartIds: [],
      detachedPartIds: [],
      detachedImpulses: [],
      detachedParts: [],
      meshUpdates: [],
      health: cloneMechanicalHealth(this.health),
    };
  }

  step(_dtSeconds: number): DamageStepResult {
    return {
      dirtyPartIds: [],
      detachedPartIds: [],
      detachedImpulses: [],
      detachedParts: [],
      meshUpdates: [],
      health: cloneMechanicalHealth(this.health),
    };
  }

  reset(): DamageStepResult {
    this.health = createHealthyMechanicalHealth();
    return {
      dirtyPartIds: [],
      detachedPartIds: [],
      detachedImpulses: [],
      detachedParts: [],
      meshUpdates: [],
      health: cloneMechanicalHealth(this.health),
    };
  }

  dispose(): void {
    this.health = createHealthyMechanicalHealth();
  }
}

/**
 * Lightweight Phase 2 test stub that proves out vertex deformation plumbing.
 * Kept exported for backwards compatibility; prefer `RealDamageSimulator` for driving.
 */
export class LocalDentStubSimulator implements DamageSimulator {
  readonly name = 'local-dent-stub';
  private meshes = new Map<string, DeformableMeshPayload>();
  private health: MechanicalHealth = createHealthyMechanicalHealth();

  init(config: DamageInitConfig): void {
    this.meshes.clear();
    for (const mesh of config.meshes) {
      this.meshes.set(mesh.partId, mesh);
    }
    this.health = createHealthyMechanicalHealth();
  }

  applyImpact(event: ImpactEvent): DamageStepResult {
    const [ix, iy, iz] = event.localPoint;
    const [nx, ny, nz] = event.localNormal;
    const radius = Math.min(0.9, Math.max(0.2, event.impulse / 4000));
    const maxDepth = Math.min(0.28, event.impulse / 18000);
    const dirtyPartIds: string[] = [];

    for (const [partId, mesh] of this.meshes.entries()) {
      if (event.partId && event.partId !== partId) continue;
      const pos = mesh.positions;
      let mutated = false;
      for (let i = 0; i < pos.length; i += 3) {
        const dx = pos[i] - ix;
        const dy = pos[i + 1] - iy;
        const dz = pos[i + 2] - iz;
        const dist = Math.hypot(dx, dy, dz);
        if (dist < radius) {
          const falloff = Math.cos((dist / radius) * (Math.PI * 0.5));
          const depth = maxDepth * falloff * falloff;
          pos[i] += nx * depth;
          pos[i + 1] += ny * depth;
          pos[i + 2] += nz * depth;
          mutated = true;
        }
      }
      if (mutated) dirtyPartIds.push(partId);
    }

    this.health.chassisIntegrity = Math.max(0.1, this.health.chassisIntegrity - maxDepth * 0.6);

    return {
      dirtyPartIds,
      detachedPartIds: [],
      health: cloneMechanicalHealth(this.health),
    };
  }

  step(_dtSeconds: number): DamageStepResult {
    return {
      dirtyPartIds: [],
      detachedPartIds: [],
      health: cloneMechanicalHealth(this.health),
    };
  }

  reset(): DamageStepResult {
    const dirtyPartIds: string[] = [];
    for (const [partId, mesh] of this.meshes.entries()) {
      mesh.positions.set(mesh.restPositions);
      dirtyPartIds.push(partId);
    }
    this.health = createHealthyMechanicalHealth();
    return {
      dirtyPartIds,
      detachedPartIds: [],
      health: cloneMechanicalHealth(this.health),
    };
  }

  dispose(): void {
    this.meshes.clear();
  }
}
