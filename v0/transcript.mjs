// SPDX-License-Identifier: MIT
//
// エージェントの活動記録（Claude Code のセッション記録）から**要約だけ**を作る。
//
//   ~/.claude/projects/<slug>/<sessionId>.jsonl
//
// 設計と判断の経緯は docs/agent-observation.md。ここでは実装上の要点だけ書く。
//
// 🚨 **この経路は「出してはいけないものを出さない」ことが本体。**
//    記録には会話の全文・読んだファイルの中身・コマンドの出力が入っている。
//    トンネル越しに繋がる相手へ全部渡さないために、**許可リスト方式**にする。
//    「これを除く」ではなく「これだけ入れる」。
//
// ⚠️ 除外方式が成立しない理由は実測で確認した（2026-08-03）。
//    ツールの結果は**入口が複数ある**:
//      - message.content[].type === 'tool_result'
//      - トップレベルの toolUseResult（{stdout, stderr, ...}）
//      - type === 'file-history-snapshot' の snapshot（ファイルの中身）
//      - type === 'file-history-delta' の backup
//      - type === 'attachment' の attachment
//    さらに自由文は message の外にもある（last-prompt.lastPrompt /
//    custom-title.customTitle / queue-operation.content）。
//    形式は Claude Code の内部形式で公開 API ではないので**フィールドは増える**。
//    除外方式だと増えた瞬間に黙って漏れる。許可リストなら表示が減るだけで済む。

