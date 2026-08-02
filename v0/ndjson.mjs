// SPDX-License-Identifier: MIT
//
// 行区切り JSON（ndjson）のストリーム読み。**ブラウザと Node の両方から使う。**
//
// なぜモジュールに切り出したか:
//   ここには「たまに文字化けする」形でしか現れない罠が2つあり、
//   ブラウザの中に置いたままではテストできなかった。
//   （headless Chrome は --virtual-time-budget が setTimeout を仮想時間で
//     即消費するので、実ネットワークの到着を待つ検証ができない）
//
//   罠1: **JSON の行が chunk 境界で割れる。** 末尾の不完全な行を次の chunk まで
//        持ち越さないと JSON.parse が失敗する
//   罠2: **マルチバイト文字が chunk 境界で割れる。** TextDecoder に
//        stream: true を渡さないと、割れた位置に U+FFFD が入る
//        （サーバ側が StringDecoder を使っているのと同じ理由）

/**
 * ReadableStream から JSON オブジェクトを順に取り出す。
 * 壊れた行は落とさず `{ __parseError: <生の行> }` として返す（黙って消さない）。
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {AsyncGenerator<object>}
 */
export async function* parseNdjson(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            // stream: true が罠2 の対策。境界の半端なバイトを内部に持ち越す
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            // 罠1 の対策。最後の要素は「まだ改行が来ていない行」なので持ち越す
            buf = lines.pop() ?? '';
            for (const line of lines) {
                if (!line) continue;
                yield parseLine(line);
            }
        }
        // 終端。デコーダに残っているものを吐き出す
        buf += decoder.decode();
        for (const line of buf.split('\n')) {
            if (line) yield parseLine(line);
        }
    } finally {
        try { reader.releaseLock(); } catch { /* 既に解放済み */ }
    }
}

function parseLine(line) {
    try {
        return JSON.parse(line);
    } catch {
        return { __parseError: line };
    }
}
