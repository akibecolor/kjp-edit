#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// クライアント描画の予算を**実ブラウザ・実時間**で測る（#3）。
//
// なぜ要るか: `docs/performance.md` はサーバ側の収集しか測っていなかったので、
// 「出力1件ごとに `scrollHeight` を読んで**総文字数に対して二次**」という
// BLOCKING が**どのテストにも掛からなかった**（実測 12,000行で 53.8秒 /
// 単一ブロック 28.9秒。その間 停止ボタンも自動更新も効かない）。
// コメントで「速い」と主張する代わりに、同じ経路を外から叩いて測る。
//
// ⚠️ **`--virtual-time-budget` を使わない。** 仮想時間はタイマーを早送りするので
//    `performance.now()` の差が実際の作業時間を反映せず、**計測が歪む**
//    （`layout-check.mjs` はレイアウトを見るだけなので仮想時間で良い。ここは別）。
// ⚠️ **`--dump-dom` では取れない。** DOM を吐くのは load の時点なので、
//    非同期の計測が終わるのを待たない（実際に空の結果を読んだ）。
//    **CDP でページに直接評価する。**
// ⚠️ ブラウザは必ず落とす。残留した Chrome が後続を壊す（53個残した事故がある）。
// ⚠️ 固定時間で待たない。入口が出るまでページ側でポーリングする。

