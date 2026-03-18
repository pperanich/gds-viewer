/**
 * Layer Classification System
 *
 * Supports common photonics and CMOS PDK layer naming conventions.
 */

export type LayerType =
	| "waveguide"
	| "slab"
	| "metal"
	| "via"
	| "contact"
	| "heater"
	| "doping"
	| "well"
	| "active"
	| "poly"
	| "trench"
	| "cladding"
	| "resistor"
	| "capacitor"
	| "diode"
	| "annotation"
	| "boundary"
	| "simulation"
	| "unknown";

export interface LayerClassification {
	type: LayerType;
	isAnnotation: boolean;
	defaultVisible: boolean;
	defaultOpacity: number;
	/** Suggested z-order for rendering (higher = on top) */
	zOrder: number;
}

/**
 * Datatypes that indicate non-drawing purposes
 * Based on PDK analysis:
 * - 0: drawing (main geometry)
 * - 1: label
 * - 2: pin
 * - 3: net/slot
 * - 4: boundary/dummy
 * - 5: marker/block
 * - 10: label
 * - 11: pin alternate
 * - 12: pin alternate
 * - 16: pin
 * - 25: text
 */
const ANNOTATION_DATATYPES = new Set([1, 2, 3, 4, 5, 10, 11, 12, 16, 25]);

/**
 * Datatypes that specifically indicate drawing/geometry (not annotations)
 * - 0: standard drawing
 * - 20: drawing
 * - 44: drawing alternate
 */
const DRAWING_DATATYPES = new Set([0, 20, 44]);

/**
 * Layer numbers commonly used for annotations/markers
 */
const ANNOTATION_LAYER_NUMBERS: Record<number, string> = {
	64: "FLOORPLAN",
	66: "TEXT",
	68: "DEVREC",
	69: "ERRORS",
	99: "FLOORPLAN",
	100: "LABEL_SETTINGS",
	101: "MONITOR",
	110: "SOURCE",
	202: "LABEL_SETTINGS",
	203: "TE",
	204: "TM",
	205: "DRC_MARKER",
	206: "LABEL_INSTANCE",
	207: "ERROR_MARKER",
	999: "WAFER",
};

// ============================================================================
// Name Pattern Definitions
// ============================================================================

const ANNOTATION_NAME_PATTERNS = [
	/^PORT/i,
	/^LABEL/i,
	/^TEXT/i,
	/^DEVREC/i,
	/^PINREC/i,
	/^FLOORPLAN/i,
	/^DRC/i,
	/^MARKER/i,
	/^SOURCE/i,
	/^MONITOR/i,
	/SHOW_PORTS/i,
	/PIN$/i,
	/_pin$/i,
	/_label$/i,
	/label$/i,
	/pin_m$/i,
	/label_m$/i,
	/^SIM_REGION/i,
	/^ERROR/i,
];

const BOUNDARY_NAME_PATTERNS = [
	/^PR_BNDRY/i,
	/^BOUNDARY/i,
	/boundary$/i,
	/boundary_m$/i,
	/^BBOX/i,
	/^DIEAREA/i,
	/^FRAME$/i,
	/^DEVREC$/i,
	/^WAFER$/i,
];

// Photonics patterns
const WAVEGUIDE_NAME_PATTERNS = [
	/^WG$/i,
	/^WG_/i,
	/^WAVEGUIDE/i,
	/^CORE$/i,
	/^GRA$/i,
	/^GRATING/i,
	/^RIB$/i,
	/^LN\d?$/i,
];

const SLAB_NAME_PATTERNS = [/^SLAB/i, /SHALLOW/i, /DEEP.*ETCH/i, /^PARTIAL/i];

const HEATER_NAME_PATTERNS = [
	/HEATER/i,
	/^MH$/i,
	/^TIN/i,
	/^M1_HEATER/i,
	/^M2_HEATER/i,
	/^HR$/i,
];

const TRENCH_NAME_PATTERNS = [
	/TRENCH/i,
	/UNDERCUT/i,
	/DEEPTRENCH/i,
	/^OXIDE_ETCH/i,
];

