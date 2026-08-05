#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// 突然変異テスト。**「守っている」と主張するコードを1つずつ外して、
// 対応するテストが実際に落ちるかを確かめる。**
//
//   node scripts/mutate.mjs            # 全件
//   node scripts/mutate.mjs <name>...  # 指定したものだけ
//   node scripts/mutate.mjs --list
//
// なぜ必要か（実際に2件の偽陽性を作った。docs/review-write-exec.md）:
//   - `core.fsmonitor` のテストはフックのクォート不足で起動しておらず、
//     修正を外しても緑だった
//   - `pathspec magic` のテストは入口の検証しか見ておらず、
//     git フラグを外しても緑だった
//   **落ちない検査は無意味。** テストを足したらここに変異も足す。
//
// ⚠️ process.exit() を try の中で使わない。finally を飛ばして
//    書き換えたソースが復元されないまま残る（実際に修正を1行失った）。

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
process.chdir(ROOT);

/**
 * 各変異は「守りを外す書き換え」と「それを捕まえるべきテスト」の対。
 * gone: 書き換えが効いたことを確かめる文字列（消えていれば成功）。
 *   ⚠️ コメント中に同じ語が出る場合は引数の形で書く。
 *      そうしないと「置換が効いていない」と誤判定する（実際に踏んだ）。
 */
