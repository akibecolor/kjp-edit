// SPDX-License-Identifier: MIT
// node --test scripts/sourcecheck.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findControlChar, wrapWorkflowForCheck } from './sourcecheck.mjs';

test('🚨 生の NUL を見つける（git が binary と判定してレビュー不能になる）', () => {
    // ⚠️ 生の制御文字は**バイトで**組む（ソースにリテラルで書かない = 規則7）
    const buf = Buffer.concat([
        Buffer.from('const x = "', 'utf8'), Buffer.from([0x00]), Buffer.from('";\n', 'utf8'),
    ]);
    const hit = findControlChar(buf);
    assert.ok(hit, '生の NUL を見逃した（この検査が無いと git diff から消える）');
    assert.equal(hit.byte, 0x00);
    assert.equal(hit.offset, 11);
});

test('tab / LF / CR は通す（普通のソースを落とさない）', () => {
    const ok = Buffer.from('a\tb\r\nc\n', 'utf8');
    assert.equal(findControlChar(ok), null, `普通のソースを落としている: ${JSON.stringify(ok.toString())}`);
    // 日本語（マルチバイト）も通す
    assert.equal(findControlChar(Buffer.from('日本語のコメント\n', 'utf8')), null);
    assert.equal(findControlChar(Buffer.alloc(0)), null);
    assert.equal(findControlChar(undefined), null, '壊れた入力で投げない');
});

test('NUL 以外の制御文字も見つける（0x1f / 0x7f / 0x08）', () => {
    // 🚨 `v0/devices.mjs` は 0x1f を含んでいて binary 扱いになった
    for (const b of [0x08, 0x0e, 0x1f, 0x7f]) {
        const hit = findControlChar(Buffer.from([0x61, b, 0x62]));
        assert.ok(hit, `0x${b.toString(16)} を見逃した`);
        assert.equal(hit.byte, b);
        assert.equal(hit.offset, 1);
    }
});

test('🚨 workflow を包むと top-level return が構文エラーにならない', async () => {
    // 素で `node --check` すると必ず Illegal return statement になるので、
    // **包まないと「本当の構文エラー」と区別が付かない**
    const src = [
        'export const meta = { name: "x", description: "y" };',
        'phase("A");',
        'const r = await agent("t");',
        'return { r };',
    ].join('\n');
    const wrapped = wrapWorkflowForCheck(src);
    assert.ok(!/^export /m.test(wrapped), 'export が残っている（関数の中では構文エラー）');
    assert.match(wrapped, /async function __main/);
    // 実際に --check に通ることまで見る（字面ではなく挙動）
    const { code } = await checkSyntax(wrapped);
    assert.equal(code, 0, '包んだのに構文エラーになる');
});

test('🚨 包んでも「本当の構文エラー」は落ちる（包み方で隠さない）', async () => {
    const broken = wrapWorkflowForCheck('export const meta = {};\nfunction broken( {\nreturn 1;');
    const { code, out } = await checkSyntax(broken);
    assert.notEqual(code, 0, '構文エラーを見逃した（包み方が緩すぎる）');
    assert.match(out, /SyntaxError/);
});

/** 一時ファイルに書いて `node --check` に掛ける */
async function checkSyntax(source) {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { spawn } = await import('node:child_process');
    const dir = await mkdtemp(join(tmpdir(), 'srccheck-'));
    try {
        const f = join(dir, 'x.mjs');
        await writeFile(f, source, 'utf8');
        return await new Promise(resolve => {
            const child = spawn(process.execPath, ['--check', f],
                { shell: false, windowsHide: true });
            const chunks = [];
            child.stdout.on('data', c => chunks.push(c));
            child.stderr.on('data', c => chunks.push(c));
            child.on('error', e => resolve({ code: -1, out: String(e.message) }));
            child.on('close', code => resolve({ code, out: Buffer.concat(chunks).toString('utf8') }));
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}
