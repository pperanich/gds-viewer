import { describe, expect, test } from "bun:test";
import { buildDerivedGeometryPayload } from "../src/lib/DerivedGeometryBuilder";
import type {
	BoundingBox,
	Cell,
	DerivedGeometrySchema,
	GDSDocument,
	Point,
	Polygon,
} from "../src/index";
import type { GeometryLayerPayload } from "../src/lib/GeometryCommon";

function makeBox(
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
): BoundingBox {
	return { minX, minY, maxX, maxY };
}

function rectPoints(
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
): Point[] {
	return [
		{ x: minX, y: minY },
		{ x: maxX, y: minY },
		{ x: maxX, y: maxY },
		{ x: minX, y: maxY },
	];
}

function polygon(
	id: string,
	layer: number,
	datatype: number,
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
): Polygon {
	return {
		id,
		layer,
		datatype,
		points: rectPoints(minX, minY, maxX, maxY),
		boundingBox: makeBox(minX, minY, maxX, maxY),
	};
}

function buildDocument(polygons: Polygon[]): GDSDocument {
	const bounds = polygons.reduce<BoundingBox>(
		(acc, poly) => ({
			minX: Math.min(acc.minX, poly.boundingBox.minX),
			minY: Math.min(acc.minY, poly.boundingBox.minY),
			maxX: Math.max(acc.maxX, poly.boundingBox.maxX),
			maxY: Math.max(acc.maxY, poly.boundingBox.maxY),
		}),
		makeBox(
			Number.POSITIVE_INFINITY,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		),
	);
	const cell: Cell = {
		name: "TOP",
		polygons,
		texts: [],
		boundingBox: bounds,
	};

	return {
		name: "test",
		cells: new Map([["TOP", cell]]),
		layers: new Map(),
		topCells: ["TOP"],
		boundingBox: bounds,
		units: {
			database: 1e-6,
			user: 1e-6,
		},
	};
}

function topArea(layer: GeometryLayerPayload): number {
	const positions = layer.positions;
	const indices = layer.indices;
	let area = 0;

	for (let i = 0; i < indices.length; i += 3) {
		const ia = indices[i]! * 3;
		const ib = indices[i + 1]! * 3;
		const ic = indices[i + 2]! * 3;

		const ax = positions[ia]!;
		const ay = positions[ia + 1]!;
		const az = positions[ia + 2]!;
		const bx = positions[ib]!;
		const by = positions[ib + 1]!;
		const bz = positions[ib + 2]!;
		const cx = positions[ic]!;
		const cy = positions[ic + 1]!;
		const cz = positions[ic + 2]!;

		if (Math.abs(az - bz) > 1e-9 || Math.abs(az - cz) > 1e-9) continue;
		const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
		if (cross <= 0) continue;
		area += cross / 2;
	}

	return area;
}