const MUTANTS = [
    {
        name: 'url-crash',
        why: '不正な request-target で認証前にプロセスが落ちる',
        file: 'v0/server.mjs',
        from: `    let url;
    try {
        url = new URL(req.url, 'http://localhost');
    } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('bad request target\\n');
        return;
    }
`,
        to: "    const url = new URL(req.url, 'http://localhost');\n",
        gone: 'bad request target',
        pattern: 'request-target',
    },
    {
        name: 'host-check',
        why: 'DNS rebinding（Host 検証を外す）',
        file: 'v0/server.mjs',
        from: '    if (!hostAllowed(req) || !siteAllowed(req)) {',
        to: '    if (false) {',
        gone: '!hostAllowed(req)',
        pattern: 'DNS rebinding',
    },
    {
        name: 'fsmonitor',
        why: '読み取り経路がリポジトリ設定のコマンドを実行する',
        file: 'v0/git.mjs',
        from: "    '-c', 'core.fsmonitor=false',\n",
        to: '',
        gone: "'core.fsmonitor=false'",
        pattern: 'core.fsmonitor',
    },
    {
        name: 'token-file-inside-repo',
        why: '表記の違い（8.3 短縮名 / symlink / /private/var）でリポジトリ内判定が外れ、'
            + '実行トークンがコミットされる',
        file: 'v0/git.mjs',
        // 祖先を realpath して継ぎ足す部分を消す = 素の文字列比較に戻す
        from: '        if (resolveAncestor) {\n',
        to: '        if (false) {\n',
        gone: 'if (resolveAncestor) {',
        pattern: 'まだ無いファイルでも別表記',
        testFile: 'v0/paths.test.mjs',
    },
    // #17: 「切断で殺す」をやめた代わりの制約。**外すと取り残しが戻る。**
    {
        name: 'exec-detached-grace',
        why: '切断後の猶予を無くす（購読者がいなくても永久に走り続け、取り残しが溜まる）',
        file: 'v0/execsession.mjs',
        from: `                if (!s.keepAlive && s.lastDetachedAt !== null
                    && now - s.lastDetachedAt >= this.limits.detachedGraceMs) {
                    kill.push({ session: s, reason: 'detached' });
                }`,
        to: '                /* 変異: 切断後の猶予をやめる */',
        gone: "reason: 'detached'",
        pattern: '切断後は猶予が過ぎたら殺す',
        testFile: 'v0/execsession.test.mjs',
    },
    {
        name: 'exec-absolute-timeout',
        why: '絶対上限を外す（keepAlive のセッションが無限に走る）',
        file: 'v0/execsession.mjs',
        from: `                if (now - s.createdAt >= this.execTimeoutMs) {
                    kill.push({ session: s, reason: 'timeout' });
                    continue;
                }`,
        to: '                /* 変異: 絶対上限をやめる */',
        gone: "reason: 'timeout'",
        pattern: '絶対上限（--exec-timeout）は keepAlive でも効く',
        testFile: 'v0/execsession.test.mjs',
    },
    {
        name: 'exec-retain-evict',
        why: '終了したセッションを台帳から消さない（メモリに溜まり続ける）',
        file: 'v0/execsession.mjs',
        // ⚠️ #24 の修正で条件から `&& !s.subscribers.size` を外したので追随させた。
        //    「消すかどうか」を測るのがこちら、「購読者がいても消すか」は
        //    `exec-evict-with-subscribers` が測る（別の守り）
        from: '            if (now - doneAt >= this.limits.retainMs) evict.push(s);',
        to: '            /* 変異: 終了後の掃除をやめる */',
        gone: 'evict.push(s)',
        pattern: '保持期間のあいだ残り、過ぎたら台帳から消える',
        testFile: 'v0/execsession.test.mjs',
    },
    {
        name: 'exec-slot-reserve-sync',
        why: '同時セッションの上限が効かない（8に対して24本走った実測がある）',
        file: 'v0/execsession.mjs',
        from: '        if (this.reserved >= this.limits.maxConcurrent) return null;',
        to: '        /* 変異: 上限の検査をやめる */',
        gone: 'this.reserved >= this.limits.maxConcurrent',
        pattern: '同時セッションの上限が効き',
        testFile: 'v0/execsession.test.mjs',
    },
    {
        name: 'exec-ring-missing',
        why: 'リングバッファで捨てた件数を告知しない（出力が完全だと誤解される）',
        file: 'v0/execsession.mjs',
        from: '        const missing = Math.max(0, firstKept - 1 - n);',
        to: '        const missing = 0;',
        gone: 'firstKept - 1 - n',
        pattern: '上限で捨てたら missing で告知できる',
        testFile: 'v0/execsession.test.mjs',
    },
    {
        name: 'exec-session-id-validation',
        why: 'セッション id の形を検証しない（HTTP から来た値をそのまま台帳に引く）',
        file: 'v0/execsession.mjs',
        from: '    return typeof v === \'string\' && ID_RE.test(v);',
        to: '    return typeof v === \'string\';',
        gone: 'ID_RE.test(v)',
        pattern: '形の違うものを弾く',
        testFile: 'v0/execsession.test.mjs',
    },
    {
        name: 'exec-kill-on-shutdown',
        why: 'サーバ終了時に子プロセスを置き去りにする'
            + '（Windows では libuv が SILENT_BREAKAWAY_OK を立てるので孫が回収されない）',
        file: 'v0/server.mjs',
        from: `        for (const s of execRegistry.running) {
            if (s.child) killTree(s.child).catch(() => {});
        }`,
        to: '        /* 変異: 終了時の後始末をやめる */',
        gone: 'execRegistry.running',
        // ⚠️ Windows では検証できない。child.kill('SIGTERM') は TerminateProcess に
        //    なるので process.on('SIGTERM') が走らない（= この守り自体が効かない）。
        //    ubuntu / macOS CI が検証する。
        platforms: ['linux', 'darwin'],
        pattern: 'サーバを SIGTERM で止めたら孫プロセスも残さない',
    },
    {
        name: 'read-auth-gate',
        why: '読み取り経路の認証を外す（トンネルに届く相手が誰でも差分を読める）',
        file: 'v0/server.mjs',
        from: '    if (!authed(req, url)) {',
        to: '    if (false) {',
        gone: '!authed(req, url)',
        pattern: 'トークンが無い / 違うと 401',
    },
    {
        name: 'read-auth-default-on-tunnel',
        why: '--allow-host を付けても認証が既定オンにならない'
            + '（無認証のままトンネルに出る）',
        file: 'v0/server.mjs',
        from: 'if (opts.requireAuth === null) opts.requireAuth = opts.allowHosts.size > 0;',
        to: 'if (opts.requireAuth === null) opts.requireAuth = false;',
        gone: 'opts.requireAuth = opts.allowHosts.size > 0',
        pattern: '--allow-host を付けると認証が既定で必須になる',
    },
    {
        name: 'no-auth-with-tunnel-refused',
        why: '--no-auth と --allow-host の併用を許すと、黙って無認証でトンネルに出る',
        file: 'v0/server.mjs',
        from: 'if (opts.requireAuth === false && opts.allowHosts.size > 0) {',
        to: 'if (false) {',
        gone: 'opts.requireAuth === false && opts.allowHosts.size > 0',
        pattern: '併用は起動を拒否する',
    },
    // 5回目のレビューの BLOCKING 2件（どちらも直前の修正による回帰）
    {
        // 🚨 6回目のレビュー: この門は自動生成より**後**にあったので、
        //    `--allow-host`（requireAuth を自動オン）を並べると消えていた
        name: 'exec-token-explicit',
        why: '実行の門を「明示的に決めたか」ではなく長さだけで見る'
            + '（requireAuth の自動生成トークン 43 文字が条件を満たす）',
        // ⚠️ **門を自動生成より前に置いた今は冗長。** その位置では `opts.token` は
        //    `--token` / `--token-file` でしか埋まらないので、長さの検査だけでも同じ結果になる。
        //    残す理由: **本体の守りは「順序」**で、順序が戻ったときにこれが第二の砦になる
        //    （順序そのものは `exec-token-gate-order` が測っている）。
        defensive: '門が自動生成より前にある限り冗長（その位置では token は明示でしか埋まらない）。'
            + '順序が戻ったときに効く第二の砦として残す。順序は exec-token-gate-order が測る',
        file: 'v0/server.mjs',
        from: 'if (opts.allowExec && (!opts.tokenExplicit || !opts.token || opts.token.length < 24)) {',
        to: 'if (opts.allowExec && (!opts.token || opts.token.length < 24)) {',
        gone: '!opts.tokenExplicit',
        pattern: '自動生成では通さない',
    },
    {
        name: 'exec-token-gate-order',
        why: '実行の門を自動生成より後ろに戻す（同じ穴が順序で復活する）',
        file: 'v0/server.mjs',
        from: `if (opts.allowExec && (!opts.tokenExplicit || !opts.token || opts.token.length < 24)) {`,
        to: `if (opts.requireAuth && !opts.token) opts.token = randomBytes(32).toString('base64url');
if (opts.allowExec && (!opts.token || opts.token.length < 24)) {`,
        gone: 'if (opts.allowExec && (!opts.tokenExplicit',
        pattern: '自動生成では通さない',
    },
    {
        name: 'token-url-for-write-exec',
        why: '書き込み・実行を有効にしてもトークン付き URL を表示しない'
            + '（ブラウザが入手する経路が無いので UI から必ず 403。有効に見えて動かない）',
        file: 'v0/server.mjs',
        from: '    if (opts.requireAuth || opts.allowWrite || opts.allowExec) {',
        to: '    if (opts.requireAuth) {',
        gone: 'opts.requireAuth || opts.allowWrite || opts.allowExec',
        pattern: 'ブラウザがトークンを入手できる経路がある',
    },
    {
        name: 'stream-detach-if-gone',
        why: '応答が届く前に切られた場合を検知しない'
            + '（購読者が永久に残り、切断後の猶予が完全に無効化される）',
        file: 'v0/server.mjs',
        // ⚠️ `req.destroyed` を混ぜた版で書いていたので SKIP になっていた（守りが
        //    未検証のまま静かに残る）。**SKIP を緑と読まない**（CLAUDE.md）
        from: '    if (res.destroyed) detach();',
        to: '    /* 変異: 既に切られている場合を見ない */',
        gone: 'if (res.destroyed) detach()',
        pattern: '応答が届く前に切っても切断として扱い',
    },
    // L3 #2: 判定できないものを「衝突する」と言わない
    {
        name: 'submodule-undecidable',
        why: 'submodule の衝突を「判定できない」ではなく「衝突する」として出す'
            + '（git 自身が trivial なケースしか対応しないと言っている）',
        file: 'v0/git.mjs',
        from: '        if (/submodule/i.test(kind)) {',
        to: '        if (false) {',
        gone: 'if (/submodule/i.test(kind)) {',
        pattern: 'submodule は「衝突する」ではなく',
    },
    {
        name: 'mergeplan-unknown-not-conflict',
        why: 'clean=null（不明）を衝突として扱う（判定できないペアを「衝突する」と提示する嘘）',
        file: 'v0/mergeplan.mjs',
        from: '        } else if (c.clean === false) {\n            tested++;',
        to: '        } else {\n            tested++;',
        gone: '} else if (c.clean === false) {',
        pattern: '「衝突する」と提示しない',
        testFile: 'v0/mergeplan.test.mjs',
    },
    // L3 #1 / #4: 「開けないものを普通に出す」「別のものを同じ見た目で並べる」
    {
        name: 'conflict-synthetic-path',
        why: 'merge-tree の退避名（実在しないパス）を普通のファイル名として出す'
            + '（押しても開けない行き止まりになる）',
        file: 'v0/git.mjs',
        from: "        synthetic.set(toNFC(m[2].trim()), toNFC(m[1].trim()));",
        to: '        /* 変異: 退避名を拾わない */',
        gone: 'synthetic.set(toNFC(m[2].trim())',
        // ⚠️ 構造からも取るようになったので、メッセージ側だけ外しても
        //    file/directory は検出できる。**両方外して守り全体を測る。**
        also: [{
            from: `        if (count === 2) {
            const [p, q] = paths;
            if (p.startsWith(\`\${q}~\`)) synthetic.set(p, q);
            else if (q.startsWith(\`\${p}~\`)) synthetic.set(q, p);
        }`,
            to: '        /* 変異: 構造からも拾わない */',
        }],
        pattern: '合成パスを印付けて',
    },
    {
        // 🚨 symlink 対 file は**メッセージに退避名が出ない**ので、構造からしか取れない
        name: 'conflict-synthetic-structural',
        why: '情報レコードの構造から退避名を取らない'
            + '（symlink 対 file = CONFLICT (distinct types) は '
            + '`moving it to X instead` と言わないので、合成パスが印無しで出る）',
        file: 'v0/git.mjs',
        from: `        if (count === 2) {
            const [p, q] = paths;
            if (p.startsWith(\`\${q}~\`)) synthetic.set(p, q);
            else if (q.startsWith(\`\${p}~\`)) synthetic.set(q, p);
        }`,
        to: '        /* 変異: 構造から拾わない */',
        gone: 'if (p.startsWith(`${q}~`))',
        pattern: 'symlink 対 file の合成パスにも印が付く',
    },
    // #33: bare / prunable の門。以前は**本物の bare を作っていなかった**ので
    //      4つとも外しても全テストが緑だった（過去2件と同じクラスの偽陽性）。
    {
        name: 'exec-bare-gate',
        why: 'bare worktree を cwd にできる（作業ツリーの無い場所で任意コマンドが走る）',
        file: 'v0/server.mjs',
        from: "            if (wt.bare) { bail(400, 'bare worktree では実行できません'); return; }",
        to: '            /* 変異: bare の門を外す */',
        gone: "bail(400, 'bare worktree では実行できません')",
        pattern: 'bare と prunable の門が実際に効く',
    },
    {
        name: 'exec-prunable-gate',
        why: '実体の消えた worktree を cwd にできる（ENOENT で経路が壊れる）',
        file: 'v0/server.mjs',
        from: "            if (wt.prunable) { bail(409, '作業ツリーが失われています'); return; }",
        to: '            /* 変異: prunable の門を外す */',
        gone: "bail(409, '作業ツリーが失われています')",
        pattern: 'bare と prunable の門が実際に効く',
    },
    {
        name: 'checkout-bare-gate',
        why: 'bare worktree で checkout を通す（作業ツリーが無いので必ず壊れる）',
        file: 'v0/server.mjs',
        from: "            if (wt.bare) { denyJson(res, 400, 'bare worktree では checkout できません'); return; }",
        to: '            /* 変異: bare の門を外す */',
        gone: "'bare worktree では checkout できません'",
        pattern: 'bare と prunable の門が実際に効く',
    },
    {
        name: 'checkout-prunable-gate',
        why: '実体の消えた worktree で checkout を通す',
        file: 'v0/server.mjs',
        from: "            if (wt.prunable) { denyJson(res, 409, '作業ツリーが失われています'); return; }",
        to: '            /* 変異: prunable の門を外す */',
        gone: "denyJson(res, 409, '作業ツリーが失われています')",
        pattern: 'bare と prunable の門が実際に効く',
    },
    {
        name: 'repo-accepts-bare',
        why: 'bare リポジトリを開けなくする（bare を親に worktree を並べる構成が使えない。'
            + 'かつ bare の門が到達不能になって検証できなくなる）',
        file: 'v0/server.mjs',
        from: "    try { top = (await git(['rev-parse', '--show-toplevel'], { cwd: opts.repo })).trim(); }\n    catch { /* bare。下で判定する */ }",
        to: "    top = (await git(['rev-parse', '--show-toplevel'], { cwd: opts.repo })).trim();",
        gone: 'catch { /* bare。下で判定する */ }',
        pattern: 'bare と prunable の門が実際に効く',
    },
    // 4回目のレビューの SERIOUS 4件（issue #26-#28, #32）
    {
        name: 'input-total-limit',
        why: '標準入力の総量を縛らない（相手が読まないと親のメモリに無限に溜まる）',
        file: 'v0/server.mjs',
        from: '                    if (s.inputBytes + bytes > limits.inputTotalBytes) {',
        to: '                    if (false) {',
        gone: 's.inputBytes + bytes > limits.inputTotalBytes',
        // 滞留の上限（1MB）が先に効くので、単独では落ちない可能性がある。
        // 両方外して「上限が全く無い」状態を測る
        also: [{
            from: '                    if (pending > limits.inputPendingBytes) {',
            to: '                    if (false) {',
        }],
        pattern: '標準入力の総量と滞留に上限がある',
    },
    {
        name: 'transcript-adaptive-tail',
        why: '巨大な1レコードで完全な行が0本になったとき読み直さない'
            + '（稼働中のエージェントに「記録がありません」と表示する嘘）',
        file: 'v0/transcript.mjs',
        from: '            needMore: complete === 0 && len < size,',
        to: '            needMore: false,',
        gone: 'complete === 0 && len < size',
        pattern: '巨大な1レコードでも読み直して',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-too-big-honest',
        why: '上限まで読んでも取れなかったことを伝えない（黙って「記録なし」になる）',
        file: 'v0/transcript.mjs',
        from: '        s.tooBigToRead = tail.tooBigToRead === true;',
        to: '        s.tooBigToRead = false;',
        gone: 'tail.tooBigToRead === true',
        pattern: '読めなかった」と伝える',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-subagents',
        why: 'サブエージェントの活動を数えない'
            + '（親の追記が止まるので、稼働中を「待機」と表示する嘘）',
        file: 'v0/transcript.mjs',
        from: '        const sub = await subagentActivity(newest.path, {',
        to: '        const sub = null && await subagentActivity(newest.path, {',
        gone: '        const sub = await subagentActivity',
        pattern: 'サブエージェントの活動を数え',
        testFile: 'v0/transcript.test.mjs',
    },
    // 4回目のレビューの SERIOUS 3件（issue #23-#25）
    {
        name: 'cookie-decode-crash',
        why: '壊れた Cookie（`kjp_auth=%`）1本で認可の手前に URIError が飛び、'
            + 'デーモンが exit 1 で落ちる（無認証で撃てる DoS）',
        file: 'v0/server.mjs',
        from: '        try { out.push(decodeURIComponent(v)); } catch { out.push(v); }',
        to: '        out.push(decodeURIComponent(v));',
        gone: 'try { out.push(decodeURIComponent(v)); }',
        // ⚠️ 外側の catch-all も守っているので、単独では落ちない可能性がある。
        //    両方外して守り全体を測る。
        // 🚨 **以前の書き方は無効だった。** `.catch(err => { throw err; }).catch(本体)` は
        //    直後の catch が再捕捉するので catch-all は外れておらず、
        //    「両方外して測る」というコメント自体が事実と違っていた（#42）。
        //    catch の**中身**を rethrow に置き換える。
        also: [{
            from: "        console.error('⚠ 要求の処理で例外（デーモンは継続します）:', err);",
            to: '        throw err;   /* 変異: catch-all を無効化 */',
        }],
        pattern: '壊れた Cookie / ヘッダでデーモンが落ちない',
    },
    {
        // 🚨 #42: 汎用の砦そのものを外す。以前は検査が1つも無く、丸ごと消しても全緑だった
        name: 'handler-catch-all',
        why: 'ハンドラの例外を捕まえる最後の砦を外す'
            + '（unhandled rejection でデーモンが exit 1。走っている全セッションが消える）',
        file: 'v0/server.mjs',
        from: "        console.error('⚠ 要求の処理で例外（デーモンは継続します）:', err);",
        to: '        throw err;   /* 変異: 砦を無効化 */',
        gone: 'デーモンは継続します',
        pattern: 'ハンドラが throw しても 500 を返して',
    },
    {
        name: 'handler-error-leak',
        why: '例外のメッセージをクライアントに返す'
            + '（内部のパスや git の出力が、認証を通っていない相手にも渡る）',
        file: 'v0/server.mjs',
        from: "        res.end(JSON.stringify({ error: 'internal error' }));\n    }\n}",
        to: '        res.end(JSON.stringify({ error: String(err && err.message || err) }));\n    }\n}',
        gone: "res.end(JSON.stringify({ error: 'internal error' }));\n    }\n}",
        pattern: 'ハンドラが throw しても 500 を返して',
    },
    {
        name: 'exec-subscriber-backpressure',
        why: '読まない購読者に無制限に溜める（RSS 72MB→433MB を実測）',
        file: 'v0/server.mjs',
        from: '        if (res.writableLength > MAX_PENDING_BYTES) {',
        to: '        if (false) {',
        gone: 'res.writableLength > MAX_PENDING_BYTES',
        pattern: '読まない購読者は切られ',
    },
    {
        name: 'exec-evict-with-subscribers',
        why: '購読者が残っていると終了済みセッションを永久に消さない'
            + '（詰まったソケット1つでメモリが溜まり続ける）',
        file: 'v0/execsession.mjs',
        from: '            if (now - doneAt >= this.limits.retainMs) evict.push(s);',
        to: '            if (now - doneAt >= this.limits.retainMs && !s.subscribers.size) evict.push(s);',
        gone: 'this.limits.retainMs) evict.push(s);',
        pattern: '保持期間を過ぎたら購読者がいても消す',
        testFile: 'v0/execsession.test.mjs',
    },
    {
        name: 'exec-attach-after-finish',
        why: '終わったセッションを running に戻す'
            + '（「停止した」後に走り続け、枠が二重に返る）',
        file: 'v0/execsession.mjs',
        from: '        if (!s.running) return false;\n        s.child = child;',
        to: '        s.child = child;',
        gone: 'if (!s.running) return false;\n        s.child',
        pattern: 'attachChild は終わったセッションを running に戻さない',
        testFile: 'v0/execsession.test.mjs',
    },
    // 4回目のレビュー（並列・独立）で見つかった BLOCKING 4件。
    // docs/review-4-parallel.md / issue #19-#22
    {
        name: 'session-token-to-cookie-auth',
        why: 'Cookie 認証の要求に実行トークンを返す。Cookie はポートで分離されないので、'
            + '他ポートを開いた相手がリクエスト1本多いだけで任意コード実行に到達する（実測）',
        file: 'v0/server.mjs',
        from: '                token: opts.allowWrite && sameOrigin && presentedToken(req, url)\n                    ? opts.token : null,',
        to: '                token: opts.allowWrite && sameOrigin ? opts.token : null,',
        // ⚠️ `presentedToken(` は関数定義側にも出るので、呼び出しの形で一意にする
        gone: 'sameOrigin && presentedToken',
        pattern: 'Cookie の値は実行トークンと別で',
    },
    // spawn 失敗（'exit' が来ない）と孫が stdio を握る場合（'close' が来ない）を
    // **2つのハンドラで両側から**塞いでいる。どちらが load-bearing かを個別に測る。
    // ⚠️ `close` 側と `error` 側は**どちらも単独で ENOENT を終端できる**ので、
    //    片方ずつ外しても落ちない（実測で確認）。それは「テストの穴」ではなく
    //    「守りが二重」なので、**両方を外す変異**で守り全体を測る。
    //    2つある理由は失敗の形が2つあること: spawn 失敗は 'exit' が来ない、
    //    孫が stdio を握ると 'close' が来ない。
    {
        name: 'exec-spawn-terminate',
        why: "spawn の非同期失敗（ENOENT）を終端する経路が両方無くなると、"
            + 'セッションが永久に running になり枠も返らない'
            + '（起動していないプロセスを「実行中」と表示する嘘）',
        file: 'v0/server.mjs',
        from: `            child.on('close', () => {
                if (execRegistry.finish(session, { code: null, signal: null,`,
        to: `            child.on('close', () => {
                if (false && execRegistry.finish(session, { code: null, signal: null,`,
        also: [{
            from: '                if (execRegistry.finish(session, { code: null, signal: null })) {',
            to: '                if (false) {',
        }],
        gone: "child.on('close', () => {\n                if (execRegistry.finish",
        pattern: '起動できないコマンドでもセッションが終端し',
    },
    {
        name: 'exec-exit-finish',
        why: "'exit' で終端しない。正常終了の終了コードが取れなくなる"
            + "（'close' の保険に落ちて code:null になる）",
        file: 'v0/server.mjs',
        from: '                if (execRegistry.finish(session, { code, signal })) {',
        to: '                if (false) {',
        gone: 'execRegistry.finish(session, { code, signal })',
        pattern: 'exec が出力を流し、終了コードを返す',
    },
    {
        name: 'exec-spawn-error-note',
        why: 'spawn 失敗の理由を出さない（何が起きたか分からない）',
        // 終端そのものは 'close' が担うので、この行は理由の告知が本体。
        // 冗長ではなく役割が違うことを記録しておく。
        defensive: '終端は close が担う。この行は「なぜ起動できなかったか」の告知',
        file: 'v0/server.mjs',
        from: '                if (execRegistry.finish(session, { code: null, signal: null })) {',
        to: '                if (false) {',
        gone: 'execRegistry.finish(session, { code: null, signal: null })) {',
        pattern: '起動できないコマンドでもセッションが終端し',
    },
    {
        name: 'stdin-error-listener',
        why: 'child.stdin の error を拾わない（EPIPE で uncaught → デーモンが落ちる）',
        file: 'v0/server.mjs',
        from: "            child.stdin?.on('error', err => {",
        to: '            if (false) (err => {',
        gone: "child.stdin?.on('error'",
        pattern: '相手が終わった直後に標準入力へ送っても',
    },
    {
        name: 'transcript-string-content',
        why: 'user の文字列 content から本文を出す'
            + '（ツールの結果と形で区別できないので T5 が漏れる）',
        file: 'v0/transcript.mjs',
        from: "            if (typeof content === 'string' && r.type === 'user') out.talk++;",
        to: "            if (typeof content === 'string' && r.type === 'user') {\n"
            + '                out.talk++;\n'
            + '                if (allowText && out.text.length < limits.maxText) {\n'
            + '                    const t = clip(content, limits.textChars);\n'
            + "                    if (t) out.text.push({ at, role: 'user', text: t });\n"
            + '                }\n'
            + '            }',
        gone: "if (typeof content === 'string' && r.type === 'user') out.talk++;",
        pattern: '文字列の content は allowText でも本文を出さない',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'auth-cookie-is-exec-token',
        why: 'Cookie に実行トークンをそのまま入れる。'
            + 'Cookie はポートで分離されないので、同じブラウザで開いた他のローカル'
            + 'サービスに実行トークンが渡り、任意コマンドを実行できる',
        file: 'v0/server.mjs',
        // ⚠️ #43 で `readCookie` → `readCookies`（全部返す）にしたので字面が変わった
        from: '    return readCookies(req, AUTH_COOKIE).some(v => secretMatches(v, cookieSecret()))',
        to: '    return readCookies(req, AUTH_COOKIE).some(v => tokenMatches(v))',
        gone: 'some(v => secretMatches(v, cookieSecret()))',
        pattern: 'Cookie の値は実行トークンと別で',
    },
    {
        name: 'exec-bail-on-prepare-error',
        why: '準備（worktree 一覧）の失敗を bail に通さない'
            + '（枠が返らず 8 回で恒久的に 429。再起動しか回復手段が無い #35）',
        file: 'v0/server.mjs',
        from: '                bail(500, `実行の準備に失敗しました: ${err.message}`);',
        to: '                throw err;   /* 変異: 枠を返さず外の catch-all に投げる */',
        gone: 'bail(500, `実行の準備に失敗しました',
        pattern: '準備に失敗しても枠を返す',
    },
    {
        name: 'exec-sweeper-early',
        why: '回収機構の起動を「過去に1本成功したか」に依存させる（#35）',
        // ⚠️ bail を直した今、**枠の回収は sweeper に依存していない**（finish が返す）。
        //    残る差は「終了済みセッションの台帳からの追い出し」で、
        //    `retainMs = 10分` 経ってからしか観測できないので安く測れない。
        //    それでも前に出しておく: 回収の有無が過去の成功に依存する形は、
        //    別の失敗経路を足した瞬間に**恒久 429** に戻る（実際にそうなっていた）。
        defensive: '枠は finish が返すので現状は保険。'
            + '追い出しの差は retainMs=10分 後にしか出ず安く測れない。'
            + '失敗経路を足したときに恒久 429 へ戻らないための前出し',
        file: 'v0/server.mjs',
        from: '            startExecSweeper();\n\n            // 予約した後の失敗経路は必ず枠を返す',
        to: '            // 予約した後の失敗経路は必ず枠を返す',
        gone: '            startExecSweeper();\n\n',
        pattern: '準備に失敗しても枠を返す',
    },
    {
        name: 'token-file-worktrees',
        why: '全 worktree を見ずにメインの top だけで判定する'
            + '（linked worktree に置かせて、エージェントの git add -A でコミットされる #39）',
        file: 'v0/server.mjs',
        from: '            for (const w of await listWorktrees(opts.repo)) if (w.path) roots.push(w.path);',
        to: '            /* 変異: worktree を見ない */',
        gone: 'if (w.path) roots.push(w.path)',
        pattern: 'linked worktree と bare の中も拒否する',
    },
    {
        name: 'token-file-common-dir',
        why: '.git 本体（bare のリポジトリ自身を含む）を見ない',
        // ⚠️ 現在の実装では冗長。`listWorktrees()` は bare の worktree レコードも
        //    返し、`.git` はメイン worktree の中にあるので、どちらも worktree 一覧で
        //    捕まる（実測: この行を外しても bare / .git の拒否は落ちない）。
        //    それでも残す理由: **`worktree list` が失敗したときの唯一の根**になる。
        //    無いと roots が空になり `unknown`（判定できない）に落ちて素通りする。
        defensive: 'listWorktrees() が bare も .git の親も返すので現状は二重。'
            + 'worktree list が失敗したときに roots を空にしない（unknown に落とさない）ための根として残す',
        file: 'v0/server.mjs',
        from: `            const common = (await commonDir(opts.repo)).trim();
            if (common) roots.push(common);`,
        to: '            /* 変異: .git を見ない */',
        gone: 'if (common) roots.push(common)',
        pattern: 'linked worktree と bare の中も拒否する',
    },
    {
        name: 'auth-cookie-first-only',
        why: '同名 Cookie の先頭1本しか見ない（他ポートのページが `path=/api/v0` に junk を焼くと'
            + '**手で消すまで 401**。焼き直しは Path=/ なので上書きできない）',
        file: 'v0/server.mjs',
        from: '    return readCookies(req, AUTH_COOKIE).some(v => secretMatches(v, cookieSecret()))',
        to: '    return secretMatches(readCookies(req, AUTH_COOKIE)[0], cookieSecret())',
        gone: '.some(v => secretMatches(v, cookieSecret()))',
        pattern: '他ポートが焼いた同名 Cookie を先頭に置かれても締め出されない',
    },
    {
        name: 'auth-cookie-samesite',
        why: 'Cookie の SameSite / HttpOnly を外す（CSRF と JS からの読み取りに開く）',
        file: 'v0/server.mjs',
        from: "            + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000');",
        to: "            + '; Path=/; Max-Age=31536000');",
        gone: 'HttpOnly; SameSite=Strict',
        pattern: '読み取り用の Cookie を焼き、ページ本体を返す',
    },
    {
        // ⚠️ リダイレクトをやめたので、URL からトークンを消すのは**ページ側**の仕事に移った
        //    （4回目のレビュー: 302 だと JS がトークンを見られず、Cookie から
        //     取り戻す作りになって RCE の穴になっていた）。変異先も app.html に移す。
        name: 'auth-token-not-in-url',
        why: 'ページが URL からトークンを消さない（履歴と Referer に残る）',
        file: 'v0/app.html',
        from: "    history.replaceState(null, '', `${u.pathname}${u.search}${u.hash}`);",
        to: '    /* 変異: URL からトークンを落とさない */',
        gone: 'history.replaceState',
        script: 'v0/render-check.mjs',
    },
    {
        name: 'auth-token-in-session-storage',
        why: 'トークンを sessionStorage に持たない。'
            + 'Cookie 経由でしか取り戻せなくなり、他ポートの相手が実行に到達する',
        file: 'v0/app.html',
        from: '    try { sessionStorage.setItem(TOKEN_KEY, t); } catch { /* 使えない環境 */ }',
        to: '    /* 変異: トークンを保持しない */',
        gone: 'sessionStorage.setItem(TOKEN_KEY, t)',
        script: 'v0/render-check.mjs',
    },
    {
        // 🚨 **行を消さずに到達不能にする変異。** #41 の本題はこれ。
        //    以前の smoke は JS の**字面**しか見ていなかったので、
        //    `if (false && t)` で囲むだけの変更が完全に見えなかった。
        name: 'auth-token-bootstrap-unreachable',
        why: 'トークンの取り込みを到達不能にする（行は残るので字面の検査では見えない）',
        file: 'v0/app.html',
        from: '  const t = u.searchParams.get(\'token\');\n  if (t) {',
        to: '  const t = u.searchParams.get(\'token\');\n  if (false && t) {',
        gone: "get('token');\n  if (t) {",
        script: 'v0/render-check.mjs',
    },
    // ---- 運用スクリプトの門（#45。ここには変異が1件も無かった）----
    // 🚨 これらの守りは落ちても**手元では気付けない**形で壊れる:
    //    `--allow-host` を落とすと**再起動後だけ 403**、観測フラグを落とすと
    //    **ログオン後だけパネルが消える**。だから変異で固定する。
    {
        name: 'serve-unknown-flag',
        why: '知らないオプションを黙って捨てる（--allow-write を渡した人に「読み取り専用」と表示していた #30）',
        file: 'scripts/serveargs.mjs',
        from: "        if (!a.startsWith('-') || known.has(a)) continue;",
        to: '        continue;',
        gone: 'known.has(a)',
        pattern: '知らないオプションは黙って捨てずに止める',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-value-skip',
        why: '値をフラグとして検査する（--port -1 を「知らないオプション」と誤報して原因から目を逸らす）',
        file: 'scripts/serveargs.mjs',
        from: '        if (VALUE_FLAGS.has(a)) { i++; continue; }',
        to: '        /* 変異: 値を飛ばさない */',
        gone: 'VALUE_FLAGS.has(a)',
        pattern: '知っているオプションと値は未知として報告しない',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-port-range',
        why: '--port の範囲検証を外す（0 や 65536 で起動して失敗の理由が分からなくなる）',
        file: 'scripts/serveargs.mjs',
        from: '    if (!Number.isFinite(n) || n < 1 || n > 65535) return { error: String(raw) };',
        to: '    /* 変異: 範囲を見ない */',
        gone: 'n > 65535',
        pattern: '--port は範囲外と非数値を拒否する',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-host-validate',
        why: 'ホスト名の形の検証を外す（Run キーの1つの文字列の中で別の引数に化ける #29）',
        file: 'scripts/serveargs.mjs',
        from: "    if (!h || !/^[A-Za-z0-9._-]+$/.test(h)) return { error: h ?? null };",
        to: '    if (!h) return { error: h ?? null };',
        gone: 'A-Za-z0-9._-',
        pattern: '--allow-host はホスト名の形だけ通す',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-host-forward',
        why: '--allow-host をサーバに引き継がない（**再起動後だけ 403**。手元では気付けない）',
        file: 'scripts/serveargs.mjs',
        from: "    for (const h of hosts) args.push('--allow-host', h);",
        to: '    /* 変異: 引き継がない */',
        gone: "for (const h of hosts) args.push",
        pattern: '--allow-host は値ごとサーバに引き継ぐ',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-watch-forward',
        why: '観測フラグをサーバに引き継がない（**ログオン後だけパネルが消える**）',
        file: 'scripts/serveargs.mjs',
        from: `    if (has('--agents-text')) args.push('--watch-agents', '--allow-transcript-text');
    else if (has('--watch')) args.push('--watch-agents');`,
        to: '    /* 変異: 観測フラグを引き継がない */',
        gone: "args.push('--watch-agents', '--allow-transcript-text')",
        pattern: '観測フラグを引き継ぐ',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-exec-implies-write',
        why: '--exec が --write を含まなくなる（実行はできるのに checkout が 403 になる）',
        file: 'scripts/serveargs.mjs',
        from: "    const wantWrite = wantExec || has('--write');",
        to: "    const wantWrite = has('--write');",
        gone: "wantExec || has('--write')",
        pattern: '--exec は --write を含むが',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-audit-log',
        why: '実行を許すのに監査ログを付けない（何が走ったか後から分からない）',
        file: 'scripts/serveargs.mjs',
        from: "        if (auditLog) args.push('--audit-log', auditLog);",
        to: '        /* 変異: 監査ログを付けない */',
        gone: "args.push('--audit-log', auditLog)",
        pattern: '--exec は --write を含むが',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-token-separate',
        why: '読み取り用トンネルと実行で同じトークンファイルを使う'
            + '（読み取り用の URL をスマホで開くことが実行トークンを配ることになる。6回目のレビュー）',
        file: 'scripts/serveargs.mjs',
        from: '    const file = wantExec ? execTokenFile : tokenFile;',
        to: '    const file = tokenFile;',
        gone: 'wantExec ? execTokenFile : tokenFile',
        pattern: '読み取り用トンネルと実行でトークンのファイルを分ける',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'serve-token-persist',
        why: 'トークンを永続化しない（遠隔から使えず「楽な場所に置く」方向へ流れる）',
        file: 'scripts/serveargs.mjs',
        // ⚠️ トークンを読み取り用と実行用に分けたので字面が変わった（6回目のレビュー）
        from: "    if ((hosts.length > 0 || wantExec) && file) args.push('--token-file', file);",
        to: '    /* 変異: 永続化しない */',
        gone: "args.push('--token-file', file)",
        pattern: '実行とトンネルはトークンを永続化する',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        // 純関数を全部テストしても「呼んでいない」は検出できないので、配線も外す
        name: 'serve-calls-gate',
        why: 'serve.mjs が未知フラグの門を呼ばない（純関数は緑のままだが打ったフラグが効かない）',
        file: 'scripts/serve.mjs',
        from: "    const bad = unknownFlag(argv, SERVE_FLAGS, 'この起動口');",
        to: '    const bad = null;',
        gone: 'unknownFlag(argv, SERVE_FLAGS',
        pattern: 'serve.mjs は知らないオプションで起動せずに止まる',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        name: 'autostart-calls-gate',
        why: 'autostart.mjs が未知フラグの門を呼ばない（壊れた登録がそのまま Run キーに入る）',
        file: 'scripts/autostart.mjs',
        from: "    const bad = unknownFlag(argv, AUTOSTART_FLAGS, 'このスクリプト');",
        to: '    const bad = null;',
        gone: 'unknownFlag(argv, AUTOSTART_FLAGS',
        pattern: 'autostart.mjs は知らないオプションで登録せずに止まる',
        testFile: 'scripts/serveargs.test.mjs',
        platforms: ['win32'],
    },
    {
        name: 'autostart-forward',
        why: '自動起動の登録が --allow-host と観測フラグを引き継がない（c0948ea の回帰）',
        file: 'scripts/serveargs.mjs',
        from: `    for (const h of hosts.hosts) args.push('--allow-host', h);
    if (has('--agents-text')) args.push('--agents-text');
    else if (has('--watch')) args.push('--watch');`,
        to: '    /* 変異: 登録に引き継がない */',
        gone: "args.push('--agents-text')",
        pattern: '自動起動は capability と引き継ぎを',
        testFile: 'scripts/serveargs.test.mjs',
    },
    {
        // #3 の予算。**`node --test` ではなく実ブラウザの検査に掛ける**
        name: 'render-raf-batch',
        why: 'rAF でまとめるのをやめる（1件ごとに scrollHeight を読んで総文字数に対して二次。'
            + '実測 12,000行で 53.8秒、その間 停止ボタンも自動更新も効かない）',
        file: 'v0/app.html',
        from: '    if (!flushing) { flushing = true; requestAnimationFrame(flush); }',
        to: '    flush();',
        gone: 'requestAnimationFrame(flush)',
        script: 'v0/render-check.mjs',
    },
    {
        // #4: ファイラの数字が信じられる形になっていること
        name: 'filer-what-diff',
        why: 'ファイラが「何の差分か」を言わない（`base...HEAD` のコミット済み差分と'
            + 'カードの「変更 N・未追跡 N」= 未コミットの数を、同じ見た目で並べる）',
        file: 'v0/app.html',
        from: `  tree.append(el('div', 'note',
    \`コミット済みの差分です（\${s.base ?? 'base'} と各 worktree の HEAD を比べたもの）。\`
    + ' カードの「変更 N・未追跡 N」は未コミットの数なので、一致しません。'));`,
        to: '  /* 変異: 何の差分かを言わない */',
        gone: '未コミットの数なので、一致しません',
        script: 'v0/render-check.mjs',
    },
    {
        name: 'filer-uncommitted-count',
        why: 'コミット済み差分ゼロのときに未コミットの数を出さない'
            + '（「変更 1」なのに「(差分なし)」になり、どちらの数字も信じられなくなる #4）',
        file: 'v0/app.html',
        from: `      tree.append(el('div', 'f', uncommitted
        ? \`   (コミット済みの差分なし / 未コミット \${uncommitted} 件)\`
        : '   (差分なし)'));`,
        to: "      tree.append(el('div', 'f', '   (差分なし)'));",
        gone: 'コミット済みの差分なし / 未コミット',
        script: 'v0/render-check.mjs',
    },
    {
        name: 'render-term-trim',
        why: '表示上限で古い要素を捨てるのをやめる（DOM が無限に伸びて固まる）',
        file: 'v0/app.html',
        from: '    if (termEl.childNodes.length > TERM_MAX_SPANS) {',
        to: '    if (false) {',
        gone: 'termEl.childNodes.length > TERM_MAX_SPANS',
        script: 'v0/render-check.mjs',
    },
    {
        name: 'render-trim-notice',
        why: '捨てたことの告知を出さない（「全部見えている」と誤認させる）',
        file: 'v0/app.html',
        from: `        notice = el('span', 'w', \`⚠ 出力が多いので古い行を捨てています（直近 \${TERM_MAX_SPANS} 要素）
\`);
        termEl.prepend(notice);`,
        to: "        notice = el('span', 'w', '');\n        termEl.prepend(notice);",
        gone: '古い行を捨てています',
        script: 'v0/render-check.mjs',
    },
    {
        name: 'render-trim-keeps-notice',
        why: '告知の次からではなく先頭から捨てる（次のトリムで告知自身が消える）',
        file: 'v0/app.html',
        from: '      for (let i = 0; i < drop; i++) notice.nextSibling?.remove();',
        to: '      for (let i = 0; i < drop; i++) termEl.firstChild?.remove();',
        gone: 'notice.nextSibling?.remove()',
        script: 'v0/render-check.mjs',
    },
    {
        name: 'transcript-type-allowlist',
        why: '走査するレコード種別の許可リストを外すと、'
            + 'file-history-snapshot / attachment / last-prompt から自由文が漏れる',
        file: 'v0/transcript.mjs',
        from: '        if (!SCAN_TYPES.has(r.type)) continue;',
        to: '        /* 変異: 種別の許可リストを外す */',
        gone: 'SCAN_TYPES.has(r.type)',
        pattern: '知らないレコード種別は',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-t5',
        why: 'ツール結果と thinking を出す（読んだファイルの中身とコマンド出力が漏れる）',
        // ⚠️ 現在の実装では冗長。ブロックの抽出も許可リストで、
        //    `text` と `tool_use` 以外は素通りするので、この行を外しても漏れない。
        //    それでも残す理由: **意図を明示する行**であり、将来 `text` の扱いを
        //    一般化したときに最初に効く砦になる。冗長であることを記録しておく。
        defensive: 'ブロックの抽出も許可リスト（text / tool_use のみ）なので現状は二重。意図の明示として残す',
        file: 'v0/transcript.mjs',
        from: "            if (b.type === 'tool_result' || b.type === 'thinking') continue;",
        to: '            /* 変異: T5 の除外をやめる */',
        gone: "b.type === 'tool_result'",
        pattern: 'ツール結果と thinking は出さない',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'serve-shared-modules',
        why: 'UI が import する共有モジュールを配信しない（import が1本 404 になると'
            + 'モジュール全体が実行されず**ページが真っ白**になる）',
        file: 'v0/server.mjs',
        from: "            || url.pathname === '/chatfilter.mjs') {",
        to: '            || false) {',
        gone: "url.pathname === '/chatfilter.mjs'",
        pattern: 'import しているモジュールが全部配信される',
    },
    {
        name: 'chat-argv-detect',
        why: '会話モードを argv から見分けない（再接続で生のテキストを stdin に書き、'
            + 'claude が exit 1 で死んで会話の文脈が丸ごと消える。6回目のレビュー）',
        file: 'v0/argv.mjs',
        from: "        if (argv[i] === '--input-format' && argv[i + 1] === 'stream-json') return true;",
        to: '        /* 変異: 会話モードを見分けない */',
        gone: "argv[i] === '--input-format'",
        pattern: 'isChatArgv',
        testFile: 'v0/argv.test.mjs',
    },
    {
        name: 'chat-array-guard',
        why: 'content が配列でない行で feed が投げる'
            + '（購読ループが抜けて「停止」表示になるのにセッションは走り続ける）',
        file: 'v0/chatfilter.mjs',
        from: '                const blocks = Array.isArray(r.message?.content) ? r.message.content : null;',
        to: '                const blocks = r.message?.content ?? null;',
        gone: 'Array.isArray(r.message?.content)',
        pattern: '壊れた行でも feed が投げない',
        testFile: 'v0/chatfilter.test.mjs',
    },
    {
        name: 'chat-flush-tail',
        why: '改行で終わらない最後の行を捨てる（kill / クラッシュ / 途中で切れた場合の'
            + '**最後の応答が丸ごと消える** #44）',
        file: 'v0/chatfilter.mjs',
        from: '        if (rest.trim()) line(\'\', `${rest}\\n`);',
        to: '        /* 変異: 残りを捨てる */',
        gone: 'if (rest.trim()) line',
        pattern: '改行で終わらない最後の行を flush で出す',
        testFile: 'v0/chatfilter.test.mjs',
    },
    {
        name: 'chat-unknown-type',
        why: '知らない type を黙って捨てる（control_response = 入力の許可拒否や'
            + '将来増える type が消え、「形式が変わったら黙って消える」状態に戻る #44）',
        file: 'v0/chatfilter.mjs',
        from: '                line(\'d\', `  （${kind} は表示していません）\\n`);',
        to: '                /* 変異: 知らない type を捨てる */',
        gone: 'は表示していません',
        pattern: '知らない type を黙って捨てず',
        testFile: 'v0/chatfilter.test.mjs',
    },
    {
        name: 'transcript-cwd-next-candidate',
        why: '最新の1本で cwd が読めないと諦める（cwd を持たない 112B のスタブが最新だと、'
            + '同じ dir の 182MB の実セッションを丸ごと捨てて「記録なし」と嘘をつく #36）',
        file: 'v0/transcript.mjs',
        from: '        const candidates = files.slice(0, limits.maxCwdProbes);',
        to: '        const candidates = files.slice(0, 1);',
        gone: 'files.slice(0, limits.maxCwdProbes)',
        pattern: '最新の記録に cwd が無くても',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-cwd-grow',
        why: '先頭の窓を広げない（先頭レコードが 16KB を超えるとプロジェクトを黙って捨てる #36）',
        file: 'v0/transcript.mjs',
        from: '        if (r.cwd || !r.truncated || want >= max) return r.cwd;',
        to: '        return r.cwd;',
        gone: 'if (r.cwd || !r.truncated || want >= max)',
        pattern: '先頭レコードが窓より大きくても cwd を見つける',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-unknown-types-grow',
        why: '窓が全部「知らない種別」でも読み直さない'
            + '（実データに 304KB 連続する箇所があり、既定 256KB を超える #37）',
        file: 'v0/transcript.mjs',
        from: `            while (s.noneReason === 'no-known-records' && tail.truncated
                && want < limits.tailMaxBytes) {`,
        to: '            while (false) {',
        gone: "s.noneReason === 'no-known-records' && tail.truncated",
        pattern: '末尾が全部「知らない種別」でも読み直し',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-none-reason',
        why: '「記録が無い」と「抽出できなかった」を同じ値で表す'
            + '（稼働中のエージェントに「走らせた記録がありません」と断言する #37）',
        file: 'v0/transcript.mjs',
        from: `        out.noneReason = !hadLines ? 'empty'
            : out.scanned === 0 ? 'no-known-records'
                : 'no-timestamp';`,
        to: "        out.noneReason = 'empty';",
        gone: "out.scanned === 0 ? 'no-known-records'",
        pattern: '末尾が全部「知らない種別」でも読み直し',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-path-clip',
        why: 'パスに上限を掛けない（--watch-agents だけで 12件 × 4096 ≒ 48KB の任意テキストが'
            + '発話用のフラグを経由せずに出る #38）',
        file: 'v0/transcript.mjs',
        from: '    if (rel.length <= max) return { path: rel, outside: false, clipped: false };',
        to: '    return { path: rel, outside: false, clipped: false };',
        gone: 'if (rel.length <= max)',
        pattern: '長いパスは切って、切ったことを伝える',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-path-clip-notice',
        why: '切ったことを告知しない（切れたパスが「開けるパス」に見え、'
            + '「そのファイルを触った」という誤読になる）',
        file: 'v0/transcript.mjs',
        from: '    return { path: `${rel.slice(0, max)}…`, outside: false, clipped: true };',
        to: '    return { path: `${rel.slice(0, max)}`, outside: false, clipped: false };',
        gone: 'outside: false, clipped: true',
        pattern: '長いパスは切って、切ったことを伝える',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-iso-strict',
        why: 'timestamp の形の検証を Date.parse だけに戻すと自由文が通る'
            + '（Date.parse は "INJECT-SECRET-12345" を西暦 12345 年として受け入れる）',
        file: 'v0/transcript.mjs',
        from: '    if (typeof v !== \'string\' || !ISO_RE.test(v)) return null;',
        to: '    if (typeof v !== \'string\') return null;',
        gone: 'ISO_RE.test(v)',
        pattern: '壊れた timestamp は落とす',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-text-capability',
        why: '--allow-transcript-text なしで発話が payload に載る',
        file: 'v0/server.mjs',
        from: '            { allowText: opts.allowTranscriptText },',
        to: '            { allowText: true },',
        gone: 'allowText: opts.allowTranscriptText',
        pattern: '自由文は payload に1文字も入らない',
    },
    {
        name: 'transcript-enum-value',
        why: 'mode / ツール名をそのまま払い出すと、形式が変わったとき自由文が通る',
        file: 'v0/transcript.mjs',
        from: '    return typeof v === \'string\' && v.length <= max && /^[A-Za-z0-9_.:-]+$/.test(v) ? v : null;',
        to: '    return typeof v === \'string\' ? v : null;',
        gone: 'v.length <= max',
        pattern: '列挙値として通らない形の mode',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'transcript-outside-repo',
        why: 'リポジトリ外のパスをそのまま出す（他プロジェクトのパスが漏れる）',
        file: 'v0/git.mjs',
        from: '    if (!c.startsWith(`${p}/`)) return null;',
        to: '    if (false) return null;',
        gone: '!c.startsWith(',
        pattern: 'リポジトリ外のパスは出さず',
        testFile: 'v0/transcript.test.mjs',
    },
    {
        name: 'literal-pathspecs',
        why: 'pathspec magic で1ファイル指定が全体になる',
        file: 'v0/git.mjs',
        from: "    '--literal-pathspecs',\n",
        to: '',
        gone: "'--literal-pathspecs',",
        pattern: 'literal として扱う',
        testFile: 'v0/paths.test.mjs',
    },
    {
        name: 'checkout-ref-validation',
        why: 'オプション名のブランチで未コミットの変更が破棄される',
        file: 'v0/server.mjs',
        from: '            if (!isSafeRef(ref)) { denyJson(res, 400, `ref が不正です: ${ref}`); return; }\n',
        to: '',
        gone: 'ref が不正です',
        pattern: 'オプション名のブランチ',
    },
    {
        name: 'sequencer-todo',
        why: 'sequencer/todo が残った状態の checkout を通してしまう',
        file: 'v0/git.mjs',
        from: "        sequencing: existsSync(p('sequencer/todo')),",
        to: '        sequencing: false,',
        gone: "existsSync(p('sequencer/todo'))",
        pattern: 'sequencer/todo が残っている',
    },
    {
        name: 'exec-capability',
        why: '--allow-exec なしで実行できてしまう',
        file: 'v0/server.mjs',
        from: '    if (!opts.allowExec) {',
        to: '    if (false) {',
        gone: '!opts.allowExec',
        pattern: '--allow-exec なしでは exec の経路が存在しない',
    },
    // ⚠️ `exec-slot-reserve` はここにあったが #17 で消した。
    //    `reserveExecSlot()` が `execRegistry.create()` に移ったため
    //    （守りが弱くなったのではなく、**後継が `exec-slot-reserve-sync`**）。
    // 孫プロセスの後始末は「木ごと kill」「stdio を destroy」
    // 「exit で拾う（close ではなく）」で守っている。
    // どれが実際に load-bearing かを個別に確かめる（まとめて1つの変異にすると
    // 「どれかが効いている」しか分からない）。
    {
        name: 'exec-kill-tree-posix',
        why: 'POSIX でプロセスグループごと殺さない（孫が残る）',
        // この経路は win32 では実行されない。ubuntu/macOS CI が検証する
        platforms: ['linux', 'darwin'],
        file: 'v0/server.mjs',
        from: "        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* グループが無い/既に死んでいる */ }",
        to: '        /* 変異: グループ kill をやめる */',
        gone: 'process.kill(-child.pid',
        pattern: '中間シェルを挟んだ孫プロセス',
    },
    {
        name: 'exec-kill-tree-win',
        why: 'Windows で taskkill /T しない（孫が残る）',
        // taskkill は win32 にしか無い。POSIX では通らない経路
        platforms: ['win32'],
        file: 'v0/server.mjs',
        from: "                execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'],",
        to: "                execFile('taskkill', ['/PID', String(child.pid), '/F'],",
        gone: "'/T', '/F'",
        pattern: '中間シェルを挟んだ孫プロセス',
    },
    {
        name: 'exec-stdio-destroy',
        why: '孫が stdio を握ったまま応答が閉じられない',
        // Windows では taskkill /T が孫まで殺すのでパイプが閉じ、これは冗長になる。
        // taskkill が失敗した場合の保険として残す（検証されていないことを明示する）
        defensive: 'taskkill /T が効く環境では冗長。失敗時の保険',
        file: 'v0/server.mjs',
        from: '    try { child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* noop */ }',
        to: '    /* 変異: stdio の destroy をやめる */',
        gone: 'child.stdout?.destroy()',
        pattern: '中間シェルを挟んだ孫プロセス',
    },
    // ⚠️ `exec-guard-timer`（exit が来なくても枠を返す保険タイマー）も #17 で消した。
    //    **順序を変えたことで不要になった。** 以前は killTree → exit 待ち →
    //    来なければ保険、という順だったが、今は台帳の sweep と明示的な kill が
    //    どちらも「先に finish() してから killTree」する。枠は exit を待たずに戻る。
    {
        name: 'merge-driver',
        why: '衝突予測が custom merge driver を実行する（任意コード実行）',
        file: 'v0/git.mjs',
        from: "    const kill = driverNames.flatMap(n => ['-c', `merge.${n}.driver=false`]);",
        to: '    const kill = [];',
        gone: 'driver=false',
        pattern: 'custom merge driver を実行しない',
    },
    {
        name: 'blob-reflog',
        why: 'reflog 経由で捨てたコミットの中身が読める',
        file: 'v0/git.mjs',
        from: "    if (r.includes('@{') || r === '@') return false;\n",
        to: '',
        gone: "r.includes('@{')",
        pattern: 'reflog 経由',
    },
    {
        name: 'worktree-allowlist',
        why: '既知でない worktree を cwd にできる',
        file: 'v0/server.mjs',
        // exec 側の allowlist だけを外す。`bail()` があるので checkout 側とは区別できる。
        // 単にメッセージを変えるのでは駄目で、**照合を通してしまう**形にする必要がある。
        from: `                wt = worktrees.find(w => samePath(w.path, wantPath));
                if (!wt) { bail(400, \`既知の worktree ではありません: \${wantPath}\`); return; }`,
        to: `                /* 変異: allowlist を外し、要求されたパスをそのまま使う */
                wt = worktrees.find(w => samePath(w.path, wantPath))
                    ?? { path: wantPath, label: wantPath, bare: false, prunable: false };`,
        gone: 'bail(400, `既知の worktree ではありません',
        pattern: 'exec は既知の worktree 以外を cwd にしない',
    },
    {
        name: 'swimlane-dedup',
        why: '同じコミットを指すレーンが畳まれずレーンが漏れる',
        file: 'v0/swimlanes.mjs',
        from: `        const push = node => {
            const at = output.findIndex(o => o.id === node.id);
            if (at !== -1) return at;
            output.push(node);
            return output.length - 1;
        };`,
        to: `        const push = node => {
            output.push(node);
            return output.length - 1;
        };`,
        gone: 'const at = output.findIndex(o => o.id === node.id);',
        pattern: 'converging',
        testFile: 'v0/swimlanes.test.mjs',
    },
    {
        name: 'ndjson-partial-line',
        why: 'JSON の行が chunk 境界で割れたときに落とす',
        file: 'v0/ndjson.mjs',
        from: "            buf = lines.pop() ?? '';",
        to: '            // 変異: 持ち越しをやめる',
        gone: "buf = lines.pop()",
        pattern: 'chunk 境界で割れても復元する',
        testFile: 'v0/ndjson.test.mjs',
    },
    {
        name: 'ndjson-multibyte',
        why: 'マルチバイトが chunk 境界で割れる',
        file: 'v0/ndjson.mjs',
        from: 'buf += decoder.decode(value, { stream: true });',
        to: 'buf += decoder.decode(value);',
        gone: '{ stream: true }',
        pattern: '3バイト文字が chunk 境界で割れても壊れない',
        testFile: 'v0/ndjson.test.mjs',
    },
    {
        name: 'mergeplan-independent-set',
        why: '提案の塊に衝突するペアが入る',
        file: 'v0/mergeplan.mjs',
        from: '        if (conflictsWithTaken.length) continue;',
        to: '        if (false) continue;',
        gone: 'if (conflictsWithTaken.length) continue;',
        pattern: '塊の中身は互いに衝突しない',
        testFile: 'v0/mergeplan.test.mjs',
    },
    {
        name: 'samepath-realpath',
        why: '8.3 短縮名 / シンボリックリンクを解決しない',
        file: 'v0/git.mjs',
        from: '            t = realpathSync.native(t);',
        to: '            t = t;',
        // ⚠️ normPath 側にも同じ式があるので、インデントまで含めて一意にする
        gone: '            t = realpathSync.native(t);',
        pattern: 'シンボリックリンク越し',
        testFile: 'v0/paths.test.mjs',
    },
];

