/**
 * アンドゥスタック。変更はすべてコマンドとして記録する。
 * 100手まで、または差分の合計が 256MB まで保持する(6章)。
 */
import { Emitter } from '../util/emitter';
import type { Store } from '../model/project';

export interface Command {
  readonly label: string;
  /** 保持しているデータ量の目安(バイト) */
  readonly bytes: number;
  apply(store: Store): void;
  revert(store: Store): void;
}

export interface HistoryOptions { maxSteps: number; maxBytes: number }

export class History extends Emitter<{ change: void }> {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private totalBytes = 0;
  readonly options: HistoryOptions;

  constructor(private store: Store, options: Partial<HistoryOptions> = {}) {
    super();
    this.options = { maxSteps: 100, maxBytes: 256 * 1024 * 1024, ...options };
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get undoLabel(): string | undefined { return this.undoStack.at(-1)?.label; }
  get redoLabel(): string | undefined { return this.redoStack.at(-1)?.label; }
  get size(): number { return this.undoStack.length; }
  get bytes(): number { return this.totalBytes; }

  /** コマンドを実行して記録する。 */
  execute(cmd: Command): void {
    cmd.apply(this.store);
    this.push(cmd);
  }

  /** すでに反映済みの変更を記録だけする(スライダーのドラッグや塗りのストローク)。 */
  push(cmd: Command): void {
    for (const c of this.redoStack) this.totalBytes -= c.bytes;
    this.redoStack = [];
    this.undoStack.push(cmd);
    this.totalBytes += cmd.bytes;
    while (this.undoStack.length > this.options.maxSteps || (this.totalBytes > this.options.maxBytes && this.undoStack.length > 1)) {
      this.totalBytes -= this.undoStack.shift()!.bytes;
    }
    this.emit('change', undefined);
  }

  undo(): boolean {
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    cmd.revert(this.store);
    this.redoStack.push(cmd);
    this.emit('change', undefined);
    return true;
  }

  redo(): boolean {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    cmd.apply(this.store);
    this.undoStack.push(cmd);
    this.emit('change', undefined);
    return true;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.totalBytes = 0;
    this.emit('change', undefined);
  }
}
