// SPDX-License-Identifier: MIT
//
// グリッド配置（#57 の段階1）。**位置と大きさ**を持つペインの置き方。
//
// なぜ `panelayout.mjs` と別か:
//   あちらは v1（4つの固定の入れ物に並べる）で、`app.html` がまだ使っている。
//   グリッドは「閉じる・新規に開く・広げる」を入れるための別の表現なので、
//   **片方を壊さずに並べて置けるように**別ファイルにする。
//   段階2（描画をグリッドに移す）が終わったら v1 を消す。
//
// 🚨 **ペインの id は序数ではなく worktree の path 由来**（CLAUDE.md）。
//    セル座標に id を紐付けるので、ここを間違えると
//    「ヘッダは agent-a なのに中身は agent-b」に直結する。
// ⚠️ ここは DOM も localStorage も触らない**純関数だけ**。
//    「どう描くか」は app.html、「どこに置くか」はここ。

/** 覚えておく id の上限（`panelayout.mjs` の MAX_REMEMBERED と同じ理由・同じ値） */
export const MAX_REMEMBERED = 300;

/**
 * グリッドの最大。**4×4 = 16 セルまで**（#57）。
 *
 * ⚠️ 上限の根拠は quota ではなく**画面**。スマホは1列に畳むのでセルを増やしても
 *    縦に伸びるだけ、母艦（1280px）で 4 列より細くするとコンソールの1行が
 *    折り返して「最後の出力」が読めない（390px で測っている教訓と同じ）。
 */
export const GRID_MAX = 4;

/** 既定のグリッド（今の見た目に近い 3 列 × 2 行） */
export const GRID_DEFAULT = { cols: 3, rows: 2 };

const inRange = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;

/**
 * セル1つの形が正しいか（範囲とはみ出し）。
 *
 * ⚠️ はみ出しは「無効」にする。**黙って縮めない** — 縮めると利用者が置いた
 *    大きさと画面が食い違い、「広げたのに広がらない」を説明できなくなる。
 */
function validCell(c, cols, rows) {
    if (!c || typeof c.id !== 'string' || c.id === '') return false;
    if (!inRange(c.col, 1, cols) || !inRange(c.row, 1, rows)) return false;
    if (!inRange(c.cw, 1, cols) || !inRange(c.ch, 1, rows)) return false;
    return c.col + c.cw - 1 <= cols && c.row + c.ch - 1 <= rows;
}

/** 2つのセルが重なるか（半開区間で比べる） */
export function cellsOverlap(a, b) {
    return a.col < b.col + b.cw && b.col < a.col + a.cw
        && a.row < b.row + b.ch && b.row < a.row + a.ch;
}

/** 空のグリッド */
export function emptyGrid() {
    return { v: 2, cols: GRID_DEFAULT.cols, rows: GRID_DEFAULT.rows, cells: [], closed: [] };
}

const cloneGrid = g => ({
    v: 2,
    cols: g?.cols ?? GRID_DEFAULT.cols,
    rows: g?.rows ?? GRID_DEFAULT.rows,
    cells: (g?.cells ?? []).map(c => ({ ...c })),
    closed: [...(g?.closed ?? [])],
});

/**
 * 保存された文字列をグリッド配置として読む。
 *
 * 🚨 **壊れていても throw しない**（v1 と同じ理由。ここで throw すると
 *    モジュールの評価が止まり**ページが真っ白**になる。
 *    並びの記憶という些末な機能のために UI 全体を失わない）。
 * 🚨 **重なりと重複は「後から来た方を落とす」。** 残すと「どちらが本物か」が
 *    配列順という無関係な理由で決まり、`hostOf` で踏んだ嘘と同じ形になる。
 *    落ちた id は配置なしとして扱われ、`autoPlace` が空きに置く
 *    （= 消えるのではなく既定の位置に戻る）。
 */
export function parseGrid(text) {
    const out = emptyGrid();
    if (typeof text !== 'string' || text === '') return out;
    let raw;
    try { raw = JSON.parse(text); } catch { return out; }
    if (!raw || typeof raw !== 'object') return out;
    // v1（入れ物の形）を黙ってグリッドとして読まない。移行は migrateV1 が明示的に行う
    if (raw.v !== 2) return out;
    out.cols = inRange(raw.cols, 1, GRID_MAX) ? raw.cols : GRID_DEFAULT.cols;
    out.rows = inRange(raw.rows, 1, GRID_MAX) ? raw.rows : GRID_DEFAULT.rows;
    const seen = new Set();
    for (const c of Array.isArray(raw.cells) ? raw.cells : []) {
        const cell = {
            id: typeof c?.id === 'string' ? c.id : '',
            col: c?.col, row: c?.row,
            cw: c?.cw ?? 1, ch: c?.ch ?? 1,
        };
        if (!validCell(cell, out.cols, out.rows)) continue;
        if (seen.has(cell.id)) continue;
        if (out.cells.some(o => cellsOverlap(o, cell))) continue;
        seen.add(cell.id);
        out.cells.push(cell);
    }
    for (const id of Array.isArray(raw.closed) ? raw.closed : []) {
        if (typeof id === 'string' && id !== '' && !out.closed.includes(id)) out.closed.push(id);
    }
    return out;
}

