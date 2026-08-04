#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// UI のレイアウトを実際のブラウザで測る。狭い画面で情報が消えていないかを見る。
//
//   node v0/layout-check.mjs [--repo <path>]
//
// なぜ必要か（実際に踏んだ3件。いずれも「見た目で気付けない」種類）:
//   1. grid/flex アイテムの min-width は既定 auto。グラフの SVG が列を押し広げ、
//      body ごと viewport より広くなっていた
//   2. `auto` 幅の grid 列にパーセント max-width を書くと幅が循環参照になり、
//      ref バッジが `a…` `HE…` のように1〜2文字へ潰れていた
//   3. バッジを overflow:hidden の .subject の中に入れていたため、狭い画面で
//      **完全に見えなくなり、横スクロールでも到達できず、溢れとしても検出されなかった**
//
// Chrome/Edge が無い環境（CI 等）では**スキップして exit 0**。
// ブラウザは検査にしか使わないので、プロジェクトの依存パッケージは増えない。

import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));

const CANDIDATES = process.platform === 'win32'
    ? ['C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe']
    : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

async function findBrowser() {
    for (const p of CANDIDATES) {
        try { await access(p); return p; } catch { /* 次を試す */ }
    }
    return null;
}

const repoArg = process.argv.indexOf('--repo');
const repo = repoArg !== -1 ? process.argv[repoArg + 1] : process.cwd();

const browser = await findBrowser();
if (!browser) {
    console.log('– layout: skipped (Chrome/Edge が見つからない)');
    process.exit(0);
}

// サーバを起動して URL を得る
const server = spawn(process.execPath,
    // ⚠️ 活動観測と**実行**も有効にする。--allow-exec が無いと
    //    コンソールは「実行は無効です」の一文になり、**コマンドバー
    //    （select + 入力 + ボタン3つ）が描かれないので測れない**。
    //    ボタンを1つ足したときに 390px で溢れても気付けなかった。
    [SERVER, '--repo', repo, '--port', '0', '--layout-probe', '--watch-agents',
        '--allow-exec', '--token', 'layout-check-token-0123456789'],
    { shell: false, windowsHide: true });
server.stdout.setEncoding('utf8');
server.stderr.setEncoding('utf8');

let baseUrl;
try {
    baseUrl = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('サーバが起動しなかった')), 15000);
        let buf = '';
        server.stdout.on('data', d => {
            buf += d;
            const m = buf.match(/http:\/\/127\.0\.0\.1:\d+/);
            if (m) { clearTimeout(t); resolve(m[0]); }
        });
        server.stderr.on('data', d => { clearTimeout(t); reject(new Error(d)); });
        server.on('error', reject);
    });
} catch (err) {
    server.kill();
    console.log(`✖ layout: サーバ起動に失敗 — ${err.message}`);
    process.exit(1);
}

/** ハーネスを開いて JSON を取り出す */
async function measure(width) {
    const profile = await mkdtemp(join(tmpdir(), 'kjp-layout-'));
    const child = spawn(browser, [
        // ⚠️ `--headless=old` は Chrome 132 で削除された。`=new` を使う
        //    （どちらでも iframe 幅は正しく効くことを実測済み）。
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--disable-extensions', '--disable-background-networking',
        // CI のコンテナでは sandbox が使えないことがある。ローカルでは付けない。
        ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
        `--user-data-dir=${profile}`, '--window-size=1200,2100',
        '--virtual-time-budget=8000', '--dump-dom',
        `${baseUrl}/__probe?w=${width}`,
    ], { shell: false, windowsHide: true });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => { out += d; });
    // ⚠️ 撮影後にブラウザを必ず落とす。放置すると同時実行で数十プロセス残る（実際に53個残した）
    const done = new Promise(r => child.on('close', r));
    const kill = setTimeout(() => child.kill('SIGKILL'), 60_000);
    await done;
    clearTimeout(kill);
    await rm(profile, { recursive: true, force: true });

    const m = out.match(/<pre id="out">([\s\S]*?)<\/pre>/);
    if (!m) throw new Error(`幅 ${width}: 計測結果が取れなかった`);
    const decode = s => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    return JSON.parse(decode(m[1]));
}

const problems = [];
const lines = [];
try {
    for (const width of [390, 768, 1280]) {
        const r = await measure(width);
        // iframe の幅が指定通りでないと、測っている対象が違う
        if (r.innerWidth !== width) {
            problems.push(`幅 ${width}: iframe の innerWidth が ${r.innerWidth} になっている`);
        }
        const overflows = r.bodyScrollWidth > r.bodyClientWidth + 1;
        if (overflows) {
            problems.push(`幅 ${width}: body が横に溢れている `
                + `(${r.bodyScrollWidth} > ${r.bodyClientWidth}) — ${r.overflowing.join(', ')}`);
        }
        // 🚨 hidden なのに描かれている = 押しても無反応の操作が出ている
        if (r.hiddenButDrawnCount > 0) {
            problems.push(`幅 ${width}: hidden なのに描かれている要素がある `
                + `(${r.hiddenButDrawn.join(', ')})`);
        }
        if (r.squashedCount > 0) {
            problems.push(`幅 ${width}: バッジが幅24px未満に潰れている `
                + `${r.squashedCount} 個 — ${r.squashedBadges.join(', ')}`);
        }
        // どの幅でも worktree HEAD は見えていなければならない。
        // これが 0 になるのは「どのコミットがどのエージェントの HEAD か」が
        // 消えた状態で、観測ツールとして意味を失う。
        if (r.visibleWorktreeBadges === 0) {
            problems.push(`幅 ${width}: worktree HEAD バッジが1つも描かれていない`);
        }
        lines.push(`  ${String(width).padStart(4)}px: 横溢れ ${overflows ? '✖' : 'なし'}`
            + ` / worktree HEAD ${r.visibleWorktreeBadges} 個・ref 込み ${r.visibleBadges} 個`
            + ` / 潰れ ${r.squashedCount} / viewport 超過 ${r.overflowingCount} 件`);
    }
} catch (err) {
    problems.push(err.message);
} finally {
    server.kill();
}

console.log(problems.length ? '✖ layout' : '✔ layout');
for (const l of lines) console.log(l);
for (const p of problems) console.log(`  ${p}`);
process.exit(problems.length ? 1 : 0);
