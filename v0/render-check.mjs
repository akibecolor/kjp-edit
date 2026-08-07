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

// 全文ビューアの予算。**同じく上限は blobview.mjs から読む**（手で写さない）。
const MAX_VIEW_LINES = (() => {
    const src = readFileSync(join(ROOT, 'v0', 'blobview.mjs'), 'utf8');
    const m = /export const MAX_VIEW_LINES = (\d+);/.exec(src);
    if (!m) throw new Error('blobview.mjs に MAX_VIEW_LINES が無い（名前が変わった？）');
    return Number(m[1]);
})();
// 上限を超える行数のファイルを用意して「切ったことを告知する」を実際に見る
const BLOB_FILE_LINES = MAX_VIEW_LINES + 500;
const BUDGET_BLOB_MS = 400;

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
  // 🚨 **周期更新（4秒）が click 無しで発火することを測る。**
  //    レイアウト検査は timers=0 で止められるようにしたので、
  //    「実運用では止まっていない」をここで押さえる（止まると盤が
  //    古い状態を出し続け、どれが待っているか分からなくなる）。
  const ageOf = () => {
    const r = rowsOf().find(e => /git --version/.test(e.textContent ?? ''));
    // ⚠️ ここはテンプレートリテラルの中。バックスラッシュのエスケープは
    //    1段失われる（\d が d に潰れて一致しない。実測で ageBefore=null になった）。
    //    バックスラッシュを持ち込まない書き方（文字クラス）にする。
    const m = /([0-9]+)秒/.exec(r?.textContent ?? '');
    return m ? Number(m[1]) : null;
  };
  const ageBefore = ageOf();
  let tickedWithoutClick = false;
  for (let i = 0; i < 100 && !tickedWithoutClick; i++) {
    await wait(200);
    const now = ageOf();
    tickedWithoutClick = ageBefore !== null && now !== null && now > ageBefore;
  }
  document.getElementById('refresh').click();
  await wait(3000);
  const same = rowsOf().filter(e => /git --version/.test(e.textContent ?? ''));
  const after = same[0];
  return {
    seenCommand: /git --version/.test(text),
    tickedWithoutClick,
    ageBefore,
    // 🚨 **行を見分ける印（#50）。** 見出しは basename だと
    //    a/wt-main と b/wt-main で同じになる（ここはテンプレートリテラルの中なので
    //    バックティックは書けない）。ラベルの一意化は unit で測るので、ここでは
    //    **最後の手段の id** が
    //    実際に描かれていることを測る（各行に stdin の欄があるので、
    //    見分けられないと別のエージェントに文字が入る）。
    idTagShown: /#[0-9a-f]{6}/.test(text),
    // 送信先が入力欄の placeholder にも出ていること（打つ直前に確認できる）
    placeholderHasId: /#[0-9a-f]{6}/.test(input.placeholder ?? ''),
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
 * 🚨 **リポジトリの切り替えを実ブラウザで測る。**
 *
 * 字面では測れない主張が2つある:
 *
 * 1. **切り替えたら state を取り直す。** `change` を撃たずに `value` を代入しても
 *    何も起きないので、検査は必ずイベントを撃つ（`input.value = …` で
 *    プリセットを実行してしまった事故と同型）。
 * 2. **自動更新でセレクトを作り直さない。** 作り直すと選択が先頭（既定の
 *    リポジトリ）に戻り、**見ている画面と操作の対象がずれる**。
 *    `render()` の中にセレクトの構築を移す変更は、字面の検査では**完全に見えない**。
 *    要素の同一性・件数・選択値の3つを一緒に見る（同一性だけでは、
 *    古い option が残る作り直しを「使い回している」と誤読する）。
 *
 * ⚠️ **これは他の検査より後で走らせる**（呼び出し側のコメント参照）。
 *    切り替えるとコンソールペインが作り直され、`__kjpFeedTerm` が
 *    DOM から外れた端末を指したままになるので、描画の計測が無意味になる。
 *    それでも最後に既定へ戻す（この後に検査を足した人が踏まないため）。
 */
const REPOSEL_CHECK = `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const head = () => document.getElementById('repo').textContent ?? '';
  const sel = document.getElementById('reposel');
  if (!sel) return { error: 'リポジトリのセレクトが無い' };
  for (let i = 0; i < 200 && sel.options.length < 2; i++) await wait(100);
  const options = [...sel.options].map(o => o.value);
  if (options.length < 2) {
    return { error: '選択肢が2本出ない（2本登録して起動している）: ' + JSON.stringify(options) };
  }
  // hidden 属性が作者スタイルに負けていないか（押せるのに見えない/見えるのに押せない）
  const visible = !sel.hidden && sel.offsetParent !== null;
  const before = head();
  // 🚨 **change を撃つ。** value の代入だけでは切り替えが走らない
  sel.value = options[1];
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  let after = before;
  for (let i = 0; i < 200; i++) {
    after = head();
    if (after !== before && after.indexOf(options[1]) !== -1) break;
    await wait(100);
  }
  // 自動更新（= 再読込。同じ load() を通る）でセレクトが作り直されないこと
  const optEl = sel.options[1];
  document.getElementById('refresh').click();
  await wait(3000);
  const result = {
    visible,
    options,
    switchedTo: after,
    reused: sel.options[1] === optEl,
    count: sel.options.length,
    selectedAfter: sel.value,
    headerAfter: head(),
  };
  // ⚠️ 既定に戻す（後続の検査のため）。戻ったことを確かめてから返す
  sel.value = options[0];
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  for (let i = 0; i < 200; i++) {
    if (head().indexOf(options[0]) !== -1) break;
    await wait(100);
  }
  result.restored = head().indexOf(options[0]) !== -1;
  return result;
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
  // 🚨 **「切替の瞬間に溜まっている行」を決定的に作る。**
  //    flush を保留してから 1.2 秒待つ（仕込みは 700ms ごとに tick を出す）。
  //    こうすると、切替の時点で**必ず**古い購読の行が溜まっている。
  //    以前はここを rAF の順序任せにしていたので、macOS だけで再現し
  //    **linux では門を外しても緑**だった（SURVIVED）。
  window.__kjpHoldFlush = true;
  await wait(1200);
  const heldBefore = (window.__kjpHeldFlushes ?? []).length;
  again[0].click();
  await wait(300);
  const released = typeof window.__kjpReleaseFlush === 'function'
    ? window.__kjpReleaseFlush() : -1;
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
    // 保留していた flush が実際にあったか（無ければ何も測れていない）。
    // ⚠️ ここはテンプレートリテラルの中。バックティックは書けない。
    //    second は解放**後**の端末なので、古い行が漏れれば both になる
    heldBefore, released,
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
 * 🚨 **走っているコンソールをドラッグで壊さないことを実挙動で測る。**
 *
 * ペインを動かすのは `appendChild`（作り直しではない）なので購読は切れない —
 * という**主張をコメントに書いても回帰は防げない**。実際に出力が出続けている
 * コンソールを列をまたいで動かし、**そのあとも出力が増えること**を見る。
 * 併せて、ドラッグ直後の click でペインが畳まれないことも見る
 * （合成 pointerup では click が生成されないので、ブラウザと同じ順で自分で撃つ）。
 * ⚠️ ここはテンプレートリテラルの中。**バックティックを書かない。**
 */
/**
 * 🚨 **更新でスクロール位置を失わないこと（#46）。**
 *
 * 過去の出力を読んでいる最中に位置が先頭へ戻ると、**長い出力を読めない**
 * （並列でエージェントを回して結果を追うためのツールなので致命的）。
 * さらに `scrollTop` が 0 に戻ると `scroll` イベントで追従が切れ、
 * 以降の出力が自動で追いかけられなくなる。
 *
 * ⚠️ **測る対象は「更新の経路」全部。** 手で押す更新（#refresh）と、
 *    ペインの増減（applyLayout が走る経路）の両方で測る。
 */
const SCROLL_CHECK = `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const paneOf = () => [...document.querySelectorAll('[data-pane-id]')]
    .find(e => e.dataset.paneId.startsWith('console-'));
  const pane = paneOf();
  if (!pane) return { error: 'コンソールのペインが無い' };
  const sc = pane.querySelector('.term')?.parentElement;
  if (!sc) return { error: '端末のスクロール要素が無い' };
  if (sc.scrollHeight <= sc.clientHeight + 10) {
    return { error: 'スクロールできる高さが無い（出力が足りない）: ' + sc.scrollHeight };
  }
  // 真ん中あたりまで戻して「過去を読んでいる」状態を作る
  sc.scrollTop = Math.floor(sc.scrollHeight / 3);
  await wait(200);
  const before = sc.scrollTop;
  // 1. 手で押す更新
  const cardsWas = document.querySelector('.cards');
  document.getElementById('refresh').click();
  for (let i = 0; i < 100; i++) {
    const now = document.querySelector('.cards');
    if (now && now !== cardsWas) break;
    await wait(100);
  }
  await wait(300);
  const afterRefresh = sc.scrollTop;
  // 2. ペインの増減（applyLayout が走る経路）。レイアウトを既定に戻すボタンで
  //    置き直しを起こす（並べ替えの経路そのもの）
  let afterLayout = afterRefresh;
  const reset = document.getElementById('reset');
  if (reset) {
    sc.scrollTop = Math.floor(sc.scrollHeight / 3);
    await wait(150);
    reset.click();
    await wait(400);
    afterLayout = sc.scrollTop;
  }
  return {
    before, afterRefresh, afterLayout,
    height: sc.scrollHeight, view: sc.clientHeight,
    sameEl: sc === (paneOf()?.querySelector('.term')?.parentElement),
  };
})()`;
/**
 * 🚨 **閉じたら閉じたままで、開き直せること（#57）。**
 *
 * 記憶が無いと 15 秒ごとの更新で戻ってくる（閉じる操作の意味が消える）。
 * 開き直す口が無いと「閉じたら二度と出せない」= 閉じるのが危険な操作になる。
 * ⚠️ **実行は止まらない**（#17）ことは監視盤側で見る。ここは表示だけ。
 */
const CLOSE_CHECK = `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const paneOf = id => document.querySelector('[data-pane-id=' + JSON.stringify(id) + ']');
  // 閉じる対象はグラフ（走っている実行に影響しない = 検査の副作用が小さい）
  const target = 'graph';
  if (!paneOf(target)) return { error: 'グラフのペインが無い' };
  const btn = [...paneOf(target).querySelectorAll('header > button')]
    .find(b => b.textContent === '×');
  if (!btn) return { error: '閉じるボタンが無い' };
  btn.click();
  await wait(300);
  const goneNow = !paneOf(target);
  // 更新しても戻ってこないこと（記憶が効いている）
  document.getElementById('refresh').click();
  await wait(2500);
  const goneAfterRefresh = !paneOf(target);
  // 開き直す口が出ていること
  const box = document.getElementById('closed');
  const listed = Boolean(box) && !box.hidden && /グラフ/.test(box.textContent || '');
  const openBtn = box ? [...box.querySelectorAll('button')][0] : null;
  let backAfterOpen = false;
  if (openBtn) {
    openBtn.click();
    for (let i = 0; i < 60 && !backAfterOpen; i++) {
      await wait(200);
      backAfterOpen = Boolean(paneOf(target));
    }
  }
  return {
    goneNow, goneAfterRefresh, listed, backAfterOpen,
    hasBox: Boolean(box), boxHidden: box ? box.hidden : null,
    closedIds: typeof window.__kjpClosed === 'function' ? window.__kjpClosed() : 'hook なし',
    btnCount: box ? box.querySelectorAll('button').length : -1,
    boxText: (box?.textContent || '').slice(0, 80),
  };
})()`;
const DRAG_LIVE_CHECK = `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const cin = [...document.querySelectorAll('.cmdbar input')].find(e =>
    e.closest('[data-pane-id]')?.dataset.paneId !== 'monitor' && !e.placeholder);
  if (!cin) return { error: 'コンソールの入力欄が見つからない' };
  // 走っている間は入力欄が disabled で Enter が効かない（前の検査の実行を待つ）
  for (let i = 0; i < 400 && cin.disabled; i++) await wait(100);
  if (cin.disabled) return { error: 'コンソールが空かない（前の実行が終わらない）' };
  const pane = cin.closest('[data-pane-id]');
  const paneId = pane.dataset.paneId;
  const term = pane.querySelector('.term');
  if (!term) return { error: 'コンソールの端末が無い' };
  const fromHost = pane.parentElement?.id ?? '(親が無い)';
  // 出力が少しずつ出続けるコマンド。**移動の後に増えたか**で購読の生死を測る
  cin.value = 'node -e "let i=0;const t=setInterval(()=>{console.log(String(++i));if(i>=80)clearInterval(t)},100)"';
  cin.dispatchEvent(new Event('input', { bubbles: true }));
  cin.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  let len0 = 0;
  for (let i = 0; i < 200 && len0 === 0; i++) {
    len0 = term.textContent.length;
    if (len0 === 0) await wait(100);
  }
  if (len0 === 0) return { error: '実行が始まらない（購読の生死を測れない）' };
  const fire = (t, type, x, y) => t.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true,
    pointerId: 1, pointerType: 'mouse', isPrimary: true,
    button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y,
  }));
  const hd = pane.querySelector('header');
  const from = hd.getBoundingClientRect();
  // ⚠️ 落とす先の座標は入れ物の矩形から取る（ペインの矩形は途中で動く）
  const aim = () => document.getElementById('left').getBoundingClientRect();
  fire(hd, 'pointerdown', from.left + 8, from.top + 3);
  fire(hd, 'pointermove', from.left + 8, from.top + 30);
  fire(hd, 'pointermove', aim().left + 8, aim().top + 1);
  fire(hd, 'pointerup', aim().left + 8, aim().top + 1);
  // ブラウザは pointerup のあとに click を出す。畳まれてはいけない
  fire(hd, 'click', aim().left + 8, aim().top + 1);
  const movedTo = pane.parentElement?.id ?? '(親が無い)';
  const minimized = pane.classList.contains('min');
  const lenMoved = term.textContent.length;
  let lenAfter = lenMoved;
  for (let i = 0; i < 100 && lenAfter <= lenMoved; i++) {
    await wait(100);
    lenAfter = term.textContent.length;
  }
  const stopBtn = [...pane.querySelectorAll('.cmdbar button')]
    .find(b => b.textContent === '停止' && !b.disabled);
  if (stopBtn) stopBtn.click();
  // ⚠️ id に Windows のパスが入るので属性セレクタで数えない（\\ の扱いで壊れる）
  const dupes = [...document.querySelectorAll('.pane')]
    .filter(e => e.dataset.paneId === paneId).length;
  const out = {
    fromHost, movedTo, minimized, dupes,
    sameTerm: pane.querySelector('.term') === term,
    grew: lenAfter > lenMoved,
    lenMoved, lenAfter,
    stopped: Boolean(stopBtn),
  };
  // 後続の計測が同じ形の画面を見るように、並びを既定へ戻す
  document.getElementById('reset').click();
  await wait(300);
  out.resetHost = pane.parentElement?.id ?? '(親が無い)';
  return out;
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

