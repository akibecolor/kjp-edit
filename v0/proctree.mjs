// SPDX-License-Identifier: MIT
//
// プロセスの親子関係を扱う**純関数**。
//
// ⚠️ **ブラウザ用ではない。** サーバ（`v0/server.mjs`）と起動口（`scripts/serve.mjs`）の
//    両方が使うので、実装を1つにするためにここに置く。以前は `scripts/winargs.mjs`
//    にしか無く、**サーバ側の `killTree()` は「直接の子」しか数え直していなかった**
//    （9回目のレビュー。木から外れた孫が生きているのに「停止しました」と言っていた）。
//    片方にしか無い道具は、もう片方で「無いことに気付かない」形の穴になる。

/**
 * `pid<TAB>ppid` の行を読む（PowerShell / `ps` の出力）。
 *
 * ⚠️ 数値でない行（警告や空行）は捨てる。**捨てた行は数に入れない**ので、
 *    呼び出し側は「調べられたか」を別に持つこと（`{supported, …}`）。
 */
export function parseProcPairs(text) {
    return String(text ?? '').split('\n')
        .map(l => l.trim()).filter(Boolean)
        .map(l => l.split(/[\t ]+/))
        .filter(([a, b]) => /^\d+$/.test(a ?? '') && /^\d+$/.test(b ?? ''))
        .map(([a, b]) => ({ pid: Number(a), ppid: Number(b) }));
}

/**
 * プロセス表から、ある pid の**子孫を全部**返す。
 *
 * 🚨 「止めました」と言う前に木を数えるために要る。`taskkill /T /F` は
 *    **木ごと**落とすので、道連れになるのはデーモンだけではない。
 *    逆に、中間プロセスが先に死んだ孫は**木から外れている**ので
 *    `/T` では落ちず、直接の子だけを見ていると「停止しました」が嘘になる。
 * ⚠️ **循環で無限ループしない。** Windows では pid が再利用されるので、
 *    親子関係が輪を作った表（死んだ親の pid を新しいプロセスが持つ）を渡されうる。
 */
export function descendantsOf(pairs, pid) {
    const kids = new Map();
    for (const p of pairs ?? []) {
        if (!kids.has(p.ppid)) kids.set(p.ppid, []);
        kids.get(p.ppid).push(p.pid);
    }
    const seen = new Set([pid]);
    const out = [];
    const stack = [pid];
    while (stack.length) {
        const cur = stack.pop();
        for (const k of kids.get(cur) ?? []) {
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(k);
            stack.push(k);
        }
    }
    return out;
}

/**
 * 「まだ生きている pid」を数える（`process.kill(pid, 0)` で確かめる）。
 *
 * 🚨 **これが「数え直し」の本体。** 撃つ前に木の pid を集めておき、
 *    撃った後にこれで数え直す。直接の子の `exitCode` だけを見ると、
 *    木から外れた孫が生き残っていても「停止しました」と書いてしまう。
 * ⚠️ 自分の pid は数えない（呼び出し側が渡さないこと）。
 * @param {number[]} pids
 * @param {(pid: number) => boolean} [probe] 検査用に差し替えられるようにする
 */
export function stillAlive(pids, probe = null) {
    const check = probe ?? (pid => {
        try { process.kill(pid, 0); return true; } catch { return false; }
    });
    const out = [];
    for (const pid of pids ?? []) {
        if (!Number.isInteger(pid) || pid <= 0) continue;
        if (check(pid)) out.push(pid);
    }
    return out;
}
