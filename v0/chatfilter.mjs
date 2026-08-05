// SPDX-License-Identifier: MIT
//
// 会話モード（`claude -p --output-format stream-json`）の出力を読める形にする。
//
// ⚠️ **ブラウザと unit テストで共有する。** `app.html` の中に置くとテストできない
//    （`ndjson.mjs` / `argv.mjs` と同じ理由。server.mjs が同じ経路で配信している）。
//
// ⚠️ **`out` は行の途中で切れて届く。** 行単位に組み直してから JSON にする
//    （chunk 境界の扱いは `ndjson.mjs` と同じ問題）。
// 🚨 **解釈できない行を捨てない。** 形式は Claude Code の内部形式なので変わる。
//    黙って消すと「応答が来ていない」ように見える。
//    以前はこの約束を **JSON.parse に失敗した行にだけ**守っていて、
//      (a) 改行で終わらない最後の行は `buf` に残ったまま**永久に表示されない**
//          （kill された / 落ちた / 出力が途中で切れた場合の最後の応答が丸ごと消える）
//      (b) `type` が assistant/result/system-init 以外の行は全部捨てていた
//          （`control_response` = 入力の許可拒否、`stream_event`、将来増える type）
//    という状態だった（#44）。**コメントが警戒していた形で実際に壊れていた。**

/**
 * @param {(cls: string, text: string) => void} line 1行を端末に出す
 * @returns {{feed: (raw: string) => void, flush: () => void}}
 */
export function makeChatFilter(line) {
    let buf = '';
    const feed = raw => {
        buf += raw;
        const parts = buf.split('\n');
        buf = parts.pop();
        for (const l of parts) {
            if (!l.trim()) continue;
            let r;
            try { r = JSON.parse(l); } catch { line('', `${l}\n`); continue; }
            if (r.type === 'assistant') {
                // 🚨 **`content` が配列でない形が来る。** `.filter` が TypeError を投げ、
                //    それが購読ループを抜けて finally の `onState({running:false})` に落ちる。
                //    結果、**ペインは「停止」表示なのにセッションは走り続け、
                //    そのペインからは止められない**（このツールが最も重いとする食い違い）。
                //    `transcript.mjs` は同じ形を `Array.isArray` で守っている。
                const blocks = Array.isArray(r.message?.content) ? r.message.content : null;
                if (blocks === null) {
                    line('d', '  （assistant の content が配列ではないので表示していません）\n');
                    continue;
                }
                // 🚨 **1行も出さずに終わらせない。** 知らないブロック種別だけの
                //    assistant レコードを黙って捨てると、宣言（解釈できない行は捨てない）に
                //    反するうえ「応答が来ていない」ように見える
                let emitted = false;
                const t = blocks.filter(b => b?.type === 'text')
                    .map(b => (typeof b.text === 'string' ? b.text : '')).join('');
                if (t.trim()) { line('', `${t.trim()}\n`); emitted = true; }
                for (const b of blocks) {
                    if (b?.type === 'tool_use') {
                        line('d', `  · ${typeof b.name === 'string' ? b.name : '(名前なし)'}\n`);
                        emitted = true;
                    }
                }
                if (!emitted) {
                    const kinds = blocks.map(b => (typeof b?.type === 'string' ? b.type : '?'))
                        .join(',').slice(0, 60);
                    line('d', `  （assistant の中身を解釈できませんでした: ${kinds || '空'}）\n`);
                }
            } else if (r.type === 'result') {
                line(r.is_error ? 'e' : 'p', `── ${r.is_error ? '✖ エラー' : '✔ 応答おわり'} ──\n`);
            } else if (r.type === 'system' && r.subtype === 'init') {
                line('d', `（セッション ${String(r.session_id ?? '').slice(0, 8)} で開始）\n`);
            } else {
                // 🚨 知らない type を黙って捨てない。ただし全文は出さず**種別だけ**を
                //    1行で出す（長い本文で画面を埋めない。省略したことは言う）
                const kind = [r.type, r.subtype].filter(v => typeof v === 'string' && v)
                    .join('/').slice(0, 60) || '(type なし)';
                line('d', `  （${kind} は表示していません）\n`);
            }
        }
    };
    /**
     * 🚨 **残りを必ず出す。** 改行で終わらない最後の行は `buf` に残る。
     *    出力が途中で切れた場合の最後の応答が消えないようにする（#44）。
     *    解釈できないので生のまま出す。
     */
    const flush = () => {
        const rest = buf;
        buf = '';
        if (rest.trim()) line('', `${rest}\n`);
    };
    return { feed, flush };
}
