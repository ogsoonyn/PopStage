/**
 * 頂点シェーダがウェイトマップ(テクスチャ配列)を読み、各レイヤーの w·(ポップ·z + 揺れ) を足して持ち上げる(5章)。
 *   x' = x + Σ_i w_i (p_i ẑ + s_i)
 * ウェイトマップは行 0 が画像の上端なので、v を反転して読む。
 */
export const MAX_LAYERS = 8;

export const vertexShader = /* glsl */ `
  precision highp sampler2DArray;
  uniform sampler2DArray uW;
  uniform int uLayerCount;
  uniform float uPop[${MAX_LAYERS}];
  uniform vec3 uSwing[${MAX_LAYERS}];
  varying vec2 vUv;
  varying vec2 vP;
  void main() {
    vUv = uv;
    vP = position.xy;
    vec2 wuv = vec2(uv.x, 1.0 - uv.y);
    vec3 p = position;
    for (int i = 0; i < ${MAX_LAYERS}; i++) {
      if (i >= uLayerCount) break;
      float w = textureLod(uW, vec3(wuv, float(i)), 0.0).r;
      p += w * (vec3(0.0, 0.0, uPop[i]) + uSwing[i]);
    }
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

export const fragmentShader = /* glsl */ `
  precision highp sampler2DArray;
  uniform sampler2D uMap;
  uniform sampler2DArray uW;
  uniform int uLayerCount;
  uniform float uPop[${MAX_LAYERS}];
  uniform int uActive;
  uniform float uOverlay, uGrid, uShade, uBrushOn, uOpacity;
  uniform vec2 uGridN, uSize, uWTexel;
  uniform vec3 uBrush;
  varying vec2 vUv;
  varying vec2 vP;

  float heightAt(vec2 wuv) {
    float h = 0.0;
    for (int i = 0; i < ${MAX_LAYERS}; i++) {
      if (i >= uLayerCount) break;
      h += texture(uW, vec3(wuv, float(i))).r * uPop[i];
    }
    return h;
  }

  void main() {
    vec4 c = texture2D(uMap, vUv);
    c.a *= uOpacity;
    vec2 wuv = vec2(vUv.x, 1.0 - vUv.y);

    // 陰影(試験的): ウェイトから法線を求めて膨らみに陰を付ける
    if (uShade > 0.5) {
      vec2 e = uWTexel * 1.5;
      float dx = (heightAt(wuv + vec2(e.x, 0.0)) - heightAt(wuv - vec2(e.x, 0.0))) / (2.0 * e.x * uSize.x);
      float dy = -(heightAt(wuv + vec2(0.0, e.y)) - heightAt(wuv - vec2(0.0, e.y))) / (2.0 * e.y * uSize.y);
      vec3 n = normalize(vec3(-dx, -dy, 1.0));
      float l = dot(n, normalize(vec3(-0.45, 0.55, 0.7)));
      c.rgb *= clamp(0.45 + 0.8 * l, 0.35, 1.25);
    }

    // 選択中レイヤーのウェイトを半透明の色で重ねる
    if (uActive >= 0 && uOverlay > 0.5) {
      float w = texture(uW, vec3(wuv, float(uActive))).r;
      c.rgb = mix(c.rgb, vec3(1.0, 0.2, 0.5), w * 0.5);
      c.a = max(c.a, w * 0.5);
    }

    // グリッド(メッシュの分割線)
    vec2 g = vUv * uGridN;
    vec2 d = abs(fract(g - 0.5) - 0.5) / fwidth(g);
    float line = (1.0 - min(min(d.x, d.y), 1.0)) * uGrid;
    c.rgb = mix(c.rgb, vec3(0.1, 0.75, 1.0), line * 0.7);
    c.a = max(c.a, line * 0.7);

    // ブラシカーソル(持ち上げる前の平面上の円)
    float r = length(vP - uBrush.xy);
    float fw = fwidth(r);
    float ring = (1.0 - smoothstep(fw, fw * 2.5, abs(r - uBrush.z))) * uBrushOn;
    float ring2 = (1.0 - smoothstep(fw, fw * 2.5, abs(r - uBrush.z - fw * 2.0))) * uBrushOn;
    c.rgb = mix(c.rgb, vec3(0.0), ring2 * 0.6);
    c.rgb = mix(c.rgb, vec3(1.0), ring * 0.95);
    c.a = max(c.a, max(ring, ring2 * 0.6));

    if (c.a < 0.004) discard;
    gl_FragColor = c;
  }
`;
