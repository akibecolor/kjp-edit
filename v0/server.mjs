#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// kjp-edit v0 — 全 worktree を1枚のグラフで見る読み取り専用デーモン。
// 依存パッケージゼロ (Node 標準ライブラリのみ)。
//
//   node v0/server.mjs [--repo <path>]... [--port 7749] [--limit 300]
//
// 🔒 **読める範囲は起動時に固定する。** `--repo` を複数渡せるが、
//    UI から任意のパスを開く経路は作らない。作ると「トークンが漏れた」が
//    「マシン上の全 git リポジトリが読まれた」に直結する。
//    クエリの `?repo=` は**登録済み一覧との samePath() 照合**だけを通す
//    （形式が正しくても登録外は 400）。
//
// 🔒 127.0.0.1 のみにバインドする (docs/architecture.md の D1)。
//    外から届かせたい場合はトンネル (tailscale serve 等) をループバックで終端させる。
//    このサーバは認証を持たない。0.0.0.0 にバインドしないこと。

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, open, lstat } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';
import {
    git, listWorktrees, log, aheadBehind, commonDir,
    changedFiles, worktreeStatus, sequencerState,
    refMap, resolveRef, worktreeGitDirs, stats, splitZ,
    showBlob, fileDiff, toNFC, samePath, containsPath, isSafeRepoPath, isSafeRef,
    mergePreview, mergeDriverNames, repoFilterNames,
} from './git.mjs';
import {
    blobOid, inspectBytes, toEditorText, encodeForWorktree, MAX_EDIT_BYTES,
} from './writefile.mjs';
import { computeSwimlanes } from './swimlanes.mjs';
import { planMerge } from './mergeplan.mjs';
import { collectAgents, transcriptRoot, maskSecrets } from './transcript.mjs';
import { ExecRegistry, isSessionId } from './execsession.mjs';
import { parseProcPairs, descendantsOf, stillAlive } from './proctree.mjs';
import { makeFailTracker, makeInflightGate, makeGoodSet, failDelay } from './failtracker.mjs';
import { collisionFullLabels } from './dirlabel.mjs';
import { readSecretOf } from './readsecret.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
    const opts = {
        // 🔒 読める範囲。**起動時に固定する**（UI から増やせない）。
        //    1本目が既定。空なら下で process.cwd() を入れる。
        repos: [], port: 7749, limit: 300, base: null,
        layoutProbe: false, allowHosts: new Set(),
        // 🔒 書き込みは既定オフ。経路そのものを存在させない
        allowWrite: false, token: null,
        // 🔒 実行は書き込みと**別の** capability。checkout を許すことと
        //    任意コマンドを許すことは危険度が桁違いなので、まとめない。
        allowExec: false, execTimeoutMs: 10 * 60 * 1000, auditLog: null, tokenFile: null,
        // 🔒 監査ログの上限（超えたら1世代だけ残して回転する）。認証前の 401 も
        //    同じファイルに追記されるので、上限が無いと外から容量を食える。
        auditMaxBytes: 4 * 1024 * 1024,
        // 「トークンを明示的に決めたか」。長さでは判定できない（自動生成も43文字）
        tokenExplicit: false,
        // 🚨 切断で子プロセスを殺すのをやめた代わりの制約（#17）。
        //    猶予は「スマホがタブを止めて戻ってくる」までを吸収する長さにする。
        //    終了後の保持は「出力を読みに戻れる」ための時間。
        execDetachedGraceMs: 5 * 60 * 1000,
        execRetainMs: 10 * 60 * 1000,
        // ⚠️ 検査専用。応答を流し始めるのを遅らせて「届く前に切られた」を
        //    決定的に作る（既定 0 = 何もしない）。`--layout-probe` と同じ扱い。
        execStreamDelayMs: 0,
        // ⚠️ 検査専用。create() と spawn() の間を遅らせて「starting のうちに
        //    kill された」を決定的に作る（既定 0 = 何もしない）。
        execSpawnDelayMs: 0,
        // 検査専用。状態キャッシュの TTL を伸ばす（既定 = CACHE_TTL_MS）
        stateTtlMs: null,
        // 🔒 エージェントの活動観測。**リポジトリ外（~/.claude/projects/）を読む**ので
        //    読み取り側の不変条件（git cat-file 経由のみ）を破る。だから別 capability。
        //    さらに自由文（発話・コマンド行）は**もう一段別のフラグ**にする。
        //    理由: --watch-agents だけなら「payload に自由文が1文字も無い」を
        //    テストで固定できる。その不変条件が守りの背骨になる（docs/agent-observation.md）。
        watchAgents: false, allowTranscriptText: false,
        // 🔒 読み取り経路にもトークンを要求するか。
        //    null = 未指定。**--allow-host を付けた瞬間に必須にする**（下で決める）。
        //    ループバック限定の従来の使い方は摩擦ゼロのまま保つ。
        requireAuth: null,
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        // ⚠️ 数値は必ず検証する。`--exec-timeout abc` は Number→NaN で
        //    setTimeout(fn, NaN) が 1ms 扱いになり、**全コマンドが即殺される**
        //    （レビューで実測）。黙って壊れるより起動を止める。
        const num = (name, min, max) => {
            const v = Number(argv[++i]);
            if (!Number.isFinite(v) || v < min || v > max) {
                console.error(`\n✖ ${name} には ${min}〜${max} の数値を指定してください（受け取った値: ${argv[i]}）\n`);
                process.exit(1);
            }
            return v;
        };
        // ⚠️ **上書きではなく追加。** 複数のリポジトリを1本のデーモンで見る。
        //    黙って最後の1本だけ効く形にすると「打ったのに効かない」になる。
        if (a === '--repo') opts.repos.push(resolve(argv[++i]));
        else if (a === '--port') opts.port = num('--port', 0, 65535);
        else if (a === '--limit') opts.limit = num('--limit', 1, 100000);
        else if (a === '--base') opts.base = argv[++i];
        else if (a === '--layout-probe') opts.layoutProbe = true;
        else if (a === '--allow-host') opts.allowHosts.add(String(argv[++i]).toLowerCase());
        else if (a === '--allow-write') opts.allowWrite = true;
        else if (a === '--allow-exec') { opts.allowExec = true; opts.allowWrite = true; }
        else if (a === '--exec-timeout') opts.execTimeoutMs = num('--exec-timeout', 1, 86400) * 1000;
        else if (a === '--exec-detached-grace') opts.execDetachedGraceMs = num('--exec-detached-grace', 1, 86400) * 1000;
        // 検査専用（`--layout-probe` と同じ扱い。ヘルプには出さない）
        else if (a === '--exec-stream-delay') opts.execStreamDelayMs = num('--exec-stream-delay', 0, 60000);
        else if (a === '--exec-spawn-delay') opts.execSpawnDelayMs = num('--exec-spawn-delay', 0, 60000);
        else if (a === '--state-ttl') opts.stateTtlMs = num('--state-ttl', 0, 600000);
        else if (a === '--exec-retain') opts.execRetainMs = num('--exec-retain', 1, 86400) * 1000;
        // 🚨 「明示的に決めた」ことを記録する。長さだけを見ると、
        //    自動生成（32バイト = 43文字）が条件を満たしてしまう（6回目のレビュー）
        else if (a === '--token') { opts.token = argv[++i]; opts.tokenExplicit = true; }
        else if (a === '--audit-log') opts.auditLog = resolve(argv[++i]);
        else if (a === '--audit-max-bytes') opts.auditMaxBytes = num('--audit-max-bytes', 512, 2 ** 40);
        else if (a === '--token-file') { opts.tokenFile = resolve(argv[++i]); opts.tokenExplicit = true; }
        else if (a === '--require-auth') opts.requireAuth = true;
        // ⚠️ 明示的に切る道を残す。ただし --allow-host と併用したら起動を止める
        //    （黙って無認証でトンネルに出す状態を作らない）。
        else if (a === '--no-auth') opts.requireAuth = false;
        else if (a === '--watch-agents') opts.watchAgents = true;
        // ⚠️ text は watch を含意させる（片方だけ指定して静かに無効、を作らない）
        else if (a === '--allow-transcript-text') { opts.allowTranscriptText = true; opts.watchAgents = true; }
        else if (a === '--help' || a === '-h') {
            console.log('usage: node v0/server.mjs [--repo <path>]... [--port 7749] [--limit 300] [--base <ref>]');
            console.log('       --repo <path>        複数指定できる（1本目が既定。読める範囲はここで固定）');
            console.log('       --allow-host <name>  トンネル経由のホスト名を許可する（既定はループバックのみ）');
            console.log('       --allow-write        checkout と追跡ファイルの編集・保存を有効にする（既定オフ）');
            console.log('       --allow-exec         任意コマンドの実行を有効にする（既定オフ。--token 必須）');
            console.log('       --exec-timeout <秒>  実行の上限時間（既定 600）');
            console.log('       --token <s>          書き込み/実行用トークン（既定は起動時にランダム生成）');
            console.log('       --audit-log <path>   実行の監査ログの置き場所（既定は <GIT_DIR> 内。実行した相手が消せる）');
            console.log('       --audit-max-bytes <n> 監査ログの上限（既定 4194304。超えたら .1 に回す）');
            console.log('       --token-file <path>  トークンを永続化する（無ければ生成。リポジトリの外に置くこと）');
            console.log('       --require-auth       読み取りにもトークンを要求する（--allow-host のとき既定オン）');
            console.log('       --no-auth            上を明示的に切る（--allow-host との併用は拒否）');
            console.log('       --watch-agents       エージェントの活動を観測する（既定オフ。リポジトリ外を読む）');
            console.log('       --allow-transcript-text  発話とコマンド行も出す（既定オフ。--watch-agents を含む）');
            console.log('       --layout-probe       レイアウト検査用の /__probe を有効にする');
            process.exit(0);
        }
    }
    if (opts.repos.length === 0) opts.repos.push(process.cwd());
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
/**
 * 描画の予算を測るハーネス（#3）。
 *
 * ⚠️ **同じ経路（`line()` → rAF → flush）を叩く。** 直接 DOM を触ると
 *    測っている対象が変わる。入口は app.html が `?probe=1` のときだけ出す。
 * ⚠️ ここは server.mjs のテンプレートリテラルの中。**バックティックを書かない。**
 */
function renderHarness(w, q) {
    return `<!doctype html><meta charset="utf-8"><title>render probe</title>
<body style="margin:0">
<iframe id="f" src="/?probe=1${q}" style="width:${w}px;height:900px;border:0"></iframe>
<pre id="out"></pre>
<script type="module">
const f = document.getElementById('f');
// 🚨 **load を無期限に待たない。** listener を付ける前に発火すると永久に戻らず、
//    ページは out を書かないままブラウザも終わらない（外から SIGKILL され、
//    何を待っていたか消える）。上限を付けて、後段のポーリングに判定させる。
const waitLoad = (ms) => Promise.race([
  new Promise(r => f.addEventListener('load', r, { once: true })),
  new Promise(r => setTimeout(r, ms)),
]);
await waitLoad(20000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const win = f.contentWindow;
for (let i = 0; i < 200 && typeof win.__kjpFeedTerm !== 'function'; i++) await sleep(100);
const term = f.contentDocument.querySelector('.term');
let out;
if (!term || typeof win.__kjpFeedTerm !== 'function') {
  out = { error: 'measurement entry missing (__kjpFeedTerm / .term)' };
} else {
  const LINES = 12000;
  let maxBlock = 0;
  const t0 = performance.now();
  for (let i = 0; i < LINES; i += 200) {
    const a = performance.now();
    for (let k = 0; k < 200; k++) win.__kjpFeedTerm('line ' + (i + k) + String.fromCharCode(10));
    await new Promise(r => win.requestAnimationFrame(r));
    const b = performance.now();
    if (b - a > maxBlock) maxBlock = b - a;
  }
  out = {
    lines: LINES,
    totalMs: Math.round(performance.now() - t0),
    maxBlockMs: Math.round(maxBlock),
    spans: term.childNodes.length,
  };
}
document.getElementById('out').textContent = JSON.stringify(out);
</script>`;
}

