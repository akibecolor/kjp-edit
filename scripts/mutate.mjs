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
    {
        name: 'exec-slot-reserve',
        why: '同時実行の上限が効かない（検査と予約の間に await）',
        file: 'v0/server.mjs',
        from: `function reserveExecSlot() {
    if (runningExec >= MAX_CONCURRENT_EXEC) return false;
    runningExec++;
    return true;
}`,
        to: `function reserveExecSlot() {
    return true;
}`,
        gone: 'runningExec >= MAX_CONCURRENT_EXEC',
        pattern: '同時実行の上限が実際に効く',
    },
    {
        name: 'exec-kill-tree',
        why: '中間シェルの孫プロセスが残り、枠が戻らない',
        file: 'v0/server.mjs',
        from: '            child.on(\'exit\', (code, signal) => { finish(code, signal); });',
        to: '            child.on(\'close\', (code, signal) => { finish(code, signal); });',
        gone: "child.on('exit'",
        pattern: '中間シェルを挟んだ孫プロセス',
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
        from: '            const wt = worktrees.find(w => samePath(w.path, wantPath));\n            if (!wt) { release(); denyJson(res, 400, `既知の worktree ではありません: ${wantPath}`); return; }',
        to: '            const wt = worktrees.find(w => samePath(w.path, wantPath)) ?? { path: wantPath, label: wantPath };\n            if (!wt) { release(); denyJson(res, 400, `既知の worktree ではありません: ${wantPath}`); return; }',
        gone: 'worktrees.find(w => samePath(w.path, wantPath));\n            if (!wt)',
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
        from: '        for (const t of taken) if (adj.get(l).has(t)) { ok = false; break; }',
        to: '        // 変異: 隣接チェックをやめる',
        gone: 'if (adj.get(l).has(t))',
        pattern: '塊の中身は互いに衝突しない',
        testFile: 'v0/mergeplan.test.mjs',
    },
    {
        name: 'samepath-realpath',
        why: '8.3 短縮名 / シンボリックリンクを解決しない',
        file: 'v0/git.mjs',
        from: '            t = realpathSync.native(t);',
        to: '            t = t;',
        gone: 'realpathSync.native(t)',
        pattern: '短縮名',
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
        // テストが1件も走っていないなら pattern が合っていない
        const ran = /^ℹ tests (\d+)/m.exec(r.out);
        if (!ran || Number(ran[1]) === 0) {
            results.push({ m, status: 'SKIP', note: `pattern に一致するテストが無い: ${m.pattern}` });
            continue;
        }
        results.push({
            m,
            status: r.code !== 0 ? 'KILLED' : 'SURVIVED',
            note: r.code !== 0 ? '' : 'テストが落ちなかった = この守りは検証されていない',
        });
    } finally {
        if (applied && existsSync(bak)) { copyFileSync(bak, m.file); unlinkSync(bak); }
    }
}

console.log('');
let bad = 0;
for (const r of results) {
    const mark = r.status === 'KILLED' ? '✔' : r.status === 'SURVIVED' ? '✖' : '–';
    if (r.status !== 'KILLED') bad++;
    console.log(`${mark} ${r.m.name.padEnd(28)} ${r.status.padEnd(9)} ${r.note || r.m.why}`);
}
console.log('');
console.log(`${results.filter(r => r.status === 'KILLED').length}/${results.length} が期待通り落ちた`);
if (bad) console.log('✖ / – は「テストがその守りを検証できていない」ことを意味する');
process.exit(bad ? 1 : 0);
