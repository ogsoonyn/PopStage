import { describe, it, expect } from 'vitest';
import { trimRecent, RECENT_MAX, COPY_TOTAL, type RecentEntry } from '../../src/storage/recent';

const entry = (id: string, openedAt: number, copy = 0): RecentEntry =>
  ({ id, name: `${id}.png`, kind: 'image', openedAt, size: copy, bytes: copy ? new Uint8Array(copy) : undefined });

describe('最近開いたファイルの上限', () => {
  it('新しい順に並べ、件数の上限を超えた古いものから外す', () => {
    const list = Array.from({ length: RECENT_MAX + 3 }, (_, i) => entry(`e${i}`, i));
    const { keep, drop } = trimRecent(list);
    expect(keep.map(e => e.id)).toEqual(Array.from({ length: RECENT_MAX }, (_, i) => `e${RECENT_MAX + 2 - i}`));
    expect(drop.sort()).toEqual(['e0', 'e1', 'e2']);
  });

  it('コピーの合計が上限を超えたら、古いコピーから外す(場所だけの項目は残す)', () => {
    const big = Math.floor(COPY_TOTAL / 3) + 1;
    const { keep, drop } = trimRecent([entry('new', 5, big), entry('handleOnly', 4), entry('b', 3, big), entry('c', 2, big), entry('d', 1, 10)]);
    expect(keep.map(e => e.id)).toEqual(['new', 'handleOnly', 'b', 'd']);
    expect(drop).toEqual(['c']);
  });
});