import { readdir, stat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { containsPath, relativeInside, isSafeRepoPath } from './git.mjs';

export const LIMITS = {
    tailBytes: 256 * 1024,   // 末尾だけ読む（実測で 24MB の記録があった）
    // ⚠️ 1レコードが 1.25MB という実データがある。完全な行が取れないときだけ
    //    ここまで広げて読み直す（#27）。無制限には広げない
    tailMaxBytes: 4 * 1024 * 1024,
    headBytes: 16 * 1024,    // cwd を知るために先頭だけ読む
    // ⚠️ 先頭レコードが大きいと 16KB の窓に cwd が入らない。末尾側（readTailAdaptive）と
    //    同じ扱いで広げる。**入らなかったことを「無関係な記録」と読まない**（#36）
    headMaxBytes: 1024 * 1024,
    // ⚠️ 最新の1本が cwd を持たないスタブ（`teleported-from` の 112B など）だと、
    //    同じディレクトリに 182MB の実セッションが同居していても観測が死ぬ。
    //    mtime 降順で次の候補を試す本数（#36）
    maxCwdProbes: 8,
    maxLines: 600,           // 走査する行数の上限
    maxDirs: 60,             // projects 配下を見る上限
    maxSubagentFiles: 300,   // サブエージェントの記録を数える上限（#28）
    maxRecent: 12,           // 出す活動の件数
    maxText: 8,              // 出す発話の件数
    textChars: 400,          // 1件あたりの文字数
    commandChars: 300,
    // 🚨 **パスにも上限を掛ける。** `isSafeRepoPath` は空白・改行・任意の Unicode を
    //    4096 文字まで通すので、`--watch-agents` だけで recent 12件 × 4096 ≒ 48KB の
    //    任意テキストが、発話用のフラグ（--allow-transcript-text）を通らずに出ていた。
    //    引き金は実在する: 読んだ README や Web ページのインジェクションが
    //    `Read("<repo>/<秘密>")` を1回呼ばせれば、失敗した read でも tool_use として残る（#38）。
    pathChars: 160,
    activeMs: 3 * 60 * 1000,
    idleMs: 60 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// 許可リスト
// ---------------------------------------------------------------------------

/** 走査するレコード種別。**ここに無い type は1バイトも見ない。** */
const SCAN_TYPES = new Set(['assistant', 'user', 'mode', 'permission-mode']);

/** ツール入力のうち「パス」として扱うキー。これ以外の入力は見ない。 */
const PATH_KEYS = ['file_path', 'notebook_path', 'path'];

/** コマンド行を持つツール（自由文なので --allow-transcript-text が必要） */
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);

/**
 * 列挙値として通す文字列。
 *
 * ⚠️ `mode` や `permissionMode` を**そのまま**払い出してはいけない。
 *    記録の中の文字列なので、形式が変われば任意の長さの文字列が来うる。
 *    「列挙可能な値だけ出す」を文字どおり成立させるために形を縛る。
 */
function enumValue(v, max = 32) {
    return typeof v === 'string' && v.length <= max && /^[A-Za-z0-9_.:-]+$/.test(v) ? v : null;
}

/** ツール名。記録由来なので同じく形を縛る。 */
function toolName(v) {
    return typeof v === 'string' && v.length <= 64 && /^[A-Za-z0-9_.:-]+$/.test(v) ? v : null;
}

/**
 * ISO8601 として妥当な timestamp だけ通す（自由文が紛れ込む余地を消す）。
 *
 * 🚨 **`Date.parse` を検証に使ってはいけない。** V8 の緩いフォールバック解析は
 *    `INJECT-SECRET-12345` を**西暦 12345 年**として受け入れて 327403350000000 を返す
 *    （実測）。それを妥当と見なすと、timestamp が自由文の抜け道になる。
 *    先に形を正規表現で縛る。
 */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
function isoTime(v) {
    if (typeof v !== 'string' || !ISO_RE.test(v)) return null;
    return Number.isFinite(Date.parse(v)) ? v : null;
}

/** 自由文を切り詰める。**allowText のときだけ呼ぶ。** */
function clip(v, max) {
    if (typeof v !== 'string') return null;
    const s = v.replace(/\s+/g, ' ').trim();
    if (!s) return null;
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 絶対パスを worktree 相対に丸める。
 *
 * ⚠️ リポジトリの外を触っていた場合は**パスを出さない**。
 *    記録には他プロジェクトのパスも入る。
 *
 * 🚨 **`null` の理由を型で分ける（8回目のレビュー。SERIOUS）。**
 *    以前は4つの別の事情で同じ `null` を返し、呼び出し側がそれを全部
 *    `(リポジトリ外)` と表示していた:
 *      (a) 本当に worktree の外            … 「外」と言ってよい
 *      (b) `rel === ''` = worktree ルート自身 … **中**。`Grep`/`Glob` の `path` に
 *          ルートを渡す形で普通に起きる
 *      (c) `isSafeRepoPath` に外れた形（先頭が `-` や `:` のファイル名）… **中**
 *      (d) 引数が判定できない（文字列でない / 空）    … 「調べられない」
 *    (b)(c) はリポジトリの中なのに「エージェントがリポジトリ外を触った」という
 *    **安全に関わる誤った断定**になっていた。同じファイルの `observedPath` は
 *    相対パスの基準が不明なときに「外と断言せず不明にする」と丁寧に分けていたのに、
 *    その原則がここに適用されていなかった（CLAUDE.md
 *    「『調べられない』と『無い』を型で分ける」）。
 *
 * @returns {{rel: string|null, why: null|'outside'|'root'|'unsafe'|'unknown'}}
 */
export function repoRelative(base, abs) {
    if (typeof abs !== 'string' || !abs || typeof base !== 'string') {
        return { rel: null, why: 'unknown' };
    }
    // ⚠️ path.relative() を使わない。記録の中のパスは worktree のパスと
    //    表記が違いうる（8.3 短縮名 / symlink / 大文字小文字）。
    //    素の relative() だと `../../..` になって、中にあるファイルなのに
    //    「外」と判定される（漏れではなく**見失う**方向の壊れ方）
    const rel = relativeInside(base, abs);
    // ⚠️ `relativeInside` の null は「本当に外」と「symlink で段数が合わない」の
    //    両方だが、どちらも**中だと言えない**ので外に倒す（漏らさない側に倒す）
    if (rel === null) return { rel: null, why: 'outside' };
    // worktree ルート自身。**中なので「外」と言ってはいけない**（パスは無い）
    if (rel === '') return { rel: null, why: 'root' };
    // isSafeRepoPath は HTTP から来た値と同じ検証。ここも通す（UI が
    // このパスで差分を開くので、開ける形であることを保証する）
    // ⚠️ ここに外れたものは**中にあるが表示できない**。外ではない
    if (!isSafeRepoPath(rel)) return { rel: null, why: 'unsafe' };
    return { rel, why: null };
}

/**
 * 記録の中のパスを、出してよい形にする。
 *
 * 返す形: `{ path, outside, clipped, unresolved, root, unsafe, unknown }`
 *   - `outside: true`  … 触ってはいるが worktree の外（パスは出さない）
 *   - `clipped: true`  … 長すぎたので切った。**切ったパスは開けない**ので
 *                        UI はリンクにしてはいけない（`app.html` が見る）
 *   - `root: true`     … worktree ルート自身（**中**。パスとしては出せない）
 *   - `unsafe: true`   … 中にあるが表示できない形（先頭が `-` / `:` など）
 *   - `unknown: true`  … 判定できなかった（「外」ではない）
 *
 * 🚨 **`path === null` を全部「外」と読ませてはいけない。** 5つの事情があり、
 *    「外」と断言してよいのは `outside` だけ（8回目のレビュー。詳細は `repoRelative`）。
 *
 * 🚨 **切ったパスをそのまま「開ける」ものとして扱わない。** 途中で切れた文字列は
 *    別のファイルを指すか、どのファイルも指さない。省略したことを告げる。
 * ⚠️ ここで `git ls-files` と照合して「実在する追跡対象だけ出す」ことはしない。
 *    worktree ごとに git 呼び出しが増えるのは明示的に禁じている（CLAUDE.md）。
 *    代わりに**長さで縛る**。パスは本質的に自由文なので、
 *    「自由文は1文字も通さない」とは言えない（`docs/agent-observation.md` を直した）。
 */
export function observedPath(base, raw, max, recordCwd = null) {
    // 🚨 **相対パスをデーモンの cwd で解決してはいけない。** 記録側のパスは
    //    相対のことがある（Grep / Glob の `path` など）。`realpathSync.native()` は
    //    **サーバプロセスの cwd** を基準に解決するので、
    //    (a) 触っていないファイルを「触った」と表示し、
    //    (b) worktree 内のファイルを「(リポジトリ外)」と表示する。
    //    レコードには `cwd` が入っていて所有者判定に使っているのに、
    //    パスの解決には使っていなかった（7回目のレビュー）。
    //    ⚠️ 基準が分からない相対パスは**「外」と断言せず不明にする**。
    let abs = raw;
    if (typeof raw === 'string' && raw && !isAbsolutePath(raw)) {
        if (typeof recordCwd === 'string' && recordCwd) abs = join(recordCwd, raw);
        else return { path: null, outside: false, clipped: false, unresolved: true };
    }
    const { rel, why } = repoRelative(base, abs);
    // 🚨 **理由ごとに別のフィールドで返す。** ここで全部 `outside: true` にしていたので、
    //    worktree ルートと中にある表示できないファイルが「外を触った」になっていた
    if (rel === null) {
        return {
            path: null, clipped: false,
            outside: why === 'outside',
            root: why === 'root',
            unsafe: why === 'unsafe',
            unknown: why === 'unknown',
        };
    }
    if (rel.length <= max) return { path: rel, outside: false, clipped: false };
    return { path: `${rel.slice(0, max)}…`, outside: false, clipped: true };
}

/** 絶対パスか（Windows のドライブレターと UNC も見る） */
function isAbsolutePath(p) {
    // ⚠️ 区切りは \\ と / の両方（UNC の先頭は区切り2つ）
    if (p.startsWith('/') || p.startsWith('\\')) return true;
    return /^[A-Za-z]:[\\\\/]/.test(p);
}

/**
 * 🚨 **コマンド行に載った秘密をマスクする（7回目のレビュー）。**
 *
 * 読み取りと実行を分けた根拠は「Cookie は他のローカルポートに漏れるが、
 * 漏れても読み取りまで」だった。ところが `--allow-transcript-text` を付けると、
 * 記録された `Bash` / `PowerShell` のコマンド行が `/api/v0/state` に丸ごと出る。
 * README が案内していた起動手順は `--allow-exec --token "$TOKEN"` で、
 * **値をリテラルで打った回は記録に残る**（実データで `--token` リテラル 42 件を確認）。
 * つまり Cookie しか持たない読み取り専用の相手（他ポートのページ / トンネルの
 * 閲覧者）が実行トークンを回収でき、**read が RCE に昇格する**。
 *
 * ⚠️ **完全な防御ではない**（秘密の形は無限にある）。ここで落とすのは
 *    (a) **このデーモン自身の資格情報**（値が分かっているので確実に落とせる）と
 *    (b) `--token` / `--password` 等の**直後の語**。
 *    **落としたことは必ず告知する**（黙って消すと「そう打っていない」と誤読される）。
 *
 * 🚨 **形ベース（b）の区切りは「空白1文字」ではない（8回目のレビュー。SERIOUS）。**
 *    `[ ]+` / `[ ]*` しか見ていなかったので:
 *      - `--token\t<値>` は**何にも当たらず素通り**（告知も出ない）
 *      - `--token \` + 改行 + `<値>` は**継続の `\` を「値」としてマスクする**ので
 *        `masked: true` が立ち、UI は `← 秘密を落としました` と表示しながら
 *        その直後に秘密を並べた。`clip` が後で `\s+` を空白に畳むので、payload には
 *        `--token (マスクしました) <秘密>` という**綺麗な1行**として出る
 *      - `--token "a b"` は `"a` だけ落として ` b"` を残す（同じ部分マスク）
 *    **落としていないのに「落とした」と言うのがこのリポジトリで最も重い誤り**なので
 *    3つ全部を直す:
 *      1. **行継続を先に畳む**（sh の `\` + 改行 / PowerShell の backtick + 改行）。
 *         シェルはこの2文字を取り除くので、畳んだ形が「実際に実行された形」
 *      2. 区切りを `\s` にする（タブ・改行・全角空白も見る）
 *      3. クォートで囲まれた値を**1つとして食う**
 *    ⚠️ 副作用として**過剰にマスクする**ことがある（`--password` が行末にあると
 *       次の行の先頭語を落とす）。過剰マスクは告知付きで情報が減るだけだが、
 *       未マスクは秘密が漏れて**しかも嘘をつく**ので、こちら側に倒す。
 *    ⚠️ `clip` の後にもう一度掛ける必要は無い。`clip` は `\s+` を空白1つに畳んで
 *       末尾を切るだけで、`\s` を見ている以上**畳んだ後に初めて成立する形は無い**
 *       （テスト側では clip 後の payload も見て固定してある）。
 * @param {string} text コマンド行 / 発話
 * @param {string[]} secrets 値が分かっている秘密（token / cookie の導出値）
 * @returns {{text: string, masked: boolean}}
 */
const SECRET_KEYS = "token|password|passwd|secret|api[-_]?key|authorization|bearer";
// 🚨 区切りの文字クラス。**`[ ]` に戻すとタブ・改行・行継続で秘密が素通りする**
const SECRET_WS = "\\s";
// 行継続。sh は `\` + 改行、PowerShell は backtick（\x60）+ 改行を**取り除く**ので
// 同じように取り除く（畳んだ形が実際に実行された形。`^` は cmd 用だが、
// 文中の行末 `^` を巻き込むので入れない）
const CONTINUATION_RE = /[\\\x60]\r?\n/g;
// 値。クォートで囲まれた値を1つとして食う（`[^ ]+` だと
// `--password "pass phrase X"` の `"pass` だけ落として ` phrase X"` を残す）
const SECRET_VALUE = "(?:\"[^\"]*\"?|'[^']*'?|[^" + SECRET_WS + "'\"]+)";
// 🚨 **記号1つを「値」として食って本物を残さない（#66。10回目のレビュー / SERIOUS）。**
//
// 区切りが `\s` なので、鍵の直後にある**記号1つ**（cmd.exe の行継続 `^`、
// YAML のブロック `|` / `>`、`$`、`-`）が値として食われ、**本物の値は次の行に残る**。
// そのあと `clip()` が `\s+` を空白1つに畳むので、画面には
// `--token (マスクしました) kjp0000SUPER…` という綺麗な1行が出て、
// 横に「← 秘密を落としました」と描かれる = **告知が嘘になる**。
// （実測で5形が決定的に再現。実データの 6347 件では未発火だったが、形として成立する）
//
// ⚠️ **英数字を1文字も含まない語は「値」と見なさない。** それを飛ばして次の語まで食う。
//    多めに消す方向に倒す（消しすぎは読みにくいだけだが、残すと秘密が漏れる）。
const PUNCT_ONLY = "[^" + SECRET_WS + "A-Za-z0-9]+";
const SECRET_VALUE_SMART = "(?:" + PUNCT_ONLY + SECRET_WS + "+)?" + SECRET_VALUE;
// 🚨 `authorization: Bearer <値>` は「Bearer」を値と見なして落とし、**トークンを残す**
//    （告知だけ立つので「落とした」と嘘をつく）。スキーム語ごと食う
const AUTH_SCHEME = "(?:(?:bearer|basic|token)" + SECRET_WS + "+)?";
export function maskSecrets(text, secrets = []) {
    if (typeof text !== "string" || !text) return { text, masked: false };
    // 1. 行継続を畳む（これが無いと継続文字だけをマスクして秘密を残す）
    let out = text.replace(CONTINUATION_RE, "");
    let masked = false;
    // (a) 値が分かっているものは確実に落とす（短すぎる値は誤爆するので見ない）
    for (const v of secrets) {
        if (typeof v !== "string" || v.length < 8) continue;
        while (out.includes(v)) {
            out = out.replace(v, "(マスクしました)");
            masked = true;
        }
    }
    // (b) 秘密を渡す形の**直後の語**を落とす（`--token=X` と `--token X` の両方、
    //     `x-kjp-token: X` のようなヘッダ形も）
    const forms = [
        new RegExp("(--?(?:" + SECRET_KEYS + ")=" + SECRET_WS + "*)" + SECRET_VALUE_SMART, "gi"),
        new RegExp("(--?(?:" + SECRET_KEYS + ")" + SECRET_WS + "+)" + SECRET_VALUE_SMART, "gi"),
        new RegExp("((?:" + SECRET_KEYS + ")['\"]?[:=]" + SECRET_WS + "*)"
            // ⚠️ スキーム語（Bearer 等）の判定は**記号を飛ばした後**に置く。
            //    前に置くと `authorization: >\n  Bearer <値>` で `> Bearer` までを
            //    値として食い、**本物のトークンが残る**（#66 で実測）。
            + "((?:" + PUNCT_ONLY + SECRET_WS + "+)?" + AUTH_SCHEME + SECRET_VALUE + ")", "gi"),
    ];
    for (const re of forms) {
        out = out.replace(re, (m, head) => { masked = true; return head + "(マスクしました)"; });
    }
    return { text: out, masked };
}

// ---------------------------------------------------------------------------
// 要約（純関数。fs を触らないので単体でテストできる）
// ---------------------------------------------------------------------------

/**
 * 記録の行（新しい順でなくてよい）から要約を作る。
 *
 * @param {string[]} lines JSON の行
 * @param {object} o
 * @param {string} o.worktreePath パスを相対化する基準
 * @param {boolean} [o.allowText] 自由文（発話・コマンド行）を出すか
 * @param {number} [o.now] 現在時刻（ms）。テストで固定するために注入できる
 */
export function summarize(lines, {
    worktreePath, allowText = false, now = Date.now(), limits = LIMITS,
    // 🔒 値が分かっている秘密（このデーモンの token / cookie の導出値）。
    //    コマンド行に載っていたら落とす（read が RCE に昇格する経路を塞ぐ）
    secrets = [],
} = {}) {
    const out = {
        session: null,
        lastActivityAt: null,
        ageMs: null,
        state: 'none',
        mode: null,
        permissionMode: null,
        toolCounts: {},
        recent: [],
        // 何件を切ったか（0 なら「全部出している」と言ってよい）
        recentDropped: 0,
        talk: 0,             // 発話の件数（本文は allowText のときだけ text に入る）
        text: [],
        sidechains: 0,
        scanned: 0,
        dropped: 0,
        // 🚨 **`state:'none'` の理由を分ける。** 「記録が無い」と「抽出できなかった」を
        //    同じ値で表すと、UI が稼働中のエージェントに
        //    「走らせた記録がありません」と断言する（#37）。
        //    'empty' / 'no-known-records' / 'no-timestamp' / null
        noneReason: null,
    };

    // 新しい順に見たいので後ろから。行数の上限で打ち切る。
    const from = Math.max(0, lines.length - limits.maxLines);
    const window = lines.slice(from);
    let newestTs = null;

    for (let i = window.length - 1; i >= 0; i--) {
        const raw = window[i];
        if (!raw || !raw.trim()) continue;
        let r;
        try { r = JSON.parse(raw); } catch { out.dropped++; continue; }
        if (!r || typeof r !== 'object') { out.dropped++; continue; }
        // 🚨 許可リスト。ここに無い type は中身を一切見ない
        //    （file-history-snapshot / attachment / last-prompt などが該当）
        if (!SCAN_TYPES.has(r.type)) continue;
        out.scanned++;

        if (r.type === 'mode') { out.mode ??= enumValue(r.mode); continue; }
        if (r.type === 'permission-mode') { out.permissionMode ??= enumValue(r.permissionMode); continue; }

        out.session ??= enumValue(r.sessionId, 64);
        const at = isoTime(r.timestamp);
        if (at && !newestTs) newestTs = at;
        if (r.isSidechain === true) out.sidechains++;

        const content = r.message?.content;
        if (!Array.isArray(content)) {
            // 🚨 **文字列の content から本文を出してはいけない。**
            //    `user` レコードの content は「あなたのプロンプト」だけでなく
            //    **ツールの結果（コマンド出力）でも文字列で来る**。
            //    形から区別できないので、出すと T5 が漏れる
            //    — しかも同じ画面に「ツールの結果は出しません」と書いてある
            //    （レビューで実測。このリポジトリが最も重いとする「嘘」の型）。
            //    件数だけ数えて、本文は allowText でも出さない。
            if (typeof content === 'string' && r.type === 'user') out.talk++;
            continue;
        }

        for (const b of content) {
            if (!b || typeof b !== 'object') continue;
            // 🚨 tool_result と thinking は allowText でも出さない（T5）。
            //    ファイルの中身とコマンド出力が入るので、
            //    `git cat-file` 経由という不変条件を完全に無効化する
            if (b.type === 'tool_result' || b.type === 'thinking') continue;

            if (b.type === 'tool_use') {
                const name = toolName(b.name);
                if (!name) continue;
                out.toolCounts[name] = (out.toolCounts[name] ?? 0) + 1;
                // ⚠️ **切ったことを告げる（MINOR。10回目のレビュー）。**
                //    payload は 12 件・画面は 6 行で切っているのに、
                //    **どこにも「切った」と書いていなかった**（「これで全部」に見える）。
                if (out.recent.length >= limits.maxRecent) { out.recentDropped++; continue; }
                const input = b.input && typeof b.input === 'object' ? b.input : {};
                let seen = { path: null, outside: false, clipped: false };
                for (const k of PATH_KEYS) {
                    if (typeof input[k] !== 'string') continue;
                    // ⚠️ レコードの cwd を渡す（相対パスの基準。無ければ不明にする）
                    seen = observedPath(worktreePath, input[k], limits.pathChars,
                        typeof r.cwd === 'string' ? r.cwd : null);
                    break;
                }
                const entry = {
                    at, tool: name, path: seen.path, outside: seen.outside,
                    // 省略したことを payload に残す（黙って切ると「開けるパス」に見える）
                    pathClipped: seen.clipped,
                    // 🚨 相対パスの基準が分からなかった = 「外」ではなく「不明」。
                    //    デーモンの cwd で解決すると別のファイルの名前を出す（7回目のレビュー）
                    pathUnresolved: seen.unresolved === true,
                    // 🚨 **「外」と別の理由を別のフィールドで出す（8回目のレビュー）。**
                    //    worktree ルート自身と、中にあるが表示できない形を
                    //    `outside` に混ぜていたので「外を触った」と嘘をついていた
                    pathRoot: seen.root === true,
                    pathUnsafe: seen.unsafe === true,
                    pathUnknown: seen.unknown === true,
                    sidechain: r.isSidechain === true,
                };
                // T2: コマンド行は自由文。既定では出さない
                if (allowText && COMMAND_TOOLS.has(name)) {
                    // 🚨 **秘密を落としてから切り詰める。** コマンド行は read 権限で
                    //    出るので、実行トークンが載っていると read → RCE に昇格する
                    const masked = maskSecrets(input.command, secrets);
                    entry.command = clip(masked.text, limits.commandChars);
                    // 落としたことは必ず告知する（黙って消すと「そう打っていない」と読める）
                    if (masked.masked) entry.commandMasked = true;
                }
                out.recent.push(entry);
                continue;
            }

            if (b.type === 'text') {
                out.talk++;
                if (allowText && out.text.length < limits.maxText) {
                    // 🔒 **発話にもマスクを掛ける（8回目のレビュー。BLOCKING）。**
                    //    発話とコマンド行は**同じ `--allow-transcript-text`・同じ read 権限**で
                    //    同じ payload に出るのに、マスクはコマンド行にしか掛かっていなかった。
                    //    「次を実行してください: … --token X」「トークンは … です」の形で
                    //    実行トークンが平文で出るので、**read が RCE に昇格する**
                    //    （7回目にコマンド行側で閉じた穴と同一クラス）。
                    const masked = maskSecrets(b.text, secrets);
                    const t = clip(masked.text, limits.textChars);
                    if (t) {
                        const item = { at, role: r.type === 'assistant' ? 'assistant' : 'user', text: t };
                        // 落としたことは必ず告知する（コマンド行と同じ扱い）
                        if (masked.masked) item.masked = true;
                        out.text.push(item);
                    }
                }
            }
        }
    }

    out.lastActivityAt = newestTs;
    if (newestTs) {
        // 🚨 **時計がずれていたら「稼働中」と断言しない（MINOR）。**
        //    以前は `Math.max(0, …)` で負を 0 に丸めていたので、
        //    記録の timestamp が未来だと**必ず 'active'**（= 今まさに動いている）になった。
        //    「調べられない」を「無い」と言わないのと同じ型なので、
        //    経過は null にして理由を添える（`{supported, why}` の扱いに合わせる）。
        const delta = now - Date.parse(newestTs);
        if (delta < 0) {
            out.ageMs = null;
            out.state = 'unknown';
            out.clockSkew = true;
            out.why = '記録の時刻が未来なので経過を判定できません（時計のずれ）';
        } else {
            out.ageMs = delta;
            out.state = out.ageMs <= limits.activeMs ? 'active'
                : out.ageMs <= limits.idleMs ? 'idle' : 'stale';
        }
    } else {
        // 🚨 なぜ何も出なかったのかを言う。実データには**許可リスト外の type が
        //    304KB 連続する箇所**があり、既定の窓（256KB）を超える。
        //    完全な行は取れているので #27 の救済に乗らず、
        //    5秒前に Edit を書いたエージェントに「記録がありません」と出ていた（#37）。
        const hadLines = window.some(l => l && l.trim());
        out.noneReason = !hadLines ? 'empty'
            : out.scanned === 0 ? 'no-known-records'
                : 'no-timestamp';
    }
    return out;
}

// ---------------------------------------------------------------------------
// 読み取り（fs のみ。git の spawn は増やさない）
// ---------------------------------------------------------------------------

/** ファイルの末尾 n バイトを行に分割して返す。先頭の不完全な行は捨てる。 */
export async function readTail(file, maxBytes = LIMITS.tailBytes) {
    const fh = await open(file, 'r');
    try {
        const { size } = await fh.stat();
        const len = Math.min(maxBytes, size);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, size - len);
        // ⚠️ Buffer で受けて最後に一度だけデコードする。
        //    途中で toString すると3バイト文字を割る（CLAUDE.md）
        const lines = buf.toString('utf8').split('\n');
        // 末尾から読んだので、ファイル全体を読んでいない限り1行目は途中
        if (len < size) lines.shift();

        // 🚨 **完全な行が0本になる場合がある。** 実データには 1.25MB / 776KB の
        //    1レコードが実在する（大きい tool_result / file-history）。それが
        //    末尾付近にあると 256KB では1行も完成せず、summarize は
        //    lastActivityAt=null を返し、UI は稼働中のエージェントに対して
        //    **「エージェントを走らせた記録がありません」と表示する**（嘘）。
        //    そこで「読む量が足りなかった」ことを呼び出し側に伝えて、
        //    より広く読み直せるようにする（#27）。
        const complete = lines.filter(l => l.trim()).length;
        return {
            lines, bytes: len, truncated: len < size,
            // 読める行が無く、まだ読んでいない部分がある = 1レコードが大きすぎる
            needMore: complete === 0 && len < size,
        };
    } finally {
        await fh.close();
    }
}

/**
 * 完全な行が取れるまで読む量を増やして読む。
 *
 * ⚠️ **無制限には広げない。** 上限（既定 4MB）まで倍々にして、それでも
 *    取れなければ「大きすぎて読めなかった」ことを伝える。
 *    黙って「記録なし」にするのが #27 の欠陥だったので、
 *    **どちらの場合も理由が残る形**にする。
 */
export async function readTailAdaptive(file, {
    start = LIMITS.tailBytes, max = LIMITS.tailMaxBytes,
} = {}) {
    let want = start;
    let last = await readTail(file, want);
    let grew = 0;
    while (last.needMore && want < max) {
        want = Math.min(want * 4, max);
        last = await readTail(file, want);
        grew++;
    }
    return { ...last, bytesWanted: want, grew, tooBigToRead: last.needMore };
}

/**
 * サブエージェントの活動を数える（#28）。
 *
 * 🚨 **`isSidechain` では数えられない。** 実データの4本すべてで 0 件だった
 *    （サブエージェントを使っていても 0）。サブエージェントの記録は
 *    **親と別のファイル**にあるので、親のファイルを読んでも何も出ない:
 *
 *      <slug>/<sessionId>.jsonl                        ← 親
 *      <slug>/<sessionId>/subagents/agent-*.jsonl      ← サブエージェント
 *      <slug>/<sessionId>/subagents/workflows/<run>/agent-*.jsonl
 *
 *    その結果、親がサブエージェントを走らせている間は親ファイルへの追記が
 *    止まり、UI は稼働中のエージェントを**「待機 N分」と表示していた**（嘘）。
 *
 * ⚠️ **中身は読まない。** 数と mtime だけで足りるし、読めば T5 の入口を
 *    増やすことになる（サブエージェントの記録にもツールの結果が入る）。
 * ⚠️ 件数の上限を置き、超えたら告知する。
 */
async function subagentActivity(sessionFile, { now, activeMs, maxFiles }) {
    const dir = join(sessionFile.replace(/\.jsonl$/i, ''), 'subagents');
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return null; }

    const files = [];
    let truncated = false;
    /** 1階層だけ潜る（workflows/<runId>/agent-*.jsonl まで） */
    const collect = async (d, ents, depth) => {
        for (const e of ents) {
            if (files.length >= maxFiles) { truncated = true; return; }
            const p = join(d, e.name);
            if (e.isDirectory()) {
                if (depth >= 2) continue;
                try { await collect(p, await readdir(p, { withFileTypes: true }), depth + 1); }
                catch { /* 読めないディレクトリは飛ばす */ }
                continue;
            }
            if (!e.name.endsWith('.jsonl')) continue;   // ⚠️ それ以外は触らない
            files.push(p);
        }
    };
    await collect(dir, entries, 0);

    let active = 0;
    let newestMs = 0;
    for (const f of files) {
        try {
            const st = await stat(f);
            if (!st.isFile()) continue;
            if (st.mtimeMs > newestMs) newestMs = st.mtimeMs;
            if (now - st.mtimeMs <= activeMs) active++;
        } catch { /* 消えた */ }
    }
    return { total: files.length, active, newestMs, truncated };
}

