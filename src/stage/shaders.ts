/**
 * 頂点シェーダがウェイトマップ(テクスチャ配列)を読み、各レイヤーのずれ d_i を一覧の下から順に重ねて持ち上げる。
 *   d_i = w_i (p_i ẑ + s_i) + w_i r_i (x_xy - c_i)
 * r_i は塗った範囲の広がり(ためて膨らむ2)、c_i はそのレイヤーのウェイトの重心。広がりは画像の面内だけに効く。
 * 重ね方(uBlend): 0 = 加算(下までのずれ D に d_i を足す)、1 = 最大(D と d_i の高さ z を比べ、高い方のずれを使う)。
 * 最大は高さの差が小さい所で2つをなめらかに混ぜる。境目で揺れの向きが急に変わってメッシュが折れないようにするため。
 * 塗っていない所(w_i = 0)は下のずれをそのまま残す。
 * ウェイトマップは行 0 が画像の上端なので、v を反転して読む。
 */
export const MAX_LAYERS = 8;

export const vertexShader = /* glsl */ `
  precision highp sampler2DArray;
  uniform sampler2DArray uW;
  uniform int uLayerCount;
  uniform float uPop[${MAX_LAYERS}];
  uniform int uBlend[${MAX_LAYERS}];
  uniform vec3 uSwing[${MAX_LAYERS}];
  uniform float uSpread[${MAX_LAYERS}];
  uniform vec2 uCenter[${MAX_LAYERS}];
  uniform float uFlat;
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
      vec3 d = w * (vec3(0.0, 0.0, uPop[i]) + uSwing[i]);
      d.xy += w * uSpread[i] * (position.xy - uCenter[i]);
      if (uBlend[i] == 1) {
        vec3 below = p - position;
        float soft = max(0.08 * max(abs(d.z), abs(below.z)), 0.5);
        float t = smoothstep(-soft, soft, d.z - below.z) * smoothstep(0.0, 0.02, w);
        p = position + mix(below, d, t);
      } else {
        p += d;
      }
    }
    // ポップ一時OFF: 持ち上げと揺れ(広がりも)を消して平らな画像に戻す
    p = mix(p, position, uFlat);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

export const fragmentShader = /* glsl */ `
  precision highp sampler2DArray;
  uniform sampler2D uMap;
  uniform sampler2DArray uW;
  uniform int uActive;
  uniform float uOverlay, uGrid, uBrushOn, uOpacity, uFade;
  uniform vec2 uGridN;
  uniform vec3 uBrush;
  varying vec2 vUv;
  varying vec2 vP;

  void main() {
    vec4 c = texture2D(uMap, vUv);
    c.a *= uOpacity;
    vec2 wuv = vec2(vUv.x, 1.0 - vUv.y);

    // 画像を薄く: 色を落として半透明にし、塗りの状況を見やすくする
    if (uFade > 0.5) {
      float g = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb = mix(c.rgb, vec3(g), 0.7);
      c.a *= 0.25;
    }

    // 選択中レイヤーのウェイトを半透明の色で重ねる(画像を薄くしているときは濃く)
    if (uActive >= 0 && uOverlay > 0.5) {
      float w = texture(uW, vec3(wuv, float(uActive))).r;
      float k = uFade > 0.5 ? 0.9 : 0.5;
      c.rgb = mix(c.rgb, vec3(1.0, 0.2, 0.5), clamp(w * k / max(max(c.a, w * k), 1e-4), 0.0, 1.0));
      c.a = max(c.a, w * k);
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
