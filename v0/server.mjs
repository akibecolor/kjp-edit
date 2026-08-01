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
    git, listWorktrees, log, aheadBehind, commonDir,
    changedFiles, worktreeStatus, sequencerState,
    refMap, resolveRef, worktreeGitDirs, stats,
} from './git.mjs';
import { computeSwimlanes } from './swimlanes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
    const opts = { repo: process.cwd(), port: 7749, limit: 300, base: null, layoutProbe: false };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--repo') opts.repo = resolve(argv[++i]);
        else if (a === '--port') opts.port = Number(argv[++i]);
        else if (a === '--limit') opts.limit = Number(argv[++i]);
        else if (a === '--base') opts.base = argv[++i];
        else if (a === '--layout-probe') opts.layoutProbe = true;
        else if (a === '--help' || a === '-h') {
            console.log('usage: node v0/server.mjs [--repo <path>] [--port 7749] [--limit 300] [--base <ref>]');
            console.log('       --layout-probe  レイアウト検査用の /__probe を有効にする (layout-check.mjs が使う)');
            process.exit(0);
        }
    }
    return opts;
}

/**
 * レイアウト検査用のハーネス。UI を指定幅の iframe に入れて、
 * 内側から実寸を測れるようにする（同一オリジンなので contentDocument が読める）。
 *
 * ⚠️ 既定では無効（`--layout-probe` が必要）。このサーバは認証を持たないので、
 *    検査専用の経路を常時開けない。
 * ⚠️ headless Chrome の `--window-size` は Windows では最小幅に丸められ、
 *    390 を指定しても innerWidth が 500 になる（実測）。iframe なら正確に効く。
 */
function probeHarness(width) {
    const w = Number.isFinite(width) && width >= 200 && width <= 4000 ? Math.floor(width) : 390;
    return `<!doctype html><meta charset="utf-8"><title>layout probe</title>
<body style="margin:0">
<iframe id="f" src="/" style="width:${w}px;height:2000px;border:0"></iframe>
<pre id="out"></pre>
<script type="module">
const f = document.getElementById('f');
await new Promise(r => f.addEventListener('load', r, { once: true }));
await new Promise(r => setTimeout(r, 2000));
const win = f.contentWindow, doc = f.contentDocument;
const vw = win.innerWidth;
const rect = e => e.getBoundingClientRect();
const over = [...doc.querySelectorAll('*')].filter(e => rect(e).right > vw + 1)
  .map(e => e.tagName + (e.id ? '#' + e.id : '')
    + (e.className ? '.' + String(e.className).trim().split(/\\s+/).join('.') : ''));
// ⚠️ 「描かれているか」は getClientRects() で見る。
//    自分の display が none でなくても、祖先が none なら描かれていない。
//    getComputedStyle(e).display だけで判定すると、意図的に隠した .refcell の
//    中のバッジを「幅0に潰れている」と誤検出する（実際に踏んだ）。
const drawn = e => e.getClientRects().length > 0;
const badges = [...doc.querySelectorAll('.ref')].filter(drawn);
// 描かれているのに幅が無い = overflow:hidden や循環参照で情報が消えている
const squashed = badges.filter(e => rect(e).width < 24)
  .map(e => e.textContent.trim() + ' w=' + Math.round(rect(e).width));
document.getElementById('out').textContent = JSON.stringify({
  innerWidth: vw,
  bodyScrollWidth: doc.body.scrollWidth,
  bodyClientWidth: doc.body.clientWidth,
  overflowing: over.slice(0, 12),
  overflowingCount: over.length,
  squashedBadges: squashed.slice(0, 12),
  squashedCount: squashed.length,
  visibleBadges: badges.length,
  // worktree HEAD バッジは狭い画面でも消してはいけない（このツールの核心情報）
  visibleWorktreeBadges: [...doc.querySelectorAll('.ref.wt')].filter(drawn).length,
});
</script>`;
}

const opts = parseArgs(process.argv);

/**
 * 既定ブランチを推測する。origin/HEAD → main → master の順。
 * ⚠️ 戻り値は必ず verifyRefs() を通してから log() に渡す。
 *    `origin/HEAD` は remote 側でブランチが消えても残るため、
 *    ここが解決できない ref を返してエンドポイント全体が 500 になっていた。
 */
async function guessBase(cwd, refs) {
    if (opts.base) {
        if (resolveRef(refs, opts.base)) return opts.base;
        console.error(`⚠ --base ${opts.base} は解決できません。自動推測に切り替えます。`);
    }
    // origin/HEAD だけは symbolic-ref なので for-each-ref の表に出ない
    try {
        const out = (await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd })).trim();
        if (out && resolveRef(refs, out)) return out;
    } catch { /* origin/HEAD が無い。次を試す */ }
    for (const candidate of ['main', 'master']) {
        if (refs.has(`refs/heads/${candidate}`)) return candidate;
    }
    return 'HEAD';
}

