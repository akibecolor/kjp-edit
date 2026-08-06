// SPDX-License-Identifier: MIT
//
// ペインの並び（利用者がドラッグで決めた配置）の表現と永続化の形。
//
// なぜ app.html の中ではなくここにあるか:
//   `app.html` の中に置いたロジックはテストできない = 宣言が破れても気付けない
//   （`ndjson.mjs` / `argv.mjs` / `chatfilter.mjs` と同じ理由）。
//   ここは DOM も localStorage も触らない純関数だけにして、
//   「どこへ置くか」「どの順に並べるか」を単体テストで固定する。
//
// 🚨 **ペインの id は序数ではなく worktree の path 由来**（CLAUDE.md）。
//    序数を保存すると、払い出し順が変わった瞬間に別のペインの位置を復元して
//    「ヘッダは agent-a なのに中身は agent-b」と同じ型の嘘になる。
//    ここが受け取るのは常に `data-pane-id` の文字列。

/** ペインを置ける入れ物（`app.html` の #left / #diffs / #consoles / #right）。 */
export const PANE_HOSTS = ['left', 'diffs', 'consoles', 'right'];

/**
 * 覚えておく id の上限。
 *
 * ⚠️ worktree は使い捨てなので、上限が無いと消えた worktree の id が
 *    localStorage に永久に溜まる（`console-<絶対パス>` なので1件100〜200バイト）。
 *    **これは quota（オリジンあたり数MB）を測って決めた値ではない** —
 *    300件でも数十KBで quota には遠く届かない。**記録を有界に保つためだけ**の上限。
 * ⚠️ 上限を超えたときだけ「今存在しないもの」から捨てる。常に捨てると、
 *    一時的に消えているペイン（差分が無くなった worktree）の位置を毎回失う。
 */
export const MAX_REMEMBERED = 300;

function emptyLayout() {
    const out = {};
    for (const h of PANE_HOSTS) out[h] = [];
    return out;
}

/**
 * 保存された文字列を読む。壊れていたら「配置なし」にする。
 *
 * ⚠️ 読めなかったことを例外にしてはいけない。ここで throw すると
 *    モジュールの評価が止まり、**ページが真っ白**になる（並びの記憶という
 *    些末な機能のために UI 全体を失う）。
 */
export function parseLayout(text) {
    const out = emptyLayout();
    if (typeof text !== 'string' || text === '') return out;
    let raw;
    try { raw = JSON.parse(text); } catch { return out; }
    if (!raw || typeof raw !== 'object') return out;
    // 🚨 同じ id が2度（同じ入れ物でも別の入れ物でも）出ていると、
    //    「どちらの位置が本物か」が PANE_HOSTS の順という**無関係な理由**で決まる。
    //    先に出た方だけを採って、残りは無かったことにする。
    const claimed = new Set();
    for (const h of PANE_HOSTS) {
        if (!Array.isArray(raw[h])) continue;
        for (const id of raw[h]) {
            if (typeof id !== 'string' || id === '' || claimed.has(id)) continue;
            claimed.add(id);
            out[h].push(id);
        }
    }
    return out;
}

export function serializeLayout(layout) {
    const out = {};
    for (const h of PANE_HOSTS) out[h] = [...(layout[h] ?? [])];
    return JSON.stringify(out);
}

/**
 * そのペインを置く入れ物。保存された配置が無ければ既定（作った側が指定した場所）。
 *
 * 🚨 **既定で上書きしてはいけない。** ここが既定を返し続けると、
 *    15秒ごとの自動更新が利用者の移動を毎回巻き戻す。
 */
export function hostOf(layout, paneId, defaultHost) {
    for (const h of PANE_HOSTS) {
        if ((layout[h] ?? []).includes(paneId)) return h;
    }
    return defaultHost;
}

/**
 * その入れ物に並べる順序を決める。
 *
 * 保存されている id は保存された順、保存に無い id（新しく現れたペイン）は
 * 呼び出し側が渡した既定の順のまま後ろに付ける。
 * ⚠️ 保存に無いものを前に置くと、worktree が1本増えるたびに
 *    利用者が決めた並びの**先頭が入れ替わる**。
 */
export function orderedIds(layout, hostId, ids) {
    const rank = new Map();
    (layout[hostId] ?? []).forEach((id, i) => rank.set(id, i));
    const known = [], fresh = [];
    for (const id of ids) (rank.has(id) ? known : fresh).push(id);
    known.sort((a, b) => rank.get(a) - rank.get(b));
    return [...known, ...fresh];
}

/**
 * 入れ物の並びを丸ごと記録する（ドラッグを確定したときに呼ぶ）。
 *
 * 🚨 **他の入れ物の記録から必ず消す。** 消さないと1つの id が2箇所に載り、
 *    hostOf が PANE_HOSTS の順で先に見つけた方を返すので、
 *    **移動したはずのペインが元の列に戻る**（列をまたぐ移動が
 *    再読込で失われる形の壊れ方）。
 */
export function setHostOrder(layout, hostId, ids) {
    if (!PANE_HOSTS.includes(hostId)) return layout;
    const out = {};
    const moved = new Set(ids);
    for (const h of PANE_HOSTS) {
        out[h] = h === hostId ? [...ids] : (layout[h] ?? []).filter(id => !moved.has(id));
    }
    return out;
}

/**
 * 覚えている id を上限まで削る。今存在しないものから捨てる。
 *
 * @param present 今ペインとして存在する id の集合
 */
export function pruneLayout(layout, present, cap = MAX_REMEMBERED) {
    const total = PANE_HOSTS.reduce((n, h) => n + (layout[h] ?? []).length, 0);
    if (total <= cap) return layout;
    let drop = total - cap;
    const out = {};
    for (const h of PANE_HOSTS) {
        out[h] = (layout[h] ?? []).filter(id => {
            if (drop === 0 || present.has(id)) return true;
            drop--;
            return false;
        });
    }
    return out;
}
