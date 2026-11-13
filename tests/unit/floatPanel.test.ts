import { describe, expect, it } from 'vitest';
import { clampPanelPos } from '../../src/ui/floatPanel';

describe('clampPanelPos', () => {
  it('画面の中ならそのまま', () => {
    expect(clampPanelPos(100, 50, 400, 300, 1400, 900)).toEqual({ right: 100, bottom: 50 });
  });
  it('右下の角から外へは出さない', () => {
    expect(clampPanelPos(-200, -50, 400, 300, 1400, 900)).toEqual({ right: 8, bottom: 8 });
  });
  it('左上へ出そうなときは、左上の端に寄せる', () => {
    expect(clampPanelPos(5000, 5000, 400, 300, 1400, 900)).toEqual({ right: 1400 - 400 - 8, bottom: 900 - 300 - 8 });
  });
  it('画面より大きいときは左上(見出し)が見えるほうを優先する', () => {
    expect(clampPanelPos(8, 8, 400, 1000, 1400, 900)).toEqual({ right: 8, bottom: 900 - 1000 - 8 });
  });
});