/**
 * basename が衝突する worktree に一意なラベルを与える。
 * `~/a/agent` と `~/b/agent` が両方 "agent" になり、
 * overlaps / headBy が別 worktree の変更を混ぜていた（レビューで発覚）。
 */
function assignLabels(worktrees) {
    const byName = new Map();
    for (const wt of worktrees) {
        if (!byName.has(wt.name)) byName.set(wt.name, []);
        byName.get(wt.name).push(wt);
    }
    for (const [name, group] of byName) {
        if (group.length === 1) { group[0].label = name; continue; }
        for (const wt of group) {
            const parts = wt.path.split(/[\\/]/).filter(Boolean);
            wt.label = parts.slice(-2).join('/') || name;
        }
    }
}

async function collectFresh() {
    const cwd = opts.repo;
    const errors = [];
    const spawnsBefore = stats.spawns;

    // worktree 本数に比例しない準備。ここで3プロセス使う。
    const [worktrees, refs, common] = await Promise.all([
        listWorktrees(cwd),
        refMap(cwd),
        commonDir(cwd),
    ]);
    assignLabels(worktrees);
    const gitDirs = await worktreeGitDirs(common);   // fs のみ、spawn なし

    // メイン worktree は `<commonDir>/worktrees/` に現れないので、その $GIT_DIR は
    // commonDir 自身。ただし「表に無いから main」と決め打つのは危険で、
    // gitdir ファイルが壊れた linked worktree も表から落ちる。その場合に
    // commonDir を渡すとメインのシーケンサ状態を誤って読むので、
    // 表に無い worktree が1本だけのときに限って commonDir を使い、
    // 複数あるなら全て rev-parse にフォールバックさせる。
    const unmapped = worktrees.filter(w => !w.bare && !gitDirs.has(w.path));
    if (unmapped.length === 1) gitDirs.set(unmapped[0].path, common);

    const base = await guessBase(cwd, refs);

    // 各 worktree の状態を並行に集める。1本が壊れても他は出す。
    // 1本あたり 3 プロセス (status / rev-list / diff) に抑える。
    // ref の解決は refs 表、$GIT_DIR は gitDirs 表を引くので spawn しない。
    await Promise.all(worktrees.map(async wt => {
        wt.status = { changed: 0, untracked: 0, unmerged: 0, dirty: false };
        wt.sequencer = { warnings: [] };
        wt.ahead = 0; wt.behind = 0; wt.files = [];

        // bare worktree には作業ツリーが無い。status を叩くと必ず失敗するので飛ばす。
        if (wt.bare) return;
        // prunable は実体ディレクトリが消えている。spawn の cwd に使うと ENOENT。
        if (wt.prunable) {
            errors.push({
                scope: wt.label,
                message: `worktree が失われています: ${wt.prunableReason ?? '理由不明'}`,
            });
            return;
        }

        const [status, seq] = await Promise.all([
            worktreeStatus(wt.path).catch(e => {
                errors.push({ scope: wt.label, message: `status: ${e.message}` });
                return wt.status;
            }),
            sequencerState(wt.path, gitDirs.get(wt.path) ?? null).catch(e => {
                errors.push({ scope: wt.label, message: `sequencer: ${e.message}` });
                return wt.sequencer;
            }),
        ]);
        wt.status = status;
        wt.sequencer = seq;

        const ref = wt.branch ?? wt.head;
        if (!resolveRef(refs, ref)) {
            errors.push({ scope: wt.label, message: `ref を解決できません: ${ref}` });
            return;
        }
        wt.ref = ref;

        // merge-base は別プロセスで取らない。`base...ref` の三点記法が
        // 内部で merge base を計算するので、diff / rev-list に任せる。
        // 無関係な履歴なら diff が失敗するのでそれを縮退の合図に使う。
        const ab = await aheadBehind(cwd, base, ref).catch(() => ({ ahead: 0, behind: 0 }));
        wt.ahead = ab.ahead;
        wt.behind = ab.behind;
        wt.files = await changedFiles(cwd, base, ref).catch(() => []);
    }));

    // 全 worktree の HEAD + base を含む1枚のグラフ。
    // 解決できない ref は log() に渡さない（1本で全体が落ちるため）。
    const wanted = [...new Set([base, ...worktrees.map(w => w.ref ?? w.branch ?? w.head)])];
    const graphRefs = wanted.filter(r => resolveRef(refs, r) || r === 'HEAD');
    let commits = [];
    if (graphRefs.length === 0) {
        errors.push({ scope: 'graph', message: '表示できる ref がありません' });
    } else {
        try {
            commits = await log(cwd, graphRefs, opts.limit);
        } catch (e) {
            // グラフが落ちても worktree 一覧は返す（部分縮退）
            errors.push({ scope: 'graph', message: e.message });
        }
    }
    const rows = computeSwimlanes(commits);

    // どの worktree がどのコミットに居るか。path をキーにして重複 basename を潰さない。
    const headBy = new Map();
    for (const wt of worktrees) {
        if (!wt.head) continue;
        if (!headBy.has(wt.head)) headBy.set(wt.head, []);
        headBy.get(wt.head).push(wt.label);
    }

    const graph = rows.map((row, i) => ({
        ...row,
        ...commits[i],
        worktrees: headBy.get(row.hash) ?? [],
    }));

    // ファイル重複の検出（クロスエージェントレビューの最小版）。
    // path をキーにするので同名 worktree でも別扱いになる。
    const byFile = new Map();
    for (const wt of worktrees) {
        for (const f of wt.files) {
            if (!byFile.has(f.path)) byFile.set(f.path, new Map());
            byFile.get(f.path).set(wt.path, wt.label);
        }
    }
    const overlaps = [...byFile.entries()]
        .filter(([, owners]) => owners.size > 1)
        .map(([path, owners]) => ({ path, worktrees: [...owners.values()] }))
        .sort((a, b) => b.worktrees.length - a.worktrees.length || a.path.localeCompare(b.path));

    return {
        repo: cwd,
        base,
        generatedAt: new Date().toISOString(),
        worktrees: worktrees.map(w => ({
            name: w.label, basename: w.name, path: w.path,
            branch: w.shortBranch, head: w.head,
            detached: w.detached, bare: w.bare, locked: w.locked,
            prunable: w.prunable, prunableReason: w.prunableReason ?? null,
            ahead: w.ahead, behind: w.behind, status: w.status,
            // sequencer の全状態を渡す。UI が rebase/merge 中を出せなかったのは
            // warnings しか払い出していなかったため（レビューで発覚）。
            sequencer: {
                rebasing: !!w.sequencer.rebasing,
                merging: !!w.sequencer.merging,
                cherryPicking: !!w.sequencer.cherryPicking,
                reverting: !!w.sequencer.reverting,
                bisecting: !!w.sequencer.bisecting,
                rebaseHeadName: w.sequencer.rebaseHeadName ?? null,
                headRef: w.sequencer.headRef ?? null,
                warnings: w.sequencer.warnings ?? [],
            },
            warnings: w.sequencer.warnings ?? [],
            files: w.files,
        })),
        graph,
        overlaps,
        errors,
        // 1回の収集で git を何回起動したか。worktree 本数に対する伸び方を
        // スモークテストで固定する（コメントだけでは回帰を防げない）。
        stats: { gitSpawns: stats.spawns - spawnsBefore, worktrees: worktrees.length },
    };
}

