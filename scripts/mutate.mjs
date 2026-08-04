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
        from: '            if (now - doneAt >= this.limits.retainMs && !s.subscribers.size) evict.push(s);',
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
    {
        name: 'auth-cookie-is-exec-token',
        why: 'Cookie に実行トークンをそのまま入れる。'
            + 'Cookie はポートで分離されないので、同じブラウザで開いた他のローカル'
            + 'サービスに実行トークンが渡り、任意コマンドを実行できる',
        file: 'v0/server.mjs',
        from: '    return secretMatches(readCookie(req, AUTH_COOKIE), cookieSecret())',
        to: '    return tokenMatches(readCookie(req, AUTH_COOKIE))',
        gone: 'secretMatches(readCookie(req, AUTH_COOKIE)',
        pattern: 'Cookie の値は実行トークンと別で',
    },
    {
        name: 'auth-cookie-samesite',
        why: 'Cookie の SameSite / HttpOnly を外す（CSRF と JS からの読み取りに開く）',
        file: 'v0/server.mjs',
        from: "                + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000',",
        to: "                + '; Path=/; Max-Age=31536000',",
        gone: 'HttpOnly; SameSite=Strict',
        pattern: 'Cookie を焼いて URL からトークンを落とす',
    },
    {
        name: 'auth-token-not-in-url',
        why: 'リダイレクトで token を落とさない（履歴と Referer に残る）',
        file: 'v0/server.mjs',
        from: "        clean.searchParams.delete('token');",
        to: '        /* 変異: URL からトークンを落とさない */',
        gone: "clean.searchParams.delete('token')",
        pattern: 'Cookie を焼いて URL からトークンを落とす',
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
        from: `            const wt = worktrees.find(w => samePath(w.path, wantPath));
            if (!wt) { bail(400, \`既知の worktree ではありません: \${wantPath}\`); return; }`,
        to: `            /* 変異: allowlist を外し、要求されたパスをそのまま使う */
            const wt = worktrees.find(w => samePath(w.path, wantPath))
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
const want = args.filter(a => !a.startsWith('--'));
const targets = want.length ? MUTANTS.filter(m => want.includes(m.name)) : MUTANTS;
if (!targets.length) {
    console.error(`一致する変異がありません: ${want.join(', ')}`);
    process.exit(1);
}

function runTest(m) {
    return new Promise(resolve => {
        const p = spawn(process.execPath, [
            '--test', `--test-name-pattern=${m.pattern}`,
            m.testFile ?? 'v0/smoke.test.mjs',
        ], { cwd: ROOT, shell: false, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } });
        let out = '';
        p.stdout.on('data', d => { out += d; });
        p.stderr.on('data', d => { out += d; });
        const t = setTimeout(() => p.kill('SIGKILL'), 300_000);
        p.on('close', code => { clearTimeout(t); resolve({ code, out }); });
    });
}

const results = [];
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
            results.push({ m, status: 'SKIP', note: '書き換え対象が見つからない（コードが変わった？）' });
            continue;
        }
        copyFileSync(m.file, bak);
        applied = true;
        writeFileSync(m.file, src.replace(m.from, m.to), 'utf8');
        if (readFileSync(m.file, 'utf8').includes(m.gone)) {
            results.push({ m, status: 'SKIP', note: '書き換えが効いていない（gone の判定が甘い）' });
            continue;
        }
        const r = await runTest(m);
        // ⚠️ `ℹ tests N` で判定してはいけない。`--test-name-pattern` に外れたテストも
        //    N に数えられて `skipped` になるだけなので、**1件も走っていないのに
        //    「落ちなかった → SURVIVED」と誤報する**（pattern をテスト名ではなく
        //    assert のメッセージに書いていて、実際にこれで誤報が出た）。
        //    実際に走った本数は pass + fail で数える。
        const n = k => Number(new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(r.out)?.[1] ?? 0);
        if (n('pass') + n('fail') === 0) {
            results.push({
                m, status: 'SKIP',
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
        if (applied && existsSync(bak)) { copyFileSync(bak, m.file); unlinkSync(bak); }
    }
}

console.log('');
let bad = 0;
for (const r of results) {
    const mark = { KILLED: '✔', SURVIVED: '✖', DEFENSIVE: '◦', SKIP: '–' }[r.status];
    // 冗長な防御とプラットフォーム外は失敗にしない（記録として残す）
    if (r.status === 'SURVIVED') bad++;
    console.log(`${mark} ${r.m.name.padEnd(28)} ${r.status.padEnd(9)} ${r.note || r.m.why}`);
}
console.log('');
const k = results.filter(r => r.status === 'KILLED').length;
const d = results.filter(r => r.status === 'DEFENSIVE').length;
const sk = results.filter(r => r.status === 'SKIP').length;
console.log(`${k} 件が期待通り落ちた / ${d} 件は冗長な防御（想定内）/ ${sk} 件はスキップ`);
if (bad) console.log('✖ = テストがその守りを検証できていない。テストを直すこと');
process.exit(bad ? 1 : 0);
