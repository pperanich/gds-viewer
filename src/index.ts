export { GdsViewer } from "./lib/GdsViewer";
export { parseGDSII } from "./lib/GDSParser";
export { buildGeometry, buildGeometryAsync } from "./lib/GeometryBuilder";
export {
  classifyLayer,
  shouldRenderLayer,
  parseLayerName,
  getTypeColor,
} from "./lib/LayerClassifier";
export type { LayerType, LayerClassification } from "./lib/LayerClassifier";
export {
  parseLypFile,
  lypToLayerStack,
  loadLypFromUrl,
  loadLypFromFile,
} from "./lib/LypParser";
export {
  derivedGeometryToLayerStack,
  isDerivedGeometrySchema,
} from "./lib/DerivedGeometry";
export { buildDerivedModel } from "./lib/DerivedGeometryModel";
export { processStackToLayerStack } from "./lib/ProcessStack";
export {
  loadLypFromUrlInWorker,
  loadLypFromFileInWorker,
  parseLypFileInWorker,
} from "./lib/LypWorkerClient";
export type { LypLayerProperties, LypParseResult } from "./lib/LypParser";
export type {
  GDSDocument,
  Cell,
  Polygon,
  Layer,
  Point,
  BoundingBox,
  LayerStackConfig,
  LayerStackEntry,
  ProcessStackConfig,
  ProcessStackLayer,
  DerivedGeometrySchema,
  DerivedGeometryCadLayer,
  DerivedGeometryMaterial,
  DerivedGeometryParam,
  DerivedGeometryMask,
  DerivedGeometryMaskRef,
  DerivedGeometryAlignmentRule,
  DerivedGeometryProcessStep,
  DerivedGeometryOutputs,
} from "./types/gds";
