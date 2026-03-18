import * as THREE from "three";
import { FontLoader, Font } from "three/examples/jsm/loaders/FontLoader.js";
import { TextGeometry } from "three/examples/jsm/geometries/TextGeometry.js";
import type { TextElement, LayerStackEntry } from "../types/gds";
import { classifyLayer } from "./LayerClassifier";

const FONT_URL =
	"https://cdn.jsdelivr.net/npm/three@0.176.0/examples/fonts/helvetiker_regular.typeface.json";

export interface TextRenderOptions {
	dbToUm: number;
	unitScale: number;
	zScale: number;
	documentBounds: { minX: number; maxX: number; minY: number; maxY: number };
}

export interface TextLayerGroup {
	layerKey: string;
	layer: number;
	datatype: number;
	meshes: THREE.Mesh[];
	classification: ReturnType<typeof classifyLayer>;
	entry: LayerStackEntry;
}

export class TextRenderer {
	private font: Font | null = null;
	private fontLoadPromise: Promise<Font> | null = null;
	private fontLoader = new FontLoader();

	async loadFont(): Promise<Font> {
		if (this.font) return this.font;

		if (this.fontLoadPromise) return this.fontLoadPromise;

		this.fontLoadPromise = new Promise((resolve, reject) => {
			this.fontLoader.load(
				FONT_URL,
				(font) => {
					this.font = font;
					resolve(font);
				},
				undefined,
				(error) => {
					console.error("Failed to load font:", error);
					reject(error);
				},
			);
		});

		return this.fontLoadPromise;
	}

	async renderTexts(
		texts: TextElement[],
		layerMap: Map<string, LayerStackEntry>,
		options: TextRenderOptions,
	): Promise<Map<string, TextLayerGroup>> {
		const font = await this.loadFont();
		const { dbToUm, documentBounds } = options;

		const docWidth = (documentBounds.maxX - documentBounds.minX) * dbToUm;
		const docHeight = (documentBounds.maxY - documentBounds.minY) * dbToUm;
		const minDim = Math.min(docWidth, docHeight);
		const baseTextSize = minDim * 0.008;

		const layerGroups = new Map<string, TextLayerGroup>();

		for (const text of texts) {
			if (!text.string || text.string.trim() === "") continue;

			const key = `${text.layer}:${text.texttype}`;
			let group = layerGroups.get(key);

			if (!group) {
				let entry = layerMap.get(key);
				const layerName = entry?.name ?? `Layer ${text.layer}/${text.texttype}`;
				const classification = classifyLayer(
					text.layer,
					text.texttype,
					layerName,
				);

				if (!entry) {
					entry = {
						layer: text.layer,
						datatype: text.texttype,
						name: layerName,
						thickness: 0.05,
						zOffset: classification.zOrder * 0.01,
						color: "#333333",
					};
				}

				group = {
					layerKey: key,
					layer: text.layer,
					datatype: text.texttype,
					meshes: [],
					classification,
					entry,
				};
				layerGroups.set(key, group);
			}

			const mesh = this.createTextMesh(
				text,
				font,
				group.entry,
				baseTextSize,
				options,
			);
			if (mesh) {
				group.meshes.push(mesh);
			}
		}

		return layerGroups;
	}

	private createTextMesh(
		text: TextElement,
		font: Font,
		entry: LayerStackEntry,
		baseTextSize: number,
		options: TextRenderOptions,
	): THREE.Mesh | null {
		const { dbToUm, unitScale, zScale } = options;

		const mag = text.mag && text.mag > 0 ? text.mag : 1;
		const textSize = baseTextSize * mag;

		try {
			const geometry = new TextGeometry(text.string, {
				font,
				size: textSize,
				depth: 0.01,
				curveSegments: 3,
				bevelEnabled: false,
			});

			geometry.computeBoundingBox();

			const color = new THREE.Color(entry.color);
			const material = new THREE.MeshBasicMaterial({
				color,
				side: THREE.DoubleSide,
			});

			const mesh = new THREE.Mesh(geometry, material);

			const x = text.position.x * dbToUm;
			const y = text.position.y * dbToUm;
			const z = entry.zOffset * unitScale * zScale + 0.1;

			mesh.position.set(x, y, z);

			mesh.userData = {
				textElement: text,
				layerKey: `${text.layer}:${text.texttype}`,
				baseScale: 1,
				isTextMesh: true,
			};

			return mesh;
		} catch (error) {
			console.warn(
				`Failed to create text geometry for "${text.string}":`,
				error,
			);
			return null;
		}
	}

	createTextGroup(layerGroups: Map<string, TextLayerGroup>): THREE.Group {
		const root = new THREE.Group();
		root.name = "texts";

		for (const [key, group] of layerGroups) {
			const layerGroup = new THREE.Group();
			layerGroup.name = `text-layer-${key}`;
			layerGroup.userData = {
				layerKey: key,
				layer: group.layer,
				datatype: group.datatype,
				isTextLayer: true,
			};
			layerGroup.visible = group.classification.defaultVisible;

			for (const mesh of group.meshes) {
				layerGroup.add(mesh);
			}

			root.add(layerGroup);
		}

		return root;
	}

	updateTextScales(
		textGroup: THREE.Group,
		camera: THREE.Camera,
		baseViewHeight: number,
		controlsTarget: THREE.Vector3,
	) {
		let currentViewHeight: number;

		if (camera instanceof THREE.OrthographicCamera) {
			currentViewHeight = (camera.top - camera.bottom) / camera.zoom;
		} else if (camera instanceof THREE.PerspectiveCamera) {
			const distance = camera.position.distanceTo(controlsTarget);
			const fovRad = (camera.fov * Math.PI) / 180;
			currentViewHeight = 2 * distance * Math.tan(fovRad / 2);
		} else {
			return;
		}

		const scaleFactor = currentViewHeight / baseViewHeight;

		textGroup.traverse((obj) => {
			if (obj instanceof THREE.Mesh && obj.userData.isTextMesh) {
				obj.scale.setScalar(scaleFactor);
			}
		});
	}
}

export const textRenderer = new TextRenderer();
