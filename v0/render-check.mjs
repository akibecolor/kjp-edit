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
  // 🚨 **コンソールが空くまで待つ。** 走っている間は入力欄が disabled で
  //    Enter が効かないので、直前の検査（IME）の実行が終わる前に撃つと
  //    **何も起動せず30秒空回りする**（手元は速いので緑、**CI の Windows だけ落ちた**）。
  for (let i = 0; i < 400 && cin.disabled; i++) await wait(100);
  if (cin.disabled) return { error: 'コンソールが空かない（前の実行が終わらない）' };
  cin.value = 'git --version';
  // 🚨 **input イベントを撃つ。** 値の代入だけでは argv の再解析が走らないので、
  //    プリセットのまま実行される（この検査自身がそれで空振りした）
  cin.dispatchEvent(new Event('input', { bubbles: true }));
  cin.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  // 🚨 **起動したことを確かめてから待つ。** 起動していないのに行を探し続けると
  //    「監視盤が壊れている」という**別の原因に見える**エラーになる（CI で1往復無駄にした）。
  //    走り始めれば入力欄が disabled になる（短いコマンドは待つ前に終わりうるので
  //    出力が出ていることでも良しとする）。
  let started = false;
  for (let i = 0; i < 100 && !started; i++) {
    started = cin.disabled || /git version/.test(document.querySelector('.term')?.textContent ?? '');
    if (!started) await wait(100);
  }
  if (!started) return { error: 'Enter で実行が始まらなかった（監視盤ではなくコンソール側の問題）' };
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

/**
 * 🚨 **「生きている合図」を実ブラウザで測る。**
 *
 * claude が長い応答を書いている間は**出力が1行も来ない**ので、画面が沈黙して
 * 止まったように見える（実機で「正しい回答じゃない」と読まれた。答えは沈黙の
 * あとに届いていた）。固定行の心拍が**実際に増えていく**ことを測る。
 * 字面では測れない（`setInterval` を消しても行は残る）。
 */
const BEAT_CHECK = `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const cin = [...document.querySelectorAll('.cmdbar input')].find(e =>
    e.closest('[data-pane-id]')?.dataset.paneId !== 'monitor' && !e.placeholder);
  if (!cin) return { error: 'コンソールの入力欄が見つからない' };
  for (let i = 0; i < 400 && cin.disabled; i++) await wait(100);
  if (cin.disabled) return { error: 'コンソールが空かない' };
  // 出力を出さずに走り続けるコマンド = 沈黙の再現
  // ⚠️ 絶対パスを使わない（Windows のバックスラッシュを検査の文字列に持ち込まない）。
  //    spawn は shell を経由しないが、実行ファイル名は PATH から解決される
  cin.value = 'node -e "setTimeout(()=>{}, 15000)"';
  cin.dispatchEvent(new Event('input', { bubbles: true }));
  cin.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  // ⚠️ **描かれているものだけ数える**（hidden でも textContent は残る。
  //    それを「消えていない」と読んで1往復無駄にした）。layout-check と同じ判定
  const beatOf = () => [...document.querySelectorAll('.note')]
    .filter(e => e.getClientRects().length > 0)
    .map(e => e.textContent ?? '').find(t => t.includes('実行中')) ?? null;
  let first = null;
  for (let i = 0; i < 100 && first === null; i++) { await wait(100); first = beatOf(); }
  if (first === null) return { error: '心拍の行が出ない（沈黙と停止を区別できない）' };
  await wait(2600);
  const second = beatOf();
  // 停止して、心拍が消えることも見る（終わったのに「実行中」と言わない）
  // ⚠️ 監視盤の停止ボタンを押さない。cmdbar の class は監視盤の行にもあるので、
  //    素の querySelectorAll だと**別のセッションを止めて**「消えない」と誤判定する
  //    （実際にこれで落ちた。しかも終了した行のボタンは disabled ではない）
  //    ⚠️ ここはテンプレートリテラルの中。**バックティックを書くと構文エラー**になる
  const stopBtn = [...(cin.closest('[data-pane-id]')?.querySelectorAll('.cmdbar button') ?? [])]
    .find(b => b.textContent === '停止' && !b.disabled);
  if (stopBtn) stopBtn.click();
  let gone = false;
  for (let i = 0; i < 100 && !gone; i++) { await wait(100); gone = beatOf() === null; }
  const pane = cin.closest('[data-pane-id]');
  return {
    first, second, changed: first !== second, gone,
    clicked: Boolean(stopBtn),
    running: pane?.querySelector('[data-running]')?.dataset?.running ?? '(不明)',
    beatNow: beatOf(),
    tail: (pane?.querySelector('.term')?.textContent ?? '').slice(-160),
  };
})()`;