function probeHarness(width, mode, token) {
    const w = Number.isFinite(width) && width >= 200 && width <= 4000 ? Math.floor(width) : 390;
    // 🚨 描画の予算を測るモード（#3）。**仮想時間では測れない**ので
    //    v0/render-check.mjs が実時間で開く（layout-check とは別の検査）。
    // 🚨 **検査用のトークンを iframe に渡す。**
    //    これが無いと --allow-exec 付きでもコンソールは「トークンが無い」の一文になり、
    //    **コマンドバーも監視盤の行も1つも描かれないまま「測った」ことになる**
    //    （「capability を切ると描かれない UI は、検査でも描かれない」の再発）。
    // 🔒 見せてよいのは **既にトークンを持っている要求だけ**（/api/v0/session と同じ規則）。
    //    呼び出し側が presentedToken を通ったときだけ token を渡してくる。
    const q = token ? `&token=${encodeURIComponent(token)}` : '';
    if (mode === 'render') return renderHarness(w, q);
    return `<!doctype html><meta charset="utf-8"><title>layout probe</title>
<body style="margin:0">
<iframe id="f" src="/?probe=1&timers=0${q}" style="width:${w}px;height:2000px;border:0"></iframe>
<pre id="out"></pre>
<script type="module">
const f = document.getElementById('f');
// 🚨 **load を無期限に待たない。** listener を付ける前に発火すると永久に戻らず、
//    ページは out を書かないままブラウザも終わらない（外から SIGKILL され、
//    何を待っていたか消える）。上限を付けて、後段のポーリングに判定させる。
const waitLoad = (ms) => Promise.race([
  new Promise(r => f.addEventListener('load', r, { once: true })),
  new Promise(r => setTimeout(r, ms)),
]);
await waitLoad(20000);
// ⚠️ 固定時間で待たない。描画は state の取得（+ 衝突予測）を待つので、
//    処理が増えると足りなくなる。実際に 390px だけ「バッジ0個」で
//    CI が落ちた（幅ごとに別の Chrome を起動するのでレースになる）。
//    **中身が出るまでポーリングする。**
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 100; i++) {
  const d = f.contentDocument;
  // グラフ行が1本でも描かれたら、state の取得と描画は終わっている
  if (d && d.querySelector('.grow')) break;
  await sleep(200);
}
await sleep(300);   // 直後のレイアウト確定を待つ
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
// 🚨 hidden 属性を付けたのに描かれているものを探す。
//    ⚠️ ここは server.mjs のテンプレートリテラルの中なので**バックティックを書かない**。
//    .cmdbar の display:flex のような作者スタイルは UA の
//    [hidden]{display:none} に**勝つ**ので、el.hidden = true が効かない。
//    「送れないのに入力欄が出ている（押しても無反応）」を実際に作った。
const hiddenButDrawn = [...doc.querySelectorAll('[hidden]')].filter(drawn)
  .map(e => e.tagName + (e.className ? '.' + String(e.className).trim().split(/\\s+/).join('.') : ''));
const badges = [...doc.querySelectorAll('.ref')].filter(drawn);
// 描かれているのに幅が無い = overflow:hidden や循環参照で情報が消えている
const squashed = badges.filter(e => rect(e).width < 24)
  .map(e => e.textContent.trim() + ' w=' + Math.round(rect(e).width));
// 🚨 **測っている対象が存在することを一緒に返す。**
// トークンが無いと実行系の UI は「使えません」の一文になり、
// **溢れも hidden も測らないまま緑**になる（実際にこの状態だった）。
const cmdbars = [...doc.querySelectorAll('.cmdbar')].filter(drawn).length;
const monitorRows = [...doc.querySelectorAll('[data-pane-id="monitor"] .ab')].filter(drawn).length;
// 🚨 **手つかずの状態の計測は、下の並び替えより前に「値として」取る。**
//    JSON を組み立てる式の中に doc.body.scrollWidth のような読み取りを残していたら、
//    再読込で doc が捨てられた後に読むことになり、**worktree HEAD バッジが 0 個**
//    （＝核心情報が消えたという偽の失敗）になった。溢れの判定も同じ経路で嘘になる。
const bodyScroll = doc.body.scrollWidth, bodyClient = doc.body.clientWidth;
const wtBadges = [...doc.querySelectorAll('.ref.wt')].filter(drawn).length;

// 🚨 リポジトリのセレクトも同じ扱い。1本しか登録していないと描かれないので、
//    検査は**2本登録して起動する**（描かれていないまま「測った」にしない）。
const repoSel = doc.getElementById('reposel');
const repoSels = repoSel && drawn(repoSel) ? repoSel.options.length : 0;
// 🚨 **CSS が読めているかを「効果」で確かめる。** 規則の書き間違い
//    （コメントの閉じ忘れなど）はブラウザが黙って規則を捨てるので、
//    構文チェックにも node --check にも掛からない（実際にコメントの
//    閉じを余らせて :has() の規則を1つ落とした）。
//    狭い画面ではセレクトとパスは**入れ替わる**約束なので、
//    「パスが描かれているか」を返して呼び出し側に判定させる。
//    ⚠️ ここは server.mjs のテンプレートリテラルの中。バックティックを書かない。
const repoPath = doc.getElementById('repo');
const repoPathDrawn = Boolean(repoPath && drawn(repoPath));
// 🚨 **トップバーからはみ出した操作は「押せないボタン」になる。**
//    .topbar は overflow:hidden + flex-wrap:nowrap なので、縮まない要素を
//    1つ足すと後ろのボタンが枠外に出る。body は溢れないので
//    bodyScrollWidth の比較では**検出できない**（実測: リポジトリのセレクトを
//    固定幅で足したら 390px で #refresh と #reset が到達不能になった）。
const barClipped = [...doc.querySelectorAll('.topbar > *')]
  .filter(e => drawn(e) && rect(e).right > vw + 1)
  .map(e => e.tagName + (e.id ? '#' + e.id : ''));
// ---- ペインの並び替え（ドラッグ移動）を実際に動かして測る ----
// 🚨 **字面を assert しない。** 保存も復元も「行は残っているのに到達不能」という
//    形で壊せるので、ヘッダを掴んで動かし、自動更新を1回通し、再読込してから
//    実際の並びを読む。⚠️ ここは server.mjs のテンプレートリテラルの中なので
//    **バックティックとドル記号+波括弧の補間を書かない**（前者は構文エラー、
//    後者は server.mjs 側の式として評価される。この注意書き自体で踏んだ）。
const paneOrder = (d, host) => [...d.querySelectorAll('#' + host + ' > .pane')]
  .map(e => e.dataset.paneId);
const fire = (target, type, x, y) => target.dispatchEvent(new win.PointerEvent(type, {
  bubbles: true, cancelable: true, composed: true,
  pointerId: 1, pointerType: 'mouse', isPrimary: true,
  button: 0, buttons: type === 'pointerup' ? 0 : 1,
  clientX: x, clientY: y,
}));
// ⚠️ 落とす先の座標は**入れ物の矩形**から取る。ペインの矩形は途中の
//    pointermove で並びが変わると動くので、掴む前に取った値が嘘になる。
const dragToTopOf = (paneEl, hostId) => {
  const hd = paneEl.querySelector('header');
  const from = hd.getBoundingClientRect();
  const aim = () => doc.getElementById(hostId).getBoundingClientRect();
  fire(hd, 'pointerdown', from.left + 8, from.top + 3);
  fire(hd, 'pointermove', from.left + 8, from.top + 30);   // しきい値(6px)を越える
  fire(hd, 'pointermove', aim().left + 8, aim().top + 1);   // 先頭ペインの中点より手前
  fire(hd, 'pointerup', aim().left + 8, aim().top + 1);
};
const dragNote = [];
const leftBefore = paneOrder(doc, 'left');
const rightBefore = paneOrder(doc, 'right');
if (leftBefore.length < 2) dragNote.push('left のペインが2本未満（列内の並び替えを測れない）');
if (rightBefore.length < 1) dragNote.push('right のペインが無い（列をまたぐ移動を測れない）');
if (leftBefore.length >= 2) {
  const ps = [...doc.querySelectorAll('#left > .pane')];
  dragToTopOf(ps[ps.length - 1], 'left');
}
if (rightBefore.length >= 1) {
  dragToTopOf(doc.querySelector('#right > .pane'), 'left');
}
const leftAfterDrag = paneOrder(doc, 'left');
const rightAfterDrag = paneOrder(doc, 'right');
// 並べ替えた後の溢れ（幅の前提が並び順に依存していないか）
const overDrag = [...doc.querySelectorAll('*')].filter(e => rect(e).right > vw + 1);
const scrollDrag = doc.body.scrollWidth, clientDrag = doc.body.clientWidth;
// 自動更新（ensurePane / dropPanes を通る）で並びが巻き戻らないこと。
// ⚠️ render は .cards を作り直すので、**別のノードになったこと**で完了を知る
//    （固定時間で待つと、処理を足したときに足りなくなる）。
const cardsWas = doc.querySelector('.cards');
doc.getElementById('refresh').click();
for (let i = 0; i < 100; i++) {
  const now = doc.querySelector('.cards');
  if (now && now !== cardsWas) break;
  await sleep(100);
}
const leftAfterRefresh = paneOrder(doc, 'left');
// 🚨 並びが同じでも**作り直されている**ことがある（古い方が先に見つかるので
//    並びだけ見ると使い回されているように読める）。同じ id の重複も数える。
const allPanes = [...doc.querySelectorAll('.pane')];
const paneDuplicates = allPanes.length
  - new Set(allPanes.map(e => e.dataset.paneId)).size;
// 再読込して、保存された並びが復元されること
f.contentWindow.location.reload();
// ⚠️ ここも上限付き（reload の load はもっと取り逃しやすい）。
//    取り逃しても下のポーリングが描画完了を待つので、判定は変わらない。
await waitLoad(20000);
let doc2 = f.contentDocument;
for (let i = 0; i < 100; i++) {
  doc2 = f.contentDocument;
  if (doc2 && doc2.querySelector('.grow')
    && paneOrder(doc2, 'left').length >= leftAfterRefresh.length) break;
  await sleep(100);
}
const leftAfterReload = paneOrder(doc2, 'left');
const rightAfterReload = paneOrder(doc2, 'right');
// 「レイアウト」で既定の並びに戻れること。
// ⚠️ 戻せないと、動かしすぎた画面を直す手段が無くなる（ペインを1つずつ
//    元の列へ引きずるしかない）。既定の並びは **render が求めた順**なので、
//    DOM に残っている今の順ではなく最初に測った順と一致しなければならない。
doc2.getElementById('reset').click();
await sleep(100);
const leftAfterReset = paneOrder(doc2, 'left');
const rightAfterReset = paneOrder(doc2, 'right');

document.getElementById('out').textContent = JSON.stringify({
  innerWidth: vw,
  dragNote,
  leftBefore, leftAfterDrag, leftAfterRefresh, leftAfterReload, leftAfterReset,
  rightBefore, rightAfterDrag, rightAfterReload, rightAfterReset,
  paneDuplicates,
  overflowingAfterDrag: overDrag.slice(0, 12).map(e => e.tagName
    + (e.id ? '#' + e.id : '')),
  overflowingAfterDragCount: overDrag.length,
  bodyScrollWidthAfterDrag: scrollDrag,
  bodyClientWidthAfterDrag: clientDrag,
  drawnCmdbars: cmdbars,
  drawnMonitorRows: monitorRows,
  bodyScrollWidth: bodyScroll,
  bodyClientWidth: bodyClient,
  topbarClipped: barClipped,
  topbarClippedCount: barClipped.length,
  repoPathDrawn,
  drawnRepoOptions: repoSels,
  overflowing: over.slice(0, 12),
  overflowingCount: over.length,
  hiddenButDrawn: hiddenButDrawn.slice(0, 12),
  hiddenButDrawnCount: hiddenButDrawn.length,
  squashedBadges: squashed.slice(0, 12),
  squashedCount: squashed.length,
  visibleBadges: badges.length,
  // worktree HEAD バッジは狭い画面でも消してはいけない（このツールの核心情報）
  visibleWorktreeBadges: wtBadges,
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

/**
 * 登録済みリポジトリの表示名。**basename、衝突したらフルパス。**
 *
 * ⚠️ worktree の `assignLabels` のように「末尾2セグメント」で畳まない。
 *    リポジトリの切り替えは**別のリポジトリに操作を撃つ**入力なので、
 *    曖昧さを残さない方に倒す（末尾2つでも衝突しうる）。
 * @param {string[]} paths 登録済みの絶対パス（重複排除済み）
 * @returns {string[]} paths と同じ順序のラベル
 */
// ⚠️ 実装は `v0/dirlabel.mjs`（ブラウザ側の監視盤と同じ道具を使う）。
//    選択リストは**衝突したらフルパス**に落とす（どのリポジトリかを
//    取り違えると読む対象そのものが変わるので、曖昧さを完全に消す方に倒す）。
function repoLabels(paths) {
    return collisionFullLabels(paths);
}

/**
 * 🔒 **クエリの `?repo=` を「登録済み一覧」と突き合わせる関門。**
 *
 * ⚠️ **`isSafeRepoPath()` では判定しない。** あれは「リポジトリ相対のパスとして
 *    安全か」で、絶対パスは弾くが「登録されているか」は見ない。ここで要るのは
 *    **登録外は形式が正しくても拒否**という判定なので、`samePath()` 照合にする
 *    （区切り文字・大文字小文字・8.3 短縮名・symlink を吸収する。`===` では
 *     手元では通るのに CI や symlink 環境でだけ 400 になる）。
 * ⚠️ 指定が無ければ既定（1本目）。後方互換のため必須にしない。
 * @returns {{repo: string} | {error: string}}
 */
function pickRepo(url) {
    const raw = url.searchParams.get('repo');
    if (raw === null || raw === '') return { repo: opts.repos[0] };
    const want = toNFC(String(raw));
    // ⚠️ 素の一致を先に見る。`samePath()` は `realpathSync.native()` を叩くので
    //    **要求ごとに同期の fs 呼び出し**が本数分入る。UI は
    //    `/api/v0/repos` で渡した表記をそのまま返してくるので、ここでほぼ済む。
    //    （素の一致で外れたときだけ samePath に落ちる。守りは緩めない）
    if (opts.repos.includes(want)) return { repo: want };
    // 返すのは**登録済みの表記そのもの**（クライアントの表記を git に渡さない）
    const hit = opts.repos.find(r => samePath(r, want));
    if (!hit) return { error: `登録されていないリポジトリです: ${want}` };
    return { repo: hit };
}

async function collectFresh(repo) {
    const cwd = repo;
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

    // 🔒 **`.gitattributes` の filter を潰す（capability ゼロでの任意コード実行を止める）。**
    //    `core.fsmonitor` と同じクラスの穴で、`git status` が作業ツリーと index を
    //    比べるときに clean filter を実行する（実測で marker が書かれた。8回目のレビュー）。
    //    ⚠️ 1リポジトリあたり 2 spawn（--local と --worktree）。worktree の本数には比例しない。
    const filters = await repoFilterNames(cwd);
    if (filters.length) {
        errors.push({
            scope: 'repo',
            message: `リポジトリ設定の filter（${filters.map(f => f.name).join(', ')}）を無効化して読みました`
                + '（`.gitattributes` の filter は任意コマンドを実行できるため）。'
                + ' 変更ありの判定が実際と違うことがあります。',
        });
    }

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
            worktreeStatus(wt.path, filters).catch(e => {
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
        // ⚠️ 失敗を黙って飲まない。無関係な履歴（merge base 無し）はここで分かる。
        //    飲むと files=[] になって overlaps に出ず、しかし ahead>0 なので
        //    「まとめて取り込める塊」に並んでしまう。git merge は門前払いするのに
        //    「安全に取り込める」と提示されていた（レビューで実測）。
        wt.files = await changedFiles(cwd, base, ref).catch(e => {
            if (/no merge base|unrelated histories/i.test(e.message ?? '')) {
                wt.noMergeBase = true;
                errors.push({
                    scope: wt.label,
                    message: `base（${base}）と共通の履歴がありません。git merge は拒否します。`,
                });
            }
            return [];
        });
    }));

    // 🚨 checkout は git のフック（post-checkout）を起動する。つまりフックのある
    //    リポジトリでは `--allow-write` は実質コード実行と同じ。capability を
    //    分けている以上、この事実を payload に出して見えるようにする（レビューで実証）。
    //    既定でフックを止めるとワークフローを壊すので、止めずに知らせる方を選んだ。
    if (opts.allowWrite) {
        try {
            const { existsSync } = await import('node:fs');
            const hooks = ['post-checkout', 'post-index-change']
                .filter(h => existsSync(join(common, 'hooks', h)));
            if (hooks.length) {
                errors.push({
                    scope: 'security',
                    message: `フックが存在します（${hooks.join(', ')}）。checkout はこれを起動するので、`
                        + '--allow-write はこのリポジトリでは実質コード実行と同じです。',
                });
            }
        } catch { /* 判定できなければ黙る */ }
    }

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
    // 候補ペアの生成にだけ使う索引。rename の**旧パス**も入れる。
    // ⚠️ 旧パスを入れないと rename/rename が候補にならない
    //    （agent-9 が `a→b`、agent-10 が `a→c` にすると新パスが重ならないので
    //     「同じファイルを触っていない」と判定され、実際は衝突するのに検査されない。
    //     レビューで実証された）。表示用の overlaps には出さない。
    const byFileForPairs = new Map();
    for (const wt of worktrees) {
        for (const f of wt.files) {
            if (!byFile.has(f.path)) byFile.set(f.path, new Map());
            byFile.get(f.path).set(wt.path, wt.label);
            for (const p of [f.path, f.from].filter(Boolean)) {
                if (!byFileForPairs.has(p)) byFileForPairs.set(p, new Map());
                byFileForPairs.get(p).set(wt.path, wt.label);
            }
        }
    }
    const overlaps = [...byFile.entries()]
        .filter(([, owners]) => owners.size > 1)
        .map(([path, owners]) => ({ path, worktrees: [...owners.values()] }))
        .sort((a, b) => b.worktrees.length - a.worktrees.length || a.path.localeCompare(b.path));

    // 🔍 衝突予測。「同じファイルを触っている」だけでは実際に衝突するか分からないので、
    //    候補ペアだけ実際にマージしてみる。
    //
    // ⚠️ 全ペア（N²）は走らせない。overlaps に出たペアだけに絞る
    //    （ループの中で git を増やさない、という規則）。
    // ⚠️ この絞り込みは**取りこぼす**: rename と delete の組み合わせは
    //    別パスでも衝突しうる。完全な検出ではないことを payload にも出す。
    const MAX_PAIRS = 12;
    // ⚠️ **path をキーにする。**ラベルは衝突しうる（`x/same/dup` と `y/same/dup` は
    //    どちらも `same/dup` になる）。ラベルでキーにすると自分自身とのペアが生まれ、
    //    `merge-tree main main` が exit 0 を返して「本当は衝突する2本」が
    //    clean と報告される（レビューで実証）。
    const byPath = new Map(worktrees.map(w => [w.path, w]));
    // 同じコミットを指す worktree（detached のコピー等）は1つに畳む。
    // 畳まないと無意味なペアが上限の枠を食い潰す（実測で12枠のうち8枠）。
    const repFor = new Map();             // path -> 代表 path
    const byOid = new Map();
    for (const w of worktrees) {
        const oid = w.head ?? w.path;
        if (!byOid.has(oid)) byOid.set(oid, w.path);
        repFor.set(w.path, byOid.get(oid));
    }

    const pairCandidates = new Map();     // "pa\0pb" -> {pa, pb}
    for (const owners of byFileForPairs.values()) {
        if (owners.size < 2) continue;
        const paths = [...owners.keys()].map(p => repFor.get(p) ?? p);
        const uniq = [...new Set(paths)];
        for (let i = 0; i < uniq.length; i++) {
            for (let j = i + 1; j < uniq.length; j++) {
                const [pa, pb] = [uniq[i], uniq[j]].sort((x, y) => x.localeCompare(y));
                pairCandidates.set(`${pa}\0${pb}`, { pa, pb });
            }
        }
    }
    // ⚠️ 先頭から MAX_PAIRS 本を取ると **owners[0] と全員のペアで枠が埋まる**
    //    （二重ループの構造上そうなる）。実測で「w2〜w8 同士のペアが1つも
    //    検査されない」状態になり、その結果 batch に実際に衝突するペアが
    //    3組入った。ラウンドロビンで各 worktree に最低1本を配る。
    const allPairs = [...pairCandidates.values()];
    const picked = [];
    const seenCount = new Map();
    for (const round of [0, 1, 2, 3]) {
        for (const p of allPairs) {
            if (picked.length >= MAX_PAIRS) break;
            if (picked.includes(p)) continue;
            const ca = seenCount.get(p.pa) ?? 0, cb = seenCount.get(p.pb) ?? 0;
            if (ca > round || cb > round) continue;
            picked.push(p);
            seenCount.set(p.pa, ca + 1);
            seenCount.set(p.pb, cb + 1);
        }
        if (picked.length >= MAX_PAIRS) break;
    }

    // 🚨 custom merge driver を潰す。潰さないと merge-tree が任意コマンドを実行する。
    //    ペアが無いときは列挙もしない（プロセスを増やさない）。
    let drivers = [];
    if (picked.length) {
        drivers = await mergeDriverNames(cwd);
        if (drivers.length) {
            errors.push({
                scope: 'conflicts',
                message: `custom merge driver（${drivers.join(', ')}）を無効化して衝突予測しました。`
                    + ' 実際のマージでは driver が働くので、ここで衝突と出ても解決されることがあります。',
            });
        }
    }

    const conflicts = (await Promise.all(picked.map(async ({ pa, pb }) => {
        const wa = byPath.get(pa), wb = byPath.get(pb);
        const refA = wa?.ref ?? wa?.branch ?? wa?.head;
        const refB = wb?.ref ?? wb?.branch ?? wb?.head;
        if (!refA || !refB || pa === pb) return null;
        try {
            const r = await mergePreview(cwd, refA, refB, drivers);
            // 🚨 **合成パスを印付ける。** `merge-tree --name-only` は
            //    実在しないパスを返すことがある（実測: `thing~B`。file/directory の
            //    衝突で git が退避先として作る名前。symlink 対 file も同様）。
            //    それを普通のファイル名として出すと、UI で押しても
            //    `/api/v0/diff` にも `blob` にも無いので**開けない行き止まり**になる（#1）。
            //    ここで判別して「開けない理由」を添える。
            //    判別は**推測ではなく git の情報メッセージ**から取る
            //    （接尾辞は label でもハッシュでもなく `refs_heads_...` だった）。
            const synth = r.synthetic ?? new Map();
            const undec = r.undecidable ?? new Map();
            const files = (r.conflicts ?? []).map(f => {
                if (synth.has(f)) {
                    return {
                        path: f, synthetic: true, of: synth.get(f),
                        why: 'git が退避先として作る名前で、実在しません'
                            + '（file と directory / symlink の衝突）',
                    };
                }
                if (undec.has(f)) {
                    return { path: f, synthetic: false, undecidable: true, why: undec.get(f) };
                }
                return { path: f, synthetic: false };
            });
            // 🚨 **判定できないものだけなら「衝突する」と言わない。**
            //    submodule は git が trivial なケースしか扱えないので、
            //    衝突扱いにするのは嘘（#2）。3値の「不明」に倒す。
            const decidable = files.filter(f => !f.undecidable);
            const clean = (r.clean === false && decidable.length === 0) ? null : r.clean;
            return {
                a: wa.label, b: wb.label, aPath: pa, bPath: pb,
                clean, files, truncated: !!r.truncated,
                undecidableOnly: clean === null && r.clean === false,
                reason: clean === null && r.clean === false
                    ? 'submodule があるため判定できません'
                        + '（git は trivial なケースだけ対応。「衝突する」ではありません）'
                    : null,
            };
        } catch (e) {
            errors.push({ scope: `${wa?.label} × ${wb?.label}`, message: `衝突予測に失敗: ${e.message}` });
            return null;
        }
    }))).filter(Boolean).sort((x, y) => Number(x.clean === true) - Number(y.clean === true));

    // 上限で切ったことを黙って隠さない
    if (allPairs.length > picked.length) {
        errors.push({
            scope: 'conflicts',
            message: `衝突予測は ${picked.length} ペアで打ち切りました（候補 ${allPairs.length} ペア）。`
                + ' 検査していないペアは「衝突しない」ではなく「不明」です。',
        });
    }

    // 🔒 エージェントの活動観測。git の spawn は増やさない（fs のみ）。
    //    既定では経路そのものが存在しない（agents は null のまま）。
    let agents = null;
    if (opts.watchAgents) {
        const r = await collectAgents(
            worktrees.filter(w => !w.bare && !w.prunable).map(w => ({ path: w.path, label: w.label })),
            {
                allowText: opts.allowTranscriptText,
                // 🚨 **自分の資格情報をコマンド行から落とす。** `--allow-transcript-text` は
                //    記録の `Bash` / `PowerShell` のコマンド行を **read 権限で**出す。
                //    README が案内していた起動手順は `--allow-exec --token "$TOKEN"` で、
                //    値をリテラルで打った回は記録に残る（実データで 42 件）。
                //    そのままだと Cookie しか持たない読み取り専用の相手が実行トークンを
                //    回収でき、**read が RCE に昇格する**（7回目のレビュー）。
                secrets: secretsForMasking(),
            },
        );
        agents = r.agents;
        errors.push(...r.errors);
    }

    return {
        repo: cwd,
        base,
        generatedAt: new Date().toISOString(),
        // エージェントの活動。--watch-agents が無ければ null（フィールドは残すが中身は無い）。
        // ⚠️ 自由文が入るのは allowTranscriptText のときの text[] と recent[].command だけ。
        //    抽出は許可リスト方式（v0/transcript.mjs）
        agents,
        agentsText: opts.allowTranscriptText,
        // 実行セッションの一覧。**切断しても走り続ける**ようにした代わりに、
        // 「今何が走っているか」を見せる窓がどこかに必要（見えない取り残しを作らない）。
        // ⚠️ 出力の中身は含めない（argv と状態だけ）。
        // 🚨 argv も**秘密をマスクしてから**載せる（`--token <値>` を打った回が残る）。
        //    マスクしたことは `argvMasked` で告げる（黙って消さない）。
        // ⚠️ **リポジトリで絞り込まない。** 台帳は1本のデーモンに1つで、
        //    ここは「見えない取り残しを作らない」ための窓。選択中のリポジトリで
        //    絞ると、切り替えた瞬間に別リポジトリで走っているものが**消える**。
        //    代わりに `repo` を載せて、どこのものかを言う。
        execSessions: opts.allowExec
            ? execRegistry.list().map(x => {
                const masked = x.argv.map(a => maskSecrets(a, secretsForMasking()));
                return {
                    ...x,
                    repo: execRegistry.get(x.id)?.repo ?? null,
                    argv: masked.map(m => m.text),
                    argvMasked: masked.some(m => m.masked),
                };
            })
            : null,
        // 取り込み順序の提案。追加の git 呼び出しは0（衝突予測の結果だけを使う純ロジック）。
        // ⚠️ 仮説であって保証ではない。詳細は v0/mergeplan.mjs のコメント。
        mergePlan: planMerge(
            // merge base が無いものは候補にしない（マージできないので）
            worktrees.filter(w => !w.bare && !w.prunable && !w.noMergeBase && (w.ahead ?? 0) > 0)
                .map(w => ({ label: w.label, ahead: w.ahead })),
            conflicts,
        ),
        // 衝突予測。clean=false のペアは実際にマージすると衝突する。
        // ⚠️ 候補は overlaps 由来なので rename/delete 絡みは取りこぼす（完全ではない）
        conflicts,
        worktrees: worktrees.map(w => ({
            name: w.label, basename: w.name, path: w.path,
            branch: w.shortBranch, head: w.head,
            detached: w.detached, bare: w.bare, locked: w.locked,
            prunable: w.prunable, prunableReason: w.prunableReason ?? null,
            noMergeBase: !!w.noMergeBase,
            ahead: w.ahead, behind: w.behind, status: w.status,
            // sequencer の全状態を渡す。UI が rebase/merge 中を出せなかったのは
            // warnings しか払い出していなかったため（レビューで発覚）。
            sequencer: {
                rebasing: !!w.sequencer.rebasing,
                merging: !!w.sequencer.merging,
                cherryPicking: !!w.sequencer.cherryPicking,
                reverting: !!w.sequencer.reverting,
                bisecting: !!w.sequencer.bisecting,
                sequencing: !!w.sequencer.sequencing,
                rebaseHeadName: w.sequencer.rebaseHeadName ?? null,
                headRef: w.sequencer.headRef ?? null,
                warnings: w.sequencer.warnings ?? [],
            },
            warnings: w.sequencer.warnings ?? [],
            files: w.files,
        })),
        // ローカルブランチ名。**checkout の候補はこれだけから作る。**
        // ⚠️ グラフの `%D` から推測してはいけない。short name では
        //    remote-tracking（`origin/main`）とスラッシュ入りのローカルブランチ
        //    （`機能/新規`）を形で区別できない。remote-tracking を checkout すると
        //    detached HEAD になる。refMap は完全な refname を持っているので確実。
        localBranches: [...refs.keys()]
            .filter(k => k.startsWith('refs/heads/'))
            .map(k => k.slice('refs/heads/'.length))
            .sort((a, b) => a.localeCompare(b)),
        graph,
        overlaps,
        errors,
        // 1回の収集で git を何回起動したか。worktree 本数に対する伸び方を
        // スモークテストで固定する（コメントだけでは回帰を防げない）。
        stats: {
            gitSpawns: stats.spawns - spawnsBefore,
            // 🚨 プロセス開始からの合計。**認証前の要求が git を起動していないか**を
            //    測るために要る（8回目のレビュー: 冷えたデーモンでは 401 の1本ごとに
            //    `git rev-parse --git-common-dir` が起動していた。実測で並列 200 本の
            //    最中に git.exe が 7 本同時）。この収集ぶん（gitSpawns）を引けば
            //    「それ以前に何回起動したか」が分かる。
            gitSpawnsTotal: stats.spawns,
            worktrees: worktrees.length,
            // 衝突予測は候補ペアの数だけ git を起動する（worktree 本数とは別軸）
            conflictPairs: conflicts.length,
        },
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
/**
 * 🚨 **キャッシュはリポジトリごとに分ける。** 1本の変数だと、A を読んだ直後に
 *    B を読むと **A の payload が B として返る**（`state.repo` も worktree も
 *    別リポジトリのものになる = 観測ツールとして最悪の嘘）。
 * ⚠️ キーは `pickRepo()` が返した**登録済みの表記そのもの**にする。
 *    クライアントの表記でキーを作ると、同じ場所が別表記で2エントリになり
 *    TTL も無効化も片方にしか効かない。
 */
const cachedByRepo = new Map();    // repo -> { at, value }
const inFlightByRepo = new Map();  // repo -> Promise

async function collect(repo, { force = false } = {}) {
    const now = process.hrtime.bigint();
    const hit = cachedByRepo.get(repo);
    // ⚠️ **TTL は検査から伸ばせるようにしてある（既定は上の 1500ms）。**
    //    「書き込みが失敗したときにキャッシュを捨てているか」は、素のままだと
    //    「捨てた」と「TTL が自然に切れた」の**競争**になり、遅い環境では
    //    守りを外しても緑になる（`--exec-stream-delay` と同じ型の非決定性）。
    if (!force && hit && Number(now - hit.at) / 1e6 < (opts.stateTtlMs ?? CACHE_TTL_MS)) {
        return hit.value;
    }
    // 同時リクエストは1回の収集に合流させる（**同じリポジトリのものだけ**）
    const running = inFlightByRepo.get(repo);
    if (running) return running;
    const p = (async () => {
        try {
            const value = await collectFresh(repo);
            cachedByRepo.set(repo, { at: process.hrtime.bigint(), value });
            return value;
        } finally {
            inFlightByRepo.delete(repo);
        }
    })();
    inFlightByRepo.set(repo, p);
    return p;
}

/**
 * 🔒 DNS rebinding を止める。
 *
 * ⚠️ 127.0.0.1 にバインドしても、CORS を返さなくても、これは防げない。
 *    攻撃者のページが自分のドメインの DNS を 127.0.0.1 に貼り替えると、
 *    そのページの**オリジン自体が 127.0.0.1 になる**ので同一オリジンとして
 *    通ってしまう。閲覧しただけのサイトからリポジトリの差分が読まれる。
 *    止められるのは Host ヘッダの検証だけ（ブラウザは元のホスト名を送る）。
 *
 * 認証は後から足せるが、これは後回しにできない。読み取りだけでも成立する攻撃なので。
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function hostAllowed(req) {
    const host = req.headers.host;
    if (!host) return false;                 // HTTP/1.1 では Host 必須
    // IPv6 の [::1]:port も受ける
    const m = /^(\[[0-9a-fA-F:]+\]|[^:]+)(?::(\d+))?$/.exec(host);
    if (!m) return false;
    const name = m[1].toLowerCase();

    if (LOOPBACK_HOSTS.has(name)) {
        // ループバックなら、ついでにポートも一致させる
        const port = m[2] ? Number(m[2]) : 80;
        const actual = server.address()?.port;
        return !actual || port === actual;
    }
    // ⚠️ トンネル（tailscale serve 等）を通すと Host はループバックではなくなる。
    //    既定で通すと DNS rebinding を通すのと同じなので、
    //    --allow-host で明示的に許可されたホスト名だけを受ける。
    //    攻撃者は自分の持たないホスト名を Host に入れさせられないので、
    //    オプトインでも rebinding は防げたまま。
    return opts.allowHosts.has(name);
}

/**
 * 🔒 別サイトからの読み出しを弾く（多層防御）。
 * Sec-Fetch-Site を送らない古いブラウザや curl は通す（Host 検証が本線）。
 */
function siteAllowed(req) {
    const site = req.headers['sec-fetch-site'];
    if (!site) return true;
    return site === 'same-origin' || site === 'same-site' || site === 'none';
}

/* =========================================================================
 * 🔒 副作用のある操作の関門。**変更・実行する経路は必ずここを通す。**
 *
 * docs/auth-ordering.md の要点: retrofit が高いのは認証そのものではなく
 * 経路の形。散らしてから認証を入れると全経路の監査になり、1つ忘れると穴が残る。
 * だから追加する認可はすべてこの1関数に足す。
 * ========================================================================= */

const TOKEN_HEADER = 'x-kjp-token';

function denyJson(res, code, message) {
    res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(JSON.stringify({ error: message }));
}

const AUTH_COOKIE = 'kjp_auth';

/**
 * 🔒 読み取り経路の認証。
 *
 * これが無い間、読み取りを守っていたのは **Host 許可 + Sec-Fetch-Site だけ**で、
 * アプリ側の認証はゼロだった。つまりトンネルに届く相手（tailnet に居る全端末）は
 * 誰でも差分を読めた。`--allow-exec` や標準入力の経路を開けるなら、
 * 「サーバに届く」と「操作してよい」を分ける必要がある（docs/auth-ordering.md）。
 *
 * 受け取り方は3つ。**どれもトークン本体の比較は timingSafeEqual を通す。**
 *   1. Cookie（ブラウザの通常経路。初回だけ URL で渡して以後は Cookie）
 *   2. `?token=` （初回のブートストラップ。Cookie を焼いて即リダイレクトする）
 *   3. `X-Kjp-Token` ヘッダ（テストと非ブラウザのクライアント）
 *
 * ⚠️ Cookie を使う以上 CSRF を自前で防ぐ必要があるが、**入口で
 *    `Sec-Fetch-Site` を検証しているので別サイト起点の要求は既に 403**。
 *    加えて副作用のある経路はカスタムヘッダを要求する（preflight が必須になる）。
 *    Cookie は `HttpOnly` / `SameSite=Strict` で出す。
 * ⚠️ `Secure` は付けない。ループバックは http なので付けると Cookie が
 *    保存されず**ローカルで一切動かなくなる**。トンネル側（tailscale serve）が
 *    https を終端する構成なので、経路の暗号化はそちらの責任。
 */
/**
 * 🚨 Cookie に入れる値は**実行トークンと別**にする。
 *
 * **Cookie はポートで分離されない**（RFC 6265: cookies do not provide isolation
 * by port）。`127.0.0.1` に対して焼いた Cookie は `127.0.0.1` の**他のポート全部**に
 * 送られるので、同じブラウザで別のローカル開発サーバ（`127.0.0.1:3000` 等）を
 * 開くと、そのサーバに Cookie の中身が平文で渡る。
 * ここに実行トークンを入れていたので、**受け取った相手は `X-Kjp-Token` に
 * 詰めるだけで任意コマンドを実行できた**（4日間気付かなかった）。
 *
 * 対策: Cookie は**読み取り専用の別の秘密**にする。トークンから決定的に導くので
 * `--token-file` を使えば再起動をまたいでも同じ値になり、
 * 「1回開けば以後そのまま」の運用は保てる。
 *
 * ⚠️ **残るリスク（消せない）**: 同じブラウザで開いた他のローカルサービスは
 *    この Cookie を受け取るので、**読み取りはできる**。ポート分離が無いのは
 *    Cookie の仕様なので、値を変えても防げない。実行を分離するのが対策の要点。
 *    トンネル側の Cookie は host-only なので他の tailnet ホストには行かない。
 */
function cookieSecret() {
    // 🔒 式は `v0/readsecret.mjs` に1本化してある（配る側とずれると
    //    `token-read` の中身が「実際に通らない値」になる。実際にそうなっていた）
    return readSecretOf(opts.token);
}

/**
 * 🚨 **同名の Cookie を全部返す（最初の一致で打ち切らない）。**
 *
 * Cookie はポートで分離されない（RFC 6265）ので、`http://127.0.0.1:3000` など
 * **任意のローカルページ**が `document.cookie = 'kjp_auth=junk; path=/api/v0'` を焼ける。
 * RFC 6265 §5.4.2 は **path の長い Cookie を先に並べる**ことを要求するので、
 * junk は `/api/v0/*` への全要求で決定論的に先頭に来る。最初の一致で返していたため、
 * サーバが焼き直す `Path=/` では上書きできず、`?token=` を開き直しても復旧せず、
 * **手で Cookie を消すまで 401 のまま**になっていた（#43。
 * トンネル越しのスマホからは最も消しにくい相手）。
 * `--allow-host` のときは同一 tailnet の別ノードが `Domain=<tailnet>.ts.net` で同じことをできる。
 */
function readCookies(req, name) {
    const raw = req.headers.cookie;
    if (typeof raw !== 'string') return [];
    const out = [];
    for (const part of raw.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        if (part.slice(0, i).trim() !== name) continue;
        const v = part.slice(i + 1).trim();
        // 🚨 **`decodeURIComponent` は不正なパーセント encoding で throw する。**
        //    `Cookie: kjp_auth=%` の1本で URIError が投げられ、
        //    認可の手前の同期例外が async ハンドラの unhandled rejection になって
        //    **デーモンが exit 1 で落ちていた**（無認証で撃てる DoS。実測）。
        //    `new URL()` で同じ型を一度直したのに、Cookie で再発させた。
        //    **認可より手前で throw しうる関数は全部囲う。**
        try { out.push(decodeURIComponent(v)); } catch { out.push(v); }
    }
    return out;
}

/** 長さを漏らさず比較する（比較先を明示できる形） */
function secretMatches(given, want) {
    if (typeof given !== 'string' || !want) return false;
    // ⚠️ 長さ不一致で早期 return するとトークン長が timing で漏れる。
    //    固定長にハッシュしてから比べれば長さも定数時間で守れる。
    const a = createHash('sha256').update(given, 'utf8').digest();
    const b = createHash('sha256').update(want, 'utf8').digest();
    return timingSafeEqual(a, b);
}

/** 長さを漏らさずトークンを比較する */
function tokenMatches(given) {
    if (typeof given !== 'string' || !opts.token) return false;
    // ⚠️ 長さ不一致で早期 return するとトークン長が timing で漏れる。
    //    固定長にハッシュしてから比べれば長さも定数時間で守れる
    //    （レビューで指摘。実害は小さいが直すのが安い）。
    const a = createHash('sha256').update(given, 'utf8').digest();
    const b = createHash('sha256').update(opts.token, 'utf8').digest();
    return timingSafeEqual(a, b);
}

/**
 * 🚨 **認証失敗を記録し、連続失敗に遅延を掛ける（7回目のレビュー）。**
 *
 * `--allow-host` を付けた瞬間、トンネルに届く相手に対する**唯一の壁がトークン**
 * になる。にもかかわらず 401 はどこにも記録されず（監査は exec の start/exit だけ）、
 * 遅延も回数制限も無かったので、**当て放題かつ痕跡ゼロで総当たり**できた
 * （実測: 3文字のトークンなら29回目に 200。17,576 回外しても一切絞られない）。
 * 当たれば読み取り全部と `POST /api/v0/checkout` が通る。
 *
 * ⚠️ **本文は残さない**（トークンの候補を記録に書かない）。残すのは
 *    peer / host / path と連続失敗の回数だけ。
 * ⚠️ 遅延は**指数**にするが上限を付ける（無限に伸ばすとイベントループに
 *    タイマーが溜まり、正規の利用者も締め出す）。
 */
// ⚠️ 実装は `v0/failtracker.mjs` に1つだけ置く（読み取りの壁と実行の壁で共有）。
//    窓 5 分 / 個別行は先頭3本 / 集約は 10 秒に1行 / 遅延は 3 回まで無料で最大 2 秒。
const AUTH_FAIL_WINDOW_MS = 5 * 60 * 1000;

/**
 * 🚨 **遅延だけではレートを縛れない（8回目のレビュー。SERIOUS）。**
 *
 * 遅延は「1本ずつを遅くする」だけで、**同じ相手が同時に何本投げられるか**を
 * 制限しない。だから総当たりの速さは遅延ではなく**攻撃側の並列度**で決まる。
 * 実測（`--require-auth --token <40字>`、node:http で同一 peer）:
 *   直列 8 本   : 1,556 ms（= 遅延は効いている。7回目のテストが見ていたのはこれだけ）
 *   並列 300 本 : 2,142 ms / 全部 401 / **140 回/秒**
 *   並列 1200 本: 2,474 ms / 全部 401 / **485 回/秒**
 *
 * ⚠️ **トレードオフを隠さない:** トンネル越しでは peer が全部 127.0.0.1 なので
 *    攻撃と正規の利用者を区別できない。総当たりが続いている間は正規の要求も
 *    429（Retry-After）になりうる。**唯一の壁がトークンである**以上、
 *    「当てる速さを縛る」を「無中断で応答する」より優先する。
 */
const PREAUTH_MAX_INFLIGHT = 2;

/** 連続失敗から遅延（ms）を決める。純関数なのでテストで固定できる */
export function authFailDelay(count) {
    return failDelay(count);
}

function peerKey(req) {
    return req.socket.remoteAddress ?? '(不明)';
}

/**
 * 🔒 読み取りの壁（`authed()` = 401）の3点セット。
 */
const authGate = makeInflightGate(PREAUTH_MAX_INFLIGHT);
const authFails = makeFailTracker({
    audit: rec => auditExec(rec),
    event: 'auth-failed', summaryEvent: 'auth-failed-summary',
    windowMs: AUTH_FAIL_WINDOW_MS,
});

/**
 * 🔒 **実行・書き込みの壁（`gateMutation()` = 403）の3点セット（#48）。**
 *
 * 🚨 **読み取りの壁と共有してはいけない。** 別の capability の壁なので、
 *    数と遅延を混ぜると「読み取りの失敗で実行が絞られる」「その逆」が起きる。
 * 🚨 **なぜ要るか（実測 8,955 req/s）。** 入口の `authed()` は**読み取り用の
 *    派生秘密**でも通る。その秘密は案内の URL に載り、スマホのブックマークや
 *    履歴に残る = 広く出回る。だから「読み取りの鍵を持っている相手」が
 *    実行トークンを**絞りも記録も無しに**総当たりできる状態だった
 *    （read から exec への昇格路。7回目に読み取り側だけ塞いだのが取り残し）。
 */
const MUTATION_MAX_INFLIGHT = 2;
const mutationGate = makeInflightGate(MUTATION_MAX_INFLIGHT);
const mutationFails = makeFailTracker({
    audit: rec => auditExec(rec),
    event: 'mutation-token-failed', summaryEvent: 'mutation-token-failed-summary',
    windowMs: AUTH_FAIL_WINDOW_MS,
});
/**
 * 🔒 **実行トークンを1度でも通した値の控え。**
 *
 * 🚨 **読み取り側の控え（`goodSecrets`）を使い回してはいけない。** あれは
 *    読み取り用の派生秘密でも真になるので、読み取りの鍵を持つ相手が
 *    混雑の門を素通りして総当たりを続けられる（= 直した意味が消える）。
 *    ここに入るのは**実行トークンに合った値だけ**。
 */
const goodTokens = makeGoodSet({});

/**
 * 🚨 **一度通った資格情報は門の外に置く（正規の利用者を締め出さないため）。**
 *
 * 実測（持続攻撃: 並列50を6秒）: 門だけだと当てる速さは 485 → 1.8 回/秒に落ちるが、
 * **正規のトークンも 15 本中 0 本しか通らなくなった**（トンネル越しでは peer が
 * 全部 127.0.0.1 なので、peer では攻撃と正規を区別できない）。
 * 区別できるのは**トークンを知っているかどうか**だけなので、
 * 「過去に通った値そのもの」を覚えておいて、それを提示した要求は門を通さない。
 *
 * ⚠️ **これは認可の代わりではない。** 素通りするのは**混雑の門だけ**で、
 *    `authed()` は必ず通る（つまり値が本当に合っていなければ 401 になる）。
 * ⚠️ 残る穴を隠さない: **攻撃が始まった後の「初回」の認証**は 429 になりうる
 *    （まだ1度も通っていない端末は覚えられていない）。再試行が要る。
 */
const goodSecrets = makeGoodSet({});

function presentedSecrets(req, url) {
    const vals = [];
    const h = req.headers[TOKEN_HEADER];
    if (typeof h === 'string') vals.push(h);
    const q = url.searchParams.get('token');
    if (typeof q === 'string') vals.push(q);
    for (const c of readCookies(req, AUTH_COOKIE)) vals.push(c);
    return vals;
}

function knownGoodSecret(vals) {
    return goodSecrets.has(vals);
}

/**
 * 🔒 **実行トークンの提示を「壁」として判定する（#63。10回目のレビュー / SERIOUS）。**
 *
 * `/api/v0/state` は `execSessions`（argv = 打ったコマンド行）を
 * **生の実行トークンを提示した相手にだけ**返す。その判定に `presentedToken()` を
 * 直接呼んでいたので、**読み取りの鍵しか持たない相手が実行トークンを
 * 1要求1bit で総当たり**できた。読み取りの門は既に通っているので 200 が返り、
 * `execSessionsHidden` の有無が**完全なオラクル**になる。
 *
 * 実測: Cookie（読み取り用）を付けて `?token=<誤り>` を300回 → **120ms（2500 req/s）、
 * 401 も 429 も遅延も無く、監査ログに1行も残らない**。
 * 同じ誤り値を `/api/v0/exec/list` に投げると1回あたり約1.6秒（門が効いている）。
 *
 * 🚨 **「唯一の壁になるものには下限・記録・遅延を必ず付ける」の対象そのもの。**
 *    当たれば実行トークンが確定し、そのまま任意コード実行に昇格する。
 *
 * ⚠️ **「提示していない」を失敗として数えない。** UI は15秒ごとに `/state` を叩くので、
 *    トークンを持たない普通の読み取りを失敗に数えると**正規の利用が遅くなる**
 *    （壁が利用者を殴る）。
 * ⚠️ **読み取り用の派生秘密は「推測」ではない。** 案内 URL の `?token=` はこの値なので、
 *    それを失敗に数えると**スマホで開くたびに遅延が積まれる**。
 *
 * @returns {Promise<{ok: boolean, handled: boolean}>} handled=true なら応答済み（429）
 */
async function presentedTokenAudited(req, res, url) {
    const vals = presentedSecrets(req, url);
    if (!vals.length) return { ok: false, handled: false };
    // 既に実行トークンとして通った値は、門を素通りさせる（比較は必ず通る）
    if (goodTokens.has(vals)) return { ok: presentedToken(req, url), handled: false };
    // 読み取り用の秘密しか提示していないなら「実行トークンの試行」ではない
    const secret = cookieSecret();
    if (!vals.some(v => !secretMatches(v, secret))) return { ok: false, handled: false };
    return tokenWall(req, res, vals, () => presentedToken(req, url));
}

/**
 * 🔒 **実行トークンの壁（#48）。門 → 比較 → 外したら記録して遅延。**
 *
 * ⚠️ **1箇所だけに置く。** #63 で `/state` と `/session` にも壁が要ると分かったとき、
 *    最初は同じ手順を書き写した。すると **`gateMutation` を測っていた変異4件が
 *    「2箇所に一致する」で STALE**（= 実行の壁が1つも検証されない状態）になった。
 *    CLAUDE.md の「`gone` は同じ式が他所にできた瞬間に無効化される」の実例。
 *    守りを増やすときは**写すのではなく1箇所に集める**。
 *
 * ⚠️ 順序が守りの本体。混雑の門は**比較の手前**。後ろに置くと 429 が
 *    「その値は違った」の同義語になり、当てる速さは並列度で決まったままになる。
 *
 * @param {string[]} vals 提示された候補（門を素通しさせてよいかの判定に使う）
 * @param {() => boolean} compare 実際の比較（ここだけが値を見る）
 * @returns {Promise<{ok: boolean, handled: boolean}>} handled=true なら応答済み（429）
 */
async function tokenWall(req, res, vals, compare) {
    const peer = peerKey(req);
    // 🔒 1度でも実行トークンを通した値は混雑の門を素通りさせる
    //    （素通りするのは門だけ。比較は必ず通るので、合っていなければ弾かれる）。
    const trusted = goodTokens.has(vals);
    if (!trusted && !mutationGate.acquire(peer)) {
        mutationFails.shed(peer);
        res.writeHead(429, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'retry-after': '1',
        });
        res.end(JSON.stringify({
            error: '認証前の要求が同時に多すぎます。少し待ってから試してください',
        }));
        return { ok: false, handled: true };
    }
    try {
        const ok = compare();
        if (ok) goodTokens.remember(vals);
        // 🚨 **外したら記録して遅延する。** ここが無いと痕跡ゼロで総当たりできた
        //    （実測 8,955 req/s。読み取り側だけ塞いで実行側が取り残しだった）。
        //    ⚠️ 遅延の間も枠を握る。これが「並列でも縛れる」の本体。
        else await mutationFails.note(peer, { ...originHint(req), path: pathOf(req) });
        return { ok, handled: false };
    } finally {
        if (!trusted) mutationGate.release(peer);
    }
}

