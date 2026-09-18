/**
 * Types for browser-layout.mjs, so the spec that keeps it in agreement with
 * src/collector/browser.ts typechecks without loosening `allowJs` for every
 * script in the repository.
 */
export declare function chromiumCandidates(root: string, platform: NodeJS.Platform): string[];
