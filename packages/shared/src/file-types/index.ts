// ============================================================================ //
// FILE-TYPE REGISTRY — PUBLIC SURFACE                                          //
// ----------------------------------------------------------------------------//
// Isomorphic: the backend imports `@fretik/shared/file-types`, the Nuxt app    //
// imports `#file-types` (an alias onto THIS file). Nothing here may pull in a  //
// dependency — `detect.ts` is intentionally absent so the frontend cannot      //
// reach `file-type`, a Node-only package.                                      //
// ============================================================================ //

export * from "./derive";
export { CODE_BASENAMES, CODE_LANGUAGES, FILE_TYPES } from "./registry";
export type * from "./types";