/**
 * 🚨 **編集器（最小エディタ）を実ブラウザで測る。**
 *
 * 測るのは3つ。どれも**字面では測れない**:
 *
 * 1. **自動更新で編集中の textarea を作り直さない。** 差分ペインの中身は毎回
 *    `replaceChildren` で作り直しているので、`obj.editing` の守りを外すと
 *    **打っている途中の内容が消える**（監視盤の行と同じ型の事故）。
 *    要素の同一性・値・**同じ textarea が増えていないこと**を一緒に見る
 *    （作り直す変異は古い要素を DOM に残すので、同一性だけでは見抜けない）。
 * 2. **保存する前に差分が見える。** 「何が変わるか分からないまま書かない」が
 *    この機能の前提条件。
 * 3. **保存が実際に作業ツリーへ届く**（呼び出し側がファイルを読んで確かめる）。
 *
 * ⚠️ `ta.value = …` の後に `input` イベントを撃つ（値の代入だけでは
 *    リスナが走らない。監視盤の検査でこれを踏んだ）。
 */
const EDITOR_CHECK = `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let btn = null;
  for (let i = 0; i < 300 && !btn; i++) {
    btn = [...document.querySelectorAll('.tabs button')].find(b => b.textContent === '編集');
    if (!btn) await wait(100);
  }
  if (!btn) {
    return { error: '編集ボタンが描かれていない（--allow-write / トークン / 差分のあるファイルを確認）' };
  }
  btn.click();
  const tasOf = () => [...document.querySelectorAll('textarea.edit')];
  let ta = null;
  for (let i = 0; i < 300; i++) {
    ta = tasOf()[0] ?? null;
    if (ta && ta.value && !ta.disabled) break;
    await wait(100);
  }
  if (!ta || !ta.value) {
    return { error: '編集器に中身が出ない: ' + (document.querySelector('.editmsg')?.textContent ?? '(告知なし)') };
  }
  const loaded = ta.value;
  const MARK = 'EDITED-BY-RENDER-CHECK-42';
  ta.value = loaded + MARK + String.fromCharCode(10);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  // 自動更新（再読込）が来ても、打っている途中の内容が消えてはいけない
  document.getElementById('refresh').click();
  await wait(3000);
  const after = tasOf();
  // 保存前に差分を見せる
  const dbtn = [...document.querySelectorAll('button')].find(b => b.textContent === '差分を見る');
  if (dbtn) dbtn.click();
  await wait(400);
  const diffText = document.querySelector('.editdiff')?.textContent ?? '';
  // 保存
  const sbtn = [...document.querySelectorAll('button')].find(b => b.textContent === '保存');
  if (!sbtn) return { error: '保存ボタンが無い' };
  sbtn.click();
  let saved = '';
  for (let i = 0; i < 300; i++) {
    saved = document.querySelector('.editmsg')?.textContent ?? '';
    if (/保存しました|✖/.test(saved)) break;
    await wait(100);
  }
  return {
    loaded,
    mark: MARK,
    want: loaded + MARK + String.fromCharCode(10),
    kept: after[0] ? after[0].value : null,
    reused: Boolean(after[0]) && after[0] === ta,
    count: after.length,
    diffText: diffText.slice(0, 400),
    saved,
  };
})()`;