/**
 * 🚨 **1ペインは1本しか購読しない（8回目のレビューの BLOCKING）。**
 *
 * 以前は再接続を2回押すと2本を同じ端末に混ぜて購読でき、
 * 入力は「最後に publish した方」に届き、片方の exit で
 * `✖ exit=…` を出して停止も押せなくするのに**もう1本が同じ端末に出力を続けた**。
 *
 * 検査: 走っている2本（AAA / BBB）を用意し、A に再接続 → B に「切替」→
 *   (1) 端末に A の印が**残っていない**（作り直している）
 *   (2) 入力が B に届く（B の出力にだけ印が出る）
 *   (3) A の出力がその後も端末に混ざらない
 * ⚠️ 字面では測れない（世代番号の比較を消しても行は残る）。
 */
const DUAL_CHECK = `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const pane = [...document.querySelectorAll('[data-pane-id]')]
    .find(p => p.dataset.paneId.startsWith('console-'));
  if (!pane) return { error: 'コンソールのペインが無い' };
  const termOf = () => pane.querySelector('.term')?.textContent ?? '';
  const resumeBtns = () => [...pane.querySelectorAll('button')]
    .filter(b => b.textContent === '再接続' || b.textContent === '切替');
  // 走っている2本が resume 一覧に出るまで待つ（自動更新は15秒なので更新を押す）
  let btns = [];
  for (let i = 0; i < 60; i++) {
    document.getElementById('refresh').click();
    await wait(1000);
    btns = resumeBtns();
    if (btns.length >= 2) break;
  }
  if (btns.length < 2) return { error: '再接続の候補が2本出ない: ' + btns.length };
  btns[0].click();
  await wait(2500);
  const afterFirst = termOf();
  // 2本目に切り替える（このボタンは「切替」になっているはず）
  const again = resumeBtns();
  const label = again[0]?.textContent ?? '(無し)';
  if (!again.length) return { error: '切替の候補が出ない' };
  // 🚨 **切替の「途中」を細かく見る。** 古い購読の終了通知は、新しい購読の
  //    session レコードで**すぐ上書きされて回復する**ので、固定時間後に見ると
  //    健全に見える（実測。変異が生き残った）。**一瞬でも「停止」表示になったら嘘**
  //    なので、その瞬間を捕まえる。
  const drawnEl = e => Boolean(e) && e.getClientRects().length > 0;
  const barOf = () => [...pane.querySelectorAll('.cmdbar input')].find(e => e.placeholder);
  const stopOf = () => [...pane.querySelectorAll('.cmdbar button')]
    .find(b => b.textContent === '停止');
  window.__kjpConsoleStates = [];   // 切替の前で区切る
  again[0].click();
  let flickered = false;
  for (let i = 0; i < 50; i++) {
    await wait(50);
    const b = barOf();
    const st = stopOf();
    // 入力欄が消える or 停止が押せなくなる = そのペインは「実行していない」と言っている
    if ((b && !drawnEl(b)) || (st && st.disabled)) { flickered = true; break; }
  }
  await wait(1500);
  const afterSwitch = termOf();
  // 入力を撃つ（届いた方のプロセスが印をエコーする）
  const inp = [...pane.querySelectorAll('.cmdbar input')].find(e => e.placeholder);
  if (!inp) return { error: '標準入力の欄が出ていない' };
  const placeholder = inp.placeholder;
  inp.value = 'MARK-DUAL';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await wait(3000);
  const afterInput = termOf();
  // ⚠️ **どちらが1本目かに依存しない。** 一覧の並びは新しい順なので
  //    「btns[0] は A」と決め打つと、正しく切り替わっているのに落ちる（実測）。
  const sideOf = t => {
    const a = /AAA/.test(t), b = /BBB/.test(t);
    if (a && b) return 'both';       // 混ざっている = 二重購読が壊れている
    if (a) return 'AAA';
    if (b) return 'BBB';
    return 'none';
  };
  const first = sideOf(afterFirst);
  const second = sideOf(afterSwitch);
  // 🚨 **古い購読の通知で「停止」表示に戻らないこと。**
  //    切替で前の購読を abort すると、その finally が
  //    onState({running:false}) を投げる。世代で捨てないと、
  //    **走っている方を見ているのに入力欄が消え、停止も押せなくなる**
  //    （このリポジトリ最重の食い違い）。**描かれているか**で測る。
  const drawn = e => Boolean(e) && e.getClientRects().length > 0;
  const barVisible = drawn(inp);
  const stopBtn2 = [...pane.querySelectorAll('.cmdbar button')]
    .find(b => b.textContent === '停止');
  return {
    label, placeholder, first, second,
    barVisible, flickered,
    // 門を通った遷移列。切替後に running:false が混ざっていたら
    // 「走っているのに停止と言った」ことになる（一瞬でも嘘）
    states: (window.__kjpConsoleStates ?? []).slice(0, 8),
    stopEnabled: Boolean(stopBtn2) && !stopBtn2.disabled,
    beatShown: [...pane.querySelectorAll('.note')].filter(drawn)
      .some(e => /実行中/.test(e.textContent ?? '')),
    // 入力は「今見ている方」に届いていなければならない
    // ⚠️ ここはテンプレートリテラルの中。バックティックは書けないので連結で組む
    echoedToShown: new RegExp(second + '-got:MARK-DUAL').test(afterInput),
    mixedAfter: sideOf(afterInput) === 'both',
    tail: afterInput.slice(-200),
  };
})()`;

