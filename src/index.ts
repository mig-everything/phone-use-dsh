/** The device API is independent of MCP, ChatGPT, and any model provider. */
export { createService, configSchema } from './config.js';
export { PhoneService } from './core/service.js';
export { PhoneError } from './core/errors.js';
export type * from './core/types.js';
export type { EncodedBatch, EncodedPacket } from './transport/encoded-video.js';
export type {
  Observation,
  TreeObservation,
  CaptureResult,
  InspectionResult,
} from './core/service.js';
export { HarmonyAdapter } from './adapters/harmony.js';
export { AndroidAdapter } from './adapters/android.js';
export { IOSAdapter } from './adapters/ios.js';
export { analyzePage, describeNodes, formatPage } from './core/perception.js';
export type { PageAnalysis, NodeSemantics, NodeRole } from './core/perception.js';
export { parseHarmonyTree, parseAndroidTree, parseIOSTree } from './adapters/parsers.js';
export { OcrEngine } from './core/ocr.js';
export type { OcrMode, OcrProvider, OcrText, OcrResult } from './core/ocr.js';
export { MacVisionOcr } from './adapters/ocr-macos.js';
export { PortableOcr } from './adapters/ocr-portable.js';
export { compactModelData, compactModelText, modelContent } from './core/presentation.js';
export { ExactTargetResolver, targetSelectorSchema } from './core/targets.js';
export type {
  TargetSelector,
  TargetCandidate,
  TargetResolution,
  TargetResolver,
} from './core/targets.js';
export { resolveTapPlan } from './core/planning.js';
export { settleParallel } from './core/parallel.js';
export { waitUntil, waitRequestSchema } from './core/wait.js';
export type { WaitRequest } from './core/wait.js';
export type { FollowUp } from './core/schema.js';
export { createPhoneTools } from './tools.js';
export { PhoneToolCatalog } from './core/tool-catalog.js';
export type { PhoneTool, ToolContext } from './core/tool-catalog.js';