function rememberGoodSecret(vals) {
    // ⚠️ **通った要求が提示した値を全部覚えてはいけない。** 偽の Cookie を
    //    正しいトークンと一緒に送るだけで、その偽の値が門を素通りする鍵になる
    //    （#43 と同じ「合っていない本数は理由にならない」型）。**合った値だけ**覚える。
    goodSecrets.remember(vals.filter(v => tokenMatches(v) || secretMatches(v, cookieSecret())));
}

async function noteAuthFail(req, url) {
    return authFails.note(peerKey(req), { ...originHint(req), path: url.pathname });
}

function noteAuthShed(peer) {
    return authFails.shed(peer);
}

/**
 * 🔒 その要求が**トークン本体**を提示しているか（Cookie では真にならない）。
 *
 * トークンを見せてよい相手を「既に持っている相手」に限るための判定。
 * Cookie は他ポートに漏れるので、Cookie 認証は読み取りまでで打ち止めにする。
 */
function presentedToken(req, url) {
    return tokenMatches(req.headers[TOKEN_HEADER])
        || tokenMatches(url.searchParams.get('token'));
}

/**
 * 🔒 **読み取り専用の派生秘密が提示されたか。**
 *
 * 案内の URL（`?token=…`）に載せるのはこの値だけにする。**生トークンは載せない。**
 * 理由（8回目のレビュー。SERIOUS）: `--exec` のデーモンでは秘密が1本だったので、
 * 「スマホで1回開いてください」と案内する URL に**任意コード実行の資格情報が
 * 平文で載っていた**。URL はアドレスバーに出て、オムニボックスの履歴に入り、
 * ブックマーク（= クラウド同期）に残り、クエリを記録する中継にも残る。
 * ページ側の `history.replaceState` はカレントの履歴エントリを差し替えるだけで、
 * それらは消せない。
 */
function presentedReadSecret(req, url) {
    const s = cookieSecret();
    if (!s) return false;
    return secretMatches(req.headers[TOKEN_HEADER], s)
        || secretMatches(url.searchParams.get('token'), s);
}
function authed(req, url) {
    if (!opts.requireAuth) return true;
    // 🚨 Cookie は**読み取り用の別の秘密**とだけ照合する。
    //    ここで実行トークンとも照合してしまうと、Cookie を受け取った
    //    他のローカルサービスがそのまま実行できる状態に戻る。
    // ⚠️ **「どれか1本が合っていれば通す」。** 偽 Cookie を先頭に置くだけで
    //    締め出せてはいけない（#43）。合っていない本数は通す理由にもならない。
    return readCookies(req, AUTH_COOKIE).some(v => secretMatches(v, cookieSecret()))
        // 🔒 案内の URL に載せる読み取り専用の派生秘密。これで**読み取りだけ**通る
        //    （exec / checkout / トークン払い出しは presentedToken = 生トークンのみ）
        || presentedReadSecret(req, url)
        || tokenMatches(req.headers[TOKEN_HEADER])
        || tokenMatches(url.searchParams.get('token'));
}

/**
 * 通ってよければ true。駄目なら応答を書いて false。
 *
 * 4つ全部を要求する:
 *   1. --allow-write（ケイパビリティ。既定オフ）
 *   2. POST（GET で副作用を起こさない。リンクや prefetch で発火しないため）
 *   3. Sec-Fetch-Site が same-origin（ブラウザからの他サイト起点を弾く）
 *   4. X-Kjp-Token（カスタムヘッダなので cross-origin では preflight が必須になる。
 *      ⚠️ これが CSRF 対策の本体。フォーム POST は preflight されないので、
 *      カスタムヘッダを必須にしないと素通りする）
 */
async function gateMutation(req, res) {
    if (!opts.allowWrite) {
        denyJson(res, 403, '書き込みは無効です。--allow-write を付けて起動してください');
        return false;
    }
    if (req.method !== 'POST') {
        denyJson(res, 405, 'POST のみ受け付けます');
        return false;
    }
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') {
        denyJson(res, 403, `別サイト起点の書き込みは拒否します (Sec-Fetch-Site: ${site})`);
        return false;
    }
    // 🚨 **ここから下がトークンの壁（#48）。比較の手前に混雑の門を置く。**
    //    ⚠️ 順序が守りの本体。比較の後ろに置くと 429 が「その値は違った」の
    //       同義語になり、当てる速さは並列度で決まったままになる。
    const given = req.headers[TOKEN_HEADER];
    const vals = typeof given === 'string' ? [given] : [];
    // 壁の中身は `tokenWall()` に1本化してある（写すと変異が効かなくなる。#63）
    const r = await tokenWall(req, res, vals, () => tokenMatches(given));
    if (r.handled) return false;
    if (!r.ok) {
        denyJson(res, 403, `${TOKEN_HEADER} が一致しません`);
        return false;
    }
    return true;
}

/** 記録に残す経路名。**トークンの候補は残さない**（本文もクエリも入れない） */
function pathOf(req) {
    try { return new URL(req.url, 'http://localhost').pathname; } catch { return null; }
}

/**
 * 🔒 実行の関門。書き込みの関門に加えて --allow-exec を要求する。
 *
 * ⚠️ 「遠隔から実行できる」は定義上そのまま remote code execution。
 *    機能と脆弱性を分けるのは実装ではなく**誰が引けるか**だけ。
 *    だから allowlist で安全を装わない。`git` を許すだけで
 *    `git -c alias.x='!sh -c ...' x` から任意コードが動くので、
 *    ゆるい allowlist は気休めにしかならない。**扉を守る方に賭ける。**
 */
async function gateExec(req, res) {
    if (!opts.allowExec) {
        denyJson(res, 403, '実行は無効です。--allow-exec を付けて起動してください');
        return false;
    }
    return gateMutation(req, res);
}

/**
 * 🔒 **作業ツリーにファイルを書く経路の関門。`/api/v0/file` と `/api/v0/write` の
 *    両方が必ずここを通る**（副作用のある経路を足すときは経路を散らさない、の実装）。
 *
 * v0 で**初めて「作業ツリーにファイルの中身を書く」経路**なので、
 * 認可を通った後も次の順序で必ず絞る。**順序そのものが守りの本体**:
 *
 *   1. `isSafeRepoPath()` — `..` / 絶対パス / ドライブレター / 先頭 `-` /
 *      NUL / pathspec magic を弾く。**最初に置く理由**: これを通っていない値を
 *      git にも fs にも渡さない（後段は全部この値を使う）
 *   2. 対象 worktree が**既知**で bare でも prunable でもないこと。
 *      **fs に触る前に置く理由**: 知らないディレクトリを基準にパスを解決しない
 *   3. **git の追跡下にあること**（`ls-files --error-unmatch`）。
 *      **fs で開く前に置く理由**: これが「未追跡の `.env` に触れる経路を作らない」
 *      という不変条件の本体。読むのも書くのも「コミットに入っているもの」に限る
 *   4. **実体が worktree の中にあること**（`realpath` 包含 + symlink の拒否）。
 *      追跡下でも**中身が symlink なら実体はリポジトリ外にありうる**
 *      （`git update-index --cacheinfo 120000` でコミットできる）。
 *      `containsPath()` は realpath するので 8.3 短縮名 / symlink / 大文字小文字を吸収する
 *   5. 中身を読む（上限 / バイナリ / 改行コードの混在を拒否）
 *
 * 🚨 **`fs` で読む唯一の経路。** `git cat-file` 経由という読み取り側の不変条件
 *    （CLAUDE.md）をここだけ破る。理由: エディタは**未コミットの現在の中身**を
 *    見せなければならず、それは git のオブジェクトDB に無い。代わりに
 *    「`--allow-write` の capability + トークン + 追跡下 + realpath 包含」の
 *    4つを全部要求する。読み取り専用のデーモン（capability 無し）からは
 *    この経路そのものが存在しない。
 *
 * ⚠️ **返した `fh` は呼び出し側が必ず閉じる。** 失敗時はここで閉じて null を返す。
 * ⚠️ 検査と `open` の間にディレクトリを差し替える競争は塞げていない
 *    （`O_NOFOLLOW` は最終要素にしか効かず、Windows には無い）。
 *    同じマシンで動く別のプロセスが敵なら防げない — この経路は
 *    「同じマシンの自分のエージェント群」を前提にしている。
 *
 * @returns {Promise<null|{wt: object, rel: string, abs: string, fh: object,
 *                         buf: Buffer, info: object}>}
 */
async function requireEditTarget(req, res, body, { forWrite, repo }) {
    // ---- 1. パスの形
    const rel = toNFC(String(body.path ?? ''));
    if (!isSafeRepoPath(rel)) {
        denyJson(res, 400, `path が不正です: ${rel.slice(0, 120)}`);
        return null;
    }
    // ---- 2. 対象 worktree（既知のものだけ。ここを緩めるとリポジトリ外に書ける）
    const wantPath = toNFC(String(body.worktree ?? ''));
    // 🔒 **allowlist は「選択中のリポジトリ」の worktree 一覧に対して引く**
    //    （exec / checkout / merge と同じ。全リポジトリの合併にすると
    //     A を選んでいるのに B のファイルを書ける = `?repo=` の意味が消える）。
    const worktrees = await listWorktrees(repo);
    const wt = worktrees.find(w => samePath(w.path, wantPath));
    if (!wt) { denyJson(res, 400, `既知の worktree ではありません: ${wantPath}`); return null; }
    if (wt.bare) { denyJson(res, 400, 'bare worktree にはファイルを書けません'); return null; }
    if (wt.prunable) { denyJson(res, 409, '作業ツリーが失われています'); return null; }

    // ---- 3. git の追跡下にあること（未追跡は拒否）
    // ⚠️ `--error-unmatch` は一致しないと exit 1。失敗と区別するため allowExit で受ける。
    // ⚠️ **出力に「まさにそのパス」が含まれることまで見る。** ディレクトリを渡すと
    //    その下のファイルが並んで exit 0 になるので、`code === 0` だけでは足りない。
    // 🔒 **内容を変換しない git コマンドだけを使う。** `status` / `diff` / `add` は
    //    作業ツリーと index の中身を比べるので **`.gitattributes` の clean filter
    //    （= リポジトリ設定の任意コマンド）を起動する**（8回目のレビューの BLOCKING）。
    //    `ls-files` は index を読むだけで content conversion を伴わない。
    //    ここに1つ変換を伴う呼び出しを足すと、この経路が capability を1段上げる。
    let ls;
    try {
        ls = await git(['ls-files', '--error-unmatch', '-z', '--', rel],
            { cwd: wt.path, allowExit: [0, 1], withCode: true });
    } catch (err) {
        denyJson(res, 500, `追跡状態を確認できませんでした（書きません）: ${err.message}`);
        return null;
    }
    if (ls.code !== 0 || !splitZ(ls.stdout).map(p => toNFC(p)).includes(rel)) {
        denyJson(res, 400,
            `git の追跡下にありません: ${rel}。`
            + ' 画面から編集できるのは追跡されているファイルだけです'
            + '（未追跡の .env などに触れる経路を作らないため）');
        return null;
    }

    // ---- 4. 実体が worktree の中にあること
    // ⚠️ **`insideRepoGate()` で代用してはいけない**（同じ判断ではない）。
    //    あれは「秘密の置き場所がリポジトリの**どこか**に入っていないか」を
    //    起動時に1回見る門で、**どの worktree でも / `.git` の中でも真**になる。
    //    ここが要るのは「**この** worktree の中か」で、`.git` の中も他の worktree も
    //    通してはいけない。極性（外にあれ / 中にあれ）も逆。共通化すると緩む。
    const abs = join(wt.path, rel);
    if (!containsPath(wt.path, abs)) {
        denyJson(res, 400, `実体が worktree の外を指しています: ${rel}`);
        return null;
    }
    let lst;
    try {
        lst = await lstat(abs);
    } catch (err) {
        denyJson(res, 409,
            `作業ツリーにファイルがありません（${err.code ?? err.message}）: ${rel}`);
        return null;
    }
    if (lst.isSymbolicLink()) {
        denyJson(res, 400,
            `シンボリックリンクは編集しません: ${rel}（実体がどこを指すか保証できません）`);
        return null;
    }
    if (!lst.isFile()) {
        denyJson(res, 400, `通常のファイルではありません: ${rel}`);
        return null;
    }

    // ---- 5. 中身
    // 🔒 `O_NOFOLLOW` を足す（POSIX のみ。最終要素の symlink 差し替えを atomic に弾く）
    const flags = (forWrite ? FS.O_RDWR : FS.O_RDONLY) | (FS.O_NOFOLLOW ?? 0);
    let fh;
    try {
        fh = await open(abs, flags);
    } catch (err) {
        denyJson(res, 409,
            `開けませんでした（${err.code ?? err.message}）: ${rel}`
            + (err.code === 'EACCES' || err.code === 'EPERM'
                ? '。読み取り専用のファイルは画面から編集できません' : ''));
        return null;
    }
    const fail = async (code, msg) => {
        await fh.close().catch(() => { /* 既に閉じている */ });
        denyJson(res, code, msg);
        return null;
    };
    try {
        // fstat（開いたハンドル自身を見る）。パスをもう一度辿らないので差し替えに強い
        const st = await fh.stat();
        if (!st.isFile()) return fail(400, `通常のファイルではありません: ${rel}`);
        if (st.size > MAX_EDIT_BYTES) {
            return fail(413,
                `${MAX_EDIT_BYTES} バイトを超えるファイルは画面から編集しません`
                + `（${st.size} バイト）`);
        }
        const buf = await fh.readFile();
        const info = inspectBytes(buf);
        if (info.binary) {
            return fail(400, `バイナリファイルは編集しません: ${rel}`);
        }
        if (info.mixed) {
            // 🚨 「分からないなら分からないと言う」。どちらに寄せても
            //    **触っていない行が変わる**ので、推測して直さない。
            return fail(409,
                `改行コードが混在しています（CRLF ${info.counts.crlf} / LF ${info.counts.lf}`
                + ` / CR ${info.counts.cr}）。どちらに寄せても触っていない行が変わるので、`
                + '画面からは編集しません。端末で揃えてください');
        }
        return { wt, rel, abs, fh, buf, info };
    } catch (err) {
        return fail(500, `読めませんでした（書きません）: ${err.message}`);
    }
}

