/** Public surface. Pure time/layover logic plus the data-injected network. */
export * from './time.mjs';
export * from './layover.mjs';
export { createNetwork } from './network.mjs';
export { createEntryRules, ENTRY_SEVERITY } from './entry.mjs';
