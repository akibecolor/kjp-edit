// SPDX-License-Identifier: MIT
//
// Windows のコマンドラインを**作る側**と**読む側**の規則。
// `scripts/serve.mjs` と `scripts/autostart.mjs` が共有する。
//
// なぜ分けたか: この3つは純粋な関数で、**壊れ方が静かで手元では気付けない**
// （空白入りのユーザ名は Windows の既定形。自分のマシンには空白が無い）。
// ユニットテストで固定できる形にする（`scripts/winargs.test.mjs`）。

/**
 * 🚨 `CreateProcess` の `lpCommandLine` に載せる引数を引用する。
 *
 * CRT の規則: 引用符の中の `\"` は**リテラルの二重引用符**。素朴に `"${a}"` で
 * 囲むと、末尾がバックスラッシュの値（`C:\Users\a b\kjp-editor\`）で
 * **引用が閉じず、後続の引数が全部その中に飲まれる**。実測:
 *
 *     素朴: --repo "C:\Users\a b\kjp-editor\" --port 7749 --allow-host x
 *     argv: ["--repo","C:\\Users\\a b\\kjp-editor\" --port 7749 --allow-host x"]
 *     CRT : --repo "C:\Users\a b\kjp-editor" --port 7749 --allow-host x
 *     argv: ["--repo","C:\\Users\\a b\\kjp-editor","--port","7749","--allow-host","x"]
 *
 * 規則:
 *   - `"` の直前のバックスラッシュ列は2倍にして、`"` を `\"` にする
 *   - 閉じ引用符の直前のバックスラッシュ列も2倍にする
 */
export function winQuote(s) {
    if (typeof s !== 'string') throw new TypeError('winQuote には文字列を渡してください');
    if (s === '') return '""';
    if (!/[\s"]/.test(s)) return s;
    const body = s
        .replace(/(\\*)"/g, (m, b) => `${b}${b}\\"`)
        .replace(/(\\+)$/, (m, b) => `${b}${b}`);
    return `"${body}"`;
}

/**
 * 🚨 コマンドラインから `--repo` の値を取り出す。**`(\S+)` で取らない。**
 *
 * Node は空白を含む引数を `"..."` で囲むので、`Win32_Process` の CommandLine 上では
 * `--repo "C:/Users/a b/repo"` になる。`(\S+)` は `"C:/Users/a` までしか取らず:
 *   - 二重起動の判定が外れて**同じリポジトリのデーモンが2本立つ**
 *     （watcher / TTL キャッシュ / exec 台帳 / 監査ログが二重化。
 *      `--exec` なら実行枠が2セット開く）
 *   - 案内は「別のプロセス」= 事実と違う
 *   - `--status` も壊れたパスを表示する
 */
export function repoOf(cmdLine) {
    if (typeof cmdLine !== 'string') return null;
    const m = /--repo\s+(?:"([^"]*)"|(\S+))/.exec(cmdLine);
    return m ? (m[1] ?? m[2]) : null;
}

/**
 * パスのゆるい一致（区切り文字・大文字小文字・末尾セパレータを吸収する）。
 *
 * ⚠️ **認可には使わない。** 実体の解決（realpath / 8.3 短縮名）はしていない。
 *    「同じリポジトリのデーモンが既に居るか」の判定と表示のためだけ。
 *    認可は `v0/git.mjs` の `samePath()` / `containsPath()` が持つ。
 */
export function samePathish(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a === '' || b === '') return false;
    const n = s => s.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
    return n(a) === n(b);
}

/** 末尾のセパレータを落とす（引用を壊しやすく、意味は変わらないので） */
export function trimTrailingSep(p) {
    return typeof p === 'string' ? p.replace(/[\\/]+$/, '') : p;
}

/**
 * PowerShell が出した `pid<TAB>ppid` の行を読む。
 *
 * ⚠️ 数値でない行（PowerShell の警告や空行）は捨てる。**捨てた行は数に入れない**
 *    ので、呼び出し側は「調べられた」かどうかを別に持つこと（`{supported, …}`）。
 */
export function parseProcPairs(text) {
    return String(text ?? '').split('\n')
        .map(l => l.trim()).filter(Boolean)
        .map(l => l.split('\t'))
        .filter(([a, b]) => /^\d+$/.test(a ?? '') && /^\d+$/.test(b ?? ''))
        .map(([a, b]) => ({ pid: Number(a), ppid: Number(b) }));
}

/**
 * プロセス表から、ある pid の**子孫を全部**返す。
 *
 * 🚨 `--stop` は `taskkill /T /F` で**木ごと**落とすので、道連れになるのは
 *    デーモンだけではない（`claude -p` / `npm test` とその子孫が全部死ぬ）。
 *    「止めます」と言う前に何本巻き込むかを見せるために木を辿る。
 * ⚠️ **循環で無限ループしない。** Windows では pid が再利用されるので、
 *    親子関係が輪を作った表（既に死んだ親の pid を新しいプロセスが持つ）を渡されうる。
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