/** 先頭 n バイトから cwd を拾う（どの worktree の記録かを知るためだけ） */
async function readHeadCwd(file, maxBytes) {
    const fh = await open(file, 'r');
    try {
        const { size } = await fh.stat();
        const len = Math.min(maxBytes, size);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, 0);
        const lines = buf.toString('utf8').split('\n');
        if (len < size) lines.pop();   // 末尾の行は途中
        for (const l of lines) {
            if (!l.trim()) continue;
            let r;
            try { r = JSON.parse(l); } catch { continue; }
            if (typeof r?.cwd === 'string' && r.cwd) return { cwd: r.cwd, truncated: len < size };
        }
        return { cwd: null, truncated: len < size };
    } finally {
        await fh.close();
    }
}

/**
 * cwd を拾う。**窓に入らなかったことを「無関係な記録」と読まない。**
 *
 * 🚨 先頭レコードが 16KB を超える実データがある。固定窓だと cwd がその後ろの行にあり、
 *    どの worktree のものか判定できず**そのプロジェクトを丸ごと黙って捨てて
 *    「記録なし」と表示していた**（errors にも何も出ない。#36）。
 *    末尾側（`readTailAdaptive`）と同じく、足りなければ広げて読み直す。
 */
export async function readCwd(file, start = LIMITS.headBytes, max = LIMITS.headMaxBytes) {
    let want = Math.min(start, max);
    for (;;) {
        const r = await readHeadCwd(file, want);
        if (r.cwd || !r.truncated || want >= max) return r.cwd;
        want = Math.min(want * 4, max);
    }
}

