// Web Worker for parsing GDS files off the main thread
import { parseGDS, RecordType, GDSParseError } from "gdsii";
import type {
	BoundingBox,
	Cell,
	GDSDocument,
	Layer,
	LayerStackConfig,
	Point,
	Polygon,
	TextElement,
} from "../types/gds";
import { pathToPolygon } from "./pathToPolygon";
import {
	buildGeometryPayload,
	createDefaultLayerStack,
	type GeometryPayloadBuildOptions,
} from "./GeometryPayloadBuilder";

const BGNEXTN = 12291;
const ENDEXTN = 12547;

let polygonIdCounter = 0;
function generateId(): string {
	return `poly_${++polygonIdCounter}`;
}

function generateLayerColor(layer: number, datatype: number): string {
	const hue = (layer * 137 + datatype * 53) % 360;
	const saturation = 70;
	const lightness = 60;

	const h = hue / 360;
	const s = saturation / 100;
	const l = lightness / 100;

	const hue2rgb = (p: number, q: number, t: number) => {
		if (t < 0) t += 1;
		if (t > 1) t -= 1;
		if (t < 1 / 6) return p + (q - p) * 6 * t;
		if (t < 1 / 2) return q;
		if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
		return p;
	};

	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;

	const r = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
	const g = Math.round(hue2rgb(p, q, h) * 255);
	const b = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);

	return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function calculateBoundingBox(points: Point[]): BoundingBox {
	if (points.length === 0 || !points[0]) {
		return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
	}

	let minX = points[0].x;
	let minY = points[0].y;
	let maxX = points[0].x;
	let maxY = points[0].y;

	for (const point of points) {
		if (!point) continue;
		minX = Math.min(minX, point.x);
		minY = Math.min(minY, point.y);
		maxX = Math.max(maxX, point.x);
		maxY = Math.max(maxY, point.y);
	}

	return { minX, minY, maxX, maxY };
}

function trimTrailingPadding(buffer: ArrayBuffer): ArrayBuffer {
	const uint8Array = new Uint8Array(buffer);
	if (uint8Array.length < 4) return buffer;

	if (
		uint8Array[uint8Array.length - 4] === 0x00 &&
		uint8Array[uint8Array.length - 3] === 0x04 &&
		uint8Array[uint8Array.length - 2] === 0x04 &&
		uint8Array[uint8Array.length - 1] === 0x00
	) {
		return buffer;
	}

	let endLibIndex = -1;
	for (let i = uint8Array.length - 4; i >= 0; i--) {
		if (
			uint8Array[i] === 0x00 &&
			uint8Array[i + 1] === 0x04 &&
			uint8Array[i + 2] === 0x04 &&
			uint8Array[i + 3] === 0x00
		) {
			endLibIndex = i;
			break;
		}
	}

	if (endLibIndex !== -1 && endLibIndex + 4 < uint8Array.length) {
		return buffer.slice(0, endLibIndex + 4);
	}

	return buffer;
}

