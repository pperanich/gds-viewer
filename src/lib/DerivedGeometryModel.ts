import * as THREE from "three";
import DerivedGeometryWorker from "./derivedGeometry.worker.ts?worker&inline";
import { buildGeometryFromPayload } from "./GeometryBuilder";
import { serializeGDSDocument } from "./gdsSerialization";
import {
  buildDerivedGeometryPayload,
  type DerivedGeometryBuildResult,
  type OverlayMode,
} from "./DerivedGeometryBuilder";
import type { DerivedGeometrySchema, GDSDocument, LayerStackConfig } from "../types/gds";

export interface DerivedModelBuildResult {
  group: THREE.Group;
  layerStack: LayerStackConfig;
  uiGroups: Map<string, string>;
  warnings: string[];
}

function toModelResult(result: DerivedGeometryBuildResult): DerivedModelBuildResult {
  return {
    group: buildGeometryFromPayload(result.layers),
    layerStack: result.layerStack,
    uiGroups: result.uiGroups,
    warnings: result.warnings,
  };
}

export function buildDerivedModel(
  document: GDSDocument,
  schema: DerivedGeometrySchema,
  options: { zScale?: number; overlayMode?: OverlayMode } = {},
): DerivedModelBuildResult {
  return toModelResult(buildDerivedGeometryPayload(document, schema, options));
}

export async function buildDerivedModelAsync(
  document: GDSDocument,
  schema: DerivedGeometrySchema,
  options: { zScale?: number; overlayMode?: OverlayMode } = {},
): Promise<DerivedModelBuildResult> {
  if (typeof Worker === "undefined") {
    return buildDerivedModel(document, schema, options);
  }

  return new Promise((resolve) => {
    const worker = new DerivedGeometryWorker();

    worker.onmessage = (event: MessageEvent) => {
      const {
        type,
        layers,
        layerStack,
        uiGroups,
        warnings,
      } = event.data as {
        type: string;
        layers?: DerivedGeometryBuildResult["layers"];
        layerStack?: LayerStackConfig;
        uiGroups?: Array<[string, string]>;
        warnings?: string[];
      };

      if (type === "complete" && layers && layerStack) {
        worker.terminate();
        resolve({
          group: buildGeometryFromPayload(layers),
          layerStack,
          uiGroups: new Map(uiGroups ?? []),
          warnings: warnings ?? [],
        });
      } else if (type === "error") {
        worker.terminate();
        console.warn(
          "Derived geometry worker failed, falling back to main thread:",
          event.data?.error,
        );
        resolve(buildDerivedModel(document, schema, options));
      }
    };

    worker.onerror = (event: ErrorEvent) => {
      worker.terminate();
      console.warn(
        "Derived geometry worker crashed, falling back to main thread:",
        event.message,
      );
      resolve(buildDerivedModel(document, schema, options));
    };

    worker.postMessage({
      type: "build",
      document: serializeGDSDocument(document),
      schema,
      options,
    });
  });
}
