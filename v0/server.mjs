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
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';
import {
    git, listWorktrees, log, aheadBehind, commonDir,
    changedFiles, worktreeStatus, sequencerState,
    refMap, resolveRef, worktreeGitDirs, stats,
    showBlob, fileDiff, toNFC, samePath, containsPath, isSafeRef, mergePreview, mergeDriverNames,
} from './git.mjs';
import { computeSwimlanes } from './swimlanes.mjs';
import { planMerge } from './mergeplan.mjs';
import { collectAgents, transcriptRoot } from './transcript.mjs';
import { ExecRegistry, isSessionId } from './execsession.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
    const opts = {
        repo: process.cwd(), port: 7749, limit: 300, base: null,
        layoutProbe: false, allowHosts: new Set(),
        // 🔒 書き込みは既定オフ。経路そのものを存在させない
        allowWrite: false, token: null,
        // 🔒 実行は書き込みと**別の** capability。checkout を許すことと
        //    任意コマンドを許すことは危険度が桁違いなので、まとめない。
        allowExec: false, execTimeoutMs: 10 * 60 * 1000, auditLog: null, tokenFile: null,
        // 🚨 切断で子プロセスを殺すのをやめた代わりの制約（#17）。
        //    猶予は「スマホがタブを止めて戻ってくる」までを吸収する長さにする。
        //    終了後の保持は「出力を読みに戻れる」ための時間。
        execDetachedGraceMs: 5 * 60 * 1000,
        execRetainMs: 10 * 60 * 1000,
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
        if (a === '--repo') opts.repo = resolve(argv[++i]);
        else if (a === '--port') opts.port = num('--port', 0, 65535);
        else if (a === '--limit') opts.limit = num('--limit', 1, 100000);
        else if (a === '--base') opts.base = argv[++i];
        else if (a === '--layout-probe') opts.layoutProbe = true;
        else if (a === '--allow-host') opts.allowHosts.add(String(argv[++i]).toLowerCase());
        else if (a === '--allow-write') opts.allowWrite = true;
        else if (a === '--allow-exec') { opts.allowExec = true; opts.allowWrite = true; }
        else if (a === '--exec-timeout') opts.execTimeoutMs = num('--exec-timeout', 1, 86400) * 1000;
        else if (a === '--exec-detached-grace') opts.execDetachedGraceMs = num('--exec-detached-grace', 1, 86400) * 1000;
        else if (a === '--exec-retain') opts.execRetainMs = num('--exec-retain', 1, 86400) * 1000;
        else if (a === '--token') opts.token = argv[++i];
        else if (a === '--audit-log') opts.auditLog = resolve(argv[++i]);
        else if (a === '--token-file') opts.tokenFile = resolve(argv[++i]);
        else if (a === '--require-auth') opts.requireAuth = true;
        // ⚠️ 明示的に切る道を残す。ただし --allow-host と併用したら起動を止める
        //    （黙って無認証でトンネルに出す状態を作らない）。
        else if (a === '--no-auth') opts.requireAuth = false;
        else if (a === '--watch-agents') opts.watchAgents = true;
        // ⚠️ text は watch を含意させる（片方だけ指定して静かに無効、を作らない）
        else if (a === '--allow-transcript-text') { opts.allowTranscriptText = true; opts.watchAgents = true; }
        else if (a === '--help' || a === '-h') {
            console.log('usage: node v0/server.mjs [--repo <path>] [--port 7749] [--limit 300] [--base <ref>]');
            console.log('       --allow-host <name>  トンネル経由のホスト名を許可する（既定はループバックのみ）');
            console.log('       --allow-write        checkout 等の書き込み操作を有効にする（既定オフ）');
            console.log('       --allow-exec         任意コマンドの実行を有効にする（既定オフ。--token 必須）');
            console.log('       --exec-timeout <秒>  実行の上限時間（既定 600）');
            console.log('       --token <s>          書き込み/実行用トークン（既定は起動時にランダム生成）');
            console.log('       --audit-log <path>   実行の監査ログの置き場所（既定は <GIT_DIR> 内。実行した相手が消せる）');
            console.log('       --token-file <path>  トークンを永続化する（無ければ生成。リポジトリの外に置くこと）');
            console.log('       --require-auth       読み取りにもトークンを要求する（--allow-host のとき既定オン）');
            console.log('       --no-auth            上を明示的に切る（--allow-host との併用は拒否）');
            console.log('       --watch-agents       エージェントの活動を観測する（既定オフ。リポジトリ外を読む）');
            console.log('       --allow-transcript-text  発話とコマンド行も出す（既定オフ。--watch-agents を含む）');
            console.log('       --layout-probe       レイアウト検査用の /__probe を有効にする');
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
document.getElementById('out').textContent = JSON.stringify({
  innerWidth: vw,
  bodyScrollWidth: doc.body.scrollWidth,
  bodyClientWidth: doc.body.clientWidth,
  overflowing: over.slice(0, 12),
  overflowingCount: over.length,
  hiddenButDrawn: hiddenButDrawn.slice(0, 12),
  hiddenButDrawnCount: hiddenButDrawn.length,
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
            // clean が null（読み切れなかった）は「分からない」として扱う
            return { a: wa.label, b: wb.label, aPath: pa, bPath: pb,
                clean: r.clean, files: r.conflicts, truncated: !!r.truncated };
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
            { allowText: opts.allowTranscriptText },
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
        execSessions: opts.allowExec ? execRegistry.list() : null,
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
function readCookie(req, name) {
    const raw = req.headers.cookie;
    if (typeof raw !== 'string') return null;
    for (const part of raw.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        if (part.slice(0, i).trim() !== name) continue;
        return decodeURIComponent(part.slice(i + 1).trim());
    }
    return null;
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
 * その要求が認証済みか。`--require-auth` が無いときは常に true
 * （ループバック限定の従来の使い方を壊さないため）。
 */
function authed(req, url) {
    if (!opts.requireAuth) return true;
    return tokenMatches(readCookie(req, AUTH_COOKIE))
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
function requireMutation(req, res) {
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
    if (!tokenMatches(req.headers[TOKEN_HEADER])) {
        denyJson(res, 403, `${TOKEN_HEADER} が一致しません`);
        return false;
    }
    return true;
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
function requireExec(req, res) {
    if (!opts.allowExec) {
        denyJson(res, 403, '実行は無効です。--allow-exec を付けて起動してください');
        return false;
    }
    return requireMutation(req, res);
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
let auditPath = null;
async function auditLogPath() {
    if (auditPath) return auditPath;
    auditPath = opts.auditLog
        ?? join(await commonDir(opts.repo), 'kjp-exec-audit.jsonl');
    return auditPath;
}

async function auditExec(entry) {
    try {
        const { appendFile } = await import('node:fs/promises');
        await appendFile(
            await auditLogPath(),
            `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
            'utf8',
        );
    } catch (err) {
        // 監査に失敗しても実行は続ける。ただし黙らない
        console.error(`⚠ 監査ログを書けませんでした: ${err.message}`);
    }
}

/** 同時実行数の上限。無制限だとマシンを埋められる。 */
const MAX_CONCURRENT_EXEC = 8;

/**
 * プロセスを**木ごと**殺す。
 *
 * ⚠️ Windows の `child.kill()` は TerminateProcess 相当で、その1プロセスしか殺さない。
 *    中間が `cmd.exe` だと孫が残り、しかも孫が stdout パイプを握るので
 *    `close` イベントが永久に来ない → `runningExec` が戻らない → 8回で exec が死ぬ。
 *    （`.cmd` は shell:false で spawn できないので、Windows で `npm test` を動かす
 *      唯一の道が `cmd /c npm test` = まさにこの形。避けられない経路だった）
 */
async function killTree(child) {
    if (!child.pid) return;
    if (process.platform === 'win32') {
        // Windows: taskkill /T で木ごと
        try {
            const { execFile } = await import('node:child_process');
            await new Promise(resolve => {
                execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'],
                    { windowsHide: true }, () => resolve());
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

    const send = obj => { if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`); };

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
                event: 'detach', session: s.id,
                graceMs: s.keepAlive ? null : opts.execDetachedGraceMs,
            });
        }
    };
    req.on('aborted', detach);
    res.on('close', detach);
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
            // ⚠️ 先に finish しておく。kill を待つ間に sweep がもう一度回って
            //    二重に殺しに行くのを防ぐ（finish は1回しか効かない）。
            session.killRequested = reason;
            execRegistry.finish(session, { code: null, signal: 'SIGKILL', note });
            await auditExec({
                event: 'kill', reason, session: session.id,
                worktree: session.worktree, argv: session.argv,
            });
            if (session.child) await killTree(session.child);
        }
        for (const s of evict) execRegistry.remove(s);
    }, 1000);
    // ⚠️ unref しておく。これだけでイベントループを生かし続けない
    sweepTimer.unref?.();
}

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

const server = createServer(async (req, res) => {
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
    if (!authed(req, url)) {
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
    // ?token=... で来たら Cookie を焼いて、**URL からトークンを落として**やり直させる。
    //    履歴・Referer・共有リンクにトークンを残さないため。
    if (opts.requireAuth && url.searchParams.get('token')) {
        const clean = new URL(url.href);
        clean.searchParams.delete('token');
        res.writeHead(302, {
            location: `${clean.pathname}${clean.search}` || '/',
            // ⚠️ Secure は付けない（ループバックは http なので保存されなくなる）。
            //    経路の暗号化はトンネル側（tailscale serve）の責任。
            'set-cookie': `${AUTH_COOKIE}=${encodeURIComponent(opts.token)}`
                + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000',
            'cache-control': 'no-store',
        });
        res.end();
        return;
    }
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
                token: opts.allowWrite && sameOrigin ? opts.token : null,
            }));
            return;
        }

        // 🔒 任意コマンドの実行。出力を行区切り JSON で流す。
        //    PTY は使わない（Node 標準に PTY は無く、node-pty は依存を増やす）。
        //    Claude Code は `claude -p "..."` で非対話実行できるので、
        //    エージェントを遠隔から動かすのに PTY は要らない。
        //    対話 TUI をそのまま覗きたくなった時点で PTY を検討する。
        if (url.pathname === '/api/v0/exec') {
            if (!requireExec(req, res)) return;
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
            if (!session) {
                denyJson(res, 429, `同時実行が上限（${MAX_CONCURRENT_EXEC}）に達しています`);
                return;
            }
            // 予約した後の失敗経路は必ず枠を返す（finish が枠を返す）
            const bail = (code, msg) => {
                execRegistry.finish(session, { note: msg });
                execRegistry.remove(session);
                denyJson(res, code, msg);
            };

            const wantPath = toNFC(String(body.worktree ?? ''));
            const worktrees = await listWorktrees(opts.repo);
            const wt = worktrees.find(w => samePath(w.path, wantPath));
            if (!wt) { bail(400, `既知の worktree ではありません: ${wantPath}`); return; }
            if (wt.bare) { bail(400, 'bare worktree では実行できません'); return; }
            if (wt.prunable) { bail(409, '作業ツリーが失われています'); return; }
            session.worktree = wt.path;

            await auditExec({
                event: 'start', session: session.id, worktree: wt.path, argv,
                keepAlive: session.keepAlive,
                peer: req.socket.remoteAddress ?? null, host: req.headers.host ?? null,
            });

            const { spawn } = await import('node:child_process');
            const { StringDecoder } = await import('node:string_decoder');

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
            execRegistry.attachChild(session, child);
            startExecSweeper();

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
            child.on('error', err => execRegistry.emit(session, 'err', `実行エラー: ${err.message}`));
            // ⚠️ `close` ではなく `exit` を使う。`close` は stdio が EOF になるまで来ないので、
            //    孫がパイプを握っていると永久に発火せず、枠が戻らない（レビューで実測）。
            child.on('exit', async (code, signal) => {
                const tail = decOut.end(), tailErr = decErr.end();
                if (tail) execRegistry.emit(session, 'out', tail);
                if (tailErr) execRegistry.emit(session, 'err', tailErr);
                if (execRegistry.finish(session, { code, signal })) {
                    await auditExec({
                        event: 'exit', session: session.id, worktree: wt.path, argv, code, signal,
                    });
                }
            });

            // POST はセッションを作ってそのまま購読する（1往復で流れ始める）
            streamSession(req, res, session, 0);
            return;
        }

        // 実行セッションの再購読。**切断しても走り続けている**ので、
        // 最後に見た通番の続きから貰えるようにする（#17）。
        {
            const m = /^\/api\/v0\/exec\/([^/]+)\/(stream|kill|input)$/.exec(url.pathname);
            if (m) {
                // 🔒 実行と同じ関門を通す（GET にしない。POST + トークン + 同一オリジン）
                if (!requireExec(req, res)) return;
                if (!isSessionId(m[1])) { denyJson(res, 400, 'セッション id が不正です'); return; }
                const s = execRegistry.get(m[1]);
                if (!s) { denyJson(res, 404, 'そのセッションはありません（保持期間を過ぎたか、id が違います）'); return; }
                if (m[2] === 'kill') {
                    await auditExec({
                        event: 'kill', reason: 'requested', session: s.id,
                        worktree: s.worktree, argv: s.argv,
                    });
                    const was = execRegistry.finish(s, {
                        code: null, signal: 'SIGKILL', note: '⚠ 停止を要求されました',
                    });
                    if (s.child) await killTree(s.child);
                    res.writeHead(200, {
                        'content-type': 'application/json; charset=utf-8',
                        'cache-control': 'no-store',
                    });
                    res.end(JSON.stringify({ ok: true, alreadyDone: !was }));
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
                    try {
                        if (data !== null) s.child.stdin.write(data);
                        if (eof) s.child.stdin.end();
                    } catch (err) {
                        // 子が既に死んでいると EPIPE。落とさずに理由を返す
                        denyJson(res, 409, `標準入力に書けません: ${err.message}`);
                        return;
                    }
                    // 入力も**記録に残して購読者全員に流す**。
                    // そうしないと別の端末から見ている側に「何を送ったか」が見えず、
                    // 再接続したときにも自分の入力が消える。
                    if (data !== null) execRegistry.emit(s, 'in', data);
                    if (eof) execRegistry.emit(s, 'note', '（標準入力を閉じました）');
                    await auditExec({
                        event: 'input', session: s.id, bytes, eof,
                        peer: req.socket.remoteAddress ?? null,
                    });
                    res.writeHead(200, {
                        'content-type': 'application/json; charset=utf-8',
                        'cache-control': 'no-store',
                    });
                    res.end(JSON.stringify({ ok: true, bytes, seq: s.log.seq }));
                    return;
                }
                let body = {};
                try { body = await readJson(req); } catch { /* from 無しでも良い */ }
                const from = Number(body.from);
                await auditExec({
                    event: 'reattach', session: s.id, from: Number.isFinite(from) ? from : 0,
                });
                streamSession(req, res, s, Number.isFinite(from) ? from : 0);
                return;
            }
        }

        // 🔒 checkout。**このツールの主張そのもの**なので、git が exit 0 で通してしまう
        //    危険な checkout を明示的に拒否する。
        if (url.pathname === '/api/v0/checkout') {
            if (!requireMutation(req, res)) return;
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
            const worktrees = await listWorktrees(opts.repo);
            const wt = worktrees.find(w => samePath(w.path, wantPath));
            if (!wt) { denyJson(res, 400, `既知の worktree ではありません: ${wantPath}`); return; }
            if (wt.bare) { denyJson(res, 400, 'bare worktree では checkout できません'); return; }
            if (wt.prunable) { denyJson(res, 409, '作業ツリーが失われています'); return; }

            const refs = await refMap(opts.repo);
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
            cached = null;   // 状態が変わったのでキャッシュを捨てる
            const after = (await listWorktrees(opts.repo)).find(w => samePath(w.path, wantPath));
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

        // ファイルの中身と差分。**追跡されている内容だけ**を返す（git オブジェクト経由）。
        // fs で読まないので、リポジトリ外や未追跡の秘密ファイルには触れない。
        // 引数の検証は git.mjs の isSafeRef / isSafeRepoPath が持つ。
        if (url.pathname === '/api/v0/blob' || url.pathname === '/api/v0/diff') {
            const path = url.searchParams.get('path') ?? '';
            const ref = url.searchParams.get('ref') ?? 'HEAD';
            try {
                const body = url.pathname === '/api/v0/blob'
                    ? await showBlob(opts.repo, ref, path)
                    : await fileDiff(opts.repo, url.searchParams.get('base') ?? 'HEAD', ref, path);
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
        if (url.pathname === '/ndjson.mjs' || url.pathname === '/argv.mjs') {
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

// リポジトリとして開けるかを先に確認して、UI で 500 を見せずに済ませる。
// ⚠️ ついでに**リポジトリのルートへ正規化する。**
//    サブディレクトリを cwd にすると `merge-tree` が
//    「cwd からの相対パス」で衝突ファイルを出すので `../shared.txt` になり、
//    `overlaps[].path`（ルート相対）と基準が食い違う。さらに
//    `isSafeRepoPath` が `..` を弾くので UI から開けなくなる（レビュー指摘）。
try {
    const top = (await git(['rev-parse', '--show-toplevel'], { cwd: opts.repo })).trim();
    if (top) {
        if (!samePath(top, opts.repo)) {
            console.log(`repo をリポジトリのルートに解決しました: ${opts.repo} → ${top}`);
        }
        opts.repo = top;
    } else {
        // bare リポジトリには toplevel が無い。開けることだけ確認する
        await git(['rev-parse', '--git-dir'], { cwd: opts.repo });
    }
} catch (err) {
    console.error(`\n✖ git リポジトリとして開けません: ${opts.repo}`);
    console.error(`  ${err.message}\n`);
    console.error('  --repo でリポジトリのパスを指定してください:');
    console.error('      node v0/server.mjs --repo C:/path/to/repo\n');
    process.exit(1);
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
// ⚠️ リポジトリの中に置かせない（コミットされる）。
if (opts.tokenFile) {
    const { readFile: rf, writeFile: wf, chmod } = await import('node:fs/promises');
    const inside = await (async () => {
        try {
            const top = (await git(['rev-parse', '--show-toplevel'], { cwd: opts.repo })).trim();
            // ⚠️ relative() では駄目。表記が違うと外れて、トークンがコミットされる
            //    （macOS の /var→/private/var、Windows の RUNNER~1 で実際に外れた）
            return top !== '' && containsPath(top, opts.tokenFile);
        } catch { return false; }
    })();
    if (inside) {
        console.error(`\n✖ --token-file をリポジトリの中に置かないでください（コミットされます）: ${opts.tokenFile}\n`);
        process.exit(1);
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
// 認証するならトークンが要る（書き込み・実行を使わない場合も）
if (opts.requireAuth && !opts.token) {
    opts.token = randomBytes(32).toString('base64url');
}

if (opts.allowExec) {
    if (!opts.token || opts.token.length < 24) {
        console.error('\n✖ --allow-exec には 24 文字以上の --token が必要です。');
        console.error('  実行を遠隔から引けるようにするので、トークンは明示的に決めてください。\n');
        console.error('  生成例:');
        console.error('      node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"');
        console.error('');
        console.error('  起動例:');
        console.error('      node v0/server.mjs --allow-exec --token <生成した値>\n');
        process.exit(1);
    }
}
// 書き込みだけなら起動ごとのランダムで十分（再起動で無効化される）
if (opts.allowWrite && !opts.token) {
    opts.token = randomBytes(32).toString('base64url');
}

server.listen(opts.port, '127.0.0.1', () => {
    const { port } = server.address();
    console.log(`kjp-edit v0  →  http://127.0.0.1:${port}`);
    console.log(`repo: ${opts.repo}`);
    if (opts.allowHosts.size) {
        console.log(`許可した Host: ${[...opts.allowHosts].join(', ')}`);
    }
    if (opts.requireAuth) {
        console.log('');
        console.log('🔒 読み取りにもトークンが必要です (--require-auth)。');
        console.log('   **この URL を1回開いてください**（Cookie を焼いたら URL から落ちます）:');
        console.log(`     http://127.0.0.1:${port}/?token=${opts.token}`);
        for (const h of opts.allowHosts) {
            console.log(`     https://${h}/?token=${opts.token}`);
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
        console.log('⚠️ 書き込み有効 (--allow-write)。checkout が可能です。');
        console.log('   トンネルを開けている場合、そのトンネルに届く相手は');
        console.log('   ブランチを切り替えられます。読み取りだけで良いなら外してください。');
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

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        // ⚠️ 走っている exec を置き去りにしない。Windows では libuv が
        //    SILENT_BREAKAWAY_OK を立てるので、サーバが死んでも孫は回収されない。
        // ⚠️ 切断では殺さなくなったが、**サーバ終了時は必ず殺す。**
        //    Windows では libuv が SILENT_BREAKAWAY_OK を立てるので、
        //    サーバが死んでも孫は回収されない（放置すると溜まる）。
        for (const s of execRegistry.running) {
            if (s.child) killTree(s.child).catch(() => {});
        }
        server.close(() => process.exit(0));
        // ソケットが残っていても確実に終わらせる
        setTimeout(() => process.exit(0), 800).unref();
    });
}