function* parseGDSWithDeprecatedRecords(
	fileData: Uint8Array,
): Generator<{ tag: number; data: unknown }, void, unknown> {
	const dataView = new DataView(
		fileData.buffer,
		fileData.byteOffset,
		fileData.byteLength,
	);
	let offset = 0;

	while (offset < fileData.length) {
		if (offset + 4 > fileData.length) break;

		const recordLength = dataView.getUint16(offset, false);
		const tag = dataView.getUint16(offset + 2, false);

		if (recordLength < 4) break;

		const dataLength = recordLength - 4;

		if (tag === BGNEXTN || tag === ENDEXTN) {
			const value =
				dataLength === 4 ? dataView.getInt32(offset + 4, false) : null;
			yield { tag, data: value };
			offset += recordLength;
			continue;
		}

		let data: unknown = null;

		switch (tag) {
			case RecordType.HEADER:
				if (dataLength === 2) {
					data = { version: dataView.getInt16(offset + 4, false) };
				}
				break;

			case RecordType.LIBNAME:
			case RecordType.STRNAME:
			case RecordType.SNAME:
			case RecordType.STRING: {
				let len = dataLength;
				if (len > 0 && dataView.getUint8(offset + 4 + len - 1) === 0) len--;
				const textDecoder = new TextDecoder();
				data = textDecoder.decode(
					new Uint8Array(
						fileData.buffer,
						fileData.byteOffset + offset + 4,
						len,
					),
				);
				break;
			}

			case RecordType.LAYER:
			case RecordType.DATATYPE:
			case RecordType.TEXTTYPE:
			case RecordType.PATHTYPE:
			case RecordType.STRANS:
			case RecordType.PRESENTATION:
				if (dataLength === 2) {
					data = dataView.getInt16(offset + 4, false);
				}
				break;

			case RecordType.WIDTH:
				if (dataLength === 4) {
					data = dataView.getInt32(offset + 4, false);
				}
				break;

			case RecordType.XY:
				if (dataLength % 8 === 0) {
					const xy = new Array(dataLength / 8);
					for (let i = 0; i < dataLength; i += 8) {
						xy[i / 8] = [
							dataView.getInt32(offset + 4 + i, false),
							dataView.getInt32(offset + 4 + i + 4, false),
						];
					}
					data = xy;
				}
				break;

			case RecordType.MAG:
			case RecordType.ANGLE:
				if (dataLength === 8) {
					data = parseReal8(dataView, offset + 4);
				}
				break;

			case RecordType.UNITS:
				if (dataLength === 16) {
					data = {
						userUnit: parseReal8(dataView, offset + 4),
						metersPerUnit: parseReal8(dataView, offset + 12),
					};
				}
				break;

			case RecordType.BGNLIB:
			case RecordType.BGNSTR:
				data = null;
				break;

			case RecordType.ENDLIB:
			case RecordType.ENDSTR:
			case RecordType.BOUNDARY:
			case RecordType.PATH:
			case RecordType.SREF:
			case RecordType.AREF:
			case RecordType.TEXT:
			case RecordType.ENDEL:
			case RecordType.BOX:
				data = null;
				break;

			default:
				data = null;
		}

		yield { tag, data };
		offset += recordLength;
	}
}

function parseReal8(dataView: DataView, offset: number): number {
	if (dataView.getUint32(offset) === 0) return 0;
	const sign = dataView.getUint8(offset) & 0x80 ? -1 : 1;
	const exponent = (dataView.getUint8(offset) & 0x7f) - 64;
	let base = 0;
	for (let i = 1; i < 7; i++) {
		const byte = dataView.getUint8(offset + i);
		for (let bit = 0; bit < 8; bit++) {
			if (byte & (1 << (7 - bit))) {
				base += 2 ** (7 - bit - i * 8);
			}
		}
	}
	return base * sign * 16 ** exponent;
}

function reportProgress(
	progress: number,
	message: string,
	phase: string = "parsing-gds",
) {
	self.postMessage({ type: "progress", progress, message, phase });
}

function parseGDSII(fileBuffer: ArrayBuffer): GDSDocument {
	reportProgress(10, "Preparing file data...");

	const trimmedBuffer = trimTrailingPadding(fileBuffer);
	const fileData = new Uint8Array(trimmedBuffer);

	reportProgress(20, "Parsing GDSII records...");

	let records: Array<{ tag: number; data: unknown }> = [];

	try {
		for (const record of parseGDS(fileData)) {
			records.push(record);
		}
	} catch (error) {
		if (
			error instanceof GDSParseError &&
			error.message.includes("Unknown record type")
		) {
			records = [];
			for (const record of parseGDSWithDeprecatedRecords(fileData)) {
				records.push(record);
			}
		} else if (error instanceof GDSParseError) {
			throw new Error(`GDSII parsing failed: ${error.message}`);
		} else {
			throw error;
		}
	}

	if (records.length === 0) {
		throw new Error("No valid GDSII records found");
	}

	reportProgress(40, "Building document structure...");

	const document = buildGDSDocument(records);

	reportProgress(100, "Parsing complete!");
	return document;
}