export function serializeGrid(grid) {
    const g = cloneGrid(grid);
    return JSON.stringify({
        v: 2, cols: g.cols, rows: g.rows,
        cells: g.cells.map(c => ({ id: c.id, col: c.col, row: c.row, cw: c.cw, ch: c.ch })),
        closed: g.closed,
    });
}

/** その範囲が空いているか（`exceptId` は自分自身なので無視する） */
export function cellFree(grid, want, exceptId = null) {
    if (!validCell(want, grid.cols, grid.rows)) return false;
    return !(grid.cells ?? []).some(c => c.id !== exceptId && cellsOverlap(c, want));
}

/** そのペインの配置（無ければ null） */
export function cellOf(grid, id) {
    return (grid?.cells ?? []).find(c => c.id === id) ?? null;
}

/**
 * 置き場所の無い id を、空いているセルに読み順（左上から）で置く。
 *
 * 🚨 **入り切らないものは黙って捨てない。** `overflow` で返して、
 *    呼び出し側が「他 N 本は表示していません」と告知する
 *    （CLAUDE.md「表示上限で省略したら必ず告知する」）。
 * 🚨 **閉じたものは自動で開かない。** 開き直すと閉じる操作の意味が消える
 *    （15秒ごとの更新で戻ってくるのが一番いらない挙動）。
 * ⚠️ 今存在しない id の配置は**残す**（差分が一時的に消えた worktree の
 *    位置を失わない。v1 の `orderedIds` と同じ方針）。
 * @returns {{grid: object, overflow: string[]}}
 */
export function autoPlace(grid, ids) {
    const g = cloneGrid(grid);
    const placed = new Set(g.cells.map(c => c.id));
    const overflow = [];
    for (const id of Array.isArray(ids) ? ids : []) {
        if (typeof id !== 'string' || id === '') continue;
        if (placed.has(id) || g.closed.includes(id)) continue;
        let at = null;
        for (let row = 1; row <= g.rows && !at; row++) {
            for (let col = 1; col <= g.cols && !at; col++) {
                const want = { id, col, row, cw: 1, ch: 1 };
                if (cellFree(g, want)) at = want;
            }
        }
        if (!at) { overflow.push(id); continue; }
        g.cells.push(at);
        placed.add(id);
    }
    return { grid: g, overflow };
}

/**
 * ペインを動かす。
 *
 * ⚠️ **重なる移動は通さない。** 通すと2枚が同じセルに描かれて片方が見えない
 *    = 見えないペインが走り続ける（観測ツールとして最悪）。
 * ⚠️ ただし**同じ大きさの相手とは入れ替える**（ドラッグの自然な期待）。
 *    大きさが違う相手や複数に重なる移動は、置き方が一意に決まらないので拒否して
 *    理由を返す（呼び出し側が出す）。
 * @returns {{grid: object, ok: boolean, why: string|null}}
 */
export function moveCell(grid, id, want) {
    const g = cloneGrid(grid);
    const me = g.cells.find(c => c.id === id);
    if (!me) return { grid, ok: false, why: 'そのペインは配置されていません' };
    const target = {
        id, col: want?.col, row: want?.row,
        cw: want?.cw ?? me.cw, ch: want?.ch ?? me.ch,
    };
    if (!validCell(target, g.cols, g.rows)) {
        return { grid, ok: false, why: 'グリッドの外にはみ出します' };
    }
    const hit = g.cells.filter(c => c.id !== id && cellsOverlap(c, target));
    if (hit.length === 0) {
        return { grid: { ...g, cells: g.cells.map(c => (c.id === id ? target : c)) }, ok: true, why: null };
    }
    if (hit.length === 1 && hit[0].cw === target.cw && hit[0].ch === target.ch) {
        const other = hit[0];
        const from = { col: me.col, row: me.row };
        const cells = g.cells.map(c => {
            if (c.id === id) return target;
            if (c.id === other.id) return { ...c, col: from.col, row: from.row };
            return c;
        });
        return { grid: { ...g, cells }, ok: true, why: null };
    }
    return {
        grid, ok: false,
        why: '置き先に別のペインがあります（大きさが違うので入れ替えられません）',
    };
}

