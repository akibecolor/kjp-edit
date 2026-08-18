// SPDX-License-Identifier: MIT
//
// 「自分はこれを実際に見るか」（#5）に**記憶ではなくデータで**答えるための読み出し。
//
//   node scripts/usage.mjs            # ~/.kjp-edit/exec-audit.jsonl を読む
//   node scripts/usage.mjs <path>     # 別のログを読む
//
// 🔒 **読むだけ。** デーモンにも git にも触らない。
// ⚠️ **記録の無い期間を「使わなかった」と読まないこと。**
//    `page-open` は 2026-08-19 に足したので、それ以前の日には**開いた記録が無い**。
//    それ以前について言えるのは「遠隔から実行・入力・承認をしたか」だけ。
//    この区別は出力に明示する（ここを黙ると自分に嘘をつく）。

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** `page-open` を記録するようになった日（これより前は「開いた」を測れない） */
export const PAGE_OPEN_SINCE = '2026-08-19';

/**
 * 監査ログの行から日別の使用状況を組む。**純関数**（テストできる形にする）。
 *
 * @param {object[]} entries パース済みのレコード
 * @returns {{days: object[], totals: object, unknownEvents: string[]}}
 */
export function summarize(entries) {
    const byDay = new Map();
    const unknown = new Set();
    const day = e => String(e?.at ?? '').slice(0, 10);
    // 🔒 tailnet 越し（= スマホ）かどうかは Host で見る。ループバックは母艦
    const remote = e => Boolean(e?.host) && !/^(127\.0\.0\.1|\[::1\]|localhost)(:|$)/.test(e.host);
    for (const e of entries ?? []) {
        const d = day(e);
        if (!d) continue;
        if (!byDay.has(d)) {
            byDay.set(d, {
                date: d, opens: 0, opensRemote: 0, opensSuppressed: 0,
                execs: 0, execsRemote: 0, inputs: 0, pairings: 0, authFailed: 0,
            });
        }
        const r = byDay.get(d);
        switch (e.event) {
            case 'page-open':
                r.opens += 1 + (Number(e.suppressed) || 0);
                r.opensSuppressed += Number(e.suppressed) || 0;
                if (remote(e)) r.opensRemote += 1 + (Number(e.suppressed) || 0);
                break;
            case 'start':
                r.execs += 1;
                if (remote(e)) r.execsRemote += 1;
                break;
            case 'input': r.inputs += 1; break;
            case 'pair-claimed': r.pairings += 1; break;
            case 'auth-failed': r.authFailed += 1; break;
            // 数えないが「知らない種別」ではないもの
            case 'exit': case 'kill': case 'detach': case 'reattach':
            case 'write': case 'merge': case 'checkout':
            case 'repo-add': case 'repo-remove':
            case 'pair-request': case 'pair-first-use': case 'pair-revoke':
            case 'auth-failed-summary': case 'mutation-token-failed':
            case 'audit-rotated': case 'token-rotated':
                break;
            default: unknown.add(String(e.event));
        }
    }
    const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
    const sum = k => days.reduce((n, d) => n + d[k], 0);
    return {
        days,
        totals: {
            days: days.length,
            opens: sum('opens'), opensRemote: sum('opensRemote'),
            execs: sum('execs'), execsRemote: sum('execsRemote'),
            inputs: sum('inputs'), pairings: sum('pairings'),
            // 「開いた」を測れる日だけを数える（それ以前を 0 と読まないため）
            daysWithOpenData: days.filter(d => d.date >= PAGE_OPEN_SINCE).length,
        },
        // 🚨 知らない種別は黙って捨てない（種別が増えたのに数えていない状態を作らない）
        unknownEvents: [...unknown].sort(),
    };
}

/** 壊れた行は捨てずに数える（「読めた行だけ」で結論を出さないため） */
export function parseLines(text) {
    const entries = []; let broken = 0;
    for (const line of String(text ?? '').split('\n')) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch { broken += 1; }
    }
    return { entries, broken };
}

// ⚠️ 直接実行のときだけ動かす（テストから import しても表を出さない）。
//    Windows のパスを手で組むと必ずずれるので `pathToFileURL` を使う。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const path = process.argv[2] ?? join(homedir(), '.kjp-edit', 'exec-audit.jsonl');
    const text = await readFile(path, 'utf8').catch(err => {
        console.error(`✖ 監査ログを読めません: ${path}\n  ${err.message}`);
        process.exitCode = 1;
        return null;
    });
    if (text !== null) {
        const { entries, broken } = parseLines(text);
        const s = summarize(entries);
        console.log(`${path}（${entries.length} 件${broken ? ` / 壊れた行 ${broken}` : ''}）\n`);
        console.log('日付        開いた(遠隔)  実行(遠隔)  入力  承認  401');
        for (const d of s.days) {
            const openCell = d.date >= PAGE_OPEN_SINCE
                ? `${String(d.opens).padStart(5)}(${String(d.opensRemote).padStart(3)})`
                : '    -(  -)';
            console.log(`${d.date}  ${openCell}`
                + `  ${String(d.execs).padStart(5)}(${String(d.execsRemote).padStart(3)})`
                + `  ${String(d.inputs).padStart(4)}`
                + `  ${String(d.pairings).padStart(4)}`
                + `  ${String(d.authFailed).padStart(4)}`);
        }
        console.log(`\n合計: ${s.totals.days} 日分の記録。`
            + `開いた ${s.totals.opens}（遠隔 ${s.totals.opensRemote}）／`
            + `実行 ${s.totals.execs}（遠隔 ${s.totals.execsRemote}）`);
        // 🚨 測れない期間を「使わなかった」と読ませない
        console.log(`⚠ 「開いた」を測れるのは ${PAGE_OPEN_SINCE} 以降だけです`
            + `（${s.totals.daysWithOpenData} 日分）。それ以前の "-" は`
            + '「開かなかった」ではなく**記録が無い**という意味です。');
        console.log('⚠ ループバックの数には検査（verify / 変異）の分も混ざります。'
            + '遠隔（Host が tailnet 名）の方が実際の利用に近い指標です。');
        if (s.unknownEvents.length) {
            console.log(`⚠ 数えていない種別があります: ${s.unknownEvents.join(', ')}`
                + '（summarize() に足してください）');
        }
    }
}
