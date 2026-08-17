#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// エージェントと hook が呼ぶ唯一の検証コマンド。
//
//   node scripts/verify.mjs          # 全部
//   node scripts/verify.mjs --quick  # スモークを飛ばす（構文 + ユニットのみ）
//
// 設計方針 (docs/development.md):
//   - 出力は 20 行以内に収める。エージェントに生のレポータを読ませない
//   - 失敗時は file:line と原因の先頭数行だけを出す
//   - exit 0 = 合格、exit 1 = 不合格（Stop hook では exit 2 に変換される）

import { spawn } from 'node:child_process';
import { readdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
// 要約は純関数として切り出してテストしてある（#52）
import { summarizeTests, detailLines, testDetail } from './testsummary.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const quick = process.argv.includes('--quick');

/** Node を子プロセスで走らせる。shell は使わない (docs/encoding-and-paths.md)。 */
function run(args, { timeout = 300_000 } = {}) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, args, {
            cwd: ROOT, shell: false, windowsHide: true,
            env: { ...process.env, NO_COLOR: '1' },
        });
        const out = [];
        child.stdout.on('data', c => out.push(c));
        child.stderr.on('data', c => out.push(c));
        const started = Date.now();
        let timedOut = false;
        const t = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
        child.on('error', e => {
            clearTimeout(t);
            resolve({ code: 1, output: String(e.message), ms: Date.now() - started, timedOut });
        });
        child.on('close', code => {
            clearTimeout(t);
            // 🚨 **打ち切ったことと、途中までの出力を必ず返す。**
            //    以前は SIGKILL された検査の output が空のままだったので、
            //    `✖ layout 240.0s` の1行しか残らず**何を待っていたか消えた**
            //    （macOS の CI でこれを踏み、原因の切り分けに1往復かかった）。
            //    「打ち切られた結果を緑と読まない」の裏返しで、
            //    **打ち切られた結果は必ず理由付きで残す**。
            const raw = Buffer.concat(out).toString('utf8');
            const head = timedOut
                ? `⏱ 上限 ${Math.round(timeout / 1000)}s で打ち切りました（SIGKILL）。`
                    + `出力は途中までです（${raw.length} 文字）:\n`
                : '';
            resolve({
                code: code ?? 1, output: head + raw,
                ms: Date.now() - started, timedOut,
            });
        });
    });
}

/** 拡張子で再帰的に集める（node_modules と .git は除く） */
async function sources(dir, exts = ['.mjs'], acc = []) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.claude')) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) await sources(p, exts, acc);
        else if (exts.some(x => e.name.endsWith(x))) acc.push(p);
    }
    return acc;
}

/**
 * HTML の中に埋まっている <script type="module"> を取り出して構文チェックする。
 *
 * ⚠️ これが無かったせいで v0/index.html は検証の対象外だった。
 *    描画バグ（マージの第二親レーンが繋がらない、レーン色が6本目で衝突する）が
 *    verify.mjs を緑のまま通り抜けた構造的な原因はここ（レビューで発覚）。
 */
