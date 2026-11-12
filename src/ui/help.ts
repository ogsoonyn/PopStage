/**
 * 項目の説明。説明は画面に並べず、項目の横の「?」で開く(ツールチップと違い、指でも読み上げでも届く)。
 * HTML では <button class="help-btn" data-help="説明の id"> と <p id="説明の id" class="help-text" hidden> を置く。
 * 説明の中身を状態に合わせて変える(重ね方・プリセットなど)ときは、その <p> の文字を書き換えればよい。
 */
export function bindHelpButton(btn: HTMLButtonElement, text: HTMLElement, name = helpName(btn)): void {
  btn.type = 'button';
  btn.textContent = '?';
  // 読み上げでどの項目の説明か分かるよう、項目名を入れる。開いているかは aria-expanded で伝える
  btn.setAttribute('aria-label', name ? `${name}の説明` : '説明');
  btn.setAttribute('aria-controls', text.id);
  btn.setAttribute('aria-expanded', String(!text.hidden));
  btn.addEventListener('click', e => {
    e.preventDefault(); // <label> や <summary> の中に置いても、そちらは動かさない
    e.stopPropagation();
    text.hidden = !text.hidden;
    btn.setAttribute('aria-expanded', String(!text.hidden));
  });
  // 名前の <label for> が指す入力欄からも、説明をたどれるようにする
  const label = btn.previousElementSibling;
  const control = label instanceof HTMLLabelElement ? label.control : null;
  if (control) control.setAttribute('aria-describedby', text.id);
}

/** 「?」の前にある項目名(<label>・見出し、または同じ入れ物の文字) */
function helpName(btn: HTMLButtonElement): string {
  return (btn.previousElementSibling?.textContent ?? btn.parentElement?.textContent ?? '').trim();
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
export function createHelp(id: string, name: string, content: string): { button: HTMLButtonElement; text: HTMLParagraphElement } {
  const text = Object.assign(document.createElement('p'), { id, className: 'help-text', hidden: true, textContent: content });
  const button = Object.assign(document.createElement('button'), { className: 'help-btn' });
  bindHelpButton(button, text, name);
  return { button, text };
}