/**
 * 大きさを変える（2セル分に広げる / 1セルに戻す）。
 *
 * ⚠️ 広げる先に他が居るなら拒否する。押しのけると配置が連鎖的に崩れて
 *    「元に戻せない」状態になる（利用者が置いた配置を壊さない）。
 */
export function resizeCell(grid, id, cw, ch) {
    const g = cloneGrid(grid);
    const me = g.cells.find(c => c.id === id);
    if (!me) return { grid, ok: false, why: 'そのペインは配置されていません' };
    const want = { ...me, cw, ch };
    if (!validCell(want, g.cols, g.rows)) {
        return { grid, ok: false, why: 'グリッドの外にはみ出します' };
    }
    if (!cellFree(g, want, id)) {
        return { grid, ok: false, why: '広げる先に別のペインがあります' };
    }
    return {
        grid: { ...g, cells: g.cells.map(c => (c.id === id ? want : c)) },
        ok: true, why: null,
    };
}

/**
 * 閉じる。**閉じたことを覚える**（自動で開き直さない）。
 *
 * 🚨 これが無いと 15 秒ごとの更新で閉じたペインが毎回戻ってくる
 *    （利用者の操作を巻き戻すのは、このリポジトリで何度も踏んだ型）。
 */
export function closeCell(grid, id) {
    const g = cloneGrid(grid);
    if (!g.closed.includes(id)) g.closed.push(id);
    return { ...g, cells: g.cells.filter(c => c.id !== id) };
}

/** 閉じたものを開く（置き場所は `autoPlace` が決める） */
export function openCell(grid, id) {
    const g = cloneGrid(grid);
    return { ...g, closed: g.closed.filter(x => x !== id) };
}

/** 閉じているか */
export function isClosed(grid, id) {
    return (grid?.closed ?? []).includes(id);
}

/**
 * グリッドの大きさを変える。
 *
 * ⚠️ **縮めるとはみ出すセルが出る。** 黙って縮めず、はみ出すものは配置から外して
 *    `dropped` で返す（`autoPlace` が空きに置き直すか、入り切らなければ
 *    `overflow` として告知される）。**どちらにしても黙って消えない**。
 * @returns {{grid: object, dropped: string[]}}
 */
export function resizeGrid(grid, cols, rows) {
    const g = cloneGrid(grid);
    const c = inRange(cols, 1, GRID_MAX) ? cols : g.cols;
    const r = inRange(rows, 1, GRID_MAX) ? rows : g.rows;
    const kept = [];
    const dropped = [];
    for (const cell of g.cells) {
        if (validCell(cell, c, r)) kept.push(cell);
        else dropped.push(cell.id);
    }
    return { grid: { ...g, cols: c, rows: r, cells: kept }, dropped };
}

/**
 * 覚えている配置を上限まで削る（v1 の `pruneLayout` と同じ理由）。
 *
 * ⚠️ 今存在するものは残す。閉じた記録も同じ上限で削る
 *    （消えた worktree の「閉じた」を永久に覚えていても意味が無い）。
 */
export function pruneGrid(grid, present, cap = MAX_REMEMBERED) {
    const g = cloneGrid(grid);
    const total = g.cells.length + g.closed.length;
    if (total <= cap) return grid;
    let drop = total - cap;
    const keep = new Set(present ?? []);
    const cells = g.cells.filter(c => {
        if (drop === 0 || keep.has(c.id)) return true;
        drop--;
        return false;
    });
    const closed = g.closed.filter(id => {
        if (drop === 0 || keep.has(id)) return true;
        drop--;
        return false;
    });
    return { ...g, cells, closed };
}

/**
 * v1（入れ物 + 並び）の配置をグリッドへ移す。
 *
 * 🚨 **利用者の並びを黙って捨てない。** `parseGrid` は v1 の文字列を
 *    「配置なし」に落とすので、移行を通さないと**移した位置が1回全部消える**。
 *    入れ物 → 列の対応は今の見た目に合わせる:
 *      left → 1列目 / diffs → 2列目の上 / consoles → 2列目の下 / right → 3列目
 * ⚠️ 入り切らない分は配置しない（`autoPlace` が空きに置き、
 *    それでも入らなければ `overflow` として告知される）。
 */
export function migrateV1(layout) {
    const g = emptyGrid();
    const put = (ids, col, row, span) => {
        let r = row;
        for (const id of Array.isArray(ids) ? ids : []) {
            if (r > row + span - 1) break;
            const cell = { id, col, row: r, cw: 1, ch: 1 };
            if (validCell(cell, g.cols, g.rows) && cellFree(g, cell)) g.cells.push(cell);
            r++;
        }
    };
    put(layout?.left, 1, 1, g.rows);
    put(layout?.diffs, 2, 1, 1);
    put(layout?.consoles, 2, 2, 1);
    put(layout?.right, 3, 1, g.rows);
    return g;
}

