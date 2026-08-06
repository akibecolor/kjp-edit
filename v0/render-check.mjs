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
    // 🚨 #4: ファイラが「何の差分か」を言っているか、**実際に見える文字**で確かめる。
    //    「変更 1」なのに「(差分なし)」という食い違いを説明できていること。
    filerText: (document.querySelector('.tree')?.textContent ?? '').slice(0, 1200),
    filerTitle: [...document.querySelectorAll('h2, .ph, .title, header')]
      .map(e => e.textContent ?? '').find(t => t.includes('ファイラ')) ?? '',
  };
})()`;

/**
 * 🚨 **IME の変換確定の Enter で実行が発火しないこと（実ブラウザで測る）。**
 *
 * 日本語で打つ前提の UI なのに `isComposing` を見ていなかったので、
 * 変換候補を確定する Enter が **半端な argv をそのまま実行**していた。
 * 字面の検査では意味が無い（条件を消しても行は残る）ので、
 * **合成イベントを撃って副作用の有無を見る**。
 */
const IME_CHECK = `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 200; i++) {
    if (document.querySelector(".cmdbar input")) break;
    await wait(100);
  }
  const input = document.querySelector(".cmdbar input");
  const term = document.querySelector(".term");
  if (!input || !term) return { error: "コマンドバーが無い（--allow-exec とトークンを確認）" };
  const fire = composing => {
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    Object.defineProperty(ev, "isComposing", { get: () => composing });
    input.dispatchEvent(ev);
  };
  const textOf = () => term.textContent ?? "";
  input.value = "git --version";
  const before = textOf();
  fire(true);            // 変換中の確定 Enter → 実行してはいけない
  await wait(1500);
  const afterComposing = textOf();
  fire(false);           // 確定後の Enter → 実行してよい
  let afterReal = afterComposing;
  for (let i = 0; i < 60; i++) {
    await wait(100);
    afterReal = textOf();
    if (afterReal.length > afterComposing.length) break;
  }
  return {
    firedWhileComposing: afterComposing.length !== before.length,
    firedAfterComposing: afterReal.length > afterComposing.length,
  };
})()`;
/**
 * 🚨 **監視盤を実ブラウザで測る（N 個の Claude を並列で回すための要）。**
 *
 * 測るのは2つの主張。どちらも**字面では測れない**:
 *
 * 1. **購読しなくても最後の出力が見える。** これが無いと「どのペインに
 *    打てばいいか」が分からず、並列運用そのものが成立しない。
 * 2. **自動更新で入力欄が消えない。** 行を毎回作り直すと、打っている途中の
 *    文字が消え、さらに送信先がずれる（`docs/review-ui-conflicts.md`）。
 *    `replaceChildren` に戻す変更は、字面の検査では**完全に見えない**。
 *
 * ⚠️ `IME_CHECK` が `git --version` を走らせた**後**に呼ぶこと（対象が要る）。
 */
const MONITOR_CHECK = `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const paneOf = () => document.querySelector('[data-pane-id="monitor"]');
  const rowsOf = () => [...(paneOf()?.querySelectorAll('.body > div > .ab') ?? [])];
  // ⚠️ **必ず出力の出るコマンドを自分で走らせる。** 既定のプリセット
  //    （git status --short）は綺麗なリポジトリでは**何も出さない**ので、
  //    「最後の出力が見える」を測れない（実際にこれで空振りした）。
  const cin = [...document.querySelectorAll('.cmdbar input')].find(e =>
    e.closest('[data-pane-id]')?.dataset.paneId !== 'monitor' && !e.placeholder);
  if (!cin) return { error: 'コンソールの入力欄が見つからない' };
  cin.value = 'git --version';
  // 🚨 **input イベントを撃つ。** 値の代入だけでは argv の再解析が走らないので、
  //    プリセットのまま実行される（この検査自身がそれで空振りした）
  cin.dispatchEvent(new Event('input', { bubbles: true }));
  cin.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  let row = null;
  for (let i = 0; i < 300; i++) {
    row = rowsOf().find(e => /git --version/.test(e.textContent ?? ''));
    if (row && /git version/.test(row.textContent ?? '')) break;
    await wait(100);
  }
  if (!row) {
    return { error: '監視の行が出ない: ' + ((paneOf()?.textContent ?? '(ペインが無い)').slice(0, 300)) };
  }
  const text = row.textContent ?? '';
  const input = row.querySelector('input');
  if (!input) return { error: '行に入力欄が無い（打てない監視盤は用を成さない）' };
  // 打っている途中を再現する。自動更新が来ても消えてはいけない
  const MARK = 'KEEP-ME-42';
  input.value = MARK;
  document.getElementById('refresh').click();
  await wait(3000);
  const same = rowsOf().filter(e => /git --version/.test(e.textContent ?? ''));
  const after = same[0];
  return {
    seenCommand: /git --version/.test(text),
    seenOutput: /git version/.test(text),
    reused: Boolean(after) && after === row,
    // 🚨 **同じセッションの行が増えていないこと。** 作り直す変異は、古い行が
    //    DOM に残るので「先頭は元の行のまま」になり、同一性だけでは見抜けない
    dupes: same.length,
    kept: after ? (after.querySelector('input')?.value ?? null) : null,
    mark: MARK,
    rowCount: rowsOf().length,
    sample: text.replace(/\\s+/g, ' ').slice(0, 200),
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

    // 🚨 #4 の検査用: **コミット済み差分ゼロ + 未コミット変更あり**の worktree を作る。
    //    ファイラが並べるのは `base...HEAD` の**コミット済み**差分なのに、
    //    カードの「変更 N・未追跡 N」は**未コミット**の数。別のものを同じ見た目で
    //    並べていたので「変更 1」なのにファイラが「(差分なし)」になり、
    //    **どちらの数字も信じられなくなっていた**。両方出して食い違いを説明する。
    await g(['worktree', 'add', '-q', '-b', 'uncommitted-only',
        join(repo, '..', `${repo.split(/[\\/]/).pop()}-unc`)], repo);
    await writeFile(join(repo, '..', `${repo.split(/[\\/]/).pop()}-unc`, 'f.txt'),
        'changed but not committed\n', 'utf8');

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

    // 🚨 **すべての評価に retry を付ける。** ページの初期描画や自動更新と重なると
    //    `Execution context was destroyed` で落ちる。`MEASURE` にだけ retry を
    //    付けていたので、後から足した IME の評価が **CI（macOS / Windows）でだけ**
    //    落ちた（手元は速いので再現しない）。**1箇所で扱う。**
    let nextId = 1;
    const evaluate = async (expression, tries = 3) => {
        for (let i = 0; i < tries; i++) {
            try {
                const got = await send(nextId++, 'Runtime.evaluate',
                    { expression, awaitPromise: true, returnByValue: true });
                return got?.result?.value;
            } catch (e) {
                if (!/context was destroyed/i.test(e.message) || i === tries - 1) throw e;
                await sleep(1500);
            }
        }
        return undefined;   // ここには来ない（上で throw する）
    };

    // ⚠️ **ページが落ち着くのを待ってから評価する。** 読み込み中に評価すると
    //    そのあとの遷移で context が捨てられる。
    await evaluate(`(async () => {
      for (let i = 0; i < 300; i++) {
        if (document.readyState === 'complete') return true;
        await new Promise(r => setTimeout(r, 100));
      }
      return false;
    })()`);

    // 🚨 IME の検査は**描画の計測より前**に走らせる（12,000行流した後だと
    //    端末の文字量で副作用を判定できない）
    const ime = await evaluate(IME_CHECK);

    // 🚨 監視盤は IME の検査が走らせた実行を対象にする（**描画の計測より前**。
    //    12,000行流した後だと自動更新が重くなって待ち時間の意味が変わる）
    const monitor = await evaluate(MONITOR_CHECK);

    const probeValue = await evaluate(MEASURE);
    const probe = probeValue;
    if (!probe) throw new Error('計測結果が取れない（評価が値を返さなかった）');
    if (probe.error) throw new Error(probe.error);

    const problems = [];
    // 🔒 IME: 変換中は発火せず、確定後は発火すること（片側だけの検査にしない）
    if (!ime || ime.error) {
        problems.push(`IME の検査ができなかった: ${ime?.error ?? "結果が取れない"}`);
    } else {
        if (ime.firedWhileComposing) {
            problems.push('IME の変換中の Enter で実行が発火した（未確定の argv がそのまま走る）');
        }
        if (!ime.firedAfterComposing) {
            problems.push('確定後の Enter で実行が発火しない（IME の守りが広すぎる）');
        }
    }
    // 🚨 監視盤: 「見える」と「打てる」の両方を実挙動で確かめる
    if (!monitor || monitor.error) {
        problems.push(`監視盤を測れなかった: ${monitor?.error ?? '結果が取れない'}`);
    } else {
        if (!monitor.seenCommand) {
            problems.push('監視盤にコマンド行が出ていない（どのセッションか分からない）'
                + `: ${monitor.sample}`);
        }
        if (!monitor.seenOutput) {
            problems.push('監視盤に最後の出力が出ていない'
                + '（購読しないと状況が分からない = 並列運用ができない）'
                + `: ${monitor.sample}`);
        }
        // 行を作り直すと入力が消える。**要素の同一性と値の両方**を見る
        if (!monitor.reused) {
            problems.push('自動更新で監視盤の行を作り直している'
                + `（打っている途中の入力が消え、送信先もずれる）: 行 ${monitor.rowCount}`);
        }
        if (monitor.dupes !== 1) {
            problems.push('自動更新で同じセッションの行が増えている'
                + `（作り直した行が古い行の下に溜まる）: ${monitor.dupes} 行`);
        }
        if (monitor.kept !== monitor.mark) {
            problems.push('自動更新で入力欄の中身が消えた'
                + `: ${JSON.stringify(monitor.kept)} ≠ ${JSON.stringify(monitor.mark)}`);
        }
    }
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
    // 🚨 #4: ファイラの数字が信じられる形になっていること（実際に見える文字で確かめる）
    // ⚠️ 「コミット済み」だけを見ると、下の「コミット済みの差分なし」にも一致してしまう。
    //    **告知の文そのもの**を見る（照合が甘いと告知を消しても緑になる）
    if (!/一致しません/.test(probe.filerText)) {
        problems.push('ファイラが「何の差分か」を言っていない'
            + `（base...HEAD のコミット済み差分と、未コミットの数は別物）: ${probe.filerText.slice(0, 120)}`);
    }
    if (!/コミット済みの差分なし \/ 未コミット \d+ 件/.test(probe.filerText)) {
        problems.push('コミット済み差分ゼロ + 未コミット変更あり の worktree で'
            + '「変更 N」と「(差分なし)」の食い違いを説明していない'
            + `: ${probe.filerText.slice(0, 300)}`);
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
    // 🚨 **後始末は retry する。** kill の直後は Chrome とサーバがまだファイルを
    //    掴んでいて Windows では `rm` が共有違反で落ちる。`.catch(() => {})` で
    //    飲んでいたので、**temp にディレクトリが残っていた**（実測で3個）。
    //    取り残しは意志ではなく仕組みで防ぐ。
    const rmRetry = async p => {
        for (let i = 0; i < 20; i++) {
            try { await rm(p, { recursive: true, force: true }); return true; } catch { /* 掴まれている */ }
            await sleep(200);
        }
        console.log(`   ⚠ 消せませんでした（手で消してください）: ${p}`);
        return false;
    };
    // ⚠️ worktree は repo の**外**（兄弟）に作ったので個別に消す
    await rmRetry(join(repo, '..', `${repo.split(/[\\/]/).pop()}-unc`));
    await rmRetry(repo);
    await rmRetry(profile);
}
