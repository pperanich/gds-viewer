import { describe, expect, test } from "bun:test";
import * as PolygonOps from "../src/lib/PolygonOps";

type Ring = PolygonOps.Ring;
type Region = PolygonOps.Region;

function square(x0: number, y0: number, x1: number, y1: number): Ring {
	return [
		[x0, y0],
		[x1, y0],
		[x1, y1],
		[x0, y1],
	];
}

function ringArea(ring: Ring): number {
	let area = 0;
	for (let i = 0; i < ring.length; i++) {
		const [ax, ay] = ring[i]!;
		const [bx, by] = ring[(i + 1) % ring.length]!;
		area += ax * by - bx * ay;
	}
	return area / 2;
}

function regionArea(region: Region): number {
	let a = 0;
	for (const poly of region) {
		a += Math.abs(ringArea(poly.outer));
		for (const hole of poly.holes) a -= Math.abs(ringArea(hole));
	}
	return a;
}

describe("PolygonOps", () => {
	test("union/intersect/difference areas for overlapping squares", () => {
		const a = PolygonOps.fromRings([square(0, 0, 1, 1)]);
		const b = PolygonOps.fromRings([square(0.5, 0.5, 1.5, 1.5)]);

		const u = PolygonOps.union(a, b);
		const i = PolygonOps.intersect(a, b);
		const d = PolygonOps.difference(a, b);

		expect(regionArea(i)).toBeCloseTo(0.25, 6);
		expect(regionArea(u)).toBeCloseTo(1.75, 6);
		expect(regionArea(d)).toBeCloseTo(0.75, 6);
	});

	test("bufferApprox expands area", () => {
		const a = PolygonOps.fromRings([square(0, 0, 1, 1)]);
		const buffered = PolygonOps.bufferApprox(a, 0.2);
		expect(regionArea(buffered)).toBeGreaterThan(regionArea(a));
	});
});
