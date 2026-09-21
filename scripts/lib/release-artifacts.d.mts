/**
 * Types for release-artifacts.mjs, so the specs over it typecheck without
 * loosening `allowJs` for every script in the repository.
 */
export declare function partitionArtifactsByVersion(
  fileNames: string[],
  version: string,
): { belonging: string[]; foreign: string[]; unversioned: string[] };

export declare function foreignArtifactFailure(
  foreign: string[],
  version: string,
  releaseDir: string,
): string;