import { spawn, execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER = join(ROOT, 'v0', 'server.mjs');

// 予算。**最長ブロック**を見る（平均ではない。UI が固まるのは長い1回のせい）
const LINES = 12000;
const BUDGET_MAX_BLOCK_MS = 400;
const BUDGET_TOTAL_MS = 12000;
const TOKEN = 'render-check-token-0123456789';

// ⚠️ **上限を二重に書かない。** app.html から読む。
//    手で写すと、片方だけ変えたときに検査が黙って無意味になる。
const MAX_SPANS = (() => {
    const html = readFileSync(join(ROOT, 'v0', 'app.html'), 'utf8');
    const m = /const TERM_MAX_SPANS = (\d+);/.exec(html);
    if (!m) throw new Error('app.html に TERM_MAX_SPANS が無い（名前が変わった？）');
    return Number(m[1]);
})();

const CANDIDATES = process.platform === 'win32'
    ? ['C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
    : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const browser = CANDIDATES.find(p => existsSync(p));
if (!browser) {
    console.log('– render (skipped: ブラウザ無し)');
    process.exit(0);
}

const g = (args, cwd) => new Promise(res => execFile('git', args,
    { cwd, windowsHide: true, encoding: 'utf8' }, () => res()));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** ページの中で走らせる計測。**同じ経路（line() → rAF → flush）を叩く。** */
const MEASURE = `(async () => {
  for (let i = 0; i < 300 && typeof window.__kjpFeedTerm !== 'function'; i++) {
    await new Promise(r => setTimeout(r, 100));
  }
  const term = document.querySelector('.term');
  if (!term || typeof window.__kjpFeedTerm !== 'function') {
    return { error: '計測の入口が無い（__kjpFeedTerm / .term）' };
  }
  const LINES = ${LINES};
  let maxBlock = 0;
  const t0 = performance.now();
  for (let i = 0; i < LINES; i += 200) {
    const a = performance.now();
    for (let k = 0; k < 200; k++) window.__kjpFeedTerm('line ' + (i + k) + String.fromCharCode(10));
    await new Promise(r => requestAnimationFrame(r));
    const b = performance.now();
    if (b - a > maxBlock) maxBlock = b - a;
  }
  return {
    lines: LINES,
    totalMs: Math.round(performance.now() - t0),
    maxBlockMs: Math.round(maxBlock),
    spans: term.childNodes.length,
    // 🚨 トークンの扱いを**実際の挙動として**測る（#41）。
    //    smoke 側は JS の字面しか見ていなかったので、行を残したまま
    //    到達不能にする変更（早期 return / 条件で囲む）が完全に見えなかった。
    heldToken: (() => { try { return sessionStorage.getItem('kjp_token'); } catch { return null; } })(),
    search: location.search,
    href: location.href,
    // ⚠️ dataset のフラグではなく**実際に見える文字**を返す。
    //    フラグだけ見ると、告知の要素を作らなくても検査が通ってしまう。
    firstText: (term.firstChild?.textContent ?? '').slice(0, 80),
  };
})()`;

const repo = await mkdtemp(join(tmpdir(), 'kjp-render-'));
const profile = await mkdtemp(join(tmpdir(), 'kjp-render-prof-'));
let server = null;
let chrome = null;
let ws = null;
try {
    await g(['init', '-q', '-b', 'main'], repo);
    await g(['config', 'user.email', 'a@b'], repo);
    await g(['config', 'user.name', 'a'], repo);
    await writeFile(join(repo, 'f.txt'), 'x\n', 'utf8');
    await g(['add', '-A'], repo);
    await g(['commit', '-q', '-m', 'seed'], repo);

    // 実行を有効にしないとコンソールペインが描かれない = 計測対象が出ない
    server = spawn(process.execPath,
        [SERVER, '--repo', repo, '--port', '0',
            '--allow-exec', '--token', TOKEN],
        { shell: false, windowsHide: true });
    server.stdout.setEncoding('utf8');
    server.stderr.setEncoding('utf8');
    let banner = '';
    let serr = '';
    server.stderr.on('data', d => { serr += d; });
    const base = await Promise.race([
        new Promise((res, rej) => {
            server.stdout.on('data', d => {
                banner += d;
                const m = banner.match(/http:\/\/127\.0\.0\.1:\d+/);
                if (m) res(m[0]);
            });
            server.on('error', rej);
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error(
            `サーバが起動しなかった\n  stdout: ${banner}\n  stderr: ${serr}`)), 30000)),
    ]);

    // ⚠️ **バナーからトークンを拾おうとしない。** URL の行とトークンの行は
    //    別のチャンクで来るので、URL が出た時点ではまだ無い（実際に踏んだ）。
    //    バナーが案内を出すことの検証はスモーク側にある
    //    （「--allow-exec でもトークン付き URL が案内される」）。

    chrome = spawn(browser, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--disable-extensions', '--disable-background-networking',
        ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
        `--user-data-dir=${profile}`, '--window-size=1400,1000',
        '--remote-debugging-port=0',
        // ⚠️ **トークン付きの URL で開く。** 実行を有効にしているので、
        //    トークンが無いとコンソールが描かれず（= 計測対象が無い）、
        //    30秒空回りする（先の UI 修正の副作用で実際に踏んだ）。
        `${base}/?token=${TOKEN}&probe=1`,
    ], { shell: false, windowsHide: true });
    chrome.stderr.setEncoding('utf8');
    let cerr = '';
    chrome.stderr.on('data', d => { cerr += d; });

    // DevTools のポートはプロファイル内のファイルに書かれる。出るまで待つ
    const portFile = join(profile, 'DevToolsActivePort');
    let devPort = null;
    for (let i = 0; i < 200 && devPort === null; i++) {
        await sleep(100);
        try {
            const t = await readFile(portFile, 'utf8');
            const n = Number(t.split('\n')[0].trim());
            if (Number.isFinite(n) && n > 0) devPort = n;
        } catch { /* まだ無い */ }
    }
    if (devPort === null) throw new Error(`DevTools のポートが出ない\n  stderr: ${cerr.slice(0, 300)}`);

    // 対象ページの WebSocket を探す
    let target = null;
    for (let i = 0; i < 100 && !target; i++) {
        await sleep(100);
        try {
            const list = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
            target = list.find(t => t.type === 'page' && /127\.0\.0\.1/.test(t.url ?? ''));
        } catch { /* まだ */ }
    }
    if (!target) throw new Error('対象ページが見つからない');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', () => rej(new Error('CDP に繋がらない')), { once: true });
    });
    // ⚠️ **上限のタイマーは必ず解除する。** 解除しないと、計測が 1.2 秒で終わっても
    //    イベントループが上限まで（240秒）生き続け、**検証全体が4分伸びる**
    //    （`verify.mjs` が `render 240.7s` を出したのは遅いからではなくこれ）。
    const send = (id, method, params) => new Promise((res, rej) => {
        let timer = null;
        const done = fn => arg => {
            if (timer !== null) clearTimeout(timer);
            ws.removeEventListener('message', onMsg);
            fn(arg);
        };
        const onMsg = ev => {
            let m;
            try { m = JSON.parse(ev.data); } catch { return; }
            if (m.id !== id) return;
            if (m.error) done(rej)(new Error(`${method}: ${m.error.message}`));
            else done(res)(m.result);
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id, method, params }));
        timer = setTimeout(() => done(rej)(new Error(`${method} が返らない`)), 240000);
    });

    // ⚠️ ページの再描画と重なると `Execution context was destroyed` になる。
    //    1回だけやり直す（それでも駄目なら失敗として出す）
    let r;
    try {
        r = await send(1, 'Runtime.evaluate',
            { expression: MEASURE, awaitPromise: true, returnByValue: true });
    } catch (e) {
        if (!/context was destroyed/i.test(e.message)) throw e;
        await sleep(1500);
        r = await send(2, 'Runtime.evaluate',
            { expression: MEASURE, awaitPromise: true, returnByValue: true });
    }
    const probe = r?.result?.value;
    if (!probe) throw new Error(`計測結果が取れない: ${JSON.stringify(r).slice(0, 200)}`);
    if (probe.error) throw new Error(probe.error);

    const problems = [];
    if (probe.maxBlockMs > BUDGET_MAX_BLOCK_MS) {
        problems.push(`最長ブロック ${probe.maxBlockMs}ms > 予算 ${BUDGET_MAX_BLOCK_MS}ms`
            + '（UI が固まって停止ボタンも自動更新も効かない）');
    }
    if (probe.totalMs > BUDGET_TOTAL_MS) {
        problems.push(`合計 ${probe.totalMs}ms > 予算 ${BUDGET_TOTAL_MS}ms`);
    }
    // 上限で捨てる作りも一緒に見る。**捨てるのに黙っていたら嘘**なので告知も見る
    // （`docs/review-ui-conflicts.md`「表示上限で省略したら必ず告知する」）。
    if (probe.spans > MAX_SPANS) {
        problems.push(`要素が ${probe.spans} 個（上限 ${MAX_SPANS}）= 古い行を捨てていない`);
    }
    // 🔒 トークンの扱い（#41）。ここが壊れると URL と履歴・Referer にトークンが残り、
    //    sessionStorage に入らないので書き込み・実行が静かに使えなくなる。
    //    ⚠️ **`?probe=1` は残り、`token=` だけが消える**のが正しい形
    //       （他のクエリを一緒に落とすと probe が動かなくなる）。
    if (probe.heldToken !== TOKEN) {
        problems.push('トークンが sessionStorage に入っていない'
            + `（Cookie 経由でしか取り戻せなくなり、他ポートの相手が実行に到達する）: ${probe.heldToken}`);
    }
    if (/token=/.test(probe.search) || /token=/.test(probe.href)) {
        problems.push(`URL からトークンが消えていない（履歴と Referer に残る）: ${probe.search}`);
    }
    if (!/probe=1/.test(probe.search)) {
        problems.push(`token 以外のクエリまで消している: ${probe.search}`);
    }
    if (!/捨てて/.test(probe.firstText)) {
        problems.push('古い行を捨てたのに告知が見えない（「全部見えている」と誤認させる）'
            + `: 先頭は ${JSON.stringify(probe.firstText)}`);
    }
    console.log(problems.length ? '✖ render' : '✔ render');
    console.log(`   ${probe.lines} 行 = ${probe.totalMs}ms / `
        + `最長ブロック ${probe.maxBlockMs}ms / 残った要素 ${probe.spans}`);
    for (const p of problems) console.log(`   ${p}`);
    process.exitCode = problems.length ? 1 : 0;
} catch (e) {
    console.log('✖ render');
    console.log(`   ${e.message}`);
    process.exitCode = 1;
} finally {
    try { ws?.close(); } catch { /* noop */ }
    try { chrome?.kill('SIGKILL'); } catch { /* noop */ }
    try { server?.kill(); } catch { /* noop */ }
    await sleep(400);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    await rm(repo, { recursive: true, force: true }).catch(() => {});
}
