// SPDX-License-Identifier: MIT
//
// 記録から観測したパスを画面に出すときの文字を決める。
// ブラウザと unit テストで共有する（app.html の中に置くとテストできない。
// ndjson.mjs / argv.mjs / chatfilter.mjs を切り出したのと同じ理由）。
//
// 🚨 **これが「外を触った」と断言してよい唯一の場所。**（8回目のレビュー。SERIOUS）
//    `app.html` は `path` が無いときに一律 `(リポジトリ外)` と出していたが、
//    `path` が無い理由は5つあり、そのうち**2つはリポジトリの中**だった:
//
//      outside   … 本当に worktree の外                → 「外」と言ってよい
//      root      … worktree ルート自身（`Grep`/`Glob` の `path` にルートを渡す形）
//      unsafe    … 中にあるが表示できない形（先頭が `-` や `:` のファイル名）
//      unknown   … 判定できなかった
//      unresolved… 相対パスの基準（レコードの cwd）が無くて解決できなかった
//
//    観測ツールが「エージェントがリポジトリ外を触った」と誤って断定するのは、
//    安全の判断を誤らせる最悪の嘘なので、**理由ごとに別の文字を出す**
//    （CLAUDE.md「『調べられない』と『無い』を型で分ける」）。
//
// ⚠️ ここは表示の**文字**を決めるだけ。判定は `transcript.mjs` の `repoRelative` /
//    `observedPath` が型（別フィールド）で持っている。

/**
 * `recent[]` の1件から、パスの代わりに出す文字を返す。
 *
 * @param {{path?: string|null, outside?: boolean, pathRoot?: boolean,
 *          pathUnsafe?: boolean, pathUnknown?: boolean,
 *          pathUnresolved?: boolean}} r
 * @returns {string} 出す文字（パスがあるとき・何も言うことが無いときは空文字）
 */
export function pathLabel(r) {
    if (!r || typeof r !== 'object') return '';
    if (typeof r.path === 'string' && r.path) return r.path;
    if (r.outside === true) return '(リポジトリ外)';
    if (r.pathRoot === true) return '(worktree ルート)';
    if (r.pathUnsafe === true) return '(パスを表示できません)';
    if (r.pathUnresolved === true) return '(相対パスの基準が不明)';
    if (r.pathUnknown === true) return '(パスを判定できません)';
    return '';
}
