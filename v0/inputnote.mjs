// SPDX-License-Identifier: MIT
//
// 標準入力を送ったときの「届いたか」の判定（#67）。
//
// 🚨 **「送った」と「届いた」を分ける。** 子が stdin を読んでいないと、
//    データは親のバッファに積まれるだけで誰も読まない。それでも HTTP は 200 を返し、
//    コンソールには `▸ 打った文章` が出るので、利用者から見ると
//    「送ったのに返事が来ない」だけになり、**送れていないことが画面のどこからも
//    分からない**（#18 の本命である claude との会話で一番起きる形）。
//
// ⚠️ **app.html の中に置かない**（CLAUDE.md）。中に置くとテストできないので、
//    「滞留を告げる」という宣言が破れても気付けない。

/**
 * `/api/v0/exec/<id>/input` の応答から、端末に出す告知を決める。
 *
 * @param {object|null} body 応答の JSON（`pending` を含む）
 * @returns {{delivered: boolean, pending: number, note: string|null}}
 *   note が null でなければ、そのまま1行として端末に出す
 */
export function inputNote(body) {
    // ⚠️ 欠けている・数値でない場合は「分からない」なので、
    //    **届いたと断言しない**（0 として黙るのは「無い」と言うのと同じ）。
    const raw = body?.pending;
    const pending = typeof raw === 'number' ? raw : Number.NaN;
    if (!Number.isFinite(pending)) {
        return { delivered: false, pending: 0, note: '⚠ 届いたか確認できませんでした\n' };
    }
    if (pending > 0) {
        return {
            delivered: false, pending,
            note: `⚠ 相手がまだ読んでいません（未読 ${pending} バイト）\n`,
        };
    }
    return { delivered: true, pending: 0, note: null };
}
