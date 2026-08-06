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
 * 🚨 **送った1行を「会話」として見せる（封筒を見せない）。**
 *
 * 会話モードでは UI が stream-json の封筒を組み立てて送るので、入力の反響
 * （`{t:"in"}`）をそのまま出すと
 * `▸ {"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}`
 * になる。**打った本人にも何を打ったのか読めない**（実機で指摘された）。
 *
 * ⚠️ 解釈できなければ null を返す（呼び出し側が生のまま出す。捨てない）。
 * @param {string} raw 送った1行
 * @returns {string|null} 本文だけ
 */
export function chatInputText(raw) {
    let r;
    try { r = JSON.parse(String(raw ?? '')); } catch { return null; }
    if (r?.type !== 'user') return null;
    const blocks = Array.isArray(r.message?.content) ? r.message.content : null;
    if (blocks === null) return typeof r.message?.content === 'string' ? r.message.content : null;
    const t = blocks.filter(b => b?.type === 'text')
        .map(b => (typeof b.text === 'string' ? b.text : '')).join('');
    return t.trim() ? t.trim() : null;
}

/**
 * @param {(cls: string, text: string) => void} line 1行を端末に出す
 * @returns {{feed: (raw: string) => void, flush: () => void}}
 */
export function makeChatFilter(line) {
    let buf = '';
    /**
     * 🚨 **告知は種別ごとに1回だけ。あとは数える（実機で2回直した）。**
     *
     * 1件1行で告知すると、`thinking` / `stream_event` は**トークンごとに来る**ので
     * 画面が告知で埋まり応答が押し出された（実測で56行中24行）。
     * 連続をまとめる形にしたが、`user`（`--replay-user-messages` の再送）と
     * `rate_limit_event` は**本物の応答の合間に挟まる**ので連続にならず、
     * 会話の間に告知が刺し込まれ続けた（「構造データは見せ方として不要」と指摘された）。
     *
     * ⚠️ **黙って捨てない約束は守る。** 種別ごとに最初の1回は出し、
     *    残りは数えて **`flush()` で合計を出す**（件数を必ず見せる）。
     * ⚠️ 応答本文とツール名（`· Bash`）は**待たせない**。読む対象なので、
     *    まとめ待ちで遅らせると「止まっている」ように見える。
     */
    const skipped = new Map();   // 告知の文 → 出さなかった件数
    const emit = o => {
        if (o.kind === 'skip') {
            const seen = skipped.get(o.text);
            if (seen === undefined) {
                skipped.set(o.text, 0);
                // 括弧を二重にしない（`（…）（…）` は読みにくい）
                line(o.cls, `${o.text.replace(/）\s*$/, '。以降は数えるだけ）')}\n`);
                return;
            }
            skipped.set(o.text, seen + 1);
            return;
        }
        line(o.cls, `${o.text}\n`);
    };
    /** 出さなかった件数の合計。**数えたまま黙って終わらない。** */
    const endSkips = () => {
        const rest = [...skipped].filter(([, n]) => n > 0);
        if (!rest.length) return;
        skipped.clear();
        // 種別だけを並べる（文をそのまま繰り返すと読めない）
        const parts = rest.map(([text, n]) => {
            const kind = text.replace(/^\s*（/, '').replace(/）\s*$/, '')
                .replace(/\s*は表示していません\s*$/, '');
            return `${kind} ×${n}`;
        });
        line('d', `  （出さなかった行: ${parts.join(' / ')}）\n`);
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
        endSkips();
    };
    return { feed, flush };
}