/**
 * 短い TTL のキャッシュと in-flight の合流。
 *
 * 本体の対策は collectFresh() 側のプロセス削減。実測のコストは
 *   定数 5 (worktree list / for-each-ref / git-common-dir / origin/HEAD / log)
 *   + worktree 1本あたり 3 (status / rev-list / diff)
 * で、11本なら 59 → 38。ref 解決と $GIT_DIR は表引きなので spawn しない。
 * この式は payload の stats.gitSpawns でスモークテストが固定している。
 * ここで効くのは「同時に来た複数リクエスト」だけ:
 *   - 15秒ポーリングは TTL を跨ぐので毎回収集し直す（意図通り）
 *   - タブを複数開いた場合や再読込連打は1回の収集に合流する
 * ⚠️ 状態を変えた直後に読む場合（テスト・手動再読込）は ?fresh=1 が必要。
 */
const CACHE_TTL_MS = 1500;
let cached = null;      // { at, value }
let inFlight = null;

async function collect({ force = false } = {}) {
    const now = process.hrtime.bigint();
    if (!force && cached && Number(now - cached.at) / 1e6 < CACHE_TTL_MS) {
        return cached.value;
    }
    if (inFlight) return inFlight;           // 同時リクエストは1回の収集に合流させる
    inFlight = (async () => {
        try {
            const value = await collectFresh();
            cached = { at: process.hrtime.bigint(), value };
            return value;
        } finally {
            inFlight = null;
        }
    })();
    return inFlight;
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
        if (url.pathname === '/api/v0/state') {
            // ?fresh=1 で TTL キャッシュを無視する（手動リロード用）
            const force = url.searchParams.get('fresh') === '1';
            const body = JSON.stringify(await collect({ force }));
            res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
            });
            res.end(body);
            return;
        }
        if (opts.layoutProbe && url.pathname === '/__probe') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(probeHarness(Number(url.searchParams.get('w'))));
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
