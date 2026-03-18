import ClipperLib from "clipper-lib";

export type Ring = Array<[number, number]>;

export interface RegionPolygon {
	outer: Ring;
	holes: Ring[];
}

export type Region = RegionPolygon[];

type IntPoint = { X: number; Y: number };
type Path = IntPoint[];
type Paths = Path[];

// Coordinates throughout the derived-geometry pipeline are in micrometers.
// Scale to integer nanometers for Clipper.
const SCALE = 1000;

function ringArea(ring: Ring): number {
	let area = 0;
	for (let i = 0; i < ring.length; i++) {
		const [x0, y0] = ring[i]!;
		const [x1, y1] = ring[(i + 1) % ring.length]!;
		area += x0 * y1 - x1 * y0;
	}
	return area / 2;
}

function normalizeRing(ring: Ring): Ring {
	if (ring.length > 1) {
		const [x0, y0] = ring[0]!;
		const [x1, y1] = ring[ring.length - 1]!;
		if (Math.abs(x0 - x1) < 1e-12 && Math.abs(y0 - y1) < 1e-12) {
			return ring.slice(0, -1);
		}
	}
	return ring;
}

function ensureOrientation(ring: Ring, clockwise: boolean): Ring {
	const normalized = normalizeRing(ring);
	const area = ringArea(normalized);
	const isClockwise = area < 0;
	if (isClockwise === clockwise) return normalized;
	return [...normalized].reverse();
}

function pointInRing(point: [number, number], ring: Ring): boolean {
	const [x, y] = point;
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i]!;
		const [xj, yj] = ring[j]!;
		const intersect =
			yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-18) + xi;
		if (intersect) inside = !inside;
	}
	return inside;
}

function ringCentroid(ring: Ring): [number, number] {
	let x = 0;
	let y = 0;
	for (const [px, py] of ring) {
		x += px;
		y += py;
	}
	const inv = ring.length > 0 ? 1 / ring.length : 1;
	return [x * inv, y * inv];
}

function pickInteriorPoint(ring: Ring): [number, number] {
	const normalized = normalizeRing(ring);
	if (normalized.length < 3) return [0, 0];

	const centroid = ringCentroid(normalized);
	if (pointInRing(centroid, normalized)) return centroid;

	const eps = 1e-6;
	const maxEdges = Math.min(12, normalized.length);
	for (let i = 0; i < maxEdges; i++) {
		const [x0, y0] = normalized[i]!;
		const [x1, y1] = normalized[(i + 1) % normalized.length]!;
		const mx = (x0 + x1) * 0.5;
		const my = (y0 + y1) * 0.5;
		const dx = x1 - x0;
		const dy = y1 - y0;
		const len = Math.sqrt(dx * dx + dy * dy);
		if (len < 1e-18) continue;
		const nx = dy / len;
		const ny = -dx / len;
		const p1: [number, number] = [mx + nx * eps, my + ny * eps];
		if (pointInRing(p1, normalized)) return p1;
		const p2: [number, number] = [mx - nx * eps, my - ny * eps];
		if (pointInRing(p2, normalized)) return p2;
	}

	return centroid;
}

function toPath(ring: Ring): Path {
	const normalized = normalizeRing(ring);
	const path: Path = [];
	for (const [x, y] of normalized) {
		path.push({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) });
	}
	return path;
}

function fromPath(path: Path): Ring {
	return path.map((p) => [p.X / SCALE, p.Y / SCALE]);
}

function regionToPaths(region: Region): Paths {
	const paths: Paths = [];
	for (const poly of region) {
		if (poly.outer.length >= 3) {
			// ClipperOffset uses orientation to decide inward/outward offsetting for holes.
			paths.push(toPath(ensureOrientation(poly.outer, true)));
		}
		for (const hole of poly.holes) {
			if (hole.length >= 3) {
				paths.push(toPath(ensureOrientation(hole, false)));
			}
		}
	}
	return paths;
}

