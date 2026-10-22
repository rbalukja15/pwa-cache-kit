// Tier configs carry their adapter builder under a symbol that only this module exports, and
// index.ts does not, so only the tier factories can make one (ADR-0002 sections 1 and 17).
import type { CreateTierAdapter } from './tier.js';
import type { TierConfig, TierName } from './types.js';

/** The key under which a tier config holds its `CreateTierAdapter`. */
export const tierBrand: unique symbol = Symbol('pwa-cache-kit tier');

/** A tier config for `name` whose adapters `create` builds. */
export function tierConfig<N extends TierName>(name: N, create: CreateTierAdapter): TierConfig<N> {
  return Object.freeze({ name, [tierBrand]: create });
}

/** The adapter builder of a tier config, or undefined for anything a tier factory did not make. */
export function adapterBuilder(config: unknown): CreateTierAdapter | undefined {
  if (typeof config !== 'object' || config === null || !(tierBrand in config)) return undefined;
  const create = config[tierBrand];
  return typeof create === 'function' ? (create as CreateTierAdapter) : undefined;
}