const args = process.argv.slice(2);
if (args.includes('--list')) {
    for (const m of MUTANTS) console.log(`${m.name.padEnd(28)} ${m.why}`);
    process.exit(0);
}
// ⚠️ `--shard 2/4` の値は名前の指定ではない。除かないと
//    「一致する変異がありません: 2/4」になる（実際に踏んだ）
// 🚨 **`indexOf` が -1 のときに +1 して 0 にしてはいけない。** `--shard` が無いと
//    `i !== 0` が最初の名前を落とし、**指定した変異が黙って走らなかった**
//    （3件指定して2件しか出ず、走っていない1件を「確認済み」と読みかけた）。
const shardIdx = args.indexOf('--shard');
const shardValueIdx = shardIdx === -1 ? -1 : shardIdx + 1;
const want = args.filter((a, i) => !a.startsWith('--') && i !== shardValueIdx);
// 🚨 **指定した名前が1つでも見つからなければ止める。** 黙って少ない件数を走らせると、
//    走っていない変異を「確認済み」と読んでしまう（実際にそう読みかけた）。
{
    const unknown = want.filter(w => !MUTANTS.some(m => m.name === w));
    if (unknown.length) {
        console.error(`✖ そんな名前の変異はありません: ${unknown.join(', ')}`);
        console.error('  一覧: node scripts/mutate.mjs --list');
        process.exit(1);
    }
}
let targets = want.length ? MUTANTS.filter(m => want.includes(m.name)) : MUTANTS;