// ---------------------------------------------------------------------------
// パターン（プリセット）と結合（#57）
//
// 🚨 **座標を手で決めさせない。** 「どこに何列あるか」を毎回ドラッグで作るのは
//    スマホでは無理（細い画面で 16 セルの当たり判定は押せない）。
//    使う形は決まっている（1枚 / 1行2列 / 1行3列 / 2×2 … 4×4）ので、
//    **選ぶ**形にして、そこから結合（2セル分）で微調整する。
// ---------------------------------------------------------------------------

/**
 * 選べるパターン。**名前は保存に載る**ので変えない（変えると古い保存が読めなくなる）。
 *
 * ⚠️ 行 × 列の順で読む名前にしない（`1x2` は「1行2列」）。
 *    ここを取り違えると、選んだ形と出る形が食い違う。
 */
export const GRID_PRESETS = [
    { name: '1x1', label: '1枚', cols: 1, rows: 1 },
    { name: '1x2', label: '1行2列', cols: 2, rows: 1 },
    { name: '1x3', label: '1行3列', cols: 3, rows: 1 },
    { name: '2x2', label: '2×2', cols: 2, rows: 2 },
    { name: '2x3', label: '2行3列', cols: 3, rows: 2 },
    { name: '3x3', label: '3×3', cols: 3, rows: 3 },
    { name: '4x4', label: '4×4', cols: 4, rows: 4 },
];

/** 名前からパターンを引く（知らない名前は null） */
export function presetByName(name) {
    return GRID_PRESETS.find(p => p.name === name) ?? null;
}

/** 今のグリッドに当てはまるパターンの名前（無ければ null） */
export function presetOf(grid) {
    const p = GRID_PRESETS.find(x => x.cols === grid?.cols && x.rows === grid?.rows);
    return p ? p.name : null;
}

/**
 * パターンを当てる。
 *
 * 🚨 **並びを保つ。** 今の配置の読み順（左上から）を維持して詰め直す。
 *    順序を捨てると「形を変えたらペインの並びが総入れ替え」になり、
 *    どれがどれだか分からなくなる（並列で回しているときに一番困る）。
 * 🚨 **結合（cw/ch）は落とす。** 新しい形に入るとは限らないので 1×1 に戻す。
 *    ⚠️ 黙って落とさず、戻した件数を `unmerged` で返して呼び出し側が告げる。
 * ⚠️ 入り切らない分は `overflow`（`autoPlace` と同じ扱い）。
 * @returns {{grid: object, overflow: string[], unmerged: number}}
 */
export function applyPreset(grid, name, ids) {
    const p = presetByName(name);
    if (!p) return { grid, overflow: [], unmerged: 0 };
    // 今の読み順（行 → 列）。配置が無いものは呼び出し側が渡した順の後ろに付ける
    const placed = [...(grid?.cells ?? [])]
        .sort((a, b) => (a.row - b.row) || (a.col - b.col))
        .map(c => c.id);
    const rest = (Array.isArray(ids) ? ids : []).filter(id => !placed.includes(id));
    const order = [...placed, ...rest];
    const unmerged = (grid?.cells ?? []).filter(c => c.cw > 1 || c.ch > 1).length;
    const fresh = {
        v: 2, cols: p.cols, rows: p.rows, cells: [],
        closed: [...(grid?.closed ?? [])],
    };
    const out = autoPlace(fresh, order);
    return { grid: out.grid, overflow: out.overflow, unmerged };
}

/**
 * 隣のセルと結合する（そのペインを2セル分に広げる）。
 *
 * ⚠️ `resizeCell` の薄い包み。方向を受け取るのは、UI が「右と結合／下と結合」
 *    のような**押せるボタン**にしたいため（座標を手で入れさせない）。
 * @param {'right'|'down'} dir
 */
export function mergeCell(grid, id, dir) {
    const me = cellOf(grid, id);
    if (!me) return { grid, ok: false, why: 'そのペインは配置されていません' };
    if (dir === 'right') return resizeCell(grid, id, me.cw + 1, me.ch);
    if (dir === 'down') return resizeCell(grid, id, me.cw, me.ch + 1);
    return { grid, ok: false, why: `知らない方向です: ${dir}` };
}

/**
 * 結合を解く（1セルに戻す）。
 *
 * ⚠️ **必ず成功する**（縮めるだけなので他とぶつからない）。
 *    空いたセルには `autoPlace` が溢れていたペインを置く。
 */
export function splitCell(grid, id) {
    return resizeCell(grid, id, 1, 1);
}