/**
 * 実行の監査ログ。1行1JSON で $GIT_DIR に追記する（追跡されない場所）。
 * 何をいつ走らせたかが残らないと、後から事故を追えない。
 */
/**
 * ⚠️ 既定の場所（`<GIT_DIR>/kjp-exec-audit.jsonl`）は**実行した相手が消せる。**
 *    `--audit-log <path>` でリポジトリ外に出せば消されにくくなる。
 *    レビューで指摘された弱点で、実装では消せない（実行を許した相手は
 *    そのマシンで何でもできる）ので、置き場所を選べるようにするのが上限。
 * ⚠️ commonDir() を毎回叩くと exec 1回につき git が余分に起動するので
 *    起動時に1回だけ解決して持つ。
 */
/**
 * ⚠️ **リポジトリごとに解決する。** 既定の置き場所は `<GIT_DIR>` なので、
 *    複数リポジトリを見ているときに1本目の GIT_DIR へまとめると
 *    「B で走らせた記録が A の .git にある」になる。
 *    `--audit-log` を明示した場合は1本にまとまるので、記録側に `repo` を載せる。
 */
const auditPathByRepo = new Map();
async function auditLogPath(repo) {
    if (opts.auditLog) return opts.auditLog;
    const key = repo ?? opts.repos[0];
    const hit = auditPathByRepo.get(key);
    if (hit) return hit;
    const p = join(await commonDir(key), 'kjp-exec-audit.jsonl');
    auditPathByRepo.set(key, p);
    return p;
}

/**
 * 🚨 **上限と回転を付ける（8回目のレビュー）。**
 *
 * 既定の置き場所は `.git` の中で、しかも**認証前の 401 も同じファイルに追記する**ので、
 * 上限が無いと外から容量を食える。並列度の門で追記の本数は縛ったが、
 * それでも「長く動かす」だけで伸びるので**大きさ自体に上限**を置く。
 * ⚠️ 回転は記録を捨てる操作なので、**捨てたことを新しいファイルの先頭に残す**
 *    （`event: "audit-rotated"`）。前の世代（`.1`）を上書きしたかどうかも書く。
 *
 * 🚨 **サイズは「パスごと」に覚える。** 複数リポジトリでは既定の置き場所が
 *    `<GIT_DIR>/kjp-exec-audit.jsonl` なので**ファイルが複数ある**。
 *    1つの変数で数えると別のファイルの大きさで回転を判断することになり、
 *    **まだ小さいファイルを回す**／**上限を超えたファイルを回さない**の両方が起きる
 *    （`--audit-log` を明示した構成では1本にまとまるので、そのときは1エントリ）。
 */
const auditBytesByPath = new Map();   // path -> 分かっている現在のサイズ

async function auditExec(entry, repo = null) {
    try {
        const { appendFile, stat, rename } = await import('node:fs/promises');
        const path = await auditLogPath(repo);
        const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
        const len = Buffer.byteLength(line, 'utf8');
        let auditBytes = auditBytesByPath.get(path) ?? null;
        if (auditBytes === null) {
            auditBytes = await stat(path).then(s => s.size, () => 0);
        }
        if (auditBytes + len > opts.auditMaxBytes) {
            const kept = `${path}.1`;
            const had = await stat(kept).then(() => true, () => false);
            await rename(path, kept);
            const notice = `${JSON.stringify({
                at: new Date().toISOString(), event: 'audit-rotated',
                keptAs: kept, bytes: auditBytes, limit: opts.auditMaxBytes,
                // ⚠️ 前の世代は上書きされる = **そこにあった記録は失われた**
                discardedPrevious: had,
            })}\n`;
            await appendFile(path, notice, 'utf8');
            auditBytes = Buffer.byteLength(notice, 'utf8');
            console.error(`⚠ 監査ログが上限（${opts.auditMaxBytes} B）に達したので`
                + ` ${kept} に回しました${had ? '（前の世代は上書きされました）' : ''}`);
        }
        await appendFile(path, line, 'utf8');
        auditBytesByPath.set(path, auditBytes + len);
    } catch (err) {
        // 監査に失敗しても実行は続ける。ただし黙らない
        console.error(`⚠ 監査ログを書けませんでした: ${err.message}`);
    }
}

/**
 * 🔒 **記録に残す「どこから来たか」。**
 *
 * 🚨 **トンネル越しだと `peer` は必ず `127.0.0.1` になる。**
 *    `tailscale serve` はこのマシンで TLS を終端して 127.0.0.1 に中継するので、
 *    スマホからの実行も母艦のブラウザからの実行も**記録上は区別できない**
 *    （実データで確認: `--exec` を開けた後の start/input が全部 127.0.0.1）。
 *    「誰が動かしたか」を答えられないのは、観測ツールとしては黙っていてよい話ではない。
 *
 * ⚠️ **`x-forwarded-for` は自己申告で、認可には使えない。**
 *    ループバックに届く相手なら誰でも好きな値を書ける。だから
 *    **`xffReported`（申告）という名前で、値をそのまま信じない前提で残す。**
 *    中継が付けていなければ null（「分からない」を「無い」と書かない）。
 */
function originHint(req) {
    const raw = req.headers['x-forwarded-for'];
    const first = typeof raw === 'string' ? raw.split(',')[0].trim() : null;
    return {
        peer: req.socket.remoteAddress ?? null,
        host: req.headers.host ?? null,
        // 長い値で記録を埋めない。形の検証はしない（申告をそのまま短く残す）
        xffReported: first ? first.slice(0, 64) : null,
    };
}

/**
 * 🔒 **マスクに使う「値が分かっている秘密」。**
 *
 * 1箇所にまとめる（記録のコマンド行と exec の argv の両方で使う）。
 * 片方だけ渡していると、同じ秘密が別経路から出る。
 */
function secretsForMasking() {
    return [opts.token, cookieSecret()].filter(Boolean);
}
/** 同時実行数の上限。無制限だとマシンを埋められる。 */
const MAX_CONCURRENT_EXEC = 8;

/**
 * 終了処理が始まったか。
 *
 * 🚨 **宣言をここに置くのは意図的。** `shutdown()` の隣に置くと、
 *    経路側（`POST /api/v0/exec` の門）から見て TDZ の危険が出る形になる。
 *    門は「必ず立っている値」を見る必要がある。
 */
let shuttingDown = false;

/**
 * 撃つ**前**に、その pid の子孫の pid を集める。
 *
 * 🚨 **撃った後では集められない。** 中間プロセスが消えると孫は木から外れるので、
 *    「何を数え直すべきか」が永久に分からなくなる。だから kill の前に取る。
 * 🚨 **「調べられない」を「0 件」と言わない**（`scripts/serve.mjs` の `running()` と
 *    同じ型）。0 と言うと「巻き込むものは無い / 残っているものは無い」という**断言**になる。
 * @returns {Promise<{supported: boolean, pids: number[], why: string|null}>}
 */
async function procTreePids(pid) {
    const { execFile } = await import('node:child_process');
    const run = (cmd, args) => new Promise(resolve => {
        execFile(cmd, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
            (err, stdout) => resolve(err ? null : stdout));
    });
    let out = null;
    if (process.platform === 'win32') {
        // ⚠️ `wmic` は新しい Windows では消えている。CIM で pid と親 pid だけ出す
        const ps = 'Get-CimInstance Win32_Process | ForEach-Object '
            + '{ "$($_.ProcessId)`t$($_.ParentProcessId)" }';
        out = await run('powershell', ['-NoProfile', '-Command', ps]);
        if (out === null) return { supported: false, pids: [], why: 'PowerShell で木を辿れませんでした' };
    } else {
        out = await run('ps', ['-eo', 'pid=,ppid=']);
        if (out === null) return { supported: false, pids: [], why: 'ps で木を辿れませんでした' };
    }
    return { supported: true, pids: descendantsOf(parseProcPairs(out), pid), why: null };
}

/**
 * プロセスを**木ごと**殺す。
 *
 * ⚠️ Windows の `child.kill()` は TerminateProcess 相当で、その1プロセスしか殺さない。
 *    中間が `cmd.exe` だと孫が残り、しかも孫が stdout パイプを握るので
 *    `close` イベントが永久に来ない → `runningExec` が戻らない → 8回で exec が死ぬ。
 *    （`.cmd` は shell:false で spawn できないので、Windows で `npm test` を動かす
 *      唯一の道が `cmd /c npm test` = まさにこの形。避けられない経路だった）
 * ⚠️ **列挙の分だけ /kill の応答が遅くなる**（Windows で実測 390〜414ms。
 *    大半は PowerShell の起動で、`-Query` で2列に絞っても同じ）。
 *    「停止を要求されました」は撃つ前に流しているので画面はすぐ反応する。
 *    嘘をつかないためのコストとして払う。
 */
async function killTree(child) {
    if (!child.pid) return { killed: true, why: null };
    const pid = child.pid;
    const tree = await procTreePids(pid);
    let taskkillCode = null;
    if (process.platform === 'win32') {
        // Windows: taskkill /T で木ごと
        try {
            const { execFile } = await import('node:child_process');
            // 🚨 **終了コードを捨てない。** アクセス拒否・taskkill 不在・木から外れた孫を
            //    「成功」と区別できないまま `signal:"SIGKILL"` と記録していた
            taskkillCode = await new Promise(resolve => {
                execFile('taskkill', ['/PID', String(pid), '/T', '/F'],
                    { windowsHide: true }, err => resolve(err ? (err.code ?? 1) : 0));
            });
        } catch { /* taskkill が無い環境では下の kill に任せる */ }
    } else {
        // ⚠️ POSIX も同じ問題がある。`sh -c "node x & wait"` の sh を SIGKILL しても
        //    バックグラウンドの node は別プロセスとして残る（ubuntu CI で実測）。
        //    spawn 側で detached:true にしてプロセスグループを作り、
        //    ここで -pid に送ってグループごと殺す。
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* グループが無い/既に死んでいる */ }
    }
    try { child.kill('SIGKILL'); } catch { /* 既に死んでいる */ }
    // 孫がパイプを握っていても応答を閉じられるようにする
    try { child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* noop */ }

    // 🚨 **「停止しました」は数え直してから書く**（CLAUDE.md）。この規則は
    //    `scripts/serve.mjs` の `running()` にしか適用されておらず、
    //    ここには数え直しが無かった（「規則を書いた場所から遠いコードには
    //    適用し忘れる」型）。失敗しても `signal:"SIGKILL"` と記録し、
    //    `/kill` は `{ok:true}` を返し、以後 sweep は候補にせず、
    //    **回復経路が1つも無い**状態になっていた。
    // 🚨 **数え直しは「木」に対して行う**（9回目のレビュー）。以前は
    //    **直接の子だけ**を見ていたので、中間が先に死んで木から外れた孫は
    //    `taskkill /T` でも落ちず、しかも数え直しに掛からないので
    //    `{ok:true}` / `signal:"SIGKILL"` / 「⚠ 停止しました」を返していた
    //    （レビュアーの実測: 200 を返した後も pid 31596 が生きていた）。
    //    観測ツールが「止めたつもりで走り続けている」と言うのは最悪の誤り。
    const taskkillNote = taskkillCode ? `taskkill は exit ${taskkillCode}` : null;
    for (let i = 0; i < 20; i++) {
        const selfDead = child.exitCode !== null || child.signalCode !== null
            || stillAlive([pid]).length === 0;
        const left = stillAlive(tree.pids);
        if (selfDead && left.length === 0) {
            // 🚨 **成功分岐でも `taskkillCode != 0` と「木を辿れなかった」を捨てない。**
            //    捨てると「確認できた停止」と「確認できていない停止」が同じ文言になる。
            const doubts = [
                tree.supported ? null : `${tree.why}（孫が残っているかは確認できていません）`,
                taskkillNote,
            ].filter(Boolean);
            return { killed: true, why: doubts.length ? doubts.join(' / ') : null };
        }
        await new Promise(r => setTimeout(r, 100));
    }
    const survivors = [...new Set([
        ...(stillAlive([pid]).length && child.exitCode === null && child.signalCode === null ? [pid] : []),
        ...stillAlive(tree.pids),
    ])];
    return {
        killed: false,
        why: `木の一部を確認できませんでした（pid ${survivors.join(', ') || pid} がまだ生きています）`
            + (taskkillNote ? `（${taskkillNote}）` : ''),
    };
}

/**
 * 実行セッションの台帳（#17）。
 *
 * 🚨 **クライアント切断で子プロセスを殺すのをやめた。** モバイルブラウザは
 *    タブを積極的に停止するので、スマホから投げた `npm test` がその瞬間に死んでいた。
 *    代わりに寿命を明示的に管理する（v0/execsession.mjs に方針を集約）。
 *
 * ⚠️ サーバ終了時に置き去りにしないのは変わらず必要
 *    （Windows では libuv が SILENT_BREAKAWAY_OK を立てるので、
 *      サーバが死んでも孫は回収されない）。
 */
const execRegistry = new ExecRegistry({
    execTimeoutMs: opts.execTimeoutMs,
    limits: {
        maxConcurrent: MAX_CONCURRENT_EXEC,
        detachedGraceMs: opts.execDetachedGraceMs,
        retainMs: opts.execRetainMs,
    },
});

/**
 * セッションを購読して ndjson で流す。
 *
 * 🚨 **切断しても子プロセスを殺さない。** 購読をやめるだけ。
 *    殺すかどうかは台帳の sweep が決める（猶予を過ぎたら / 絶対上限を過ぎたら）。
 *    これが #17 の本体で、以前はここで killTree していた。
 *
 * ⚠️ 1行目に必ず `{t:'session', id, ...}` を出す。これが無いと
 *    クライアントは再接続先の id を知る手段が無い（POST の応答本文は
 *    ストリームなので、ヘッダやボディの先頭以外に置き場所がない）。
 * ⚠️ 取りこぼし（リングバッファの上限で捨てた分）は `missing` として告知する。
 *    黙って間を抜くと、利用者は出力が完全だと誤解する。
 */
function streamSession(req, res, s, from) {
    res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        // プロキシに溜め込ませない（トンネル越しで出力が止まって見えるのを防ぐ）
        'x-accel-buffering': 'no',
    });
    // 無音のコマンドでも「受理された」がすぐ分かるようにする
    res.flushHeaders?.();

    /**
     * 🚨 **読まない購読者に無制限に溜めない。**
     *
     * `res.write()` は相手が読まなくてもメモリに積む。ブラウザのタブが停止した
     * まま出力の多いコマンドを走らせると、**RSS が 72MB → 433MB まで伸びた**
     * （レビューで実測）。溜まりが上限を超えたら**その購読者を切る**。
     * データはリングバッファに残っているので、再接続すれば `from` で追いつける。
     */
    const MAX_PENDING_BYTES = 4 * 1024 * 1024;
    let dropped = false;
    const send = obj => {
        if (dropped || res.writableEnded) return;
        res.write(`${JSON.stringify(obj)}\n`);
        if (res.writableLength > MAX_PENDING_BYTES) {
            dropped = true;
            // ⚠️ 告知しようとしても、詰まっているので届かない。ログと監査に残す。
            console.error(`⚠ 追いつけていない購読者を切りました（session ${s.id}、`
                + `${Math.round(res.writableLength / 1024)}KB 未送信）`);
            auditExec({
                event: 'drop-subscriber', session: s.id, repo: s.repo ?? null,
                pendingBytes: res.writableLength,
            }, s.repo ?? null).catch(() => {});
            try { res.destroy(); } catch { /* 既に閉じている */ }
        }
    };

    const { replay, unsubscribe } = execRegistry.subscribe(s, from, rec => {
        send(rec);
        // 終わったら購読側も閉じる（クライアントに「まだ続く」と思わせない）
        if (rec.t === 'exit') { try { res.end(); } catch { /* 既に閉じている */ } }
    });

    send({
        t: 'session',
        id: s.id,
        state: s.state,
        keepAlive: s.keepAlive,
        worktree: s.worktree,
        seq: replay.seq,
        detachedGraceMs: s.keepAlive ? null : opts.execDetachedGraceMs,
        // 🚨 **絶対上限を必ず送る。** これが無いと UI は寿命について
        //    「切断しても最後まで走ります」しか言えず、**完走の約束**になっていた。
        //    実際は `--exec-timeout`（既定600秒）で SIGKILL される。
        //    「停止しましたと言って停止していない」の裏返しで、同じ型の食い違い
        //    （スマホで会話を始めて席を離れると10分で殺され、文脈は取り戻せない）。
        timeoutMs: opts.execTimeoutMs,
    });
    if (replay.missing > 0) {
        send({ t: 'err', d: `⚠ 出力が上限を超えたので ${replay.missing} 件を省略しました` });
    }
    for (const rec of replay.records) send(rec);
    // 再購読で、既に終わっていたら閉じる
    if (!s.running) { try { res.end(); } catch { /* noop */ } }

    let gone = false;
    const detach = async () => {
        if (gone) return;
        gone = true;
        unsubscribe();
        // 🚨 ここで killTree しない。それが以前の挙動で、スマホでは
        //    タブが停止した瞬間に会話やテストが死んでいた。
        if (s.running) {
            await auditExec({
                event: 'detach', session: s.id, repo: s.repo ?? null,
                graceMs: s.keepAlive ? null : opts.execDetachedGraceMs,
            }, s.repo ?? null);
        }
    };
    req.on('aborted', detach);
    res.on('close', detach);
    // 🚨 **応答が届く前に切られていたら、その場で detach する。**
    //    `streamSession` は `create()` → `await listWorktrees()` →
    //    `await auditExec()` → `spawn` の**後**に呼ばれる。この 150ms 以上の窓で
    //    クライアントが切ると `res` の 'close' は listener 登録より前に発火済みで、
    //    **detach が一度も走らない**。すると `subscribers` が 1 のまま残り、
    //    `lastDetachedAt` が永久に入らないので **#17 の「切断後の猶予」が
    //    完全に無効化**され、子は絶対上限（既定600秒）まで走る。
    //    しかも `/api/v0/state` は `subscribers:1 detachedMs:null` を返すので
    //    **誰も見ていないセッションが「接続中」と表示される**（嘘）。
    //    UI で「実行→停止」を素早く押すとこの窓に落ちる（レビューで実測）。
    //    ⚠️ **`req.destroyed` を見てはいけない。** 本文を読み切った正常な要求でも
    //    真になるので、**毎回 detach してしまい応答が永久に閉じない**（実測でハング）。
    //    見るのは応答側（切断されたら `res.destroyed` が立つ）。
    if (res.destroyed) detach();
}

/** 台帳の判断に従って実際に殺す・消す。1秒ごと。 */
let sweepTimer = null;
function startExecSweeper() {
    if (sweepTimer) return;
    sweepTimer = setInterval(async () => {
        const { kill, evict } = execRegistry.sweep();
        for (const { session, reason } of kill) {
            const note = reason === 'timeout'
                ? `⚠ 上限時間 ${opts.execTimeoutMs / 1000}s を超えたので停止します`
                : `⚠ 切断されたまま ${opts.execDetachedGraceMs / 1000}s 経ったので停止します`;
            // ⚠️ 二重に殺しに行くのを防ぐため `killRequested` を先に立てる
            //    （`sweep()` はこれが立っているセッションを候補にしない）。
            // 🚨 **殺してから終端する。** finish が先だと、実際に死ぬまでの出力が
            //    `exit` の後ろに並んで live には届かず、殺せなかった場合も
            //    「停止しました」と記録してしまう（`/kill` と同じ理由）。
            session.killRequested = reason;
            // 🚨 **理由は殺す前に流す。** 殺してから終端する順序にしたので、
            //    子の 'exit' ハンドラが先に終端することがあり（実測: `code:1`）、
            //    finish に載せた note が**捨てられて停止理由が消えた**
            //    （「なぜ止まったか」が読めなくなる = 観測ツールとして本末転倒）。
            //    先に理由を1件流せば、実際の終了コードと両方が残る。
            execRegistry.emit(session, 'err', `${note}\n`);
            await auditExec({
                event: 'kill', reason, session: session.id, repo: session.repo ?? null,
                worktree: session.worktree, argv: session.argv,
            }, session.repo ?? null);
            const r = session.child
                ? await killTree(session.child) : { killed: true, why: null };
            if (!r.killed) {
                session.killRequested = null;   // 次の tick で もう一度試せるように戻す
                execRegistry.emit(session, 'err', `⚠ 停止できませんでした: ${r.why}\n`);
                await auditExec({
                    event: 'kill-failed', reason, session: session.id, repo: session.repo ?? null,
                    worktree: session.worktree, argv: session.argv, why: r.why,
                }, session.repo ?? null);
                continue;
            }
            // 🚨 確認できていない点があるなら、それを添えて終端する
            //    （「停止しました」だけを残すと、確認できた停止と区別が付かない）
            if (r.why) {
                execRegistry.emit(session, 'err', `⚠ ${r.why}\n`);
                await auditExec({
                    event: 'kill-unverified', reason, session: session.id, repo: session.repo ?? null,
                    worktree: session.worktree, argv: session.argv, why: r.why,
                }, session.repo ?? null);
            }
            execRegistry.finish(session, {
                code: null, signal: 'SIGKILL',
                note: r.why ? `${note}（${r.why}）` : note,
            });
        }
        for (const s of evict) execRegistry.remove(s);
    }, 1000);
    // ⚠️ unref しておく。これだけでイベントループを生かし続けない
    sweepTimer.unref?.();
}

/**
 * 保存の本文の上限。
 *
 * ⚠️ 中身の上限（`MAX_EDIT_BYTES` = 512KB）より大きくする必要がある。
 *    JSON の文字列エスケープで最悪 6倍（`\u00xx`）に膨らむので、
 *    ここを 512KB にすると**上限ぎりぎりのファイルが保存できない**。
 *    大きすぎる中身は本文を読んだ後に 413 で断る（理由が分かる形で返す）。
 */
const MAX_WRITE_BODY_BYTES = 4 * 1024 * 1024;

