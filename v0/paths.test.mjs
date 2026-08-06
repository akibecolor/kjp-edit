// SPDX-License-Identifier: MIT
// node --test v0/paths.test.mjs
//
// パス比較と入力検証の回帰テスト。
// samePath は worktree の allowlist 照合に使うので、
// 「同じ場所を別表記で書いたら一致する」と「違う場所は一致しない」の両方が必要。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, symlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { samePath, containsPath, isSafeRepoPath, isSafeRef, git, relativeInside } from './git.mjs';

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

// ⚠️ 上のテストは**手元の Windows では realpath が no-op なので何も検証できない**
//    （tmpdir が短縮名にならない。突然変異テストで survive した）。
//    シンボリックリンク（Windows では junction）を自分で作れば、
//    どのプラットフォームでも realpath が必要な状況を作れる。
test('regression: シンボリックリンク越しでも同じ場所とみなす', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kjp-link-'));
    const target = join(dir, 'target');
    const link = join(dir, 'link');
    let made = false;
    try {
        await mkdir(target);
        try {
            // Windows では junction なら管理者権限が要らない
            await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
            made = true;
        } catch (e) {
            // 権限やファイルシステムの都合で作れない環境ではスキップする。
            // 黙って通すのではなく、何を検証できなかったかを出す
            console.log(`  – シンボリックリンクを作れないのでスキップ: ${e.code ?? e.message}`);
        }
        if (made) {
            assert.ok(samePath(link, target),
                `リンクが解決されていない: ${link} vs ${target}`);
            // 別の場所を指すリンクは一致しない（allowlist が緩まないこと）
            const other = join(dir, 'other');
            await mkdir(other);
            assert.equal(samePath(link, other), false);
        }
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

// ---------------------------------------------------------------------------
// containsPath — `--token-file` をリポジトリの外に強制するのに使う。
// 外れると**実行トークンがコミットされる**ので、素の relative() では駄目。
// ---------------------------------------------------------------------------

test('containsPath: 中と外を区別する', () => {
    assert.ok(containsPath('/a/b', '/a/b/c'), '子');
    assert.ok(containsPath('/a/b', '/a/b'), '自分自身');
    assert.ok(!containsPath('/a/b', '/a/bc'), '接頭辞が同じだけの兄弟');
    assert.ok(!containsPath('/a/b', '/a'), '親');
    assert.ok(!containsPath('/a/b', '/x/y'), '無関係');
    assert.ok(!containsPath('', '/a'), '空');
    assert.ok(!containsPath('/a', null), '非文字列');
});

// 🚨 これが CI の Windows と macOS だけを落とした本体。
//    まだ存在しないファイル（これから作るトークン）を含む判定では、
//    realpath できないので表記の違いがそのまま残る:
//      macOS  /var/folders/... と /private/var/folders/...
//      Windows は Users/RUNNER~1（8.3 短縮名）と Users/runneradmin
//    そのため「リポジトリの中なのに外と判定」→ 拒否されず、コミットされる。
//    存在する最も近い祖先を realpath して継ぎ足すことで一致させる。
test('🚨 containsPath: まだ無いファイルでも別表記のリポジトリの中と判定できる', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kjp-contains-'));
    try {
        const target = join(dir, 'repo');
        const link = join(dir, 'link');
        await mkdir(target);
        try {
            await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
        } catch {
            return; // 権限が無い環境（realpath の検証はできないが他は上のテストで見ている）
        }
        // link 経由の「まだ作っていない」ファイルは、実体 target の中にある
        const notYet = join(link, 'sub', 'token');
        assert.ok(containsPath(target, notYet),
            'realpath を祖先まで遡らないと外れる（トークンがコミットされる）');
        // 実体側の表記でも当然一致する
        assert.ok(containsPath(target, join(target, 'token')));
        // 外は外のまま（緩めていないことの確認）
        assert.ok(!containsPath(target, join(dir, 'token')),
            'リポジトリの隣は「外」でなければならない');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

/**
 * 🚨 **元表記と解決後のパスから「段を混ぜない」（9回目のレビュー。BLOCKING）。**
 *
 * 以前は解決後の残り段数だけ元表記の末尾を採っていたので、junction / symlink が
 * 段を跨ぐと**2つの綴りの断片が合成され**、実測でこうなった:
 *   - pnpm 形（`node_modules/foo` → `.pnpm/foo@1/node_modules/foo`）で
 *     **worktree の外の親ディレクトリ名**が「中のパス」として出た
 *   - 外から中を指すリンクで**外のディレクトリ名**が `outside:false` で payload に載った
 *   - リポジトリに**存在しないパス**を「触ったファイル」として断定表示した
 * `isSafeRepoPath` を通る形なので、どの守りにも掛からなかった。
 *
 * ⚠️ これは**攻撃者を要さない**（pnpm や dotfiles の symlink で普通に起きる）。
 * ⚠️ リンクが作れない環境では `t.skip()`（「測れていない」と出す。緑に見せない）。
 */
test('🚨 junction が段を跨いでも、リポジトリ外の名前を「中のパス」にしない', async t => {
    const base = await mkdtemp(join(tmpdir(), 'kjp-mix-'));
    try {
        // pnpm 形: <base>/PRIVATE-NAME/repo/node_modules/foo → 同 repo の深い実体
        const repo = join(base, 'PRIVATE-NAME', 'repo');
        const real = join(repo, 'node_modules', '.pnpm', 'foo@1', 'node_modules', 'foo');
        await mkdir(real, { recursive: true });
        const link = join(repo, 'node_modules', 'foo');
        try {
            await symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir');
        } catch (e) {
            t.skip(`リンクを作れないので測れていません: ${e.code}`);
            return;
        }
        const rel = relativeInside(repo, join(link, 'index.js'));
        assert.ok(rel !== null, 'リポジトリの中なのに外と言っている');
        assert.ok(!rel.includes('PRIVATE-NAME'),
            `worktree の外のディレクトリ名が相対パスに入っている: ${rel}`);
        // 記録の綴りで完結している（段を混ぜていない）
        assert.equal(rel, 'node_modules/foo/index.js');

        // 外から中の深い場所を指すリンク: 外の名前を1文字も出さない
        const deep = join(repo, 'v0', 'deep');
        await mkdir(deep, { recursive: true });
        const outLink = join(base, 'OUTSIDE-SECRET', 'k');
        await mkdir(join(base, 'OUTSIDE-SECRET'), { recursive: true });
        await symlink(deep, outLink, process.platform === 'win32' ? 'junction' : 'dir');
        const rel2 = relativeInside(repo, join(outLink, 'x.txt'));
        assert.ok(rel2 === null || !rel2.includes('OUTSIDE-SECRET'),
            `リポジトリ外のディレクトリ名が漏れている: ${rel2}`);
        // 実体は中なので、出すなら**実体側の綴り**で出す（存在しないパスにしない）
        if (rel2 !== null) assert.equal(rel2, 'v0/deep/x.txt');
    } finally {
        for (let i = 0; i < 20; i++) {
            try { await rm(base, { recursive: true, force: true }); break; }
            catch { await new Promise(r => setTimeout(r, 200)); }
        }
    }
});
