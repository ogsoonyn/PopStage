/**
 * 動作の重さを調べるための記録(デバッグ表示用)。DOM に依存しない。
 * ?debug で開いたときだけ作られ、通常の起動では読み込みもしない。
 *
 * 1フレームごとに「前のフレームからの間隔」と、処理ごとの時間(物理・ウェイト転送・描画)を
 * 直近 FRAME_CAP フレームぶん輪の形で持つ。自動保存などの単発の処理と、ブラウザが知らせる
 * 長いタスクは出来事(event)として持つ。間隔が FREEZE_MS を超えたら「止まった」として、
 * その前後の記録を控える。
 */

export const SECTIONS = ['physics', 'upload', 'render'] as const;
export type Section = typeof SECTIONS[number];

export const FRAME_CAP = 3600;
export const EVENT_CAP = 400;
export const FREEZE_MS = 250;
const FREEZE_CAP = 10;
/** 止まったときに控える、その前の時間 */
const FREEZE_BEFORE_MS = 5000;
/** 止まった間が終わってからこの時間がたったら、見立てを確かなものとしてやり直さない */
const SETTLE_MS = 3000;

export interface PerfEvent {
  /** performance.now() の時刻(始まり) */
  t: number;
  /** 長さ(ミリ秒) */
  d: number;
  kind: string;
  detail?: string;
}

export interface FrameRow { t: number; interval: number; physics: number; upload: number; render: number }

export interface FreezeRecord {
  /** 止まる直前のフレームの時刻 */
  t: number;
  /** 止まった長さ(フレーム間隔) */
  gap: number;
  /** その間にこのページの処理(長いタスク)が占めていた時間 */
  pageBusy: number;
  /** pageBusy から見た見立て。unknown は長いタスクを知らせないブラウザ(Firefox・Safari) */
  verdict: 'page' | 'outside' | 'mixed' | 'unknown';
  events: PerfEvent[];
  frames: FrameRow[];
}

export interface PerfSummary {
  frames: number;
  fps: number;
  interval: { avg: number; p95: number; max: number };
  sections: Record<Section, { avg: number; max: number }>;
  slowFrames: number;
}

export class PerfStats {
  private times = new Float64Array(FRAME_CAP);
  private intervals = new Float32Array(FRAME_CAP);
  private sec: Record<Section, Float32Array> = { physics: new Float32Array(FRAME_CAP), upload: new Float32Array(FRAME_CAP), render: new Float32Array(FRAME_CAP) };
  private cur: Record<Section, number> = { physics: 0, upload: 0, render: 0 };
  private head = 0;
  private count = 0;
  private last = 0;
  readonly events: PerfEvent[] = [];
  readonly freezes: FreezeRecord[] = [];
  readonly heap: { t: number; mb: number }[] = [];
  /** 止まったのを見つけたときに呼ぶ(表示の更新用) */
  onFreeze: ((f: FreezeRecord) => void) | null = null;
  /** 長いタスクの知らせが届くか(届かないブラウザでは見立てられない) */
  constructor(private readonly longTasks = true) {}
  private settled = new WeakSet<FreezeRecord>();

  /** 処理ごとの時間を今のフレームに足す。t0 からの経過を足し、今の時刻を返す */
  lap(section: Section, t0: number, now: number): number {
    this.cur[section] += now - t0;
    return now;
  }

  /** フレームの始まり(requestAnimationFrame の時刻)で呼ぶ。前のフレームの記録を確定する */
  frame(now: number): void {
    if (this.last) {
      const i = this.head, interval = now - this.last;
      this.times[i] = this.last; this.intervals[i] = interval;
      for (const s of SECTIONS) { this.sec[s][i] = this.cur[s]; this.cur[s] = 0; }
      this.head = (i + 1) % FRAME_CAP;
      this.count = Math.min(this.count + 1, FRAME_CAP);
      if (interval > FREEZE_MS) this.captureFreeze(this.last, interval);
    }
    this.last = now;
  }

  event(e: PerfEvent): void {
    this.events.push(e);
    if (this.events.length > EVENT_CAP) this.events.splice(0, this.events.length - EVENT_CAP);
  }