/** JSON ボディを読む。上限付き（無制限に読むと DoS になる）。 */
function readJson(req, maxBytes = 64 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let over = false;
        req.on('data', c => {
            // ⚠️ **`req.destroy()` しない。** ソケットを切ると応答が届かず、
            //    クライアントには「fetch failed」しか見えない。
            //    「大きすぎる」と「サーバが落ちた」を区別できないのは、
            //    このツールが避けるべき種類の壊れ方（実際にテストで踏んだ）。
            //    読み捨てて（chunks に積まない）応答は 413 で返す。
            if (over) return;
            size += c.length;
            if (size > maxBytes) {
                over = true;
                chunks.length = 0;
                const e = new Error(`ボディが大きすぎます（上限 ${maxBytes} バイト）`);
                e.tooLarge = true;
                reject(e);
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw) { resolve({}); return; }
            try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON として読めません')); }
        });
        req.on('error', reject);
    });
}

/**
 * 🚨 **1つの要求でデーモンを落とさないための最後の砦。**
 *
 * ハンドラは async なので、**認可より手前の同期例外は unhandled rejection になり
 * プロセスが exit 1 で落ちる**。`new URL()` でこの型を一度直したのに、
 * `decodeURIComponent`（Cookie）で再発させた（`Cookie: kjp_auth=%` の1本で落ちた。
 * レビューで実測）。個別に囲うだけでは次も忘れるので、**外側でも受ける。**
 *
 * ⚠️ ここは「気付かなくする」ための蓋ではない。落ちないようにしつつ
 *    **必ず stderr に出す**（黙って 500 を返すだけにしない）。
 */
const server = createServer((req, res) => {
    handleRequest(req, res).catch(err => {
        console.error('⚠ 要求の処理で例外（デーモンは継続します）:', err);
        try {
            if (!res.headersSent) {
                res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
            }
            if (!res.writableEnded) res.end(JSON.stringify({ error: 'internal error' }));
        } catch { /* 応答も書けない状態。接続は落とす */ res.destroy?.(); }
    });
});


/**
 * 🚨 **`/api/v0/precheck` の計算（#62）。TTL キャッシュ + 重複排除つき。**
 *
 * この経路は1要求で **worktree 本数に比例して git を起動する**
 * （実測: worktree 9本で 1要求 64 spawn。`/api/v0/state` は並列30要求でも 90）。
 * 他の読み取り経路は `collect()` の TTL キャッシュと inFlight 重複排除で
 * 守られているのに、**この経路だけ素で回していた**（10回目のレビュー / SERIOUS）。
 *
 * ⚠️ **`paths` で絞る前の結果をキャッシュする。** フックは触るファイルごとに
 *    別の `paths` で聞くので、絞り込み後をキャッシュすると当たらない。
 * ⚠️ 短い TTL にする。「編集を始める前に聞く」用途なので、
 *    数秒前の状態を返すと**乗っ取りを見落とす**（守りの意味が消える）。
 */
const PRECHECK_TTL_MS = 1500;
const PRECHECK_MAX_INFLIGHT = 2;
const precheckGate = makeInflightGate(PRECHECK_MAX_INFLIGHT);
const precheckCache = new Map();   // `${repo}\u0000${worktree}` → {at, p}

async function precheckFull(repo, wantPath) {
    const now = Date.now();
    // 古いものを捨てる（外から無制限に増やせない形にする）
    for (const [k, v] of precheckCache) {
        if (now - v.at > PRECHECK_TTL_MS) precheckCache.delete(k);
    }
    const key = `${repo}\u0000${wantPath}`;
    const hit = precheckCache.get(key);
    // ⚠️ **promise を入れる**（結果ではなく）。同時に来た同じ問い合わせを
    //    1回の計算に畳むのが目的なので、完了を待たずに共有する。
    if (hit) return hit.p;
    const p = precheckCompute(repo, wantPath).catch(err => {
        precheckCache.delete(key);   // 失敗は覚えない
        throw err;
    });
    precheckCache.set(key, { at: now, p });
    return p;
}

async function precheckCompute(repo, wantPath) {
    let worktrees;
    try { worktrees = await listWorktrees(repo); }
    catch (err) { return { error: `worktree を読めません: ${err.message}`, code: 500 }; }
    const me = worktrees.find(w => samePath(w.path, wantPath));
    if (!me) return { error: `既知の worktree ではありません: ${wantPath}`, code: 400 };
    const drivers = await mergeDriverNames(repo).catch(() => []);
    const others = worktrees.filter(w => !samePath(w.path, me.path) && !w.bare);
    const conflicts = [];
    const unknown = [];
    const refA = me.ref ?? me.branch ?? me.head;
    if (!refA) unknown.push({ worktree: me.path, why: '自分の ref を解決できません' });
    for (const other of others) {
        const refB = other.ref ?? other.branch ?? other.head;
        if (!refA || !refB) {
            unknown.push({ worktree: other.path, why: 'ref を解決できません' });
            continue;
        }
        try {
            const r = await mergePreview(repo, refA, refB, drivers);
            for (const f of r.conflicts ?? []) {
                // ⚠️ ここでは `paths` で絞らない。絞り込みは**キャッシュより後**
                //    （フックは触るファイルごとに別の `paths` で聞くので、
                //     絞り込み後を覚えるとキャッシュが当たらない。#62）
                conflicts.push({
                    path: f, worktree: other.path,
                    branch: other.shortBranch ?? other.branch ?? null,
                    synthetic: Boolean(r.synthetic?.has?.(f)),
                });
            }
        } catch (err) {
            unknown.push({ worktree: other.path, why: err.message });
        }
    }
    // 🚨 **相手が rebase / cherry-pick の途中なら、衝突が無くても触らせない。**
    //    シーケンサの途中に別のエージェントが書くと、`git rebase --continue`
    //    が意図しない内容を取り込む（乗っ取り）。ここを落とすと
    //    「衝突なし」だけ見て通してしまうので、判定できない場合も unknown に積む。
    const busy = [];
    // 🚨 **自分の worktree のシーケンサも返す。** 乗っ取りが起きるのは
    //    「rebase が止まっている worktree で編集を続ける」形なので、
    //    他所との衝突より先にこれを見る必要がある。
    let self = null;
    let gitDirs = null;
    try { gitDirs = await worktreeGitDirs(repo); }
    catch (err) { unknown.push({ worktree: repo, why: `$GIT_DIR を引けません: ${err.message}` }); }
    if (gitDirs) {
        try {
            const seq = await sequencerState(me.path, gitDirs.get(me.path) ?? null);
            self = {
                rebasing: !!seq.rebasing, merging: !!seq.merging,
                cherryPicking: !!seq.cherryPicking, reverting: !!seq.reverting,
                bisecting: !!seq.bisecting, sequencing: !!seq.sequencing,
                warnings: seq.warnings ?? [],
            };
        } catch (err) {
            unknown.push({ worktree: me.path, why: `sequencer: ${err.message}` });
        }
        for (const other of others) {
            try {
                const seq = await sequencerState(other.path, gitDirs.get(other.path) ?? null);
                const active = Boolean(seq.rebasing || seq.merging || seq.cherryPicking
                    || seq.reverting || seq.bisecting || seq.sequencing);
                if (active) {
                    busy.push({
                        worktree: other.path, branch: other.shortBranch ?? other.branch ?? null,
                        rebasing: !!seq.rebasing, merging: !!seq.merging,
                        cherryPicking: !!seq.cherryPicking, reverting: !!seq.reverting,
                        bisecting: !!seq.bisecting, sequencing: !!seq.sequencing,
                    });
                }
            } catch (err) {
                unknown.push({ worktree: other.path, why: `sequencer: ${err.message}` });
            }
        }
    }
    return { me, self, conflicts, busy, unknown };
}