/**
 * 🚨 **読み取り用の鍵しか無いタブで「編集」を出さないこと。**
 *
 * 案内の URL に載るのは読み取り専用の派生秘密なので、`session.token` の有無で
 * 判定すると**読み取り用の鍵でも真**になり、押しても必ず 403 の「編集」を出す
 * （このリポジトリが BLOCKING として扱ってきた「有効に見えて動かない」形）。
 * 判定は `session.canMutate`（= 生の鍵を提示したか）でなければならない。
 *
 * ⚠️ **字面では測れない。** `canMutate` を `token` に戻しても行は残る。
 * ⚠️ `READKEY_CHECK` と同じ「鍵を捨てて読み込み直した」状態で測る（前段が要る）。
 */
const EDITOR_READKEY_CHECK = `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const drawn = e => e.getClientRects().length > 0;
  const panesOf = () => [...document.querySelectorAll('[data-pane-id]')]
    .filter(p => p.dataset.paneId.startsWith('diff-'));
  let note = '', tabs = 0;
  for (let i = 0; i < 100; i++) {
    const ps = panesOf();
    tabs = ps.reduce((n, p) => n + [...p.querySelectorAll('.tabs button')].filter(drawn).length, 0);
    note = ps.flatMap(p => [...p.querySelectorAll('.note')]).filter(drawn)
      .map(e => e.textContent ?? '').join(' | ');
    if (tabs > 0 && note) break;
    await wait(200);
  }
  return {
    // 🚨 前提の確認: このタブが**鍵を持っている**こと（持っていないなら
    //    「token の有無で判定する」退行を再現できない = 何も測れていない）
    heldToken: (() => { try { return sessionStorage.getItem('kjp_token'); } catch { return null; } })(),
    // 🚨 測る対象が描かれていること自体を確かめる（差分ペインとタブが無いなら空振り）
    panes: panesOf().length,
    tabs,
    hasEditButton: panesOf().some(p => [...p.querySelectorAll('.tabs button')]
      .filter(drawn).some(b => b.textContent === '編集')),
    said: /鍵/.test(note),
    sample: note.replace(/\\s+/g, ' ').slice(0, 200),
  };
})()`;

