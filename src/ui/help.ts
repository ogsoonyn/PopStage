/**
 * 項目の説明。説明は画面に並べず、項目の横の「?」で開く(ツールチップと違い、指でも読み上げでも届く)。
 * HTML では <button class="help-btn" data-help="説明の id"> と <p id="説明の id" class="help-text" hidden> を置く。
 * 説明の中身を状態に合わせて変える(重ね方・プリセットなど)ときは、その <p> の文字を書き換えればよい。
 */
export function bindHelpButton(btn: HTMLButtonElement, text: HTMLElement): void {
  btn.type = 'button';
  btn.textContent = '?';
  btn.setAttribute('aria-label', '説明を表示');
  btn.setAttribute('aria-controls', text.id);
  btn.setAttribute('aria-expanded', String(!text.hidden));
  btn.addEventListener('click', e => {
    e.preventDefault(); // <label> や <summary> の中に置いても、そちらは動かさない
    e.stopPropagation();
    text.hidden = !text.hidden;
    btn.setAttribute('aria-expanded', String(!text.hidden));
    btn.setAttribute('aria-label', text.hidden ? '説明を表示' : '説明を隠す');
  });
}

/** 画面にある「?」をまとめて結び付ける。説明が無ければ起動時に例外にする */
export function bindHelp(root: ParentNode = document): void {
  for (const btn of root.querySelectorAll<HTMLButtonElement>('button.help-btn[data-help]')) {
    const text = document.getElementById(btn.dataset.help!);
    if (!text) throw new Error(`説明 #${btn.dataset.help} がありません`);
    bindHelpButton(btn, text);
  }
}

/** 「?」と説明を作る(panels.ts で作る揺らし方の固有設定などに使う) */
export function createHelp(id: string, content: string): { button: HTMLButtonElement; text: HTMLParagraphElement } {
  const text = Object.assign(document.createElement('p'), { id, className: 'help-text', hidden: true, textContent: content });
  const button = Object.assign(document.createElement('button'), { className: 'help-btn' });
  bindHelpButton(button, text);
  return { button, text };
}