/**
 * `--shard i/n` で分割する。CI を並列に回すため。
 *
 * 🚨 **時間が伸びると CI で打ち切られ、結果が「不明」になる。**
 *    変異が 62 → 96 件に増えたら Linux の job（上限15分）が cancelled になり、
 *    **突然変異の結果が出ないまま**「他は success」の表示になった。
 *    打ち切られたものを緑と読まないために、分割して各シャードを短く保つ。
 * ⚠️ **分割したことを必ず出す。** 出さないと部分実行を全体と読み違える。
 */
let shard = null;
{
    const i = args.findIndex(a => a === '--shard');
    const raw = i !== -1 ? args[i + 1] : args.find(a => a.startsWith('--shard='))?.split('=')[1];
    if (raw !== undefined) {
        const m = /^(\d+)\/(\d+)$/.exec(String(raw));
        if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) {
            console.error(`--shard は i/n の形で指定してください（受け取った値: ${raw}）`);
            process.exit(1);
        }
        shard = { index: Number(m[1]), total: Number(m[2]) };
        // 費用が偏らないよう round-robin で配る（render 系は1件60秒、unit 系は2秒）
        targets = targets.filter((_, k) => k % shard.total === shard.index - 1);
    }
}
if (!targets.length) {
    console.error(want.length
        ? `一致する変異がありません: ${want.join(', ')}`
        : `シャード ${shard?.index}/${shard?.total} に割り当てられた変異がありません`);
    process.exit(1);
}
if (shard) {
    console.log(`シャード ${shard.index}/${shard.total}: `
        + `${targets.length} 件（全 ${MUTANTS.length} 件のうち）を走らせます`);
}

