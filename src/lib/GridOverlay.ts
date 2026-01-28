import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import {
  Fn,
  vec2,
  vec4,
  float,
  uniform,
  positionWorld,
  cameraPosition,
  floor,
  fract,
  abs,
  length,
  mix,
  clamp,
  smoothstep,
  dFdx,
  dFdy,
  Discard,
  If,
  max,
} from "three/tsl";

export class GridOverlay {
  private mesh: THREE.Mesh;
  private material: MeshBasicNodeMaterial;
  private gridSize: number = 100000;

  private uScale = uniform(1.0);
  private uMajorGridFactor = uniform(10.0);
  private uMinorLineWidth = uniform(0.02);
  private uMajorLineWidth = uniform(0.04);
  private uMinorLineColor = uniform(new THREE.Color(0x888888));
  private uMajorLineColor = uniform(new THREE.Color(0x666666));
  private uOpacity = uniform(0.4);

  constructor() {
    const gridShader = Fn(() => {
      const scale = this.uScale;
      const majorGridFactor = this.uMajorGridFactor;
      const minorLineWidthU = this.uMinorLineWidth;
      const majorLineWidthU = this.uMajorLineWidth;
      const minorLineColor = this.uMinorLineColor;
      const majorLineColor = this.uMajorLineColor;
      const opacity = this.uOpacity;

      const division = scale.mul(majorGridFactor);
      const cameraCenteringOffset = floor(cameraPosition.xy.div(division)).mul(division);
      const worldPos = positionWorld.xy;
      const vUv = worldPos.sub(cameraCenteringOffset);

      const uvDDXY_x = dFdx(vUv);
      const uvDDXY_y = dFdy(vUv);
      const uvDeriv = vec2(
        length(vec2(uvDDXY_x.x, uvDDXY_y.x)),
        length(vec2(uvDDXY_x.y, uvDDXY_y.y))
      );

      const majorGridSize = scale.mul(majorGridFactor);
      const majorDiv = max(float(0.1), majorGridSize);
      const majorUVDeriv = uvDeriv.div(majorDiv);
      const majorLineWidth = majorLineWidthU.mul(scale).div(majorDiv);
      const majorDrawWidth = clamp(vec2(majorLineWidth, majorLineWidth), majorUVDeriv, vec2(0.5, 0.5));
      const majorLineAA = majorUVDeriv.mul(1.5);
      const majorGridUV = float(1.0).sub(abs(fract(vUv.div(majorDiv)).mul(2.0).sub(1.0)));
      const majorGrid2Raw = smoothstep(majorDrawWidth.add(majorLineAA), majorDrawWidth.sub(majorLineAA), majorGridUV);
      const majorGrid2Scaled = majorGrid2Raw.mul(clamp(vec2(majorLineWidth, majorLineWidth).div(majorDrawWidth), vec2(0.0, 0.0), vec2(1.0, 1.0)));
      const majorGrid2 = mix(majorGrid2Scaled, vec2(majorLineWidth, majorLineWidth), clamp(majorUVDeriv.mul(2.0).sub(1.0), vec2(0.0, 0.0), vec2(1.0, 1.0)));

      const minorDiv = max(float(0.1), scale);
      const minorUVDeriv = uvDeriv.div(minorDiv);
      const minorLineWidth = minorLineWidthU.mul(scale).div(minorDiv);
      const minorDrawWidth = clamp(vec2(minorLineWidth, minorLineWidth), minorUVDeriv, vec2(0.5, 0.5));
      const minorLineAA = minorUVDeriv.mul(1.5);
      const minorGridUV = float(1.0).sub(abs(fract(vUv.div(minorDiv)).mul(2.0).sub(1.0)));
      const minorGrid2Raw = smoothstep(minorDrawWidth.add(minorLineAA), minorDrawWidth.sub(minorLineAA), minorGridUV);
      const minorGrid2Scaled = minorGrid2Raw.mul(clamp(vec2(minorLineWidth, minorLineWidth).div(minorDrawWidth), vec2(0.0, 0.0), vec2(1.0, 1.0)));
      const minorGrid2 = mix(minorGrid2Scaled, vec2(minorLineWidth, minorLineWidth), clamp(minorUVDeriv.mul(2.0).sub(1.0), vec2(0.0, 0.0), vec2(1.0, 1.0)));

      const minorGrid = mix(minorGrid2.x, float(1.0), minorGrid2.y);
      const majorGrid = mix(majorGrid2.x, float(1.0), majorGrid2.y);

      const minorCol = vec4(minorLineColor, minorGrid);
      const col = mix(minorCol, vec4(majorLineColor, 1.0), majorGrid);
      const finalAlpha = col.w.mul(opacity);

      If(finalAlpha.lessThan(0.01), () => {
        Discard();
      });

      return vec4(col.xyz, finalAlpha);
    });

    this.material = new MeshBasicNodeMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
    });
    this.material.outputNode = gridShader();

    const geometry = new THREE.PlaneGeometry(this.gridSize, this.gridSize);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.rotation.x = 0;
    this.mesh.renderOrder = 999;
  }

  getObject(): THREE.Mesh {
    return this.mesh;
  }

  setColor(color: string, opacity: number = 0.4) {
    const c = new THREE.Color(color);
    this.uMinorLineColor.value = c;
    this.uMajorLineColor.value = c.clone().multiplyScalar(0.7);
    this.uOpacity.value = opacity;
  }

  setVisible(visible: boolean) {
    this.mesh.visible = visible;
  }

  update(controlsTarget: THREE.Vector3, gridSpacing: number) {
    this.uScale.value = gridSpacing;
    this.mesh.position.set(controlsTarget.x, controlsTarget.y, -0.01);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
