import type { LayerStackConfig } from "../types/gds";
import {
	deserializeGDSDocument,
	type SerializedGDSDocument,
} from "./gdsSerialization";
import {
	buildGeometryPayload,
	type GeometryPayloadBuildOptions,
} from "./GeometryPayloadBuilder";

self.onmessage = (event: MessageEvent) => {
	const { type, document, layerStack, options } = event.data as {
		type: string;
		document: SerializedGDSDocument;
		layerStack: LayerStackConfig;
		options?: GeometryPayloadBuildOptions;
	};

	if (type !== "build") return;

	try {
		const result = buildGeometryPayload(
			deserializeGDSDocument(document),
			layerStack,
			options,
		);

		const transferables: Transferable[] = [];
		for (const payload of result.layers) {
			transferables.push(
				payload.positions.buffer,
				payload.normals.buffer,
				payload.indices.buffer,
			);
		}

		self.postMessage(
			{
				type: "complete",
				layers: result.layers,
				stats: result.stats,
			},
			transferables,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		self.postMessage({ type: "error", error: message });
	}
};
