// SPDX-License-Identifier: MIT
//
// 読み取り専用の派生秘密（#59 で切り出し）。
//
// 🔒 **生トークンを配らないための派生。** `--allow-exec` のデーモンでは
//    `--token-file` に渡すのが実行トークンなので、案内の URL や
//    別プロセス（`scripts/precheck.mjs` のフック）に**生の値を渡すと read が RCE に昇格する**。
//    そこで一方向に潰した値を「読み取りだけ通る秘密」として配る。
//
// ⚠️ **サーバと配る側で必ず同じ式を使う。** 以前は `v0/server.mjs` の中にだけ
//    あったので、`~/.kjp-edit/token-read` の中身と**実際に通る値が食い違っていても
//    誰も気付かなかった**（フックが毎回 401 を受けて ask に倒れて発覚した）。

import { createHash } from 'node:crypto';

/** Cookie / 案内 URL / フックに配る、読み取り専用の派生秘密 */
export function readSecretOf(token) {
    if (!token) return null;
    // 🚨 ここを `token` にすると、案内 URL とフックに**実行トークンそのもの**が載る
    //    （変異 `read-secret-not-derived` がそれを測る）
    return derive(token);
}

function derive(token) {
    return createHash('sha256')
        .update(`${token}\nkjp-edit auth cookie v1`, 'utf8')
        .digest('base64url');
}
