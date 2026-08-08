// SPDX-License-Identifier: MIT
//
// 配色（ダーク / ライト）の判定と、コントラストの実測。
//
// ⚠️ **`app.html` の中に置かない**（CLAUDE.md）。中に置くとテストできないので、
//    「切り替わる」「読める」という宣言が破れても気付けない。
//
// 🚨 **「色を用意した」と「読める」は別。** ダーク用に選んだ色をライトに流用すると
//    白地の上で `--warn: #cca700` のように**淡すぎて読めない**ものが出る。
//    だから比（WCAG のコントラスト比）を計算できる形にして、
//    実ブラウザの検査が**実際に描かれている色**で測る。

/** 選べる値。`auto` は OS の設定に従う（既定） */
export const THEMES = ['auto', 'light', 'dark'];

/** 表示名（UI のボタンに出す） */
export const THEME_LABEL = { auto: '自動', light: 'ライト', dark: 'ダーク' };

/**
 * 次の値（ボタンを押したときの遷移）。auto → light → dark → auto。
 *
 * ⚠️ 知らない値は `auto` に戻す（localStorage は書き換えられうる）。
 */
export function nextTheme(cur) {
    const i = THEMES.indexOf(cur);
    return i === -1 ? 'auto' : THEMES[(i + 1) % THEMES.length];
}

/**
 * 実際に適用する配色を決める。
 *
 * @param {string|null} saved localStorage の値（壊れていてもよい）
 * @param {boolean} prefersDark OS がダークを望んでいるか
 * @returns {{choice: string, applied: 'light'|'dark'}}
 *   choice = 利用者が選んだ値（ボタンの表示用）/ applied = 実際に当てる配色
 */
export function resolveTheme(saved, prefersDark) {
    const choice = THEMES.includes(saved) ? saved : 'auto';
    if (choice === 'auto') return { choice, applied: prefersDark ? 'dark' : 'light' };
    return { choice, applied: choice };
}

/**
 * `getComputedStyle` が返す色を [r, g, b] にする。
 *
 * ⚠️ ブラウザは `rgb(30, 30, 30)` / `rgb(30 30 30 / 0.5)` / `#1e1e1e` のどれでも返しうる。
 *    解釈できない形は **null**（「読めた」と嘘をつかない）。
 */
export function parseColor(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (hex) {
        const h = hex[1].length === 3 ? [...hex[1]].map(c => c + c).join('') : hex[1];
        return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    }
    const m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (!m) return null;
    const nums = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (nums.length < 3 || nums.slice(0, 3).some(n => !Number.isFinite(n))) return null;
    return nums.slice(0, 3);
}

/** WCAG の相対輝度 */
function luminance([r, g, b]) {
    const f = c => {
        const x = c / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * コントラスト比（1〜21）。どちらかが解釈できなければ null。
 *
 * ⚠️ **null を「十分」と読まない。** 呼ぶ側は null を失敗として扱う
 *    （「測れなかった」を「読める」と言わないため）。
 */
export function contrastRatio(a, b) {
    const ca = parseColor(a);
    const cb = parseColor(b);
    if (!ca || !cb) return null;
    const la = luminance(ca);
    const lb = luminance(cb);
    const hi = Math.max(la, lb);
    const lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
}

/**
 * 検査が要求する最低値。
 *
 * 本文（`--fg`）は WCAG AA の 4.5、補助（`--dim`）と状態色（warn / ok / danger）は
 * **大きめの文字・アイコン相当**として 3.0 にしてある。
 * ⚠️ 数字は「守れそうな値」ではなく**守る値**として置く。下げるなら理由を書く。
 */
export const MIN_CONTRAST = { fg: 4.5, dim: 3, state: 3 };