/**
 * 🚨 **読み取り用の鍵しか無いタブ（= スマホ）で機能が黙って消えないこと
 *    （8回目のレビュー。SERIOUS）。**
 *
 * `--allow-host` のトンネルは `--require-auth` を自動でオンにする。その構成では
 * サーバが `execSessions` を落とす（argv に秘密が載りうる。**この分界は緩めない**）。
 * 落としたことを UI が言わないと、**走っているセッションと再接続口が
 * 「1本も走っていない」と同じ見た目**になる（#17 の目的そのものが到達不能）。
 *
 * ⚠️ **字面では測れない。** 告知の行を作らなくても、hidden のままでも、
 *    文字列は app.html に残る。**描かれている文字**を見る。
 * ⚠️ 最後に走らせる（鍵を捨てて読み込み直すので、他の検査の前提を壊す）。
 */
const READKEY_CHECK = `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const pane = [...document.querySelectorAll('[data-pane-id]')]
    .find(p => p.dataset.paneId.startsWith('console-'));
  if (!pane) return { error: 'コンソールのペインが無い（読み込み直しに失敗した？）' };
  const drawn = e => e.getClientRects().length > 0;
  // ⚠️ hidden でも textContent は残るので、**描かれているものだけ**を読む
  const notes = () => [...pane.querySelectorAll('.note')].filter(drawn)
    .map(e => e.textContent ?? '').join(' | ');
  let text = '';
  for (let i = 0; i < 100; i++) {
    text = notes();
    if (/出せません/.test(text)) break;
    await wait(200);
  }
  return {
    heldToken: (() => { try { return sessionStorage.getItem('kjp_token'); } catch { return null; } })(),
    canRun: [...pane.querySelectorAll('button')].some(b => b.textContent === '実行'),
    said: /出せません/.test(text),
    sample: text.replace(/\\s+/g, ' ').slice(0, 300),
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
    // 🚨 **`--require-auth` を付ける（8回目のレビュー。SERIOUS）。**
    //    これは `--allow-host` = トンネル = スマホから使う既定の構成であり、
    //    サーバが `/api/v0/state` の `execSessions` を「生の鍵を提示していない
    //    要求」には返さない構成でもある。ブラウザ検査はこの構成を**1度も
    //    踏んでいなかった**ので、`load()` がヘッダを付けずに一覧を取り落とし、
    //    **一番使う経路で再接続口が黙って消えている**ことに誰も気付けなかった。
    server = spawn(process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--require-auth',
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

    // 🚨 心拍は**監視盤の検査より後**に走らせる（先に走らせると、
    //    15秒走るセッションが監視盤の行の数を変えて dupes の判定を乱す）
    const beat = await evaluate(BEAT_CHECK);

    // 🚨 二重購読の検査。走っている2本を API で用意する（UI からは1本しか作れない）。
    //    ⚠️ keepAlive にする（購読を切るので猶予で殺されると測る前に消える）
    const startSide = async mark => {
        const res = await fetch(`${base}/api/v0/exec`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': TOKEN },
            body: JSON.stringify({
                worktree: repo,
                argv: [process.execPath, '-e',
                    // ⚠️ 子のソースには**改行のエスケープ**を渡す（生の改行を入れると
                    //    子側の文字列リテラルが閉じずに構文エラーになる）
                    'const m=process.argv[1];const NL=String.fromCharCode(10);'
                    + 'setInterval(()=>process.stdout.write(m+"-tick"+NL),700);'
                    + 'process.stdin.on("data",d=>process.stdout.write(m+"-got:"+String(d).trim()+NL));',
                    mark],
                keepAlive: true,
            }),
        });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let id = null;
        let timer = null;
        const deadline = new Promise(r => { timer = setTimeout(() => r('timeout'), 5000); });
        while (id === null) {
            const got = await Promise.race([reader.read(), deadline]);
            if (got === 'timeout' || got.done) break;
            buf += dec.decode(got.value, { stream: true });
            const nl = buf.indexOf(String.fromCharCode(10));
            if (nl === -1) continue;
            const rec = JSON.parse(buf.slice(0, nl));
            if (rec.t === 'session') id = rec.id;
        }
        clearTimeout(timer);
        await reader.cancel().catch(() => {});
        return id;
    };
    const sideA = await startSide('AAA');
    const sideB = await startSide('BBB');
    const dual = (sideA && sideB) ? await evaluate(DUAL_CHECK) : { error: '2本用意できなかった' };
    for (const id of [sideA, sideB]) {
        if (!id) continue;
        await fetch(`${base}/api/v0/exec/${id}/kill`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': TOKEN },
        }).catch(() => {});
    }

    const probeValue = await evaluate(MEASURE);
    const probe = probeValue;
    if (!probe) throw new Error('計測結果が取れない（評価が値を返さなかった）');
    if (probe.error) throw new Error(probe.error);

    // 🚨 **最後に「読み取り用の鍵だけ」の状態を作って測る。**
    //    鍵を捨てて読み込み直すと、Cookie（読み取り専用の派生秘密）だけが残る =
    //    スマホが案内の URL を1回開いた状態。ここで走っているセッションの一覧が
    //    「出せません」と言われることを確かめる（黙って空にしない）。
    //    ⚠️ 他の検査の前提（鍵を持っている）を壊すので、必ずこの位置。
    await evaluate(`(() => {
      try { sessionStorage.removeItem('kjp_token'); } catch (e) { /* 使えない環境 */ }
      location.reload();
      return true;
    })()`).catch(() => { /* reload で実行コンテキストが消えるのは正常 */ });
    await sleep(1500);
    await evaluate(`(async () => {
      for (let i = 0; i < 300; i++) {
        if (document.readyState === 'complete') return true;
        await new Promise(r => setTimeout(r, 100));
      }
      return false;
    })()`);
    const readkey = await evaluate(READKEY_CHECK);

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
    // 🚨 心拍: 沈黙している間も「生きている」と分かること
    if (!beat || beat.error) {
        problems.push(`心拍を測れなかった: ${beat?.error ?? '結果が取れない'}`);
    } else {
        if (!beat.changed) {
            problems.push('出力が来ない間、心拍が更新されない'
                + `（沈黙と停止を区別できない）: ${JSON.stringify(beat.first)}`);
        }
        if (!beat.gone) {
            problems.push('停止したのに「実行中」が残っている（走っていると誤読させる）'
                + `: 停止を押せた=${beat.clicked} running=${JSON.stringify(beat.running)}`
                + ` 心拍=${JSON.stringify(beat.beatNow)} 端末の末尾=${JSON.stringify(beat.tail)}`);
        }
    }
    // 🚨 二重購読: 1ペイン1セッションの不変条件
    if (!dual || dual.error) {
        problems.push(`二重購読を測れなかった: ${dual?.error ?? '結果が取れない'}`);
    } else {
        if (dual.label !== '切替') {
            problems.push('購読中なのにボタンが「切替」になっていない'
                + `（両方見られると誤解させる）: ${dual.label}`);
        }
        if (dual.first === 'both' || dual.second === 'both' || dual.mixedAfter) {
            problems.push('2本の出力が同じ端末に混ざっている（1ペイン1購読が壊れている）'
                + `: ${JSON.stringify(dual.tail)}`);
        }
        if (dual.first === 'none' || dual.second === 'none') {
            problems.push('購読したセッションの出力が出ていない'
                + `（${dual.first} → ${dual.second}）: ${JSON.stringify(dual.tail)}`);
        }
        if (dual.first !== 'none' && dual.first === dual.second) {
            problems.push('「切替」で別のセッションに移っていない'
                + `（両方 ${dual.first}）: ${JSON.stringify(dual.tail)}`);
        }
        if (!dual.echoedToShown) {
            problems.push('入力が「今見ているセッション」に届いていない'
                + `（見えているのは ${dual.second}）: ${JSON.stringify(dual.tail)}`);
        }
        // 🚨 古い購読の終了通知で「停止」状態に戻っていないこと
        if (!dual.barVisible) {
            problems.push('切替後に標準入力の欄が消えている'
                + '（古い購読の exit で「停止」表示に戻った = 走っているのに打てない）');
        }
        if (!dual.stopEnabled) {
            problems.push('切替後に停止ボタンが押せない'
                + '（走っているセッションをそのペインから止められない）');
        }
        if (!dual.beatShown) {
            problems.push('切替後に心拍が出ていない（走っているのに止まって見える）');
        }
        if (dual.flickered) {
            problems.push('切替の途中で「実行していない」表示になった'
                + '（古い購読の終了通知を捨てていない。一瞬でも停止と見えるのは嘘）');
        }
        // 遷移列で決定的に見る（画面のサンプリングでは数ミリ秒の嘘を掠れない）
        if ((dual.states ?? []).some(x => x.running === false)) {
            problems.push('切替後に running:false の通知が通っている'
                + `（古い購読の終了で「停止」に戻る）: ${JSON.stringify(dual.states)}`);
        }
        if (!/→ /.test(dual.placeholder)) {
            problems.push(`入力欄が送信先を出していない: ${JSON.stringify(dual.placeholder)}`);
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
    // 🚨 読み取り用の鍵だけのタブ（スマホの既定の構成）で、機能が黙って消えないこと
    if (!readkey || readkey.error) {
        problems.push(`読み取り用の鍵の画面を測れなかった: ${readkey?.error ?? '結果が取れない'}`);
    } else {
        if (readkey.heldToken !== null) {
            problems.push('検査が鍵を捨てられていない = 読み取り専用の状態を作れていない'
                + `（この検査は何も測っていない）: ${JSON.stringify(readkey.heldToken)}`);
        }
        if (readkey.canRun) {
            problems.push('実行の鍵が無いのに実行ボタンが出ている（押せば必ず 403）');
        }
        if (!readkey.said) {
            problems.push('読み取り用の鍵のとき、走っているセッションの一覧を'
                + '「出せない」と言っていない（1本も走っていないと同じ見た目になる）'
                + `: ${JSON.stringify(readkey.sample)}`);
        }
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
