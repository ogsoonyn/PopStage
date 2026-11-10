import { describe, it, expect } from 'vitest';
import { PerfStats, FRAME_CAP, EVENT_CAP } from '../../src/debug/perfStats';

/** 16ms ごとのフレームを n 回進める。各フレームで物理 1ms・描画 2ms を使ったことにする */
function run(s: PerfStats, n: number, start = 1000, step = 16): number {
  let t = start;
  for (let i = 0; i < n; i++) {
    s.frame(t);
    s.lap('physics', t, t + 1); s.lap('render', t + 1, t + 3);
    t += step;
  }
  return t;
}

describe('PerfStats', () => {
  it('フレーム間隔と処理ごとの時間をまとめる', () => {
    const s = new PerfStats();
    const t = run(s, 70);
    s.frame(t);
    const m = s.summary(1000);
    expect(m.interval.avg).toBeCloseTo(16);
    expect(m.fps).toBeCloseTo(62.5);
    expect(m.sections.physics.avg).toBeCloseTo(1);
    expect(m.sections.render.max).toBeCloseTo(2);
    expect(m.sections.upload.avg).toBe(0);
    expect(m.slowFrames).toBe(0);
  });

  it('記録は上限までの輪で、古いものから捨てる', () => {
    const s = new PerfStats();
    run(s, FRAME_CAP + 50);
    const rows = s.frames();
    expect(rows.length).toBe(FRAME_CAP);
    expect(rows[1].t - rows[0].t).toBe(16);
    for (let i = 0; i < EVENT_CAP + 10; i++) s.event({ t: i, d: 1, kind: 'x' });
    expect(s.events.length).toBe(EVENT_CAP);
    expect(s.events[0].t).toBe(10);
  });

  it('長く止まったら記録し、長いタスクが重なっていればページの処理、無ければページの外と見立てる', () => {
    const s = new PerfStats();
    const found: number[] = [];
    s.onFreeze = f => found.push(f.gap);
    let t = run(s, 10);
    // 1回目: 400ms 止まり、その間ずっと長いタスクが走っていた
    s.event({ t: t + 5, d: 390, kind: 'longtask' });
    s.event({ t: t + 5, d: 80, kind: 'autosave' });
    s.frame(t); s.frame(t + 400); t += 400;
    t = run(s, 5, t);
    // 2回目: 600ms 止まったが、ページは何もしていなかった(ほかのプロセスに CPU を取られたなど)
    s.frame(t); s.frame(t + 600);
    expect(found).toEqual([400, 600]);
    const [a, b] = s.freezes;
    expect(a.verdict).toBe('page');
    expect(a.pageBusy).toBe(390);
    expect(a.events.map(e => e.kind)).toContain('autosave');
    expect(a.frames.length).toBeGreaterThan(5);
    expect(b.verdict).toBe('outside');
    expect(b.pageBusy).toBe(0);
  });

  it('長いタスクの知らせが後から届いても、見立てをやり直せる', () => {
    const s = new PerfStats();
    const t = run(s, 3);
    s.frame(t); s.frame(t + 500);
    expect(s.freezes[0].verdict).toBe('outside');
    s.event({ t: t + 10, d: 480, kind: 'longtask' });
    s.refreshVerdicts();
    expect(s.freezes[0].verdict).toBe('page');
    const j = s.toJSON() as { freezes: unknown[]; frames: unknown[] };
    expect(j.freezes.length).toBe(1);
    expect(j.frames.length).toBe(4);
  });
});
