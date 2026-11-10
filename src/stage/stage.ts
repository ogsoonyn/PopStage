/**
 * 3Dビュー(5章)。メッシュ生成、シェーダ、カメラ、ピック、書き出し用のオフスクリーン描画。
 * 単位は元画像の 1 ピクセル = 1、画像の中心が原点。
 */
import * as THREE from 'three';
import type { CameraState, Document, Layer, Vec3 } from '../model/project';
import type { Rect } from '../model/weightmap';
import { vertexShader, fragmentShader, MAX_LAYERS } from './shaders';

export interface ViewOptions { overlay: boolean; grid: boolean; shade: boolean }

export interface PickResult {
  x: number; y: number; // ドキュメントのローカル座標(ピクセル)
  u: number; v: number; // 0〜1、v は下が 0
  inside: boolean;
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 1, 1e6);
  private mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null = null;
  private material: THREE.ShaderMaterial;
  private uniforms: Record<string, THREE.IUniform>;
  private mapTex: THREE.Texture | null = null;
  private weightTex: THREE.DataArrayTexture | null = null;
  private weightSize = { w: 1, h: 1 };
  private imageSize = { w: 1, h: 1 };
  private exportTarget: THREE.WebGLRenderTarget | null = null;
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private hit = new THREE.Vector3();
  private plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private gridN = new THREE.Vector2(1, 1);
  vertexCount = 0;
  /** 部分転送を使えたか(フェーズ0の検証項目の確認用) */
  partialUploads = 0;
  fullUploads = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // ライティング無しで画像をそのまま出すので、色空間の変換は挟まない
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    this.uniforms = {
      uMap: { value: null }, uW: { value: null }, uLayerCount: { value: 0 },
      uPop: { value: new Array(MAX_LAYERS).fill(0) },
      uSwing: { value: Array.from({ length: MAX_LAYERS }, () => new THREE.Vector3()) },
      uActive: { value: -1 }, uOverlay: { value: 1 }, uGrid: { value: 0 }, uShade: { value: 0 },
      uBrushOn: { value: 0 }, uBrush: { value: new THREE.Vector3() }, uOpacity: { value: 1 },
      uGridN: { value: this.gridN }, uSize: { value: new THREE.Vector2(1, 1) }, uWTexel: { value: new THREE.Vector2(1, 1) },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader, fragmentShader,
      transparent: true, side: THREE.DoubleSide, depthWrite: true,
    });
  }

  get maxTextureSize(): number { return this.renderer.capabilities.maxTextureSize; }
  get hasDocument(): boolean { return !!this.mesh; }

  /* ---------- ドキュメント ---------- */

  /** 画像を差し替える。source は縮小済みでもよい(メッシュは元画像のピクセル単位)。 */
  setImage(source: TexImageSource & { width: number; height: number }, imageW: number, imageH: number): void {
    this.mapTex?.dispose();
    const tex = new THREE.Texture(source as THREE.Texture['image']);
    tex.colorSpace = THREE.NoColorSpace;
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.needsUpdate = true;
    this.mapTex = tex;
    this.uniforms.uMap.value = tex;
    this.imageSize = { w: imageW, h: imageH };
    (this.uniforms.uSize.value as THREE.Vector2).set(imageW, imageH);
  }

  rebuildMesh(density: number): void {
    const { w, h } = this.imageSize;
    const nx = w >= h ? density : Math.max(2, Math.round((density * w) / h));
    const ny = h > w ? density : Math.max(2, Math.round((density * h) / w));
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); }
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h, nx, ny), this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.gridN.set(nx, ny);
    this.vertexCount = (nx + 1) * (ny + 1);
  }

  setTransform(doc: Pick<Document, 'position' | 'rotation' | 'scale' | 'opacity'>): void {
    if (!this.mesh) return;
    this.mesh.position.set(doc.position.x, doc.position.y, doc.position.z);
    this.mesh.rotation.set(doc.rotation.x, doc.rotation.y, doc.rotation.z);
    this.mesh.scale.setScalar(doc.scale);
    this.mesh.updateMatrixWorld();
    this.uniforms.uOpacity.value = doc.opacity;
  }

  /** ウェイトのテクスチャ配列を作り直して全レイヤーを転送する。 */
  setLayers(layers: readonly Layer[]): void {
    const w = layers[0]?.weights.width ?? 1, h = layers[0]?.weights.height ?? 1;
    if (!this.weightTex || this.weightSize.w !== w || this.weightSize.h !== h) {
      this.weightTex?.dispose();
      const tex = new THREE.DataArrayTexture(new Uint8Array(w * h * MAX_LAYERS), w, h, MAX_LAYERS);
      tex.format = THREE.RedFormat; tex.type = THREE.UnsignedByteType;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false; tex.unpackAlignment = 1;
      this.weightTex = tex; this.weightSize = { w, h };
      this.uniforms.uW.value = tex;
      (this.uniforms.uWTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    }
    const data = this.weightTex.image.data as Uint8Array;
    data.fill(0);
    layers.forEach((l, i) => data.set(l.weights.data, i * w * h));
    this.weightTex.needsUpdate = true;
    this.fullUploads++;
    this.uniforms.uLayerCount.value = layers.length;
    layers.forEach((l, i) => this.setLayerParams(i, l));
  }

  setLayerParams(index: number, layer: Pick<Layer, 'pop' | 'visible'>): void {
    (this.uniforms.uPop.value as number[])[index] = layer.visible ? layer.pop : 0;
  }

  setSwing(index: number, s: Vec3, visible: boolean): void {
    const v = (this.uniforms.uSwing.value as THREE.Vector3[])[index];
    if (visible) v.set(s.x, s.y, s.z); else v.set(0, 0, 0);
  }

  /** 塗った矩形だけをテクスチャへ転送する。まだGPUに無いときは全面転送に切り替える。 */
  uploadWeights(index: number, layer: Layer, rect: Rect): void {
    const tex = this.weightTex; if (!tex) return;
    const { w, h } = this.weightSize, data = tex.image.data as Uint8Array, base = index * w * h;
    const src = layer.weights.data;
    for (let y = rect.y; y < rect.y + rect.h; y++) data.set(src.subarray(y * w + rect.x, y * w + rect.x + rect.w), base + y * w + rect.x);
    const props = this.renderer.properties.get(tex) as { __webglTexture?: WebGLTexture; __version?: number };
    const gl = this.renderer.getContext();
    if (this.partialBroken || !props.__webglTexture || props.__version !== tex.version || !(gl instanceof WebGL2RenderingContext)) {
      tex.needsUpdate = true; this.fullUploads++;
      return;
    }
    // 矩形を詰めた配列にコピーして送る。ROW_LENGTH / SKIP_* を使うとブラウザによって
    // "invalid unpack params combination" で拒否されるため、unpack の設定はすべて既定値にする
    const sub = this.subBuffer.length >= rect.w * rect.h ? this.subBuffer.subarray(0, rect.w * rect.h) : (this.subBuffer = new Uint8Array(rect.w * rect.h));
    for (let y = 0; y < rect.h; y++) sub.set(src.subarray((rect.y + y) * w + rect.x, (rect.y + y) * w + rect.x + rect.w), y * rect.w);
    this.renderer.state.bindTexture(gl.TEXTURE_2D_ARRAY, props.__webglTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, rect.x, rect.y, index, rect.w, rect.h, 1, gl.RED, gl.UNSIGNED_BYTE, sub);
    // 最初の1回だけ成否を確かめ、失敗する環境では以後すべて全面転送にする
    if (!this.partialChecked) {
      this.partialChecked = true;
      if (gl.getError() !== gl.NO_ERROR) {
        console.warn('PopStage: 部分転送が使えないため、ウェイトは全面転送に切り替えます');
        this.partialBroken = true;
        tex.needsUpdate = true; this.fullUploads++;
        return;
      }
    }
    this.partialUploads++;
  }

  private subBuffer = new Uint8Array(0);
  private partialChecked = false;
  private partialBroken = false;

  /* ---------- 表示 ---------- */

  setView(o: ViewOptions, activeIndex: number): void {
    this.uniforms.uOverlay.value = o.overlay ? 1 : 0;
    this.uniforms.uGrid.value = o.grid ? 1 : 0;
    this.uniforms.uShade.value = o.shade ? 1 : 0;
    this.uniforms.uActive.value = activeIndex;
  }

  setBrush(p: { x: number; y: number } | null, radius: number): void {
    this.uniforms.uBrushOn.value = p ? 1 : 0;
    if (p) (this.uniforms.uBrush.value as THREE.Vector3).set(p.x, p.y, radius);
  }

  setBackground(color: string | null): void {
    // 出力で色空間を変換しないので、指定色も変換せずそのまま使う
    if (color) this.renderer.setClearColor(new THREE.Color().setStyle(color, THREE.LinearSRGBColorSpace), 1);
    else this.renderer.setClearColor(0x000000, 0);
  }

  /* ---------- カメラ ---------- */

  /** 画角を変えても正面から見た画像の大きさが変わらないよう、距離を画角から決める。 */
  cameraDistance(cam: CameraState, aspect = this.camera.aspect): number {
    const { w, h } = this.imageSize;
    return ((Math.max(h, w / aspect) * 0.62) / Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) * cam.zoom;
  }

  applyCamera(cam: CameraState, aspect = this.camera.aspect): void {
    const c = this.camera, d = this.cameraDistance(cam, aspect), cp = Math.cos(cam.pitch);
    c.fov = cam.fov; c.aspect = aspect;
    c.near = Math.max(0.1, d * 0.01); c.far = d * 100;
    c.position.set(cam.target.x + d * Math.sin(cam.yaw) * cp, cam.target.y + d * Math.sin(cam.pitch), cam.target.z + d * Math.cos(cam.yaw) * cp);
    c.lookAt(cam.target.x, cam.target.y, cam.target.z);
    c.updateProjectionMatrix(); c.updateMatrixWorld();
  }

  /** 画面上の 1px がカメラ注視点の距離で何単位にあたるか */
  pixelToWorld(cam: CameraState): number {
    return (2 * this.cameraDistance(cam) * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / Math.max(1, this.canvas.clientHeight);
  }

  /** 画面の右・上方向(ワールド)を返す */
  screenAxes(): { right: Vec3; up: Vec3 } {
    const e = this.camera.matrixWorld.elements;
    return { right: { x: e[0], y: e[1], z: e[2] }, up: { x: e[4], y: e[5], z: e[6] } };
  }

  resize(): void {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
  }

  /** ポインタからのレイと「持ち上げる前の平面」の交点 */
  pick(clientX: number, clientY: number): PickResult | null {
    if (!this.mesh) return null;
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -(((clientY - r.top) / r.height) * 2 - 1));
    this.ray.setFromCamera(this.ndc, this.camera);
    const inv = this.mesh.matrixWorld.clone().invert();
    const local = this.ray.ray.clone().applyMatrix4(inv);
    if (!local.intersectPlane(this.plane, this.hit)) return null;
    const { w, h } = this.imageSize, u = this.hit.x / w + 0.5, v = this.hit.y / h + 0.5;
    return { x: this.hit.x, y: this.hit.y, u, v, inside: u >= 0 && u <= 1 && v >= 0 && v <= 1 };
  }

  render(cam: CameraState): void {
    this.applyCamera(cam);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);
  }

  /* ---------- 書き出し ---------- */

  /**
   * 指定サイズでオフスクリーンに描き、上の行から並んだ RGBA(ストレートアルファ)を返す。
   * ウェイト重ね表示・グリッド・ブラシカーソルは描かない。
   */
  renderFrame(width: number, height: number, cam: CameraState, background: string | null, out?: Uint8ClampedArray): Uint8ClampedArray {
    if (!this.exportTarget || this.exportTarget.width !== width || this.exportTarget.height !== height) {
      this.exportTarget?.dispose();
      this.exportTarget = new THREE.WebGLRenderTarget(width, height, { samples: 4, depthBuffer: true });
    }
    const u = this.uniforms, saved = [u.uOverlay.value, u.uGrid.value, u.uBrushOn.value];
    u.uOverlay.value = 0; u.uGrid.value = 0; u.uBrushOn.value = 0;
    const clear = new THREE.Color(), clearAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(clear);
    this.setBackground(background);
    const aspect = this.camera.aspect;
    this.applyCamera(cam, width / height);
    this.renderer.setRenderTarget(this.exportTarget);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    const raw = new Uint8Array(width * height * 4);
    this.renderer.readRenderTargetPixels(this.exportTarget, 0, 0, width, height, raw);
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(clear, clearAlpha);
    this.camera.aspect = aspect;
    [u.uOverlay.value, u.uGrid.value, u.uBrushOn.value] = saved;

    // 下から上へ並んでいるので反転し、乗算済みの色をストレートアルファへ戻す
    const px = out && out.length === raw.length ? out : new Uint8ClampedArray(raw.length);
    const row = width * 4;
    for (let y = 0; y < height; y++) {
      const s = (height - 1 - y) * row, d = y * row;
      for (let i = 0; i < row; i += 4) {
        const a = raw[s + i + 3];
        if (a === 255 || a === 0) { px[d + i] = raw[s + i]; px[d + i + 1] = raw[s + i + 1]; px[d + i + 2] = raw[s + i + 2]; }
        else { const k = 255 / a; px[d + i] = raw[s + i] * k; px[d + i + 1] = raw[s + i + 1] * k; px[d + i + 2] = raw[s + i + 2] * k; }
        px[d + i + 3] = a;
      }
    }
    return px;
  }

  dispose(): void {
    this.mapTex?.dispose(); this.weightTex?.dispose(); this.exportTarget?.dispose();
    this.mesh?.geometry.dispose(); this.material.dispose(); this.renderer.dispose();
  }
}