function runTest(m) {
    return new Promise(resolve => {
        // `script` を持つ変異は `node --test` ではなく検査スクリプトを直接走らせる。
        // ⚠️ **layout / render の検査もここに掛けられるようにするため。**
        //    これが無いと「実ブラウザで測る検査」だけが変異テストの外に残り、
        //    予算を守っているコードを外しても誰も気付かない状態になる。
        const argv = m.script
            ? [m.script]
            : ['--test', `--test-name-pattern=${m.pattern}`, m.testFile ?? 'v0/smoke.test.mjs'];
        const p = spawn(process.execPath, argv,
            { cwd: ROOT, shell: false, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } });
        let out = '';
        p.stdout.on('data', d => { out += d; });
        p.stderr.on('data', d => { out += d; });
        let timedOut = false;
        const t = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, 300_000);
        // 🚨 **'error' を必ず拾う。** ChildProcess の 'error' に listener が無いと
        //    Node は uncaught exception として**プロセスを即死させる**。
        //    そうなると下の finally が走らず、**書き換えたソースが復元されないまま
        //    `*.mutate-bak` が残る**。実際に起き、その bak が `git add -A` で
        //    コミットに混入した（Windows で多数プロセスを起動している最中の
        //    一時的な spawn 失敗が引き金）。
        p.on('error', err => {
            clearTimeout(t);
            resolve({ code: -1, out: `${out}\n[spawn 失敗] ${err.message}`, timedOut });
        });
        p.on('close', code => { clearTimeout(t); resolve({ code, out, timedOut }); });
    });
}