/**
 * 🚨 **全文ビューアを実ブラウザで測る。** 測るのは4つ、どれも字面では測れない:
 *
 * 1. **ファイラから押すと全文が出る**（差分ではなく中身が、行番号付きで）
 * 2. **表示上限で切ったことが、実際に見える文字として出る**
 *    （`dataset` のフラグを見るだけの検査は禁止。告知の要素を作らなくても通る）
 * 3. **自動更新（15秒 / 再読込ボタン）で差分に戻らない** —
 *    ペインの中身は作り直されるので、モードを持っていないと**読んでいる途中で
 *    差分に戻る**。字面では完全に見えない
 * 4. **描画の予算**（1行ごとに DOM へ足してレイアウトを起こすと二次になる。
 *    同じ環境の実測で 4000 行 = 59 秒）
 */
const BLOB_CHECK = `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  // 🚨 **long.txt を持つペインを名指しで選ぶ。** 編集器の検査用に
  //    コミット済み差分のある worktree が2本になったので、素朴に最初の差分ペインを
  //    掴むと**別のペインで「全文」を押して、ファイラのクリックは long.txt の
  //    ペインへ行く**（= 何も測らずに rows 0 で落ちる）。対象で選ぶ。
  let target = null;
  for (let i = 0; i < 400 && !target; i++) {
    target = [...document.querySelectorAll('[data-pane-id^="diff-"]')]
      .find(p => [...p.querySelectorAll('.tabs button')]
        .some(b => (b.title ?? '').endsWith('long.txt'))) ?? null;
    if (!target) await wait(100);
  }
  if (!target) return { error: 'long.txt のタブを持つ差分ペインが無い（検査の前提が崩れている）' };
  const paneId = target.dataset.paneId;
  const bar = target.querySelector('.viewbar');
  if (!bar) return { error: '差分ペインに表示の切り替え（.viewbar）が無い' };
  const paneOf = () => document.querySelector('[data-pane-id="' + paneId + '"]');
  const btnOf = label => [...(paneOf()?.querySelectorAll('.viewbar button') ?? [])]
    .find(b => b.textContent === label) ?? null;
  const full = btnOf('全文');
  if (!full) return { error: '「全文」ボタンが無い' };
  full.click();
  // 🚨 **ファイラから**押す（差分ペインのタブではなく、ファイラ経由で開けること）
  const f = [...document.querySelectorAll('.tree .f')]
    .find(e => (e.title ?? '').includes('long.txt'));
  if (!f) return { error: 'ファイラに long.txt が無い（検査の前提が崩れている）' };
  f.click();
  let rows = 0;
  for (let i = 0; i < 400; i++) {
    rows = paneOf()?.querySelectorAll('.blob .bl').length ?? 0;
    if (rows > 0) break;
    await wait(100);
  }
  const pane = paneOf();
  // ⚠️ **実際に見える文字**を読む（hidden でも textContent は残るので描かれているものだけ）
  const notice = [...(pane?.querySelectorAll('.note') ?? [])]
    .filter(e => e.getClientRects().length > 0)
    .map(e => e.textContent ?? '').find(t => t.includes('行だけ表示')) ?? null;
  const nums = [...(pane?.querySelectorAll('.blob .bl .ln') ?? [])].map(e => e.textContent);
  const firstLineText = pane?.querySelector('.blob .bl .lx')?.textContent ?? null;
  const stillDiff = (pane?.querySelectorAll('.diff div').length ?? 0) > 0;
  // 3. 自動更新で差分に戻らないこと（再読込ボタンは load() → render() と同じ経路）
  document.getElementById('refresh').click();
  await wait(3500);
  let afterRows = 0;
  for (let i = 0; i < 100; i++) {
    afterRows = paneOf()?.querySelectorAll('.blob .bl').length ?? 0;
    if (afterRows > 0) break;
    await wait(100);
  }
  const afterDiff = (paneOf()?.querySelectorAll('.diff div').length ?? 0) > 0;
  // 4. 予算。**UI と同じ renderBlob を通す入口**で測る（3回の中央値）
  if (typeof window.__kjpRenderBlob !== 'function') {
    return { error: '描画予算の入口（__kjpRenderBlob）が無い' };
  }
  const shots = [];
  for (let k = 0; k < 3; k++) {
    shots.push(window.__kjpRenderBlob(${MAX_VIEW_LINES}));
    // 🚨 **1回目で予算を超えたら繰り返さない。** 毎行レイアウトを起こす変異は
    //    1回で約 59 秒かかるので、3回測ると検査自体が上限に達して
    //    HUNG（= 落ちない検査）になり、変異が「守りを検証できていない」扱いになる。
    //    超えた事実は1回で分かるので、そこで止めて失敗として返す。
    if (shots[shots.length - 1].ms > ${BUDGET_BLOB_MS}) break;
    await new Promise(r => requestAnimationFrame(r));
  }
  const ms = shots.map(s => s.ms).sort((a, b) => a - b);
  return {
    rows, notice, stillDiff, firstLineText,
    firstNum: nums[0] ?? null, lastNum: nums[nums.length - 1] ?? null,
    afterRows, afterDiff,
    // 打ち切ったときは1件しか無いので、真ん中を取る（3件なら中央値）
    budgetMs: ms[Math.floor(ms.length / 2)], budgetAll: ms,
    budgetRows: shots[0].rows, connected: shots[0].connected,
    maxViewLines: shots[0].maxViewLines,
    paneId, budgetPaneId: shots[0].paneId,
  };
})()`;