async function handleRequest(req, res) {
    // 🚨 new URL() は必ず try で囲む。**認可の手前にある同期例外はプロセスを殺す。**
    //    `GET //[ HTTP/1.1` のような request-target は ERR_INVALID_URL を投げ、
    //    async ハンドラの unhandled rejection でデーモンが exit 1 で落ちる。
    //    4関門も Host 検証も通らない、認証前の1パケット DoS だった（レビューで実証）。
    let url;
    try {
        url = new URL(req.url, 'http://localhost');
    } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('bad request target\n');
        return;
    }
    // 🔒 すべての経路の手前で判定する。個別のハンドラに任せない
    //    （経路が増えたときに1つ忘れるのを防ぐ）。
    if (!hostAllowed(req) || !siteAllowed(req)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('forbidden: ループバック以外の Host / 別サイトからの参照は拒否します\n');
        return;
    }
    // 🔒 読み取りの認証も**入口で**判定する。個別のハンドラに任せない。
    //    ここを通らない経路を作らないことが、後から穴を1つ忘れないための唯一の方法。
    // 🚨 **認証前の並列度を、比較の手前で縛る**（8回目のレビュー。SERIOUS）。
    //    遅延は1本ずつを遅くするだけで同時本数を制限しないので、並列度を上げれば
    //    実測 485 回/秒で当て続けられた。**枠が取れなければ比較せずに 429 で切る。**
    //    ⚠️ 順序が守りの本体。比較の後ろに置くと 429 が「その値は違った」の
    //       同義語になり、当てる速さは並列度で決まったままになる。
    if (opts.requireAuth) {
        const peer = peerKey(req);
        // 🔒 一度通った値そのものを提示している要求は、混雑の門を通さない
        //    （素通りするのは門だけ。authed() は必ず通る）。
        const vals = presentedSecrets(req, url);
        const trusted = knownGoodSecret(vals);
        if (!trusted && !authGate.acquire(peer)) {
            noteAuthShed(peer);
            res.writeHead(429, {
                'content-type': 'text/plain; charset=utf-8',
                'cache-control': 'no-store',
                'retry-after': '1',
            });
            res.end('too many auth attempts: 認証前の要求が同時に多すぎます。'
                + '少し待って開き直してください\n');
            return;
        }
        let pass;
        try {
            pass = authed(req, url);
            if (pass) rememberGoodSecret(vals);
            // 🚨 **失敗を記録して、連続失敗には遅延を掛ける。** ここが無いと
            //    痕跡ゼロで総当たりできる（実測で29回目に通った）。
            //    ⚠️ 遅延の間も枠を握る。これが「並列でも縛れる」の本体。
            else await noteAuthFail(req, url);
        } finally {
            if (!trusted) authGate.release(peer);
        }
        if (!pass) {
            // ⚠️ 「トークンが違う」と「トークンが無い」を区別して返さない
            //    （総当たりに手掛かりを与えない）。
            res.writeHead(401, {
                'content-type': 'text/plain; charset=utf-8',
                'cache-control': 'no-store',
            });
            res.end('unauthorized: トークンが必要です。'
                + '起動時に表示された ?token=... 付きの URL を開いてください\n');
            return;
        }
    }
    // ?token=... で来たら**読み取り用の Cookie を焼く**（応答は普通に返す）。
    //
    // 🚨 **リダイレクトしない。** 以前は 302 で URL からトークンを落としていたが、
    //    それだとページの JS がトークンを一度も見られないので、書き込み・実行に
    //    必要なトークンを `/api/v0/session` から取り戻す作りになり、
    //    **Cookie を持つ相手（= 他ポートの誰か）が実行に到達する**穴になっていた
    //    （レビューで実測。リクエスト1本多いだけで RCE）。
    //    今はページ側が `?token=` を読んで **sessionStorage に入れ、
    //    `history.replaceState` で URL から消す**。
    //    sessionStorage は**ポートを含むオリジン単位**なので他ポートから読めない
    //    （Cookie との決定的な違い。これが分離の根拠）。
    // 🚨 実行トークンではなく**読み取り用の別の秘密**を焼く。
    if (opts.requireAuth && url.searchParams.get('token')) {
        // ⚠️ Secure は付けない（ループバックは http なので保存されなくなる）。
        //    経路の暗号化はトンネル側（tailscale serve）の責任。
        res.setHeader('set-cookie', `${AUTH_COOKIE}=${encodeURIComponent(cookieSecret())}`
            + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000');
    }
    // 🔒 **`?repo=` の照合も入口で1回だけ行う。** 個別のハンドラで拾わせない。
    //    ここで解決した `repo` 以外を git に渡さないので、
    //    「新しい経路で照合を忘れる」余地が構造として無くなる
    //    （副作用のある経路を足すときに必ず通る関門を同じコミットで作る、の実装）。
    // ⚠️ 登録外は 400 で落とす（読み取りも書き込みも実行も等しく）。
    // 🚨 **検査専用の経路は、門より後ろ・内側の try より手前に置く（#64）。**
    //
    //    以前は `handleRequest` の**先頭**にあったので、
    //    **Host 検証も認証も通らずに `/__shutdown` でデーモンを落とせた**
    //    （10回目のレビュー / SERIOUS）。`--layout-probe` は検査用とはいえ、
    //    「既定では存在しない経路」は「門の外にあってよい経路」ではない。
    //    ⚠️ 起動時に `--layout-probe` と `--allow-host` の併用も拒否している
    //       （下の起動処理）。門を通すことと、そもそも外に出さないことの二段。
    //
    // ⚠️ **内側の try/catch より手前**であることは維持する。中に置くと
    //    内側が捕まえてしまい、汎用の砦（top-level `.catch()`）を測れない（#42）。
    if (opts.layoutProbe && url.pathname === '/__throw') {
        throw new Error('検査用の例外（デーモンは継続しなければならない）');
    }
    // 🚨 **検査専用: 終了処理を起こす経路（既定では存在しない）。**
    //    `SIGHUP` / `uncaughtException` からの終了処理は Windows では測れない
    //    （`process.kill` が TerminateProcess 相当でハンドラを走らせない）。
    //    ここが無いと、終了処理の**中身**（新しい実行を断る門・起動途中の印・
    //    数え直しと告知）が **Windows では1つも検査されない**まま CI 任せになる。
    //    シグナルへの登録だけは linux / darwin の検査で測る。
    if (opts.layoutProbe && url.pathname === '/__shutdown') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('shutting down\n');
        shutdown('probe').catch(() => { /* 終了処理の失敗で落とさない */ });
        return;
    }
    const picked = pickRepo(url);
    if (picked.error) {
        res.writeHead(400, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
        });
        res.end(JSON.stringify({ error: picked.error }));
        return;
    }
    const repo = picked.repo;
    try {
        // 登録済みリポジトリの一覧。読み取り経路なので入口の authed() の枠内。
        // 🔒 **ここで返すのは起動時に固定した一覧だけ。** 「開けるものを探す」
        //    経路（走査・任意パスの追加）は作らない。
        if (url.pathname === '/api/v0/repos') {
            const labels = repoLabels(opts.repos);
            res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
            });
            res.end(JSON.stringify({
                repos: opts.repos.map((p, i) => ({
                    path: p, label: labels[i], current: p === repo,
                })),
                current: repo,
                default: opts.repos[0],
            }));
            return;
        }
        if (url.pathname === '/api/v0/state') {
            // ?fresh=1 で TTL キャッシュを無視する（手動リロード用）
            const force = url.searchParams.get('fresh') === '1';
            const state = await collect(repo, { force });
            // 🚨 **exec の情報は Cookie だけの相手に出さない。** `argv` は
            //    ユーザが打ったコマンド行そのもので、秘密が載りうる。
            //    Cookie はポートで分離されないので、他ポートのページが読める状態にすると
            //    「read は読み取りまで」という分界が崩れる（記録のコマンド行と同じクラス。
             //   7回目のレビューで transcript 側を直したのと同型の穴がここにも残っていた）。
            //    ⚠️ **キャッシュは共有**なので、payload を作り直すのではなく
            //    応答の時点で落とす。
            // 🔒 **判定は必ず壁を通す**（#63）。直接 `presentedToken()` を呼ぶと
            //    記録も遅延も無い当たり判定になり、実行トークンの総当たり口になる。
            const shown = await presentedTokenAudited(req, res, url);
            if (shown.handled) return;
            const body = JSON.stringify(
                // ⚠️ 隠すのは **`--require-auth` のときだけ**。認証が要らない構成は
                //    ループバック限定で Cookie の脅威（他ポートのページ）が無く、
                //    ここで隠すと素の利用を壊すだけで守りにならない。
                (state.execSessions && opts.requireAuth && !shown.ok)
                    ? { ...state, execSessions: null, execSessionsHidden: true }
                    : state,
            );
            res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
            });
            res.end(body);
            return;
        }
        // 検査専用: **内側の** catch を測る経路（下の `/__throw` と対）
        if (opts.layoutProbe && url.pathname === '/__throw-inner') {
            throw new Error('検査用の例外（内側。メッセージを返してはいけない）');
        }
        if (opts.layoutProbe && url.pathname === '/__probe') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(probeHarness(Number(url.searchParams.get('w')),
                url.searchParams.get('mode'),
                presentedToken(req, url) ? opts.token : null));
            return;
        }
        // クライアントが書き込み可否とトークンを知るための経路。
        // 🔒 Host 検証と Sec-Fetch-Site を通った同一オリジンにだけ返る。
        //    cross-origin では CORS が無いので応答が読めない。
        // 🚨 **`--require-auth` のときは「既に認証されている要求」にしか
        //    トークンを返さない。** ここが無認証で払い出している限り、
        //    読み取り経路にトークンを要求しても意味が無い
        //    （届く相手が誰でも取れるので、トークンは CSRF 対策でしかない）。
        //    入口の authed() を通っているので、ここに来た要求は認証済み。
        if (url.pathname === '/api/v0/session') {
            const site = req.headers['sec-fetch-site'];
            const sameOrigin = !site || site === 'same-origin' || site === 'none';
            // 🔒 ここも当たり判定（しかも当たれば**トークンそのもの**を返す）なので、
            //    壁を通す（#63。`/state` と同じ理由）。
            const shown = await presentedTokenAudited(req, res, url);
            if (shown.handled) return;
            res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
            });
            res.end(JSON.stringify({
                allowWrite: opts.allowWrite,
                allowExec: opts.allowExec,
                watchAgents: opts.watchAgents,
                allowTranscriptText: opts.allowTranscriptText,
                requireAuth: opts.requireAuth,
                tokenHeader: TOKEN_HEADER,
                // 🚨 **Cookie で認証した要求にトークンを渡してはいけない。**
                //    Cookie はポートで分離されないので、127.0.0.1 の他のポートを
                //    開いた相手にも Cookie は届く。ここが渡していたので、
                //    「Cookie が漏れても実行はできない」という前の修正は
                //    **リクエスト1本多いだけで破られていた**（レビューで実測）。
                //    しかも `sameOrigin` は `!site || ...` なので
                //    **Sec-Fetch-Site を送らない非ブラウザは素通り**する。
                // ⚠️ トークンを見せてよいのは「既にトークンを持っている」要求だけ。
                //    ブラウザは `?token=` で1回渡され、sessionStorage に持つ
                //    （sessionStorage は**ポートを含むオリジン単位**なので
                //     他のポートからは読めない。Cookie との決定的な違い）。
                token: opts.allowWrite && sameOrigin && shown.ok
                    ? opts.token : null,
                // 🔒 **どちらの秘密で来たかを伝える。**
                //    案内の URL には読み取り専用の派生秘密しか載せないので、
                //    ページはそれを「読める鍵」として保持するが、
                //    **書き込み・実行の鍵と混同してはいけない**
                //    （混同すると「有効に見えて必ず 403」の状態を作る）。
                presented: shown.ok ? 'token'
                    : (presentedReadSecret(req, url) ? 'read' : 'none'),
            }));
            return;
        }

        // 🔒 任意コマンドの実行。出力を行区切り JSON で流す。
        //    PTY は使わない（Node 標準に PTY は無く、node-pty は依存を増やす）。
        //    Claude Code は `claude -p "..."` で非対話実行できるので、
        //    エージェントを遠隔から動かすのに PTY は要らない。
        //    対話 TUI をそのまま覗きたくなった時点で PTY を検討する。
        /**
         * 🔒 **衝突の事前問い合わせ（#59。`precheck`）。読み取り専用。**
         *
         * 設計当初（`docs/s0-verification.md`）に「他所に無い」と判定した中核が
         * これ。今までは**画面で見えるだけ**で、エージェントが編集を始める前に
         * 機械が問い合わせる口が無かった（`PreToolUse` フックから使う）。
         *
         * 🔒 触るのは `merge-tree --write-tree`（loose object を書くだけ）と
         *    `.git` の読み取りのみ。ref / index / 作業ツリーは変えないので
         *    **読み取りトークンで通す**（`--allow-write` も `--allow-exec` も要らない）。
         * ⚠️ **「調べられない」を「衝突なし」と答えない。** ref が解決できない、
         *    merge-tree が落ちた等は `unknown` に積み、`decided:false` を返す。
         *    呼ぶ側が「衝突ゼロ = 安全」と読める形にしない。
         */
        if (url.pathname === '/api/v0/precheck') {
            if (req.method !== 'POST') { denyJson(res, 405, 'POST のみ受け付けます'); return; }
            // 🔒 **同一オリジンだけ（#62）。** 入口の `siteAllowed()` は `same-site` と
            //    「ヘッダ無し」を通すので、**同じマシンの別ポートのページ**や、
            //    `--allow-host` 構成では**同一 tailnet の別ノードのページ**から
            //    blind で撃てた（`ts.net` は PSL にあるので `*.tailnetX.ts.net` 同士は same-site）。
            //    副作用は無いが**コストがある**経路なので、書き込みと同じ基準にする。
            {
                const site = req.headers['sec-fetch-site'];
                if (site && site !== 'same-origin') {
                    denyJson(res, 403,
                        `別オリジン起点の問い合わせは拒否します (Sec-Fetch-Site: ${site})`);
                    return;
                }
            }
            let body;
            try { body = await readJson(req); } catch (err) {
                denyJson(res, err.tooLarge ? 413 : 400, err.message); return;
            }
            const wantPath = toNFC(String(body.worktree ?? ''));
            const only = Array.isArray(body.paths) && body.paths.length
                ? new Set(body.paths.map(x => toNFC(String(x)))) : null;
            // 🚨 **同時実行を peer ごとに縛る（#62。10回目のレビュー / SERIOUS）。**
            //    この経路は1要求で worktree 本数分の `merge-tree` と `sequencerState` を
            //    起動する（実測: worktree 9本で **1要求 64 spawn**）。読み取りの鍵しか
            //    持たない相手が並列120本投げると 13.7 秒かかり、
            //    同時に投げた `/api/v0/repos` が 1ms → 643ms に伸びた。
            //    副作用が無くても**コストがある経路**は縛る。
            if (!precheckGate.acquire(peerKey(req))) {
                res.writeHead(429, {
                    'content-type': 'application/json; charset=utf-8',
                    'cache-control': 'no-store', 'retry-after': '1',
                });
                res.end(JSON.stringify({
                    error: '衝突の問い合わせが同時に多すぎます。少し待ってから試してください',
                }));
                return;
            }
            let full;
            try {
                full = await precheckFull(repo, wantPath);
            } finally {
                precheckGate.release(peerKey(req));
            }
            if (full.error) { denyJson(res, full.code ?? 400, full.error); return; }
            const { conflicts: allConflicts, busy, unknown, self, me } = full;
            const conflicts = only
                ? allConflicts.filter(c => only.has(toNFC(c.path)))
                : allConflicts;
            res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
            });
            res.end(JSON.stringify({
                worktree: me.path, branch: me.shortBranch ?? me.branch ?? null,
                self, conflicts, busy, unknown,
                // ⚠️ 呼ぶ側が「安全」と読んでよいのは decided が true のときだけ
                decided: unknown.length === 0,
            }));
            return;
        }

        if (url.pathname === '/api/v0/exec') {
            if (!await gateExec(req, res)) return;
            // 🚨 **終了処理が始まったら新しい実行を受けない**（9回目のレビュー / SERIOUS）。
            //    門が無かったので、終了処理の掃き取りと `POST /api/v0/exec` が競争し、
            //    **掃いた後に spawn される**（`create()` から `spawn()` までは実測 36〜43ms）。
            //    その子は寿命管理の外に落ちる: sweeper は止まり、監査に `exit` は残らず、
            //    POSIX では detached でプロセスグループを切っているので確実に生き残る。
            //    門は `create()`（枠の予約）より**前**に置く。後ろだと枠を予約したまま
            //    返す経路が増えるだけで、spawn との競争は消えない。
            if (shuttingDown) {
                denyJson(res, 503, '終了処理中です（新しい実行は受け付けません）');
                return;
            }
            let body;
            try { body = await readJson(req); } catch (err) { denyJson(res, err.tooLarge ? 413 : 400, err.message); return; }

            // ⚠️ argv 配列で受ける。shell は使わない（引用の崩れと二重解釈を避ける）
            const argv = Array.isArray(body.argv) ? body.argv.map(String) : null;
            if (!argv || argv.length === 0) { denyJson(res, 400, 'argv（配列）が必要です'); return; }
            if (argv.some(a => a.includes('\0'))) { denyJson(res, 400, 'argv に NUL は使えません'); return; }

            // 🔒 枠は await の手前で予約する（検査と予約の間に await を挟むと上限が効かない）。
            //    create() は同期。ここを async にしてはいけない。
            const session = execRegistry.create({
                worktree: '(未検証)', argv, keepAlive: body.keepAlive === true,
            });
            // ⚠️ **セッションに repo を持たせる。** 既定の監査ログは
            //    `<GIT_DIR>/…` なので、持たせないと `start` は B の .git に、
            //    `exit` / `input` / `kill` は既定（1本目）の .git に書かれて
            //    **1回の実行の記録が2つのファイルに割れる**（追えなくなる）。
            if (session) session.repo = repo;
            if (!session) {
                denyJson(res, 429, `同時実行が上限（${MAX_CONCURRENT_EXEC}）に達しています`);
                return;
            }
            // 🚨 **回収機構は「過去に1本成功したか」に依存させない。**
            //    以前は attachChild 成功後にだけ起動していたので、正常な exec が
            //    一度も通っていないデーモンでは sweeper が存在せず、枠が返らない
            //    経路を1つ踏むだけで **429 が恒久化**した（再起動しか回復手段が無い。#35）。
            startExecSweeper();

            // 予約した後の失敗経路は必ず枠を返す（finish が枠を返す）
            const bail = (code, msg) => {
                execRegistry.finish(session, { note: msg });
                execRegistry.remove(session);
                denyJson(res, code, msg);
            };

            let wt;
            try {
                const wantPath = toNFC(String(body.worktree ?? ''));
                // 🚨 **ここは throw しうる。** `listWorktrees` は git が非ゼロで終わると
                //    throw する（リポジトリの移動・削除・破損）。囲っていなかったので
                //    外側の catch-all に吸われて 500 になるだけで **finish も remove も
                //    走らず、枠が8本埋まったまま恒久的に 429** になっていた（#35）。
                // 🔒 **allowlist は「選択中のリポジトリ」の worktree 一覧に対して引く。**
                //    全リポジトリを合わせた集合で照合すると、A を選んでいるのに
                //    B の worktree でコマンドが走る（`?repo=` の意味が消える）。
                const worktrees = await listWorktrees(repo);
                wt = worktrees.find(w => samePath(w.path, wantPath));
                if (!wt) { bail(400, `既知の worktree ではありません: ${wantPath}`); return; }
                if (wt.bare) { bail(400, 'bare worktree では実行できません'); return; }
                if (wt.prunable) { bail(409, '作業ツリーが失われています'); return; }
                session.worktree = wt.path;

                await auditExec({
                    event: 'start', session: session.id, repo, worktree: wt.path, argv,
                    keepAlive: session.keepAlive,
                    ...originHint(req),
                }, repo);
            } catch (err) {
                // ⚠️ **spawn すらしていないことを記録に残す。** sweeper が拾うと
                //    `signal:"SIGKILL"` / `reason:"timeout"` で終わり、
                //    「起動していないプロセスを殺した」という嘘になる（#35）。
                await auditExec({
                    event: 'bail', reason: 'never-started', session: session.id, repo,
                    worktree: session.worktree, argv, error: err.message,
                }, repo).catch(() => { /* 監査に書けなくても枠は返す */ });
                bail(500, `実行の準備に失敗しました: ${err.message}`);
                return;
            }

            const { spawn } = await import('node:child_process');
            const { StringDecoder } = await import('node:string_decoder');

            // ⚠️ **検査専用の遅延（既定 0）。** `create()` と `spawn()` の間の窓
            //    （実測 100ms 前後）に `/kill` を確実に割り込ませるために要る。
            //    素のままでは「starting のうちに殺されてから spawn が失敗する」経路が
            //    プラットフォーム依存の競争になり、**決定的に再現できない**
            //    （`--exec-stream-delay` / `--layout-probe` と同じ扱い。
            //      渡さない限りこの経路は存在しない）。
            if (opts.execSpawnDelayMs > 0) {
                await new Promise(r => setTimeout(r, opts.execSpawnDelayMs));
            }

            let child;
            try {
                child = spawn(argv[0], argv.slice(1), {
                    cwd: wt.path, shell: false, windowsHide: true,
                    // POSIX では新しいプロセスグループを作る。killTree が -pid で
                    // グループごと殺せるようにするため（中間シェルの孫を残さない）。
                    detached: process.platform !== 'win32',
                    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', NO_COLOR: '1' },
                });
            } catch (err) {
                // Windows で .cmd/.bat を直接 spawn すると EINVAL になる。
                // shell を使わない方針なので `cmd /c` を明示してもらう
                const hint = err.code === 'EINVAL' && process.platform === 'win32'
                    ? '（Windows では .cmd/.bat は直接実行できません。'
                        + ' argv を ["cmd","/c","npm","test"] のように指定してください）'
                    : '';
                execRegistry.emit(session, 'err', `起動できません: ${err.message}${hint}`);
                execRegistry.finish(session, { code: null, signal: null });
                // 起動できなかったことは購読者に見せたいので、ストリームで返す
                streamSession(req, res, session, 0);
                return;
            }
            // 🚨 **子の 'error' は spawn の直後・どの早期 return よりも前に張る**
            //    （8回目のレビュー。SERIOUS）。以前は `attachChild` が false のときの
            //    早期 return より**後ろ**で張っていたので、`create()` と `spawn()` の間に
            //    `/kill`（または猶予切れ）が入った回だけ **ChildProcess に error の
            //    listener が1つも無い**状態になっていた。spawn の失敗（ENOENT / EACCES）は
            //    非同期の 'error' で来るので、そこで **uncaughtException になり
            //    デーモンが exit 1 で即死**する（実測: exec 1本 + kill 1本で消えた）。
            //    落ちると SIGINT/SIGTERM のハンドラも走らないので、
            //    **走っていた全セッションの子が寿命管理の外に落ち**（POSIX は
            //    detached でプロセスグループを切っているので確実に残る）、
            //    監査に `exit` が1件も残らない。**タイポ1個 + 停止ボタンで盲目になる。**
            //    `child.stdin` については同じ型を既に直していたのに（#17 の兄弟経路）、
            //    こちらだけ取りこぼしていた。
            // ⚠️ 既に done のセッションへの emit / finish は無害（finish は1回しか効かない）。
            // 🚨 **spawn の失敗は同期例外ではなく 'error' イベントで来る。**
            //    存在しないコマンド（Windows なら拡張子なしの `npm` も）は
            //    ENOENT で 'error' + 'close' だけを出し、**'exit' は来ない**。
            //    以前はここで emit するだけだったので `finish()` を呼ぶ経路が無く、
            //    セッションが**永久に running のまま**になっていた（レビューで実測）:
            //      - `/api/v0/state` が「起動していないプロセスを実行中」と表示する（嘘）
            //      - 枠が返らないのでミスタイプ8回で実行が死ぬ
            //      - 回復時の記録が「上限時間を超えたので停止」= 起動すらしていない
            //        プロセスを殺したという主張になる
            child.on('error', async err => {
                execRegistry.emit(session, 'err', `実行エラー: ${err.message}`);
                if (execRegistry.finish(session, { code: null, signal: null })) {
                    await auditExec({
                        event: 'exit', session: session.id, repo, worktree: wt.path, argv,
                        code: null, signal: null, note: `spawn 失敗: ${err.message}`,
                    }, repo);
                }
            });
            // 🚨 **stdin の書き込み失敗も非同期の 'error' で来る。**
            //    listener が無いと uncaughtException になり**デーモンが落ちる**
            //    （走っている全セッションが消え、監査に exit が1件も残らない。
            //     レビューで実測）。相手が入力待ちを終えた直後に送るだけで起きる。
            child.stdin?.on('error', err => {
                // EPIPE は「相手が読むのをやめた」だけなので、セッションは殺さない
                execRegistry.emit(session, 'err',
                    `⚠ 標準入力に書けませんでした: ${err.code ?? err.message}`);
            });
            // 🚨 create() から spawn() までに await が入るので、その隙に
            //    セッションが殺されている（猶予切れ / kill）ことがある。
            //    そのまま走らせると「停止した」と告げた後に動き続ける。
            if (!execRegistry.attachChild(session, child)) {
                // 🚨 ここでも数え直しの結果を捨てない。セッションは既に「停止した」と
                //    告げているので、止め切れていないなら**その後ろに**足す
                //    （終端の後の行になるが、黙って捨てるより読める）
                const r = await killTree(child);
                if (!r.killed || r.why) execRegistry.emit(session, 'err', `⚠ ${r.why}\n`);
                streamSession(req, res, session, 0);
                return;
            }
            // 🚨 **`killRequested` が立っているセッションに子を渡したままにしない。**
            //    終了処理は `s.child === null`（起動途中）のセッションを殺せないので、
            //    印だけ付けて先へ進む。その印をここで見ないと、**サーバが死んだ後に
            //    spawn された子**が寿命管理の外で走り続ける（`attachChild` は
            //    まだ running なので true を返す = 上の早期 return では捕まらない）。
            if (session.killRequested) {
                execRegistry.emit(session, 'err',
                    `⚠ 起動途中に停止が要求されていたので停止します（${session.killRequested}）\n`);
                const late = await killTree(child);
                execRegistry.finish(session, {
                    code: null, signal: 'SIGKILL',
                    note: late.killed
                        ? (late.why ? `⚠ 停止しました（${late.why}）` : '⚠ 停止しました')
                        : `⚠ ${late.why}`,
                });
                streamSession(req, res, session, 0);
                return;
            }

            // ⚠️ chunk ごとに toString() すると3バイト文字が割れる。
            //    StringDecoder が境界を持ち越す（CLAUDE.md の git 呼び出し規則と同じ理由）。
            const decOut = new StringDecoder('utf8'), decErr = new StringDecoder('utf8');
            child.stdout.on('data', c => {
                const s = decOut.write(c);
                if (s) execRegistry.emit(session, 'out', s);
            });
            child.stderr.on('data', c => {
                const s = decErr.write(c);
                if (s) execRegistry.emit(session, 'err', s);
            });
            // ⚠️ `close` は保険。`exit` を主にする理由（孫がパイプを握ると
            //    `close` が来ない）は変わらないが、**逆に `exit` が来ない経路がある**
            //    ので両方拾う。finish は1回しか効かないので二重にはならない。
            child.on('close', () => {
                if (execRegistry.finish(session, { code: null, signal: null,
                    note: '⚠ 終了コードを取れませんでした（stdio が閉じました）' })) {
                    auditExec({
                        event: 'exit', session: session.id, repo, worktree: wt.path, argv,
                        code: null, signal: null, note: 'close で終端',
                    }, repo).catch(() => {});
                }
            });
            // ⚠️ `close` ではなく `exit` を使う。`close` は stdio が EOF になるまで来ないので、
            //    孫がパイプを握っていると永久に発火せず、枠が戻らない（レビューで実測）。
            child.on('exit', async (code, signal) => {
                const tail = decOut.end(), tailErr = decErr.end();
                if (tail) execRegistry.emit(session, 'out', tail);
                if (tailErr) execRegistry.emit(session, 'err', tailErr);
                if (execRegistry.finish(session, { code, signal })) {
                    await auditExec({
                        event: 'exit', session: session.id, repo, worktree: wt.path, argv, code, signal,
                    }, repo);
                }
            });

            // ⚠️ **検査専用の遅延。** 既定 0 で、渡さない限り何もしない。
            //    「応答が届く前に切られた」ことを**決定的に**作るために要る:
            //    素の実装では `res` の 'close' がリスナ登録の前か後かが
            //    プラットフォーム依存の競争になり、**Linux では守りを外しても
            //    テストが緑になっていた**（CI だけで露出した。SURVIVED）。
            //    ここを遅らせれば、どの環境でも切断が先に確定する。
            if (opts.execStreamDelayMs > 0) {
                await new Promise(r => setTimeout(r, opts.execStreamDelayMs));
            }
            // POST はセッションを作ってそのまま購読する（1往復で流れ始める）
            streamSession(req, res, session, 0);
            return;
        }

        /**
         * 🔒 **全セッションの監視（N 個のエージェントを1画面で見るため）。**
         *
         * 各セッションの状態と**最後の出力**を返す。購読しなくても
         * 「どれが動いていて、どれが止まっていて、今何が出ているか」が分かる。
         *
         * 🚨 **exec の関門を必ず通す**（トークン + POST + same-origin + Host）。
         *    出力はコマンドの結果なので、Cookie だけの相手に渡すと
         *    「read は読み取りまで」という分界が崩れる。
         * 🚨 秘密は argv と出力の両方でマスクする（打った値が残りうる）。
         */
        if (url.pathname === '/api/v0/exec/list') {
            if (!await gateExec(req, res)) return;
            const now = Date.now();
            const secrets = secretsForMasking();
            const sessions = execRegistry.sessionsForMonitor(now).map(x => {
                const argv = x.argv.map(a => maskSecrets(a, secrets));
                const last = x.lastOutput === null
                    ? { text: null, masked: false }
                    : maskSecrets(x.lastOutput, secrets);
                return {
                    ...x,
                    argv: argv.map(m => m.text),
                    argvMasked: argv.some(m => m.masked),
                    lastOutput: last.text,
                    lastOutputMasked: last.masked,
                };
            });
            res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
            });
            res.end(JSON.stringify({
                sessions,
                limits: {
                    maxConcurrent: MAX_CONCURRENT_EXEC,
                    timeoutMs: opts.execTimeoutMs,
                    detachedGraceMs: opts.execDetachedGraceMs,
                },
            }));
            return;
        }
        // 実行セッションの再購読。**切断しても走り続けている**ので、
        // 最後に見た通番の続きから貰えるようにする（#17）。
        {
            const m = /^\/api\/v0\/exec\/([^/]+)\/(stream|kill|input)$/.exec(url.pathname);
            if (m) {
                // 🔒 実行と同じ関門を通す（GET にしない。POST + トークン + 同一オリジン）
                if (!await gateExec(req, res)) return;
                if (!isSessionId(m[1])) { denyJson(res, 400, 'セッション id が不正です'); return; }
                const s = execRegistry.get(m[1]);
                if (!s) { denyJson(res, 404, 'そのセッションはありません（保持期間を過ぎたか、id が違います）'); return; }
                if (m[2] === 'kill') {
                    await auditExec({
                        event: 'kill', reason: 'requested', session: s.id,
                        repo: s.repo ?? null, worktree: s.worktree, argv: s.argv,
                    }, s.repo ?? null);
                    // 🚨 **殺してから終端する（順序を逆にした）。** 以前は
                    //    `finish()` が先だったので、(a) 実際に死ぬまでに出た出力は
                    //    `exit` の後ろに並び **live には1件も届かず告知も無い**、
                    //    (b) 出力が多いと `exit` 自身がリングから押し出されて
                    //    **終端が消える**、(c) 殺せなかったのに「停止しました」と
                    //    記録する、という3つが同時に起きていた。
                    //    ⚠️ 二重に殺しに行くのを防ぐため、`killRequested` を先に立てる
                    //    （`sweep()` はこれが立っているセッションを候補にしない）。
                    s.killRequested = 'requested';
                    // 🚨 理由は殺す前に流す（子の 'exit' が先に終端すると
                    //    finish の note が捨てられ、停止理由が消える。sweeper と同じ理由）
                    execRegistry.emit(s, 'err', '⚠ 停止を要求されました\n');
                    const r = s.child ? await killTree(s.child) : { killed: true, why: null };
                    if (!r.killed) {
                        // 殺せていないなら終端しない（走っているものを「停止」と言わない）。
                        // `killRequested` を戻して、上限で sweep がもう一度試せるようにする
                        s.killRequested = null;
                        execRegistry.emit(s, 'err', `⚠ 停止できませんでした: ${r.why}\n`);
                        await auditExec({
                            event: 'kill-failed', reason: 'requested', session: s.id,
                            repo: s.repo ?? null, worktree: s.worktree, argv: s.argv, why: r.why,
                        }, s.repo ?? null);
                        denyJson(res, 500, `停止できませんでした: ${r.why}`);
                        return;
                    }
                    // 🚨 **「停止しました」と言い切れないなら言い切らない。**
                    //    木を辿れなかった / taskkill が非ゼロだった場合は、その旨を
                    //    UI（出力と note）と監査の両方にそのまま出す。
                    if (r.why) {
                        execRegistry.emit(s, 'err', `⚠ ${r.why}\n`);
                        await auditExec({
                            event: 'kill-unverified', reason: 'requested', session: s.id,
                            repo: s.repo ?? null, worktree: s.worktree, argv: s.argv, why: r.why,
                        }, s.repo ?? null);
                    }
                    const was = execRegistry.finish(s, {
                        code: null, signal: 'SIGKILL',
                        note: r.why ? `⚠ 停止しました（${r.why}）` : '⚠ 停止しました',
                    });
                    res.writeHead(200, {
                        'content-type': 'application/json; charset=utf-8',
                        'cache-control': 'no-store',
                    });
                    res.end(JSON.stringify({ ok: true, alreadyDone: !was, warn: r.why ?? null }));
                    return;
                }
                if (m[2] === 'input') {
                    // 走っているセッションの標準入力に書く（#18）。
                    //
                    // ⚠️ **サーバは中身を解釈しない。** `claude` の
                    //    `--input-format stream-json` 用の1行を組み立てるのは
                    //    クライアントの仕事。ここを賢くすると、対応する
                    //    プログラムごとに分岐が増えて汎用性を失う。
                    // 🔒 監査には**バイト数だけ**書く。入力は自由文で、
                    //    秘密が入りうる（T5 と同じ理屈で本文は残さない）。
                    let inBody;
                    try { inBody = await readJson(req); } catch (err) { denyJson(res, err.tooLarge ? 413 : 400, err.message); return; }
                    if (!s.running) { denyJson(res, 409, 'そのセッションは終了しています'); return; }
                    const eof = inBody.eof === true;
                    const data = typeof inBody.data === 'string' ? inBody.data : null;
                    if (!eof && data === null) { denyJson(res, 400, 'data（文字列）か eof が必要です'); return; }
                    if (!s.child?.stdin || s.child.stdin.destroyed || !s.child.stdin.writable) {
                        denyJson(res, 409, '標準入力は既に閉じています');
                        return;
                    }
                    const bytes = data === null ? 0 : Buffer.byteLength(data, 'utf8');
                    // 🚨 **総量と滞留を縛る（#26）。** 1回 64KB を縛っても、相手が
                    //    読まなければ書いた分は親のメモリに無限に溜まる。
                    //    「守りを緩めた代わりの制約」の表に入力の総量だけが無かった。
                    const limits = execRegistry.limits;
                    if (s.inputBytes + bytes > limits.inputTotalBytes) {
                        denyJson(res, 413,
                            `このセッションに送れる総量の上限（${Math.round(limits.inputTotalBytes / 1024)}KB）`
                            + `を超えます（これまで ${Math.round(s.inputBytes / 1024)}KB）。`
                            + ' 相手が読んでいないか、送りすぎです');
                        return;
                    }
                    // ⚠️ 相手が読まずに溜まっている分も見る。**ok:true だけ返して
                    //    滞留を隠さない**（画面から見えないと気付けない）
                    const pending = s.child.stdin.writableLength ?? 0;
                    if (pending > limits.inputPendingBytes) {
                        denyJson(res, 429,
                            `相手が読んでいません（未読 ${Math.round(pending / 1024)}KB）。`
                            + ' 読まれるまで送れません');
                        return;
                    }
                    try {
                        if (data !== null) {
                            s.child.stdin.write(data);
                            s.inputBytes += bytes;
                        }
                        if (eof) s.child.stdin.end();
                    } catch (err) {
                        // 子が既に死んでいると EPIPE。落とさずに理由を返す
                        denyJson(res, 409, `標準入力に書けません: ${err.message}`);
                        return;
                    }
                    // 🚨 **入力が通ったら切断後の猶予を延ばす（#49）。**
                    //    監視盤は購読せずに入力できるので、これが無いと
                    //    **返事を書いている最中のセッションが猶予切れで殺される。**
                    execRegistry.noteInput(s);
                    // 入力も**記録に残して購読者全員に流す**。
                    // そうしないと別の端末から見ている側に「何を送ったか」が見えず、
                    // 再接続したときにも自分の入力が消える。
                    if (data !== null) execRegistry.emit(s, 'in', data);
                    if (eof) execRegistry.emit(s, 'note', '（標準入力を閉じました）');
                    await auditExec({
                        event: 'input', session: s.id, repo: s.repo ?? null, bytes, eof,
                        ...originHint(req),
                    }, s.repo ?? null);
                    res.writeHead(200, {
                        'content-type': 'application/json; charset=utf-8',
                        'cache-control': 'no-store',
                    });
                    res.end(JSON.stringify({
                        ok: true, bytes, seq: s.log.seq,
                        // 送った側が滞留に気付けるようにする（#26）
                        totalBytes: s.inputBytes,
                        pending: s.child?.stdin?.writableLength ?? 0,
                    }));
                    return;
                }
                let body = {};
                try { body = await readJson(req); } catch { /* from 無しでも良い */ }
                const from = Number(body.from);
                await auditExec({
                    event: 'reattach', session: s.id, repo: s.repo ?? null,
                    from: Number.isFinite(from) ? from : 0,
                }, s.repo ?? null);
                streamSession(req, res, s, Number.isFinite(from) ? from : 0);
                return;
            }
        }

        // 🔒 checkout。**このツールの主張そのもの**なので、git が exit 0 で通してしまう
        //    危険な checkout を明示的に拒否する。
        /**
         * 🔒 **取り込み（merge）。`--allow-write` が必要。**
         *
         * なぜ足したか: このツールが唯一持っている「衝突予測」と「取り込み順序の提案」が
         * **提案だけで実行できなかった**。実行するには `--allow-exec`（任意コマンド =
         * 遠隔コード実行）を開けるか、端末に戻るしかなかった。
         *
         * 🚨 **任意コード実行を増やさないための設計:**
         *   1. **衝突すると予測されたものは実行しない。** `merge-tree` で先に試して
         *      clean でなければ拒否する（作業ツリーを衝突状態にしない）。
         *      「判定できない」（submodule / 大きすぎる差分）も拒否する
         *   2. **カスタム merge driver があるリポジトリでは実行しない。**
         *      driver は `.gitattributes` + config で任意コマンドを起動する
         *      （衝突予測では `merge.<name>.driver=false` で潰しているが、
         *       本番の merge では潰すと結果が変わるので、実行そのものを断る）
         *   3. **hooks を通さない**（`core.hooksPath` を空のディレクトリに向ける）。
         *      `post-merge` / `prepare-commit-msg` / `commit-msg` はリポジトリ設定の
         *      コードなので、HTTP から起動できる状態にしない
         *   4. 作業ツリーが dirty なら拒否（未コミットの変更を巻き込まない）
         *   5. シーケンサ停止中は拒否（checkout と同じ理由）
         *
         * ⚠️ つまり**画面からできるのは「安全と分かっている取り込み」だけ**。
         *    それ以外は端末でやる、という線を引いている。
         */
        if (url.pathname === '/api/v0/merge') {
            if (!await gateMutation(req, res)) return;
            let body;
            try {
                body = await readJson(req);
            } catch (err) {
                denyJson(res, err.tooLarge ? 413 : 400, err.message);
                return;
            }
            const branch = String(body.branch ?? '');
            // 🚨 checkout と同じ理由で isSafeRef を通す（オプション注入 / reflog）
            if (!isSafeRef(branch)) { denyJson(res, 400, `ref が不正です: ${branch}`); return; }
            const wantPath = toNFC(String(body.worktree ?? ''));

            // 🔒 allowlist は選択中のリポジトリの worktree 一覧に対して引く（exec と同じ）
            const worktrees = await listWorktrees(repo);
            const wt = worktrees.find(w => samePath(w.path, wantPath));
            if (!wt) { denyJson(res, 400, `既知の worktree ではありません: ${wantPath}`); return; }
            if (wt.bare) { denyJson(res, 400, 'bare worktree では取り込めません'); return; }
            if (wt.prunable) { denyJson(res, 409, '作業ツリーが失われています'); return; }

            const refs = await refMap(repo);
            if (!resolveRef(refs, branch)) {
                denyJson(res, 400, `解決できない ref です: ${branch}`);
                return;
            }
            // 自分自身を取り込もうとしたら止める（git は「既に最新」だが意図が壊れている）
            if (wt.shortBranch && wt.shortBranch === branch) {
                denyJson(res, 400, `${branch} は今この worktree が居るブランチです`);
                return;
            }

            // 5. シーケンサ停止中は拒否（checkout と同じ）
            const seq = await sequencerState(wt.path).catch(() => ({}));
            const blockers = [
                [seq.rebasing, 'rebase 進行中'],
                [seq.merging, 'マージ未コミット（MERGE_HEAD あり）'],
                [seq.cherryPicking, 'cherry-pick 進行中'],
                [seq.reverting, 'revert 進行中'],
                [seq.bisecting, 'bisect 進行中'],
                [seq.sequencing, 'sequencer に未処理の操作が残っている'],
            ].filter(([f]) => f).map(([, label]) => label);
            if (blockers.length) {
                denyJson(res, 409,
                    `${blockers.join(' / ')} のため取り込みを拒否しました。`
                    + ' 先に --continue / --abort で決着させてください');
                return;
            }

            // 🚨 **filter の門は dirty の門より前に置く（9回目のレビュー。BLOCKING）。**
            //    以前は dirty の判定が先で、その `worktreeStatus()` に filter の名前を
            //    渡していなかったので、**「filter は任意コマンドを起動するので断ります」と
            //    409 で言う前に、その任意コマンドを1回実行していた**
            //    （実測: merge を断った後に marker が書かれていた）。
            //    応答の文面と実際に起きたことが違うのは、このリポジトリが最も重いとする嘘。
            //    ⚠️ **順序そのものが守り**なので変異で測る（`merge-filter-gate-order`）。
            // 2b. 🔒 **`.gitattributes` の filter も同じ理由で断る。**
            //     読み取り経路では `cat` に潰して読むが、**取り込みでは潰せない** —
            //     smudge を潰したまま merge すると**作業ツリーに書かれる中身が変わる**
            //     （git-lfs ならポインタのまま実体を上書きする）。潰すのも走らせるのも
            //     危ないので、driver と同じ「実行そのものを断る」に倒す（8回目のレビュー）。
            const filterNames = await repoFilterNames(wt.path);
            if (filterNames.length) {
                denyJson(res, 409,
                    `リポジトリ設定の filter があります（${filterNames.map(f => f.name).join(', ')}）。`
                    + ' filter は任意コマンドを起動し、無効化すると作業ツリーの中身が変わるので、'
                    + '画面からの取り込みは行いません。端末で実行してください');
                return;
            }

            // 4. dirty なら拒否（未コミットの変更を巻き込まない）
            const st = await worktreeStatus(wt.path, filterNames).catch(() => null);
            if (st === null) {
                denyJson(res, 409, '作業ツリーの状態を確認できませんでした（取り込みません）');
                return;
            }
            if (st.changed > 0 || st.unmerged > 0) {
                denyJson(res, 409,
                    `未コミットの変更が ${st.changed} 件あります（未マージ ${st.unmerged} 件）。`
                    + ' 巻き込まないよう取り込みを拒否しました。先にコミットか stash してください');
                return;
            }

            // 2. カスタム merge driver があるなら実行しない（任意コマンドが走る）
            const drivers = await mergeDriverNames(wt.path);
            if (drivers.length) {
                denyJson(res, 409,
                    `カスタム merge driver が設定されています（${drivers.join(', ')}）。`
                    + ' driver はリポジトリ設定の任意コマンドを起動するので、'
                    + '画面からの取り込みは行いません。端末で実行してください');
                return;
            }

            // 1. 衝突すると予測されたら実行しない（作業ツリーを衝突状態にしない）
            const from = wt.shortBranch ?? wt.head ?? 'HEAD';
            let pre;
            try {
                pre = await mergePreview(wt.path, from, branch, drivers);
            } catch (err) {
                denyJson(res, 409, `衝突の予測に失敗したので取り込みません: ${err.message}`);
                return;
            }
            if (pre.clean !== true) {
                const why = pre.clean === null
                    ? (pre.reason ?? '判定できませんでした（submodule か、差分が大きすぎます）')
                    : `衝突します: ${(pre.conflicts ?? []).slice(0, 5).join(', ')}`;
                denyJson(res, 409,
                    `${why}。画面からは「衝突しないと分かっている取り込み」だけ行います。`
                    + ' 端末で git merge して解決してください');
                return;
            }

            // 3. hooks を通さない（リポジトリ設定のコードを HTTP から起動させない）
            const { mkdtemp } = await import('node:fs/promises');
            const { tmpdir } = await import('node:os');
            const emptyHooks = await mkdtemp(join(tmpdir(), 'kjp-nohooks-'));
            await auditExec({
                event: 'merge', repo, worktree: wt.path, from, branch,
                ...originHint(req),
            }, repo);
            try {
                await git([
                    '-c', `core.hooksPath=${emptyHooks}`,
                    // 🔒 **署名も「リポジトリ設定のプログラム」。**
                    //    `commit.gpgsign=true` + `gpg.program=<任意>` は同じ .git/config に
                    //    書けるので、hooks と driver だけ潰しても穴が残っていた
                    //    （実測: 409 を返しながら gpg.program が走って marker が書かれた）。
                    //    検証側（merge.verifySignatures）も同じプログラムを起動する。
                    '-c', 'commit.gpgsign=false',
                    '-c', 'merge.verifySignatures=false',
                    '-c', 'gpg.program=false',
                    'merge', '--no-edit', '--end-of-options', branch,
                ], { cwd: wt.path, optionalLocks: true });
            } catch (err) {
                // 🚨 **失敗経路でも数え直す（8回目のレビュー。SERIOUS）。**
                //    `git merge` は**作業ツリーと index を書いた後に失敗しうる**
                //    （commit 生成の失敗・署名の失敗・同時実行・checkout の失敗）。
                //    成功経路だけが `sequencerState` を数え直していたので、
                //    **MERGE_HEAD と staged 変更を残したまま「git が取り込みを
                //    拒否しました」= 嘘**を返していた（実測: 409 の直後に
                //    `MERGE_HEAD: true` / `1 A. … b.txt`）。残るのは他のエージェントの
                //    worktree なので、そのエージェントが次に commit すると
                //    気付かないまま merge コミットになる。
                // 🚨 **キャッシュも捨てる。** 失敗経路だけ `cached = null` が無かったので、
                //    画面は TTL の間 clean のままだった。
                //    ⚠️ キャッシュはリポジトリごとなので、**そのリポジトリの分**を捨てる
                //       （`cached = null` のままだと ES モジュールは strict なので
                //        ReferenceError = この経路が丸ごと 500 になる。`node --check` では
                //        見えず、smoke の「半端な状態が残ったと言う」が拾った）。
                cachedByRepo.delete(repo);
                const seqAfter = await sequencerState(wt.path).catch(() => null);
                const stAfter = await worktreeStatus(wt.path).catch(() => null);
                // ⚠️ **「数え直せなかった」を「綺麗だ」と書かない**（分からないなら分からないと言う）
                const leftover = (seqAfter === null || stAfter === null)
                    ? { counted: false, dirty: null, merging: null, changed: null, unmerged: null }
                    : {
                        counted: true,
                        merging: seqAfter.merging === true,
                        changed: stAfter.changed,
                        unmerged: stAfter.unmerged,
                        dirty: seqAfter.merging === true
                            || stAfter.changed > 0 || stAfter.unmerged > 0,
                    };
                await auditExec({
                    event: 'merge-failed', repo, worktree: wt.path, from, branch,
                    error: err.message, leftover,
                }, repo);
                const parts = [];
                if (leftover.merging) parts.push('MERGE_HEAD あり');
                if (leftover.changed > 0) parts.push(`変更 ${leftover.changed} 件`);
                if (leftover.unmerged > 0) parts.push(`未解決 ${leftover.unmerged} 件`);
                const message = leftover.counted === false
                    ? '取り込みが失敗し、そのあとの作業ツリーの状態を数え直せませんでした。'
                        + '半端な状態が残っているかもしれません。端末で確認してください: '
                        + err.message
                    : (leftover.dirty
                        ? `取り込みは完了しませんでした。作業ツリーに半端な状態が残っています（${parts.join(' / ')}）。`
                            + ' 端末で git merge --abort か解決をしてください: ' + err.message
                        : `git が取り込みを拒否しました（作業ツリーは元のままです）: ${err.message}`);
                res.writeHead(409, {
                    'content-type': 'application/json; charset=utf-8',
                    'cache-control': 'no-store',
                });
                res.end(JSON.stringify({ error: message, leftover }));
                return;
            } finally {
                const { rm } = await import('node:fs/promises');
                await rm(emptyHooks, { recursive: true, force: true }).catch(() => {});
            }
            // 状態が変わったので**そのリポジトリの**キャッシュを捨てる
            // （全部消すと他のリポジトリの収集をやり直させるだけで無駄）
            cachedByRepo.delete(repo);
            // 🚨 **取り込んだ後の状態を数え直してから返す**（「取り込みました」を
            //    確かめずに言わない）。衝突状態になっていないことも見る
            const seqAfter = await sequencerState(wt.path).catch(() => ({}));
            const after = (await listWorktrees(repo)).find(w => samePath(w.path, wantPath));
            res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
            });
            res.end(JSON.stringify({
                ok: true,
                worktree: wt.path,
                branch,
                head: after?.head ?? null,
                shortBranch: after?.shortBranch ?? null,
                // 予測が clean だったのに衝突状態になったら、それは**予測が外れた**という事実
                conflicted: seqAfter.merging === true,
                warning: seqAfter.merging === true
                    ? '⚠ 衝突しないと予測したのに衝突状態になりました。端末で確認してください'
                    : null,
            }));
            return;
        }
        if (url.pathname === '/api/v0/checkout') {
            if (!await gateMutation(req, res)) return;
            let body;
            try {
                body = await readJson(req);
            } catch (err) {
                denyJson(res, err.tooLarge ? 413 : 400, err.message);
                return;
            }
            const ref = String(body.ref ?? '');
            // 🚨 isSafeRef を通す。`git update-ref refs/heads/--force <oid>` は作れてしまい、
            //    `resolveRef` は `refs/heads/` を前置して照合するので通る。argv では
            //    `--` より前なので `git checkout --force --` と解釈され、
            //    **未コミットの変更が黙って破棄される**（レビューで実証）。
            //    しかもこの ref は localBranches に載るので UI の候補に並ぶ。
            if (!isSafeRef(ref)) { denyJson(res, 400, `ref が不正です: ${ref}`); return; }
            const wantPath = toNFC(String(body.worktree ?? ''));

            // ⚠️ cwd に任意のパスを受け取らない。既知の worktree のみ。
            //    ここを緩めるとリポジトリ外で git を走らせられる。
            const worktrees = await listWorktrees(repo);
            const wt = worktrees.find(w => samePath(w.path, wantPath));
            if (!wt) { denyJson(res, 400, `既知の worktree ではありません: ${wantPath}`); return; }
            if (wt.bare) { denyJson(res, 400, 'bare worktree では checkout できません'); return; }
            if (wt.prunable) { denyJson(res, 409, '作業ツリーが失われています'); return; }

            // 🔒 **filter があるなら checkout もしない（9回目のレビュー。SERIOUS）。**
            //    `git checkout` は作業ツリーを書き換えるので **smudge filter を起動する**
            //    = リポジトリ設定の任意コマンドが `--allow-write` だけで走る。
            //    merge には同じ門を付けたのに、checkout には1つも無かった
            //    （「規則を書いた場所から遠いコードには適用し忘れる」の再発）。
            //    ⚠️ **シーケンサの判定より前**に置く。あとの判定は git を呼ぶので、
            //    後ろに置くと「断る」と言う前に filter が走りうる（merge で実際に踏んだ）。
            const coFilters = await repoFilterNames(wt.path);
            if (coFilters.length) {
                denyJson(res, 409,
                    `リポジトリ設定の filter があります（${coFilters.map(f => f.name).join(', ')}）。`
                    + ' checkout は作業ツリーを書き換えるので smudge filter'
                    + '（リポジトリ設定の任意コマンド）が走ります。'
                    + '画面からの切り替えは行いません。端末で実行してください');
                return;
            }

            const refs = await refMap(repo);
            if (!resolveRef(refs, ref)) {
                denyJson(res, 400, `解決できない ref です: ${ref}`);
                return;
            }

            // 🚨 シーケンサ停止中の checkout を拒否する。
            //    git はこれを exit 0 で通し、その後の `rebase --continue` は
            //    **別のブランチにリプレイする**。MERGE_HEAD も無警告で消える。
            //    v0 がこれを警告として検出しているのに、自分の checkout で
            //    それを起こしたら本末転倒。
            const seq = await sequencerState(wt.path).catch(() => ({}));
            const blockers = [
                [seq.rebasing, 'rebase 進行中'],
                [seq.merging, 'マージ未コミット（MERGE_HEAD あり）'],
                [seq.cherryPicking, 'cherry-pick 進行中'],
                [seq.reverting, 'revert 進行中'],
                [seq.bisecting, 'bisect 進行中'],
                // CHERRY_PICK_HEAD が消えていても sequencer/todo は残る
                [seq.sequencing, 'sequencer に未処理の操作が残っている'],
            ].filter(([f]) => f).map(([, label]) => label);
            if (blockers.length) {
                denyJson(res, 409,
                    `${blockers.join(' / ')} のため checkout を拒否しました。`
                    + ' git はこれを通しますが、続きの rebase --continue が別ブランチに'
                    + 'リプレイされたり MERGE_HEAD が無警告で消えます。'
                    + ' 先に --continue / --abort で決着させてください');
                return;
            }

            try {
                // optionalLocks: index の stat-cache 更新を許す（書き込み操作なので）
                // --end-of-options: ref がオプションとして解釈される余地を潰す（多層防御）
                await git(['checkout', '--end-of-options', ref, '--'],
                    { cwd: wt.path, optionalLocks: true });
            } catch (err) {
                // git 自身が拒否した場合（未コミットの変更が消える等）もここに来る
                denyJson(res, 409, `git が checkout を拒否しました: ${err.message}`);
                return;
            }
            cachedByRepo.delete(repo);   // 状態が変わったのでキャッシュを捨てる
            const after = (await listWorktrees(repo)).find(w => samePath(w.path, wantPath));
            res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
            });
            // ⚠️ 40桁 hex を渡すと detached HEAD になる。ok:true だけ返すと
            //    「そのブランチは以後進まない」ことに気付けないので警告を添える
            //    （レビューで指摘された。エージェントの worktree が detach されると
            //     そのブランチが止まる）。
            const detached = !after?.shortBranch;
            res.end(JSON.stringify({
                ok: true, worktree: wantPath,
                branch: after?.shortBranch ?? null, head: after?.head ?? null,
                detached,
                warning: detached
                    ? 'detached HEAD になりました。このままコミットしてもブランチは進みません。'
                    : null,
            }));
            return;
        }

        /**
         * 🔒 **最小エディタ（`--allow-write` の枠内）。**
         *
         *   `POST /api/v0/file`  … 編集のために作業ツリーの中身を読む
         *   `POST /api/v0/write` … 作業ツリーに書く
         *
         * なぜ2つとも POST か: どちらも `gateMutation()`（`--allow-write` /
         * POST / same-origin / `X-Kjp-Token`）を通す。読む側も **write の
         * capability の中**に置くのが分界の要点で、読み取り専用のデーモンからは
         * 経路そのものが存在しない（`fs` で作業ツリーを読むのはここだけ）。
         *
         * 🚨 **なぜ楽観ロックが核心か。** このツールは
         * 「N 個のエージェントが N 個の worktree で並行に動く」前提で作っている。
         * 画面で開いてから保存するまでの間に、そのエージェント自身がファイルを
         * 書き換えているのが**普通の状態**。読んだときの中身のハッシュ（`baseOid`）を
         * 突き合わせて、食い違ったら **409 で断る**。
         * 黙って上書きするのは、観測ツールとしては最悪の誤り
         * （「止めたつもりで走り続けている」と同じクラス）。
         *
         * ⚠️ `--allow-exec` は要らない。書き込みと実行は別の capability
         *    （ファイルを書けることと任意コマンドが動くことは危険度が桁違い）。
         */
        if (url.pathname === '/api/v0/file' || url.pathname === '/api/v0/write') {
            const forWrite = url.pathname === '/api/v0/write';
            // 🚨 **門の順序: 認可を最初に置く（本文を読む前）。** ここを後ろに回すと
            //    (a) 認可を持たない相手がエラーメッセージの違いから
            //        「そのパスが追跡されているか」を引き出せる（存在の走査）
            //    (b) 未認可の相手に大きな本文を送らせることになる
            //    ので、**フォールバックや解析より前**に置く。順序は変異で測っている
            //    （`write-gate-order`）。
            if (!await gateMutation(req, res)) return;   // ← 門1: 認可
            let body;
            try {
                body = await readJson(req, forWrite ? MAX_WRITE_BODY_BYTES : 64 * 1024);
            } catch (err) {
                denyJson(res, err.tooLarge ? 413 : 400, err.message);
                return;
            }
            // ← 門2〜5: パスの形 / 既知の worktree / 追跡下 / 実体と中身
            const t = await requireEditTarget(req, res, body, { forWrite, repo });
            if (!t) return;                          // ← 応答は関門が書いている
            try {
                if (!forWrite) {
                    res.writeHead(200, {
                        'content-type': 'application/json; charset=utf-8',
                        'cache-control': 'no-store',
                    });
                    res.end(JSON.stringify({
                        ok: true,
                        worktree: t.wt.path,
                        path: t.rel,
                        // ⚠️ LF に畳んだテキストを返す（textarea の value は LF）。
                        //    書き戻すときに元の流儀へ戻すのはサーバの責任にする
                        //    （クライアントに改行コードを持たせると必ず壊れる）。
                        text: toEditorText(t.buf),
                        oid: t.info.oid,
                        eol: t.info.eol,
                        bom: t.info.bom,
                        bytes: t.info.bytes,
                    }));
                    return;
                }
                const text = typeof body.text === 'string' ? body.text : null;
                if (text === null) { denyJson(res, 400, 'text（文字列）が必要です'); return; }
                // NUL を書くとバイナリファイルになる（もう画面から開けなくなる）
                if (text.includes('\0')) {
                    denyJson(res, 400, 'NUL を含む内容は書きません');
                    return;
                }
                // 🔒 **楽観ロック。** 形の検証を先にする（40桁 hex 以外は比較に入れない）
                const baseOid = String(body.baseOid ?? '');
                if (!/^[0-9a-f]{40}$/.test(baseOid)) {
                    denyJson(res, 400,
                        'baseOid（読んだときの oid）が必要です。'
                        + ' POST /api/v0/file で読み直してから保存してください');
                    return;
                }
                if (baseOid !== t.info.oid) {
                    // 🔒 **記録に残す（中身は残さない）。** 並行して書いている相手が
                    //    いたことは、後から事故を追うのに一番効く情報。
                    await auditExec({
                        event: 'write-conflict', worktree: t.wt.path, path: t.rel,
                        expected: baseOid, actual: t.info.oid, ...originHint(req),
                    });
                    denyJson(res, 409,
                        '他が書き換えました。読み直してください'
                        + `（読んだとき ${baseOid.slice(0, 8)} / 今 ${t.info.oid.slice(0, 8)}）`);
                    return;
                }
                const next = encodeForWorktree(text, t.info);
                if (next.length > MAX_EDIT_BYTES) {
                    denyJson(res, 413,
                        `${MAX_EDIT_BYTES} バイトを超える内容は書きません（${next.length} バイト）`);
                    return;
                }
                // 🚨 **書いてから縮める。** 先に truncate(0) すると、その間に落ちた場合に
                //    **空のファイル**が残る（中身が消える）。この順なら最悪でも
                //    「新しい中身 + 古い末尾」で、git から見て回復できる。
                await t.fh.write(next, 0, next.length, 0);
                await t.fh.truncate(next.length);
                // 🔒 監査に残す。**中身は残さない**（記録が秘密の持ち出し口になる）。
                //    残すのは「いつ・どの worktree の・どのパスを・何バイト」だけ。
                await auditExec({
                    event: 'write', repo, worktree: t.wt.path, path: t.rel,
                    bytes: next.length, eol: t.info.eol, bom: t.info.bom,
                    ...originHint(req),
                }, repo);
                // 作業ツリーが変わったので**そのリポジトリの**キャッシュを捨てる
                cachedByRepo.delete(repo);
                res.writeHead(200, {
                    'content-type': 'application/json; charset=utf-8',
                    'cache-control': 'no-store',
                });
                res.end(JSON.stringify({
                    ok: true,
                    worktree: t.wt.path,
                    path: t.rel,
                    bytes: next.length,
                    // 次の保存のための新しい oid（読み直さずに続けて編集できる）
                    oid: blobOid(next),
                    eol: t.info.eol,
                    bom: t.info.bom,
                }));
            } finally {
                // ⚠️ 開いたハンドルは必ず閉じる（Windows では開いたままだと
                //    他のプロセスが書けなくなる）
                await t.fh.close().catch(() => { /* 既に閉じている */ });
            }
            return;
        }

        // ファイルの中身と差分。**追跡されている内容だけ**を返す（git オブジェクト経由）。
        // fs で読まないので、リポジトリ外や未追跡の秘密ファイルには触れない。
        // 引数の検証は git.mjs の isSafeRef / isSafeRepoPath が持つ。
        if (url.pathname === '/api/v0/blob' || url.pathname === '/api/v0/diff') {
            const path = url.searchParams.get('path') ?? '';
            const ref = url.searchParams.get('ref') ?? 'HEAD';
            try {
                const body = url.pathname === '/api/v0/blob'
                    ? await showBlob(repo, ref, path)
                    : await fileDiff(repo, url.searchParams.get('base') ?? 'HEAD', ref, path);
                res.writeHead(200, {
                    'content-type': 'application/json; charset=utf-8',
                    'cache-control': 'no-store',
                });
                res.end(JSON.stringify(body));
            } catch (err) {
                // 不正な引数と「見つからない」を 400 で返す。500 にしない
                res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: String(err && err.message || err) }));
            }
            return;
        }
        // ブラウザと unit テストで共有しているモジュール。
        // ここに置く理由は ndjson.mjs の冒頭コメント参照（ブラウザ内だとテストできない）。
        if (url.pathname === '/ndjson.mjs' || url.pathname === '/argv.mjs'
            || url.pathname === '/chatfilter.mjs' || url.pathname === '/panelayout.mjs'
            || url.pathname === '/pathlabel.mjs' || url.pathname === '/mergeresult.mjs'
            || url.pathname === '/linediff.mjs' || url.pathname === '/blobview.mjs'
            || url.pathname === '/dirlabel.mjs'
            || url.pathname === '/mergeplan.mjs'
            || url.pathname === '/panegrid.mjs') {
            const js = await readFile(join(HERE, url.pathname.slice(1)));
            res.writeHead(200, {
                'content-type': 'text/javascript; charset=utf-8',
                'cache-control': 'no-store',
            });
            res.end(js);
            return;
        }
        // 統合 UI。以前は index.html と layout-prototype.html に割れていて、
        // 機能が揃っているのに片方ずつしか使えなかった（/layout は互換のため残す）。
        if (url.pathname === '/' || url.pathname === '/index.html'
            || url.pathname === '/layout' || url.pathname === '/layout-prototype.html') {
            const html = await readFile(join(HERE, 'app.html'));
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
            return;
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found\n');
    } catch (err) {
        // 🚨 **例外のメッセージをクライアントに返さない。** 内部のパスや git の
        //    出力が入りうるので、認証を通っていない相手にも渡ることになる
        //    （401 の本文にトークンの手掛かりを出さないのと同じ理由。#42 で気付いた）。
        //    原因はサーバのログに出す。
        console.error('⚠ 要求の処理で例外（内側で捕まえました）:', err);
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'internal error' }));
    }
}

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

