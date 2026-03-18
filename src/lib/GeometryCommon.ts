export interface GeometryLayerPayload {
	layerKey: string;
	layer: number;
	datatype: number;
	layerType: string;
	lypTransparent: boolean;
	lypOutline: boolean;
	lypDitherPattern?: string;
	lypWidth?: number;
	lypXfill?: boolean;
	defaultVisible: boolean;
	color: string;
	opacity: number;
	isTransparent: boolean;
	renderOrder: number;
	polygonOffsetFactor: number;
	polygonOffsetUnits: number;
	positions: Float32Array;
	normals: Float32Array;
	indices: Uint32Array;
}

export function getUnitScale(units: string): number {
	switch (units) {
		case "nm":
			return 0.001;
		case "mm":
			return 1000;
		case "um":
		default:
			return 1;
	}
}

export function generateLayerColor(layer: number, datatype: number): string {
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

export function getDefaultThicknessForType(
	type: string,
	defaultThickness: number,
): number {
	switch (type) {
		case "well":
			return defaultThickness * 2;
		case "active":
		case "poly":
			return defaultThickness * 0.8;
		case "metal":
			return defaultThickness * 1.5;
		case "via":
		case "contact":
			return defaultThickness * 1.2;
		case "heater":
			return defaultThickness * 0.6;
		case "waveguide":
			return defaultThickness * 1.0;
		case "slab":
			return defaultThickness * 0.5;
		case "doping":
			return defaultThickness * 0.3;
		case "cladding":
			return defaultThickness * 3;
		default:
			return defaultThickness;
	}
}