describe("Derived geometry compiler", () => {
	test("through etch stops at stopOn material instead of punching through lower same-material slabs", () => {
		const document = buildDocument([
			polygon("die", 0, 0, 0, 0, 10, 10),
			polygon("m1", 1, 0, 3, 3, 7, 7),
			polygon("via", 2, 0, 3, 3, 7, 7),
		]);

		const schema: DerivedGeometrySchema = {
			format: "gds-viewer-derived-geometry@1",
			cadLayers: {
				DIEAREA: { gds: { layer: 0, datatype: 0 }, role: "die-area" },
				M1: { gds: { layer: 1, datatype: 0 } },
				VIA: { gds: { layer: 2, datatype: 0 } },
			},
			materials: {
				SiO2: { display: { color: "#9ad5ff", opacity: 0.2 } },
				Al: { display: { color: "#cccccc", opacity: 0.8 } },
			},
			process: {
				baseStack: [
					{ id: "BOX", type: "slab", material: "SiO2", thickness: 2 },
				],
				steps: [
					{
						id: "deposit_M1",
						type: "deposit",
						material: "Al",
						thickness: 1,
						pattern: { mask: { cad: "M1" } },
					},
					{
						id: "deposit_ILD",
						type: "deposit",
						material: "SiO2",
						thickness: 3,
					},
					{
						id: "etch_via",
						type: "etch",
						targetMaterial: "SiO2",
						depth: "through",
						stopOn: { material: "Al" },
						mask: { cad: "VIA" },
					},
				],
			},
			outputs: {
				renderSolids: [{ id: "diel", from: { material: "SiO2" } }],
			},
		};

		const result = buildDerivedGeometryPayload(document, schema);
		const box = result.layers.find((layer) => layer.layerKey === "base:BOX");
		const ild = result.layers.find(
			(layer) => layer.layerKey === "step:deposit_ILD",
		);

		expect(box).toBeDefined();
		expect(ild).toBeDefined();
		expect(topArea(box!)).toBeCloseTo(100, 6);
		expect(topArea(ild!)).toBeCloseTo(84, 6);
	});

	test("shared mask refs do not trigger false cycle warnings", () => {
		const document = buildDocument([
			polygon("die", 0, 0, 0, 0, 10, 10),
			polygon("mask", 1, 0, 2, 2, 8, 8),
		]);

		const schema: DerivedGeometrySchema = {
			format: "gds-viewer-derived-geometry@1",
			cadLayers: {
				DIEAREA: { gds: { layer: 0, datatype: 0 }, role: "die-area" },
				MASK: { gds: { layer: 1, datatype: 0 } },
			},
			masks: {
				BASE: { cad: "MASK" },
				COMBINED: { op: "or", args: [{ ref: "BASE" }, { ref: "BASE" }] },
			},
			process: {
				steps: [
					{
						id: "deposit",
						type: "deposit",
						material: "SiO2",
						thickness: 1,
						pattern: { mask: { ref: "COMBINED" } },
					},
				],
			},
			outputs: {
				renderSolids: [{ id: "step-only", from: { steps: ["deposit"] } }],
			},
		};

		const result = buildDerivedGeometryPayload(document, schema);
		expect(
			result.warnings.some((warning) => warning.includes("cycle")),
		).toBeFalse();
		expect(result.layers.length).toBe(1);
	});

	test("step-selected outputs keep etched descendants", () => {
		const document = buildDocument([
			polygon("die", 0, 0, 0, 0, 10, 10),
			polygon("top", 1, 0, 1, 1, 9, 9),
			polygon("etch", 2, 0, 3, 3, 7, 7),
		]);

		const schema: DerivedGeometrySchema = {
			format: "gds-viewer-derived-geometry@1",
			cadLayers: {
				DIEAREA: { gds: { layer: 0, datatype: 0 }, role: "die-area" },
				TOP: { gds: { layer: 1, datatype: 0 } },
				ETCH: { gds: { layer: 2, datatype: 0 } },
			},
			process: {
				steps: [
					{
						id: "deposit_top",
						type: "deposit",
						material: "SiO2",
						thickness: 2,
						pattern: { mask: { cad: "TOP" } },
					},
					{
						id: "trim_top",
						type: "etch",
						targetMaterial: "SiO2",
						depth: 1,
						mask: { cad: "ETCH" },
					},
				],
			},
			outputs: {
				renderSolids: [{ id: "top-only", from: { steps: ["deposit_top"] } }],
			},
		};

		const result = buildDerivedGeometryPayload(document, schema);
		expect(result.layerStack.layers.length).toBe(2);
		expect(
			result.layerStack.layers.some((layer) =>
				(layer.id ?? "").includes("@trim_top"),
			),
		).toBeTrue();
	});

	test("ignored sidewall angles produce an explicit warning", () => {
		const document = buildDocument([
			polygon("die", 0, 0, 0, 0, 10, 10),
			polygon("etch", 1, 0, 2, 2, 8, 8),
		]);

		const schema: DerivedGeometrySchema = {
			format: "gds-viewer-derived-geometry@1",
			cadLayers: {
				DIEAREA: { gds: { layer: 0, datatype: 0 }, role: "die-area" },
				ETCH: { gds: { layer: 1, datatype: 0 } },
			},
			params: {
				WALL: { nominal: 60, units: "deg" },
			},
			process: {
				baseStack: [
					{ id: "BOX", type: "slab", material: "SiO2", thickness: 2 },
				],
				steps: [
					{
						id: "etch_box",
						type: "etch",
						targetMaterial: "SiO2",
						depth: 1,
						sidewallAngleDeg: { ref: "WALL" },
						mask: { cad: "ETCH" },
					},
				],
			},
			outputs: {
				renderSolids: [{ id: "diel", from: { material: "SiO2" } }],
			},
		};

		const result = buildDerivedGeometryPayload(document, schema);
		expect(
			result.warnings.some((warning) => warning.includes("sidewallAngleDeg")),
		).toBeTrue();
	});
});
