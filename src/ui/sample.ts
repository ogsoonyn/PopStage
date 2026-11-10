/** 最初から触れるよう、サンプル画像(プリン)をその場で描き、プリン部分をあらかじめ塗っておく。 */
import { createDocument, type Document } from '../model/project';
import { Stroke } from '../paint/stroke';

function drawSample(): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 768;
  const g = c.getContext('2d')!;
  let gr = g.createLinearGradient(0, 0, 0, 768); gr.addColorStop(0, '#cfe8ef'); gr.addColorStop(1, '#f3e3c8'); g.fillStyle = gr; g.fillRect(0, 0, 1024, 768);
  g.fillStyle = '#e9cfa6'; g.fillRect(0, 610, 1024, 158);
  g.fillStyle = 'rgba(60,40,20,.18)'; g.beginPath(); g.ellipse(512, 668, 360, 44, 0, 0, 7); g.fill();
  g.fillStyle = '#fbfbf8'; g.beginPath(); g.ellipse(512, 640, 350, 62, 0, 0, 7); g.fill();
  g.fillStyle = '#e7e9e6'; g.beginPath(); g.ellipse(512, 646, 270, 40, 0, 0, 7); g.fill();
  gr = g.createLinearGradient(300, 0, 724, 0); gr.addColorStop(0, '#f2b63c'); gr.addColorStop(0.45, '#ffdf80'); gr.addColorStop(1, '#eaa52a'); g.fillStyle = gr;
  g.beginPath(); g.moveTo(312, 630); g.quadraticCurveTo(350, 400, 398, 300); g.quadraticCurveTo(512, 262, 626, 300);
  g.quadraticCurveTo(674, 400, 712, 630); g.quadraticCurveTo(512, 690, 312, 630); g.fill();
  g.fillStyle = '#7a3d10'; g.beginPath(); g.moveTo(396, 304); g.quadraticCurveTo(512, 258, 628, 304);
  g.quadraticCurveTo(640, 352, 606, 346); g.quadraticCurveTo(590, 392, 562, 350); g.quadraticCurveTo(520, 372, 486, 348);
  g.quadraticCurveTo(462, 398, 440, 346); g.quadraticCurveTo(388, 356, 396, 304); g.fill();
  g.fillStyle = '#fffdf6'; for (const [x, y, r] of [[470, 262, 34], [512, 244, 40], [556, 262, 34], [512, 272, 38]]) { g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); }
  g.strokeStyle = '#3c6b2a'; g.lineWidth = 5; g.lineCap = 'round'; g.beginPath(); g.moveTo(514, 196); g.quadraticCurveTo(530, 150, 566, 140); g.stroke();
  g.fillStyle = '#d6263c'; g.beginPath(); g.arc(512, 214, 26, 0, 7); g.fill();
  g.fillStyle = 'rgba(255,255,255,.7)'; g.beginPath(); g.arc(503, 205, 7, 0, 7); g.fill();
  g.fillStyle = '#4a2a12'; g.beginPath(); g.arc(462, 470, 11, 0, 7); g.arc(562, 470, 11, 0, 7); g.fill();
  g.strokeStyle = '#4a2a12'; g.lineWidth = 6; g.beginPath(); g.arc(512, 492, 26, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
  g.fillStyle = 'rgba(240,120,110,.45)'; g.beginPath(); g.ellipse(428, 506, 22, 13, 0, 0, 7); g.ellipse(596, 506, 22, 13, 0, 0, 7); g.fill();
  g.fillStyle = 'rgba(255,255,255,.35)'; g.beginPath(); g.ellipse(392, 470, 16, 90, 0.12, 0, 7); g.fill();
  return c;
}

export async function createSampleDocument(): Promise<Document> {
  const c = drawSample();
  const blob = await new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('sample'))), 'image/png'));
  const doc = createDocument({ bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png', ext: 'png', width: 1024, height: 768 }, 'プリン(サンプル)');
  const layer = doc.layers[0];
  layer.name = 'プリン';
  layer.pop = 140;
  const wm = layer.weights, k = wm.width / 1024;
  for (const [x, y, r, a] of [[512, 520, 230, 0.9], [512, 430, 210, 1], [512, 330, 170, 1], [512, 250, 120, 1], [512, 215, 70, 0.9]]) {
    const st = new Stroke(wm, 'brush', { size: r * 2 * k, strength: a, hardness: 0.2 });
    st.addPoint(x * k, y * k);
  }
  wm.gaussianBlur(12 * k);
  return doc;
}