// リポジトリとして開けるかを先に確認して、UI で 500 を見せずに済ませる。
// ⚠️ ついでに**リポジトリのルートへ正規化する。**
//    サブディレクトリを cwd にすると `merge-tree` が
//    「cwd からの相対パス」で衝突ファイルを出すので `../shared.txt` になり、
//    `overlaps[].path`（ルート相対）と基準が食い違う。さらに
//    `isSafeRepoPath` が `..` を弾くので UI から開けなくなる（レビュー指摘）。
// ⚠️ **1本でも開けなければ起動しない。** 黙って落とすと「登録したつもりの
//    リポジトリが一覧に無い」を起動ログを読まないと気付けない（打ったフラグを
//    黙って捨てない、と同じ根拠）。
{
    const normalized = [];
    for (const given of opts.repos) {
        try {
            // 🚨 **bare では `--show-toplevel` が exit 128 で落ちる**
            //    （`fatal: this operation must be run in a work tree`）。空文字を返すのではない。
            //    そのため以前は bare リポジトリを「git リポジトリとして開けません」と
            //    誤って拒否していた。**bare を親にして linked worktree を並べる構成**は
            //    エージェントを並列に走らせる普通のやり方なので、受け付ける。
            //    （これが `wt.bare` の門が到達不能だった原因でもある。#33）
            let top = '';
            try { top = (await git(['rev-parse', '--show-toplevel'], { cwd: given })).trim(); }
            catch { /* bare。下で判定する */ }
            let resolved = given;
            if (top) {
                if (!samePath(top, given)) {
                    console.log(`repo をリポジトリのルートに解決しました: ${given} → ${top}`);
                }
                resolved = top;
            } else {
                const bare = (await git(['rev-parse', '--is-bare-repository'], { cwd: given })).trim();
                if (bare !== 'true') {
                    throw new Error('作業ツリーが無く、bare でもありません（.git の中を指していませんか）');
                }
                console.log(`bare リポジトリを見ています: ${given}`
                    + '（作業ツリーは linked worktree 側にあります）');
            }
            // ⚠️ 重複は `===` ではなく `samePath()` で潰す。同じ場所を別表記で
            //    2回渡されると、セレクトに2行出て**キャッシュも2重**になる
            //    （TTL の無効化が片方にしか効かない）。
            if (normalized.some(r => samePath(r, resolved))) {
                console.log(`repo が重複しているので1本にまとめました: ${given}`);
                continue;
            }
            normalized.push(resolved);
        } catch (err) {
            console.error(`\n✖ git リポジトリとして開けません: ${given}`);
            console.error(`  ${err.message}\n`);
            console.error('  --repo でリポジトリのパスを指定してください（複数可）:');
            console.error('      node v0/server.mjs --repo C:/path/to/repo --repo D:/other/repo\n');
            process.exit(1);
        }
    }
    opts.repos = normalized;
}

