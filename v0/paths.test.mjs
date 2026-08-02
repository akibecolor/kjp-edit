// SPDX-License-Identifier: MIT
// node --test v0/paths.test.mjs
//
// パス比較と入力検証の回帰テスト。
// samePath は worktree の allowlist 照合に使うので、
// 「同じ場所を別表記で書いたら一致する」と「違う場所は一致しない」の両方が必要。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { samePath, isSafeRepoPath, isSafeRef, git } from './git.mjs';

test('samePath: 区切り文字の違いを吸収する', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kjp-path-'));
    try {
        assert.ok(samePath(dir, dir.replace(/\\/g, '/')), 'バックスラッシュ → スラッシュ');
        assert.ok(samePath(dir, `${dir}/`), '末尾のスラッシュ');
        assert.ok(samePath(dir, dir.replace(/\//g, '//')), '重複したスラッシュ');
        // ⚠️ `/` → `\` の変換は Windows でしか意味を持たない。
        //    POSIX では `\` は正当なファイル名の文字なので、変換すると
        //    「存在しない別のファイル名」になる（macOS CI でこれで落ちた）。
        if (process.platform === 'win32') {
            assert.ok(samePath(dir, dir.replace(/\//g, '\\')), 'スラッシュ → バックスラッシュ');
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

// 回帰: POSIX で `\` を区切りとして畳むと、`a\b`（1つのファイル名）と
// `a/b`（2階層）を同一視してしまう。allowlist の照合に使うので緩めてはいけない。
test('regression: POSIX ではバックスラッシュを区切りとして扱わない', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kjp-path-'));
    try {
        const withBackslash = `${dir}/a\\b`;
        const withSlash = `${dir}/a/b`;
        if (process.platform === 'win32') {
            // Windows ではどちらも同じ場所を指す
            assert.ok(samePath(withBackslash, withSlash));
        } else {
            assert.equal(samePath(withBackslash, withSlash), false,
                'POSIX で a\\b と a/b を同一視している');
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

// 回帰: Windows CI の os.tmpdir() は `C:\Users\RUNNER~1\...` と 8.3 短縮名を返すのに
// git は `runneradmin` と長い形を返す。realpath で実体に解決しないと一致しない。
// macOS でも os.tmpdir() の /var/... は実体 /private/var/...。
// 手元の Windows では tmpdir が短縮名にならないので再現せず、CI だけで落ちた。
test('regression: 8.3 短縮名 / シンボリックリンクを解決して比べる', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kjp-path-'));
    try {
        const real = realpathSync.native(dir);
        // 表記が違っても（短縮名 vs 長い名、/var vs /private/var）同じ場所とみなす
        assert.ok(samePath(dir, real),
            `短縮名/リンクが解決されていない: ${dir} vs ${real}`);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('samePath: 違う場所は一致しない（allowlist が緩まないこと）', async () => {
    const a = await mkdtemp(join(tmpdir(), 'kjp-path-a-'));
    const b = await mkdtemp(join(tmpdir(), 'kjp-path-b-'));
    try {
        assert.equal(samePath(a, b), false);
        assert.equal(samePath(a, join(a, 'sub')), false, '子ディレクトリは別');
        assert.equal(samePath(a, ''), false);
        assert.equal(samePath('', ''), false, '空文字は常に不一致');
        assert.equal(samePath(a, null), false);
        assert.equal(samePath(undefined, a), false);
    } finally {
        await rm(a, { recursive: true, force: true });
        await rm(b, { recursive: true, force: true });
    }
});

test('samePath: 存在しないパスでも落ちず、文字列として比べる', () => {
    const p = join(tmpdir(), 'kjp-does-not-exist-12345');
    assert.ok(samePath(p, p.replace(/\\/g, '/')));
    assert.equal(samePath(p, `${p}-other`), false);
});

test('isSafeRepoPath: リポジトリ外へ抜ける表記を拒否する', () => {
    for (const ok of [
        'a.txt', 'src/a.txt', '日本語フォルダ/テスト ファイル.txt',
        'a/b/c.mjs', '.gitignore', 'a..b/c.txt',
    ]) {
        assert.ok(isSafeRepoPath(ok), `拒否されるべきでない: ${ok}`);
    }
    for (const bad of [
        '../x', '..\\x', 'a/../../x', '/etc/passwd', '\\\\server\\share',
        'C:/Windows', 'c:\\Windows', '--output=x', '', null, undefined,
        'a\0b', 'x'.repeat(5000),
    ]) {
        assert.equal(isSafeRepoPath(bad), false, `拒否されるべき: ${String(bad).slice(0, 20)}`);
    }
});

// 多層防御の2層目。入口の isSafeRepoPath が `:` を弾くのとは別に、
// git 呼び出し自体が pathspec magic を解釈しないことを実挙動で確かめる。
// （入口のテストだけだと、この BASE_ARGS を外しても緑のまま通り抜ける）
test('git() は pathspec magic を literal として扱う（--literal-pathspecs）', async () => {
    // `:(exclude)*.mjs` は magic なら「.mjs 以外」を列挙し、literal なら
    // そんな名前のファイルは無いので何も返らない。
    const out = await git(['ls-files', '--', ':(exclude)*.mjs'], { cwd: process.cwd() });
    assert.equal(out.trim(), '',
        `pathspec magic が解釈されている（--literal-pathspecs が効いていない）: ${out.slice(0, 200)}`);
    // 比較のため、素のパスは通ることを確認しておく（テストが常に空を見ていないこと）
    const real = await git(['ls-files', '--', 'v0/git.mjs'], { cwd: process.cwd() });
    assert.match(real, /v0\/git\.mjs/, 'そもそも ls-files が動いていない');
});

test('isSafeRef: リビジョン式とオプションを拒否し、日本語ブランチ名は通す', () => {
    for (const ok of ['main', 'origin/main', '機能/新規', 'HEAD', 'refs/heads/main',
        'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0']) {
        assert.ok(isSafeRef(ok), `拒否されるべきでない: ${ok}`);
    }
    for (const bad of ['--output=x', 'main~1', 'main^', 'main^{tree}', 'a b',
        'x..y', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a\0b', '', null]) {
        assert.equal(isSafeRef(bad), false, `拒否されるべき: ${String(bad)}`);
    }
});