const CLADDING_NAME_PATTERNS = [
	/CLAD/i,
	/^BOX$/i,
	/^OXIDE$/i,
	/^XS_BOX/i,
	/^XS_OX/i,
];

// CMOS patterns
const WELL_NAME_PATTERNS = [
	/^NWELL/i,
	/^PWELL/i,
	/^DNWELL/i,
	/^LPWELL/i,
	/^WELL/i,
	/nwelldrawing/i,
	/pwelldrawing/i,
	/^nBuLay/i,
];

const ACTIVE_NAME_PATTERNS = [
	/^COMP$/i,
	/^COMP_/i,
	/^DIFF$/i,
	/^DIFF_/i,
	/^ACTIV/i,
	/^TAP$/i,
	/^TAP_/i,
	/diffdrawing/i,
	/tapdrawing/i,
];

const POLY_NAME_PATTERNS = [
	/^POLY/i,
	/^GATPOLY/i,
	/^GATE$/i,
	/polydrawing/i,
	/polygate/i,
	/^GatPoly/i,
];

const CONTACT_NAME_PATTERNS = [
	/^CONT$/i,
	/^CONT_/i,
	/^CONTACT$/i,
	/^LICON/i,
	/^MCON/i, // metal contact
	/^NPC$/i, // n+ poly contact
	/Contdrawing/i,
];

const VIA_NAME_PATTERNS = [
	/^VIA\d?$/i,
	/^VIA\d?_/i,
	/^VIAC/i,
	/^MVIA$/i,
	/viadrawing/i,
	/via\ddrawing/i,
];

const METAL_NAME_PATTERNS = [
	/^M\d$/i,
	/^M\d_/i,
	/^METAL\d?$/i,
	/^METAL\d?_/i,
	/^MET\d$/i,
	/^PAD$/i,
	/^MTOP/i,
	/^METALTOP/i,
	/ROUTER/i,
	/^LI\d?$/i,
	/^LI\d?_/i,
	/Metal\ddrawing/i,
	/met\ddrawing/i,
	/li\ddrawing/i,
];

const DOPING_NAME_PATTERNS = [
	/^N$/i,
	/^P$/i,
	/^NP$/i,
	/^PP$/i,
	/^NPP$/i,
	/^PPP$/i,
	/^NPLUS$/i,
	/^PPLUS$/i,
	/^NSDM/i,
	/^PSDM/i,
	/^NSD$/i,
	/^PSD$/i,
	/^GEN$/i, // germanium n-doped
	/^GEP$/i, // germanium p-doped
	/IMPLANT/i,
	/^SAB$/i, // salicide block
	/^SALBLOCK/i,
	/^NP_/i,
];

const RESISTOR_NAME_PATTERNS = [
	/^RES$/i,
	/^RESISTOR/i,
	/^POLYRES/i,
	/^FHRES/i,
	/^HVPOLYRS/i,
	/res_mk$/i,
	/res$/i,
	/_res$/i,
];

const CAPACITOR_NAME_PATTERNS = [
	/^CAP$/i,
	/^MIM$/i,
	/^MOS_CAP/i,
	/cap_mk$/i,
	/^CAPACITOR/i,
];

const DIODE_NAME_PATTERNS = [
	/^DIODE/i,
	/^SCHOTTKY/i,
	/^ZENER/i,
	/diode_mk$/i,
	/^MDIODE/i,
	/^WELL_DIODE/i,
];

const SIMULATION_NAME_PATTERNS = [
	/^XS_/i, // cross-section layers
	/^SIM_/i,
	/^LUMERICAL/i,
];

// ============================================================================
// Classification Functions
// ============================================================================

/**
 * Parse layer name to extract the base name from compound formats
 * Handles patterns like:
 * - "WG 3/0" -> "WG"
 * - "met1pin_m 68/16" -> "met1pin"
 * - "Metal1drawing" -> "Metal1drawing"
 */