/**
 * 書き換えたソースを必ず戻すための最後の砦。
 *
 * ⚠️ `finally` は**throw には効くがプロセスの即死には効かない**。
 *    シグナルと uncaught をここで拾って復元する。
 */
const pending = new Map();   // file -> bak

/**
 * 結果。**handlers より前に宣言する。**
 * 🚨 途中で落ちると要約が1行も出ず、**結果が不明なのを緑と読める**状態になる
 *    （適用側の共有違反でクラッシュして実際にそうなった）。落ちても必ず告知する。
 */
const results = [];
function announcePartial(why) {
    console.error(`
✖ 途中で終わりました（${why}）。${results.length} 件まで実行。`
        + '**結果は不明です**（全件走っていません）。');
}

/**
 * 控えから戻す。
 *
 * ⚠️ **Windows では一時的に失敗する。** テストが終わった直後は
 *    まだ別プロセスがファイルを開いていることがあり、`copyFileSync` が
 *    `UNKNOWN (-4094)`（共有違反）で落ちる。**1回で諦めると
 *    変異が残ったままになる**ので短い間隔で数回試す（実際に踏んだ）。
 */
/**
 * 書き換えを**適用する**側も retry する。
 *
 * ⚠️ 復元だけ retry していたので、**適用が共有違反で落ちて全件が中断**した
 *    （`writeFileSync ... UNKNOWN (-4094)` on `v0/git.mjs`。砦が復元したので
 *     ソースは無傷だったが、**要約が出ないまま終わった = 結果が不明**になった）。
 *    Windows では直前のテストがまだファイルを開いていることがある。
 */
