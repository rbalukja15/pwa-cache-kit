import { createReferenceTier } from './reference-tier.js';
import { runTierConformance } from './tier-conformance.js';

runTierConformance({ name: 'reference, sync', ...createReferenceTier('memory', true) });
runTierConformance({ name: 'reference, async', ...createReferenceTier('indexeddb', false) });
