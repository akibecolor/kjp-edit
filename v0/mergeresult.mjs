// SPDX-License-Identifier: MIT
//
// 取り込み（merge）の応答を「画面がすべきこと」に翻訳する純関数。
//
// 🚨 **なぜ app.html の中に書かないか（CLAUDE.md）。**
//    `app.html` に置いたロジックはテストできない = 宣言が破れても気付けない。
//    ここで決めているのは3つとも**壊れても静かな**判定なので、外に出して固定する:
//      1. 失敗しても画面を数え直すか（`reload`）
//         → 以前は `!r.ok` で `load(true)` を呼んでいなかったので、
//           半端な状態が残っているのに**画面は clean のまま**だった
//           （TTL 1.5s + 自動更新 15s の窓。8回目のレビュー）
//      2. その告知を「再描画で消えない場所」に出すか（`sticky`）
//         → 取り込みのペインは毎回作り直されるので、`load(true)` を呼ぶと
//           出したばかりの文字が消える。**半端な状態の告知は消してはいけない。**
//      3. 「取り込みました」と言ってよいか
//         → 予測が clean だったのに衝突状態になった回（`conflicted`）は成功ではない。

/**
 * @param {number} status HTTP のステータス
 * @param {object|null} body 応答の本文（JSON。読めなければ null）
 * @returns {{ok: boolean, message: string, sticky: string|null, reload: boolean}}
 */
export function mergeOutcome(status, body) {
    const b = (body && typeof body === 'object') ? body : {};
    if (status >= 200 && status < 300 && b.ok === true) {
        const conflicted = b.conflicted === true;
        return {
            ok: true,
            message: conflicted
                ? `取り込みましたが衝突状態です: ${b.warning ?? '端末で確認してください'}`
                : '取り込みました',
            // 予測が外れて衝突状態になったのは、次の描画で消してよい話ではない
            sticky: conflicted
                ? (b.warning ?? '衝突しないと予測したのに衝突状態になりました')
                : null,
            reload: true,
        };
    }
    const message = typeof b.error === 'string' && b.error ? b.error : `HTTP ${status}`;
    // `leftover` はサーバが**実際に git merge を走らせた**ときだけ付く。
    // 手前の門（dirty / driver / 衝突の予測）で断られた場合は付かないので、
    // 「何も起きていない」ことをここで区別できる（無用な警告を残さない）。
    const lo = (b.leftover && typeof b.leftover === 'object') ? b.leftover : null;
    const unknown = lo !== null && lo.counted === false;
    const dirty = lo !== null && lo.counted !== false && lo.dirty === true;
    return {
        ok: false,
        message,
        sticky: (dirty || unknown) ? message : null,
        // 🚨 失敗でも数え直す。断られた理由が「画面が古い」ことである場合も多い
        reload: true,
    };
}