function buildGDSDocument(
	records: Array<{ tag: number; data: unknown }>,
): GDSDocument {
	const cells = new Map<string, Cell>();
	const layers = new Map<string, Layer>();
	let libraryName = "Untitled";
	let units = { database: 1e-9, user: 1e-6 };

	let currentCell: Cell | null = null;
	let currentPolygon: Partial<Polygon> | null = null;
	let currentLayer = 0;
	let currentDatatype = 0;

	let currentPath: Partial<{
		id: string;
		points: Point[];
		layer: number;
		datatype: number;
		width: number;
		pathtype: number;
	}> | null = null;
	let currentPathWidth = 0;
	let currentPathType = 0;

	let currentBox: Partial<{
		id: string;
		points: Point[];
		layer: number;
		datatype: number;
	}> | null = null;

	let currentText: Partial<{
		id: string;
		position: Point;
		layer: number;
		texttype: number;
		width: number;
		mag: number;
		string: string;
	}> | null = null;

	const totalRecords = records.length;
	let lastProgressUpdate = 0;

	for (let i = 0; i < totalRecords; i++) {
		const record = records[i];
		if (!record) continue;

		const { tag, data } = record;

		if (i - lastProgressUpdate > totalRecords / 20) {
			const progress = 40 + Math.floor((i / totalRecords) * 50);
			reportProgress(
				progress,
				`Processing records... ${Math.floor((i / totalRecords) * 100)}%`,
			);
			lastProgressUpdate = i;
		}

		switch (tag) {
			case RecordType.LIBNAME:
				libraryName = data as string;
				break;

			case RecordType.UNITS:
				if (
					data &&
					typeof data === "object" &&
					"userUnit" in data &&
					"metersPerUnit" in data
				) {
					const unitsData = data as { userUnit: number; metersPerUnit: number };
					units = {
						database: unitsData.metersPerUnit,
						user: unitsData.userUnit,
					};
				}
				break;

			case RecordType.BGNSTR:
				currentCell = {
					name: "",
					polygons: [],
					texts: [],
					boundingBox: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
				};
				break;

			case RecordType.STRNAME:
				if (currentCell) {
					currentCell.name = data as string;
				}
				break;

			case RecordType.ENDSTR:
				if (currentCell?.name) {
					currentCell.boundingBox = calculateCellBoundingBox(currentCell);
					cells.set(currentCell.name, currentCell);
				}
				currentCell = null;
				break;

			case RecordType.BOUNDARY:
				currentPolygon = {
					id: generateId(),
					points: [],
				};
				break;

			case RecordType.PATH:
				currentPath = {
					id: generateId(),
					points: [],
				};
				break;

			case RecordType.BOX:
				currentBox = {
					id: generateId(),
					points: [],
				};
				break;

			case RecordType.TEXT:
				currentText = {
					id: generateId(),
					position: { x: 0, y: 0 },
				};
				break;

			case RecordType.LAYER:
				currentLayer = data as number;
				if (currentPolygon) currentPolygon.layer = currentLayer;
				if (currentPath) currentPath.layer = currentLayer;
				if (currentBox) currentBox.layer = currentLayer;
				if (currentText) currentText.layer = currentLayer;
				break;

			case RecordType.DATATYPE:
				currentDatatype = data as number;
				if (currentPolygon) currentPolygon.datatype = currentDatatype;
				if (currentPath) currentPath.datatype = currentDatatype;
				if (currentBox) currentBox.datatype = currentDatatype;
				break;

			case RecordType.TEXTTYPE:
				if (currentText) currentText.texttype = data as number;
				break;

			case RecordType.WIDTH:
				currentPathWidth = data as number;
				if (currentPath) currentPath.width = currentPathWidth;
				if (currentText) currentText.width = data as number;
				break;

			case RecordType.MAG:
				if (currentText) currentText.mag = data as number;
				break;

			case RecordType.PATHTYPE:
				currentPathType = data as number;
				if (currentPath) currentPath.pathtype = currentPathType;
				break;

			case RecordType.STRING:
				if (currentText && typeof data === "string") {
					currentText.string = data;
				}
				break;

			case RecordType.XY:
				if (currentPolygon && Array.isArray(data)) {
					const points: Point[] = [];
					for (const coord of data) {
						if (Array.isArray(coord) && coord.length >= 2) {
							points.push({ x: coord[0] as number, y: coord[1] as number });
						}
					}
					currentPolygon.points = points;
					currentPolygon.boundingBox = calculateBoundingBox(points);
				} else if (currentPath && Array.isArray(data)) {
					const points: Point[] = [];
					for (const coord of data) {
						if (Array.isArray(coord) && coord.length >= 2) {
							points.push({ x: coord[0] as number, y: coord[1] as number });
						}
					}
					currentPath.points = points;
				} else if (currentBox && Array.isArray(data)) {
					const points: Point[] = [];
					for (const coord of data) {
						if (Array.isArray(coord) && coord.length >= 2) {
							points.push({ x: coord[0] as number, y: coord[1] as number });
						}
					}
					currentBox.points = points;
				} else if (currentText && Array.isArray(data) && data.length > 0) {
					const coord = data[0];
					if (Array.isArray(coord) && coord.length >= 2) {
						currentText.position = {
							x: coord[0] as number,
							y: coord[1] as number,
						};
					}
				}
				break;

			case RecordType.ENDEL:
				if (currentPolygon && currentCell && currentPolygon.points) {
					if (currentPolygon.layer === undefined) {
						currentPolygon.layer = currentLayer || 0;
					}
					if (currentPolygon.datatype === undefined) {
						currentPolygon.datatype = currentDatatype || 0;
					}

					const uniquePoints = new Set(
						currentPolygon.points.map((p) => `${p.x},${p.y}`),
					);

					if (uniquePoints.size >= 3) {
						currentCell.polygons.push(currentPolygon as Polygon);
						addLayer(layers, currentPolygon.layer, currentPolygon.datatype);
					}
					currentPolygon = null;
				} else if (currentPath && currentCell && currentPath.points) {
					if (currentPath.layer === undefined)
						currentPath.layer = currentLayer || 0;
					if (currentPath.datatype === undefined)
						currentPath.datatype = currentDatatype || 0;
					if (currentPath.width === undefined)
						currentPath.width = currentPathWidth || 0;
					if (currentPath.pathtype === undefined)
						currentPath.pathtype = currentPathType || 0;

					const polygonPoints = pathToPolygon(
						currentPath.points,
						currentPath.width,
						currentPath.pathtype,
					);

					if (polygonPoints.length >= 3) {
						const polygon: Polygon = {
							id: currentPath.id!,
							points: polygonPoints,
							layer: currentPath.layer,
							datatype: currentPath.datatype,
							boundingBox: calculateBoundingBox(polygonPoints),
						};
						currentCell.polygons.push(polygon);
						addLayer(layers, polygon.layer, polygon.datatype);
					}
					currentPath = null;
				} else if (currentBox && currentCell && currentBox.points) {
					if (currentBox.layer === undefined)
						currentBox.layer = currentLayer || 0;
					if (currentBox.datatype === undefined)
						currentBox.datatype = currentDatatype || 0;

					const uniquePoints = new Set(
						currentBox.points.map((p) => `${p.x},${p.y}`),
					);

					if (uniquePoints.size >= 3) {
						const polygon: Polygon = {
							id: currentBox.id!,
							points: currentBox.points,
							layer: currentBox.layer,
							datatype: currentBox.datatype,
							boundingBox: calculateBoundingBox(currentBox.points),
						};
						currentCell.polygons.push(polygon);
						addLayer(layers, polygon.layer, polygon.datatype);
					}
					currentBox = null;
				} else if (currentText && currentCell && currentText.position) {
					if (currentText.layer === undefined)
						currentText.layer = currentLayer || 0;
					if (currentText.texttype === undefined) currentText.texttype = 0;

					const textElement: TextElement = {
						id: currentText.id!,
						layer: currentText.layer,
						texttype: currentText.texttype,
						position: currentText.position,
						string: currentText.string || "",
						width: currentText.width,
						mag: currentText.mag,
					};
					currentCell.texts.push(textElement);
					addLayer(layers, textElement.layer, textElement.texttype);
					currentText = null;
				}
				break;
		}
	}

	const allCellNames = new Set(cells.keys());
	const topCells = Array.from(allCellNames);

	let globalMinX = Number.POSITIVE_INFINITY;
	let globalMinY = Number.POSITIVE_INFINITY;
	let globalMaxX = Number.NEGATIVE_INFINITY;
	let globalMaxY = Number.NEGATIVE_INFINITY;

	for (const cellName of topCells) {
		const cell = cells.get(cellName);
		if (cell) {
			globalMinX = Math.min(globalMinX, cell.boundingBox.minX);
			globalMinY = Math.min(globalMinY, cell.boundingBox.minY);
			globalMaxX = Math.max(globalMaxX, cell.boundingBox.maxX);
			globalMaxY = Math.max(globalMaxY, cell.boundingBox.maxY);
		}
	}

	return {
		name: libraryName,
		cells,
		layers,
		topCells,
		boundingBox: {
			minX: globalMinX === Number.POSITIVE_INFINITY ? 0 : globalMinX,
			minY: globalMinY === Number.POSITIVE_INFINITY ? 0 : globalMinY,
			maxX: globalMaxX === Number.NEGATIVE_INFINITY ? 0 : globalMaxX,
			maxY: globalMaxY === Number.NEGATIVE_INFINITY ? 0 : globalMaxY,
		},
		units,
	};
}