/** projects 配下の既定の場所。**パスは組み立てず、ここを readdir する。** */
export function transcriptRoot() {
    return join(homedir(), '.claude', 'projects');
}

/**
 * worktree ごとの活動要約を集める。
 *
 * @param {{path: string, label: string}[]} worktrees
 * @returns {Promise<{agents: object[], errors: {scope: string, message: string}[]}>}
 */
export async function collectAgents(worktrees, {
    root = transcriptRoot(), allowText = false, now = Date.now(), limits = LIMITS,
    // 🔒 コマンド行から落とす秘密（サーバが自分の token / cookie 導出値を渡す）
    secrets = [],
    // ⚠️ **検査専用の継ぎ目**（既定は素の stat）。1ファイルの stat 失敗で
    //    プロジェクト丸ごとを捨てていた形を測るために要る。移植可能に
    //    「stat が投げるファイル」を作る手段が無い（symlink は Windows で EPERM、
    //    ディレクトリは stat が成功する）ので、注入で作る。
    //    --layout-probe / --exec-stream-delay と同じ「既定では存在しない経路」。
    statFn = stat,
} = {}) {
    const errors = [];
    const byPath = new Map();   // worktree path -> 要約
    let dirs;
    try {
        dirs = await readdir(root, { withFileTypes: true });
    } catch (e) {
        return {
            agents: [],
            errors: [{
                scope: 'agents',
                message: `活動記録の場所を読めません（${root}）: ${e.code ?? e.message}。`
                    + ' Claude Code を使っていないか、場所が違います。',
            }],
        };
    }

    let scannedDirs = 0;
    let skippedDirs = 0;
    let cwdlessDirs = 0;   // cwd が読めず、どの worktree のものか判定できなかった数
    // 🚨 読めなかったものは**件数を必ず出す**（黙って「記録なし」にしない）
    let unreadableDirs = 0;
    let unreadableFiles = 0;
    for (const d of dirs) {
        if (!d.isDirectory()) continue;
        if (scannedDirs >= limits.maxDirs) { skippedDirs++; continue; }
        scannedDirs++;
        const dir = join(root, d.name);
        // そのディレクトリの *.jsonl を新しい順に並べる
        const files = [];
        // 🚨 **1ファイルの失敗でディレクトリ全体を捨てない。** try がループの**外**に
        //    あったので、`stat()` が1つでも投げると（消えた最中 / 権限 / ロック）
        //    **プロジェクトディレクトリ丸ごと**を無告知で捨てていた。
        //    結果、5秒前に Edit を書いたエージェントに「記録がありません」と断言する
        //    — #27 / #36 / #37 で3回潰した型が、まだここに残っていた（7回目のレビュー）。
        let entries = null;
        try { entries = await readdir(dir); } catch { unreadableDirs++; continue; }
        let skippedFiles = 0;
        for (const f of entries) {
            if (!f.endsWith('.jsonl')) continue;   // ⚠️ それ以外は開かない
            const p = join(dir, f);
            try {
                const s = await statFn(p);
                if (!s.isFile()) continue;
                files.push({ path: p, mtimeMs: s.mtimeMs });
            } catch { skippedFiles++; }   // そのファイルだけ飛ばす
        }
        if (skippedFiles) unreadableFiles += skippedFiles;
        if (!files.length) continue;
        files.sort((a, b) => b.mtimeMs - a.mtimeMs);

        // まず cwd だけ拾い、担当の worktree が無ければ末尾は読まない（無駄な読み取りを避ける）
        // 🚨 **最新の1本で諦めない。** 最新が cwd を持たないスタブ
        //    （`teleported-from` の 112B など）だと、同じディレクトリに
        //    182MB の実セッションが同居していても観測が死ぬ（#36）。
        // 🚨 **広い窓と候補の本数を掛け算しない。** 素朴に「候補ごとに最大 1MB まで
        //    広げる」と `8候補 × 1MB × 60プロジェクト = 480MB` が最悪ケースになり、
        //    `p95 < 1000ms` を静かに超える（`docs/performance.md`）。
        //    **まず全候補を安い窓（16KB）で試し、1本も取れなかったときだけ
        //    最新の1本を広い窓で読み直す**。1ディレクトリあたり `8×16KB + 1MB` に収まる。
        const candidates = files.slice(0, limits.maxCwdProbes);
        let newest = null;
        let cwd = null;
        for (const cand of candidates) {
            let c = null;
            // 安い窓だけ（max = start にして広げない）
            try { c = await readCwd(cand.path, limits.headBytes, limits.headBytes); }
            catch { continue; }
            if (c) { newest = cand; cwd = c; break; }
        }
        if (!cwd && candidates.length) {
            // 先頭レコードが窓より大きい形（#36）。最新の1本だけ広げて読み直す
            try {
                const c = await readCwd(candidates[0].path,
                    limits.headBytes, limits.headMaxBytes);
                if (c) { newest = candidates[0]; cwd = c; }
            } catch { /* 読めない */ }
        }
        // ⚠️ cwd が無いと**どの worktree のものか判定できない**ので、
        //    このディレクトリ単位ではエラーを出せない（無関係なプロジェクトかもしれない）。
        //    件数だけ数えて後でまとめて告知する（黙って消さない）。
        if (!cwd) { cwdlessDirs++; continue; }
        // 最も深く一致する worktree を選ぶ（サブディレクトリで動かしている場合に対応）
        let owner = null;
        for (const w of worktrees) {
            if (!containsPath(w.path, cwd)) continue;
            if (!owner || w.path.length > owner.path.length) owner = w;
        }
        if (!owner) continue;   // 他プロジェクトの記録。無視する（エラーではない）

        let tail;
        let s;
        try {
            tail = await readTailAdaptive(newest.path,
                { start: limits.tailBytes, max: limits.tailMaxBytes });
            s = summarize(tail.lines, { worktreePath: owner.path, allowText, now, limits, secrets });
            // 🚨 **窓が全部「知らない種別」でも「記録なし」と言わない。**
            //    実データには許可リスト外の type が 304KB 連続する箇所があり、
            //    既定の窓（256KB）を超える。完全な行は取れているので #27 の救済に
            //    乗らず、5秒前に Edit を書いたエージェントに
            //    「走らせた記録がありません」と出ていた（#37）。広げて読み直す。
            let want = tail.bytes;
            while (s.noneReason === 'no-known-records' && tail.truncated
                && want < limits.tailMaxBytes) {
                want = Math.min(want * 4, limits.tailMaxBytes);
                const wider = await readTail(newest.path, want);
                // 適応読み（#27）で分かったことは引き継ぐ
                wider.tooBigToRead = tail.tooBigToRead;
                wider.bytesWanted = tail.bytesWanted;
                wider.grew = tail.grew;
                tail = wider;
                s = summarize(tail.lines, { worktreePath: owner.path, allowText, now, limits, secrets });
            }
        } catch { continue; }
        s.bytesRead = tail.bytes;
        s.tailOnly = tail.truncated;
        // 🚨 読めなかったことを**必ず伝える**。黙って「記録なし」にしない（#27）
        s.tooBigToRead = tail.tooBigToRead === true;
        if (tail.grew > 0) s.grewReads = tail.grew;

        // 🚨 サブエージェントの活動。**親のファイルには出ない**ので別に見る（#28）。
        //    親が待っている間にサブが動いていると、これが無いと『待機』と嘘をつく。
        const sub = await subagentActivity(newest.path, {
            now, activeMs: limits.activeMs, maxFiles: limits.maxSubagentFiles,
        });
        if (sub) {
            s.subagents = { total: sub.total, active: sub.active };
            // isSidechain では数えられないので、ファイル数で置き換える
            s.sidechains = sub.active;
            // サブが動いていれば、その時刻を『最後の活動』として採る
            if (sub.newestMs > 0) {
                const parentMs = s.lastActivityAt ? Date.parse(s.lastActivityAt) : 0;
                if (sub.newestMs > parentMs) {
                    s.lastActivityAt = new Date(sub.newestMs).toISOString();
                    s.activityFrom = 'subagent';
                }
                s.ageMs = Math.max(0, now - Date.parse(s.lastActivityAt));
                s.state = s.ageMs <= limits.activeMs ? 'active'
                    : s.ageMs <= limits.idleMs ? 'idle' : 'stale';
            }
            if (sub.truncated) {
                errors.push({
                    scope: 'agents',
                    message: `${owner.label} のサブエージェントは`
                        + `${limits.maxSubagentFiles} 件で打ち切りました（実際はもっとあります）。`,
                });
            }
        }
        // 🚨 広げても抽出できなかったら**そう言う**。「記録なし」にしない（#37）
        if (s.noneReason === 'no-known-records') {
            errors.push({
                scope: 'agents',
                message: `${owner.label} の記録から活動を抽出できませんでした`
                    + `（末尾 ${Math.round(tail.bytes / 1024)}KB が全部「知らない種別」です）。`
                    + ' 「記録なし」ではなく「抽出できなかった」です。',
            });
        }
        if (s.tooBigToRead) {
            errors.push({
                scope: 'agents',
                message: `${owner.label} の記録は1レコードが大きすぎて読めませんでした`
                    + `（末尾 ${Math.round(tail.bytesWanted / 1024)}KB を読んでも完全な行がありません）。`
                    + ' 「記録なし」ではなく「読めなかった」です。',
            });
        }
        const prev = byPath.get(owner.path);
        // 同じ worktree に複数の記録が対応することがある（slug の大文字小文字違い）。
        // 新しい方を採る
        if (!prev || (s.lastActivityAt ?? '') > (prev.lastActivityAt ?? '')) {
            byPath.set(owner.path, s);
        }
    }

    if (skippedDirs) {
        // 表示上限で省略したら必ず告知する（CLAUDE.md）
        errors.push({
            scope: 'agents',
            message: `活動記録は ${limits.maxDirs} 個のプロジェクトで打ち切りました（${skippedDirs} 個未確認）。`,
        });
    }
    // 🚨 cwd が読めなかったディレクトリは**どの worktree のものか判定できない**ので
    //    worktree 単位では告知できない。まとめて件数だけ出す。
    //    黙って捨てると、稼働中のエージェントに「記録なし」と言う経路が残る（#36）。
    if (cwdlessDirs) {
        errors.push({
            scope: 'agents',
            message: `${cwdlessDirs} 個のプロジェクトの記録から cwd が読めませんでした`
                + '（どの worktree のものか判定できないので観測から漏れています）。',
        });
    }
    // 🚨 **読めなかったことを黙って飲まない。** 1ファイルの失敗で
    //    プロジェクト全体を捨てていた形（#27 / #36 / #37 と同型）を直した名残として、
    //    残った失敗は件数で告知する。
    if (unreadableDirs || unreadableFiles) {
        errors.push({
            scope: 'agents',
            message: `記録を読めなかったものがあります（プロジェクト ${unreadableDirs} 個 / `
                + `ファイル ${unreadableFiles} 個）。その分は観測から漏れています。`,
        });
    }

    const agents = worktrees.map(w => ({
        path: w.path,
        name: w.label,
        ...(byPath.get(w.path) ?? { state: 'none', session: null, lastActivityAt: null, ageMs: null }),
    }));
    return { agents, errors };
}
