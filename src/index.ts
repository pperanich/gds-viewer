export { GdsViewer } from "./lib/GdsViewer";
export { parseGDSII } from "./lib/GDSParser";
export { buildGeometry } from "./lib/GeometryBuilder";
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
} from "./types/gds";
