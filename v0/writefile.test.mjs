// SPDX-License-Identifier: MIT
// node --test v0/writefile.test.mjs
//
// 「触っていない行を変えない」ことを固定するテスト。
// 改行コードや BOM の破壊は**画面上は同じに見える**ので、ここで測らないと
// 「保存したら全行変更になっていた」を後で発見することになる。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    blobOid, inspectBytes, toEditorText, encodeForWorktree, MAX_EDIT_BYTES,
} from './writefile.mjs';

const CRLF = '\r\n';
const CR = '\r';

test('blobOid: git hash-object と同じ値になる', async () => {
    // 🚨 **git と突き合わせる。** 自前実装が git の形式と違っていても
    //    「自分の値と自分の値」を比べる限りテストは緑になる（照合には使えるが、
    //    OID だと名乗る根拠が無くなる）。実物と比べて初めて主張が確かめられる。
    const dir = await mkdtemp(join(tmpdir(), 'kjp-oid-'));
    try {
        const f = join(dir, 'a.txt');
        const body = Buffer.from('日本語 と CRLF\r\nの混ざった中身\n', 'utf8');
        await writeFile(f, body);
        const out = await new Promise((resolve, reject) => {
            // --no-filters: clean filter（任意コマンド）を起動させない
            const p = spawn('git', ['hash-object', '-t', 'blob', '--no-filters', '--', f],
                { cwd: dir, shell: false, windowsHide: true });
            const o = [], e = [];
            p.stdout.on('data', c => o.push(c));
            p.stderr.on('data', c => e.push(c));
            p.on('error', reject);
            p.on('close', code => (code === 0
                ? resolve(Buffer.concat(o).toString('utf8').trim())
                : reject(new Error(`git hash-object → ${code}: ${Buffer.concat(e)}`))));
        });
        assert.equal(blobOid(body), out);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('blobOid: 1バイト違えば別の値になる', () => {
    assert.notEqual(blobOid(Buffer.from('a')), blobOid(Buffer.from('b')));
    assert.equal(blobOid(Buffer.from('')), blobOid(Buffer.from('')));
});

test('inspectBytes: LF / CRLF / CR を見分ける', () => {
    assert.equal(inspectBytes(Buffer.from('a\nb\n')).eol, 'lf');
    assert.equal(inspectBytes(Buffer.from(`a${CRLF}b${CRLF}`)).eol, 'crlf');
    assert.equal(inspectBytes(Buffer.from(`a${CR}b${CR}`)).eol, 'cr');
    // 改行が1つも無いファイル（書き戻しても差が出ないので lf 扱い）
    assert.equal(inspectBytes(Buffer.from('one line')).eol, 'lf');
    for (const b of [Buffer.from('a\nb\n'), Buffer.from(`a${CRLF}b${CRLF}`)]) {
        assert.equal(inspectBytes(b).mixed, false);
    }
});

test('inspectBytes: 改行コードの混在を mixed として報告する', () => {
    // 🚨 混在は**どちらに寄せても触っていない行が変わる**。
    //    「分からないなら分からないと言う」ので、直さずに報告する。
    const m = inspectBytes(Buffer.from(`a${CRLF}b\nc${CRLF}`));
    assert.equal(m.mixed, true);
    assert.deepEqual(m.counts, { crlf: 2, lf: 1, cr: 0 });
});

test('inspectBytes: BOM とバイナリを見分ける', () => {
    const bom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('a\n')]);
    assert.equal(inspectBytes(bom).bom, true);
    assert.equal(inspectBytes(bom).binary, false);
    assert.equal(inspectBytes(Buffer.from('a\n')).bom, false);
    // NUL があれば binary（git と同じ判定）
    assert.equal(inspectBytes(Buffer.from([0x61, 0x00, 0x62])).binary, true);
    // 8000 バイトより後ろの NUL は git と同じく見ない
    const late = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0x00])]);
    assert.equal(inspectBytes(late).binary, false);
});

test('toEditorText: BOM を落として LF に畳む', () => {
    const bom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]),
        Buffer.from(`a${CRLF}b${CRLF}`)]);
    assert.equal(toEditorText(bom), 'a\nb\n');
    assert.equal(toEditorText(Buffer.from(`x${CR}y${CR}`)), 'x\ny\n');
});

test('toEditorText: 中身を NFC 正規化しない（編集していない文字を変えない）', () => {
    // ⚠️ **エスケープで書く。** 生の NFD/NFC をソースに並べると、
    //    編集ツールが片方を正規化した瞬間に「同じ文字列を比べている」テストに化ける
    //    （緑のまま無意味になる）。nfd = か + 濁点、nfc = 合成済み。
    const nfd = '\u304B\u3099\n';
    const nfc = '\u304C\n';
    assert.notEqual(nfd, nfc, 'この検査の前提が崩れている');
    assert.equal(toEditorText(Buffer.from(nfd, 'utf8')), nfd,
        '中身を NFC に正規化している（利用者が触っていない文字が変わる）');
});

test('encodeForWorktree: CRLF のファイルは CRLF で書き戻す', () => {
    const src = Buffer.from(`a${CRLF}b${CRLF}`);
    const info = inspectBytes(src);
    const text = toEditorText(src);
    // 何も編集しなければ**バイト列が完全に一致する**（往復で壊れない）
    assert.deepEqual(encodeForWorktree(text, info), src);
    // 1行足しても他の行の改行は CRLF のまま
    const out = encodeForWorktree(`${text}c\n`, info);
    assert.equal(out.toString('utf8'), `a${CRLF}b${CRLF}c${CRLF}`);
    assert.equal(inspectBytes(out).mixed, false);
});

test('encodeForWorktree: LF のファイルに CRLF を混ぜない', () => {
    const src = Buffer.from('a\nb\n');
    const info = inspectBytes(src);
    const out = encodeForWorktree(`a${CRLF}b${CRLF}c${CRLF}`, info);
    assert.equal(out.toString('utf8'), 'a\nb\nc\n');
});

test('encodeForWorktree: BOM を保ち、二重にしない', () => {
    const src = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('a\n')]);
    const info = inspectBytes(src);
    assert.deepEqual(encodeForWorktree(toEditorText(src), info), src);
    // クライアントが BOM を文字として送ってきても二重にしない
    assert.deepEqual(encodeForWorktree('\uFEFFa\n', info), src);
    // BOM が無いファイルには足さない
    assert.deepEqual(encodeForWorktree('a\n', inspectBytes(Buffer.from('a\n'))),
        Buffer.from('a\n'));
});

test('encodeForWorktree: CR だけのファイルも保つ', () => {
    const src = Buffer.from(`a${CR}b${CR}`);
    assert.deepEqual(encodeForWorktree(toEditorText(src), inspectBytes(src)), src);
});

test('encodeForWorktree: 文字列以外は受け取らない', () => {
    assert.throws(() => encodeForWorktree(null, {}), TypeError);
    assert.throws(() => encodeForWorktree({ a: 1 }, {}), TypeError);
});

test('MAX_EDIT_BYTES は git.mjs の blob 上限と同じ 512KB', () => {
    assert.equal(MAX_EDIT_BYTES, 512 * 1024);
});