function pathsToRegion(paths: Paths): Region {
	const rings = paths
		.map((p) => fromPath(p))
		.map((r) => normalizeRing(r))
		.filter((r) => r.length >= 3)
		.map((r) => ensureOrientation(r, false));

	if (rings.length === 0) return [];

	const areas = rings.map((r) => Math.abs(ringArea(r)));
	const order = rings
		.map((_, i) => i)
		.sort((a, b) => (areas[b] ?? 0) - (areas[a] ?? 0));

	const parent = new Array<number>(rings.length).fill(-1);
	for (const idx of order) {
		const ring = rings[idx]!;
		const p = pickInteriorPoint(ring);
		let bestParent = -1;
		let bestArea = Number.POSITIVE_INFINITY;
		for (const j of order) {
			if (j === idx) continue;
			const outer = rings[j]!;
			const aOuter = areas[j] ?? 0;
			const aInner = areas[idx] ?? 0;
			if (aOuter <= aInner) continue;
			if (!pointInRing(p, outer)) continue;
			if (aOuter < bestArea) {
				bestArea = aOuter;
				bestParent = j;
			}
		}
		parent[idx] = bestParent;
	}

	const depth = new Array<number>(rings.length).fill(0);
	for (const idx of order) {
		let d = 0;
		let p: number = parent[idx] ?? -1;
		while (p !== -1) {
			d++;
			p = parent[p] ?? -1;
			if (d > rings.length) break;
		}
		depth[idx] = d;
	}

	const polys: Region = [];
	const polyIndexByRing = new Map<number, number>();
	for (const idx of order) {
		const d = depth[idx] ?? 0;
		if (d % 2 === 0) {
			const outer = ensureOrientation(rings[idx]!, false);
			polyIndexByRing.set(idx, polys.length);
			polys.push({ outer, holes: [] });
		}
	}

	for (const idx of order) {
		const d = depth[idx] ?? 0;
		if (d % 2 !== 1) continue;
		let p: number = parent[idx] ?? -1;
		while (p !== -1 && (depth[p] ?? 0) % 2 !== 0) {
			p = parent[p] ?? -1;
		}
		if (p === -1) continue;
		const polyIndex = polyIndexByRing.get(p);
		if (polyIndex === undefined) continue;
		polys[polyIndex]!.holes.push(ensureOrientation(rings[idx]!, true));
	}

	return polys.filter((p) => p.outer.length >= 3);
}

function executeClip(
	subject: Paths,
	clip: Paths,
	clipType: (typeof ClipperLib)["ClipType"][keyof (typeof ClipperLib)["ClipType"]],
): Paths {
	const c = new ClipperLib.Clipper();
	c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
	c.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
	const solution: Paths = new ClipperLib.Paths();
	c.Execute(
		clipType,
		solution,
		ClipperLib.PolyFillType.pftEvenOdd,
		ClipperLib.PolyFillType.pftEvenOdd,
	);
	return solution;
}

function executeUnion(paths: Paths): Paths {
	const c = new ClipperLib.Clipper();
	c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
	const solution: Paths = new ClipperLib.Paths();
	c.Execute(
		ClipperLib.ClipType.ctUnion,
		solution,
		ClipperLib.PolyFillType.pftEvenOdd,
		ClipperLib.PolyFillType.pftEvenOdd,
	);
	return solution;
}

export function isEmpty(region: Region): boolean {
	for (const poly of region) {
		if (poly.outer.length >= 3) return false;
	}
	return true;
}

export function fromRings(rings: Ring[]): Region {
	const region: Region = rings
		.map((r) => normalizeRing(r))
		.filter((r) => r.length >= 3)
		.map((outer) => ({ outer: ensureOrientation(outer, false), holes: [] }));
	const unioned = executeUnion(regionToPaths(region));
	return pathsToRegion(unioned);
}

export function union(a: Region, b: Region): Region {
	const out = executeClip(
		regionToPaths(a),
		regionToPaths(b),
		ClipperLib.ClipType.ctUnion,
	);
	return pathsToRegion(out);
}

export function intersect(a: Region, b: Region): Region {
	const out = executeClip(
		regionToPaths(a),
		regionToPaths(b),
		ClipperLib.ClipType.ctIntersection,
	);
	return pathsToRegion(out);
}

export function difference(a: Region, b: Region): Region {
	const out = executeClip(
		regionToPaths(a),
		regionToPaths(b),
		ClipperLib.ClipType.ctDifference,
	);
	return pathsToRegion(out);
}

export function unionMany(regions: Region[]): Region {
	const all: Paths = [];
	for (const r of regions) all.push(...regionToPaths(r));
	if (all.length === 0) return [];
	return pathsToRegion(executeUnion(all));
}

export function buffer(region: Region, deltaUm: number): Region {
	if (deltaUm === 0) return region;
	if (isEmpty(region)) return region;

	const delta = Math.round(deltaUm * SCALE);
	const co = new ClipperLib.ClipperOffset(2, 0.25 * SCALE);
	const paths = regionToPaths(region);
	co.AddPaths(
		paths,
		ClipperLib.JoinType.jtMiter,
		ClipperLib.EndType.etClosedPolygon,
	);
	const solution: Paths = new ClipperLib.Paths();
	co.Execute(solution, delta);
	return pathsToRegion(executeUnion(solution));
}

// Backwards-compat alias (was an approximation before the Clipper implementation landed).
export function bufferApprox(region: Region, delta: number): Region {
	return buffer(region, delta);
}
