#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// kjp-edit v0 — 全 worktree を1枚のグラフで見る読み取り専用デーモン。
// 依存パッケージゼロ (Node 標準ライブラリのみ)。
//
//   node v0/server.mjs [--repo <path>] [--port 7749] [--limit 300]
//
// 🔒 127.0.0.1 のみにバインドする (docs/architecture.md の D1)。
//    外から届かせたい場合はトンネル (tailscale serve 等) をループバックで終端させる。
//    このサーバは認証を持たない。0.0.0.0 にバインドしないこと。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
    git, listWorktrees, log, mergeBase, aheadBehind,
    changedFiles, worktreeStatus, sequencerState,
} from './git.mjs';
import { computeSwimlanes } from './swimlanes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
    const opts = { repo: process.cwd(), port: 7749, limit: 300, base: null };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--repo') opts.repo = resolve(argv[++i]);
        else if (a === '--port') opts.port = Number(argv[++i]);
        else if (a === '--limit') opts.limit = Number(argv[++i]);
        else if (a === '--base') opts.base = argv[++i];
        else if (a === '--help' || a === '-h') {
            console.log('usage: node v0/server.mjs [--repo <path>] [--port 7749] [--limit 300] [--base <ref>]');
            process.exit(0);
        }
    }
    return opts;
}

const opts = parseArgs(process.argv);

/** 既定ブランチを推測する。origin/HEAD → main → master の順。 */
async function guessBase(cwd) {
    if (opts.base) return opts.base;
    for (const probe of [
        ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
        ['rev-parse', '--verify', '--quiet', 'refs/heads/main'],
        ['rev-parse', '--verify', '--quiet', 'refs/heads/master'],
    ]) {
        try {
            const out = (await git(probe, { cwd })).trim();
            if (out) return probe[0] === 'symbolic-ref' ? out : probe[probe.length - 1];
        } catch { /* 次を試す */ }
    }
    return 'HEAD';
}

async function collect() {
    const cwd = opts.repo;
    const worktrees = await listWorktrees(cwd);
    const base = await guessBase(cwd);

    // 各 worktree の状態を並行に集める
    await Promise.all(worktrees.map(async wt => {
        const ref = wt.branch ?? wt.head;
        const [status, seq, mb] = await Promise.all([
            worktreeStatus(wt.path).catch(() => ({ changed: 0, untracked: 0, dirty: false })),
            sequencerState(wt.path).catch(() => ({ warnings: [] })),
            mergeBase(cwd, base, ref),
        ]);
        wt.status = status;
        wt.sequencer = seq;
        wt.mergeBase = mb;
        const ab = await aheadBehind(cwd, base, ref).catch(() => ({ ahead: 0, behind: 0 }));
        wt.ahead = ab.ahead;
        wt.behind = ab.behind;
        wt.files = mb
            ? await changedFiles(cwd, base, ref).catch(() => [])
            : [];
    }));

    // 全 worktree の HEAD + base を含む1枚のグラフ
    const refs = [...new Set([base, ...worktrees.map(w => w.branch ?? w.head)])];
    const commits = await log(cwd, refs, opts.limit);
    const rows = computeSwimlanes(commits);

    // どの worktree がどのコミットに居るか
    const headBy = new Map();
    for (const wt of worktrees) {
        if (!wt.head) continue;
        if (!headBy.has(wt.head)) headBy.set(wt.head, []);
        headBy.get(wt.head).push(wt.name);
    }

    const graph = rows.map((row, i) => ({
        ...row,
        ...commits[i],
        worktrees: headBy.get(row.hash) ?? [],
    }));

    // ファイル重複の検出（クロスエージェントレビューの最小版）
    const byFile = new Map();
    for (const wt of worktrees) {
        for (const f of wt.files) {
            if (!byFile.has(f.path)) byFile.set(f.path, []);
            byFile.get(f.path).push(wt.name);
        }
    }
    const overlaps = [...byFile.entries()]
        .filter(([, names]) => new Set(names).size > 1)
        .map(([path, names]) => ({ path, worktrees: [...new Set(names)] }))
        .sort((a, b) => b.worktrees.length - a.worktrees.length);

    return {
        repo: cwd,
        base,
        generatedAt: new Date().toISOString(),
        worktrees: worktrees.map(w => ({
            name: w.name, path: w.path, branch: w.shortBranch, head: w.head,
            detached: w.detached, bare: w.bare, locked: w.locked, prunable: w.prunable,
            ahead: w.ahead, behind: w.behind, status: w.status,
            warnings: w.sequencer.warnings ?? [],
            files: w.files,
        })),
        graph,
        overlaps,
    };
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
        if (url.pathname === '/api/v0/state') {
            const body = JSON.stringify(await collect());
            res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
            });
            res.end(body);
            return;
        }
        if (url.pathname === '/' || url.pathname === '/index.html') {
            const html = await readFile(join(HERE, 'index.html'));
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
            return;
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found\n');
    } catch (err) {
        console.error(err);
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: String(err && err.message || err) }));
    }
});

// 起動時エラーは生のスタックトレースではなく、次の一手が分かる形で出す
server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n✖ ポート ${opts.port} は既に使われています。\n`);
        console.error('  別のポートで起動する:');
        console.error(`      node v0/server.mjs --port ${opts.port + 1}\n`);
        console.error('  掴んでいるプロセスを調べる:');
        if (process.platform === 'win32') {
            console.error(`      Get-NetTCPConnection -LocalPort ${opts.port} -State Listen |`);
            console.error('        ForEach-Object { Get-Process -Id $_.OwningProcess }');
        } else {
            console.error(`      lsof -nP -iTCP:${opts.port} -sTCP:LISTEN`);
        }
        console.error('');
        process.exit(1);
    }
    if (err.code === 'EACCES') {
        console.error(`\n✖ ポート ${opts.port} を開く権限がありません。1024 以上のポートを指定してください。\n`);
        process.exit(1);
    }
    console.error(err);
    process.exit(1);
});

// リポジトリとして開けるかを先に確認して、UI で 500 を見せずに済ませる
try {
    await git(['rev-parse', '--git-dir'], { cwd: opts.repo });
} catch (err) {
    console.error(`\n✖ git リポジトリとして開けません: ${opts.repo}`);
    console.error(`  ${err.message}\n`);
    console.error('  --repo でリポジトリのパスを指定してください:');
    console.error('      node v0/server.mjs --repo C:/path/to/repo\n');
    process.exit(1);
}

// 🔒 ループバックのみ。--port 0 で OS に空きポートを選ばせる（テスト用）
server.listen(opts.port, '127.0.0.1', () => {
    const { port } = server.address();
    console.log(`kjp-edit v0  →  http://127.0.0.1:${port}`);
    console.log(`repo: ${opts.repo}`);
    console.log('停止: Ctrl+C');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        server.close(() => process.exit(0));
        // ソケットが残っていても確実に終わらせる
        setTimeout(() => process.exit(0), 500).unref();
    });
}
