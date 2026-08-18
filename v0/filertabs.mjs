// SPDX-License-Identifier: MIT
//
// ファイラのタブ（素 = コミット済み / `*` = 未コミット / `+` = 未追跡）の組み立てと、
// 「押されたタブで何を読むか」の判断。
//
// 🚨 **なぜ app.html の外に置くか。**
//    `app.html` の中に書いたロジックは**テストできない = 宣言が破れても気付けない**
//    （`ndjson.mjs` / `argv.mjs` / `chatfilter.mjs` と同じ理由）。
//    実際、ここは中に書いていたせいで**レビュー13 で3件の欠陥が同時に出た**:
//      1. 振り分けを「押されたタブ」ではなく**集合の所属**で決めていたので、
//         同じファイルがコミット済み差分にも未コミット変更にもあるとき
//         （= エージェントがコミットしてから編集を続ける、**このツールの中心的な場面**）
//         素タブを押しても HEAD ↔ 作業ツリーの差分が出た。
//         **印と中身が食い違い、コミット済み差分には二度と辿り着けなかった。**
//      2. 復元を `files`（コミット済み）からしか探していなかったので、
//         `*` や `+` を選んでいると 15 秒ごとの自動更新で**選択が先頭に飛んだ**。
//      3. 点灯の照合が `title` の一致だったが、`*` / `+` のタブは title に注釈を
//         足しているので**一致せず、`*` を押すと素タブが光った**。
//
// 🔒 **ここは表示の判断だけ。** 認可も fetch もしない（サーバ側の門が本体）。

/** 1種類あたりのタブの上限。超えた分は件数で告知する（黙って省略しない）。 */
export const TAB_LIMIT = 6;

/** タブの種別。**この3つ以外を作らない**（増やすと印と中身の対応が崩れる）。 */
export const KINDS = ['committed', 'dirty', 'untracked'];

/**
 * タブを組み立てる。
 *
 * ⚠️ **3種類を同じ場所で切る。** 別々の場所で切ると、復元が
 * 「画面に出ていないファイル」を選び直せてしまう。
 *
 * @param {object} wt payload の worktree（`files` / `dirtyFiles` / `untracked` と
 *   サーバ側で切った残数 `dirtyMore` / `untrackedMore`）
 * @param {number} [limit]
 * @returns {{tabs: {kind: string, path: string, label: string, title: string}[],
 *            hiddenDirty: number, hiddenUntracked: number}}
 */
export function buildTabs(wt, limit = TAB_LIMIT) {
    const files = (wt?.files ?? []).slice(0, limit);
    const dirty = (wt?.dirtyFiles ?? []).slice(0, limit);
    const untracked = (wt?.untracked ?? []).slice(0, limit);
    const leaf = p => String(p).split('/').pop();
    const tabs = [
        ...files.map(f => ({
            kind: 'committed', path: f.path,
            label: leaf(f.path), title: f.path,
        })),
        ...dirty.map(p => ({
            kind: 'dirty', path: p,
            label: `*${leaf(p)}`, title: `${p}（未コミットの変更）`,
        })),
        ...untracked.map(p => ({
            kind: 'untracked', path: p,
            label: `+${leaf(p)}`, title: `${p}（未追跡。まだ git に入っていません）`,
        })),
    ];
    // 🚨 **省略したら必ず告げる。** 画面で切った分（`length - limit`）と、
    //    サーバが既に切った分（`*More`）の**両方**を足す。片方だけだと
    //    「全部見えている」と読める表示になる（この repo が端末の告知で踏んだ型）。
    return {
        tabs,
        hiddenDirty: Math.max(0, (wt?.dirtyFiles?.length ?? 0) - dirty.length)
            + (wt?.dirtyMore ?? 0),
        hiddenUntracked: Math.max(0, (wt?.untracked?.length ?? 0) - untracked.length)
            + (wt?.untrackedMore ?? 0),
    };
}

/** タブの同一性。**`title` で照合しない**（注釈が付くので一致しない）。 */
export function tabKey(kind, path) {
    return kind + '::' + path;
}

/**
 * 前回の選択を復元する。無ければ先頭のタブ。
 *
 * 🚨 **種別まで見て復元する。** パスだけで探すと、同じパスが2種類のタブに
 * 出ているとき（コミット済み + 未コミット）に別のタブへ移る。
 *
 * ⚠️ コミット済み差分が無くても未コミット / 未追跡があるなら**そちらを選ぶ**。
 * `files` だけを見ていると「base と同じ内容です」と出て、`*` タブが並んでいるのに
 * **嘘の説明**になる。
 *
 * @param {{kind: string, path: string}[]} tabs
 * @param {{path: string, kind?: string}|null} prev 同じ worktree での前回の選択
 * @returns {{path: string, kind: string}|null} タブが1つも無ければ null
 */
export function restoreSelection(tabs, prev) {
    const list = tabs ?? [];
    if (prev?.path) {
        // 種別が分からない古い状態（`kind` を持つ前の選択）は committed として扱う
        const kind = prev.kind ?? 'committed';
        const hit = list.find(t => t.path === prev.path && t.kind === kind);
        if (hit) return { path: hit.path, kind: hit.kind };
    }
    const first = list[0];
    return first ? { path: first.path, kind: first.kind } : null;
}

/**
 * 選択中のタブで**何を読むか**を決める。
 *
 * 🚨 **押されたタブの種別で決める。集合の所属で決めない**（冒頭の欠陥1）。
 *
 * @param {string|null} kind タブの種別。`'auto'` / 未指定なら所属から推定する
 *   （他のカードからの遷移 `openDiff()` は種別を知らないので、そこだけ推定に頼る）
 * @param {string} mode 'diff' | 'blob'
 * @param {object} wt 推定に使う payload（kind が 'auto' のときだけ読む）
 * @param {string} path
 * @returns {'untracked'|'worktree-diff'|'blob'|'diff'}
 */
export function viewFor(kind, mode, wt, path) {
    const k = (!kind || kind === 'auto')
        ? ((wt?.untracked ?? []).includes(path) ? 'untracked'
            : (wt?.dirtyFiles ?? []).includes(path) ? 'dirty' : 'committed')
        : kind;
    // 未追跡は git オブジェクトに無いので「全文」を選んでいても読み方は1つ
    if (k === 'untracked') return 'untracked';
    // ⚠️ 「全文」を選んでいるときは未コミットでも git の中身を読む
    //    （ref を選べることの意味を保つ）
    if (k === 'dirty' && mode !== 'blob') return 'worktree-diff';
    return mode === 'blob' ? 'blob' : 'diff';
}