function calculateCellBoundingBox(cell: Cell): BoundingBox {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;

	for (const polygon of cell.polygons) {
		minX = Math.min(minX, polygon.boundingBox.minX);
		minY = Math.min(minY, polygon.boundingBox.minY);
		maxX = Math.max(maxX, polygon.boundingBox.maxX);
		maxY = Math.max(maxY, polygon.boundingBox.maxY);
	}

	return {
		minX: minX === Number.POSITIVE_INFINITY ? 0 : minX,
		minY: minY === Number.POSITIVE_INFINITY ? 0 : minY,
		maxX: maxX === Number.NEGATIVE_INFINITY ? 0 : maxX,
		maxY: maxY === Number.NEGATIVE_INFINITY ? 0 : maxY,
	};
}

function addLayer(
	layers: Map<string, Layer>,
	layer: number,
	datatype: number,
): void {
	const key = `${layer}:${datatype}`;
	if (!layers.has(key)) {
		layers.set(key, {
			layer,
			datatype,
			name: `Layer ${layer}/${datatype}`,
			color: generateLayerColor(layer, datatype),
			visible: true,
		});
	}
}

// Convert Maps to serializable format for postMessage
function serializeDocument(doc: GDSDocument): unknown {
	return {
		name: doc.name,
		cells: Array.from(doc.cells.entries()),
		layers: Array.from(doc.layers.entries()),
		topCells: doc.topCells,
		boundingBox: doc.boundingBox,
		units: doc.units,
	};
}