function writeFileRetry(file, text) {
    let last = null;
    for (let i = 0; i < 20; i++) {
        try { writeFileSync(file, text, 'utf8'); return true; } catch (e) {
            last = e;
            const until = Date.now() + 100;
            while (Date.now() < until) { /* 短いスピン */ }
        }
    }
    console.error(`✖ ${file} に書けません: ${last?.message}`);
    return false;
}

function restoreFile(file, bak) {
    let last = null;
    for (let i = 0; i < 20; i++) {
        try {
            copyFileSync(bak, file);
            unlinkSync(bak);
            return true;
        } catch (e) {
            last = e;
            // 同期的に少し待つ（ここでイベントループを回すと復元が遅れる）
            const until = Date.now() + 100;
            while (Date.now() < until) { /* 短いスピン */ }
        }
    }
    console.error(`✖ ${file} を復元できません: ${last?.message}`);
    console.error(`   手で戻してください: copy "${bak}" "${file}"`);
    return false;
}

function restoreAll(why) {
    for (const [file, bak] of pending) {
        if (!existsSync(bak)) continue;
        if (restoreFile(file, bak)) console.error(`⚠ ${why}: ${file} を復元しました`);
    }
    pending.clear();
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { restoreAll(`シグナル ${sig}`); announcePartial(sig); process.exit(130); });
}
process.on('uncaughtException', e => {
    restoreAll('uncaught');
    console.error(e);
    announcePartial('uncaught');
    process.exit(1);
});
process.on('unhandledRejection', e => {
    restoreAll('unhandledRejection');
    console.error(e);
    announcePartial('unhandledRejection');
    process.exit(1);
});