async function checkInlineModules(htmlFiles) {
    const bad = [];
    const dir = await mkdtemp(join(tmpdir(), 'kjp-verify-'));
    try {
        for (const file of htmlFiles) {
            const html = await readFile(file, 'utf8');
            const scripts = [...html.matchAll(
                /<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>([\s\S]*?)<\/script>/gi,
            )];
            if (scripts.length === 0) {
                bad.push(`${relative(ROOT, file)}: type="module" の script が見つかりません`);
                continue;
            }
            for (const [i, m] of scripts.entries()) {
                const tmp = join(dir, `${i}-${file.split(/[\\/]/).pop()}.mjs`);
                await writeFile(tmp, m[1], 'utf8');
                const r = await run(['--check', tmp], { timeout: 20_000 });
                if (r.code !== 0) {
                    const first = r.output.split('\n')
                        .find(l => /Error/.test(l)) ?? r.output.split('\n')[0] ?? '';
                    bad.push(`${relative(ROOT, file)} (script #${i + 1}): ${first.trim()}`);
                }
            }
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
    return bad;
}

const steps = [];
// 🚨 **飛ばした検査の名前を集める（#52）。** 件数だけだと
//    「何が測られていないか」が分からない（SKIP を緑と読む型）。
const allSkipped = [];
let failed = false;

// 1. 構文チェック（型チェックの代わり。依存ゼロを保つため tsc は入れない）
//    *.mjs と、HTML に埋め込まれた type="module" の両方を見る。
{
    const files = await sources(ROOT, ['.mjs']);
    const htmlFiles = await sources(ROOT, ['.html']);
    const bad = [];
    for (const f of files) {
        const r = await run(['--check', f], { timeout: 20_000 });
        if (r.code !== 0) {
            const first = r.output.split('\n').find(l => l.includes('Error') || l.includes('^')) ?? '';
            bad.push(`${relative(ROOT, f)}: ${first.trim()}`);
        }
    }
    bad.push(...await checkInlineModules(htmlFiles));
    const label = `syntax (${files.length} mjs, ${htmlFiles.length} html)`;
    steps.push(bad.length
        ? { name: label, ok: false, detail: bad.slice(0, 5) }
        : { name: label, ok: true });
    if (bad.length) failed = true;
}

// 2. ユニットテスト
// ⚠️ **上限は「遅い」ことを隠すためではなく、ハングを失敗として観測するため。**
//    `serveargs.test.mjs` に**実際に serve.mjs を起動して配線を測る**テストが入った
//    （純関数を全部テストしても「呼んでいない」は見えない。8回目のレビュー）。
//    Windows の起動口は 1回の探索ごとに PowerShell の CIM クエリを待つので
//    1テストで 25 秒かかる（CI の Windows は更に遅い）。上限が 30 秒だと
//    **配線のテストだけが SIGKILL され、原因が消える**ので広げてある。
{
    // 🚨 **一覧を手で書かない（10回目のレビュー / SERIOUS）。**
    //    手書きのリテラルだったので、新しく足した `precheck.test.mjs` と
    //    `dirlabel.test.mjs` の**15 テストが verify にも CI にも1度も載っていなかった**
    //    （突然変異のときだけ、しかも「落ちる前提」で走っていた）。
    //    テストを足した人が一覧を更新し忘れる形の穴なので、**探して並べる**。
    //    ⚠️ smoke / layout / render / input は別の段で扱うので除く（重い・順序がある）。
    const SEPARATE = new Set(['smoke.test.mjs']);
    const unitTests = (await Promise.all(['v0', 'scripts'].map(async dir =>
        (await readdir(join(ROOT, dir)))
            .filter(f => f.endsWith('.test.mjs') && !SEPARATE.has(f))
            .map(f => `${dir}/${f}`)))).flat().sort();
    const r = await run(
        ['--test', '--test-timeout=90000', ...unitTests],
        { timeout: 240_000 },
    );
    const s = summarizeTests(r.output);
    allSkipped.push(...(s.skippedNames ?? []));
    const ok = r.code === 0;
    steps.push({
        name: `unit (${s.pass} pass, ${s.fail} fail${s.skipped ? `, ${s.skipped} skip` : ''}) ${(r.ms / 1000).toFixed(1)}s`,
        ok,
        detail: ok ? [] : testDetail(r, s),
    });
    if (!ok) failed = true;
}

// 3. スモークテスト（一時リポジトリを作るので時間がかかる）
if (!quick && !failed) {
    // ⚠️ 上限は「遅い」ことを隠すためではなく、ハングを失敗として観測するため。
    // 🚨 **テストごとの上限（--test-timeout）も付ける。** ファイル全体の上限だけだと
    //    1本のハングが「smoke (0 pass, 0 fail) で SIGKILL」になり、
    //    **どのテストが原因か分からない**（実際に10分潰した）。
    //    テストが増えたので 240s では足りなくなった（CI の Windows は更に遅い）。
    const r = await run(['--test', '--test-timeout=90000', 'v0/smoke.test.mjs'],
        { timeout: 600_000 });
    const s = summarizeTests(r.output);
    allSkipped.push(...(s.skippedNames ?? []));
    const ok = r.code === 0;
    steps.push({
        name: `smoke (${s.pass} pass, ${s.fail} fail${s.skipped ? `, ${s.skipped} skip` : ''}) ${(r.ms / 1000).toFixed(1)}s`,
        ok,
        detail: ok ? [] : testDetail(r, s),
    });
    if (!ok) failed = true;
} else {
    // 🚨 **走らなかったことを出す。** 先行ステップが落ちると行そのものが
    //    消えていたので、「5つのうち3つが走っていない」ことがどこにも書かれず、
    //    直した後に「smoke も layout も見た」と読める形になっていた
    //    （mutation の shard が cancelled で「他は success」に見えた事故と同型）。
    steps.push({ name: 'smoke', ok: true, skipped: true, why: quick ? '--quick' : '先行ステップが失敗' });
}

// 4. レイアウト検査（ブラウザが有る環境だけ。CI では自動でスキップされる）
//    CSS の「見た目で気付けない」バグ用。詳細は v0/layout-check.mjs のコメント。
if (!quick && !failed) {
    // ⚠️ 上限は「遅さを隠すため」ではなく**ハングを失敗として観測するため**。
    //    macOS の runner は同じ検査に Windows の 20 倍かかる（実測 122.9s vs 6s）。
    //    layout-check 自身が 260s の締切で理由を出して落ちるので、ここは少し広い。
    const r = await run(['v0/layout-check.mjs'], { timeout: 300_000 });
    const skipped = /skipped/.test(r.output);
    const ok = r.code === 0;
    steps.push({
        name: `layout ${(r.ms / 1000).toFixed(1)}s`,
        ok,
        skipped,
        // ⚠️ 打ち切りのときは**末尾**が知りたい（何を待っていたか）。
        //    先頭6行だけだと起動時の案内で埋まる。
        detail: ok ? [] : detailLines(r.output, r.timedOut ? 10 : 6, r.timedOut),
    });
    if (!ok) failed = true;
} else {
    steps.push({ name: 'layout', ok: true, skipped: true, why: quick ? '--quick' : '先行ステップが失敗' });
}

// 5. クライアント描画の予算（#3）。**実時間で測る**ので layout とは別プロセス。
//    ⚠️ layout は --virtual-time-budget を使うが、それでは時間を測れない。
if (!quick && !failed) {
    const r = await run(['v0/render-check.mjs'], { timeout: 300_000 });
    const skipped = /skipped/.test(r.output);
    const ok = r.code === 0;
    steps.push({
        name: `render ${(r.ms / 1000).toFixed(1)}s`,
        ok,
        skipped,
        // ⚠️ 打ち切りのときは**末尾**が知りたい（何を待っていたか）。
        //    先頭6行だけだと起動時の案内で埋まる。
        detail: ok ? [] : detailLines(r.output, r.timedOut ? 10 : 6, r.timedOut),
    });
    if (!ok) failed = true;
} else {
    steps.push({ name: 'render', ok: true, skipped: true, why: quick ? '--quick' : '先行ステップが失敗' });
}

// 6. 入力層の検査（#58）。**合成イベントでは測れない壊れ方**を測る
//    （click の飲み込み・テキスト選択・ヒットテスト）。ブラウザが無ければ skip。
if (!quick && !failed) {
    const r = await run(['v0/input-check.mjs'], { timeout: 240_000 });
    const skipped = /skipped/.test(r.output);
    const ok = r.code === 0;
    steps.push({
        name: `input ${(r.ms / 1000).toFixed(1)}s`,
        ok, skipped,
        detail: ok ? [] : detailLines(r.output, r.timedOut ? 10 : 6, r.timedOut),
    });
    if (!ok) failed = true;
} else {
    steps.push({ name: 'input', ok: true, skipped: true, why: quick ? '--quick' : '先行ステップが失敗' });
}

// 7. 配色の検査。**値の下限は unit で固定してあるので、ここが測るのは
//    「CSS が実際にその値を当てているか」**（data-theme の書き忘れ・変数の使い忘れは
//    unit では1件も捕まらない）。ブラウザが無ければ skip。
if (!quick && !failed) {
    const r = await run(['v0/theme-check.mjs'], { timeout: 240_000 });
    const skipped = /skipped/.test(r.output);
    const ok = r.code === 0;
    steps.push({
        name: `theme ${(r.ms / 1000).toFixed(1)}s`,
        ok, skipped,
        detail: ok ? [] : detailLines(r.output, r.timedOut ? 10 : 6, r.timedOut),
    });
    if (!ok) failed = true;
} else {
    steps.push({ name: 'theme', ok: true, skipped: true, why: quick ? '--quick' : '先行ステップが失敗' });
}

// 8. 端末の承認を UI から通す検査。**「どの枠から鍵を読むか」の配線は app.html の中**
//    なので、unit では字面しか見られない（行を残して到達不能にする変更が見えない）。
//    実際にこの配線で壊れた（承認済みなのに「実行有効（トークン未取得）」）。
if (!quick && !failed) {
    const r = await run(['v0/pair-check.mjs'], { timeout: 240_000 });
    const skipped = /skipped/.test(r.output);
    const ok = r.code === 0;
    steps.push({
        name: `pair ${(r.ms / 1000).toFixed(1)}s`,
        ok, skipped,
        detail: ok ? [] : detailLines(r.output, r.timedOut ? 10 : 6, r.timedOut),
    });
    if (!ok) failed = true;
} else {
    steps.push({ name: 'pair', ok: true, skipped: true, why: quick ? '--quick' : '先行ステップが失敗' });
}

// ---- 出力: 20行以内 ----
// 🚨 **飛ばした検査は緑のときも名前を出す（#52）。**
//    「このプラットフォームでは測っていない」を毎回目に入れる。
//    件数だけだと「何が測られていないか」が分からない。
const skippedTests = [...new Set(allSkipped)];

for (const s of steps) {
    const mark = s.skipped ? '–' : s.ok ? '✔' : '✖';
    // ⚠️ 理由を取り違えない。--quick / 先行ステップの失敗 / ブラウザ無し は別物
    const why = s.skipped ? ` (skipped: ${s.why ?? 'ブラウザ無し'})` : '';
    console.log(`${mark} ${s.name}${why}`);
    for (const d of s.detail ?? []) console.log(`    ${d}`);
}
// 🚨 プラットフォームで飛ばした検査は**緑のときも**名前を出す（#52）。
//    「このプラットフォームでは測っていない」を毎回目に入れる。
if (skippedTests.length) {
    console.log(`– このプラットフォームで飛ばした検査 ${skippedTests.length} 件（緑と読まないこと）:`);
    for (const name of skippedTests.slice(0, 5)) console.log(`    ${name}`);
    if (skippedTests.length > 5) console.log(`    …他 ${skippedTests.length - 5} 件`);
}
if (failed) {
    console.log('\n再現するには:');
    console.log('    node --test v0/swimlanes.test.mjs v0/paths.test.mjs v0/ndjson.test.mjs v0/mergeplan.test.mjs v0/argv.test.mjs');
    console.log('    node --test v0/smoke.test.mjs');
    console.log('    node v0/layout-check.mjs');
    console.log('    node v0/pair-check.mjs        # 端末の承認を UI から通す');
}
process.exit(failed ? 1 : 0);
