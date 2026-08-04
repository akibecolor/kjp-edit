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
            resolve({
                code: code ?? 1, output: Buffer.concat(out).toString('utf8'),
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

/** node --test の出力から失敗だけを抜き出して短くする */
function summarizeTests(output) {
    const lines = output.split('\n');
    // node --test は ✖ を2回出す（インラインと末尾の "failing tests:" 要約）。
    // 名前で重複排除し、原因が取れている方を残す。
    const byName = new Map();
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^✖\s+(.+?)\s+\(/);
        if (!m) continue;
        const cause = lines.slice(i + 1, i + 6)
            .map(l => l.trim())
            .find(l => /Error|Assertion|expected|actual|!==/.test(l)) ?? '';
        const prev = byName.get(m[1]);
        if (!prev || (!prev.cause && cause)) byName.set(m[1], { name: m[1], cause });
    }
    const failing = [...byName.values()];
    const counts = {};
    for (const key of ['pass', 'fail']) {
        const m = output.match(new RegExp(`^ℹ ${key} (\\d+)`, 'm'));
        counts[key] = m ? Number(m[1]) : 0;
    }
    return { failing, ...counts };
}

/**
 * テスト1本ぶんの失敗表示を作る。
 *
 * ⚠️ **要約が取れなかったときは生の末尾を出す。** `node --test` は
 * クラッシュや SIGKILL では `ℹ pass N` を出さないので、そのまま整形すると
 * 「smoke (0 pass, 0 fail)」だけが残り、**原因が完全に消える**
 * （CI で失敗したのに手元では再現せず、これで1往復無駄にした）。
 */
function testDetail(r, s) {
    if (s.failing.length) return s.failing.slice(0, 5).map(f => `${f.name} — ${f.cause}`);
    const head = r.timedOut
        ? [`⏱ ${(r.ms / 1000).toFixed(1)}s で SIGKILL（上限に達した）`]
        : [`終了コード ${r.code}（テストの要約が出ていない = 途中で落ちた）`];
    const tail = r.output.split('\n').map(l => l.trim()).filter(Boolean).slice(-8);
    return [...head, ...tail];
}

const steps = [];
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
{
    const r = await run(
        ['--test', '--test-timeout=30000', 'v0/swimlanes.test.mjs', 'v0/paths.test.mjs', 'v0/ndjson.test.mjs', 'v0/mergeplan.test.mjs', 'v0/argv.test.mjs', 'v0/transcript.test.mjs', 'v0/execsession.test.mjs', 'v0/chatfilter.test.mjs',
            'scripts/winargs.test.mjs', 'scripts/serveargs.test.mjs'],
        { timeout: 60_000 },
    );
    const s = summarizeTests(r.output);
    const ok = r.code === 0;
    steps.push({
        name: `unit (${s.pass} pass, ${s.fail} fail) ${(r.ms / 1000).toFixed(1)}s`,
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
    const ok = r.code === 0;
    steps.push({
        name: `smoke (${s.pass} pass, ${s.fail} fail) ${(r.ms / 1000).toFixed(1)}s`,
        ok,
        detail: ok ? [] : testDetail(r, s),
    });
    if (!ok) failed = true;
} else if (quick) {
    steps.push({ name: 'smoke', ok: true, skipped: true });
}

// 4. レイアウト検査（ブラウザが有る環境だけ。CI では自動でスキップされる）
//    CSS の「見た目で気付けない」バグ用。詳細は v0/layout-check.mjs のコメント。
if (!quick && !failed) {
    const r = await run(['v0/layout-check.mjs'], { timeout: 240_000 });
    const skipped = /skipped/.test(r.output);
    const ok = r.code === 0;
    steps.push({
        name: `layout ${(r.ms / 1000).toFixed(1)}s`,
        ok,
        skipped,
        detail: ok ? [] : r.output.split('\n').filter(l => l.trim()).slice(0, 6),
    });
    if (!ok) failed = true;
} else if (quick) {
    steps.push({ name: 'layout', ok: true, skipped: true });
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
        detail: ok ? [] : r.output.split('\n').filter(l => l.trim()).slice(0, 6),
    });
    if (!ok) failed = true;
} else if (quick) {
    steps.push({ name: 'render', ok: true, skipped: true });
}

// ---- 出力: 20行以内 ----
for (const s of steps) {
    const mark = s.skipped ? '–' : s.ok ? '✔' : '✖';
    const why = s.skipped ? (quick ? ' (skipped: --quick)' : ' (skipped: ブラウザ無し)') : '';
    console.log(`${mark} ${s.name}${why}`);
    for (const d of s.detail ?? []) console.log(`    ${d}`);
}
if (failed) {
    console.log('\n再現するには:');
    console.log('    node --test v0/swimlanes.test.mjs v0/paths.test.mjs v0/ndjson.test.mjs v0/mergeplan.test.mjs v0/argv.test.mjs');
    console.log('    node --test v0/smoke.test.mjs');
    console.log('    node v0/layout-check.mjs');
}
process.exit(failed ? 1 : 0);
