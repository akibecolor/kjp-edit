// SPDX-License-Identifier: MIT
//
// 端末の鍵をブラウザ側でどう扱うか（`docs/device-approval.md`）。
//
// ⚠️ **`app.html` の中に置かない**（CLAUDE.md）。ここが壊れると
//    「登録したのに送っていない」「貼った鍵より弱い鍵を送る」が起きるのに、
//    中に書くと**テストで固定できない**。
// ⚠️ `devices.mjs` はサーバ側（`node:crypto` を使う）なので分けてある。
//    ブラウザに配るのはこのファイルだけ。

/** localStorage のキー（**ポートを含むオリジン単位**。Cookie と違って他ポートから読めない） */
export const DEVICE_KEY = 'kjp.device';

/** 案内 URL で渡された鍵を入れる枠（**貼った鍵とは別**。下の理由） */
export const URL_KEY = 'kjp_url';

/**
 * どの資格情報を送るか。**強い順に選ぶ。**
 *
 * 🚨 **URL で渡された鍵を「貼った鍵」と同じ枠に入れない（実測で踏んだ）。**
 *    以前は案内 URL の `?token=` を貼った鍵と同じ `kjp_token` に入れていた。
 *    トンネル越しの URL に載るのは**読み取り専用の派生秘密**なので、
 *    それが「貼った鍵」として**端末の鍵より優先**され、承認済みの端末なのに
 *    capability の UI が「トークン未取得」のままになった
 *    （サーバは `presented: 'device'` を返せていたので、**画面側だけの取り違え**）。
 *
 * ⚠️ **「今この遷移で渡された」と「前に渡されて残っている」を分ける。**
 *    分けずに URL 由来を一律で端末の鍵より下に置くと、
 *    **失効した端末の鍵が読み取りまで塞ぐ**（鍵つき URL を開き直しても効かない）。
 *    今来た鍵は利用者の最新の意思なので最優先にする。
 *
 * 強い順: 今 URL で来た鍵 > 貼った鍵 > 端末の鍵 > 前に URL で来た鍵。
 *
 * @param {{urlToken: string|null, sessionToken: string|null,
 *          deviceKey: string|null, storedUrlToken: string|null}} held
 * @returns {{value: string|null, kind: 'url'|'pasted'|'device'|'stored'|'none'}}
 */
export function pickCredential({
    urlToken, sessionToken, deviceKey, storedUrlToken,
} = {}) {
    const clean = v => (typeof v === 'string' ? v.trim() : '');
    const fresh = clean(urlToken);
    if (fresh) return { value: fresh, kind: 'url' };
    const paste = clean(sessionToken);
    if (paste) return { value: paste, kind: 'pasted' };
    const dev = clean(deviceKey);
    if (dev) return { value: dev, kind: 'device' };
    const stored = clean(storedUrlToken);
    if (stored) return { value: stored, kind: 'stored' };
    return { value: null, kind: 'none' };
}

// ⚠️ **`shouldForgetDevice`（401 を受けたら端末の鍵を捨てる）は書いたが削除した。**
//    防ぐつもりだった「死んだ鍵を握って読み取りまで塞ぐ」は**実測で起きなかった**
//    （読み取りは Cookie の派生秘密で続く。`v0/pair-check.mjs` の4節）。
//    そして実行は**鍵つき URL を開き直せば戻る**（`urlToken` が最優先）。
//    つまり守る対象が無く、しかも配線を測る手段が無かった。
//    CLAUDE.md「測っても差が出ない守りは置かない」に従って**守りごと消した**
//    （`defensive` で誤魔化さない）。

/**
 * サーバの `presented` から「書き込み・実行に使える鍵か」を決める。
 *
 * 🚨 **`device` も使える側に入れる。** 入れ忘れると、承認した端末で
 *    **capability の UI が「トークン未取得」のまま**になり（押せない）、
 *    登録した意味が消える。
 * ⚠️ 読み取り用の派生秘密（`read`）は**使えない**。ここを混ぜると
 *    「有効に見えて必ず 403」になる（このリポジトリが BLOCKING として扱ってきた形）。
 */
export function canMutateWith(presented) {
    return presented === 'token' || presented === 'device';
}

/**
 * 端末が名乗る名前を作る。
 *
 * ⚠️ **User-Agent をそのまま出さない。** 長いし、母艦の一覧で読めない。
 *    ⚠️ 名前は識別のためだけなので、分からなければ「不明な端末」でよい
 *    （推測して間違った名前を出すより、分からないと言う）。
 */
export function deviceLabel(ua, platform) {
    const s = String(ua ?? '');
    const os = /Android/i.test(s) ? 'Android'
        : /iPhone|iPad|iPod/i.test(s) ? 'iOS'
            : /Windows/i.test(s) ? 'Windows'
                : /Mac OS X|Macintosh/i.test(s) ? 'macOS'
                    : /Linux/i.test(s) ? 'Linux' : null;
    const browser = /Edg\//.test(s) ? 'Edge'
        : /OPR\//.test(s) ? 'Opera'
            : /Chrome\//.test(s) ? 'Chrome'
                : /Firefox\//.test(s) ? 'Firefox'
                    : /Safari\//.test(s) ? 'Safari' : null;
    const parts = [os, browser].filter(Boolean);
    if (!parts.length) {
        const p = typeof platform === 'string' && platform.trim() ? platform.trim() : null;
        return p ? `不明な端末（${p.slice(0, 20)}）` : '不明な端末';
    }
    return parts.join(' / ');
}
