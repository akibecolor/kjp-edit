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
 * 1レコード（パース済み）を表示行に変換する。**純関数。**
 *
 * 🚨 **端末（`makeChatFilter`）と監視盤（`chatGlance`）で必ず同じ解釈を使う。**
 *    片方だけに書くと、同じ出力が場所によって違う意味に見える
 *    （「規則を書いた場所から遠いコードには適用し忘れる」と同型）。
 * 🚨 **必ず1行以上返す。** 解釈できない形でも「解釈できなかった」と言う。
 *
 * @param {any} r
 * @returns {{cls: string, text: string}[]} `text` は改行を含まない
 */
export function chatRecordLines(r) {
    const out = [];
    if (r?.type === 'assistant') {
        // 🚨 **`content` が配列でない形が来る。** `.filter` が TypeError を投げ、
        //    それが購読ループを抜けて finally の `onState({running:false})` に落ちる。
        //    結果、**ペインは「停止」表示なのにセッションは走り続け、
        //    そのペインからは止められない**（このツールが最も重いとする食い違い）。
        //    `transcript.mjs` は同じ形を `Array.isArray` で守っている。
        const blocks = Array.isArray(r.message?.content) ? r.message.content : null;
        if (blocks === null) {
            return [{ cls: 'd', kind: 'skip', text: '  （assistant の content が配列ではないので表示していません）' }];
        }
        const t = blocks.filter(b => b?.type === 'text')
            .map(b => (typeof b.text === 'string' ? b.text : '')).join('');
        if (t.trim()) out.push({ cls: '', text: t.trim() });
        for (const b of blocks) {
            if (b?.type === 'tool_use') {
                out.push({ cls: 'd', text: `  · ${typeof b.name === 'string' ? b.name : '(名前なし)'}` });
            }
        }
        // 🚨 **1行も出さずに終わらせない。** 知らないブロック種別だけの
        //    assistant レコードを黙って捨てると、宣言（解釈できない行は捨てない）に
        //    反するうえ「応答が来ていない」ように見える
        if (!out.length) {
            const kinds = blocks.map(b => (typeof b?.type === 'string' ? b.type : '?'))
                .join(',').slice(0, 60);
            out.push({ cls: 'd', kind: 'skip', text: `  （assistant の中身を解釈できませんでした: ${kinds || '空'}）` });
        }
        return out;
    }
    if (r?.type === 'result') {
        return [{
            cls: r.is_error ? 'e' : 'p',
            text: `── ${r.is_error ? '✖ エラー' : '✔ 応答おわり'} ──`,
        }];
    }
    if (r?.type === 'system' && r.subtype === 'init') {
        return [{ cls: 'd', text: `（セッション ${String(r.session_id ?? '').slice(0, 8)} で開始）` }];
    }
    // 🚨 知らない type を黙って捨てない。ただし全文は出さず**種別だけ**を
    //    1行で出す（長い本文で画面を埋めない。省略したことは言う）
    const kind = [r?.type, r?.subtype].filter(v => typeof v === 'string' && v)
        .join('/').slice(0, 60) || '(type なし)';
    return [{ cls: 'd', kind: 'skip', text: `  （${kind} は表示していません）` }];
}

/**
 * 🚨 **監視盤用の「一目で分かる1行」。**
 *
 * 監視盤（`/api/v0/exec/list` の `lastOutput`）に会話セッションの最後の出力を
 * そのまま出すと、**生の stream-json** が並んで「どれが待っているか」が
 * 読めない（並列運用の目的そのものが失われる）。
 *
 * ⚠️ サーバ側では解釈しない（`v0/README.md` の約束）。ここはクライアント側。
 * 🚨 **解釈できなければ生のまま返す。** 捨てない・黙って空にしない。
 *    渡される文字列は**先頭が切れている**ことがある（サーバが末尾を返す）ので、
 *    **後ろから見て最初に解釈できた行**を使う。
 *
 * @param {string} raw 改行を含みうる出力の断片
 * @returns {{text: string, interpreted: boolean}}
 */
export function chatGlance(raw) {
    const lines = String(raw ?? '').split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        let r;
        try { r = JSON.parse(lines[i]); } catch { continue; }   // 切れた行は飛ばす
        const got = chatRecordLines(r);
        // 🚨 **本文とツール名の両方を出す。** 最後の1行だけにすると、
        //    text と tool_use が同じレコードに入っている形で**本文が消え**、
        //    `· Bash` だけになる（「〜しますか？」が読めず、打つべきか判断できない）。
        const text = got.map(o => o.text.trim()).filter(Boolean).join(' ');
        if (text) return { text, interpreted: true };
    }
    return { text: lines[lines.length - 1] ?? '', interpreted: false };
}

/**
 * @param {(cls: string, text: string) => void} line 1行を端末に出す
 * @returns {{feed: (raw: string) => void, flush: () => void}}
 */
export function makeChatFilter(line) {
    let buf = '';
    /**
     * 🚨 **同じ告知の連続をまとめる（実機で踏んだ）。**
     *
     * `thinking` や `stream_event` は**トークンごとに1レコード来る**ので、
     * 「表示していません」を1件1行で出すと**画面が告知で埋まり、
     * 肝心の応答が押し出される**（スマホの実画面の8割がこれになった）。
     *
     * ⚠️ **黙って捨てない約束は守る。** 最初の1件は即座に出し、
     *    続く同じ告知は数えて「同上 ×N」として出す（件数は必ず見せる）。
     * ⚠️ 応答本文とツール名（`· Bash`）は**待たせない**。読む対象なので、
     *    まとめ待ちで遅らせると「止まっている」ように見える。
     */
    let run = null;   // {cls, text, extra}
    const endRun = () => {
        if (run !== null && run.extra > 0) {
            line(run.cls, `  （同上 ×${run.extra} を省略）\n`);
        }
        run = null;
    };
    const emit = o => {
        if (o.kind === 'skip') {
            if (run !== null && run.text === o.text) { run.extra++; return; }
            endRun();
            line(o.cls, `${o.text}\n`);
            run = { cls: o.cls, text: o.text, extra: 0 };
            return;
        }
        endRun();
        line(o.cls, `${o.text}\n`);
    };
    const feed = raw => {
        buf += raw;
        const parts = buf.split('\n');
        buf = parts.pop();
        for (const l of parts) {
            if (!l.trim()) continue;
            let r;
            try { r = JSON.parse(l); } catch { emit({ cls: '', text: l }); continue; }
            for (const o of chatRecordLines(r)) emit(o);
        }
    };
    /**
     * 🚨 **残りを必ず出す。** 改行で終わらない最後の行は `buf` に残る。
     *    出力が途中で切れた場合の最後の応答が消えないようにする（#44）。
     *    解釈できないので生のまま出す。
     *    ⚠️ まとめ待ちの件数も必ず出す（数えたまま黙って終わらない）。
     */
    const flush = () => {
        const rest = buf;
        buf = '';
        if (rest.trim()) emit({ cls: '', text: rest });
        endRun();
    };
    return { feed, flush };
}