// 🔒 ループバックのみ。--port 0 で OS に空きポートを選ばせる（テスト用）
// 🔒 --allow-exec は自動生成トークンを許さない。
//
// 理由: 実行を遠隔から使うなら、再起動で変わるトークンでは運用できず、
//       結果として「トークンを楽な場所に置く」方向へ流れる。
//       明示的に --token を要求すれば、有効化が必ず意識的な操作になる。
//       うっかり --allow-exec だけ付けて起動する事故も防げる。
// 🔒 --token-file: トークンを永続化する。
//
// 理由: 起動ごとにランダムだと遠隔から使うたびに貼り直しになり、
//   結果として「楽な場所に置く」方向へ流れる（--allow-exec が --token を
//   必須にしているのと同じ理屈）。ファイルに置けば運用できる。
// ⚠️ 代わりに「再起動で無効化される」性質を失う。だから**明示的なオプション**にし、
//   既定では使わない。作るときは所有者のみ読める権限（0600）にする。
/**
 * 🚨 **「リポジトリの中か」の判定を1箇所にする。**
 *
 * `--token-file` にはこの門があったのに、**同じ危険を持つ `--audit-log` には
 * 1つも無かった**（8回目のレビュー）。監査ログは exec の argv を**マスクせずに**
 * 保存するので、worktree の中に落ちると常時 `git add -A` するエージェントが
 * そのままコミットし、push で外に出る（実データで 24 文字以上のトークン様文字列を
 * 含む argv が 2 件あった）。`--help` が「既定は `<GIT_DIR>` 内。実行した相手が
 * 消せる」と書いて外に出すことを促すので、リポジトリ直下を指す動機まであった。
 *
 * 経路ごとに書くと1つ忘れる（認可の関門と同じ理屈）。**関数にして両方が通る。**
 *
 * @returns {{inside: boolean} | {unknown: true}} 判定できないときは unknown
 *   （⚠️ 分からないことを「外」と断定しない）
 */
async function insideRepoGate(target) {
    const roots = [];
    const gitDirs = [];
    // 🚨 **登録した全リポジトリを見る。** 1本目だけ調べると、2本目のリポジトリの
    //    中を指した `--token-file` / `--audit-log` が門を素通りしてコミットされる
    //    （「メイン worktree の top だけでは足りない」#39 の再発を、
    //      **リポジトリの本数**という別の軸で作らない）。
    for (const r0 of opts.repos) {
        try {
            const top = (await git(['rev-parse', '--show-toplevel'], { cwd: r0 })).trim();
            if (top) roots.push(top);
        } catch { /* bare。失敗を「外」と読まない */ }
        // .git 本体（bare のリポジトリ自身もここに入る）
        try {
            const common = (await commonDir(r0)).trim();
            if (common) { roots.push(common); gitDirs.push(common); }
        } catch { /* noop */ }
        // 全 worktree の作業ツリー
        try {
            for (const w of await listWorktrees(r0)) if (w.path) roots.push(w.path);
        } catch { /* noop */ }
    }
    // ⚠️ 何も分からなかったときに「外」と断定しない（分からないと言う）
    if (!roots.length) return { unknown: true };
    // ⚠️ relative() では駄目。表記が違うと外れて、秘密がコミットされる
    //    （macOS の /var→/private/var、Windows の RUNNER~1 で実際に外れた）
    return {
        inside: roots.some(r => containsPath(r, target)),
        // 🚨 **`.git` の中かどうかも一緒に返す。** 監査ログは `.git` の中（既定）を
        //    許すので呼び出し側がこれを要る。ここで返さないと呼び出し側が
        //    `commonDir()` を再度叩くことになり、しかも**1本目だけ**を見る
        //    単一 repo 前提の判定に戻る（複数リポジトリでは B の .git を
        //    「worktree の中」と誤判定して既定の置き場所を拒否する）。
        inGitDir: gitDirs.some(d => containsPath(d, target)),
    };
}

// 🔒 **監査ログも worktree の中に置かせない。**
//    argv をマスクせずに保存するので、置いた場所がそのままコミットされる
//    （8回目のレビュー。`--token-file` には門があったのにこちらは素通りだった）。
//    ⚠️ `.git` の中（既定）は許す — `git add -A` では追跡されないので、
//       ここを拒否すると既定の置き場所を自分で否定することになる。
if (opts.auditLog) {
    const gate = await insideRepoGate(opts.auditLog);
    // worktree の中かどうかを分けて判定する（.git の中は許す）。
    // ⚠️ 判定は `insideRepoGate()` が**全リポジトリ分**まとめて返す。
    //    ここで commonDir を叩き直すと1本目だけを見ることになり、
    //    2本目の `.git` を「worktree の中」と誤判定して既定の場所を拒否する。
    //    `.git` が1つも分からなければ gitDirs が空 = 安全側（拒否）に倒れる。
    const inWorktree = gate.inside === true && gate.inGitDir !== true;
    if (inWorktree) {
        console.error(`\n✖ --audit-log を worktree の中に置かないでください: ${opts.auditLog}\n`);
        console.error('  監査ログは実行した argv をそのまま保存します（マスクしません）。');
        console.error('  worktree の中に置くと、エージェントの `git add -A` でコミットされ、');
        console.error('  push で外に出ます（実データにトークン様の文字列を含む argv がありました）。');
        console.error('  ホームディレクトリの下など、リポジトリの外を指定してください\n');
        process.exit(1);
    }
    if (gate.unknown) {
        console.error('⚠ --audit-log がリポジトリの中かどうか判定できませんでした'
            + `（worktree 一覧が取れません）: ${opts.auditLog}`);
        console.error('  コミットされていないか自分で確認してください。');
    }
}

// ⚠️ リポジトリの中に置かせない（コミットされる）。
if (opts.tokenFile) {
    const { readFile: rf, writeFile: wf, chmod } = await import('node:fs/promises');
    // 🚨 **メイン worktree の top だけでは足りない。**
    //    このツールが存在理由にしている **linked worktree** が全部素通りしていた。
    //    N 個のエージェントは常時 `git add -A` するので、置いたトークンはそのまま
    //    commit に入る（実測で `git show HEAD:token` にトークン本体が出た）。
    //    さらに bare では `--show-toplevel` が exit 128 で落ち、catch → false で
    //    **門が丸ごと無効**だった（cc7e9b0 で直したのと同じクラスの再発。#39）。
    const gate = await insideRepoGate(opts.tokenFile);
    if (gate.inside) {
        // ⚠️ 理由を場所ごとに正しく言う。`.git` の中は `git add -A` では追跡されないので、
        //    「コミットされます」だけを理由にすると嘘になる（それでも置き場所としては誤り）。
        console.error(`\n✖ --token-file をリポジトリの中に置かないでください: ${opts.tokenFile}\n`);
        console.error('  worktree の中に置くと、エージェントの `git add -A` でコミットされます。');
        console.error('  .git の中はコミットはされませんが、リポジトリを消すと一緒に消えます。');
        console.error('  ホームディレクトリの下など、リポジトリの外を指定してください\n');
        process.exit(1);
    }
    if (gate.unknown) {
        console.error('⚠ --token-file がリポジトリの中かどうか判定できませんでした'
            + `（worktree 一覧が取れません）: ${opts.tokenFile}`);
        console.error('  コミットされていないか自分で確認してください。');
    }
    try {
        opts.token = (await rf(opts.tokenFile, 'utf8')).trim();
        if (opts.token.length < 24) throw new Error('短すぎます');
    } catch {
        opts.token = randomBytes(32).toString('base64url');
        await wf(opts.tokenFile, `${opts.token}\n`, { encoding: 'utf8', mode: 0o600 });
        try { await chmod(opts.tokenFile, 0o600); } catch { /* Windows では効かない */ }
        console.log(`トークンを生成して保存しました: ${opts.tokenFile}`);
    }
}

/* =========================================================================
 * 🔒 読み取り経路の認証を要求するかを決める。
 *
 * 判断: **トンネルを開けた瞬間から必須。** ループバックだけなら不要。
 *   - ループバックには別サイトから届かない（入口の Sec-Fetch-Site 検証）ので、
 *     摩擦を足す意味が薄い
 *   - --allow-host を付けた時点で「サーバに届く相手」が広がる。そこからは
 *     「届く」と「操作してよい」を分ける必要がある（docs/auth-ordering.md）
 * ========================================================================= */
if (opts.requireAuth === null) opts.requireAuth = opts.allowHosts.size > 0;
if (opts.requireAuth === false && opts.allowHosts.size > 0) {
    // ⚠️ 黙って無認証のままトンネルに出す状態を作らない。起動を止める。
    console.error('\n✖ --no-auth と --allow-host は併用できません。');
    console.error('  トンネルに届く相手が全員、無認証で差分を読める状態になります。');
    console.error('  ループバックだけで使うなら --allow-host を外してください。\n');
    process.exit(1);
}
// 🚨 **検査専用の経路をトンネルに出さない（#64。10回目のレビュー / SERIOUS）。**
//    `--layout-probe` は `/__shutdown`（デーモンを落とす）と `/__throw`
//    （必ず例外を起こす）を生やす。門の後ろに移したとはいえ、
//    **検査のためだけの経路をトンネルに届く相手に見せる理由が無い。**
//    ⚠️ `--no-auth` × `--allow-host` と同じ「黙って危ない構成を作らない」型なので、
//       警告ではなく起動を止める（警告は読まれない）。
if (opts.layoutProbe && opts.allowHosts.size > 0) {
    console.error('\n✖ --layout-probe と --allow-host は併用できません。');
    console.error('  検査専用の経路（/__shutdown /__throw）をトンネルに出すことになります。');
    console.error('  レイアウト検査はループバックで走らせてください。\n');
    process.exit(1);
}
// 🚨 **実行の門は自動生成より「前」に置く。**
//    以前は `requireAuth && !opts.token` の自動生成が先にあったので、
//    `--allow-exec --require-auth` や `--allow-exec --allow-host <name>` では
//    **門が消えて自動生成トークンで起動できた**（6回目のレビューが実測。
//    43文字の自動生成トークンで `POST /api/v0/exec` が 200 を返した）。
//    しかも `--allow-host` は requireAuth を自動でオンにするので、
//    **門が最も効くべきトンネル構成でだけ門が無い**という最悪の形だった。
//    ここで見るのは「値の長さ」ではなく **`--token` / `--token-file` で
//    明示的に決めたか**（それが「有効化を必ず意識的な操作にする」という趣旨）。
//    ⚠️ **明示だけでは足りない。長さの下限も残す**（`--token short` を通してしまった）。
//       「明示的に決めたこと」と「推測されない長さ」は別の要求。
// 🚨 **長さの下限は capability を問わず掛ける（7回目のレビュー）。**
//    以前は下限が `--allow-exec` のときだけだったので、`--token abc` がそのまま通った。
//    `--allow-host` を付けた瞬間、トンネルに届く相手に対する**唯一の壁がこのトークン**
//    なのに、`aaa,aab,…` の総当たりで**29回目に 200** が返った（実測）。
//    当たれば読み取り全部と `POST /api/v0/checkout` が通る
//    （post-checkout フックがあるリポジトリでは実質コード実行）。
//    ⚠️ 正規の経路（`scripts/serve.mjs`）は必ず `--token-file` を渡すので
//    短いトークンは作れないが、手打ちの `node v0/server.mjs --token <短い>` で露出する。
//    **意志ではなく仕組みで防ぐ。**
if (opts.token !== null && opts.token.length < 24) {
    console.error(`\n✖ --token は 24 文字以上にしてください（受け取った長さ: ${opts.token.length}）。`);
    console.error('  トンネルに出すとこのトークンが唯一の壁になります');
    console.error('  （実測: 3文字なら総当たりで29回目に通った）。\n');
    console.error('  生成例:');
    console.error('      node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"\n');
    process.exit(1);
}

if (opts.allowExec && (!opts.tokenExplicit || !opts.token || opts.token.length < 24)) {
    console.error('\n✖ --allow-exec には --token（24 文字以上）か --token-file が必要です。');
    console.error('  実行を遠隔から引けるようにするので、トークンは明示的に決めてください');
    console.error('  （自動生成では通しません。--require-auth や --allow-host を');
    console.error('   一緒に付けても同じです）。\n');
    console.error('  生成例:');
    console.error('      node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"');
    console.error('');
    console.error('  起動例:');
    console.error('      node v0/server.mjs --allow-exec --token <生成した値>');
    console.error('      node v0/server.mjs --allow-exec --token-file ~/.kjp-edit/token-exec\n');
    process.exit(1);
}

// 認証するならトークンが要る（書き込み・実行を使わない場合も）
if (opts.requireAuth && !opts.token) {
    opts.token = randomBytes(32).toString('base64url');
}
// 書き込みだけなら起動ごとのランダムで十分（再起動で無効化される）
if (opts.allowWrite && !opts.token) {
    opts.token = randomBytes(32).toString('base64url');
}

server.listen(opts.port, '127.0.0.1', () => {
    const { port } = server.address();
    console.log(`kjp-edit v0  →  http://127.0.0.1:${port}`);
    // 🔒 **読める範囲を必ず全部出す。** 何本見ているかを起動ログで確かめられないと、
    //    「登録したつもり」と「実際に読める範囲」がずれても気付けない。
    if (opts.repos.length === 1) console.log(`repo: ${opts.repos[0]}`);
    else {
        console.log(`repo: ${opts.repos.length} 本（1本目が既定。この範囲だけが読めます）`);
        for (const [i, r] of opts.repos.entries()) {
            console.log(`  ${i === 0 ? '*' : ' '} ${r}`);
        }
    }
    if (opts.allowHosts.size) {
        console.log(`許可した Host: ${[...opts.allowHosts].join(', ')}`);
    }
    // 🚨 **トークンが必要になる条件は「認証」だけではない。**
    //    書き込み・実行も `X-Kjp-Token` を要求する。ブラウザは
    //    `?token=` 付き URL から sessionStorage に入れる経路しか持たないので、
    //    **URL を出さないと UI から checkout も実行も絶対にできない**
    //    （それでも「⚠️ 書き込み有効」と表示するので、有効に見えて必ず 403 になる）。
    //    前のコミットで `/api/v0/session` の払い出しを締めたときに、
    //    受け渡し経路を requireAuth の中だけに残してしまった回帰（レビューで実測）。
    if (opts.requireAuth || opts.allowWrite || opts.allowExec) {
        console.log('');
        if (opts.requireAuth) console.log('🔒 読み取りにもトークンが必要です (--require-auth)。');
        else console.log('🔑 書き込み・実行にはトークンが必要です。');
        // 🔒 **案内の URL に生トークンを載せない（8回目のレビュー）。**
        //    URL はアドレスバー・入力履歴・ブックマーク（クラウド同期）・
        //    中継のログに残る。載せるのは**読み取り専用の派生秘密**だけにして、
        //    書き込み・実行の鍵は画面に貼る操作で渡す（履歴に残らない）。
        const readKey = cookieSecret();
        console.log('   **この URL を1回開いてください**（読み取り用。ブラウザが保持します）:');
        console.log(`     http://127.0.0.1:${port}/?token=${readKey}`);
        for (const h of opts.allowHosts) {
            console.log(`     https://${h}/?token=${readKey}`);
        }
        if (opts.allowWrite || opts.allowExec) {
            console.log('');
            console.log(`   ${opts.allowExec ? '🚨 実行' : '⚠️ 書き込み'}に使う鍵は URL に載せません`
                + '（履歴とブックマークに残るため）。');
            console.log('   画面の「鍵を貼る」に1回貼ってください（そのタブだけが持ちます）:');
            console.log(`     ${opts.token}`);
        }
        if (opts.tokenFile) console.log(`   トークンの置き場所: ${opts.tokenFile}`);
        else console.log('   ⚠️ 再起動すると変わります（--token-file で固定できます）');
    }
    if (opts.allowExec) {
        console.log('');
        console.log('🚨 実行有効 (--allow-exec)。任意のコマンドが動きます。');
        console.log('   これは定義上そのまま remote code execution です。');
        console.log('   トンネルに届く相手 = このマシンでコードを実行できる相手 になります。');
        console.log('   トンネルは必ずループバックで終端し、トンネル側で認証してください');
        console.log('   （tailscale serve など。funnel / quick tunnel は使わないこと）。');
        // ⚠️ 実際の置き場所を出す。既定の場所は**実行した相手が消せる**ので、
        //    どこに書いているかを起動時に見せる（--audit-log で外に出せる）。
        console.log(`   監査ログ: ${opts.auditLog ?? '<GIT_DIR>/kjp-exec-audit.jsonl（実行した相手が消せます）'}`);
        console.log(`   上限 ${opts.execTimeoutMs / 1000}s / 同時 ${MAX_CONCURRENT_EXEC} 本`);
    } else if (opts.allowWrite) {
        console.log('');
        console.log('⚠️ 書き込み有効 (--allow-write)。checkout と'
            + '追跡ファイルの編集・保存が可能です。');
        console.log('   トンネルを開けている場合、そのトンネルに届く相手は');
        console.log('   ブランチを切り替え、追跡されているファイルを書き換えられます。');
        console.log('   読み取りだけで良いなら外してください。');
        console.log(`   監査ログ: ${opts.auditLog ?? '<GIT_DIR>/kjp-exec-audit.jsonl（書いた相手が消せます）'}`);
    } else {
        console.log('読み取り専用（書き込みは --allow-write で有効化）');
    }
    // 🔒 読み取りの範囲を広げる変更なので、有効なときは必ず言う。
    //    「いつリポジトリ外を読み始めたか」を後から思い出せない状態を作らない。
    if (opts.watchAgents) {
        console.log('');
        console.log('⚠️ 活動観測 有効 (--watch-agents)。エージェントのセッション記録を読みます。');
        console.log(`   読む場所: ${transcriptRoot()}（リポジトリの外）`);
        if (opts.allowTranscriptText) {
            console.log('🚨 発話とコマンド行も出します (--allow-transcript-text)。');
            console.log('   トンネルに届く相手が、エージェントとの会話とコマンド行を読めます。');
        } else {
            console.log('   画面に出すのは状態・ツール名・パス・件数だけです（自由文は出しません）。');
        }
        console.log('   ツールの結果（読んだファイルの中身・コマンド出力）は');
        console.log('   どちらのフラグでも出しません（docs/agent-observation.md の T5）。');
    }
    console.log('停止: Ctrl+C');
});

/**
 * 終了処理。**1つの関数にして、全ての落ち方から必ず通す。**
 *
 * 🚨 以前は `SIGINT` と `SIGTERM` の2つにしか登録していなかった（9回目のレビュー）。
 *    そのため:
 *    - **`SIGHUP`（端末を閉じる）で子が置き去りになる。** 「Ctrl+C で停止」と
 *      案内しているが、常用の起動は端末に張り付いているので**端末を閉じる**方が
 *      普通の終わり方。POSIX の子は `detached:true`（別プロセスグループ）なので
 *      端末の HUP は子には届かない = 確実に生き残る。
 *    - **`uncaughtException` / `unhandledRejection` でも置き去りになる。**
 *      `scripts/mutate.mjs` は同じ形の砦を3段（シグナル・例外・拒否）で持っていて、
 *      そこには SIGHUP もあるのに、**子を持つ本体側に無かった**
 *      （「規則を書いた場所から遠いコードには適用し忘れる」型）。
 * 🚨 **殺した後に数え直す**（`killTree` に任せる）。数え切れなかったものは
 *    stderr に pid を出す。黙って終わると、残った子を探す手掛かりが消える。
 */
async function shutdown(reason, exitCode = 0) {
    if (shuttingDown) return;
    // 🚨 印を**最初に**立てる。`await` の後だと、その隙に届いた
    //    `POST /api/v0/exec` が掃き取りの後で spawn される
    shuttingDown = true;
    // ⚠️ 走っている exec を置き去りにしない。Windows では libuv が
    //    SILENT_BREAKAWAY_OK を立てるので、サーバが死んでも孫は回収されない。
    // ⚠️ 切断では殺さなくなったが、**サーバ終了時は必ず殺す。**
    const jobs = [];
    for (const s of execRegistry.running) {
        // 🚨 **起動途中（`child === null`）を飛ばさない。** 以前は `if (s.child)` で
        //    黙って飛ばしていたので、`create()` と `spawn()` の間にいたセッションは
        //    印も付かずに spawn され、寿命管理の外に落ちていた。
        //    印を付けておけば spawn 側（attachChild の直後）が始末する。
        s.killRequested = s.killRequested ?? 'shutdown';
        if (!s.child) continue;
        jobs.push(killTree(s.child).then(r => ({ s, r }), () => ({ s, r: null })));
    }
    // ⚠️ 集約待ちの認証失敗を落とさない（「何本外されたか」を残して終わる）
    authFails.flushAll('shutdown').catch(() => {});
    mutationFails.flushAll('shutdown').catch(() => {});
    // 🚨 **数え直しの結果を待って、残ったものを告げる。** 以前は `catch(() => {})` で
    //    投げっぱなしにして 800ms 後に `process.exit(0)` していたので、
    //    「止まったか」を一度も見ずに終わっていた。
    const results = await Promise.race([
        Promise.all(jobs),
        new Promise(r => setTimeout(() => r(null), 5000)),
    ]);
    if (results === null) {
        console.error(`⚠ ${reason}: 子プロセスの停止を 5s 以内に確認できませんでした`);
    } else {
        const left = results.filter(x => x.r && !x.r.killed);
        for (const x of left) {
            console.error(`⚠ ${reason}: ${x.s.id} を止め切れませんでした: ${x.r.why}`);
        }
        if (left.length) {
            console.error('   残った pid は手で確認してください'
                + (process.platform === 'win32' ? '（taskkill /PID <pid> /T /F）' : '（kill -9 <pid>）'));
        }
    }
    // 🚨 **起動途中のセッションが片付くまで待つ**（印を付けるだけでは足りない）。
    //    印を見て殺すのは spawn 側なので、そこまで待たずに `process.exit(0)` すると
    //    **殺している途中でデーモンが消えて子が生き残る**
    //    （実測: 検査が pid 34404 を捕まえた。撃つ前の木の列挙に約1秒かかるので
    //      800ms の強制終了と必ず競争する）。`done` になるまで数え直す。
    for (let i = 0; i < 60 && execRegistry.running.length; i++) {
        await new Promise(r => setTimeout(r, 100));
    }
    const pending = execRegistry.running;
    for (const s of pending) {
        console.error(`⚠ ${reason}: ${s.id} が ${s.state} のまま残りました`
            + `（argv: ${s.argv?.[0] ?? '?'}）`);
    }
    // 🚨 **異常終了は 0 で終わらせない。** 例外から来た終了を exit 0 にすると、
    //    落ちたのに「綺麗に終わった」と読める（起動口や CI が成功と読む）。
    server.close(() => process.exit(exitCode));
    // ソケットが残っていても確実に終わらせる
    setTimeout(() => process.exit(exitCode), 800).unref();
}

// 🚨 SIGHUP = 端末を閉じたとき。SIGBREAK = Windows の Ctrl+Break。
//    どちらも「普通に起きる終わり方」なので、ここから漏らすと子が残る。
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    // ⚠️ `SIGBREAK` は POSIX に無い（`process.on` は受けるが飛んで来ない）。
    //    登録しても害は無いので分岐を増やさない。
    process.on(sig, () => { shutdown(sig).catch(() => process.exit(1)); });
}
// 🚨 例外で落ちるときも子を回収する（`finally` はプロセスの即死には効かないが、
//    ここは即死ではないので効く）。**落ちた理由も必ず出す**（黙って終わらせない）。
process.on('uncaughtException', err => {
    console.error(`🚨 uncaughtException: ${err?.stack ?? err}`);
    shutdown('uncaughtException', 1).catch(() => process.exit(1));
});
process.on('unhandledRejection', err => {
    console.error(`🚨 unhandledRejection: ${err?.stack ?? err}`);
    shutdown('unhandledRejection', 1).catch(() => process.exit(1));
});
