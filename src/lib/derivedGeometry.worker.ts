import { deserializeGDSDocument, type SerializedGDSDocument } from "./gdsSerialization";
import {
  buildDerivedGeometryPayload,
  type OverlayMode,
} from "./DerivedGeometryBuilder";
import type { DerivedGeometrySchema } from "../types/gds";

self.onmessage = (event: MessageEvent) => {
  const { type, document, schema, options } = event.data as {
    type: string;
    document: SerializedGDSDocument;
    schema: DerivedGeometrySchema;
    options?: { zScale?: number; overlayMode?: OverlayMode };
  };

  if (type !== "build") return;

  try {
    const result = buildDerivedGeometryPayload(
      deserializeGDSDocument(document),
      schema,
      options,
    );

    const transferables: Transferable[] = [];
    for (const layer of result.layers) {
      transferables.push(layer.positions.buffer, layer.normals.buffer, layer.indices.buffer);
    }

    self.postMessage(
      {
        type: "complete",
        layers: result.layers,
        layerStack: result.layerStack,
        uiGroups: Array.from(result.uiGroups.entries()),
        warnings: result.warnings,
      },
      transferables,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    self.postMessage({ type: "error", error: message });
  }
};