// 🚨 前回の実行が残した書き換えを引きずらない。
//    残骸がある状態で走らせると、変異の上に変異を重ねることになる。
//
// ⚠️ **SIGKILL では `finally` もシグナルハンドラも走らない。** 実際に踏んだ:
//    シェルの上限（2分）で SIGKILL され、`v0/app.html` が変異したまま残った。
//    しかも `*.mutate-bak` は `.gitignore` にあるので `git status` には出ない
//    （変異したソース自体は出るので、**`git add -A` の前に読む**のが最後の砦）。
//    復元を手順ではなく**仕組み**にする: `--restore` で bak から戻す。
{
    const stale = [...new Set(MUTANTS.map(m => `${m.file}.mutate-bak`))].filter(existsSync);
    if (args.includes('--restore')) {
        if (!stale.length) { console.log('復元するものはありません'); process.exit(0); }
        let ok = true;
        for (const b of stale) {
            const file = b.replace(/\.mutate-bak$/, '');
            if (restoreFile(file, b)) console.log(`✔ 復元しました: ${file}`);
            else ok = false;
        }
        process.exit(ok ? 0 : 1);
    }
    if (stale.length) {
        console.error('\n✖ 前回の実行が残した書き換えがあります:');
        for (const b of stale) console.error(`    ${b} → ${b.replace(/\.mutate-bak$/, '')}`);
        console.error('\n  ソースが変異したままです（SIGKILL されると finally が走りません）。');
        console.error('  bak から戻す:');
        console.error('      node scripts/mutate.mjs --restore\n');
        process.exit(1);
    }
}

for (const m of targets) {
    if (m.platforms && !m.platforms.includes(process.platform)) {
        results.push({ m, status: 'SKIP', note: `このプラットフォームでは通らない経路（${m.platforms.join('/')} 用）` });
        continue;
    }
    const bak = `${m.file}.mutate-bak`;
    let applied = false;
    try {
        const src = readFileSync(m.file, 'utf8');
        if (!src.includes(m.from)) {
            // 🚨 **これは失敗。** 字面がずれた変異は「守りを外せていない」だけで、
            //    守りが検証されない状態が静かに続く（実際に `worktree-allowlist` が
            //    CI で SKIP のまま残り、`samePath` の変異も同じ形で落ちていた）。
            //    プラットフォーム外の SKIP とは意味が違うので**分けて失敗にする**。
            results.push({ m, status: 'STALE', note: '書き換え対象が見つからない（コードが変わった）' });
            continue;
        }
        copyFileSync(m.file, bak);
        applied = true;
        pending.set(m.file, bak);
        // ⚠️ `also` は「同じ守りが二重になっていて、片方ずつでは測れない」場合に
        //    複数箇所を同時に外すための追加。**単独で落ちない = テストの穴**とは
        //    限らないので、二重の守りは束ねて測る（実際に exec の終端で必要になった）。
        let mutated = src.replace(m.from, m.to);
        for (const extra of m.also ?? []) {
            if (!mutated.includes(extra.from)) {
                results.push({ m, status: 'STALE', note: `also の対象が見つからない: ${extra.from.slice(0, 40)}` });
                mutated = null;
                break;
            }
            mutated = mutated.replace(extra.from, extra.to);
        }
        if (mutated === null) continue;
        // ⚠️ ここで落ちると全件が中断して**結果が不明**になる（実際に踏んだ）
        if (!writeFileRetry(m.file, mutated)) {
            results.push({ m, status: 'STALE', note: '書き換えを適用できなかった（ファイルが掴まれている）' });
            continue;
        }
        if (readFileSync(m.file, 'utf8').includes(m.gone)) {
            results.push({ m, status: 'STALE', note: '書き換えが効いていない（gone の判定が甘い）' });
            continue;
        }
        const r = await runTest(m);
        if (m.script) {
            // 検査スクリプトは「ブラウザが無ければスキップ」を自分で出す。
            // 🚨 **それを緑と読まない。** 測れていないことを SKIP として出す。
            if (/skipped/.test(r.out)) {
                results.push({ m, status: 'SKIP', note: `${m.script} が測れなかった（ブラウザ無し）` });
                continue;
            }
            if (r.timedOut) {
                results.push({
                    m, status: 'HUNG',
                    note: `${m.script} が上限まで返らなかった。`
                        + '守りを外すと止まらなくなる = 落ちる形になっていない',
                });
                continue;
            }
            const killed = r.code !== 0;
            results.push({
                m,
                status: killed ? 'KILLED' : (m.defensive ? 'DEFENSIVE' : 'SURVIVED'),
                note: killed ? ''
                    : (m.defensive ?? `${m.script} が落ちなかった = この守りは検証されていない`),
            });
            continue;
        }
        // ⚠️ `ℹ tests N` で判定してはいけない。`--test-name-pattern` に外れたテストも
        //    N に数えられて `skipped` になるだけなので、**1件も走っていないのに
        //    「落ちなかった → SURVIVED」と誤報する**（pattern をテスト名ではなく
        //    assert のメッセージに書いていて、実際にこれで誤報が出た）。
        //    実際に走った本数は pass + fail で数える。
        const n = k => Number(new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(r.out)?.[1] ?? 0);
        if (n('pass') + n('fail') === 0) {
            // 🚨 **「走らなかった」には2つの原因があり、意味が正反対。**
            //    (a) pattern がテスト名に一致していない → 検査の設定ミス（SKIP）
            //    (b) **テストがハングして SIGKILL された** → 守りを外したら
            //        止まらなくなった = **変異は効いている**。これを SKIP にすると
            //        ツール自身が「SKIP を緑と読まない」という規則を破り、
            //        しかも「テスト名を直せ」という**無関係な修正へ誘導する**（#32）。
            //    要約が出ていない（= 途中で殺された）なら (b) として扱う。
            const summarized = /^ℹ tests \d+/m.test(r.out);
            if (!summarized || r.timedOut) {
                results.push({
                    m, status: 'HUNG',
                    note: 'テストがハングした（要約が出ていない）。'
                        + '守りを外すと止まらなくなる = 変異は効いているが、'
                        + '**落ちる形になっていない**。上限を付けて失敗として観測できるようにすること',
                });
                continue;
            }
            results.push({
                m, status: 'STALE',
                note: `pattern に一致するテストが無い（テスト名に含まれる文字列を書く）: ${m.pattern}`,
            });
            continue;
        }
        const killed = r.code !== 0;
        results.push({
            m,
            status: killed ? 'KILLED' : (m.defensive ? 'DEFENSIVE' : 'SURVIVED'),
            note: killed ? ''
                : (m.defensive ?? 'テストが落ちなかった = この守りは検証されていない'),
        });
    } finally {
        if (applied && existsSync(bak)) restoreFile(m.file, bak);
        pending.delete(m.file);
    }
}

console.log('');
let bad = 0;
for (const r of results) {
    const mark = { KILLED: '✔', SURVIVED: '✖', HUNG: '✖', STALE: '✖', DEFENSIVE: '◦', SKIP: '–' }[r.status];
    // 冗長な防御とプラットフォーム外は失敗にしない（記録として残す）。
    // 🚨 **HUNG も失敗**。ハングは「落ちない検査」なので緑にしてはいけない（#32）
    if (r.status === 'SURVIVED' || r.status === 'HUNG' || r.status === 'STALE') bad++;
    console.log(`${mark} ${r.m.name.padEnd(28)} ${r.status.padEnd(9)} ${r.note || r.m.why}`);
}
console.log('');
const k = results.filter(r => r.status === 'KILLED').length;
const d = results.filter(r => r.status === 'DEFENSIVE').length;
const sk = results.filter(r => r.status === 'SKIP').length;
const hung = results.filter(r => r.status === 'HUNG').length;
const stale = results.filter(r => r.status === 'STALE').length;
console.log(`${k} 件が期待通り落ちた / ${d} 件は冗長な防御（想定内）`
    + ` / ${sk} 件はスキップ${hung ? ` / ${hung} 件はハング` : ''}`
    + `${stale ? ` / ${stale} 件は字面がずれている` : ''}`
    // 🚨 部分実行を全体と読み違えないよう、必ず添える
    + (shard ? `（シャード ${shard.index}/${shard.total}。全 ${MUTANTS.length} 件の一部）` : ''));
if (bad) console.log('✖ = テストがその守りを検証できていない。テストを直すこと');
// 🚨 **字面がずれた変異は失敗。** 「守りを外せていない」だけなので、
//    守りが検証されない状態が静かに続く（CI で SKIP のまま残っていた）。
if (stale) {
    console.log(`✖ ${stale} 件は変異の from/gone/pattern がソースとずれている。`
        + '変異を直すこと（守りは1つも検証されていない）');
}
// ⚠️ SKIP も無害ではない。**検証されていない守り**なので数を必ず出す
if (sk) console.log(`– = ${sk} 件はこのプラットフォームでは通らない経路`);
// 🚨 終了時に残骸が無いことを確かめる。ここが残ると次回以降が汚染される。
{
    const left = [...new Set(MUTANTS.map(m => `${m.file}.mutate-bak`))].filter(existsSync);
    if (left.length) {
        console.error(`
✖ 書き換えの控えが残っています: ${left.join(', ')}`);
        console.error('  ソースが復元されていない可能性があります。git diff で確認してください。');
        bad++;
    }
}
process.exit(bad ? 1 : 0);