const repo = await mkdtemp(join(tmpdir(), 'kjp-render-'));
// 🚨 リポジトリの切り替えを測るには**2本登録する**必要がある
//    （1本だとセレクトは出ない = 測る対象が描かれない。
//     「capability を切ると描かれない UI は、検査でも描かれない」と同型）
const repo2 = await mkdtemp(join(tmpdir(), 'kjp-render2-'));
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

    // 🚨 **編集器を測るには「コミット済み差分のあるファイル」が1本必要。**
    //    編集の入口は差分ペインのタブなので、差分が無いと**ボタンが描かれず、
    //    何も測らないまま緑になる**（layout-check がコマンドバーを
    //    「測っている」と嘘をついていたのと同じ形）。
    const edWt = join(repo, '..', `${repo.split(/[\\/]/).pop()}-ed`);
    await g(['worktree', 'add', '-q', '-b', 'editable', edWt], repo);
    const edFile = join(edWt, 'edit-me.txt');
    await writeFile(edFile, 'one\ntwo\nthree\n', 'utf8');
    await g(['add', '-A'], edWt);
    await g(['commit', '-q', '-m', 'edit target'], edWt);
    // 切り替え先のリポジトリ（中身は最小限。ここでは「切り替わること」だけを測る）
    await g(['init', '-q', '-b', 'main'], repo2);
    await g(['config', 'user.email', 'a@b'], repo2);
    await g(['config', 'user.name', 'a'], repo2);
    await writeFile(join(repo2, 'g.txt'), 'y\n', 'utf8');
    await g(['add', '-A'], repo2);
    await g(['commit', '-q', '-m', 'seed2'], repo2);

    // 全文ビューアの検査用: **表示上限を超える行数のファイルを1つコミットする。**
    // これが無いと「切ったことを告知する」を測れない（切る対象が無いので緑になる）。
    // ⚠️ ファイラから開くので、コミット済み差分として出る worktree に置く。
    const longWt = join(repo, '..', `${repo.split(/[\\/]/).pop()}-long`);
    await g(['worktree', 'add', '-q', '-b', 'long-file', longWt], repo);
    await writeFile(join(longWt, 'long.txt'),
        `${Array.from({ length: BLOB_FILE_LINES }, (_, i) => `line ${i}`).join('\n')}\n`, 'utf8');
    await g(['add', '-A'], longWt);
    await g(['commit', '-q', '-m', 'long file'], longWt);

    // 実行を有効にしないとコンソールペインが描かれない = 計測対象が出ない
    server = spawn(process.execPath,
        // ⚠️ **2本登録する。** 1本だとリポジトリのセレクトが描かれないので
        //    切り替えの検査が「何も測っていない」状態になる（下の --require-auth と
        //    同じ「マージで消えやすい引数」なので理由をここに書く）。
        [SERVER, '--repo', repo, '--repo', repo2, '--port', '0',
            // 🚨 **`--require-auth` を付ける（8回目のレビュー。SERIOUS）。**
            //    これは `--allow-host` = トンネル = スマホから使う既定の構成であり、
            //    サーバが `/api/v0/state` の `execSessions` を「生の鍵を提示していない
            //    要求」には返さない構成でもある。ブラウザ検査はこの構成を**1度も
            //    踏んでいなかった**ので、`load()` がヘッダを付けずに一覧を取り落とし、
            //    **一番使う経路で再接続口が黙って消えている**ことに誰も気付けなかった。
            //    ⚠️ 統合のときにこの1語を落として、検査が「何も測っていない」状態に
            //       戻りかけた（マージで消えやすい1語なので理由をここに書く）。
            '--require-auth',
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
    /**
     * 🚨 **切替で前の購読が本当に切れたかは、サーバ側の購読者数で測る。**
     *
     * 画面の「混ざらない」だけでは足りない: 書き込みの出口を閉じた（`isCurrent`）ので、
     * **abort を外しても画面は混ざらなくなった**（変異が SURVIVED した）。
     * 切らないと fetch が開いたままでサーバは購読者が居ると見なし、
     * `lastDetachedAt` が立たないので**切断後の猶予が始まらない**（取り残しになる）。
     * ここが abort の本体なので、ここを測る。
     */
    let subs = null;
    if (sideA && sideB && dual && !dual.error) {
        try {
            const body = await (await fetch(`${base}/api/v0/exec/list`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-kjp-token': TOKEN },
            })).json();
            const byId = new Map((body.sessions ?? []).map(s => [s.id, s.subscribers]));
            // dual.second は今見ている側（'AAA' か 'BBB'）
            const shown = dual.second === 'AAA' ? sideA : sideB;
            const other = dual.second === 'AAA' ? sideB : sideA;
            subs = { shown: byId.get(shown) ?? null, other: byId.get(other) ?? null };
        } catch (e) {
            subs = { error: e.message };
        }
    }
    for (const id of [sideA, sideB]) {
        if (!id) continue;
        await fetch(`${base}/api/v0/exec/${id}/kill`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': TOKEN },
        }).catch(() => {});
    }
    // 🚨 **全文ビューアは編集器より前に置く。**
    //    `EDITOR_CHECK` は「閉じる」を押さないので、終わったあとも `obj.editing` が
    //    真のまま残る。`openEditor` は **`obj.body` ごと**置き換えるので、
    //    そのペインからは **`.viewbar` が DOM から消える**。
    //
    //    ⚠️ **今は後ろに置いても通る。それは偶然なので前に置く。** 実測した:
    //       編集器は最初に見つけた「編集」ボタン（= `editable` の worktree の
    //       ペイン）を押すので、`long.txt` のペインは無傷のまま残る。だから
    //       順序を入れ替えても両方緑になった（`✔ render` を確認済み）。
    //       依存しているのは「2枚あるうちのどちらを先に掴むか」という**偶然**で、
    //       `MAX_DIFF_PANES` が 1 になる / worktree 名の並びが変わるだけで壊れる。
    //       壊れたときは「表示の切り替えが無い」という**別の原因に見える**失敗になる。
    //    ⚠️ 描画の計測（12,000行）より前でもあること
    //       （DOM が重くなると「開いたら出る」の待ち時間の意味が変わる）。
    //    ⚠️ 鍵を捨てて読み込み直す `READKEY_CHECK` より前でもあること
    //       （あれの後だと `?probe=1` の入口ごと作り直された状態を測る）。
    const blob = await evaluate(BLOB_CHECK);

    // 🚨 編集器は**描画の計測より前**（12,000行流した後だと自動更新が重くなり、
    //    「作り直されたか」を待つ時間の意味が変わる）
    const editor = await evaluate(EDITOR_CHECK);
    // 保存が**実際に作業ツリーへ届いた**ことは、ブラウザではなくここで確かめる
    const onDisk = await readFile(edFile, 'utf8').catch(e => `(読めない: ${e.message})`);

    // 🚨 ドラッグの検査は**描画の計測より前**（12,000行流した後だと端末の
    //    文字量が動き続けて「移動の後に増えたか」を測れない）。
    //    心拍の検査の後に置く（あれが走らせたセッションが終わるのを待つ形になる）。
    const dragLive = await evaluate(DRAG_LIVE_CHECK);

    // 🚨 閉じる検査は**他の検査より後**（ペインを消すので前に置くと他が測れない）
    const closing = await evaluate(CLOSE_CHECK);
    const probeValue = await evaluate(MEASURE);
    const probe = probeValue;
    // 🚨 #46: 更新でスクロール位置が飛ばないこと（MEASURE の後 = 端末に十分な高さがある）
    const scroll = await evaluate(SCROLL_CHECK);
    if (!probe) throw new Error('計測結果が取れない（評価が値を返さなかった）');
    if (probe.error) throw new Error(probe.error);

    /* 🚨 **リポジトリの切り替えは MEASURE より後、鍵を捨てる検査より前。**
     *
     * 後ろに置けない理由: `window.__kjpFeedTerm` は**最初に作られたコンソール
     * ペイン**の writer に一度だけ束縛される（`!window.__kjpFeedTerm` の番人がある）。
     * リポジトリを切り替えるとペインは worktree の path が変わるので作り直され、
     * `__kjpFeedTerm` は**DOM から外れた古い端末**を指したままになる。
     * その状態で MEASURE を走らせると、**流し込む先と測る先が別の要素**になり
     * 「12,000行を 982ms・残り12要素」という**意味の無い数字**が出る
     * （実際にこの順序で踏んだ。告知の検査が落ちて気付けた）。
     *
     * 前に置けない理由: 下の READKEY_CHECK は**鍵を捨てて読み込み直す**ので、
     * その後では `?repo=` を投げても 401 になり切り替えを測れない。
     */
    const reposel = await evaluate(REPOSEL_CHECK);

    // 🚨 **最後に「読み取り用の鍵だけ」の状態を作って測る。**
    //    鍵を捨てて読み込み直すと、Cookie（読み取り専用の派生秘密）だけが残る =
    //    スマホが案内の URL を1回開いた状態。ここで走っているセッションの一覧が
    //    「出せません」と言われることを確かめる（黙って空にしない）。
    //    ⚠️ 他の検査の前提（鍵を持っている）を壊すので、必ずこの位置。
    //    ⚠️ この前段（鍵を捨てて読み込み直す）を接ぎ忘れて、統合直後に
    //       「鍵を捨てられていない = 何も測っていない」で落ちた。**手順ごと接ぐ。**
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

    /**
     * 🚨 **「読み取り用の鍵を持っている」状態を作ってから、編集の入口を測る。**
     *
     * 上の READKEY の前段は鍵を**捨てる**ので `session.token === null` になり、
     * 「`canMutate` の代わりに `token` の有無で判定する」退行を**再現できない**
     * （最初そう書いて、変異 `editor-key-gate` が SURVIVED した。
     *  「何も測っていないのに緑」の実例をここで1つ作っていた）。
     * 案内の URL に載る**読み取り専用の派生秘密**を sessionStorage に入れて
     * 読み込み直す = スマホが案内の URL を1回開いた状態。この状態では
     * `session.token` は**非 null** で `presented === 'read'` になる。
     */
    const readSecret = /\?token=([A-Za-z0-9._~-]+)/.exec(banner)?.[1] ?? null;
    let editorReadKey = { error: '案内の URL から読み取り用の鍵を取れなかった' };
    if (readSecret === TOKEN) {
        // ⚠️ 一致していたらこの検査は何も測れない（その事実は smoke 側が落とす）
        editorReadKey = { error: '案内の URL に生の鍵が載っているので、読み取り鍵の状態を作れない' };
    } else if (readSecret !== null) {
        await evaluate(`(() => {
          try { sessionStorage.setItem('kjp_token', ${JSON.stringify(readSecret)}); }
          catch (e) { /* 使えない環境 */ }
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
        editorReadKey = await evaluate(EDITOR_READKEY_CHECK);
        // 🚨 前提が成立したことを確かめる（鍵が入っていないなら測れていない）
        if (editorReadKey && !editorReadKey.error && editorReadKey.heldToken !== readSecret) {
            editorReadKey = {
                error: '読み取り用の鍵をタブに入れられなかった'
                    + `（held=${JSON.stringify(editorReadKey.heldToken)}）`,
            };
        }
    }
    if (probe.error) throw new Error(probe.error);

    const problems = [];
    // 🔒 リポジトリの切り替え（#複数リポジトリ）
    if (!reposel || reposel.error) {
        problems.push(`リポジトリの切り替えを測れなかった: ${reposel?.error ?? '結果が取れない'}`);
    } else {
        if (!reposel.visible) {
            problems.push('2本登録しているのにリポジトリのセレクトが描かれていない'
                + '（切り替える手段が無い）');
        }
        if (reposel.switchedTo.indexOf(reposel.options[1]) === -1) {
            problems.push('セレクトを切り替えても state を取り直していない'
                + `（画面が別のリポジトリのまま）: ${reposel.switchedTo.slice(0, 160)}`);
        }
        // 🚨 作り直しは**同一性・件数・選択値**の3つで見る
        if (!reposel.reused) {
            problems.push('自動更新でリポジトリのセレクトを作り直している'
                + '（選択が既定に戻り、見ている画面と操作の対象がずれる）');
        }
        if (reposel.count !== reposel.options.length) {
            problems.push('自動更新でセレクトの選択肢が増減している'
                + `: ${reposel.count} ≠ ${reposel.options.length}`);
        }
        if (reposel.selectedAfter !== reposel.options[1]) {
            problems.push('自動更新で選択が既定に戻った'
                + `: ${reposel.selectedAfter} ≠ ${reposel.options[1]}`);
        }
        if (reposel.headerAfter.indexOf(reposel.options[1]) === -1) {
            problems.push('自動更新で表示が既定のリポジトリに戻った'
                + `（セレクトと中身が食い違う）: ${reposel.headerAfter.slice(0, 160)}`);
        }
        // ⚠️ 戻し損ねていたら後続の検査の前提が崩れている。黙って通さない
        if (!reposel.restored) {
            problems.push('既定のリポジトリに戻せなかった'
                + '（この後の検査が別のリポジトリを相手にしている）');
        }
    }
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
        if (!monitor.tickedWithoutClick) {
            problems.push('監視盤が周期更新で動いていない'
                + `（click 無しで経過が進まない。ageBefore=${monitor.ageBefore}）。`
                + 'timers=0 の分岐が実運用にも効いていないか確認すること');
        }
        if (!monitor.idTagShown) {
            problems.push('監視盤の行にセッションを見分ける印（#id）が出ていない'
                + `（同名 worktree で入力先を間違える。#50）: ${monitor.sample}`);
        }
        if (!monitor.placeholderHasId) {
            problems.push('入力欄が送信先の id を出していない（打つ直前に確認できない）');
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
    // 🚨 #46: スクロール位置を失うと長い出力が読めない（追従も切れる）
    if (!scroll || scroll.error) {
        problems.push(`スクロール位置を測れなかった: ${scroll?.error ?? '結果が取れない'}`);
    } else {
        const keep = (name, got) => {
            // 完全一致は求めない（更新で高さが変わる）。**先頭に飛んでいない**ことを見る
            if (got >= scroll.before - 40) return;
            problems.push(`${name} でスクロール位置が飛んだ（#46）: `
                + `${scroll.before} → ${got}（高さ ${scroll.height} / 表示 ${scroll.view}）`);
        };
        keep('更新（#refresh）', scroll.afterRefresh);
        keep('置き直し（レイアウト）', scroll.afterLayout);
        if (!scroll.sameEl) {
            problems.push('端末のスクロール要素が作り直された（追従も購読も切れる）');
        }
    }
    // 🚨 #57: 閉じたら閉じたまま / 開き直せる
    if (!closing || closing.error) {
        problems.push(`閉じる／開くを測れなかった: ${closing?.error ?? '結果が取れない'}`);
    } else {
        if (!closing.goneNow) problems.push('× を押してもペインが消えない（#57）');
        if (!closing.goneAfterRefresh) {
            problems.push('更新で閉じたペインが戻ってきた（#57。閉じる操作の意味が消える）');
        }
        if (!closing.listed) {
            problems.push('閉じたペインの一覧が出ていない（開き直せない）: '
                + `box=${closing.hasBox} hidden=${closing.boxHidden} `
                + `btn=${closing.btnCount} text=${JSON.stringify(closing.boxText)} `
                + `closed=${JSON.stringify(closing.closedIds)}`);
        }
        if (!closing.backAfterOpen) problems.push('一覧から開き直せない（#57）');
    }
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
        // 🚨 **「溜まっていた行を落とす」門を測れたことを確かめる。**
        //    保留が1件も無ければ、切替の瞬間に古い行が無かった = 何も測っていない。
        //    ここを見ないと、rAF の順序次第で**門を外しても緑**になる
        //    （linux の CI で SURVIVED した形。`--exec-stream-delay` と同じ理由で
        //     検査専用の保留を入れた）。
        if (!(dual.heldBefore > 0)) {
            problems.push('切替の瞬間に溜まっている行を作れていない'
                + `（保留 ${dual.heldBefore} 件）= 古い書き込みの門を測れていない`);
        }
        if (!(dual.released > 0)) {
            problems.push(`保留した flush を解放できていない（released=${dual.released}）`);
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
        // 🚨 前の購読が本当に切れたか（切れないと猶予が始まらず取り残しになる）
        if (subs && subs.error) {
            problems.push(`購読者数を測れなかった: ${subs.error}`);
        } else if (subs) {
            if (subs.other !== 0) {
                problems.push('切替で前の購読が切れていない'
                    + `（サーバは購読者 ${subs.other} と見なしている = 切断後の猶予が始まらない）`);
            }
            if (!(subs.shown >= 1)) {
                problems.push(`切り替え先を購読していない（購読者 ${subs.shown}）`);
            }
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
    // 🚨 走っているコンソールをドラッグで壊していないこと（作り直しは購読を切る）
    if (!dragLive || dragLive.error) {
        problems.push(`ドラッグ移動を測れなかった: ${dragLive?.error ?? '結果が取れない'}`);
    } else {
        if (dragLive.movedTo !== 'left') {
            problems.push('コンソールのペインが列をまたいで動かない'
                + `（${dragLive.fromHost} → ${dragLive.movedTo}）`);
        }
        if (!dragLive.grew) {
            problems.push('ペインを動かしたあと出力が増えない'
                + '（購読が切れている = 動かすと走っている実行を見失う）'
                + `: ${dragLive.lenMoved} → ${dragLive.lenAfter} 文字`);
        }
        if (!dragLive.sameTerm) {
            problems.push('ペインを動かすときに中身を作り直している'
                + '（それまでの出力が消え、購読も切れる）');
        }
        if (dragLive.dupes !== 1) {
            problems.push(`同じ id のコンソールが ${dragLive.dupes} 個ある`
                + '（動かすときに複製している）');
        }
        if (dragLive.minimized) {
            problems.push('ドラッグ直後の click でペインが畳まれた'
                + '（並べ替えるたびに中身が隠れる）');
        }
        if (dragLive.resetHost !== 'consoles') {
            problems.push('「レイアウト」で並びが既定に戻らない'
                + `（コンソールが ${dragLive.resetHost} に残っている = 直し方が無い）`);
        }
    }
    // 🚨 編集器: 「打っている途中が消えない」「保存前に差分が見える」
    //    「保存が作業ツリーに届く」を実挙動で確かめる
    if (!editor || editor.error) {
        problems.push(`編集器を測れなかった: ${editor?.error ?? '結果が取れない'}`);
    } else {
        if (!editor.reused) {
            problems.push('自動更新で編集中の textarea を作り直している'
                + `（打っている途中の内容が消える）: textarea ${editor.count} 個`);
        }
        if (editor.count !== 1) {
            problems.push('自動更新で編集器の textarea が増えている'
                + `（作り直した要素が溜まる）: ${editor.count} 個`);
        }
        if (editor.kept !== editor.want) {
            problems.push('自動更新で編集中の内容が変わった'
                + `: ${JSON.stringify(editor.kept)} ≠ ${JSON.stringify(editor.want)}`);
        }
        if (!editor.diffText.includes(editor.mark) || !editor.diffText.includes('+')) {
            problems.push('保存する前に差分が見えていない'
                + `（何が変わるか分からないまま書くことになる）: ${JSON.stringify(editor.diffText)}`);
        }
        if (!/保存しました/.test(editor.saved)) {
            problems.push(`保存できなかった: ${JSON.stringify(editor.saved)}`);
        }
        if (!onDisk.includes(editor.mark)) {
            problems.push('「保存しました」と出たのに作業ツリーに届いていない'
                + `: ${JSON.stringify(onDisk.slice(0, 120))}`);
        }
    }
    // 🚨 読み取り用の鍵だけのタブ（= 案内の URL を開いたスマホ）で
    //    「押しても必ず 403 の編集」を出していないこと
    if (!editorReadKey || editorReadKey.error) {
        problems.push(`読み取り鍵での編集の入口を測れなかった: ${editorReadKey?.error ?? '結果が取れない'}`);
    } else if (editorReadKey.tabs === 0) {
        // 測る対象が描かれていないなら「出ていない」ではなく「測れていない」
        problems.push('差分ペインのタブが1つも描かれていないので、'
            + `編集の入口を測れていない（ペイン ${editorReadKey.panes} 個）`);
    } else {
        if (editorReadKey.hasEditButton) {
            problems.push('読み取り用の鍵しか無いのに「編集」ボタンが出ている'
                + '（押すと必ず 403 = 有効に見えて動かない）');
        }
        if (!editorReadKey.said) {
            problems.push('読み取り用の鍵では編集できない理由を言っていない'
                + `（黙って消すと「機能が無い」と読まれる）: ${JSON.stringify(editorReadKey.sample)}`);
        }
    }
    // 🚨 全文ビューア
    if (!blob || blob.error) {
        problems.push(`全文ビューアを測れなかった: ${blob?.error ?? '結果が取れない'}`);
    } else {
        if (blob.maxViewLines !== MAX_VIEW_LINES) {
            problems.push('ページ側の上限と検査の上限が食い違っている'
                + `（${blob.maxViewLines} ≠ ${MAX_VIEW_LINES}）= 別のものを測っている`);
        }
        if (blob.rows !== MAX_VIEW_LINES) {
            problems.push(`ファイラから全文を開いた行数が ${blob.rows} 行`
                + `（上限 ${MAX_VIEW_LINES} 行で切られていない / そもそも出ていない）`);
        }
        if (blob.stillDiff) {
            problems.push('「全文」を選んだのに差分がまだ描かれている（切り替わっていない）');
        }
        // 行番号が無いと「何行目か」が分からない = ビューアとして用を成さない
        if (blob.firstNum !== '1' || blob.lastNum !== String(MAX_VIEW_LINES)) {
            problems.push('行番号が 1..上限 になっていない'
                + `: 先頭 ${JSON.stringify(blob.firstNum)} / 末尾 ${JSON.stringify(blob.lastNum)}`);
        }
        // **差分ではなく中身**が出ていること（差分なら先頭に + が付く）
        if (blob.firstLineText !== 'line 0') {
            problems.push('全文の1行目が中身になっていない（差分を出している？）'
                + `: ${JSON.stringify(blob.firstLineText)}`);
        }
        // 🚨 **見える文字**で告知を確かめる（フラグではなく）
        if (!blob.notice) {
            problems.push('上限で切ったのに告知が見えない（「全部見えている」と誤認させる）');
        } else if (!new RegExp(`先頭 ${MAX_VIEW_LINES} 行`).test(blob.notice)
            || !new RegExp(`全 ${BLOB_FILE_LINES} 行`).test(blob.notice)) {
            problems.push(`告知に「どこまで / 全体で何行」が入っていない: ${blob.notice}`);
        }
        // 自動更新でモードが戻ると、読んでいる途中で差分に化ける
        if (blob.afterRows === 0 || blob.afterDiff) {
            problems.push('自動更新（再読込）で全文が差分に戻った'
                + `（読んでいる途中で中身が入れ替わる）: 行 ${blob.afterRows} / 差分 ${blob.afterDiff}`);
        }
        // 予算。**DOM から外れた要素を測っていないことも確かめる**
        //（外れていると offsetHeight がレイアウトを起こさず「速い」という嘘が出る）
        if (!blob.connected) {
            problems.push('描画予算の計測対象が DOM から外れている（測った時間に意味が無い）');
        }
        if (blob.budgetRows !== MAX_VIEW_LINES) {
            problems.push(`予算の計測が ${blob.budgetRows} 行しか描いていない（上限は ${MAX_VIEW_LINES}）`);
        }
        if (blob.budgetMs > BUDGET_BLOB_MS) {
            problems.push(`全文 ${MAX_VIEW_LINES} 行の描画 ${blob.budgetMs}ms > 予算 ${BUDGET_BLOB_MS}ms`
                + `（1行ごとにレイアウトを起こしていると二次になる）: ${JSON.stringify(blob.budgetAll)}`);
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
    // 🚨 **測った値を出す。** 「0 文字 → 0 文字」で緑になっていないかを目で見る
    console.log(`   ドラッグ: ${dragLive?.fromHost} → ${dragLive?.movedTo}`
        + ` / 移動後の出力 ${dragLive?.lenMoved} → ${dragLive?.lenAfter} 文字`
        + ` / 戻し先 ${dragLive?.resetHost}`);
    // 🚨 **測った対象を必ず出す。** 「編集器を測っている」が嘘になっていないかは
    //    件数と結果の文言で分かる形にする（layout-check の教訓）。
    console.log(`   編集器: textarea ${editor?.count ?? '(測れず)'} 個 / `
        + `使い回し ${editor?.reused ?? '(測れず)'} / 保存 ${
            JSON.stringify((editor?.saved ?? '(測れず)').slice(0, 40))}`);
    console.log(`   読み取り鍵のみ: タブ ${editorReadKey?.tabs ?? '(測れず)'} 個 / `
        + `編集ボタン ${editorReadKey?.hasEditButton ?? '(測れず)'} / `
        + `理由を言った ${editorReadKey?.said ?? '(測れず)'}`);
    if (blob && !blob.error) {
        // ⚠️ **どのペインを測ったかも出す**（差分ペインが2枚あるので、
        //    駆動した対象と予算の計測先が違っていたら目で気付ける形にする）
        console.log(`   全文 ${blob.rows}/${BLOB_FILE_LINES} 行を描画 = ${blob.budgetMs}ms`
            + `（予算 ${BUDGET_BLOB_MS}ms）/ 対象 ${blob.paneId} / 予算の対象 ${blob.budgetPaneId}`);
    }
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
    await rmRetry(join(repo, '..', `${repo.split(/[\\/]/).pop()}-ed`));
    await rmRetry(join(repo, '..', `${repo.split(/[\\/]/).pop()}-long`));
    await rmRetry(repo);
    await rmRetry(repo2);
    await rmRetry(profile);
}