  sampleHeap(t: number, bytes: number): void {
    this.heap.push({ t, mb: Math.round(bytes / 1e5) / 10 });
    if (this.heap.length > 600) this.heap.splice(0, this.heap.length - 600);
  }

  /** 古い順に、直近 n フレーム(既定はすべて) */
  frames(n = this.count): FrameRow[] {
    const out: FrameRow[] = [];
    n = Math.min(n, this.count);
    for (let k = n; k > 0; k--) {
      const i = (this.head - k + FRAME_CAP) % FRAME_CAP;
      out.push({ t: this.times[i], interval: this.intervals[i], physics: this.sec.physics[i], upload: this.sec.upload[i], render: this.sec.render[i] });
    }
    return out;
  }

  /** 直近 ms ミリ秒のまとめ */
  summary(ms = 1000): PerfSummary {
    const rows = this.frames().filter(r => r.t >= this.last - ms);
    const iv = rows.map(r => r.interval).sort((a, b) => a - b);
    const sum = iv.reduce((s, v) => s + v, 0);
    const sections = {} as PerfSummary['sections'];
    for (const s of SECTIONS) {
      let tot = 0, max = 0;
      for (const r of rows) { tot += r[s]; max = Math.max(max, r[s]); }
      sections[s] = { avg: rows.length ? tot / rows.length : 0, max };
    }
    return {
      frames: rows.length,
      fps: sum > 0 ? (rows.length * 1000) / sum : 0,
      interval: { avg: rows.length ? sum / rows.length : 0, p95: iv.length ? iv[Math.min(iv.length - 1, Math.floor(iv.length * 0.95))] : 0, max: iv.length ? iv[iv.length - 1] : 0 },
      sections,
      slowFrames: iv.filter(v => v > 50).length,
    };
  }

  private captureFreeze(t: number, gap: number): void {
    // タブが隠れていた間に描画が止まるのは正常なので、止まった記録にしない
    if (this.events.some(e => e.kind === 'visibility' && e.t >= t && e.t <= t + gap)) return;
    const rec: FreezeRecord = { t, gap, pageBusy: 0, verdict: 'outside', events: [], frames: this.frames().filter(r => r.t >= t - FREEZE_BEFORE_MS) };
    this.judge(rec);
    this.freezes.push(rec);
    if (this.freezes.length > FREEZE_CAP) this.freezes.shift();
    this.onFreeze?.(rec);
  }

  /**
   * 止まっていた間に重なる長いタスクの時間から見立てる。ほとんど重なっていなければ、
   * ページの外(ほかのプロセスによる CPU の取り合い・GPU・OS)で止まっていたことになる。
   */
  private judge(f: FreezeRecord): void {
    const end = f.t + f.gap;
    // 先に控えた出来事は残し、あとから届いた分だけ足す(出来事の輪から古いものが消えても失わない)
    const seen = new Set(f.events);
    for (const e of this.events) if (!seen.has(e) && e.t + e.d >= f.t - FREEZE_BEFORE_MS && e.t <= end) { f.events.push(e); seen.add(e); }
    f.events.sort((a, b) => a.t - b.t);
    let busy = 0;
    for (const e of f.events) {
      if (e.kind !== 'longtask') continue;
      const a = Math.max(f.t, e.t), b = Math.min(end, e.t + e.d);
      if (b > a) busy += b - a;
    }
    const ratio = busy / f.gap;
    f.pageBusy = Math.round(busy);
    f.verdict = !this.longTasks ? 'unknown' : ratio > 0.6 ? 'page' : ratio < 0.2 ? 'outside' : 'mixed';
  }

  /** 長いタスクの知らせはフレームより後に届くことがあるので、まだ確かでない記録の見立てをやり直す */
  refreshVerdicts(now = this.last): void {
    for (const f of this.freezes) {
      if (this.settled.has(f)) continue;
      this.judge(f);
      if (now - (f.t + f.gap) > SETTLE_MS) this.settled.add(f);
    }
  }

  /** 書き出し用 */
  toJSON(): object {
    this.refreshVerdicts();
    return { frames: this.frames(), events: this.events, freezes: this.freezes, heap: this.heap, summary: this.summary(5000) };
  }
}
