import * as THREE from "three";

const NICE_NUMBERS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

const UNIT_SCALES: { threshold: number; unit: string; divisor: number }[] = [
	{ threshold: 0.001, unit: "nm", divisor: 0.001 },
	{ threshold: 1, unit: "μm", divisor: 1 },
	{ threshold: 1000, unit: "mm", divisor: 1000 },
];

export class ScaleRuler {
	private container: HTMLDivElement;
	private rulerBar: HTMLDivElement;
	private rulerLabel: HTMLSpanElement;
	private readonly targetWidthPx = 150;

	constructor() {
		this.container = document.createElement("div");
		this.container.style.cssText = `
      position: absolute;
      bottom: 20px;
      left: 20px;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      pointer-events: none;
      transition: opacity 0.2s;
    `;

		this.rulerBar = document.createElement("div");
		this.rulerBar.style.cssText = `
      height: 4px;
      background: #333;
      border-left: 2px solid #333;
      border-right: 2px solid #333;
      min-width: 50px;
    `;

		this.rulerLabel = document.createElement("span");
		this.rulerLabel.style.cssText = `
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 12px;
      color: #333;
      margin-top: 4px;
      white-space: nowrap;
    `;

		this.container.appendChild(this.rulerBar);
		this.container.appendChild(this.rulerLabel);
	}

	getElement(): HTMLDivElement {
		return this.container;
	}

	setColors(barColor: string, textColor: string) {
		this.rulerBar.style.background = barColor;
		this.rulerBar.style.borderLeftColor = barColor;
		this.rulerBar.style.borderRightColor = barColor;
		this.rulerLabel.style.color = textColor;
	}

	setFont(fontFamily: string, fontSize: string) {
		this.rulerLabel.style.fontFamily = fontFamily;
		this.rulerLabel.style.fontSize = fontSize;
	}

	private lastNiceValue: number = 1;

	update(
		camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
		containerHeight: number,
		controlsTarget?: THREE.Vector3,
	) {
		let worldHeightAtTarget: number;
		if (camera instanceof THREE.OrthographicCamera) {
			worldHeightAtTarget = (camera.top - camera.bottom) / camera.zoom;
		} else {
			const target = controlsTarget ?? new THREE.Vector3(0, 0, 0);
			const distance = camera.position.distanceTo(target);
			const fovRad = (camera.fov * Math.PI) / 180;
			worldHeightAtTarget = 2 * distance * Math.tan(fovRad / 2);
		}
		const umPerPixel = worldHeightAtTarget / containerHeight;
		const targetWorldWidth = umPerPixel * this.targetWidthPx;

		const niceValue = this.findNiceNumber(targetWorldWidth);
		this.lastNiceValue = niceValue;

		const actualWidthPx = niceValue / umPerPixel;
		this.rulerBar.style.width = `${actualWidthPx}px`;

		const { value, unit } = this.formatValue(niceValue);
		this.rulerLabel.textContent = `${value} ${unit}`;
	}

	getGridSpacing(): number {
		return this.lastNiceValue;
	}

	private findNiceNumber(target: number): number {
		const magnitude = Math.pow(10, Math.floor(Math.log10(target)));
		const normalized = target / magnitude;

		let best = NICE_NUMBERS[0]!;
		let bestDiff = Math.abs(normalized - best);

		for (const n of NICE_NUMBERS) {
			const diff = Math.abs(normalized - n);
			if (diff < bestDiff) {
				bestDiff = diff;
				best = n;
			}
		}

		return best * magnitude;
	}

	private formatValue(umValue: number): { value: number; unit: string } {
		for (let i = UNIT_SCALES.length - 1; i >= 0; i--) {
			const scale = UNIT_SCALES[i]!;
			if (umValue >= scale.threshold) {
				return {
					value: Math.round((umValue / scale.divisor) * 100) / 100,
					unit: scale.unit,
				};
			}
		}

		return {
			value: Math.round(umValue * 1000 * 100) / 100,
			unit: "nm",
		};
	}
}