export function parseLayerName(rawName: string): {
	baseName: string;
	layer?: number;
	datatype?: number;
	purpose?: string;
} {
	if (!rawName) return { baseName: "" };

	// Pattern: "name layer/datatype" (e.g., "WG 3/0")
	const match1 = rawName.match(/^(.+?)\s+(\d+)\/(\d+)$/);
	if (match1) {
		return {
			baseName: match1[1]!.trim(),
			layer: parseInt(match1[2]!, 10),
			datatype: parseInt(match1[3]!, 10),
		};
	}

	// Pattern: "namepurpose_m layer/datatype"
	const match2 = rawName.match(/^(\w+?)([a-z]+)_m\s+(\d+)\/(\d+)$/i);
	if (match2) {
		return {
			baseName: match2[1]!,
			purpose: match2[2],
			layer: parseInt(match2[3]!, 10),
			datatype: parseInt(match2[4]!, 10),
		};
	}

	// Pattern: "name_m layer/datatype"
	const match3 = rawName.match(/^(\w+)_m\s+(\d+)\/(\d+)$/i);
	if (match3) {
		return {
			baseName: match3[1]!,
			layer: parseInt(match3[2]!, 10),
			datatype: parseInt(match3[3]!, 10),
		};
	}

	// Pattern: "CATEGORY_TYPE_OPERATION" (e.g., "WG_RIBS_ADD")
	const match4 = rawName.match(/^(\w+?)_(ADD|SUB|CPY|DF|LF)$/i);
	if (match4) {
		return {
			baseName: match4[1]!,
			purpose: match4[2]!.toLowerCase(),
		};
	}

	// Default: use as-is
	return { baseName: rawName };
}

export function classifyLayer(
	layer: number,
	datatype: number,
	name?: string,
): LayerClassification {
	const parsed = parseLayerName(name ?? "");
	const baseName = parsed.baseName || name;

	// Check for boundary layers first
	if (matchesPatterns(baseName, BOUNDARY_NAME_PATTERNS)) {
		return {
			type: "boundary",
			isAnnotation: true,
			defaultVisible: false,
			defaultOpacity: 0.3,
			zOrder: -100,
		};
	}

	// Check for annotation layers
	if (isAnnotationLayer(layer, datatype, baseName)) {
		return {
			type: "annotation",
			isAnnotation: true,
			defaultVisible: false,
			defaultOpacity: 0.8,
			zOrder: 1000,
		};
	}

	// Check for simulation layers
	if (matchesPatterns(baseName, SIMULATION_NAME_PATTERNS)) {
		return {
			type: "simulation",
			isAnnotation: true,
			defaultVisible: false,
			defaultOpacity: 0.3,
			zOrder: 900,
		};
	}

	const type = determineLayerType(baseName);

	return {
		type,
		isAnnotation: false,
		defaultVisible: getDefaultVisibility(type),
		defaultOpacity: getDefaultOpacity(type),
		zOrder: getDefaultZOrder(type),
	};
}

function isAnnotationLayer(
	layer: number,
	datatype: number,
	name?: string,
): boolean {
	// Drawing datatypes are never annotations by datatype alone
	if (DRAWING_DATATYPES.has(datatype)) {
		// But check name patterns
		if (name && matchesPatterns(name, ANNOTATION_NAME_PATTERNS)) return true;
		if (layer in ANNOTATION_LAYER_NUMBERS) return true;
		return false;
	}

	// Non-drawing datatypes are annotations
	if (ANNOTATION_DATATYPES.has(datatype)) return true;

	// Check layer numbers
	if (layer in ANNOTATION_LAYER_NUMBERS) return true;

	// Check name patterns
	if (name && matchesPatterns(name, ANNOTATION_NAME_PATTERNS)) return true;

	return false;
}

function matchesPatterns(
	value: string | undefined,
	patterns: RegExp[],
): boolean {
	if (!value) return false;
	return patterns.some((p) => p.test(value));
}