function createDocumentMetadata(doc: GDSDocument) {
	const texts: TextElement[] = [];
	for (const cell of doc.cells.values()) {
		texts.push(...cell.texts);
	}

	return {
		name: doc.name,
		layers: Array.from(doc.layers.entries()),
		topCells: doc.topCells,
		boundingBox: doc.boundingBox,
		units: doc.units,
		texts,
	};
}

// Handle messages from main thread
self.onmessage = (e: MessageEvent) => {
	const { type, buffer, layerStack, options } = e.data as {
		type: string;
		buffer: ArrayBuffer;
		layerStack?: LayerStackConfig | null;
		options?: GeometryPayloadBuildOptions;
	};

	if (type === "parse") {
		try {
			const document = parseGDSII(buffer);
			self.postMessage({
				type: "complete",
				document: serializeDocument(document),
			});
		} catch (error) {
			self.postMessage({ type: "error", error: (error as Error).message });
		}
		return;
	}

	if (type === "parse-and-build") {
		try {
			const document = parseGDSII(buffer);
			const effectiveLayerStack =
				layerStack ?? createDefaultLayerStack(document);
			reportProgress(55, "Building geometry payloads...", "building-geometry");
			const result = buildGeometryPayload(document, effectiveLayerStack, {
				...options,
				progressBase: 55,
				progressSpan: 40,
				onProgress: (progress, message, phase) =>
					reportProgress(progress, message, phase ?? "building-geometry"),
			});

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
					type: "complete-build",
					metadata: createDocumentMetadata(document),
					layerStack: result.layerStack,
					layers: result.layers,
					stats: result.stats,
					renderEntries: result.renderEntries,
					buildableRenderKeys: result.buildableRenderKeys,
					deferredRenderKeys: result.deferredRenderKeys,
				},
				transferables,
			);
		} catch (error) {
			self.postMessage({ type: "error", error: (error as Error).message });
		}
	}
};
