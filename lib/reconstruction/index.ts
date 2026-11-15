/**
 * Reconstruction adapter (HK-002): fal-ai/sam-3/3d-objects jobs driven through
 * the JobStore port, with GLB validation and canonical normalization.
 * The live provider lives in ./fal-live and is server-only.
 */
export * from "./fal-queue";
export * from "./glb-normalize";
export * from "./runner";
export * from "./splat";
export * from "./placement";