function determineLayerType(name?: string): LayerType {
	if (!name) return "unknown";

	// Check in order of specificity (more specific patterns first)

	// CMOS-specific layers
	if (matchesPatterns(name, WELL_NAME_PATTERNS)) return "well";
	if (matchesPatterns(name, ACTIVE_NAME_PATTERNS)) return "active";
	if (matchesPatterns(name, POLY_NAME_PATTERNS)) return "poly";
	if (matchesPatterns(name, CONTACT_NAME_PATTERNS)) return "contact";
	if (matchesPatterns(name, VIA_NAME_PATTERNS)) return "via";
	if (matchesPatterns(name, METAL_NAME_PATTERNS)) return "metal";
	if (matchesPatterns(name, DOPING_NAME_PATTERNS)) return "doping";
	if (matchesPatterns(name, RESISTOR_NAME_PATTERNS)) return "resistor";
	if (matchesPatterns(name, CAPACITOR_NAME_PATTERNS)) return "capacitor";
	if (matchesPatterns(name, DIODE_NAME_PATTERNS)) return "diode";

	// Photonics layers
	if (matchesPatterns(name, HEATER_NAME_PATTERNS)) return "heater";
	if (matchesPatterns(name, WAVEGUIDE_NAME_PATTERNS)) return "waveguide";
	if (matchesPatterns(name, SLAB_NAME_PATTERNS)) return "slab";
	if (matchesPatterns(name, TRENCH_NAME_PATTERNS)) return "trench";
	if (matchesPatterns(name, CLADDING_NAME_PATTERNS)) return "cladding";

	return "unknown";
}

function getDefaultVisibility(type: LayerType): boolean {
	switch (type) {
		case "cladding":
		case "boundary":
		case "simulation":
			return false;
		default:
			return true;
	}
}

function getDefaultOpacity(type: LayerType): number {
	switch (type) {
		case "heater":
		case "via":
		case "contact":
			return 1.0;
		case "waveguide":
		case "poly":
			return 0.9;
		case "slab":
		case "active":
			return 0.7;
		case "metal":
			return 0.6;
		case "well":
			return 0.5;
		case "doping":
		case "resistor":
		case "capacitor":
		case "diode":
			return 0.6;
		case "cladding":
			return 0.3;
		case "trench":
			return 0.5;
		case "boundary":
			return 0.1;
		default:
			return 0.8;
	}
}

/**
 * Get default z-order for layer stacking
 * Higher values render on top
 */
function getDefaultZOrder(type: LayerType): number {
	switch (type) {
		case "well":
			return 0;
		case "active":
			return 10;
		case "poly":
			return 20;
		case "doping":
			return 25;
		case "contact":
			return 30;
		case "waveguide":
			return 35;
		case "slab":
			return 32;
		case "trench":
			return 5;
		case "cladding":
			return -10;
		case "metal":
			return 50; // metals stack on top
		case "via":
			return 45;
		case "heater":
			return 55;
		case "resistor":
		case "capacitor":
		case "diode":
			return 40;
		case "boundary":
			return -100;
		case "simulation":
			return 900;
		case "annotation":
			return 1000;
		default:
			return 30;
	}
}

export function shouldRenderLayer(
	layer: number,
	datatype: number,
	name?: string,
): boolean {
	const classification = classifyLayer(layer, datatype, name);
	return !classification.isAnnotation;
}

/**
 * Get a suggested color for a layer type
 * These are fallback colors when no LYP file is provided
 */
export function getTypeColor(type: LayerType): string {
	switch (type) {
		case "waveguide":
			return "#ff9d9d"; // light red
		case "slab":
			return "#00ffff"; // cyan
		case "metal":
			return "#c0c0c0"; // silver
		case "via":
		case "contact":
			return "#ffffcc"; // light yellow
		case "heater":
			return "#ebc634"; // gold
		case "well":
			return "#00cc66"; // green
		case "active":
			return "#00ff00"; // bright green
		case "poly":
			return "#ff0000"; // red
		case "doping":
			return "#9900e6"; // purple
		case "trench":
			return "#9999cc"; // blue-gray
		case "cladding":
			return "#f3ff80"; // light yellow
		case "resistor":
			return "#1437ff"; // blue
		case "capacitor":
			return "#268c6b"; // teal
		case "diode":
			return "#9f0f89"; // magenta
		case "boundary":
			return "#808080";
		case "simulation":
			return "#f3ff80";
		case "annotation":
			return "#333333";
		default:
			return "#808080"; // gray
	}
}
