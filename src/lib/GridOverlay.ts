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
  max,
  dFdx,
  dFdy,
  Discard,
  If,
} from "three/tsl";

// Ben Golus's "Pristine Grid" algorithm: https://bgolus.medium.com/the-best-darn-grid-shader-yet-727f9278b9d8
const pristineGrid = Fn(
  ([uv, lineWidthPx, gridDiv, pixelRatio]: [
    ReturnType<typeof vec2>,
    ReturnType<typeof float>,
    ReturnType<typeof float>,
    ReturnType<typeof float>,
  ]) => {
    const div = max(gridDiv, 0.0001);
    const uvScaled = uv.div(div);

    const uvDDX = dFdx(uvScaled);
    const uvDDY = dFdy(uvScaled);
    const uvDeriv = vec2(
      length(vec2(uvDDX.x, uvDDY.x)),
      length(vec2(uvDDX.y, uvDDY.y)),
    );

    const lineWidthScaled = uvDeriv.mul(pixelRatio).mul(lineWidthPx);
    const targetWidth = clamp(lineWidthScaled, vec2(0.0), vec2(0.5));
    const drawWidth = clamp(targetWidth, uvDeriv, vec2(0.5));

    const lineAA = uvDeriv.mul(1.5);
    const gridUV = float(1.0).sub(abs(fract(uvScaled).mul(2.0).sub(1.0)));

    const grid2Raw = smoothstep(drawWidth.add(lineAA), drawWidth.sub(lineAA), gridUV);
    const grid2Scaled = grid2Raw.mul(clamp(targetWidth.div(drawWidth), vec2(0.0), vec2(1.0)));
    const grid2 = mix(grid2Scaled, targetWidth, clamp(uvDeriv.mul(2.0).sub(1.0), vec2(0.0), vec2(1.0)));

    return mix(grid2.x, float(1.0), grid2.y);
  },
);

function createInfiniteGridGeometry(): THREE.BufferGeometry {
  // Near quad (unit size, will be scaled by shader/update) + far quad (200x larger)
  // Forms a ring pattern: far quad with near quad hole, plus near quad
  //
  //  x-----------------x
  //  |\\             //|
  //  | \\           // |
  //  |  \\         //  |
  //  |   x---------x   |
  //  |   |         |   |
  //  |   |  NEAR   |   |
  //  |   |         |   |
  //  |   x---------x   |
  //  |  //         \\  |
  //  | //           \\ |
  //  |//             \\|
  //  x-----------------x

  const nearScale = 1.0;
  const farScale = 200.0;

  const positions = new Float32Array([
    -nearScale, -nearScale, 0,
     nearScale, -nearScale, 0,
    -nearScale,  nearScale, 0,
     nearScale,  nearScale, 0,
    -farScale, -farScale, 0,
     farScale, -farScale, 0,
    -farScale,  farScale, 0,
     farScale,  farScale, 0,
  ]);

  const indices = new Uint16Array([
    0, 1, 2, 2, 1, 3,
    4, 5, 0, 0, 5, 1,
    5, 7, 1, 1, 7, 3,
    7, 6, 3, 3, 6, 2,
    6, 4, 2, 2, 4, 0,
  ]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

export class GridOverlay {
  private root: THREE.Group;
  private baseMesh: THREE.Mesh;
  private baseMaterial: MeshBasicNodeMaterial;

  private uScale = uniform(1.0);
  private uMajorGridFactor = uniform(10.0);
  private uMinorLineWidthPx = uniform(1.2);
  private uMajorLineWidthPx = uniform(2.4);
  private uBaseMajorLineColor = uniform(new THREE.Color(0x666666));
  private uBaseMinorLineColor = uniform(new THREE.Color(0x888888));
  private uBaseOpacity = uniform(0.4);
  private uPixelRatio = uniform(1.0);

  constructor() {
    const makeGridShader = (
      majorColorUniform: ReturnType<typeof uniform>,
      minorColorUniform: ReturnType<typeof uniform>,
      opacityUniform: ReturnType<typeof uniform>,
    ) =>
      Fn(() => {
      const scale = this.uScale;
      const majorGridFactor = this.uMajorGridFactor;
      const minorLineWidthPx = this.uMinorLineWidthPx;
      const majorLineWidthPx = this.uMajorLineWidthPx;
      const majorLineColor = majorColorUniform;
      const minorLineColor = minorColorUniform;
      const pixelRatio = this.uPixelRatio;

      const majorGridSize = max(scale.mul(majorGridFactor), 0.0001);
      const cameraCenteringOffset = floor(cameraPosition.xy.div(majorGridSize)).mul(majorGridSize);
      const worldPos = positionWorld.xy;
      const uv = worldPos.sub(cameraCenteringOffset);

      const majorAlpha = pristineGrid(uv, majorLineWidthPx, majorGridSize, pixelRatio);

      const minorScale = max(scale, 0.0001);
      const minorAlpha = pristineGrid(uv, minorLineWidthPx, minorScale, pixelRatio);

      const minorCol = vec4(minorLineColor, minorAlpha);
      const col = mix(minorCol, vec4(majorLineColor, 1.0), majorAlpha);
      const finalAlpha = col.w.mul(opacityUniform);

      If(finalAlpha.lessThan(0.001), () => {
        Discard();
      });

      return vec4(col.xyz, finalAlpha);
      });

    this.baseMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
    });
    this.baseMaterial.outputNode = makeGridShader(
      this.uBaseMajorLineColor,
      this.uBaseMinorLineColor,
      this.uBaseOpacity,
    )();

    this.baseMesh = new THREE.Mesh(createInfiniteGridGeometry(), this.baseMaterial);
    this.baseMesh.frustumCulled = false;
    this.baseMesh.renderOrder = -1;

    this.root = new THREE.Group();
    this.root.add(this.baseMesh);
  }

  getObject(): THREE.Group {
    return this.root;
  }

  setColor(
    color: string,
    opacity: number = 0.4,
  ) {
    const baseColor = new THREE.Color(color);
    this.uBaseMinorLineColor.value = baseColor;
    this.uBaseMajorLineColor.value = baseColor.clone().multiplyScalar(0.7);
    this.uBaseOpacity.value = opacity;
  }

  setVisible(visible: boolean) {
    this.root.visible = visible;
  }

  update(
    camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
    controlsTarget: THREE.Vector3,
    gridSpacing: number,
    pixelRatio: number = 1.0,
  ) {
    this.uScale.value = gridSpacing;
    this.uPixelRatio.value = pixelRatio;

    let gridMultiplier: number;
    if (camera instanceof THREE.OrthographicCamera) {
      const viewWidth = (camera.right - camera.left) / camera.zoom;
      const viewHeight = (camera.top - camera.bottom) / camera.zoom;
      gridMultiplier = Math.max(viewWidth, viewHeight);
    } else {
      const distance = camera.position.distanceTo(controlsTarget);
      gridMultiplier = distance * 2;
    }

    this.baseMesh.scale.set(gridMultiplier, gridMultiplier, 1);
    this.baseMesh.position.set(camera.position.x, camera.position.y, -0.01);
  }

  dispose() {
    this.baseMesh.geometry.dispose();
    this.baseMaterial.dispose();
  }
}
