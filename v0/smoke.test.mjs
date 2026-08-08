// SPDX-License-Identifier: MIT
// node --test v0/smoke.test.mjs
//
// 手で確認したことを自動化したスモークテスト。
// 使い捨ての一時リポジトリを作るので、あなたのリポジトリには触りません。
//
// docs/encoding-and-paths.md の E1/E3/E6/E7 を実際に踏む:
//   E1 日本語ファイル名  E3 日本語＋空白のファイル名
//   E6 日本語コミットメッセージ  E7 日本語ブランチ名
// そして誰もガードしていないシーケンサ乗っ取りの検出を検証する。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as httpRequest, Agent as HttpAgent } from 'node:http';
import { connect as netConnect } from 'node:net';
import { mkdtemp, rm, writeFile, readFile, mkdir, rename } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));

/**
 * 🚨 **本物の `~/.kjp-edit/` を触っていないことを固定する（#56）。**
 *
 * 実測: 検査が本物の `last.json` を一時リポジトリで上書きしていた。
 * 同じディレクトリに `token-read` / `token-write` / `token-exec` があるので、
 * **書ける経路があること自体**が危ない（鍵が変わればスマホから繋がらない）。
 * ⚠️ `exec-audit.jsonl` は動いているデーモンが正しく追記するので見ない。
 */
const STATE_DIR = join(homedir(), '.kjp-edit');
const STATE_WATCHED = ['token-read', 'token-write', 'token-exec', 'last.json'];
const stampState = async () => {
    const { stat } = await import('node:fs/promises');
    const out = {};
    for (const name of STATE_WATCHED) {
        out[name] = await stat(join(STATE_DIR, name))
            .then(st => `${st.mtimeMs}:${st.size}`, () => null);
    }
    return out;
};
let stateBefore = null;


let repo;          // 一時リポジトリ
let proc;          // サーバプロセス
let baseUrl;
let emptyConfig;   // 空の gitconfig

/**
 * 🚨 **桁違いに遅い起動を、緑のうちに記録する（#34）。**
 *
 * `--allow-host` のテストが CI で「起動しなかった」で落ちる flaky があり、
 * **落ちてから調べても再現しない**（3プラットフォーム同時に落ちて、
 * 次の push では同じコードで緑になった）。
 * 起動は実測で**中央 107ms**（worktree 4本、`--allow-host` / `--watch-agents` 込み。
 * 疑われていた `git rev-parse` の正規化は原因ではなかった）。
 * なので 3 秒を超えたら異常。**緑でも数字を残して、次に落ちる前に気付ける形にする。**
 */
const slowStarts = [];

/**
 * 開発者の ~/.gitconfig と system gitconfig を無効化する env。
 *
 * ⚠️ os.devNull は使えない。Windows では '\\\\.\\nul' になり git が
 *    「fatal: unable to access '//./nul': Invalid argument」で落ちる（実測）。
 *    docs/encoding-and-paths.md に /dev/null と書いていたのは Windows で誤り。
 *    空ファイルを指すのが移植性のある方法。
 */
function isolatedConfig() {
    return { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig };
}

/** テスト用の git。ユーザの ~/.gitconfig に依存しない（決定性のため）。 */
function g(args, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, {
            cwd,
            shell: false,
            windowsHide: true,
            env: {
                ...process.env,
                // docs/encoding-and-paths.md: 開発者の設定でテストが揺れないようにする。
                ...isolatedConfig(),
                GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
                GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
                GIT_TERMINAL_PROMPT: '0',
            },
        });
        const out = [], err = [];
        child.stdout.on('data', c => out.push(c));
        child.stderr.on('data', c => err.push(c));
        child.on('error', reject);
        child.on('close', code => code === 0
            ? resolve(Buffer.concat(out).toString('utf8'))
            : reject(new Error(`git ${args.join(' ')} → ${code}: ${Buffer.concat(err)}`)));
    });
}

before(async () => {
    stateBefore = await stampState();   // 本物の状態ディレクトリを触らないことの見張り（#56）
    repo = await mkdtemp(join(tmpdir(), 'kjp-smoke-'));
    emptyConfig = join(repo, '.empty-gitconfig');
    await writeFile(emptyConfig, '', 'utf8');
    await g(['init', '-q', '-b', 'main'], repo);
    // GIT_CONFIG_GLOBAL を潰しているのでコミット可能な最小設定を repo local に入れる
    await g(['config', 'user.name', 't'], repo);
    await g(['config', 'user.email', 't@example.com'], repo);

    await writeFile(join(repo, 'README.md'), '# smoke\n', 'utf8');
    await g(['add', '-A'], repo);
    await g(['commit', '-q', '-m', 'chore: 初期コミット'], repo);   // E6 日本語メッセージ

    // 2つのエージェント worktree。共通ファイル shared.txt を両方が触る
    for (const n of ['a', 'b']) {
        const wt = join(repo, '..', `${repo.split(/[\\/]/).pop()}-wt-${n}`);
        await g(['worktree', 'add', '-q', '-b', `agent-${n}`, wt], repo);
        await writeFile(join(wt, `only-${n}.txt`), `${n}\n`, 'utf8');
        await writeFile(join(wt, 'shared.txt'), `touched by ${n}\n`, 'utf8');
        // E1 日本語ファイル名 / E3 日本語＋空白
        await mkdir(join(wt, '日本語フォルダ'), { recursive: true });
        await writeFile(join(wt, '日本語フォルダ', `テスト ファイル-${n}.txt`), 'ok\n', 'utf8');
        await g(['add', '-A'], wt);
        await g(['commit', '-q', '-m', `feat: agent-${n} の変更`], wt);
    }

    // E7 日本語ブランチ名
    await g(['branch', '機能/新規', 'main'], repo);

    proc = spawn(process.execPath, [SERVER, '--repo', repo, '--port', '0'], {
        shell: false, windowsHide: true,
        env: { ...process.env, ...isolatedConfig() },
    });
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    baseUrl = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('サーバが 15 秒以内に起動しなかった')), 15000);
        let buf = '';
        proc.stdout.on('data', d => {
            buf += d;
            const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
            if (m) { clearTimeout(t); resolve(m[0]); }
        });
        proc.stderr.on('data', d => { clearTimeout(t); reject(new Error(`サーバが失敗: ${d}`)); });
        proc.on('error', reject);
    // 🚨 待ちが失敗したら子を殺す。子の stdio パイプが node --test を生かし続け、
    //    要約が出ないまま SIGKILL される（原因が消える）
    }).catch(e => { try { proc.kill(); } catch { /* noop */ } throw e; });
});

after(async () => {
    // 🚨 検査が本物の ~/.kjp-edit/ を書き換えていないこと（#56）。
    //    **最初に見る**（この後の後始末で時間が経つと原因が分かりにくくなる）。
    const stateNow = await stampState();
    const stateChanged = STATE_WATCHED.filter(n => stateBefore?.[n] !== stateNow[n]);
    proc?.kill();
    // 🚨 **検査が起動した孫プロセスを掃く（仕組みで防ぐ）。**
    //    仕込みは自死するようにしたが、それは「30秒後」であって
    //    テストが途中で止まったときの保険にすぎない。ここで確実に落とす。
    //    実測で6本が生き残り、beacon が計 11MB、temp に33個のディレクトリが
    //    残っていた（レビューで指摘）。**取り残しは意志ではなく仕組みで防ぐ。**
    if (process.platform === 'win32') {
        const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" '
            + '| Where-Object { $_.CommandLine -like \'*grandchild.mjs*\' '
            + '-or $_.CommandLine -like \'*appendFileSync*\' '
            // 「木から逃げた孫」の検査の仕込み（自死もするが、ここが最後の砦）
            + '-or $_.CommandLine -like \'*escaped-grandchild*\' '
            + '-or $_.CommandLine -like \'*escape-parent*\' } '
            + '| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false }';
        await new Promise(r => spawn('powershell', ['-NoProfile', '-Command', ps],
            { windowsHide: true, stdio: 'ignore' }).on('close', r));
    } else {
        for (const pat of ['grandchild.mjs', 'escaped-grandchild', 'escape-parent']) {
            await new Promise(r => spawn('pkill', ['-f', pat],
                { stdio: 'ignore' }).on('close', r));
        }
    }
    // worktree は repo の外に置いたので個別に消す
    const stem = repo.split(/[\\/]/).pop();
    for (const n of ['a', 'b', 'gone']) {
        await rm(join(repo, '..', `${stem}-wt-${n}`), { recursive: true, force: true });
    }
    // basename 衝突テストが作るディレクトリ（テスト内で消し損ねた場合の保険）
    // blobfx = 全文ビューアのフィクスチャ用（テスト内で畳むが、落ちたときの保険）
    for (const n of ['dup1', 'dup2', 'blobfx']) {
        await rm(join(repo, '..', `${stem}-${n}`), { recursive: true, force: true });
    }
    await rm(repo, { recursive: true, force: true });

    // 🚨 遅い起動があったら**緑でも出す**（#34。落ちてから調べても再現しない）
    if (slowStarts.length) {
        console.error(`\n⚠ 起動が異常に遅い実行が ${slowStarts.length} 件ありました`
            + '（基準 107ms）。CI で「起動しなかった」で落ちる前兆です:');
        for (const s of slowStarts.slice(0, 8)) {
            console.error(`    ${s.ms}ms  argv: ${s.argv}`);
        }
    }
    // 🚨 **最後に判定する（#56）。** 後始末を全部済ませてから落とす
    //    （ここで throw すると以降の後始末が走らないので、順序が重要）。
    assert.deepEqual(stateChanged, [],
        `検査が本物の ${STATE_DIR} を書き換えた（#56）: ${stateChanged.join(', ')}。`
        + ' 子を起こす経路に一時 HOME を渡し忘れていないか確認すること'
        + '（同じ場所に実行トークンがある）');
});

// ⚠️ 必ず fresh=1 で叩く。サーバは短い TTL キャッシュを持つので、
//    テストがリポジトリを変更した直後に素で読むと古い payload が返り、
//    「変更が検出されない」形で偽陰性になる（実際にこれで乗っ取り検出が落ちた）。
const state = async () => (await fetch(`${baseUrl}/api/v0/state?fresh=1`)).json();

test('UI が返る', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /kjp-edit/);
});

/**
 * 🚨 **UI が import しているモジュールを全部配信していること。**
 *
 * `app.html` は `./ndjson.mjs` などを import する（ブラウザの中だとテストできない
 * ロジックを外に出しているため）。1本でも 404 だと**モジュール全体が実行されず
 * ページが真っ白になる**。import を足したときに配信の許可リストへ足し忘れる形の
 * 事故は、`chatfilter.mjs` を切り出したときに実際に起こりうる形だった（#44）。
 * **一覧を手で書かず、`app.html` から読む**（書き忘れを検出できないので）。
 */
test('UI が import しているモジュールが全部配信される', async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    const specs = [...html.matchAll(/from\s+'\.\/([A-Za-z0-9_.-]+\.mjs)'/g)].map(m => m[1]);
    assert.ok(specs.length >= 3, `import が読めていない: ${specs.join(',')}`);
    for (const spec of specs) {
        const r = await fetch(`${baseUrl}/${spec}`);
        assert.equal(r.status, 200, `${spec} が配信されていない（ページが真っ白になる）`);
        assert.match(r.headers.get('content-type'), /javascript/, spec);
    }
});

test('ループバック以外を待ち受けていない', async () => {
    // 127.0.0.1 で listen しているので、外部 IP では接続できない
    const port = Number(new URL(baseUrl).port);
    await assert.rejects(
        fetch(`http://192.0.2.1:${port}/`, { signal: AbortSignal.timeout(1200) }),
        '外部アドレスに応答してはいけない',
    );
});

test('3つの worktree を列挙し ahead/behind を返す', async () => {
    const s = await state();
    assert.equal(s.worktrees.length, 3);
    const byBranch = Object.fromEntries(s.worktrees.map(w => [w.branch, w]));
    assert.ok(byBranch['main'], 'main worktree');
    assert.equal(byBranch['agent-a'].ahead, 1);
    assert.equal(byBranch['agent-b'].ahead, 1);
    assert.equal(byBranch['agent-a'].behind, 0);
});

test('E1/E3: 日本語＋空白のファイル名がクォートされずに返る', async () => {
    const s = await state();
    const a = s.worktrees.find(w => w.branch === 'agent-a');
    const paths = a.files.map(f => f.path);
    assert.ok(
        paths.includes('日本語フォルダ/テスト ファイル-a.txt'),
        `期待するパスが無い。実際: ${JSON.stringify(paths)}`,
    );
    // 8進エスケープ (\346\227\245) やクォートが混じっていないこと
    for (const p of paths) {
        assert.ok(!p.includes('\\3'), `8進エスケープが残っている: ${p}`);
        assert.ok(!p.startsWith('"'), `クォートが残っている: ${p}`);
    }
});

test('E6: 日本語コミットメッセージが化けずに返る', async () => {
    const s = await state();
    const subjects = s.graph.map(r => r.subject);
    assert.ok(subjects.includes('feat: agent-a の変更'), JSON.stringify(subjects));
    assert.ok(subjects.includes('chore: 初期コミット'), JSON.stringify(subjects));
});

test('E7: 日本語ブランチ名が ref として見える', async () => {
    const s = await state();
    const refs = s.graph.flatMap(r => r.refs);
    assert.ok(refs.some(r => r.includes('機能/新規')), JSON.stringify(refs));
});

test('同じファイルを触っている worktree を検出する', async () => {
    const s = await state();
    const shared = s.overlaps.find(o => o.path === 'shared.txt');
    assert.ok(shared, `shared.txt の重複が検出されていない: ${JSON.stringify(s.overlaps)}`);
    assert.deepEqual([...shared.worktrees].sort(), ['agent-a', 'agent-b'].map(n =>
        s.worktrees.find(w => w.branch === n).name).sort());
});

test('グラフで兄弟ブランチが別レーンに乗り、worktree の HEAD が印される', async () => {
    const s = await state();
    const heads = s.graph.filter(r => r.worktrees.length > 0);
    assert.equal(heads.length, 3, '3つの worktree HEAD がグラフ上にある');
    const lanes = new Set(heads.map(h => h.lane));
    assert.ok(lanes.size >= 2, `兄弟が同じレーンに畳まれている: ${[...lanes]}`);
    // 開いているレーン数がコミット数に比例して増えていない（重複排除の回帰）
    const maxLanes = Math.max(...s.graph.map(r => r.output.length));
    assert.ok(maxLanes <= 3, `レーンが漏れている: ${maxLanes}`);
});

test('🚨 シーケンサ乗っ取りを検出する（どのツールもガードしていないケース）', async () => {
    const stem = repo.split(/[\\/]/).pop();
    const wt = join(repo, '..', `${stem}-wt-a`);

    // clean index で止まる rebase を作る。todo の先頭に break を挿入する。
    await writeFile(join(wt, 'only-a.txt'), 'a\nmore\n', 'utf8');
    await g(['add', '-A'], wt);
    await g(['commit', '-q', '-m', 'feat: agent-a の2つ目'], wt);
    await new Promise((resolve, reject) => {
        const child = spawn('git', ['rebase', '-i', 'HEAD~2'], {
            cwd: wt, shell: false, windowsHide: true,
            env: {
                ...process.env,
                ...isolatedConfig(),
                GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
                GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
                // todo の 1 行目の後ろに break を挿入する（Node で書くので shell 非依存）
                GIT_SEQUENCE_EDITOR: `${JSON.stringify(process.execPath)} -e `
                    + JSON.stringify(
                        'const f=process.argv[1],fs=require("fs");'
                        + 'const l=fs.readFileSync(f,"utf8").split("\\n");'
                        + 'l.splice(1,0,"break");fs.writeFileSync(f,l.join("\\n"));'),
            },
        });
        child.on('error', reject);
        child.on('close', () => resolve());   // break で止まるので 0 以外もありうる
    });

    // rebase 停止中に、他の worktree で使われていないブランチへ checkout。
    // git はこれを exit 0 で通してしまう。
    await g(['checkout', '-q', '-b', 'hijacked'], wt);

    const s = await state();
    const a = s.worktrees.find(w => w.path.endsWith(`-wt-a`));
    const danger = a.warnings.find(w => w.code === 'sequencer-hijack');
    assert.ok(danger, `乗っ取りが検出されていない: ${JSON.stringify(a.warnings)}`);
    assert.equal(danger.level, 'danger');
    assert.match(danger.message, /agent-a/);
    assert.match(danger.message, /hijacked/);

    // 後片付け
    await g(['rebase', '--abort'], wt).catch(() => {});
    await g(['checkout', '-q', 'agent-a'], wt).catch(() => {});
});

// ---------------------------------------------------------------------------
// レビューで見つかった「静かに 500 になる / 静かに混ざる」経路の回帰テスト。
// いずれも worktree を作る・壊すので、既存のフィクスチャを乱さないように
// 専用の worktree を作って自分で片付ける。
// ---------------------------------------------------------------------------

test('1回の収集で git を起動する回数が worktree 本数に比例して爆発しない', async () => {
    const s = await state();
    assert.ok(s.stats, 'payload に stats が無い');
    const { gitSpawns, worktrees } = s.stats;
    // 実測: 定数 5（worktree list / for-each-ref / git-common-dir /
    // origin/HEAD / log）+ 1本あたり 3（status / rev-list / diff）
    // + 衝突予測の候補ペア数（merge-tree 1回ずつ）。
    // 1本あたり1プロセス分だけ余裕を持たせる。
    // ⚠️ 以前は worktrees*4 で1本あたり1 spawn ぶん緩かった（doc の式は 3N）。
    //    「ループの中で git を増やす回帰」を捕まえる精度が甘くなるので式に寄せる。
    //    +1 は merge driver の列挙（候補ペアがあるときだけ走る）。
    const pairs = s.stats.conflictPairs ?? 0;
    const budget = worktrees * 3 + 6 + pairs + (pairs ? 1 : 0);
    assert.ok(
        gitSpawns <= budget,
        `worktree ${worktrees} 本で ${gitSpawns} プロセス起動（上限 ${budget}）。`
        + ' ループの中で新しい git 呼び出しを足していないか確認する',
    );
});

test('worktree のディレクトリが消えても他の worktree は返る（500 にしない）', async () => {
    const stem = repo.split(/[\\/]/).pop();
    const gone = join(repo, '..', `${stem}-wt-gone`);
    await g(['worktree', 'add', '-q', '-b', 'agent-gone', gone], repo);
    // ディレクトリだけ消す → git 的には prunable。cwd に使うと ENOENT。
    await rm(gone, { recursive: true, force: true });

    const res = await fetch(`${baseUrl}/api/v0/state?fresh=1`);
    assert.equal(res.status, 200, 'prunable な worktree でエンドポイントが落ちてはいけない');
    const s = await res.json();

    // 生きている worktree は今までどおり出る
    assert.ok(s.worktrees.find(w => w.branch === 'agent-a'), 'agent-a が消えている');
    assert.ok(s.worktrees.find(w => w.branch === 'main'), 'main が消えている');
    // 失われた worktree は黙って消えるのではなく prunable として現れる
    const dead = s.worktrees.find(w => w.branch === 'agent-gone');
    assert.ok(dead, 'prunable な worktree が一覧から消えている');
    assert.ok(dead.prunable, 'prunable フラグが立っていない');
    // 縮退したことが payload に残る
    assert.ok(
        s.errors.some(e => /失われて/.test(e.message)),
        `errors に縮退が記録されていない: ${JSON.stringify(s.errors)}`,
    );

    await g(['worktree', 'prune'], repo);
    await g(['branch', '-D', 'agent-gone'], repo).catch(() => {});
});

test('basename が衝突する worktree の変更が混ざらない', async () => {
    const stem = repo.split(/[\\/]/).pop();
    const one = join(repo, '..', `${stem}-dup1`, 'dup');
    const two = join(repo, '..', `${stem}-dup2`, 'dup');
    await g(['worktree', 'add', '-q', '-b', 'dup-one', one], repo);
    await g(['worktree', 'add', '-q', '-b', 'dup-two', two], repo);
    // 両方が同じファイルを触る。basename でキーにしていると1本に見える。
    await writeFile(join(one, 'dup-shared.txt'), 'from one\n', 'utf8');
    await writeFile(join(two, 'dup-shared.txt'), 'from two\n', 'utf8');
    await g(['add', '-A'], one);
    await g(['commit', '-q', '-m', 'feat: dup one'], one);
    await g(['add', '-A'], two);
    await g(['commit', '-q', '-m', 'feat: dup two'], two);

    const s = await state();
    const dups = s.worktrees.filter(w => w.basename === 'dup');
    assert.equal(dups.length, 2, '同名 worktree が2本見えていない');
    // 表示名が一意になっている（親ディレクトリで区別される）
    assert.equal(new Set(dups.map(w => w.name)).size, 2,
        `表示名が衝突している: ${dups.map(w => w.name)}`);

    // 重複検出が2本を別物として数える
    const ov = s.overlaps.find(o => o.path === 'dup-shared.txt');
    assert.ok(ov, 'dup-shared.txt の重複が検出されていない');
    assert.equal(ov.worktrees.length, 2,
        `basename でキーにすると1本に潰れる: ${JSON.stringify(ov)}`);

    for (const [wt, branch] of [[one, 'dup-one'], [two, 'dup-two']]) {
        await g(['worktree', 'remove', '--force', wt], repo).catch(() => {});
        await g(['branch', '-D', branch], repo).catch(() => {});
    }
});

// ---------------------------------------------------------------------------
// /api/v0/diff と /api/v0/blob。ネットワーク越しの値を git に渡す唯一の経路なので、
// 「読めるべきものが読める」と「読めてはいけないものが読めない」の両方を見る。
// ---------------------------------------------------------------------------

test('diff: 日本語＋空白のファイル名の差分が取れる', async () => {
    const p = '日本語フォルダ/テスト ファイル-a.txt';
    const q = new URLSearchParams({ base: 'main', ref: 'agent-a', path: p });
    const res = await fetch(`${baseUrl}/api/v0/diff?${q}`);
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.binary, false);
    // ファイル追加なので +++ 側にパスが出る。クォートされていないこと
    assert.match(d.text, /\+\+\+ b\/日本語フォルダ\/テスト ファイル-a\.txt/);
    assert.match(d.text, /^\+ok$/m, `追加行が無い: ${d.text}`);
});

test('blob: 追跡されている内容が読める', async () => {
    // ⚠️ only-a.txt を使わないこと。乗っ取り検出テストが agent-a に
    //    コミットを積んで内容を変えるので、実行順序に依存して落ちる（実際に落ちた）。
    //    shared.txt はどのテストも書き換えない。
    const q = new URLSearchParams({ ref: 'agent-a', path: 'shared.txt' });
    const res = await fetch(`${baseUrl}/api/v0/blob?${q}`);
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.binary, false);
    assert.equal(d.tooLarge, false);
    assert.equal(d.text, 'touched by a\n');
});

test('🔒 blob: リポジトリ外へ抜けようとする path を拒否する', async () => {
    for (const bad of [
        '../../../../../../Windows/win.ini',
        '..\\..\\..\\Windows\\win.ini',
        '/etc/passwd',
        'C:/Windows/win.ini',
        '--output=/tmp/pwned',
    ]) {
        const q = new URLSearchParams({ ref: 'agent-a', path: bad });
        const res = await fetch(`${baseUrl}/api/v0/blob?${q}`);
        assert.equal(res.status, 400, `拒否されていない: ${bad}`);
        const d = await res.json();
        assert.ok(d.error, `error が返っていない: ${bad}`);
        // 中身が漏れていないこと
        assert.equal(d.text, undefined, `中身が返っている: ${bad}`);
        // 🚨 **400 だけを見てはいけない。拒否理由を確認する。**
        //    git 自身も `<rev>:<path>` を repo の中に限定するので、入口の検証を
        //    丸ごと外しても全部 400（「見つかりません」）のまま緑で通り抜ける
        //    （reflog の検証で同じ形の偽陽性を実際に踏んだ）。
        //    多重防御の**手前側が生きていること**をここで固定する。
        assert.match(d.error, /path が不正です/,
            `入口の検証ではなく git 側の失敗で 400 になっている: ${bad} → ${d.error}`);
    }
});

// 🔒 ref も同じ。`main~1` のようなリビジョン式は git なら解決できてしまうので、
//    「入口で弾いている」ことを理由の文言まで見て固定する。
test('🔒 blob: ref にオプションやリビジョン式を渡せない', async () => {
    for (const bad of ['--output=/tmp/x', 'main~1', 'main^{tree}', 'a b', 'x..y']) {
        const q = new URLSearchParams({ ref: bad, path: 'shared.txt' });
        const res = await fetch(`${baseUrl}/api/v0/blob?${q}`);
        assert.equal(res.status, 400, `拒否されていない: ${bad}`);
        const d = await res.json();
        assert.match(d.error, /ref が不正です/,
            `入口の検証ではなく git 側の失敗で 400 になっている: ${bad} → ${d.error}`);
        assert.equal(d.text, undefined, `中身が返っている: ${bad}`);
    }
});

/**
 * 全文ビューア用のフィクスチャ。**巨大ファイルとバイナリ**を含む
 * コミットを1つ作る。
 *
 * ⚠️ **worktree を増やしたままにしない。** `worktrees.length === 3` を見ている
 *    テストがあるので、一時 worktree でコミットしてから畳む（ブランチだけ残す）。
 *    ブランチはどの worktree の HEAD からも到達できないのでグラフにも出ない。
 */
let blobFixtureWt = null;
async function ensureBlobFixture() {
    if (blobFixtureWt) return;
    const stem = repo.split(/[\\/]/).pop();
    const wt = join(repo, '..', `${stem}-blobfx`);
    await g(['worktree', 'add', '-q', '-b', 'blob-fixture', wt], repo);
    // サーバ側の上限（512KB）を確実に超える大きさ。中身は何でもよい
    await writeFile(join(wt, 'big.txt'), 'a'.repeat(600 * 1024), 'utf8');
    // ⚠️ **ソースに生の NUL を書かない**（git がこのテストファイルを binary と
    //    判定して `git log -p` から見えなくなる。実際に v0/git.mjs でやった）。
    //    バイト列を組み立てる。先頭 8000 バイトに NUL があれば git と同じ判定になる
    await writeFile(join(wt, 'bin.dat'),
        Buffer.concat([Buffer.from('PNGX'), Buffer.alloc(32, 0), Buffer.from('tail')]));
    await g(['add', '-A'], wt);
    await g(['commit', '-q', '-m', 'test: 大きいファイルとバイナリ'], wt);
    await g(['worktree', 'remove', '--force', wt], repo);
    blobFixtureWt = wt;
}

// 🔒 巨大ファイルでメモリを食い切らせない。**上限に達したら読むのをやめて、
//    やめたことを言う**（size も binary も「読んでいないので分からない」を含む）。
test('blob: サーバの上限を超えるファイルは中身を読まずに tooLarge を返す', async () => {
    await ensureBlobFixture();
    const q = new URLSearchParams({ ref: 'blob-fixture', path: 'big.txt' });
    const res = await fetch(`${baseUrl}/api/v0/blob?${q}`);
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.tooLarge, true, `上限が効いていない: ${JSON.stringify(d).slice(0, 200)}`);
    assert.equal(d.text, null, '上限を超えたのに中身が返っている');
    // 「読まなかったので分からない」を false と偽らない
    assert.equal(d.binary, null);
    assert.equal(d.size, 600 * 1024);
    // ⚠️ UI が上限を二重に書かないための値。無いと告知の数字が書けない
    assert.equal(d.limitBytes, 512 * 1024, `limitBytes が返っていない: ${d.limitBytes}`);
});

test('blob: バイナリは中身を返さず binary で告知する', async () => {
    await ensureBlobFixture();
    const q = new URLSearchParams({ ref: 'blob-fixture', path: 'bin.dat' });
    const res = await fetch(`${baseUrl}/api/v0/blob?${q}`);
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.binary, true, `バイナリと判定されていない: ${JSON.stringify(d).slice(0, 200)}`);
    assert.equal(d.tooLarge, false);
    assert.equal(d.text, null, 'バイナリの中身が返っている');
    assert.equal(d.size, 40);
});

test('blob: 上限内のテキストは全文が返る（全文ビューアが読むもの）', async () => {
    await ensureBlobFixture();
    const q = new URLSearchParams({ ref: 'blob-fixture', path: 'README.md' });
    const d = await (await fetch(`${baseUrl}/api/v0/blob?${q}`)).json();
    assert.equal(d.tooLarge, false);
    assert.equal(d.binary, false);
    assert.equal(d.text, '# smoke\n');
});

test('🔒 diff: ref にオプションやリビジョン式を渡せない', async () => {
    for (const bad of ['--output=/tmp/x', 'main~1', 'main^{tree}', 'a b', 'x..y']) {
        const q = new URLSearchParams({ base: 'main', ref: bad, path: 'only-a.txt' });
        const res = await fetch(`${baseUrl}/api/v0/diff?${q}`);
        assert.equal(res.status, 400, `拒否されていない: ${bad}`);
    }
});

test('blob: 未追跡のファイルは読めない（git オブジェクト経由なので）', async () => {
    const stem = repo.split(/[\\/]/).pop();
    const wt = join(repo, '..', `${stem}-wt-b`);
    await writeFile(join(wt, 'secret-untracked.txt'), 'トップシークレット\n', 'utf8');
    const q = new URLSearchParams({ ref: 'agent-b', path: 'secret-untracked.txt' });
    const res = await fetch(`${baseUrl}/api/v0/blob?${q}`);
    assert.equal(res.status, 400, '未追跡ファイルが読めてしまっている');
    const d = await res.json();
    assert.match(d.error, /見つかりません/);
    await rm(join(wt, 'secret-untracked.txt'), { force: true });
});

// TOCTOU 対策。size と text が別オブジェクトのものにならないよう、
// 先に不変の OID へ解決してから読む。payload に oid が出ることで検証できる。
test('blob: 不変の OID に解決してから読む（size と text が同じオブジェクト）', async () => {
    const q = new URLSearchParams({ ref: 'agent-a', path: 'shared.txt' });
    const d = await (await fetch(`${baseUrl}/api/v0/blob?${q}`)).json();
    assert.match(d.oid ?? '', /^[0-9a-f]{40,64}$/, `OID が返っていない: ${JSON.stringify(d)}`);
    // git が同じ OID を返すこと
    const expect = (await g(['rev-parse', 'agent-a:shared.txt'], repo)).trim();
    assert.equal(d.oid, expect);
    // size は読んだバイト数そのもの（別問い合わせではない）
    assert.equal(d.size, Buffer.byteLength(d.text, 'utf8'));
});

test('blob: 存在しない path は 400 で、500 にしない', async () => {
    const q = new URLSearchParams({ ref: 'agent-a', path: 'no/such/file.txt' });
    const res = await fetch(`${baseUrl}/api/v0/blob?${q}`);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /見つかりません/);
});

// ---------------------------------------------------------------------------
// 🔒 DNS rebinding。127.0.0.1 バインドと CORS では防げない攻撃なので、
//    Host 検証が効いていることを固定する。認証より先に必要な保護。
// ---------------------------------------------------------------------------

/**
 * ⚠️ fetch（undici）は Host ヘッダを上書きできない（forbidden header）。
 *    黙って既定の Host が送られるので、fetch で書いたテストは
 *    「攻撃が防がれた」ではなく「攻撃を送れていない」を見てしまう（実際に踏んだ）。
 *    Host を検証するテストは生の node:http で送る。
 */
function rawGet(urlStr, headers = {}) {
    const u = new URL(urlStr);
    return new Promise((resolve, reject) => {
        const req = httpRequest({
            hostname: u.hostname, port: u.port, path: u.pathname + u.search,
            method: 'GET', headers,
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.on('error', reject);
        req.end();
    });
}

test('🔒 Host が攻撃者のドメインのリクエストを拒否する（DNS rebinding）', async () => {
    const port = Number(new URL(baseUrl).port);
    for (const host of ['evil.example', 'attacker.test:1234', 'kjp.evil.example']) {
        const res = await rawGet(`${baseUrl}/api/v0/state`, { host });
        assert.equal(res.status, 403, `Host: ${host} が通ってしまった`);
        assert.doesNotMatch(res.body, /worktree/, `403 なのに中身が漏れている: ${host}`);
    }
    // 正しい Host は通る
    const ok = await rawGet(`${baseUrl}/api/v0/state`, { host: `127.0.0.1:${port}` });
    assert.equal(ok.status, 200);
    assert.match(ok.body, /worktrees/);
});

test('🔒 ループバックでもポートが違う Host は拒否する', async () => {
    const res = await rawGet(`${baseUrl}/api/v0/state`, { host: '127.0.0.1:1' });
    assert.equal(res.status, 403);
});

test('🔒 別サイトからの参照（Sec-Fetch-Site: cross-site）を拒否する', async () => {
    const res = await fetch(`${baseUrl}/api/v0/state`, {
        headers: { 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(res.status, 403);
    // 同一オリジンと直接ナビゲーションは通る
    for (const site of ['same-origin', 'none']) {
        const ok = await fetch(`${baseUrl}/api/v0/state`, { headers: { 'sec-fetch-site': site } });
        assert.equal(ok.status, 200, `${site} が拒否されている`);
    }
});

test('🔒 diff / blob / layout も同じ Host 検証を通る（経路ごとの取りこぼしが無い）', async () => {
    const paths = [
        '/api/v0/blob?ref=agent-a&path=shared.txt',
        '/api/v0/diff?base=main&ref=agent-a&path=shared.txt',
        '/layout',
        '/',
    ];
    for (const p of paths) {
        const res = await rawGet(`${baseUrl}${p}`, { host: 'evil.example' });
        assert.equal(res.status, 403, `${p} が Host 検証を通っていない`);
    }
});

test('--allow-host で指定したホスト名だけは通る（トンネル用）', async () => {
    const child = spawn(
        process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--allow-host', 'box.tail-scale.ts.net'],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } },
    );
    child.stdout.setEncoding('utf8');
    try {
        // トークンの案内も同じ塊で出るので banner ごと受け取る。
        // ⚠️ **stderr を捨てない。** 捨てると CI で「起動しなかった」だけが残り
        //    原因が消える（実際に1往復無駄にした）。
        let banner = '';
        let errOut = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', d => { errOut += d; });
        const url = await new Promise((resolve, reject) => {
            const fail = () => reject(new Error(`起動しなかった\n  stdout: ${banner.trim() || '(空)'}`
                + `\n  stderr: ${errOut.trim() || '(空)'}`));
            const t = setTimeout(fail, 30000);
            child.stdout.on('data', d => {
                banner += d;
                const m = banner.match(/http:\/\/127\.0\.0\.1:\d+/);
                if (m) { clearTimeout(t); setTimeout(() => resolve(m[0]), 400); }
            });
            child.on('error', e => { clearTimeout(t); reject(e); });
            child.on('exit', () => setTimeout(() => { clearTimeout(t); fail(); }, 50));
        });
        // ⚠️ --allow-host を付けると**認証が既定で必須になる**ので、
        //    許可したホスト名でもトークンが無ければ 401。
        //    「Host が通る」と「操作してよい」は別の判定であることを固定する。
        const noTok = await rawGet(`${url}/api/v0/state`, { host: 'box.tail-scale.ts.net' });
        assert.equal(noTok.status, 401, 'トンネル用のホスト名が無認証で通ってしまった');

        const token = /\?token=([A-Za-z0-9_-]+)/.exec(banner)?.[1];
        assert.ok(token, `トークンが案内に出ていない: ${banner}`);
        const ok = await rawGet(`${url}/api/v0/state`,
            { host: 'box.tail-scale.ts.net', 'x-kjp-token': token });
        assert.equal(ok.status, 200, '許可したホスト名 + トークンが通らない');

        // 🔒 Host の判定は認証より手前。**正しいトークンでも Host が違えば 403。**
        //    順序が逆だと、トークンを持つ相手が任意の Host で入れてしまう
        //    （rebinding 対策が認証の後ろに回ると意味が薄れる）
        const no = await rawGet(`${url}/api/v0/state`,
            { host: 'evil.example', 'x-kjp-token': token });
        assert.equal(no.status, 403, '許可していないホスト名がトークン付きで通ってしまった');
    } finally {
        child.kill();
    }
});

// ---------------------------------------------------------------------------
// 🔒 書き込み（checkout）。関門の4条件すべてと、シーケンサ停止中の拒否を固定する。
//    docs/auth-ordering.md の 1〜4 段。
// ---------------------------------------------------------------------------

// 「同じファイルを触っている」は代理指標。実際に衝突するかを merge-tree で見る。
// ---------------------------------------------------------------------------
// 非機能要件（応答時間）の線。docs/performance.md に根拠と実測値がある。
//
// ⚠️ 壁時計の assert は CI のノイズで揺れるので、**精度は spawn 数で、
//    桁違いの劣化だけを壁時計で**見る。2段構えにする理由:
//    厳しい壁時計は flaky になり、緩い壁時計だけでは 3倍の劣化を見逃す。
// ---------------------------------------------------------------------------

test('応答時間: 収集が桁違いに遅くなっていない', async () => {
    // 一度温めてから測る（初回は Node の JIT とファイルキャッシュで遅い）
    await fetch(`${baseUrl}/api/v0/state?fresh=1`);
    const runs = [];
    for (let i = 0; i < 5; i++) {
        const t0 = process.hrtime.bigint();
        const res = await fetch(`${baseUrl}/api/v0/state?fresh=1`);
        await res.json();
        runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const median = [...runs].sort((a, b) => a - b)[2];
    // 手元の実測は 3 worktree で中央 195ms。CI は遅いので 10 倍を天井にする。
    // これは「桁違いの劣化」を捕まえるための線で、性能目標そのものではない
    // （目標は docs/performance.md、精度の担保は gitSpawns のテスト）。
    assert.ok(median < 2000,
        `収集の中央値が ${median.toFixed(0)}ms（天井 2000ms）。`
        + ' ループの中で git 呼び出しを増やしていないか確認する');
});

test('応答時間: キャッシュ経由は収集より明確に速い', async () => {
    await fetch(`${baseUrl}/api/v0/state?fresh=1`);
    const t0 = process.hrtime.bigint();
    await (await fetch(`${baseUrl}/api/v0/state`)).json();
    const cached = Number(process.hrtime.bigint() - t0) / 1e6;
    // 手元では 1-2ms。TTL キャッシュが壊れて毎回収集していたら数百 ms になる
    assert.ok(cached < 100,
        `キャッシュ経由が ${cached.toFixed(0)}ms。TTL キャッシュが効いていない可能性`);
});

test('取り込み順序の提案が payload に入り、塊の中身が衝突しない', async () => {
    const s = await state();
    assert.ok(s.mergePlan, 'mergePlan が無い');
    const bad = new Set((s.conflicts ?? []).filter(c => !c.clean)
        .map(c => [c.a, c.b].sort().join('|')));
    const b = s.mergePlan.batch;
    for (let i = 0; i < b.length; i++) {
        for (let j = i + 1; j < b.length; j++) {
            assert.ok(!bad.has([b[i], b[j]].sort().join('|')),
                `提案の塊に衝突ペアが入っている: ${b[i]} × ${b[j]}`);
        }
    }
    // agent-a と agent-b は衝突するので、両方が塊に入ることは無い
    const names = n => s.worktrees.find(w => w.branch === n).name;
    const both = b.includes(names('agent-a')) && b.includes(names('agent-b'));
    assert.equal(both, false, '衝突する2本が同じ塊に入っている');
});

test('衝突予測: 実際に衝突するペアを検出する', async () => {
    const s = await state();
    assert.ok(Array.isArray(s.conflicts), 'conflicts が payload に無い');
    const names = n => s.worktrees.find(w => w.branch === n).name;
    const pair = s.conflicts.find(c =>
        [c.a, c.b].sort().join('|') === [names('agent-a'), names('agent-b')].sort().join('|'));
    assert.ok(pair, `agent-a × agent-b のペアが無い: ${JSON.stringify(s.conflicts)}`);
    // 両方が shared.txt を別内容で追加しているので add/add で衝突する
    assert.equal(pair.clean, false, 'きれいにマージできると判定されている');
    // ⚠️ `files` は `{path, synthetic, ...}` の配列（#1 で合成パスに印を付けた）
    const paths = pair.files.map(f => (typeof f === 'string' ? f : f.path));
    assert.ok(paths.includes('shared.txt'),
        `衝突ファイルに shared.txt が無い: ${JSON.stringify(pair.files)}`);
    // 日本語＋空白のパスがクォートされずに返る（別名なので衝突しない）
    for (const f of paths) {
        assert.ok(!f.includes('\\3'), `8進エスケープが残っている: ${f}`);
        assert.ok(!f.startsWith('"'), `クォートが残っている: ${f}`);
    }
});

/**
 * 🚨 **diff がリポジトリ設定のコマンドを実行しないこと（textconv / ext-diff）。**
 *
 * `core.fsmonitor` と**同じレビュー・同じコミット**で入った守りなのに、
 * fsmonitor だけテストと変異があり、`--no-textconv` / `--no-ext-diff` 側は
 * **テストも変異も1件も無かった**（7回目のレビュー）。
 * 1行の書き戻しで、無認証の読み取り経路（`/api/v0/diff`）が RCE に戻る。
 */
/**
 * 🚨 **rename の3トークン（`status` NUL `from` NUL `to`）がずれないこと。**
 *
 * ここが1つずれると status とパスの対応が**全部シフト**し、
 * 別 worktree のファイル名をカードに出す / 「同じファイルを触っている」の
 * 重複検出が嘘になる / 差分タブが違うファイルを開く。
 * CLAUDE.md が「`-z` の多トークン」を再発トップの罠として挙げている当のコードで、
 * **`git mv` がテストに1回も出てこなかった**（7回目のレビュー。grep で0件）。
 */
/**
 * 🚨 **read 権限のコマンド行から実行トークンを回収できないこと（7回目のレビュー）。**
 *
 * 読み取りと実行を分けた根拠は「Cookie は他ポートに漏れるが、漏れても読み取りまで」。
 * ところが `--allow-transcript-text` は記録の `Bash` のコマンド行を丸ごと出す。
 * README が案内していた起動手順は `--allow-exec --token "$TOKEN"` なので、
 * **値をリテラルで打った回は記録に残る**（実データで 42 件）。
 * つまり Cookie しか持たない相手が実行トークンを回収でき、read が RCE に昇格する。
 */
/**
 * 🚨 **認証失敗を記録し、連続失敗には遅延を掛ける（7回目のレビュー）。**
 *
 * `--allow-host` を付けた瞬間、トンネルに届く相手に対する**唯一の壁がトークン**
 * になる。にもかかわらず 401 はどこにも記録されず、遅延も回数制限も無かったので
 * **当て放題かつ痕跡ゼロで総当たり**できた（実測: 3文字なら29回目に 200、
 * 17,576 回外しても絞られない）。当たれば読み取り全部と checkout が通る。
 *
 * ⚠️ 試された値そのものは記録しない（トークンの候補を記録に書かない）。
 */
/**
 * 🚨 **トークンの長さの下限は capability を問わず掛ける（7回目のレビュー）。**
 *
 * 以前は下限が `--allow-exec` のときだけだったので `--token abc` が通った。
 * `--allow-host` を付けるとトンネルに届く相手に対する**唯一の壁**がこれになる
 * （実測: 3文字なら総当たりで29回目に 200 が返った）。
 */
test('🔒 短いトークンでは起動しない（capability を問わず）', async () => {
    const cases = [
        [['--token', 'abc'], '読み取りだけ'],
        [['--token', 'abc', '--allow-host', 'x.example'], 'トンネル'],
        [['--token', 'abc', '--allow-write'], '書き込み'],
        [['--token', 'a'.repeat(23)], '23 文字（境界の1つ手前）'],
    ];
    for (const [extra, label] of cases) {
        const child = spawn(process.execPath,
            [SERVER, '--repo', repo, '--port', '0', ...extra],
            { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
        child.stderr.setEncoding('utf8');
        let err = '';
        child.stderr.on('data', d => { err += d; });
        // ⚠️ 拒否されないとサーバは listen し続けるので素の await にしない
        const code = await Promise.race([
            new Promise(r => child.on('close', r)),
            new Promise(r => setTimeout(() => r('running'), 15000)),
        ]);
        child.kill();
        assert.equal(code, 1, `起動してしまった（${label}）`);
        assert.match(err, /24 文字以上/, label);
    }
    // 24 文字なら通る（門が全部を拒否していないこと）
    const okChild = spawn(process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--token', 'a'.repeat(24)],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
    okChild.stdout.setEncoding('utf8');
    try {
        const started = await Promise.race([
            new Promise(r => {
                let buf = '';
                okChild.stdout.on('data', d => {
                    buf += d;
                    if (/http:[/][/]127[.]0[.]0[.]1:[0-9]+/.test(buf)) r(true);
                });
            }),
            new Promise(r => setTimeout(() => r(false), 15000)),
        ]);
        assert.ok(started, '24 文字のトークンで起動しない');
    } finally { okChild.kill(); }
});
/**
 * 🚨 **exec の argv を Cookie だけの相手に出さない。**
 *
 * `argv` はユーザが打ったコマンド行そのもので、秘密が載りうる。
 * Cookie はポートで分離されないので、他ポートのページが読める状態にすると
 * 「read は読み取りまで」という分界が崩れる（記録のコマンド行と同じクラス）。
 * 7回目のレビューで transcript 側を直したが、**同型の穴が exec 側に残っていた**。
 */
test('🔒 exec の argv は Cookie だけでは読めず、秘密はマスクされる', async () => {
    const child = spawn(process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--require-auth',
            '--allow-exec', '--token', EXEC_TOKEN],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
    child.stdout.setEncoding('utf8');
    try {
        const url = await new Promise((res, rej) => {
            const t2 = setTimeout(() => rej(new Error('起動しなかった')), 15000);
            let buf = '';
            child.stdout.on('data', d => {
                buf += d;
                const m = buf.match(/http:[/][/]127[.]0[.]0[.]1:[0-9]+/);
                if (m) { clearTimeout(t2); res(m[0]); }
            });
            child.on('error', rej);
        });
        const port = Number(new URL(url).port);

        // 秘密を argv に含むセッションを1本走らせる
        const started = await fetch(`${url}/api/v0/exec`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            body: JSON.stringify({
                worktree: repo,
                argv: [process.execPath, '-e', `setTimeout(()=>{}, 3000)`, '--token', EXEC_TOKEN],
            }),
        });
        assert.equal(started.status, 200);
        started.body?.cancel?.().catch(() => {});
        await new Promise(r => setTimeout(r, 300));

        // Cookie を手に入れる（読み取りは通る）
        const boot = await authGet(port, `/?token=${EXEC_TOKEN}`);
        const cookie = /kjp_auth=([^;]+)/.exec(boot.setCookie)?.[1];
        assert.ok(cookie, 'Cookie が焼かれていない');

        // 🚨 Cookie だけ → 読み取りは 200 だが exec の一覧は出ない
        const viaCookie = await authGet(port, '/api/v0/state?fresh=1',
            { cookie: `kjp_auth=${cookie}` });
        assert.equal(viaCookie.code, 200, 'Cookie で読み取りができない');
        const c = JSON.parse(viaCookie.body);
        assert.equal(c.execSessions, null, 'Cookie だけで exec の argv が読める');
        assert.equal(c.execSessionsHidden, true, '隠したことを伝えていない');
        assert.ok(!viaCookie.body.includes(EXEC_TOKEN),
            'Cookie 経路の payload にトークンが出ている');

        // トークンを提示すれば見える。ただし **argv の秘密はマスクされる**
        const viaToken = await authGet(port, '/api/v0/state?fresh=1',
            { 'x-kjp-token': EXEC_TOKEN });
        assert.equal(viaToken.code, 200);
        const j = JSON.parse(viaToken.body);
        assert.ok(Array.isArray(j.execSessions), 'トークンを提示しても一覧が出ない');
        assert.ok(j.execSessions.length >= 1);
        assert.ok(!viaToken.body.includes(EXEC_TOKEN),
            'argv に載ったトークンがマスクされていない');
        assert.ok(j.execSessions.some(x => x.argvMasked === true),
            'マスクしたことを伝えていない');
    } finally {
        child.kill();
    }
});
/**
 * 🚨 **`--require-auth` で走っているセッションが「無い」ことにならない
 *    （8回目のレビュー。SERIOUS）。**
 *
 * `--allow-host`（= トンネル = スマホから使う既定の構成）は `--require-auth` を
 * 自動でオンにする。案内の URL に載るのは**読み取り専用の派生秘密**なので、
 * スマホのタブはまずそれを `x-kjp-token` で送って読む。
 * ⚠️ **その相手に exec の argv を渡す分界は緩めない**（コマンド行に秘密が載りうるし、
 *    Cookie はポートで分離されない）。しかし**落としたことを言わなければ**、
 *    UI は `execSessions: null` を「1本も走っていない」と描き、
 *    走っているセッションと再接続口が**黙って消える**（#17 の目的が到達不能）。
 *
 * ここで固定するのは server 側の契約:
 *   (A) 読み取り用の鍵 → 200 / `execSessions: null` / **`execSessionsHidden: true`**
 *   (B) 実行の鍵       → 200 / 一覧が出る（`load()` はこの鍵をヘッダで送る）
 * UI が実際に案内するかは実ブラウザで測る（`v0/render-check.mjs` の読み取り鍵の検査）。
 */
test('🚨 --require-auth: 読み取り用の鍵では走っているセッションを出さないが、隠したと告げる', async () => {
    const s = await startAuthServer(['--require-auth', '--allow-exec', '--token', EXEC_TOKEN]);
    try {
        const readKey = /\?token=([A-Za-z0-9_-]+)/.exec(s.banner())?.[1];
        assert.ok(readKey, `案内の URL に読み取り用の鍵が出ていない: ${s.banner()}`);
        assert.notEqual(readKey, EXEC_TOKEN, '案内の URL に生の鍵が載っている');

        // 走っているセッションを1本用意する（実行の鍵で起こす）
        const started = await fetch(`http://127.0.0.1:${s.port}/api/v0/exec`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            body: JSON.stringify({
                worktree: repo,
                argv: [process.execPath, '-e', 'setTimeout(()=>{}, 5000)'],
            }),
        });
        assert.equal(started.status, 200, '実行の鍵でセッションを作れない');
        started.body?.cancel?.().catch(() => { /* 購読はしない */ });
        await new Promise(r => setTimeout(r, 300));

        // (A) 読み取り用の鍵をヘッダで送る = スマホのタブがやること
        const viaRead = await authGet(s.port, '/api/v0/state?fresh=1',
            { 'x-kjp-token': readKey });
        assert.equal(viaRead.code, 200, '読み取り用の鍵で読めない');
        const r = JSON.parse(viaRead.body);
        assert.equal(r.execSessions, null, '読み取り用の鍵で exec の argv が読める');
        assert.equal(r.execSessionsHidden, true,
            '一覧を落としたのに黙っている（UI が「1本も走っていない」と描く）');

        // (B) 実行の鍵をヘッダで送る = 画面で鍵を貼ったタブ
        const viaToken = await authGet(s.port, '/api/v0/state?fresh=1',
            { 'x-kjp-token': EXEC_TOKEN });
        assert.equal(viaToken.code, 200);
        const t = JSON.parse(viaToken.body);
        assert.ok(Array.isArray(t.execSessions),
            '実行の鍵でも一覧が出ない（走っているものへの再接続口が消える）');
        assert.ok(t.execSessions.some(x => x.state === 'starting' || x.state === 'running'),
            `走っているセッションが一覧に出ていない: ${viaToken.body.slice(0, 300)}`);
        assert.ok(!t.execSessionsHidden, '出しているのに「隠した」と言っている');
    } finally { s.child.kill(); }
});
test('🔒 認証失敗は記録され、連続失敗は遅くなる（本文は残さない）', async () => {
    const audit = join(repo, '..', `auth-audit-${Date.now()}.jsonl`);
    const child = spawn(process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--require-auth',
            '--token', EXEC_TOKEN, '--audit-log', audit],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
    child.stdout.setEncoding('utf8');
    try {
        const url = await new Promise((res, rej) => {
            const t2 = setTimeout(() => rej(new Error('起動しなかった')), 15000);
            let buf = '';
            child.stdout.on('data', d => {
                buf += d;
                const m = buf.match(/http:[/][/]127[.]0[.]0[.]1:\d+/);
                if (m) { clearTimeout(t2); res(m[0]); }
            });
            child.on('error', rej);
        });

        // 8回外す。遅延は 4 回目から伸びる（0,0,0,50,100,200,400,800 = 1550ms）
        const t0 = Date.now();
        for (let i = 0; i < 8; i++) {
            const r = await fetch(`${url}/api/v0/state`,
                { headers: { 'x-kjp-token': `wrong-value-${i}` } });
            assert.equal(r.status, 401, `${i} 回目が 401 でない`);
            await r.text();
        }
        const ms = Date.now() - t0;
        assert.ok(ms > 300,
            `連続失敗が遅くなっていない（${ms}ms）。痕跡ゼロで総当たりできる`);

        // 正規のトークンは通る（遅延で締め出していない）
        const ok = await fetch(`${url}/api/v0/state`,
            { headers: { 'x-kjp-token': EXEC_TOKEN } });
        assert.equal(ok.status, 200, '正しいトークンが通らない');
        await ok.text();

        // 監査に残っていること（誰が何回外したか）
        await new Promise(r => setTimeout(r, 300));
        const { readFile: rf } = await import('node:fs/promises');
        const lines = (await rf(audit, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
        const fails = lines.filter(e => e.event === 'auth-failed');
        assert.ok(fails.length >= 1, `失敗が記録されていない: ${fails.length} 件`);
        assert.equal(typeof fails[0].peer, 'string');
        assert.equal(fails[0].path, '/api/v0/state');
        // 🚨 **1本1行では記録しない（8回目のレビュー）。** 認証前の要求は誰でも
        //    撃てるので、個別行だと外から `.git` の中のファイルを無制限に伸ばせる。
        //    先頭だけ個別に残し、**残りは集約行**にする。
        assert.ok(fails.length <= 3,
            `401 を1本1行で追記している（${fails.length} 行）。外から容量を食える`);
        const sum = lines.filter(e => e.event === 'auth-failed-summary');
        // 🚨 **捨てたことが分かる形で残す**（黙って落とさない）
        assert.ok(sum.length >= 1, '集約行が無い。個別行を省いたことが記録から分からない');
        const last = sum[sum.length - 1];
        assert.ok(last.suppressed >= 1,
            `集約行が「何本省いたか」を持っていない: ${JSON.stringify(last)}`);
        assert.equal(typeof last.attempts, 'number');
        // 🔒 **試された値は記録しない**（トークンの候補を記録に書かない）
        assert.ok(!JSON.stringify(lines).includes('wrong-value-'),
            '試されたトークンの値が監査に入っている');
    } finally {
        child.kill();
        await rm(audit, { force: true }).catch(() => {});
    }
});
/**
 * 並列に叩くための小道具。
 *
 * 🚨 **`fetch`（undici）で並列の総当たりを再現してはいけない。** 同一オリジンへの
 *    接続をプールして本数を絞るので、**攻撃を送れていないのに「縛れている」と
 *    読める**（Host 検証を fetch で測って偽陽性を出したのと同じ型）。
 *    `node:http` の Agent を明示して並列度を自分で決める。
 * ⚠️ keepAlive を使うのは移植性のため。持続攻撃で毎回新しいソケットを開くと
 *    Windows の ephemeral port を食い潰す。
 */
function makeHitter(port, parallel) {
    const agent = new HttpAgent({ keepAlive: true, maxSockets: parallel });
    const hit = (token, path = '/api/v0/state') => new Promise(res => {
        const r = httpRequest({
            host: '127.0.0.1', port, path, method: 'GET', agent,
            headers: token === null ? {} : { 'x-kjp-token': token },
        }, x => {
            let b = '';
            x.on('data', d => { b += d; });
            x.on('end', () => res({ code: x.statusCode, body: b }));
        });
        r.on('error', e => res({ code: 0, body: e.message }));
        r.end();
    });
    return { hit, close: () => agent.destroy() };
}

const sizeOrZero = async p => {
    const { stat } = await import('node:fs/promises');
    return stat(p).then(s => s.size, () => 0);
};

/**
 * 🚨 **8回目のレビュー（SERIOUS）: 401 の指数遅延はレートを縛っていなかった。**
 *
 * 遅延は「1本ずつを遅くする」だけで同時本数を制限しないので、
 * **攻撃側が並列度を上げるだけで元の速さに戻る。** 実測（このリポジトリ）:
 *   直列 8 本   : 1,556 ms（7回目のテストが見ていたのはこれだけ）
 *   並列 300 本 : 2,142 ms / 401 が 300 本 / **140 回/秒** / 監査 +46,092 B
 *   並列 1200 本: 2,474 ms / 401 が 1200 本 / **485 回/秒** / 監査 +184,893 B
 * 直列のテストは**この性質を1度も測っていなかった。**
 */
test('🔒 401 は並列でも縛られる（比較の本数と記録の増分に上限がある）', async () => {
    const audit = join(repo, '..', `auth-par-${Date.now()}.jsonl`);
    const s = await startAuthServer(['--require-auth', '--token', EXEC_TOKEN,
        '--audit-log', audit]);
    const { hit, close } = makeHitter(s.port, 320);
    try {
        // 正規のトークンで1回通す（= この値は「一度通った」ものになる）
        const seed = await hit(EXEC_TOKEN, '/api/v0/state?fresh=1');
        assert.equal(seed.code, 200, `正しいトークンが通らない: ${seed.body.slice(0, 200)}`);
        const before = JSON.parse(seed.body).stats;

        const N = 300;
        const t0 = Date.now();
        const rs = await Promise.all(
            Array.from({ length: N }, (_, i) => hit(`wrong-parallel-${i}`)));
        const ms = Date.now() - t0;
        const by = {};
        for (const r of rs) by[r.code] = (by[r.code] ?? 0) + 1;
        const compared = by[401] ?? 0;
        const shed = by[429] ?? 0;
        assert.equal(compared + shed, N, `401/429 以外が返った: ${JSON.stringify(by)}`);
        // 🔒 **比較された本数に上限がある**こと。門が無いと 300 本全部が 401 になる
        //    （= 並列度がそのまま当てる速さになる）。実測は 5 本 / 315 ms。
        assert.ok(compared <= 40,
            `並列 ${N} 本のうち ${compared} 本が比較された（${ms}ms, ${(compared / (ms / 1000)).toFixed(1)} 回/秒）。`
            + '遅延は並列を縛れない');
        assert.ok(shed >= 100, `429 で切られた本数が少なすぎる: ${shed}`);

        // 🔒 **記録の増幅を断つ**（認証前の要求で `.git` の中を伸ばせない）
        await new Promise(r => setTimeout(r, 300));
        const grew = await sizeOrZero(audit);
        assert.ok(grew <= 8 * 1024,
            `認証前の ${N} 本で監査ログが ${grew} B になった（基準: 修正前は 46,092 B）`);

        // 正規のトークンは攻撃の直後も通る（締め出していない）
        const after = await hit(EXEC_TOKEN, '/api/v0/state?fresh=1');
        assert.equal(after.code, 200, '攻撃の直後に正しいトークンが通らない');
        const st = JSON.parse(after.body).stats;
        // 🔒 **認証前の要求が git を起動しない**こと。冷えたデーモンでは
        //    401 の1本ごとに `git rev-parse --git-common-dir` が起動していた
        //    （実測で並列 200 本の最中に git.exe が 7 本同時）。
        //    この収集ぶんを引けば「その間に何回起動したか」が出る。
        const during = st.gitSpawnsTotal - st.gitSpawns - before.gitSpawnsTotal;
        assert.ok(during <= 2,
            `認証前の ${N} 本の間に git が ${during} 回起動した（1本ごとに起動している）`);
    } finally {
        close();
        s.child.kill();
        await rm(audit, { force: true }).catch(() => {});
    }
});

/**
 * 🚨 **実行トークンの壁にも同じ3点セットが要る（9回目のレビュー / #48。SERIOUS）。**
 *
 * 7回目・8回目で塞いだのは**読み取りの壁（401）だけ**だった。実行・書き込みの壁
 * （`gateMutation()` = 403）には遅延も記録も並列の門も無く、**痕跡ゼロで
 * 総当たり**できた。実測（同じ機械・同じ手順、`--audit-log` を外に置いて計測）:
 *   修正前: 並列 1200 本 = 479 ms / **403 が 1200 本**（= 2,505 回/秒 比較された）/ 監査 **0 B**
 *   修正後: 並列 1200 本 = 869 ms / 403 が **6 本** / 429 が 1194 本 / 監査 682 B
 *
 * 🚨 **効く相手が「読み取りの鍵を持っている人」であることが重要。** 入口の
 *    `authed()` は案内 URL に載る読み取り用の派生秘密でも通る。その値は
 *    スマホのブックマークや履歴に残って広く出回るので、**read から exec への
 *    昇格路**になっていた（capability の分界が壊れる）。
 *    だからこの検査は「読み取り鍵の Cookie を持った相手」として撃つ。
 */
test('🔒 実行トークンの総当たりが縛られ、痕跡が残る（read から exec への昇格）', async () => {
    const audit = join(repo, '..', `mut-brute-${Date.now()}.jsonl`);
    const s = await startAuthServer(['--require-auth', '--allow-exec',
        '--token', EXEC_TOKEN, '--audit-log', audit]);
    // 案内 URL に載る読み取り専用の派生秘密（生トークンではない）
    const readSecret = (s.banner().match(/\?token=([A-Za-z0-9_-]+)/) ?? [])[1];
    const agent = new HttpAgent({ keepAlive: true, maxSockets: 320 });
    const tryExec = token => new Promise(res => {
        const body = JSON.stringify({ worktree: repo, argv: ['git', '--version'] });
        const r = httpRequest({
            host: '127.0.0.1', port: s.port, path: '/api/v0/exec', method: 'POST', agent,
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
                'x-kjp-token': token,
                'sec-fetch-site': 'same-origin',
                cookie: `kjp_auth=${readSecret}`,
            },
        }, x => {
            let b = '';
            x.on('data', d => { b += d; });
            x.on('end', () => res({ code: x.statusCode, body: b }));
        });
        r.on('error', e => res({ code: 0, body: e.message }));
        r.end(body);
    });
    try {
        assert.ok(readSecret, `案内 URL の読み取り鍵が取れない: ${s.banner().slice(0, 300)}`);
        // 前提: 読み取り鍵だけで入口は通る（= 昇格の起点が実在する）
        const rd = await authGet(s.port, '/api/v0/state?fresh=1', { cookie: `kjp_auth=${readSecret}` });
        assert.equal(rd.code, 200, `読み取り鍵で入口が通らない（前提が崩れている）: ${rd.code}`);

        const N = 300;
        const t0 = Date.now();
        const rs = await Promise.all(Array.from({ length: N }, (_, i) => tryExec(`wrong-exec-${i}`)));
        const ms = Date.now() - t0;
        const by = {};
        for (const r of rs) by[r.code] = (by[r.code] ?? 0) + 1;
        const compared = by[403] ?? 0;
        const shed = by[429] ?? 0;
        assert.equal(compared + shed, N, `403/429 以外が返った: ${JSON.stringify(by)}`);
        // 🔒 **比較された本数に上限がある**こと（門が無いと N 本すべて比較される）
        assert.ok(compared <= 40,
            `並列 ${N} 本のうち ${compared} 本が比較された`
            + `（${ms}ms, ${(compared / (ms / 1000)).toFixed(1)} 回/秒）。修正前は全部が比較された`);
        assert.ok(shed >= 100, `429 で切られた本数が少なすぎる: ${shed}`);

        // 🔒 **痕跡が残る**こと（修正前は 0 B = 何も残らなかった）
        await new Promise(r => setTimeout(r, 400));
        const grew = await sizeOrZero(audit);
        assert.ok(grew > 0, '実行トークンを外しても監査に1行も残らない（痕跡ゼロで総当たりできる）');
        // 🔒 ただし増幅もしない（外からログを無制限に伸ばせない）
        assert.ok(grew <= 8 * 1024, `監査ログが ${grew} B に伸びた（集約が効いていない）`);
        const lines = (await readFile(audit, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
        const kinds = new Set(lines.map(r => r.event));
        assert.ok(kinds.has('mutation-token-failed') || kinds.has('mutation-token-failed-summary'),
            `実行トークンの失敗が記録されていない: ${JSON.stringify([...kinds])}`);
        // 🔒 **候補の値を残さない**（記録がトークン辞書になってはいけない）
        assert.equal(lines.some(r => JSON.stringify(r).includes('wrong-exec-')), false,
            '試された値が記録に残っている');

        // 🔒 正しい実行トークンは通る（縛った代わりに使えなくしていない）。
        //    ⚠️ 攻撃直後の初回は 429 になりうる（まだ「通った値」として覚えられて
        //       いないため。残る穴として docs に書いてある）。数回試して通ること。
        let ok = 0;
        for (let i = 0; i < 5 && ok === 0; i++) {
            const r = await tryExec(EXEC_TOKEN);
            if (r.code === 200) ok++;
            else await new Promise(res => setTimeout(res, 300));
        }
        assert.equal(ok, 1, '総当たりの直後に正しい実行トークンが通らない');
    } finally {
        agent.destroy();
        s.child.kill();
        await rm(audit, { force: true }).catch(() => {});
    }
});

/**
 * 🚨 **実行の壁でも「縛った代わりに実行できなくなった」を作らない（#48）。**
 *
 * これが読み取り側より重い理由: 総当たりが続いている間に**走っているコマンドを
 * 止められない**と、観測ツールとして最悪の状態になる（暴走している `claude` を
 * スマホから止めに行けない）。だから持続攻撃の最中に測る。
 *
 * ⚠️ 上の「総当たりが縛られる」検査だけでは足りなかった: あれは攻撃が**終わった後**に
 *    正規トークンを試すので、混雑の門が空いていて通ってしまう
 *    （変異 `mutation-known-good-bypass` が SURVIVED した）。
 */
test('🔒 実行トークンの総当たり中でも、正しい鍵で実行と停止ができる', async () => {
    const audit = join(repo, '..', `mut-sus-${Date.now()}.jsonl`);
    const s = await startAuthServer(['--require-auth', '--allow-exec',
        '--token', EXEC_TOKEN, '--audit-log', audit]);
    const readSecret = (s.banner().match(/\?token=([A-Za-z0-9_-]+)/) ?? [])[1];
    const PAR = 12;
    const agent = new HttpAgent({ keepAlive: true, maxSockets: PAR + 4 });
    const post = (token, path, bodyObj) => new Promise(res => {
        const body = JSON.stringify(bodyObj);
        const r = httpRequest({
            host: '127.0.0.1', port: s.port, path, method: 'POST', agent,
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
                'x-kjp-token': token,
                'sec-fetch-site': 'same-origin',
                cookie: `kjp_auth=${readSecret}`,
            },
        }, x => {
            let b = '';
            x.on('data', d => { b += d; });
            x.on('end', () => res({ code: x.statusCode, body: b }));
        });
        r.on('error', e => res({ code: 0, body: e.message }));
        r.end(body);
    });
    const runOnce = token => post(token, '/api/v0/exec', { worktree: repo, argv: ['git', '--version'] });
    try {
        assert.ok(readSecret, '案内 URL の読み取り鍵が取れない');
        // 実運用で言えば「スマホの画面に鍵を貼ってある」状態を作る
        assert.equal((await runOnce(EXEC_TOKEN)).code, 200, '最初の1回が通らない');

        const deadline = Date.now() + 2500;
        let sent = 0;
        const attack = {};
        const worker = async () => {
            while (Date.now() < deadline) {
                const r = await runOnce(`wrong-sustained-exec-${sent++}`);
                attack[r.code] = (attack[r.code] ?? 0) + 1;
            }
        };
        const legit = [];
        const legitLoop = async () => {
            while (Date.now() < deadline) {
                legit.push((await runOnce(EXEC_TOKEN)).code);
                await new Promise(r => setTimeout(r, 300));
            }
        };
        const t0 = Date.now();
        await Promise.all([...Array.from({ length: PAR }, worker), legitLoop()]);
        const ms = Date.now() - t0;

        // 🔒 正しい鍵は**全部**通る（1本でも 429 なら締め出している）
        assert.ok(legit.length >= 5, `正規の実行が少なすぎる: ${legit.length} 本`);
        assert.ok(legit.every(c => c === 200),
            `総当たりの最中に正しい鍵で実行できなかった: ${JSON.stringify(legit)}`);
        // 当てる速さは縛られたまま
        const compared = attack[403] ?? 0;
        const rate = compared / (ms / 1000);
        assert.ok(rate <= 20,
            `総当たりが ${rate.toFixed(1)} 回/秒（要求 ${sent} 本）。`
            + `修正前は 2,505 回/秒。${JSON.stringify(attack)}`);
    } finally {
        agent.destroy();
        s.child.kill();
        await rm(audit, { force: true }).catch(() => {});
    }
});

/**
 * 🚨 **縛った代わりに正規の利用者を締め出していないこと。**
 *
 * トンネル越しでは peer が全部 127.0.0.1 なので、peer だけでは攻撃と
 * 正規の利用者を区別できない。実測で門だけを入れたときは
 * **持続攻撃（並列50）の間、正規のトークンが 15 本中 0 本しか通らなかった。**
 * 区別できるのは「トークンを知っているか」だけなので、
 * 一度通った値そのものを提示した要求は混雑の門を通さない。
 */
test('🔒 総当たりが続いている間も正しい鍵は通り、記録も増幅しない', async () => {
    const audit = join(repo, '..', `auth-sus-${Date.now()}.jsonl`);
    const s = await startAuthServer(['--require-auth', '--token', EXEC_TOKEN,
        '--audit-log', audit]);
    const PAR = 12;
    const { hit, close } = makeHitter(s.port, PAR + 2);
    try {
        // 先に1回通しておく（実運用で言えば「母艦のブラウザで既に開いている」状態）
        assert.equal((await hit(EXEC_TOKEN)).code, 200, '最初の1回が通らない');

        const before = await sizeOrZero(audit);
        const deadline = Date.now() + 2500;
        let sent = 0;
        const attack = {};
        const worker = async () => {
            while (Date.now() < deadline) {
                const r = await hit(`wrong-sustained-${sent++}`);
                attack[r.code] = (attack[r.code] ?? 0) + 1;
            }
        };
        const legit = [];
        const legitLoop = async () => {
            while (Date.now() < deadline) {
                legit.push((await hit(EXEC_TOKEN)).code);
                await new Promise(r => setTimeout(r, 300));
            }
        };
        const t0 = Date.now();
        await Promise.all([...Array.from({ length: PAR }, worker), legitLoop()]);
        const ms = Date.now() - t0;

        // 🔒 正しい鍵は**全部**通る（1本でも 429 なら締め出している）
        assert.ok(legit.length >= 5, `正規の要求が少なすぎる: ${legit.length} 本`);
        assert.ok(legit.every(c => c === 200),
            `総当たりの最中に正しい鍵が弾かれた: ${JSON.stringify(legit)}`);
        // 当てる速さは縛られたまま（実測 1.8 回/秒。修正前は 485 回/秒）
        const compared = attack[401] ?? 0;
        const rate = compared / (ms / 1000);
        assert.ok(rate <= 20,
            `持続攻撃で ${rate.toFixed(1)} 回/秒 比較された（${compared} 本 / ${sent} 要求）`);
        // 🚨 **429 で記録を増幅させない。** 「N 件ごとに1行」にしていたときは
        //    7秒で 503 KB 伸びた（429 は毎秒1万本以上撃てる）。時間で縛る。
        await new Promise(r => setTimeout(r, 300));
        const grew = await sizeOrZero(audit) - before;
        assert.ok(grew <= 20 * 1024,
            `${sent} 本の 429 で監査ログが ${grew} B 伸びた（件数ごとに追記している）`);
    } finally {
        close();
        s.child.kill();
        await rm(audit, { force: true }).catch(() => {});
    }
});

/**
 * 🚨 **監査ログは上限で回転し、「捨てた」ことを残す。**
 *
 * 既定の置き場所は `.git` の中で、認証前の 401 も同じファイルに追記されるので、
 * 上限が無いと長く動かすだけで伸びる。回転は記録を捨てる操作なので、
 * 新しいファイルの先頭に何をどこへ回したかを残す（黙って消さない）。
 */
test('🔒 監査ログは上限で回転し、捨てたことを記録に残す', async () => {
    const audit = join(repo, '..', `auth-rot-${Date.now()}.jsonl`);
    const { writeFile: wf, readFile: rf } = await import('node:fs/promises');
    // 上限を超えた状態から始める（既に長く動いていたデーモンと同じ）
    const old = `${JSON.stringify({ at: 'old', event: 'start', filler: 'x'.repeat(400) })}\n`;
    await wf(audit, old.repeat(4), 'utf8');
    const s = await startAuthServer(['--require-auth', '--token', EXEC_TOKEN,
        '--audit-log', audit, '--audit-max-bytes', '1024']);
    try {
        assert.equal((await authGet(s.port, '/api/v0/state',
            { 'x-kjp-token': 'wrong-rotate' })).code, 401);
        // 追記は非同期なので、回転が現れるまで待つ（固定時間で待たない）
        let lines = [];
        for (let i = 0; i < 60; i++) {
            lines = (await rf(audit, 'utf8').catch(() => '')).split('\n')
                .filter(Boolean).map(l => JSON.parse(l));
            if (lines.some(e => e.event === 'audit-rotated')) break;
            await new Promise(r => setTimeout(r, 100));
        }
        const rot = lines.find(e => e.event === 'audit-rotated');
        assert.ok(rot, `回転していない: ${JSON.stringify(lines).slice(0, 300)}`);
        assert.equal(rot.keptAs, `${audit}.1`);
        assert.equal(rot.discardedPrevious, false, '初回なのに前の世代を捨てたと言っている');
        assert.ok(rot.bytes >= 1024, `回転前のサイズを残していない: ${rot.bytes}`);
        // 回した先に元の記録がある（消したのではなく回した）
        assert.ok((await rf(`${audit}.1`, 'utf8')).includes('"at":"old"'),
            '前の記録が .1 に残っていない');
        // 新しいファイルは小さく、上限を守っている
        assert.ok(await sizeOrZero(audit) <= 1024 + 400,
            '回転後のファイルが上限を超えている');
        assert.ok(lines.some(e => e.event === 'auth-failed'), '回転後に追記できていない');
    } finally {
        s.child.kill();
        await rm(audit, { force: true }).catch(() => {});
        await rm(`${audit}.1`, { force: true }).catch(() => {});
    }
});

test('🔒 コマンド行に載った実行トークンを read 権限で配らない', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kjp-mask-home-'));
    // 記録を仕込む（サーバは ~/.claude/projects を読むので HOME を差し替える）
    const projDir = join(home, '.claude', 'projects', 'proj');
    await mkdir(projDir, { recursive: true });
    const rec = JSON.stringify({
        type: 'assistant', timestamp: new Date().toISOString(), cwd: repo, sessionId: 'sx',
        message: { content: [{ type: 'tool_use', name: 'Bash',
            input: { command: `node v0/server.mjs --allow-exec --token ${EXEC_TOKEN}` } }] },
    });
    // 🚨 **値でしか落とせない形も入れる。** 形（--token X）だけを見ていると、
    //    トークンが裸で出る行（echo / パイプ / 変数展開の跡）が素通りする。
    //    ここが「サーバが自分の資格情報を渡す」ことの唯一の検査になる。
    const bare = JSON.stringify({
        type: 'assistant', timestamp: new Date().toISOString(), cwd: repo, sessionId: 'sx',
        message: { content: [{ type: 'tool_use', name: 'Bash',
            input: { command: `echo ${EXEC_TOKEN} | tee /dev/null` } }] },
    });
    await writeFile(join(projDir, 'sx.jsonl'), rec + '\n' + bare + '\n', 'utf8');

    const child = spawn(process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--allow-exec', '--token', EXEC_TOKEN,
            '--watch-agents', '--allow-transcript-text'],
        { shell: false, windowsHide: true,
            env: { ...process.env, ...isolatedConfig(), USERPROFILE: home, HOME: home } });
    child.stdout.setEncoding('utf8');
    try {
        const url = await new Promise((res, rej) => {
            const t2 = setTimeout(() => rej(new Error('起動しなかった')), 15000);
            let buf = '';
            child.stdout.on('data', d => {
                buf += d;
                const m = buf.match(/http:[/][/]127[.]0[.]0[.]1:\d+/);
                if (m) { clearTimeout(t2); res(m[0]); }
            });
            child.on('error', rej);
        });

        const r = await fetch(`${url}/api/v0/state?fresh=1`,
            { headers: { 'x-kjp-token': EXEC_TOKEN } });
        assert.equal(r.status, 200);
        const body = await r.text();
        // 🚨 本題: 実行トークンが payload に出ていないこと
        assert.ok(!body.includes(EXEC_TOKEN),
            'コマンド行から実行トークンが読める（read が RCE に昇格する）');
        // ただし観測はできている（記録を読んでいることの確認。読めていないと検査にならない）
        const st = JSON.parse(body);
        const withCmd = (st.agents ?? []).flatMap(a => a.recent ?? [])
            .filter(x => typeof x.command === 'string');
        assert.ok(withCmd.length >= 1,
            `コマンド行が1件も読めていない（検査になっていない）: ${JSON.stringify(st.agents)}`);
        assert.ok(withCmd.some(x => /マスクしました/.test(x.command)),
            `マスクの痕跡が無い: ${JSON.stringify(withCmd)}`);
        assert.ok(withCmd.some(x => x.commandMasked === true),
            '落としたことを payload で伝えていない');
    } finally {
        child.kill();
        await rm(home, { recursive: true, force: true }).catch(() => {});
    }
});
test('🚨 rename（R の3トークン）で後続のファイルがずれない', async () => {
    const stem = repo.split(/[\\/]/).pop();
    const wt = join(repo, '..', `${stem}-ren`);
    try {
        await g(['worktree', 'add', '-q', '-b', 'renamed', wt, 'main'], repo);
        // rename を1件 + その**後ろ**に普通の変更を2件作る
        // （ずれると後続の status とパスの対応が壊れる）
        // ⚠️ main にあるのは README.md だけ（shared.txt は agent 側で作られる）
        await g(['mv', 'README.md', 'renamed.md'], wt);
        await writeFile(join(wt, 'zz-added.txt'), 'added\n', 'utf8');
        await writeFile(join(wt, 'zz-second.txt'), 'second\n', 'utf8');
        await g(['add', '-A'], wt);
        await g(['commit', '-q', '-m', 'rename と後続の変更'], wt);

        const s2 = await state();
        const card = s2.worktrees.find(w => w.branch === 'renamed');
        assert.ok(card, `renamed の worktree が無い: ${s2.worktrees.map(w => w.branch)}`);
        const files = card.files ?? [];

        // R が1件だけ出て、新旧のパスが正しく入っていること
        const ren = files.filter(f => f.status === 'R');
        assert.equal(ren.length, 1, `rename が1件でない: ${JSON.stringify(files)}`);
        assert.equal(ren[0].path, 'renamed.md', `新しいパスが違う: ${JSON.stringify(ren[0])}`);
        assert.equal(ren[0].from, 'README.md', `元のパスが違う: ${JSON.stringify(ren[0])}`);

        // 🚨 **後続がずれていないこと。** ここが本題（3トークンを2つとして読むと
        //    以降の status とパスの対応が全部1つずれる）
        const added = files.find(f => f.path === 'zz-added.txt');
        assert.ok(added, `後続の追加ファイルが無い（ずれている）: ${JSON.stringify(files)}`);
        assert.equal(added.status, 'A', `追加の status が違う（ずれている）: ${added.status}`);
        const second = files.find(f => f.path === 'zz-second.txt');
        assert.ok(second, `後続の2件目が無い（ずれている）: ${JSON.stringify(files)}`);
        assert.equal(second.status, 'A', `2件目の status が違う（ずれている）: ${second.status}`);
        // 🚨 **件数も見る。** 3トークンを2つとして読むと、余分なエントリ
        //    （旧パスが status に化けたもの）が増えるか、対応が1つずれる
        assert.equal(files.length, 3,
            `エントリ数が合わない（ずれている）: ${JSON.stringify(files)}`);

        // status が1文字の既知の値だけであること（トークンがパスとして入っていない）
        for (const f of files) {
            assert.match(f.status, /^[ACDMRTUX]$/, `status が壊れている: ${JSON.stringify(f)}`);
            assert.ok(!f.path.includes(String.fromCharCode(0)), 'NUL が残っている');
        }
    } finally {
        await g(['worktree', 'remove', '--force', wt], repo).catch(() => {});
        await g(['branch', '-D', 'renamed'], repo).catch(() => {});
        await rm(wt, { recursive: true, force: true }).catch(() => {});
    }
});
test('🚨 diff がリポジトリ設定のコマンドを実行しない（textconv / ext-diff）', async () => {
    const marker = join(repo, 'textconv-ran.txt').replace(/[\\]/g, '/');
    const hook = join(repo, 'textconv.sh').replace(/[\\]/g, '/');
    const { existsSync } = await import('node:fs');
    const { chmod } = await import('node:fs/promises');
    try {
        // フックは sh スクリプト + 実行ビット（Linux では exec ビットが無いと起動しない）
        await writeFile(hook, '#!/bin/sh\nprintf ran >> "' + marker + '"\ncat "$1"\n', 'utf8');
        await chmod(hook, 0o755);
        // .gitattributes を **コミットする**（in-tree の属性が読まれる）
        await writeFile(join(repo, '.gitattributes'), 'shared.txt diff=evil\n', 'utf8');
        await g(['add', '-A'], repo);
        await g(['commit', '-q', '-m', 'chore: textconv のテスト用'], repo);
        await g(['config', 'diff.evil.textconv', hook], repo);
        await g(['config', 'diff.evil.command', hook], repo);

        // 読み取り専用の経路を叩く（--allow-write も --allow-exec も不要）
        const r = await fetch(`${baseUrl}/api/v0/diff?base=main&ref=agent-a&path=shared.txt`);
        assert.equal(r.status, 200, `diff が取れない: ${r.status}`);
        await r.json();
        await new Promise(x => setTimeout(x, 400));
        assert.equal(existsSync(marker), false,
            'textconv / ext-diff が実行された（読み取り経路から任意コード実行）');
    } finally {
        await g(['config', '--unset', 'diff.evil.textconv'], repo).catch(() => {});
        await g(['config', '--unset', 'diff.evil.command'], repo).catch(() => {});
        await rm(join(repo, '.gitattributes'), { force: true }).catch(() => {});
        await rm(hook, { force: true }).catch(() => {});
        await rm(marker, { force: true }).catch(() => {});
        await g(['add', '-A'], repo).catch(() => {});
        await g(['commit', '-q', '-m', 'chore: textconv のテスト後始末'], repo).catch(() => {});
    }
});
// 🚨 core.fsmonitor と同じクラスの穴。コミット済みの .gitattributes と
//    .git/config の merge driver で、/api/v0/state を1回叩くだけで
//    任意コマンドが走っていた（--allow-write 不要）。
test('🚨 衝突予測が custom merge driver を実行しない', async () => {
    const marker = join(repo, 'driver-ran.txt').replace(/\\/g, '/');
    const hook = join(repo, 'driver.sh').replace(/\\/g, '/');
    const stem = repo.split(/[\\/]/).pop();
    try {
        // フックは sh スクリプト + 実行ビット（Linux では exec ビットが無いと起動しない）
        await writeFile(hook, `#!/bin/sh\nprintf ran >> "${marker}"\nexit 1\n`, 'utf8');
        const { chmod } = await import('node:fs/promises');
        await chmod(hook, 0o755);
        // .gitattributes を **コミットする**（in-tree の属性が読まれる）
        await writeFile(join(repo, '.gitattributes'), 'shared.txt merge=evil\n', 'utf8');
        await g(['add', '-A'], repo);
        await g(['commit', '-q', '-m', 'chore: merge driver のテスト用'], repo);
        await g(['config', 'merge.evil.name', 'demo'], repo);
        await g(['config', 'merge.evil.driver', `${hook} %A %O %B`], repo);

        // agent-a と agent-b は shared.txt を別内容で持つので driver が呼ばれる状況
        const s = await state();
        await new Promise(r => setTimeout(r, 400));
        const { existsSync } = await import('node:fs');
        assert.equal(existsSync(marker), false,
            'merge driver が実行された（読み取り経路から任意コード実行）');
        // 無効化したことを利用者に伝えている
        assert.ok(s.errors.some(e => /merge driver/.test(e.message)),
            `driver を無効化した旨が errors に無い: ${JSON.stringify(s.errors)}`);
    } finally {
        await g(['config', '--unset', 'merge.evil.driver'], repo).catch(() => {});
        await g(['config', '--unset', 'merge.evil.name'], repo).catch(() => {});
        await rm(hook, { force: true });
        await rm(marker, { force: true });
        await rm(join(repo, '.gitattributes'), { force: true });
        await g(['add', '-A'], repo).catch(() => {});
        await g(['commit', '-q', '-m', 'chore: merge driver のテスト後片付け'], repo).catch(() => {});
        // 他のテストのために base を元に戻す（main が2コミット進んだ）
        await g(['worktree', 'prune'], repo).catch(() => {});
        void stem;
    }
});

test('衝突予測: 作業ツリーと ref に触らない', async () => {
    const stem = repo.split(/[\\/]/).pop();
    const before = await Promise.all([
        g(['status', '--porcelain'], repo),
        g(['rev-parse', 'agent-a', 'agent-b', 'main'], repo),
        g(['status', '--porcelain'], join(repo, '..', `${stem}-wt-a`)),
    ]);
    await state();   // 衝突予測を走らせる
    const after = await Promise.all([
        g(['status', '--porcelain'], repo),
        g(['rev-parse', 'agent-a', 'agent-b', 'main'], repo),
        g(['status', '--porcelain'], join(repo, '..', `${stem}-wt-a`)),
    ]);
    assert.deepEqual(after, before,
        'merge-tree が作業ツリーか ref を変えている（--write-tree は object だけを書くはず）');
});

test('localBranches はローカルブランチだけで、remote-tracking を含まない', async () => {
    const s = await state();
    assert.ok(Array.isArray(s.localBranches), 'localBranches が無い');
    // 日本語ブランチ名（スラッシュ入り）が入っている
    assert.ok(s.localBranches.includes('機能/新規'),
        `機能/新規 が無い: ${JSON.stringify(s.localBranches)}`);
    assert.ok(s.localBranches.includes('main'));
    // ⚠️ remote-tracking が混ざると checkout 候補に出て detached HEAD になる
    for (const r of s.localBranches) {
        assert.doesNotMatch(r, /^refs\//, `完全な refname が漏れている: ${r}`);
        assert.ok(!r.startsWith('origin/'), `remote-tracking が混ざっている: ${r}`);
    }
});

test('🔒 --allow-write なしでは checkout の経路が存在しない', async () => {
    const res = await fetch(`${baseUrl}/api/v0/checkout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ worktree: repo, ref: 'main' }),
    });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /--allow-write/);
});

test('🔒 --allow-write なしでは session がトークンを返さない', async () => {
    const res = await fetch(`${baseUrl}/api/v0/session`);
    const d = await res.json();
    assert.equal(d.allowWrite, false);
    assert.equal(d.token, null);
});

/**
 * 書き込み有効のサーバを立てる。呼び出し側が kill する。
 *
 * ⚠️ **トークンは `--token` で渡して固定する。** 以前は
 *    `/api/v0/session` を無認証で叩いて貰っていたが、その経路は塞いだ
 *    （Cookie を持つ相手が実行トークンを取り戻せる穴だった。4回目のレビュー）。
 */
const WRITE_TOKEN = 'smoke-write-token-0123456789abcdef';
async function startWritable(extra = [], env = {}) {
    const child = spawn(
        process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--allow-write', '--token', WRITE_TOKEN, ...extra],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig(), ...env } },
    );
    child.stdout.setEncoding('utf8');
    const url = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('起動しなかった')), 15000);
        let buf = '';
        child.stdout.on('data', d => {
            buf += d;
            const m = buf.match(/http:\/\/127\.0\.0\.1:\d+/);
            if (m) { clearTimeout(t); resolve(m[0]); }
        });
        child.on('error', reject);
    // 🚨 待ちが失敗したら子を殺す。子の stdio パイプが node --test を生かし続け、要約が出ないまま SIGKILL される（原因が消える）
    }).catch(e => { try { child.kill(); } catch { /* noop */ } throw e; });
    // トークン本体を提示して capability を確認する（Cookie では返らない）
    const s = await (await fetch(`${url}/api/v0/session`, {
        headers: { 'x-kjp-token': WRITE_TOKEN },
    })).json();
    assert.equal(s.token, WRITE_TOKEN, 'トークンを提示したのに返ってこない');
    return { child, url, session: s };
}

test('🔒 checkout の関門: token / method / Sec-Fetch-Site をそれぞれ要求する', async () => {
    const { child, url, session } = await startWritable();
    try {
        assert.equal(session.allowWrite, true);
        assert.ok(session.token && session.token.length >= 20, 'トークンが返っていない');
        const wtPath = (await (await fetch(`${url}/api/v0/state?fresh=1`)).json())
            .worktrees.find(w => w.branch === 'agent-b').path;
        const body = JSON.stringify({ worktree: wtPath, ref: 'main' });
        const H = session.tokenHeader;

        // トークン無し
        let r = await fetch(`${url}/api/v0/checkout`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body,
        });
        assert.equal(r.status, 403, 'トークン無しが通った');
        assert.match((await r.json()).error, /token/i);

        // トークンが違う
        r = await fetch(`${url}/api/v0/checkout`, {
            method: 'POST', headers: { 'content-type': 'application/json', [H]: 'wrong' }, body,
        });
        assert.equal(r.status, 403, '誤ったトークンが通った');

        // GET では副作用を起こさない
        r = await fetch(`${url}/api/v0/checkout`, { headers: { [H]: session.token } });
        assert.equal(r.status, 405, 'GET が通った');

        // 別サイト起点
        r = await fetch(`${url}/api/v0/checkout`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                [H]: session.token, 'sec-fetch-site': 'cross-site',
            },
            body,
        });
        assert.equal(r.status, 403, 'cross-site が通った');

        // Host が攻撃者ドメイン（入口の検証が書き込み経路にも効く）
        r = await rawGet(`${url}/api/v0/checkout`, { host: 'evil.example' });
        assert.equal(r.status, 403);
    } finally {
        child.kill();
    }
});

test('🔒 checkout は既知の worktree 以外を cwd にしない', async () => {
    const { child, url, session } = await startWritable();
    try {
        for (const bad of [tmpdir(), `${repo}-not-a-worktree`, '']) {
            const r = await fetch(`${url}/api/v0/checkout`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', [session.tokenHeader]: session.token },
                body: JSON.stringify({ worktree: bad, ref: 'main' }),
            });
            assert.equal(r.status, 400, `既知でない worktree が通った: ${bad}`);
            assert.match((await r.json()).error, /既知の worktree ではありません/);
        }
    } finally {
        child.kill();
    }
});

test('checkout が実際にブランチを切り替える', async () => {
    const { child, url, session } = await startWritable();
    try {
        // ⚠️ このフィクスチャの worktree は agent-a / agent-b の2本だけ。
        //    agent-c はスクリーンショット用の別フィクスチャにしか無い。
        const wt = (await (await fetch(`${url}/api/v0/state?fresh=1`)).json())
            .worktrees.find(w => w.branch === 'agent-b');
        const post = ref => fetch(`${url}/api/v0/checkout`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [session.tokenHeader]: session.token },
            body: JSON.stringify({ worktree: wt.path, ref }),
        });
        // ⚠️ レスポンスボディは1回しか読めない。assert のメッセージの中で
        //    await r.json() を書くとテンプレートリテラルが先に評価されて body を
        //    消費し、後続の r.json() が "Body is unusable" で落ちる（実際に踏んだ）。
        // E7 日本語ブランチ名へ切り替える
        let r = await post('機能/新規');
        let d = await r.json();
        assert.equal(r.status, 200, `切り替え失敗: ${JSON.stringify(d)}`);
        assert.equal(d.branch, '機能/新規');
        // payload にも反映されている（キャッシュを捨てていること）
        const s2 = await (await fetch(`${url}/api/v0/state?fresh=1`)).json();
        assert.equal(s2.worktrees.find(w => w.path === wt.path).branch, '機能/新規');
        // 戻す
        r = await post('agent-b');
        d = await r.json();
        assert.equal(r.status, 200, `戻せなかった: ${JSON.stringify(d)}`);
        assert.equal(d.branch, 'agent-b');
    } finally {
        child.kill();
    }
});

/**
 * 🔒 **取り込み（merge）は「衝突しないと分かっているもの」だけ実行する。**
 *
 * このツールが唯一持っている衝突予測と順序提案が**提案だけで実行できなかった**
 * ので足した経路。任意コード実行を増やさないために、
 * 衝突予測が clean でないもの・カスタム merge driver があるリポジトリ・
 * dirty な作業ツリー・シーケンサ停止中は**すべて拒否**する。
 */
test('🔒 merge: --allow-write なしでは経路が存在しない', async () => {
    const r = await fetch(`${baseUrl}/api/v0/merge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ worktree: repo, branch: 'agent-a' }),
    });
    assert.equal(r.status, 403, '--allow-write なしで取り込めてしまう');
});

test('🔒 merge: 衝突しないものは取り込め、衝突するものは拒否する', async () => {
    const { child, url } = await startWritable();
    const token = WRITE_TOKEN;
    const stem = repo.split(/[\\/]/).pop();
    const base = join(repo, '..', `${stem}-mg-base`);
    const ok = join(repo, '..', `${stem}-mg-ok`);
    const bad = join(repo, '..', `${stem}-mg-bad`);
    const post = (worktree, branch) => fetch(`${url}/api/v0/merge`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-kjp-token': token,
            'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify({ worktree, branch }),
    });
    try {
        // 取り込み先（base）と、衝突しない枝（ok）と、衝突する枝（bad）を作る
        await g(['worktree', 'add', '-q', '-b', 'mg-base', base, 'main'], repo);
        await g(['worktree', 'add', '-q', '-b', 'mg-ok', ok, 'main'], repo);
        await writeFile(join(ok, 'only-in-ok.txt'), 'ok side\n', 'utf8');
        await g(['add', '-A'], ok);
        await g(['commit', '-q', '-m', '衝突しない追加'], ok);

        await g(['worktree', 'add', '-q', '-b', 'mg-bad', bad, 'main'], repo);
        await writeFile(join(bad, 'clash.txt'), 'from bad\n', 'utf8');
        await g(['add', '-A'], bad);
        await g(['commit', '-q', '-m', 'bad 側の clash'], bad);
        // base 側にも同じパスを別内容で入れる（= 衝突する）
        await writeFile(join(base, 'clash.txt'), 'from base\n', 'utf8');
        await g(['add', '-A'], base);
        await g(['commit', '-q', '-m', 'base 側の clash'], base);

        // (1) 衝突しないものは取り込める
        const r1 = await post(base, 'mg-ok');
        const b1 = await r1.json();
        assert.equal(r1.status, 200, `衝突しない取り込みが失敗した: ${JSON.stringify(b1)}`);
        assert.equal(b1.conflicted, false, '衝突状態になっている');
        // 実際に入っていること（数え直す）
        const files = await g(['ls-tree', '--name-only', 'HEAD'], base);
        assert.match(files, /only-in-ok\.txt/, '取り込んだと言ったのに入っていない');

        // (2) 衝突するものは拒否し、**作業ツリーを衝突状態にしない**
        const r2 = await post(base, 'mg-bad');
        const b2 = await r2.json();
        assert.equal(r2.status, 409, `衝突する取り込みが通ってしまった: ${JSON.stringify(b2)}`);
        assert.match(b2.error, /衝突/);
        // MERGE_HEAD が残っていないこと（拒否したのに半端な状態にしていない）
        const st = await g(['status', '--porcelain=v2', '--branch'], base);
        assert.ok(!st.includes('U '), `未マージのエントリが残っている: ${st}`);
        const { existsSync } = await import('node:fs');
        assert.equal(existsSync(join(base, '.git')), true);

        // (3) 自分自身は拒否
        const r3 = await post(base, 'mg-base');
        assert.equal(r3.status, 400, '自分自身を取り込めてしまう');

        // (4) 知らない ref は拒否
        assert.equal((await post(base, 'no-such-branch')).status, 400);
        // 🚨 **実際に危険な ref を作って測る。** `git update-ref refs/heads/--force` は
        //    作れてしまい、refMap に載るので `resolveRef` は通す。
        //    `isSafeRef` が無いと argv でオプションとして解釈されうる。
        //    ⚠️ 素の `--force` を投げるだけでは `resolveRef` でも 400 になるので、
        //    **検査が isSafeRef を測れていなかった**（変異が SURVIVED した）。
        //    **理由まで見る**ことで区別する。
        await g(['update-ref', 'refs/heads/--force', 'HEAD'], repo);
        const rBad = await post(base, '--force');
        assert.equal(rBad.status, 400, '不正な ref が通った');
        assert.match((await rBad.json()).error, /ref が不正です/,
            'isSafeRef ではなく別の理由で断っている（守りを測れていない）');

        // (5) dirty な作業ツリーは拒否（未コミットの変更を巻き込まない）
        await writeFile(join(base, 'dirty.txt'), 'x\n', 'utf8');
        await g(['add', '-A'], base);
        const r5 = await post(base, 'mg-ok');
        assert.equal(r5.status, 409, 'dirty なのに取り込んだ');
        assert.match((await r5.json()).error, /未コミット/);
    } finally {
        child.kill();
        await g(['update-ref', '-d', 'refs/heads/--force'], repo).catch(() => {});
        for (const [wt, br] of [[base, 'mg-base'], [ok, 'mg-ok'], [bad, 'mg-bad']]) {
            await g(['worktree', 'remove', '--force', wt], repo).catch(() => {});
            await g(['branch', '-D', br], repo).catch(() => {});
            await rm(wt, { recursive: true, force: true }).catch(() => {});
        }
    }
});

/**
 * 🚨 **8回目のレビュー（SERIOUS）: merge が途中で失敗すると MERGE_HEAD と
 *    staged 変更を残したまま「git が取り込みを拒否しました」と返していた。**
 *
 * 約束は「衝突すると予測されたものは実行しない = 作業ツリーを衝突状態にしない」で、
 * 成功経路は `conflicted` を数え直しているのに、**失敗経路は1度も数え直さなかった。**
 * `git merge` は作業ツリーと index を書いた**後**に失敗しうるので「拒否しました」は嘘。
 * 残るのは他のエージェントの worktree の MERGE_HEAD なので、そのエージェントが
 * 次に commit すると気付かないまま merge コミットになる。
 *
 * ⚠️ 決定的に失敗させる方法: `GIT_AUTHOR_DATE` を不正な値にする。
 *    git は**マージして作業ツリーと index を書いた後**、commit を作る段で
 *    `fatal: invalid date format` で落ちる（実測: MERGE_HEAD あり /
 *    `1 A. … b.txt` が staged）。identity を消す方法は commit の**手前**で
 *    落ちるので（実測で MERGE_HEAD 無し）この形を測れない。
 */
test('🚨 merge が途中で失敗したら「半端な状態が残った」と言う', async () => {
    const stem = repo.split(/[\\/]/).pop();
    const base = join(repo, '..', `${stem}-mf-base`);
    const src = join(repo, '..', `${stem}-mf-src`);
    // ⚠️ サーバ側の git にだけ効かせる（テスト自身の g() は自前で identity を渡す）
    // ⚠️ `--state-ttl` で「キャッシュを捨てたか」を決定的に測る。既定の 1500ms だと
    //    merge に掛かる時間と競争になり、遅い環境では守りを外しても緑になる。
    const { child, url } = await startWritable(['--state-ttl', '60000'],
        { GIT_AUTHOR_DATE: 'kjp-not-a-date' });
    const { existsSync } = await import('node:fs');
    try {
        await g(['worktree', 'add', '-q', '-b', 'mf-base', base, 'main'], repo);
        await g(['worktree', 'add', '-q', '-b', 'mf-src', src, 'main'], repo);
        // src 側に「衝突しない追加」（= 予測は clean になる）
        await writeFile(join(src, 'mf-src-only.txt'), 'src\n', 'utf8');
        await g(['add', '-A'], src);
        await g(['commit', '-q', '-m', 'feat: src 側の追加'], src);
        // base 側も1つ進めて fast-forward にしない（merge コミットを作らせる）
        await writeFile(join(base, 'mf-base-only.txt'), 'base\n', 'utf8');
        await g(['add', '-A'], base);
        await g(['commit', '-q', '-m', 'feat: base 側の追加'], base);

        // 🚨 **キャッシュが有る状態から始める。** 何も読んでいないと、
        //    失敗後の読み取りは（キャッシュを捨てていなくても）collect し直すので、
        //    「捨てている」を測れない（変異が SURVIVED した）。
        const plain = async () => (await (await fetch(`${url}/api/v0/state`)).json());
        const before = await plain();
        const t0 = Date.now();
        const r = await fetch(`${url}/api/v0/merge`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-kjp-token': WRITE_TOKEN,
                'sec-fetch-site': 'same-origin',
            },
            body: JSON.stringify({ worktree: base, branch: 'mf-src' }),
        });
        const b = await r.json();
        assert.equal(r.status, 409, `失敗しなかった: ${JSON.stringify(b)}`);
        // 実体はどうなっているか（テスト側で数え直す）
        const mergeHead = existsSync(join(base, '.git'))
            ? (await g(['rev-parse', '--verify', '-q', 'MERGE_HEAD'], base)
                .then(() => true, () => false))
            : false;
        const st = await g(['status', '--porcelain=v2'], base);
        assert.equal(mergeHead, true,
            `この検査の前提が崩れた（MERGE_HEAD が残らない失敗になっている）: ${st}`);

        // 🚨 **応答が実体と一致していること。** 「拒否しました」と言ってはいけない
        assert.ok(b.leftover, `半端な状態を数え直していない: ${JSON.stringify(b)}`);
        assert.equal(b.leftover.counted, true, '数え直せなかったのか、と読めてしまう');
        assert.equal(b.leftover.merging, true,
            `MERGE_HEAD が残っているのにそう言っていない: ${JSON.stringify(b.leftover)}`);
        assert.equal(b.leftover.dirty, true);
        assert.ok(b.leftover.changed > 0,
            `staged 変更が残っているのに 0 と言っている: ${JSON.stringify(b.leftover)}`);
        assert.match(b.error, /半端な状態/,
            `「拒否しました」で済ませている（作業ツリーは半端なのに）: ${b.error}`);
        assert.ok(!/拒否しました/.test(b.error), `嘘の文言が残っている: ${b.error}`);

        // 🚨 **キャッシュを捨てていること。** 素の /api/v0/state（?fresh=1 なし）が
        //    merging を返す = 失敗経路で cached を捨てている
        const s = await plain();
        const elapsed = Date.now() - t0;
        // ⚠️ TTL を超えていたら、キャッシュは自然に切れているので
        //    「捨てたから新しい」を測れない。**測れなかったことを緑にしない。**
        assert.ok(elapsed < 60000,
            `キャッシュの判定を測れなかった（merge に ${elapsed}ms かかり TTL を超えた）`);
        assert.notEqual(s.generatedAt, before.generatedAt,
            'キャッシュをそのまま返している（画面は clean のままになる）');
        const w = s.worktrees.find(x => x.branch === 'mf-base');
        assert.ok(w, `worktree が見えない: ${s.worktrees.map(x => x.branch).join(',')}`);
        assert.equal(w.sequencer.merging, true,
            'キャッシュが古いままなので、画面は clean のままになる');
    } finally {
        child.kill();
        await g(['merge', '--abort'], base).catch(() => {});
        for (const [wt, br] of [[base, 'mf-base'], [src, 'mf-src']]) {
            await g(['worktree', 'remove', '--force', wt], repo).catch(() => {});
            await g(['branch', '-D', br], repo).catch(() => {});
            await rm(wt, { recursive: true, force: true }).catch(() => {});
        }
        await g(['worktree', 'prune'], repo).catch(() => {});
    }
});

/**
 * 🚨 **merge が hooks を実行しないこと。**
 *
 * `git merge` は `post-merge` / `prepare-commit-msg` / `commit-msg` を走らせる。
 * これらは**リポジトリ設定のコード**なので、HTTP から起動できる状態にすると
 * 「書き込みの capability」で任意コード実行になる（merge driver と同じクラス）。
 * `core.hooksPath` を空のディレクトリに向けて通さない。
 */
test('🚨 merge が hooks を実行しない（リポジトリ設定のコードを走らせない）', async () => {
    const { child, url } = await startWritable();
    const token = WRITE_TOKEN;
    const stem = repo.split(/[\\/]/).pop();
    const base = join(repo, '..', `${stem}-hk-base`);
    const src = join(repo, '..', `${stem}-hk-src`);
    const marker = join(repo, '..', `hook-ran-${Date.now()}.txt`).replace(/[\\]/g, '/');
    const { existsSync } = await import('node:fs');
    const { chmod } = await import('node:fs/promises');
    try {
        await g(['worktree', 'add', '-q', '-b', 'hk-base', base, 'main'], repo);
        await g(['worktree', 'add', '-q', '-b', 'hk-src', src, 'main'], repo);
        await writeFile(join(src, 'hk.txt'), 'src\n', 'utf8');
        await g(['add', '-A'], src);
        await g(['commit', '-q', '-m', 'hooks の検査用'], src);

        // post-merge フックを仕込む（sh + 実行ビット。Linux では exec ビットが要る）
        // ⚠️ `--git-path` は**絶対パスを返すことがある**（linked worktree では
        //    共通の .git/hooks を指す）。join すると二重になる（実際に踏んだ）
        const hooksDir = (await g(['rev-parse', '--git-path', 'hooks'], base)).trim();
        // ⚠️ 正規表現にスラッシュを持ち込まない（規則8）。文字で判定する
        const isAbs = hooksDir.startsWith('/') || /^[A-Za-z]:/.test(hooksDir);
        const hookPath = isAbs ? hooksDir : join(base, hooksDir);
        const { mkdir } = await import('node:fs/promises');
        await mkdir(hookPath, { recursive: true }).catch(() => {});
        const hook = join(hookPath, 'post-merge');
        await writeFile(hook, '#!/bin/sh\nprintf ran >> "' + marker + '"\n', 'utf8');
        await chmod(hook, 0o755);

        const r = await fetch(`${url}/api/v0/merge`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-kjp-token': token,
                'sec-fetch-site': 'same-origin',
            },
            body: JSON.stringify({ worktree: base, branch: 'hk-src' }),
        });
        assert.equal(r.status, 200, `取り込めない: ${JSON.stringify(await r.json())}`);
        await new Promise(x => setTimeout(x, 400));
        assert.equal(existsSync(marker), false,
            'post-merge フックが実行された（書き込みの capability で任意コード実行）');
    } finally {
        child.kill();
        for (const [wt, br] of [[base, 'hk-base'], [src, 'hk-src']]) {
            await g(['worktree', 'remove', '--force', wt], repo).catch(() => {});
            await g(['branch', '-D', br], repo).catch(() => {});
            await rm(wt, { recursive: true, force: true }).catch(() => {});
        }
        await rm(marker, { force: true }).catch(() => {});
    }
});
test('🔒 merge: カスタム merge driver があるリポジトリでは実行しない', async () => {
    const { child, url } = await startWritable();
    const token = WRITE_TOKEN;
    const stem = repo.split(/[\\/]/).pop();
    const wt = join(repo, '..', `${stem}-mgd`);
    try {
        await g(['worktree', 'add', '-q', '-b', 'mgd', wt, 'main'], repo);
        await g(['config', 'merge.evil.name', 'demo'], repo);
        await g(['config', 'merge.evil.driver', 'false %A %O %B'], repo);
        const r = await fetch(`${url}/api/v0/merge`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-kjp-token': token,
                'sec-fetch-site': 'same-origin',
            },
            body: JSON.stringify({ worktree: wt, branch: 'agent-a' }),
        });
        assert.equal(r.status, 409, 'driver があるのに取り込んだ（任意コマンドが走る）');
        assert.match((await r.json()).error, /merge driver/);
    } finally {
        child.kill();
        await g(['config', '--unset', 'merge.evil.driver'], repo).catch(() => {});
        await g(['config', '--unset', 'merge.evil.name'], repo).catch(() => {});
        await g(['worktree', 'remove', '--force', wt], repo).catch(() => {});
        await g(['branch', '-D', 'mgd'], repo).catch(() => {});
        await rm(wt, { recursive: true, force: true }).catch(() => {});
    }
});
/**
 * 🔒 **merge も filter を断る（8回目のレビュー）。**
 *
 * 読み取り経路では filter を `cat` に潰して読むが、**取り込みでは潰せない** —
 * smudge を潰したまま merge すると作業ツリーに書かれる中身が変わる
 * （git-lfs ならポインタで実体を上書きする）。driver と同じ「断る」に倒す。
 */
test('🔒 merge: リポジトリ設定の filter があるときは実行しない', async () => {
    const { child, url } = await startWritable();
    const stem = repo.split(sep).pop();
    const wt = join(repo, '..', `${stem}-mgf`);
    try {
        await g(['worktree', 'add', '-q', '-b', 'mgf', wt, 'main'], repo);
        await g(['config', 'filter.evil.clean', 'false'], repo);
        const r = await fetch(`${url}/api/v0/merge`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-kjp-token': WRITE_TOKEN,
                'sec-fetch-site': 'same-origin',
            },
            body: JSON.stringify({ worktree: wt, branch: 'agent-a' }),
        });
        assert.equal(r.status, 409, 'filter があるのに取り込んだ（任意コマンドが走る）');
        assert.match((await r.json()).error, /filter/);
    } finally {
        child.kill();
        await g(['config', '--unset', 'filter.evil.clean'], repo).catch(() => {});
        await g(['worktree', 'remove', '--force', wt], repo).catch(() => {});
        await g(['branch', '-D', 'mgf'], repo).catch(() => {});
        await rm(wt, { recursive: true, force: true }).catch(() => {});
    }
});
/**
 * 🔒 **merge がリポジトリ設定の署名プログラムを起動しない（8回目のレビュー）。**
 *
 * hooks と merge driver は潰していたのに、`commit.gpgsign=true` +
 * `gpg.program=<任意>` は同じ `.git/config` に書けるので**書き込みの capability で
 * 任意プログラム実行**になっていた（実測: 409 を返しながら marker が書かれた）。
 */
test('🔒 merge が commit.gpgsign / gpg.program を起動しない', async () => {
    const { child, url } = await startWritable();
    const stem = repo.split(sep).pop();
    const wt = join(repo, '..', `${stem}-mgg`);
    const marker = join(repo, 'gpg-ran.txt').split(sep).join('/');
    const fake = join(repo, 'fakegpg.sh').split(sep).join('/');
    try {
        await writeFile(fake, `#!/bin/sh
printf ran > "${marker}"
exit 1
`, 'utf8');
        const { chmod } = await import('node:fs/promises');
        await chmod(fake, 0o755);
        await g(['worktree', 'add', '-q', '-b', 'mgg', wt, 'main'], repo);
        // 衝突しない枝を用意する（成功経路で署名が走ることを見たい）
        await writeFile(join(wt, 'mgg-only.txt'), `x${'\n'}`, 'utf8');
        await g(['add', '-A'], wt);
        await g(['commit', '-q', '-m', 'mgg 側'], wt);
        await g(['config', 'commit.gpgsign', 'true'], repo);
        await g(['config', 'gpg.program', fake], repo);
        const r = await fetch(`${url}/api/v0/merge`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-kjp-token': WRITE_TOKEN,
                'sec-fetch-site': 'same-origin',
            },
            body: JSON.stringify({ worktree: wt, branch: 'agent-a' }),
        });
        // 🚨 **前提条件そのものを検証する。** 取り込みが門で断られていると
        //    署名の段まで到達せず、**守りを外しても marker が書かれない**ので
        //    テストが緑になる（実際に変異が SURVIVED した）。
        //    200 = 実際にマージコミットを作った = 署名が走りうる状態だったこと。
        const body = await r.json();
        assert.equal(r.status, 200,
            `取り込みが成立していないので署名の経路を測れていない: ${JSON.stringify(body)}`);
        const { existsSync } = await import('node:fs');
        assert.equal(existsSync(join(repo, 'gpg-ran.txt')), false,
            'gpg.program が起動した（書き込みの capability で任意プログラム実行）');
    } finally {
        child.kill();
        await g(['config', '--unset', 'commit.gpgsign'], repo).catch(() => {});
        await g(['config', '--unset', 'gpg.program'], repo).catch(() => {});
        await g(['worktree', 'remove', '--force', wt], repo).catch(() => {});
        await g(['branch', '-D', 'mgg'], repo).catch(() => {});
        await rm(wt, { recursive: true, force: true }).catch(() => {});
        await rm(join(repo, 'gpg-ran.txt'), { force: true }).catch(() => {});
        await rm(join(repo, 'fakegpg.sh'), { force: true }).catch(() => {});
    }
});
test('🚨 checkout はシーケンサ停止中を拒否する（git は通してしまう操作）', async () => {
    const { child, url, session } = await startWritable();
    const stem = repo.split(/[\\/]/).pop();
    const wt = join(repo, '..', `${stem}-wt-a`);
    try {
        // ⚠️ setup に `rebase -i` + GIT_SEQUENCE_EDITOR を使わないこと。
        //    エディタと todo の書き換えに依存するので CI で停止しないことがあり、
        //    「ガードが効かなかった」と「setup が失敗した」の区別が付かなくなる
        //    （実際に windows CI だけで落ちた）。
        //    衝突するマージなら外部エディタを介さず決定的に MERGE_HEAD が残る。
        //    agent-a と agent-b は shared.txt を別内容で追加しているので add/add 衝突になる。
        await g(['merge', 'agent-b'], wt).catch(() => {});   // 衝突するので非0 で正常

        // 前提条件そのものを検証する。これが無いと assert が何を見たのか分からない。
        const st = await (await fetch(`${url}/api/v0/state?fresh=1`)).json();
        const target = st.worktrees.find(w => w.path.endsWith('-wt-a'));
        assert.ok(target, 'agent-a の worktree が payload に無い');
        assert.equal(target.sequencer.merging, true,
            'setup 失敗: MERGE_HEAD が残っていない。テストの前提が成立していない');

        const r = await fetch(`${url}/api/v0/checkout`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [session.tokenHeader]: session.token },
            body: JSON.stringify({ worktree: wt, ref: 'main' }),
        });
        const d = await r.json();
        assert.equal(r.status, 409, `マージ未コミット中の checkout が通ってしまった: ${JSON.stringify(d)}`);
        assert.match(d.error, /マージ未コミット/);
        assert.match(d.error, /MERGE_HEAD/, '危険の説明が入っていない');
    } finally {
        child.kill();
        await g(['merge', '--abort'], wt).catch(() => {});
        await g(['checkout', '-q', '--force', 'agent-a'], wt).catch(() => {});
    }
});

// ---------------------------------------------------------------------------
// 🔒 最小エディタ（/api/v0/file と /api/v0/write）。
//    **v0 で初めて「作業ツリーにファイルの中身を書く」経路**なので、
//    門（capability / token / method / Sec-Fetch-Site / Host / パスの形 /
//    既知の worktree / 追跡下 / 実体 / 楽観ロック）を全部固定する。
//    ⚠️ 門を外したときにここが落ちることは scripts/mutate.mjs が確かめている
//       （落ちない検査は無意味）。
// ---------------------------------------------------------------------------

/**
 * 編集の検査用に、使い捨ての worktree を1本作る。
 *
 * ⚠️ **必ず finally で消す。** 既存のテストは worktree の本数（3本）と
 *    衝突予測のペアを assert しているので、残すと**別のテストが落ちる**。
 * @param {object} files `{ tracked: {path: 中身}, untracked: {path: 中身} }`
 */
async function withEditWorktree(name, files, fn) {
    const stem = repo.split(/[\\/]/).pop();
    const dir = join(repo, '..', `${stem}-${name}`);
    const branch = `ed-${name}`;
    try {
        await g(['worktree', 'add', '-q', '-b', branch, dir, 'main'], repo);
        for (const [p, body] of Object.entries(files.tracked ?? {})) {
            const full = join(dir, p);
            await mkdir(dirname(full), { recursive: true });
            await writeFile(full, body);
        }
        await g(['add', '-A'], dir);
        await g(['commit', '-q', '-m', `検査用: ${name}`], dir);
        // 🚨 未追跡のファイルは**コミットの後**に置く（add -A で追跡させない）
        for (const [p, body] of Object.entries(files.untracked ?? {})) {
            const full = join(dir, p);
            await mkdir(dirname(full), { recursive: true });
            await writeFile(full, body);
        }
        await fn(dir);
    } finally {
        await g(['worktree', 'remove', '--force', dir], repo).catch(() => {});
        await g(['branch', '-D', branch], repo).catch(() => {});
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

/** 編集経路への POST（トークンつき） */
function editPost(url, route, payload, headers = {}) {
    return fetch(`${url}${route}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-kjp-token': WRITE_TOKEN,
            'sec-fetch-site': 'same-origin',
            ...headers,
        },
        body: JSON.stringify(payload),
    });
}

test('🔒 write: --allow-write なしでは経路が存在しない', async () => {
    // 読む側（/api/v0/file）も write の capability の中に置いている。
    // 作業ツリーを fs で読む唯一の経路なので、読み取り専用のデーモンには存在しない。
    for (const route of ['/api/v0/file', '/api/v0/write']) {
        const r = await fetch(`${baseUrl}${route}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ worktree: repo, path: 'README.md', text: 'x\n' }),
        });
        assert.equal(r.status, 403, `${route} が --allow-write なしで通った`);
        assert.match((await r.json()).error, /--allow-write/);
    }
    // 書き込みが無効なら中身も変わっていない（数え直す）
    assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), '# smoke\n');
});

test('🔒 write: 関門（token / method / Sec-Fetch-Site / Host）を要求する', async () => {
    const { child, url } = await startWritable();
    try {
        await withEditWorktree('gate', { tracked: { 'edit.txt': 'a\nb\n' } }, async dir => {
            const body = JSON.stringify({
                worktree: dir, path: 'edit.txt', text: 'hacked\n',
                baseOid: '0000000000000000000000000000000000000000',
            });
            // トークン無し
            let r = await fetch(`${url}/api/v0/write`, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body,
            });
            assert.equal(r.status, 403, 'トークン無しが通った');
            assert.match((await r.json()).error, /token/i);
            // トークンが違う
            r = await fetch(`${url}/api/v0/write`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-kjp-token': 'wrong' },
                body,
            });
            assert.equal(r.status, 403, '誤ったトークンが通った');
            // GET では副作用を起こさない
            r = await fetch(`${url}/api/v0/write`, { headers: { 'x-kjp-token': WRITE_TOKEN } });
            assert.equal(r.status, 405, 'GET が通った');
            // 別サイト起点
            r = await fetch(`${url}/api/v0/write`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-kjp-token': WRITE_TOKEN, 'sec-fetch-site': 'cross-site',
                },
                body,
            });
            assert.equal(r.status, 403, 'cross-site が通った');
            // Host が攻撃者ドメイン（入口の検証が編集経路にも効く）
            // ⚠️ Host の検証は fetch では書けない（undici が上書きを許さない）ので
            //    node:http の request を使う。GET でも入口の 403 は測れる。
            r = await rawGet(`${url}/api/v0/write`, { host: 'evil.example' });
            assert.equal(r.status, 403, 'evil.example が通った');
            // 読む側（/api/v0/file）も同じ門を通る
            const rf = await fetch(`${url}/api/v0/file`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ worktree: dir, path: 'edit.txt' }),
            });
            assert.equal(rf.status, 403, '/api/v0/file がトークン無しで読めた');
            // どれも中身を変えていない
            assert.equal(await readFile(join(dir, 'edit.txt'), 'utf8'), 'a\nb\n');
        });
    } finally {
        child.kill();
    }
});

test('🚨 write: 門の順序（認可が追跡チェックより前）', async () => {
    // 🚨 **順序そのものが守り。** 認可を後ろに回すと、認可を持たない相手が
    //    エラーメッセージの違いから「そのパスが追跡されているか」を引き出せる
    //    （`--allow-exec` の門が自動生成より後ろにあって消えていたのと同じ型）。
    //    未追跡のパスを**トークン無しで**投げて、返るのが 403（認可）であって
    //    400（追跡されていない）でないことを見る。
    const { child, url } = await startWritable();
    try {
        await withEditWorktree('order', {
            tracked: { 'edit.txt': 'a\n' },
            untracked: { '.env': 'SECRET=1\n' },
        }, async dir => {
            for (const route of ['/api/v0/file', '/api/v0/write']) {
                const r = await fetch(`${url}${route}`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        worktree: dir, path: '.env', text: 'x\n',
                        baseOid: '0000000000000000000000000000000000000000',
                    }),
                });
                const d = await r.json();
                assert.equal(r.status, 403,
                    `${route}: 認可より先にパスを調べている（存在の走査ができる）: ${JSON.stringify(d)}`);
                assert.match(d.error, /token/i,
                    '認可以外の理由で断っている = 門の順序が入れ替わっている');
                assert.doesNotMatch(d.error, /追跡/,
                    '未認可の相手に「追跡されているか」を教えている');
            }
        });
    } finally {
        child.kill();
    }
});

test('🔒 write: 未追跡ファイルを拒否する（.env に触れる経路を作らない）', async () => {
    const { child, url } = await startWritable();
    try {
        await withEditWorktree('untracked', {
            tracked: { 'edit.txt': 'a\n' },
            untracked: { '.env': 'SECRET=abc\n' },
        }, async dir => {
            // 読むのも拒否する（中身が漏れない）
            const rf = await editPost(url, '/api/v0/file', { worktree: dir, path: '.env' });
            assert.equal(rf.status, 400, '未追跡ファイルが読めた');
            const df = await rf.json();
            assert.match(df.error, /追跡下にありません/);
            assert.doesNotMatch(JSON.stringify(df), /SECRET/, '中身が応答に漏れている');
            // 書くのも拒否する
            const rw = await editPost(url, '/api/v0/write', {
                worktree: dir, path: '.env', text: 'SECRET=overwritten\n',
                baseOid: '0000000000000000000000000000000000000000',
            });
            assert.equal(rw.status, 400, '未追跡ファイルに書けた');
            assert.match((await rw.json()).error, /追跡下にありません/);
            // **数え直す**: 中身が変わっていないこと
            assert.equal(await readFile(join(dir, '.env'), 'utf8'), 'SECRET=abc\n');
            // 追跡されているファイルは読める（この検査が「全部拒否」で緑になっていないこと）
            const ok = await editPost(url, '/api/v0/file', { worktree: dir, path: 'edit.txt' });
            assert.equal(ok.status, 200, '追跡下のファイルも読めていない（検査が空振り）');
        });
    } finally {
        child.kill();
    }
});

test('🔒 write: ../ と絶対パスとドライブレターを拒否する', async () => {
    const { child, url } = await startWritable();
    const outside = join(repo, '..', 'kjp-must-not-be-written.txt');
    try {
        await rm(outside, { force: true }).catch(() => {});
        await withEditWorktree('paths', { tracked: { 'edit.txt': 'a\n' } }, async dir => {
            const bad = [
                '../kjp-must-not-be-written.txt',
                '../../kjp-must-not-be-written.txt',
                'sub/../../kjp-must-not-be-written.txt',
                join(dir, 'edit.txt'),        // 絶対パス（Windows ならドライブレター付き）
                '/etc/passwd',
                'C:/Windows/System32/drivers/etc/hosts',
                '-oProxyCommand=x',           // 先頭 `-`（オプション注入）
                ':(exclude)edit.txt',         // pathspec magic
                'edit.txt\u0000.png',         // NUL
                '',
            ];
            for (const p of bad) {
                const r = await editPost(url, '/api/v0/write', {
                    worktree: dir, path: p, text: 'written\n',
                    baseOid: '0000000000000000000000000000000000000000',
                });
                assert.equal(r.status, 400, `拒否されなかった: ${JSON.stringify(p)}`);
                assert.match((await r.json()).error, /path が不正です/,
                    `別の理由で断っている（isSafeRepoPath を測れていない）: ${JSON.stringify(p)}`);
            }
            // **数え直す**: リポジトリ外にファイルが作られていないこと
            await assert.rejects(readFile(outside, 'utf8'),
                'リポジトリ外にファイルが作られた');
        });
    } finally {
        child.kill();
        await rm(outside, { force: true }).catch(() => {});
    }
});

test('🔒 write: 既知の worktree 以外を対象にできない', async () => {
    const { child, url } = await startWritable();
    try {
        for (const bad of [tmpdir(), `${repo}-not-a-worktree`, '']) {
            const r = await editPost(url, '/api/v0/write', {
                worktree: bad, path: 'edit.txt', text: 'x\n',
                baseOid: '0000000000000000000000000000000000000000',
            });
            assert.equal(r.status, 400, `既知でない worktree が通った: ${bad}`);
            assert.match((await r.json()).error, /既知の worktree ではありません/);
        }
    } finally {
        child.kill();
    }
});

test('🚨 write: 並行書き換えを 409 で拒否する（楽観ロック）', async () => {
    // 🚨 **このツールの核心。** 開いてから保存するまでの間に、その worktree の
    //    エージェント自身がファイルを書き換えているのが**普通の状態**。
    //    黙って上書きしたら観測ツールとして最悪。
    const { child, url } = await startWritable();
    try {
        await withEditWorktree('lock', { tracked: { 'edit.txt': 'one\ntwo\n' } }, async dir => {
            const f = join(dir, 'edit.txt');
            const opened = await (await editPost(url, '/api/v0/file',
                { worktree: dir, path: 'edit.txt' })).json();
            assert.equal(opened.text, 'one\ntwo\n');
            assert.match(opened.oid, /^[0-9a-f]{40}$/);

            // ここで**別のエージェントが書いた**ことにする
            await writeFile(f, 'written by another agent\n', 'utf8');

            const r = await editPost(url, '/api/v0/write', {
                worktree: dir, path: 'edit.txt',
                text: `${opened.text}three\n`, baseOid: opened.oid,
            });
            assert.equal(r.status, 409, '黙って上書きした（並行書き換えを検出していない）');
            const d = await r.json();
            assert.match(d.error, /他が書き換えました。読み直してください/,
                '文言が「何が起きたか」を言っていない');
            // **数え直す**: 相手の書いた内容が残っていること
            assert.equal(await readFile(f, 'utf8'), 'written by another agent\n',
                '409 を返したのに上書きしている');

            // 読み直せば保存できる（ロックが厳しすぎて何も保存できない状態でないこと）
            const again = await (await editPost(url, '/api/v0/file',
                { worktree: dir, path: 'edit.txt' })).json();
            const ok = await editPost(url, '/api/v0/write', {
                worktree: dir, path: 'edit.txt',
                text: `${again.text}mine\n`, baseOid: again.oid,
            });
            assert.equal(ok.status, 200, `読み直しても保存できない: ${await ok.text()}`);
            assert.equal(await readFile(f, 'utf8'), 'written by another agent\nmine\n');

            // baseOid を付けない／形が違う要求は 400（比較の前に形を見る）
            for (const baseOid of [undefined, '', 'not-an-oid', 'ABCDEF']) {
                const r2 = await editPost(url, '/api/v0/write',
                    { worktree: dir, path: 'edit.txt', text: 'x\n', baseOid });
                assert.equal(r2.status, 400, `baseOid ${JSON.stringify(baseOid)} が通った`);
                assert.match((await r2.json()).error, /baseOid/);
            }
            assert.equal(await readFile(f, 'utf8'), 'written by another agent\nmine\n',
                'baseOid が不正なのに書いている');
        });
    } finally {
        child.kill();
    }
});

/**
 * 🚨 **大きさの上限に検査が1件も無かった（#53）。**
 *
 * `MAX_EDIT_BYTES`（512KB）の門は**開く側と保存する側の2箇所**にあるのに、
 * どちらもテストが無く変異も無かった。1行の書き戻しで
 * 「巨大なファイルを丸ごと読んで丸ごと書く」経路に戻る
 * （スマホから 100MB のファイルを開いて母艦のメモリを埋められる）。
 *
 * ⚠️ **上限ちょうどが通ることも測る。** 「大きすぎるものを断る」だけを測ると、
 *    比較を `>=` にする変異（実用的な大きさまで断る）を見逃す。
 * ⚠️ 本文の上限（`MAX_WRITE_BODY_BYTES` = 4MB）と混同しない。JSON の文字列
 *    エスケープで最悪6倍に膨らむので、**中身 512KB を保存できる余地**が要る。
 */
test('🔒 write: 512KB を超える中身は開かない・書かない（上限ちょうどは通る）', async () => {
    const { child, url } = await startWritable();
    const LIMIT = 512 * 1024;
    try {
        await withEditWorktree('big', {
            tracked: {
                // 上限ちょうど（改行込みでぴったり）と、上限 + 1
                'fit.txt': `${'a'.repeat(LIMIT - 1)}\n`,
                'over.txt': `${'a'.repeat(LIMIT)}\n`,
                'small.txt': 'x\n',
            },
        }, async dir => {
            // 1. 上限を超えるファイルは**開けない**（413 で理由を言う）
            const over = await editPost(url, '/api/v0/file', { worktree: dir, path: 'over.txt' });
            assert.equal(over.status, 413, `上限を超えるファイルを開いた: ${over.status}`);
            const od = await over.json();
            assert.match(od.error, /バイトを超えるファイルは画面から編集しません/,
                `理由が分からない: ${JSON.stringify(od)}`);
            assert.match(od.error, new RegExp(String(LIMIT + 1)),
                '実際の大きさを言っていない（どれだけ超えたか分からない）');

            // 2. 上限ちょうどは**開ける**（厳しすぎて実用的な大きさが開けない状態にしない）
            // ⚠️ **本文は1回しか読めない。** assert のメッセージに `await res.text()` を
            //    書くと、テンプレートは**先に評価される**ので本文を消費してしまい、
            //    後の `res.json()` が `Body is unusable` で落ちる（実際に踏んだ）。
            const fit = await editPost(url, '/api/v0/file', { worktree: dir, path: 'fit.txt' });
            const fitBody = await fit.text();
            assert.equal(fit.status, 200, `上限ちょうどのファイルが開けない: ${fitBody.slice(0, 200)}`);
            const fd = JSON.parse(fitBody);
            assert.equal(fd.text.length, LIMIT);

            // 3. 上限を超える**中身**は書かない（開けたファイルに足して超えさせる）
            const small = await (await editPost(url, '/api/v0/file',
                { worktree: dir, path: 'small.txt' })).json();
            const big = await editPost(url, '/api/v0/write', {
                worktree: dir, path: 'small.txt',
                text: 'y'.repeat(LIMIT + 1), baseOid: small.oid,
            });
            assert.equal(big.status, 413, `上限を超える中身を書いた: ${big.status}`);
            assert.match((await big.json()).error, /バイトを超える内容は書きません/);
            // **数え直す**: ファイルが変わっていないこと
            assert.equal(await readFile(join(dir, 'small.txt'), 'utf8'), 'x\n',
                '413 を返したのに書いている');

            // 4. 上限ちょうどの中身は書ける
            const ok = await editPost(url, '/api/v0/write', {
                worktree: dir, path: 'small.txt',
                text: 'z'.repeat(LIMIT), baseOid: small.oid,
            });
            const okBody = await ok.text();
            assert.equal(ok.status, 200,
                `上限ちょうどの中身が書けない: ${okBody.slice(0, 200)}`);
            const wrote = await readFile(join(dir, 'small.txt'));
            assert.equal(wrote.length, LIMIT, `書かれた大きさが違う: ${wrote.length}`);
        });
    } finally {
        child.kill();
    }
});

test('write: CRLF と BOM と日本語ファイル名を保つ（触っていない行を変えない）', async () => {
    const { child, url } = await startWritable();
    try {
        await withEditWorktree('eol', {
            tracked: {
                'crlf.txt': Buffer.from('a\r\nb\r\n'),
                'lf.txt': 'a\nb\n',
                'bom.txt': Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]),
                    Buffer.from('a\r\n')]),
                'mixed.txt': Buffer.from('a\r\nb\nc\r\n'),
                // E1/E3 日本語＋空白のファイル名
                '日本語フォルダ/テスト ファイル.txt': 'ふが\n',
            },
        }, async dir => {
            const save = async (path, add) => {
                const opened = await (await editPost(url, '/api/v0/file',
                    { worktree: dir, path })).json();
                const r = await editPost(url, '/api/v0/write', {
                    worktree: dir, path, text: `${opened.text}${add}`, baseOid: opened.oid,
                });
                return { opened, status: r.status, body: await r.json() };
            };

            // CRLF のファイルは CRLF のまま（LF が1つも混ざらない）
            let s = await save('crlf.txt', 'c\n');
            assert.equal(s.status, 200, JSON.stringify(s.body));
            assert.equal(s.opened.eol, 'crlf');
            const crlf = await readFile(join(dir, 'crlf.txt'));
            assert.equal(crlf.toString('utf8'), 'a\r\nb\r\nc\r\n',
                'CRLF が保たれていない（全行が変更になる）');

            // LF のファイルに CRLF は入らない
            s = await save('lf.txt', 'c\n');
            assert.equal(s.status, 200, JSON.stringify(s.body));
            assert.equal((await readFile(join(dir, 'lf.txt'))).toString('utf8'), 'a\nb\nc\n');

            // BOM は保つ（1つだけ）
            s = await save('bom.txt', 'x\n');
            assert.equal(s.opened.bom, true);
            assert.equal(s.status, 200, JSON.stringify(s.body));
            const bom = await readFile(join(dir, 'bom.txt'));
            assert.deepEqual([...bom.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'BOM が消えた');
            assert.equal(bom.toString('utf8').replace(/^\uFEFF/, ''), 'a\r\nx\r\n');
            assert.equal([...bom].filter((_, i) => i < 6).join(','), '239,187,191,97,13,10',
                'BOM が二重になっている');

            // 日本語＋空白のファイル名（E1/E3）
            s = await save('日本語フォルダ/テスト ファイル.txt', 'ほげ\n');
            assert.equal(s.status, 200, JSON.stringify(s.body));
            assert.equal(
                await readFile(join(dir, '日本語フォルダ', 'テスト ファイル.txt'), 'utf8'),
                'ふが\nほげ\n');

            // 🚨 改行コードが混在しているファイルは**推測して直さない**（409 で断る）
            const mixed = await editPost(url, '/api/v0/file',
                { worktree: dir, path: 'mixed.txt' });
            assert.equal(mixed.status, 409, '混在しているのに開いた（保存で全行が変わる）');
            assert.match((await mixed.json()).error, /改行コードが混在/);
            assert.equal((await readFile(join(dir, 'mixed.txt'))).toString('utf8'),
                'a\r\nb\nc\r\n', '断ったのに書き換えている');
        });
    } finally {
        child.kill();
    }
});

test('🔒 write: 監査に残すが、中身は残さない', async () => {
    const auditPath = join(repo, '..', `kjp-write-audit-${process.pid}.jsonl`);
    const { child, url } = await startWritable(['--audit-log', auditPath]);
    const SECRETISH = 'CONTENT-MUST-NOT-BE-LOGGED-42';
    try {
        await withEditWorktree('audit', { tracked: { 'edit.txt': 'a\n' } }, async dir => {
            const opened = await (await editPost(url, '/api/v0/file',
                { worktree: dir, path: 'edit.txt' })).json();
            const r = await editPost(url, '/api/v0/write', {
                worktree: dir, path: 'edit.txt',
                text: `${SECRETISH}\n`, baseOid: opened.oid,
            });
            assert.equal(r.status, 200, await r.text());
            // 並行書き換えの記録も出す（後から事故を追うのに一番効く）
            await writeFile(join(dir, 'edit.txt'), 'someone else\n', 'utf8');
            const c = await editPost(url, '/api/v0/write', {
                worktree: dir, path: 'edit.txt', text: 'x\n', baseOid: opened.oid,
            });
            assert.equal(c.status, 409);

            const log = await readFile(auditPath, 'utf8');
            const rows = log.split('\n').filter(Boolean).map(l => JSON.parse(l));
            const wrote = rows.find(x => x.event === 'write');
            assert.ok(wrote, `write の記録が無い: ${log}`);
            assert.equal(wrote.path, 'edit.txt');
            assert.equal(wrote.bytes, `${SECRETISH}\n`.length);
            assert.ok(wrote.worktree.endsWith('-audit'), `worktree が無い: ${log}`);
            assert.ok(rows.some(x => x.event === 'write-conflict'),
                `並行書き換えの記録が無い: ${log}`);
            // 🔒 **中身は残さない**（記録が秘密の持ち出し口になる。T5 と同じ理屈）
            assert.doesNotMatch(log, new RegExp(SECRETISH),
                '監査ログに書いた中身が入っている');
            assert.doesNotMatch(log, /"text"/, '監査ログに text フィールドがある');
        });
    } finally {
        child.kill();
        await rm(auditPath, { force: true }).catch(() => {});
    }
});

test('🔒 write: シンボリックリンクは編集しない（実体がリポジトリ外を指しうる）', async t => {
    // 追跡下でも中身が symlink なら実体は worktree の外にありうる
    // （`git update-index --cacheinfo 120000` でコミットできる）。
    // ⚠️ Windows では symlink の作成に権限が要る。作れなければ**測れていないと言う**
    //    （緑にして「守った」と読まない）。
    const { symlink } = await import('node:fs/promises');
    const { child, url } = await startWritable();
    const outside = join(repo, '..', `kjp-symlink-target-${process.pid}.txt`);
    try {
        await writeFile(outside, 'outside secret\n', 'utf8');
        await withEditWorktree('symlink', { tracked: { 'edit.txt': 'a\n' } }, async dir => {
            const link = join(dir, 'link.txt');
            try {
                await symlink(outside, link);
            } catch (err) {
                t.skip(`symlink を作れないので測れません: ${err.code ?? err.message}`);
                return;
            }
            await g(['add', '-A'], dir);
            await g(['commit', '-q', '-m', 'symlink を追加'], dir);
            for (const route of ['/api/v0/file', '/api/v0/write']) {
                const r = await editPost(url, route, {
                    worktree: dir, path: 'link.txt', text: 'overwritten\n',
                    baseOid: '0000000000000000000000000000000000000000',
                });
                assert.equal(r.status, 400, `${route}: symlink が通った`);
                const d = await r.json();
                assert.match(d.error, /シンボリックリンク|worktree の外/);
                assert.doesNotMatch(JSON.stringify(d), /outside secret/,
                    'リンク先の中身が漏れている');
            }
            assert.equal(await readFile(outside, 'utf8'), 'outside secret\n',
                'リポジトリ外のファイルが書き換えられた');
        });
    } finally {
        child.kill();
        await rm(outside, { force: true }).catch(() => {});
    }
});

test('UI: 編集器が使うモジュール（linediff.mjs）が配信される', async () => {
    // 1本でも 404 だとモジュール全体が実行されず**ページが真っ白**になる。
    // 一覧は app.html から読む検査（上）が持っているが、この経路だけは
    // 「編集器を足したのに配信の許可リストに足し忘れる」形で壊れるので名指しで見る。
    const r = await fetch(`${baseUrl}/linediff.mjs`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /javascript/);
    assert.match(await r.text(), /export function diffLines/);
});

// ---------------------------------------------------------------------------
// 🔒 実行（/api/v0/exec）。「遠隔から実行できる」は定義上そのまま RCE なので、
//    扉（capability + token + method + Sec-Fetch-Site + Host）を全部固定する。
// ---------------------------------------------------------------------------

const EXEC_TOKEN = 'test-token-for-exec-0123456789abcdef';

/** 実行有効のサーバを立てる。呼び出し側が kill する。 */
async function startExec(extra = []) {
    const child = spawn(
        process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--allow-exec', '--token', EXEC_TOKEN, ...extra],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } },
    );
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const url = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('起動しなかった')), 15000);
        let buf = '';
        child.stdout.on('data', d => {
            buf += d;
            const m = buf.match(/http:\/\/127\.0\.0\.1:\d+/);
            if (m) { clearTimeout(t); resolve(m[0]); }
        });
        child.on('error', reject);
    // 🚨 待ちが失敗したら子を殺す。子の stdio パイプが node --test を生かし続け、要約が出ないまま SIGKILL される（原因が消える）
    }).catch(e => { try { child.kill(); } catch { /* noop */ } throw e; });
    return { child, url };
}

/** ndjson を全部読んでイベント配列にする */
async function readExec(url, bodyObj, headers = {}) {
    const res = await fetch(`${url}/api/v0/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN, ...headers },
        body: JSON.stringify(bodyObj),
    });
    if (!res.ok) return { status: res.status, error: (await res.json()).error, events: [] };
    const text = await res.text();
    const events = text.split('\n').filter(Boolean).map(l => JSON.parse(l));
    return { status: res.status, events };
}

test('🔒 --allow-exec なしでは exec の経路が存在しない', async () => {
    const res = await fetch(`${baseUrl}/api/v0/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ worktree: repo, argv: ['git', 'status'] }),
    });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /--allow-exec/);
});

/**
 * 🚨 **自動生成トークンで実行を許してはいけない。**
 *
 * 以前は長さだけを見ていて、しかもその検査が
 * `if (opts.requireAuth && !opts.token) opts.token = randomBytes(32)` の**後**にあった。
 * `--allow-host` は requireAuth を自動でオンにするので、
 * **門が最も効くべきトンネル構成でだけ門が消えていた**
 * （6回目のレビューが実測: 43文字の自動生成トークンで `POST /api/v0/exec` が 200）。
 * 見るべきは長さではなく **`--token` / `--token-file` で明示したか**（+ 長さの下限）。
 */
test('🔒 --allow-exec は明示的なトークン無しでは起動を拒否する（自動生成では通さない）', async () => {
    const cases = [
        [[], 'トークン無し'],
        [['--token', 'short'], '短いトークン'],
        // 🚨 ここが抜けていた。requireAuth が自動生成を先に走らせる経路
        [['--require-auth'], '--require-auth の自動生成'],
        [['--allow-host', 'x.example'], '--allow-host（requireAuth を自動オン）'],
        [['--require-auth', '--token', 'short'], '自動生成 + 短いトークン'],
    ];
    for (const [extra, label] of cases) {
        const child = spawn(process.execPath,
            [SERVER, '--repo', repo, '--port', '0', '--allow-exec', ...extra],
            { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
        child.stderr.setEncoding('utf8');
        child.stdout.setEncoding('utf8');
        let err = '';
        let out = '';
        child.stderr.on('data', d => { err += d; });
        child.stdout.on('data', d => { out += d; });
        // ⚠️ 拒否されないとサーバは listen し続けるので、素の await にしない
        const code = await Promise.race([
            new Promise(r => child.on('close', r)),
            new Promise(r => setTimeout(() => r('running'), 15000)),
        ]);
        child.kill();
        assert.equal(code, 1,
            `起動してしまった（${label}）— 自動生成トークンで実行が引ける:\n${out}`);
        assert.match(err, /--token/, label);
    }
});

// 明示したなら通る（門が全部を拒否していないこと。片側だけの検査にしない）
test('🔒 --allow-exec は --token / --token-file を明示すれば起動する', async () => {
    const outside = join(repo, '..', `${repo.split(/[\\/]/).pop()}-exec-tok`);
    const cases = [
        ['--token', EXEC_TOKEN],
        ['--token-file', outside],
    ];
    try {
        for (const extra of cases) {
            const child = spawn(process.execPath,
                [SERVER, '--repo', repo, '--port', '0', '--allow-exec', ...extra,
                    // トンネル構成でも通ること（requireAuth が絡んでも門が壊れない）
                    '--allow-host', 'x.example'],
                { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            let out = '';
            let err = '';
            child.stdout.on('data', d => { out += d; });
            child.stderr.on('data', d => { err += d; });
            const started = await Promise.race([
                new Promise(r => {
                    const iv = setInterval(() => {
                        if (/http:\/\/127\.0\.0\.1:\d+/.test(out)) { clearInterval(iv); r(true); }
                    }, 50);
                    setTimeout(() => { clearInterval(iv); r(false); }, 15000);
                }),
                new Promise(r => child.on('close', () => r(false))),
            ]);
            child.kill();
            assert.ok(started,
                `明示したのに起動しない（${extra[0]}）:\n${out}\n${err}`);
        }
    } finally {
        await rm(outside, { force: true });
    }
});

test('🔒 exec の関門: token / method / Sec-Fetch-Site / Host', async () => {
    const { child, url } = await startExec();
    try {
        const body = JSON.stringify({ worktree: repo, argv: ['git', '--version'] });
        const J = { 'content-type': 'application/json' };

        let r = await fetch(`${url}/api/v0/exec`, { method: 'POST', headers: J, body });
        assert.equal(r.status, 403, 'トークン無しが通った');

        r = await fetch(`${url}/api/v0/exec`,
            { method: 'POST', headers: { ...J, 'x-kjp-token': 'wrong-but-long-enough-value-xx' }, body });
        assert.equal(r.status, 403, '誤ったトークンが通った');

        r = await fetch(`${url}/api/v0/exec`, { headers: { 'x-kjp-token': EXEC_TOKEN } });
        assert.equal(r.status, 405, 'GET が通った');

        r = await fetch(`${url}/api/v0/exec`, {
            method: 'POST',
            headers: { ...J, 'x-kjp-token': EXEC_TOKEN, 'sec-fetch-site': 'cross-site' },
            body,
        });
        assert.equal(r.status, 403, 'cross-site が通った');

        const raw = await rawGet(`${url}/api/v0/exec`, { host: 'evil.example' });
        assert.equal(raw.status, 403, 'Host 検証を通っていない');
    } finally {
        child.kill();
    }
});

test('🔒 exec は既知の worktree 以外を cwd にしない', async () => {
    const { child, url } = await startExec();
    try {
        for (const bad of [tmpdir(), '', `${repo}-nope`]) {
            const r = await readExec(url, { worktree: bad, argv: ['git', '--version'] });
            assert.equal(r.status, 400, `既知でない worktree が通った: ${bad}`);
        }
        // argv の検証
        for (const bad of [null, [], 'git status', ['git\0x']]) {
            const r = await readExec(url, { worktree: repo, argv: bad });
            assert.equal(r.status, 400, `不正な argv が通った: ${JSON.stringify(bad)}`);
        }
    } finally {
        child.kill();
    }
});

/**
 * 🚨 **予約した枠は、どの失敗経路でも返す。**
 *
 * `create()` で枠を予約した後、`listWorktrees()` が throw する経路が
 * `bail()` を通っていなかった。throw は外側の catch-all に吸われて 500 になるだけで
 * **finish も remove も走らない**ので、8回踏むと恒久的に 429 になっていた。
 * さらに回収する sweeper は `attachChild` 成功後にしか起動していなかったので、
 * **正常な exec が一度も通っていないデーモンでは回収機構が存在しない**（#35）。
 * 記録の側も、sweeper が拾うと `signal:"SIGKILL"` / `reason:"timeout"` になり
 * **spawn すらしていないプロセスを殺したという嘘**が監査に残っていた。
 */
test('🚨 exec: 準備に失敗しても枠を返す（500 を上限回踏んでも 429 にならない）', async () => {
    const lab = await mkdtemp(join(tmpdir(), 'kjp-slot-'));
    const r2 = join(lab, 'r');
    const audit = join(lab, 'audit.jsonl');
    await mkdir(r2, { recursive: true });
    await g(['init', '-q', '-b', 'main'], r2);
    await writeFile(join(r2, 'f.txt'), 'x\n', 'utf8');
    await g(['add', '-A'], r2);
    await g(['commit', '-q', '-m', 'seed'], r2);

    const child = spawn(process.execPath,
        [SERVER, '--repo', r2, '--port', '0', '--allow-exec', '--token', EXEC_TOKEN,
            '--audit-log', audit],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
    child.stdout.setEncoding('utf8');
    const url = await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('起動しなかった')), 15000);
        let buf = '';
        child.stdout.on('data', d => {
            buf += d;
            const m = buf.match(/http:\/\/127\.0\.0\.1:\d+/);
            if (m) { clearTimeout(t); res(m[0]); }
        });
        child.on('error', rej);
    // 🚨 待ちが失敗したら子を殺す。子の stdio パイプが node --test を生かし続け、要約が出ないまま SIGKILL される（原因が消える）
    }).catch(e => { try { child.kill(); } catch { /* noop */ } throw e; });
    const post = () => fetch(`${url}/api/v0/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
        body: JSON.stringify({ worktree: r2, argv: ['git', '--version'] }),
    });
    try {
        // ⚠️ **正常な exec を1本も通さない。** 通すと sweeper が起動してしまい、
        //    「回収機構が過去の成功に依存している」という本題が測れなくなる。
        const off = `${join(r2, '.git')}-off`;
        await rename(join(r2, '.git'), off);
        // 上限（8）より多く踏む。枠が返っていなければここで埋まりきる
        const codes = [];
        for (let i = 0; i < 10; i++) codes.push((await post()).status);
        assert.ok(codes.every(c => c === 500),
            `準備の失敗が 500 以外になった（枠切れの 429 が混ざっている）: ${codes.join(',')}`);
        await rename(off, join(r2, '.git'));

        // 枠が返っていれば、直後の正常な要求が通る
        const ok = await post();
        assert.equal(ok.status, 200,
            `枠が返っていない（${ok.status}）— 500 を踏むたびに実行枠が1本死んでいる`);
        await ok.text();   // 本文を読み切ってセッションを終わらせる

        // 📓 記録の側: 「起動していないものを殺した」と言わない
        const lines = (await (await import('node:fs/promises')).readFile(audit, 'utf8'))
            .split('\n').filter(Boolean).map(l => JSON.parse(l));
        const bails = lines.filter(e => e.reason === 'never-started');
        assert.ok(bails.length >= 10,
            `準備の失敗が監査に残っていない: ${JSON.stringify(lines.slice(0, 3))}`);
        assert.ok(!lines.some(e => e.event === 'kill' && e.worktree === '(未検証)'),
            '検証前に落ちたセッションを「停止した」として記録している（嘘）');
    } finally {
        child.kill();
        await rm(lab, { recursive: true, force: true }).catch(() => {});
    }
});

test('exec が出力を流し、終了コードを返す', async () => {
    const { child, url } = await startExec();
    try {
        const ok = await readExec(url, { worktree: repo, argv: ['git', '--version'] });
        assert.equal(ok.status, 200);
        const out = ok.events.filter(e => e.t === 'out').map(e => e.d).join('');
        assert.match(out, /git version/);
        const exit = ok.events.at(-1);
        assert.equal(exit.t, 'exit');
        assert.equal(exit.code, 0);

        // 非 0 の終了コードも伝わる
        const bad = await readExec(url, { worktree: repo, argv: ['git', 'rev-parse', 'no-such-ref'] });
        assert.equal(bad.status, 200);
        assert.notEqual(bad.events.at(-1).code, 0, '失敗の終了コードが伝わっていない');
        assert.ok(bad.events.some(e => e.t === 'err'), 'stderr が流れていない');
    } finally {
        child.kill();
    }
});

test('exec: 3バイト文字が chunk 境界で割れない', async () => {
    const { child, url } = await startExec();
    try {
        // 日本語を大量に出力させ、UTF-8 の境界越えを起こす
        const script = 'process.stdout.write("あいうえお漢字テスト".repeat(4000))';
        const r = await readExec(url, {
            worktree: repo, argv: [process.execPath, '-e', script],
        });
        assert.equal(r.status, 200);
        const out = r.events.filter(e => e.t === 'out').map(e => e.d).join('');
        assert.equal(out, 'あいうえお漢字テスト'.repeat(4000));
        assert.ok(!out.includes('�'), '置換文字が混ざっている（chunk 境界で割れた）');
    } finally {
        child.kill();
    }
});

test('exec: 上限時間を超えたら停止する', async () => {
    const { child, url } = await startExec(['--exec-timeout', '1']);
    try {
        const r = await readExec(url, {
            worktree: repo, argv: [process.execPath, '-e', 'setTimeout(()=>process.exit(0),30000)'],
        });
        assert.equal(r.status, 200);
        const exit = r.events.at(-1);
        assert.equal(exit.t, 'exit');
        assert.ok(r.events.some(e => e.t === 'err' && /上限時間/.test(e.d)),
            `上限で止めた形跡が無い: ${JSON.stringify(r.events)}`);
    } finally {
        child.kill();
    }
});

// ⚠️ 取り残した子プロセスはこのプロジェクトが実際に事故を起こした種類
//    （検証用サーバを残してポートを塞いだ / chrome を53個残した）。
//    クライアントが切れたら殺すことをテストで固定する。
// 🚨 #17 で挙動を**意図的に変えた**。以前は「切断で必ず殺す」だったが、
//    モバイルブラウザはタブを積極的に停止するので、スマホから投げた
//    `npm test` がその瞬間に死んでいた。今は「切断では殺さず、猶予を過ぎたら殺す」。
//    ここでは新しい契約の3点すべてを固定する:
//      1. 切断しても走り続ける
//      2. 再購読で切断中の出力が貰える
//      3. 猶予を過ぎたら確実に死ぬ（取り残しの経路を作っていない）
test('🚨 exec: 切断しても走り続け、再購読で追いつき、猶予を過ぎたら死ぬ', async () => {
    // 猶予を2秒にして決定的に測る（既定は5分）
    const { child, url } = await startExec(['--exec-detached-grace', '2']);
    const beacon = join(repo, 'exec-beacon.txt');
    const { readFileSync } = await import('node:fs');
    const size = () => { try { return readFileSync(beacon, 'utf8').length; } catch { return 0; } };
    try {
        // 100ms ごとにファイルへ追記し、同時に標準出力にも書き続ける
        const script = 'const fs=require("fs");let i=0;'
            + 'setInterval(()=>{i++;try{fs.appendFileSync(process.argv[1],"x")}catch(e){};'
            + 'process.stdout.write("tick"+i+"\\n")},100);';
        const ac = new AbortController();
        const res = await fetch(`${url}/api/v0/exec`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            body: JSON.stringify({
                worktree: repo, argv: [process.execPath, '-e', script, beacon],
            }),
            signal: ac.signal,
        });
        // 1行目は必ず session（再接続先の id を知る唯一の手段）
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let sessionId = null, lastSeq = 0;
        while (sessionId === null) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            for (const line of buf.split('\n').slice(0, -1)) {
                if (!line.trim()) continue;
                const r = JSON.parse(line);
                if (r.t === 'session') sessionId = r.id;
                if (typeof r.n === 'number') lastSeq = Math.max(lastSeq, r.n);
            }
            buf = buf.slice(buf.lastIndexOf('\n') + 1);
        }
        assert.ok(sessionId, '1行目に session が来ない（再接続先の id を知る手段が無い）');
        assert.match(sessionId, /^[0-9a-f]{16}$/);

        // 走り始めたことを確認して切断する
        while (size() === 0) await new Promise(r => setTimeout(r, 50));
        ac.abort();
        const atAbort = size();

        // 1. 切断しても走り続ける（ファイルが増え続ける）
        await new Promise(r => setTimeout(r, 700));
        const afterAbort = size();
        assert.ok(afterAbort > atAbort,
            `切断で殺されている（${atAbort} → ${afterAbort}）。#17 の目的が失われている`);

        // 2. 再購読で切断中の出力が貰える
        const re = await fetch(`${url}/api/v0/exec/${sessionId}/stream`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            body: JSON.stringify({ from: lastSeq }),
        });
        assert.equal(re.status, 200, '再購読できない');
        const rr = re.body.getReader();
        let rbuf = '';
        const got = [];
        while (got.length < 3) {
            const { value, done } = await rr.read();
            if (done) break;
            rbuf += dec.decode(value, { stream: true });
            for (const line of rbuf.split('\n').slice(0, -1)) {
                if (line.trim()) got.push(JSON.parse(line));
            }
            rbuf = rbuf.slice(rbuf.lastIndexOf('\n') + 1);
        }
        assert.equal(got[0].t, 'session');
        assert.equal(got[0].state, 'running', '再購読したのに running でない');
        const outs = got.filter(r => r.t === 'out');
        assert.ok(outs.length > 0, '切断中の出力が再生されない');
        assert.ok(outs.every(r => r.n > lastSeq),
            `既に見た分が重複して送られている: ${JSON.stringify(outs.map(r => r.n))}`);
        try { await rr.cancel(); } catch { /* 既に閉じている */ }

        // 3. 猶予（2秒）を過ぎたら死ぬ。ここが効かないと取り残しが戻る
        const beforeGrace = size();
        // 猶予 2s + sweep の周期 1s + 余裕
        for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 200));
            const a = size();
            await new Promise(r => setTimeout(r, 400));
            if (size() === a && a > beforeGrace) break;
        }
        const s1 = size();
        await new Promise(r => setTimeout(r, 800));
        assert.equal(size(), s1,
            `猶予を過ぎても子プロセスが生きている（${s1} → ${size()}）。取り残しの経路が戻っている`);
    } finally {
        child.kill();
        await rm(beacon, { force: true });
    }
});

// 🚨 5回目のレビューの BLOCKING。`streamSession` は `create()` →
//    `await listWorktrees()` → `await auditExec()` → `spawn` の**後**に呼ばれるので、
//    その窓（150ms 以上）で切ると `res` の 'close' は listener 登録より前に
//    発火済みで **detach が一度も走らない**。すると `subscribers` が 1 のまま残り、
//    `lastDetachedAt` が永久に入らず **切断後の猶予が完全に無効化**される
//    （子は絶対上限 600 秒まで走る）。しかも一覧は「接続中」と表示する（嘘）。
//    UI で「実行→停止」を素早く押すとこの窓に落ちる。
test('🚨 exec: 応答が届く前に切っても切断として扱い、猶予が効く', async () => {
    // 🚨 **`--exec-stream-delay` で「届く前に切られた」を決定的にする。**
    //    素の実装では `res` の 'close' がリスナ登録の前か後かが
    //    プラットフォーム依存の競争になり、**Linux では守りを外しても緑**だった
    //    （CI だけで SURVIVED として露出した。手元の Windows では落ちていた）。
    const { child, url } = await startExec(['--exec-detached-grace', '2', '--exec-timeout', '60',
        '--exec-stream-delay', '500']);
    try {
        const body = JSON.stringify({
            worktree: repo,
            argv: [process.execPath, '-e',
                'setInterval(()=>process.stdout.write("x".repeat(1000)),20)'],
        });
        // ⚠️ fetch では「応答到着前に切る」を作りにくいので node:http で書く
        const port = Number(new URL(url).port);
        const q = httpRequest({
            host: '127.0.0.1', port, path: '/api/v0/exec', method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
        }, x => x.resume());
        q.on('error', () => { /* こちらから切るので当然エラーになる */ });
        q.write(body);
        q.end();
        await new Promise(r => setTimeout(r, 30));
        q.destroy();

        const sessions = async () => {
            const st = JSON.parse(await (await fetch(`${url}/api/v0/state?fresh=1`)).text());
            return st.execSessions ?? [];
        };
        // 切断として扱われていること（購読者0・切断中が数値）
        let one = null;
        for (let i = 0; i < 20 && !one; i++) {
            await new Promise(r => setTimeout(r, 200));
            one = (await sessions()).find(s => s.state === 'running' || s.state === 'done');
        }
        assert.ok(one, 'セッションが台帳に無い');
        assert.equal(one.subscribers, 0, '購読者が残っている（detach が走っていない）');
        assert.notEqual(one.detachedMs, null,
            '切断中として扱われていない（猶予が永久に効かなくなる）');

        // 猶予（2秒）+ sweep の周期で止まる
        let done = null;
        for (let i = 0; i < 32 && !done; i++) {
            await new Promise(r => setTimeout(r, 250));
            const list = await sessions();
            const s = list.find(x => x.id === one.id);
            if (!s || s.state === 'done') done = s ?? { state: 'evicted' };
        }
        assert.ok(done, `猶予を過ぎても止まらない: ${JSON.stringify(await sessions())}`);
    } finally { child.kill(); }
});

/**
 * 🚨 **8回目のレビュー（SERIOUS）: `attachChild` 失敗経路に 'error' listener が無く、
 *    ENOENT でデーモンが exit 1 で落ちていた。**
 *
 * `create()` → `spawn()` の間に `/kill` が入るとセッションは done になり、
 * `if (!execRegistry.attachChild(...))` で早期 return する。ところが
 * `child.on('error')` を張るのは**その return の後ろ**だったので、この経路の
 * ChildProcess には error listener が1つも無かった。spawn の失敗は非同期の
 * 'error' で来る（ENOENT / EACCES）ため、**listener 無しの 'error' が
 * uncaughtException になりデーモンが即死**する（要求2本で消える）。
 * SIGINT/SIGTERM のハンドラは uncaughtException では走らないので、
 * 走っている全セッションの子は寿命管理の外に落ちる。
 * `child.stdin` の 'error' で同じ型を直していたのに、兄弟経路を取りこぼしていた。
 */
test('🚨 exec: starting のうちに kill された後に spawn が失敗してもデーモンは生きている', async () => {
    // `--exec-spawn-delay` で「kill が spawn より先」を決定的にする
    //（素のままだと窓は実測 100ms 前後のプラットフォーム依存の競争）
    const { child, url } = await startExec(['--exec-spawn-delay', '900']);
    const port = Number(new URL(url).port);
    try {
        // 存在しないコマンド。spawn は ENOENT で非同期の 'error' を出す
        const q = httpRequest({
            host: '127.0.0.1', port, path: '/api/v0/exec', method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
        }, x => x.resume());
        q.on('error', () => { /* 応答は待たない */ });
        q.write(JSON.stringify({ worktree: repo, argv: ['kjp-no-such-command-xyz'] }));
        q.end();

        const list = async () => {
            const r = await fetch(`${url}/api/v0/exec/list`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            });
            return r.ok ? (await r.json()).sessions ?? [] : null;
        };
        // starting のうちに掴む（spawn の手前で待たせているので必ず居る）
        let target = null;
        for (let i = 0; i < 40 && !target; i++) {
            await new Promise(r => setTimeout(r, 50));
            target = (await list() ?? []).find(s => s.state === 'starting');
        }
        assert.ok(target, 'starting のセッションが見えない（窓を作れていない）');
        const killed = await fetch(`${url}/api/v0/exec/${target.id}/kill`, {
            method: 'POST', headers: { 'x-kjp-token': EXEC_TOKEN },
        });
        assert.equal(killed.status, 200, '停止できない');
        await killed.text();

        // spawn（900ms 後）の ENOENT を過ぎてもデーモンが応答すること
        await new Promise(r => setTimeout(r, 1500));
        const after = await list();
        assert.ok(after !== null,
            'ENOENT の '
            + `'error' でデーモンが落ちた（exitCode=${child.exitCode}）。`
            + '要求2本で全セッションの観測が消える');
        assert.equal(child.exitCode, null, `デーモンが終了している: ${child.exitCode}`);
        // 起動できなかったことがセッションに残る（黙って消えない）
        const s = (after ?? []).find(x => x.id === target.id);
        assert.ok(s, `セッションが台帳から消えた: ${JSON.stringify(after)}`);
        assert.equal(s.state, 'done', `終端していない: ${JSON.stringify(s)}`);
    } finally { child.kill(); }
});

test('🚨 exec: 明示的な kill で止まり、監査に残る', async () => {
    const { child, url } = await startExec();
    const beacon = join(repo, 'exec-kill-beacon.txt');
    const { readFileSync } = await import('node:fs');
    const size = () => { try { return readFileSync(beacon, 'utf8').length; } catch { return 0; } };
    try {
        const script = 'const fs=require("fs");'
            + 'const t=setInterval(()=>{try{fs.appendFileSync(process.argv[1],"x")}catch(e){}},100);'
            + 'setTimeout(()=>{clearInterval(t);process.exit(0)},30000);'
            + 'process.stdout.write("go\\n");';
        const ac = new AbortController();
        const res = await fetch(`${url}/api/v0/exec`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            body: JSON.stringify({
                worktree: repo, argv: [process.execPath, '-e', script, beacon], keepAlive: true,
            }),
            signal: ac.signal,
        });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        const first = JSON.parse(dec.decode((await reader.read()).value).split('\n')[0]);
        assert.equal(first.t, 'session');
        assert.equal(first.keepAlive, true, 'keepAlive が反映されていない');
        assert.equal(first.detachedGraceMs, null, 'keepAlive なのに猶予が出ている');
        // 🚨 **絶対上限を必ず送る。** これが無いと UI は「切断しても最後まで走ります」
        //    しか言えず、**完走の約束**になる（実際は --exec-timeout で SIGKILL）。
        //    keepAlive のセッションこそ、いつ殺されるかを言わなければならない
        assert.equal(typeof first.timeoutMs, 'number',
            `session レコードに絶対上限が入っていない: ${JSON.stringify(first)}`);
        assert.ok(first.timeoutMs > 0, `上限が正の数でない: ${first.timeoutMs}`);

        while (size() === 0) await new Promise(r => setTimeout(r, 50));
        ac.abort();

        // keepAlive なので切断だけでは死なない
        await new Promise(r => setTimeout(r, 600));
        const a = size();
        await new Promise(r => setTimeout(r, 600));
        assert.ok(size() > a, 'keepAlive なのに切断で死んでいる');

        // 明示的に止める
        const k = await fetch(`${url}/api/v0/exec/${first.id}/kill`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
        });
        assert.equal(k.status, 200);
        assert.equal((await k.json()).ok, true);

        await new Promise(r => setTimeout(r, 600));
        const s1 = size();
        await new Promise(r => setTimeout(r, 600));
        assert.equal(size(), s1, `kill が効いていない（${s1} → ${size()}）`);

        // 監査に残る（何を止めたか後から辿れる）
        const { readFile: rf } = await import('node:fs/promises');
        const auditRaw = await rf(join(repo, '.git', 'kjp-exec-audit.jsonl'), 'utf8');
        const events = auditRaw.trim().split('\n').map(l => JSON.parse(l))
            .filter(e => e.session === first.id);
        const kinds = events.map(e => e.event);
        for (const want of ['start', 'detach', 'kill']) {
            assert.ok(kinds.includes(want), `監査に ${want} が無い: ${kinds.join(',')}`);
        }
    } finally {
        child.kill();
        await rm(beacon, { force: true });
    }
});

// 🚨 切断で殺さなくなったので、**サーバ終了時の後始末が唯一の最後の砦**になった。
//    ここが効かないと、サーバを止めるたびに孫が残る。
//
// ⚠️ Windows では検証できない。`child.kill('SIGTERM')` は TerminateProcess に
//    なるので `process.on('SIGTERM')` ハンドラが**そもそも走らない**
//    （= Windows ではこの守り自体が効かない。既知の限界として記録する）。
test('🚨 exec: サーバを SIGTERM で止めたら孫プロセスも残さない', {
    skip: process.platform === 'win32'
        ? 'Windows は SIGTERM が TerminateProcess になりハンドラが走らない（既知の限界）'
        : false,
}, async () => {
    const { child, url } = await startExec();
    const beacon = join(repo, 'shutdown-beacon.txt');
    const { readFileSync } = await import('node:fs');
    const size = () => { try { return readFileSync(beacon, 'utf8').length; } catch { return 0; } };
    try {
        // 中間に sh を挟む。直接の子だけを殺す実装では孫が残る形
        const inner = 'const fs=require("fs");'
            + 'const t=setInterval(()=>{try{fs.appendFileSync(process.argv[1],"x")}catch(e){}},100);'
            + 'setTimeout(()=>{clearInterval(t);process.exit(0)},30000);';
        const ac = new AbortController();
        const res = await fetch(`${url}/api/v0/exec`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            body: JSON.stringify({
                worktree: repo,
                argv: ['sh', '-c', `${process.execPath} -e '${inner}' "$1"`, 'sh', beacon],
            }),
            signal: ac.signal,
        });
        await res.body.getReader().read();
        while (size() === 0) await new Promise(r => setTimeout(r, 50));

        // サーバを止める（切断ではなく、サーバ自身の終了）
        child.kill('SIGTERM');
        await Promise.race([
            new Promise(r => child.on('exit', r)),
            new Promise(r => setTimeout(r, 5000)),
        ]);
        await new Promise(r => setTimeout(r, 700));
        const s1 = size();
        await new Promise(r => setTimeout(r, 700));
        assert.equal(size(), s1,
            `サーバを止めても孫が走り続けている（${s1} → ${size()}）`);
        ac.abort();
    } finally {
        child.kill('SIGKILL');
        await rm(beacon, { force: true });
    }
});

// ---------------------------------------------------------------------------
// #18 標準入力（会話コンソールの土台）
//
// ⚠️ サーバは中身を解釈しない。`claude` の stream-json の1行を組み立てるのは
//    クライアントの仕事。ここでは「汎用の stdin 書き込み」として検証する。
// ---------------------------------------------------------------------------

/** 行ごとに `echo:<行>` を返し、EOF で `eof` を出す子プロセス */
const ECHO_SCRIPT = 'process.stdin.setEncoding("utf8");let b="";'
    + 'process.stdin.on("data",d=>{b+=d;let i;'
    + 'while((i=b.indexOf("\\n"))>=0){const l=b.slice(0,i);b=b.slice(i+1);'
    + 'process.stdout.write("echo:"+l+"\\n")}});'
    + 'process.stdin.on("end",()=>{process.stdout.write("eof\\n")});';

/** セッションを1つ作り、id と「行を読む」関数を返す */
async function startSession(url, argv, extra = {}) {
    const ac = new AbortController();
    const res = await fetch(`${url}/api/v0/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
        body: JSON.stringify({ worktree: repo, argv, ...extra }),
        signal: ac.signal,
    });
    assert.equal(res.status, 200, `セッションを作れない: ${res.status}`);
    const rd = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const seen = [];
    /**
     * 条件を満たすレコードが来るまで読む。
     *
     * 🚨 **上限は `Promise.race` で掛ける。** 経過時間をループの先頭で見るだけでは、
     *    `rd.read()` が返らないときに**一度も判定に戻らずハングする**。
     *    ハングすると `node --test` ごと SIGKILL され、要約が出ないので
     *    「落ちた」ではなく「テストが1件も走っていない」に見える
     *    （変異テストが SKIP と誤報し、守りが検証されない）。
     */
    const until = async (pred, limitMs = 15000) => {
        const t0 = Date.now();
        while (!seen.some(pred)) {
            const left = limitMs - (Date.now() - t0);
            if (left <= 0) {
                throw new Error(`条件を満たすレコードが来ない。見えたもの: ${JSON.stringify(seen)}`);
            }
            const r = await Promise.race([
                rd.read(),
                new Promise(res => setTimeout(() => res({ timeout: true }), left)),
            ]);
            if (r.timeout) {
                throw new Error(`${limitMs}ms 待っても条件を満たさない。見えたもの: ${JSON.stringify(seen)}`);
            }
            if (r.done) break;
            buf += dec.decode(r.value, { stream: true });
            const parts = buf.split('\n');
            buf = parts.pop();
            for (const l of parts) if (l.trim()) seen.push(JSON.parse(l));
        }
        return seen;
    };
    await until(r => r.t === 'session');
    const id = seen.find(r => r.t === 'session').id;
    return { id, seen, until, abort: () => ac.abort(), cancel: () => rd.cancel().catch(() => {}) };
}

const sendInput = (url, id, body) => fetch(`${url}/api/v0/exec/${id}/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
    body: JSON.stringify(body),
});

/**
 * 🚨 **#49: 監視盤から入力している最中のセッションを、猶予切れで殺さない。**
 *
 * 監視盤は**購読せずに**入力できる（`/api/v0/exec/list` + `/input`）ので、
 * 猶予が購読/解除の時刻でしか進まないと**返事を書いている最中に SIGKILL**される。
 * ここは寿命の配線（`/input` → `noteInput`）を測る。判断そのものは
 * `execsession.test.mjs` の純関数 `sweep(now)` で測ってある。
 */
test('🚨 exec: 購読していなくても、入力している間は猶予で殺されない（#49）', async () => {
    // 猶予 2 秒。入力を 700ms ごとに送り続けて、猶予の2倍以上生き延びること
    const { child, url } = await startExec(['--exec-detached-grace', '2']);
    try {
        // 標準入力を読んで応答する仕込み（入力が届いていることも確かめられる）
        const script = 'process.stdin.on("data", d => '
            + 'process.stdout.write("got:" + String(d).trim() + String.fromCharCode(10)));'
            + 'setInterval(() => {}, 1000);';
        const s = await startSession(url, [process.execPath, '-e', script]);
        // 🚨 **購読をやめる**（= 監視盤だけで触っている状態を作る）。
        //    ここで abort しないと lastDetachedAt が入らず、猶予が始まらない
        s.abort();
        await new Promise(r => setTimeout(r, 300));

        const alive = async () => {
            const r = await fetch(`${url}/api/v0/exec/list`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            });
            const body = await r.json();
            return (body.sessions ?? []).find(x => x.id === s.id) ?? null;
        };
        // 猶予（2秒）の 2.5 倍のあいだ、700ms ごとに入力を送る
        const sent = [];
        for (let i = 0; i < 7; i++) {
            const res = await sendInput(url, s.id, { data: `poke-${i}\n` });
            sent.push(res.status);
            await new Promise(r => setTimeout(r, 700));
        }
        const st = await alive();
        assert.ok(st, `セッションが台帳から消えた（入力中に殺された）: 入力の応答 ${JSON.stringify(sent)}`);
        assert.equal(st.state, 'running',
            `入力し続けたのに殺された（state=${st.state} / 入力の応答 ${JSON.stringify(sent)}）`);
        assert.ok(sent.every(c => c === 200), `入力が通っていない: ${JSON.stringify(sent)}`);

        // 入力をやめたら、猶予を過ぎて**ちゃんと殺される**（延命しっぱなしにしない）
        for (let i = 0; i < 40; i++) {
            const cur = await alive();
            if (!cur || cur.state !== 'running') break;
            await new Promise(r => setTimeout(r, 250));
        }
        const after = await alive();
        assert.ok(!after || after.state !== 'running',
            '入力をやめても猶予で殺されない（取り残しの経路になっている）');
    } finally {
        child.kill();
    }
});

/**
 * 🚨 **停止したら、そこで終端すること（exit の後ろに出力を並べない）。**
 *
 * 以前は `/kill` と sweeper がどちらも **finish() を先に、killTree() を後に**
 * 呼んでいた。`finish()` は `exit` を流して購読側が `res.end()` するので、
 * (a) 実際に死ぬまでに出た出力は **live に1件も届かず、省略の告知も無い**
 * (b) 再購読すると `exit` より**後ろに** out が並ぶ（終わったと言った後の出力）
 * (c) 出力が多いと `exit` 自身がリングから押し出されて**終端が消える**
 * が同時に起きていた。「省略したのに告知しない」型そのもの。
 * → **殺してから終端する**順序に変えた。
 */
test('🚨 exec: 停止した後の出力が exit の後ろに並ばない', async () => {
    const { child, url } = await startExec();
    try {
        // 出力を出し続けるプロセス（1ms ごとに 2KB）
        const script = "setInterval(() => process.stdout.write('x'.repeat(2048)), 1)";
        const s = await startSession(url, [process.execPath, '-e', script]);
        await s.until(r => r.t === 'out');
        await new Promise(r => setTimeout(r, 700));

        const kr = await fetch(`${url}/api/v0/exec/${s.id}/kill`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
        });
        assert.equal(kr.status, 200, `停止できない: ${kr.status}`);
        await s.until(r => r.t === 'exit', 20000);

        // (b) 台帳側（再購読）で exit が最後であること
        const rep = await fetch(`${url}/api/v0/exec/${s.id}/stream?from=0`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
        });
        assert.equal(rep.status, 200);
        const recs = (await rep.text()).split('\n').filter(Boolean).map(l => JSON.parse(l));
        const exitAt = recs.findIndex(r => r.t === 'exit');
        assert.notEqual(exitAt, -1, `再購読に exit が無い（終端が消えた）: ${recs.length} 件`);
        const after = recs.slice(exitAt + 1).filter(r => r.t === 'out' || r.t === 'err');
        assert.equal(after.length, 0,
            `exit の後ろに出力が ${after.length} 件並んでいる（終わったと言った後の出力）`);

        // (a) live が受けた最大通番が台帳の最大通番と一致すること（黙って捨てていない）
        const nums = r => r.filter(x => typeof x.n === 'number').map(x => x.n);
        const liveMax = Math.max(0, ...nums(s.seen));
        const ledgerMax = Math.max(0, ...nums(recs));
        assert.equal(liveMax, ledgerMax,
            `live が受け取れなかった出力がある（live ${liveMax} / 台帳 ${ledgerMax}）`);
        s.abort();
    } finally { child.kill(); }
});
/**
 * 🚨 **「停止しました」が実態と一致すること（9回目のレビュー / SERIOUS）。**
 *
 * `killTree()` の数え直しは**直接の子だけ**を見ていた。木から外れた孫は
 * `taskkill /T` にも `kill(-pgid)` にも当たらず、しかも数え直しに掛からないので
 * `/kill` は 200 `{ok:true}` を返し、台帳には `signal:"SIGKILL"` と
 * 「⚠ 停止しました」が残り、以後 sweeper も候補にしない = **回復経路が無い**。
 * レビュアーの実測では 200 を返した後も孫（pid 31596）が生きていた。
 * 観測ツールが「止めたつもりで走り続けている」と言うのは最悪の誤り。
 *
 * ここで測るのは **主張と実態の一致**（「殺せること」ではない）:
 *   孫が生きているなら 200 と「停止しました」を返してはいけない。
 *   孫が死んでいるなら 200 でよい。
 * POSIX では孫が `detached` で**プロセスグループから逃げる**ので
 * `kill(-pgid)` が当たらず生き残る → 修正前は必ず嘘になる（linux/darwin で変異を測る）。
 * Windows では `taskkill /T` が ppid を辿って孫まで落とすので、
 * 同じ形でも「殺せてしまう」= 一致する。
 *
 * ⚠️ **限界も測る（過大な主張をしないため）。** 撃つ**前**に親が終了していた孫は
 *    どちらのプラットフォームでも親子関係から辿れない（実測: `procTreePids` が
 *    「子孫なし」を返す）。これは #45 に残す。ここで守れるのは
 *    「撃つ時点で木に載っていた pid」だけである。
 */
test('🚨 exec: /kill の「停止しました」が実態と一致する（木を数え直す）', async () => {
    const { child, url } = await startExec();
    const pidFile = join(repo, 'escaped-grandchild.pid');
    const script = join(repo, 'escape-parent.mjs');
    let gcPid = null;
    try {
        // 中間（= 直接の子）は生き続け、孫だけがプロセスグループから逃げる。
        // 🚨 仕込みは必ず自死させる（テストが SIGKILL されたときに残さない）
        await writeFile(script, [
            'import { spawn } from "node:child_process";',
            'import { writeFileSync } from "node:fs";',
            'const gc = spawn(process.execPath, ["-e",',
            '    `require("fs").writeFileSync(process.argv[1], String(process.pid));`',
            '    + `setTimeout(() => process.exit(0), 30000);`,',
            '    process.argv[2]], { detached: true, stdio: "ignore" });',
            'gc.unref();',
            'writeFileSync(process.argv[3], String(gc.pid));',
            'setTimeout(() => process.exit(0), 30000);',
        ].join('\n'), 'utf8');
        const midPidFile = join(repo, 'escaped-mid.pid');
        const s = await startSession(url,
            [process.execPath, script, pidFile, midPidFile]);
        // 孫が起きるまで待つ（固定待ちにしない。#4）
        const { readFileSync, existsSync } = await import('node:fs');
        for (let i = 0; i < 100 && !existsSync(pidFile); i++) {
            await new Promise(r => setTimeout(r, 100));
        }
        assert.ok(existsSync(pidFile), '孫が起動しなかった（仕込みが壊れている）');
        gcPid = Number(readFileSync(pidFile, 'utf8'));
        assert.ok(gcPid > 0, `孫の pid が読めない: ${gcPid}`);

        const kr = await fetch(`${url}/api/v0/exec/${s.id}/kill`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
        });
        const kbody = await kr.text();
        // 実態: 孫が生きているか（少し待って、死ぬ猶予を与える）
        await new Promise(r => setTimeout(r, 600));
        let gcAlive = true;
        try { process.kill(gcPid, 0); } catch { gcAlive = false; }

        // 台帳の文言も見る（応答だけ直して note が嘘のまま、を防ぐ）
        const rep = await fetch(`${url}/api/v0/exec/${s.id}/stream?from=0`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
        });
        const recs = (await rep.text()).split('\n').filter(Boolean).map(l => JSON.parse(l));
        // ⚠️ 終端の理由は `exit` レコードではなく、その**直前の `err` 行**に流れる
        //    （`finish()` の実装。ここを間違えると常に空文字を見て緑になる）
        const errText = recs.filter(r => r.t === 'err').map(r => r.d ?? '').join('');
        const said = `${kbody} / 出力=${JSON.stringify(errText.slice(-200))}`;

        if (gcAlive) {
            assert.notEqual(kr.status, 200,
                `孫 ${gcPid} が生きているのに /kill が 200 を返した: ${said}`);
            // 「停止しました」と言い切っていないこと（UI にそのまま出る文言）
            assert.ok(!/停止しました/.test(errText),
                `孫が生きているのに「停止しました」と記録した: ${said}`);
            assert.match(kbody, /確認できませんでした/,
                `残った pid を告げていない: ${said}`);
            assert.match(kbody, new RegExp(String(gcPid)),
                `どの pid が残ったかを告げていない: ${said}`);
        } else {
            assert.equal(kr.status, 200,
                `孫は止まっているのに /kill が失敗した: ${said}`);
            assert.match(errText, /停止しました/, `終端の理由が残っていない: ${said}`);
        }
        s.abort();
    } finally {
        if (gcPid) {
            try { process.kill(gcPid, 'SIGKILL'); } catch { /* 既に死んでいる */ }
            if (process.platform === 'win32') {
                await new Promise(r => spawn('taskkill', ['/PID', String(gcPid), '/T', '/F'],
                    { windowsHide: true, stdio: 'ignore' }).on('close', r));
            }
        }
        child.kill();
        await rm(pidFile, { force: true });
        await rm(join(repo, 'escaped-mid.pid'), { force: true });
        await rm(script, { force: true });
    }
});

/**
 * 🚨 **終了処理（9回目のレビュー / SERIOUS 2件）。**
 *
 * (1) ハンドラは `SIGINT` と `SIGTERM` にしか付いていなかった。**`SIGHUP`（端末を
 *     閉じる）では既定動作でプロセスが消え、子は置き去りになる。** 常用の起動は
 *     端末に張り付いているので、端末を閉じるのは**普通の終わり方**であり、
 *     POSIX の子は `detached:true`（別プロセスグループ）なので端末の HUP は届かない。
 * (2) 終了処理に門が無く、掃き取りと `POST /api/v0/exec` が競争していた
 *     （`create()` → `spawn()` は実測 36〜43ms）。掃いた後に spawn された子は
 *     寿命管理の外に落ちる。
 * (3) `starting`（`child === null`）のセッションは黙って飛ばされていたので、
 *     終了処理の後に spawn されていた。
 *
 * ⚠️ **Windows では測れない。** `process.kill` は TerminateProcess 相当で
 *    ハンドラが走らない（`SIGBREAK` も同じ）。CI の linux / darwin で測る。
 *    変異にも `platforms` を書いてある。**ここが skip のときは緑と読まないこと。**
 */
/**
 * コマンド行に `needle` を含むプロセスの pid を数える。
 *
 * 🚨 **「調べられない」を「0 件」と言わない**（`{null}` を返して呼び出し側に
 *    「測れていない」と分からせる）。0 と言うと「置き去りは無い」という**断言**になる。
 */
async function pidsRunning(needle) {
    if (process.platform === 'win32') {
        // 🚨 **自分自身を数えない。** `-Command` の中に needle が入るので、
        //    問い合わせている PowerShell 自身が一致する。これで
        //    「置き去りが1本ある」という**偽の失敗**を出した（実測: 修正は効いて
        //    いたのに pid 15156 = PowerShell を数えていた）。
        //    `pgrep` は自分を除外するので POSIX 側では起きない差。
        const ps = 'Get-CimInstance Win32_Process '
            + `| Where-Object { $_.CommandLine -like '*${needle}*' `
            + '-and $_.ProcessId -ne $PID } '
            + '| ForEach-Object { $_.ProcessId }';
        return await new Promise(res => {
            const p = spawn('powershell', ['-NoProfile', '-Command', ps],
                { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
            let out = '';
            p.stdout.on('data', d => { out += d; });
            p.on('error', () => res(null));
            p.on('close', c => res(c === 0
                ? out.split('\n').map(x => x.trim()).filter(Boolean) : null));
        });
    }
    return await new Promise(res => {
        const p = spawn('pgrep', ['-f', needle], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        p.stdout.on('data', d => { out += d; });
        p.on('error', () => res(null));
        // ⚠️ pgrep は「1件も無い」を **exit 1** で返す。失敗と区別する
        p.on('close', c => res(c === 0 || c === 1
            ? out.split('\n').map(x => x.trim()).filter(Boolean) : null));
    });
}

test('🚨 終了: 子を回収し、終了処理中の実行を断り、残ったものを告げる', async () => {
    // 起動途中のセッションを作れるようにする（検査専用フラグ。既定 0）。
    // ⚠️ 終了処理は `--layout-probe` 配下の `/__shutdown` で起こす
    //    （Windows では signal でハンドラが走らないので、これが無いと
    //     終了処理の中身が CI 任せ = 手元で1つも測れない）
    const { child, url } = await startExec(['--exec-spawn-delay', '1500', '--layout-probe']);
    const stderr = [];
    child.stderr.on('data', d => stderr.push(String(d)));
    const midPidFile = join(repo, 'hup-mid.pid');
    const gcPidFile = join(repo, 'hup-escaped-grandchild.pid');
    const script = join(repo, 'hup-parent.mjs');
    let gcPid = null;
    try {
        // 直接の子: 自分の pid を書き、プロセスグループから逃げる孫を持つ
        await writeFile(script, [
            'import { spawn } from "node:child_process";',
            'import { writeFileSync } from "node:fs";',
            'writeFileSync(process.argv[2], String(process.pid));',
            'const gc = spawn(process.execPath, ["-e",',
            '    `require("fs").writeFileSync(process.argv[1], String(process.pid));`',
            '    + `setTimeout(() => process.exit(0), 30000);`,',
            '    process.argv[3]], { detached: true, stdio: "ignore" });',
            'gc.unref();',
            'setTimeout(() => process.exit(0), 30000);',
        ].join('\n'), 'utf8');

        const { readFileSync, existsSync } = await import('node:fs');
        const s = await startSession(url, [process.execPath, script, midPidFile, gcPidFile]);
        for (let i = 0; i < 150 && !(existsSync(midPidFile) && existsSync(gcPidFile)); i++) {
            await new Promise(r => setTimeout(r, 100));
        }
        assert.ok(existsSync(midPidFile) && existsSync(gcPidFile),
            '仕込みが起動しなかった（子 / 孫の pid が書かれていない）');
        const midPid = Number(readFileSync(midPidFile, 'utf8'));
        gcPid = Number(readFileSync(gcPidFile, 'utf8'));
        const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
        assert.ok(alive(midPid), `直接の子 ${midPid} が既に死んでいる（前提が崩れている）`);

        // (3) 起動途中のセッションを1本仕込む（spawn まで 1500ms 待つ）
        const startingPidFile = join(repo, 'hup-starting.pid');
        const startingScript = join(repo, 'hup-starting.mjs');
        await writeFile(startingScript, [
            'import { writeFileSync } from "node:fs";',
            'writeFileSync(process.argv[2], String(process.pid));',
            'setTimeout(() => process.exit(0), 30000);',
        ].join('\n'), 'utf8');
        // 🚨 **中間シェルを挟む。** 直接の子は Windows では libuv の job object に
        //    入っていて、**デーモンが死ぬと一緒に落ちる**。だから直接の子で測ると
        //    印を外しても待つのをやめても**置き去りが観測できず、守りが検証されない**
        //    （実測: `shutdown-skips-starting` / `shutdown-no-wait-for-starting` が
        //     どちらも SURVIVED した）。孫は job から抜けるので生き残る =
        //    「終了処理が始末したか」を実際に測れる（既存の孫の検査と同じ理由）。
        const startingArgv = process.platform === 'win32'
            ? ['cmd', '/c', process.execPath, startingScript, startingPidFile]
            : ['sh', '-c', `"${process.execPath}" "${startingScript}" "${startingPidFile}" & wait`];
        const startingReq = fetch(`${url}/api/v0/exec`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            body: JSON.stringify({ worktree: repo, argv: startingArgv }),
        }).then(r => r.text()).catch(() => '');

        // 🚨 **本当に `starting` の状態で SIGHUP を撃つ。** 送った直後に撃つと、
        //    リクエストが `create()` に届く前に門（503）で断られて
        //    **「起動途中」を1度も作らずに緑になる**（SKIP を緑と読む型）。
        //    spawn の遅延は 1500ms なので、300ms 待てば必ず starting に居る。
        await new Promise(r => setTimeout(r, 300));

        const exited = new Promise(r => child.on('exit', () => r(true)));
        await fetch(`${url}/__shutdown`).then(r => r.text()).catch(() => '');

        // (2) 終了処理中は 503 を返す（黙って受理しない）。
        //     ⚠️ シグナルの配送は非同期なので「1回でも 503 を観測できるか」で測る。
        //     孫が逃げているので killTree が最大2秒数え直す = 窓は十分ある。
        let saw503 = false;
        let saw200AfterShutdown = false;
        for (let i = 0; i < 40; i++) {
            let st = 0;
            try {
                st = (await fetch(`${url}/api/v0/exec`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
                    body: JSON.stringify({ worktree: repo, argv: ['git', '--version'] }),
                })).status;
            } catch { break; }   // サーバが閉じた
            if (st === 503) saw503 = true;
            else if (st === 200 && saw503) saw200AfterShutdown = true;
            await new Promise(r => setTimeout(r, 50));
        }
        assert.ok(saw503, '終了処理中に 503 を返さなかった（新しい実行を受け付けている）');
        assert.ok(!saw200AfterShutdown, '503 の後に 200 で受理した（門が閉じ切っていない）');

        await Promise.race([exited, new Promise(r => setTimeout(r, 15000))]);
        assert.equal(child.exitCode !== null || child.signalCode !== null, true,
            '終了処理を起こしてもサーバが終わらなかった');

        // (1) 直接の子が回収されている
        for (let i = 0; i < 30 && alive(midPid); i++) await new Promise(r => setTimeout(r, 100));
        assert.ok(!alive(midPid),
            `直接の子 ${midPid} が置き去りになった`);

        // 🚨 止め切れなかったこと（プロセスグループから逃げた孫）を**黙って終わらない**。
        //    ⚠️ 「殺せること」ではなく **主張と実態の一致**を測る。孫が実際に
        //    生き残ったときだけ告知を要求する（消せていたなら告知は不要）。
        const err = stderr.join('');
        if (alive(gcPid)) {
            assert.match(err, /止め切れませんでした|確認できませんでした/,
                `残ったものを告げずに終了した: ${JSON.stringify(err.slice(-300))}`);
        }

        // (3) 起動途中だったセッションの子も置き去りにならない。
        //     🚨 pid ファイルの有無で測らない（書く前に殺されると
        //        「測らずに緑」になる）。**プロセスが居ないこと**を直接見る。
        await startingReq;
        await new Promise(r => setTimeout(r, 2500));   // spawn 遅延 1500ms + 余裕
        const leftover = await pidsRunning('hup-starting.mjs');
        assert.notEqual(leftover, null,
            'プロセスを数えられないので測れていない（緑と読まないこと）');
        for (const pid of leftover) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* noop */ } }
        assert.deepEqual(leftover, [],
            `起動途中だったセッションの子が置き去りになった（pid ${leftover.join(', ')}）`);
        await rm(startingPidFile, { force: true });
        await rm(startingScript, { force: true });
        s.abort();
    } finally {
        if (gcPid) { try { process.kill(gcPid, 'SIGKILL'); } catch { /* noop */ } }
        child.kill();
        for (const f of [midPidFile, gcPidFile, script]) await rm(f, { force: true });
    }
});

/**
 * 🚨 **`SIGHUP`（端末を閉じる）への登録そのものを測る。**
 *
 * 上の検査は `/__shutdown` で終了処理の**中身**を測る。中身が正しくても、
 * **どのシグナルに登録されているか**を間違えると同じ事故が起きる:
 * ハンドラは `SIGINT` / `SIGTERM` にしか付いていなかったので、
 * 端末を閉じる（= 常用の終わり方）と既定動作でプロセスが消え、
 * POSIX の子は別プロセスグループなので HUP が届かず**確実に生き残っていた**。
 *
 * ⚠️ **Windows では測れない。** `process.kill` は TerminateProcess 相当で
 *    ハンドラが走らない（`SIGBREAK` も同じ）。**ここが skip のときは
 *    「SIGHUP の登録は検証されていない」と読むこと**（CI の linux / darwin で測る）。
 */
test('🚨 終了: SIGHUP（端末を閉じる）でも子を置き去りにしない', {
    skip: process.platform === 'win32'
        ? 'Windows は process.kill でハンドラが走らない（TerminateProcess 相当）'
        : false,
}, async () => {
    const { child, url } = await startExec();
    const marker = join(repo, 'sighup-child.mjs');
    try {
        await writeFile(marker, 'setTimeout(() => process.exit(0), 30000);\n', 'utf8');
        const s = await startSession(url, [process.execPath, marker]);
        // 子が本当に動き出すまで待つ（起動途中に撃つと別の経路を測ってしまう）
        for (let i = 0; i < 100; i++) {
            const found = await pidsRunning('sighup-child.mjs');
            if (found && found.length) break;
            await new Promise(r => setTimeout(r, 100));
        }
        const before = await pidsRunning('sighup-child.mjs');
        assert.ok(before && before.length, `仕込みが起動していない: ${JSON.stringify(before)}`);

        const exited = new Promise(r => child.on('exit', () => r(true)));
        process.kill(child.pid, 'SIGHUP');
        await Promise.race([exited, new Promise(r => setTimeout(r, 15000))]);
        assert.ok(child.exitCode !== null || child.signalCode !== null,
            'SIGHUP でサーバが終わらなかった');

        let after = null;
        for (let i = 0; i < 30; i++) {
            after = await pidsRunning('sighup-child.mjs');
            if (after && after.length === 0) break;
            await new Promise(r => setTimeout(r, 100));
        }
        for (const pid of after ?? []) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* noop */ } }
        assert.deepEqual(after, [],
            `SIGHUP で子が置き去りになった（pid ${(after ?? []).join(', ')}）`);
        s.abort();
    } finally {
        child.kill();
        await rm(marker, { force: true });
    }
});

/**
 * 🔒 **全セッションの監視（N 個のエージェントを1画面で見るため）。**
 *
 * 購読しなくても「どれが動いていて、今何が出ているか」が分かる必要がある
 * （並列で走らせた Claude のどれに入力すべきかを判断するため）。
 * 🚨 出力はコマンドの結果なので **exec の関門を必ず通す**
 *    （Cookie だけの相手に渡すと「read は読み取りまで」が崩れる）。
 */
test('🔒 exec/list: 全セッションの状態と最後の出力が関門越しに取れる', async () => {
    const { child, url } = await startExec();
    const list = (headers = {}) => fetch(`${url}/api/v0/exec/list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
    });
    try {
        // 関門: トークン無し / GET は通さない
        assert.equal((await list()).status, 403, 'トークン無しで監視できる');
        // ⚠️ GET は **405**（Method Not Allowed）。403 を期待して落ちた
        //    — 期待値を書く前に「何が返るのが正しいか」を確かめること
        assert.equal((await fetch(`${url}/api/v0/exec/list`,
            { headers: { 'x-kjp-token': EXEC_TOKEN } })).status, 405, 'GET で通る');

        // 2本走らせる（片方は出力を出し、片方は入力待ち）
        const a = await startSession(url, [process.execPath, '-e',
            'console.log("AAA-marker"); setTimeout(()=>{}, 5000)']);
        const b = await startSession(url, [process.execPath, '-e', ECHO_SCRIPT]);
        await a.until(r => r.t === 'out' && r.d.includes('AAA-marker'));

        const r = await list({ 'x-kjp-token': EXEC_TOKEN });
        assert.equal(r.status, 200);
        const body = await r.json();
        assert.ok(Array.isArray(body.sessions), `一覧が無い: ${JSON.stringify(body)}`);
        assert.ok(body.sessions.length >= 2,
            `2本走らせたのに ${body.sessions.length} 本しか見えない`);

        // 🚨 **最後の出力が見える**（購読しなくても状況が分かる）
        const seenA = body.sessions.find(x => x.id === a.id);
        assert.ok(seenA, `走らせたセッションが一覧に無い: ${a.id}`);
        assert.equal(seenA.state, 'running');
        assert.match(seenA.lastOutput ?? '', /AAA-marker/,
            `最後の出力が見えない: ${JSON.stringify(seenA)}`);

        // 上限も返す（あと何本走らせられるか / いつ殺されるかが分かる）
        assert.equal(typeof body.limits.maxConcurrent, 'number');
        assert.ok(body.limits.timeoutMs > 0, '絶対上限が出ていない');

        a.abort();
        b.abort();
    } finally { child.kill(); }
});
test('🚨 exec: 標準入力に書けて、往復し、EOF で閉じられる', async () => {
    const { child, url } = await startExec();
    try {
        const s = await startSession(url, [process.execPath, '-e', ECHO_SCRIPT]);
        // 1ターン目
        const r1 = await sendInput(url, s.id, { data: 'hello\n' });
        assert.equal(r1.status, 200);
        assert.equal((await r1.json()).bytes, 6);
        await s.until(r => r.t === 'out' && r.d.includes('echo:hello'));

        // 2ターン目（同じプロセスに続けて送れる = 会話が成立する形）
        await sendInput(url, s.id, { data: 'second\n' });
        await s.until(r => r.t === 'out' && r.d.includes('echo:second'));

        // 入力も記録に残り、購読者に流れる（別端末から見ても何を送ったか分かる）
        const ins = s.seen.filter(r => r.t === 'in');
        assert.deepEqual(ins.map(r => r.d), ['hello\n', 'second\n']);

        // EOF で閉じる
        await sendInput(url, s.id, { eof: true });
        await s.until(r => r.t === 'out' && r.d.includes('eof'));
        await s.until(r => r.t === 'exit');

        // 閉じた後の書き込みは 409（黙って捨てない）
        const after = await sendInput(url, s.id, { data: 'late\n' });
        assert.equal(after.status, 409);
        s.abort();
    } finally { child.kill(); }
});

test('exec: 入力は再接続でも再生される（自分の発言が消えない）', async () => {
    const { child, url } = await startExec();
    try {
        const s = await startSession(url, [process.execPath, '-e', ECHO_SCRIPT]);
        await sendInput(url, s.id, { data: 'remembered\n' });
        await s.until(r => r.t === 'out' && r.d.includes('echo:remembered'));
        s.abort();

        const re = await fetch(`${url}/api/v0/exec/${s.id}/stream`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            body: JSON.stringify({ from: 0 }),
        });
        const rd = re.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        const got = [];
        while (!got.some(r => r.t === 'out' && r.d.includes('echo:remembered'))) {
            const { value, done } = await rd.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const parts = buf.split('\n');
            buf = parts.pop();
            for (const l of parts) if (l.trim()) got.push(JSON.parse(l));
        }
        assert.ok(got.some(r => r.t === 'in' && r.d === 'remembered\n'),
            `再接続で入力が再生されない: ${JSON.stringify(got.filter(r => r.t === 'in'))}`);
        await rd.cancel().catch(() => {});
    } finally { child.kill(); }
});

// 🚨 入力は自由文で、秘密が入りうる（パスワードやトークンを打つ場面がある）。
//    T5 と同じ理屈で**本文は監査に残さない**。残すのはバイト数だけ。
test('🚨 exec: 監査ログに入力の本文を残さない（バイト数だけ）', async () => {
    const { child, url } = await startExec();
    const SECRET = 'INPUT-SECRET-31337';
    try {
        const s = await startSession(url, [process.execPath, '-e', ECHO_SCRIPT]);
        await sendInput(url, s.id, { data: `${SECRET}\n` });
        await s.until(r => r.t === 'out' && r.d.includes(SECRET));

        const { readFile: rf } = await import('node:fs/promises');
        const raw = await rf(join(repo, '.git', 'kjp-exec-audit.jsonl'), 'utf8');
        assert.ok(!raw.includes(SECRET), '監査ログに入力の本文が残っている');
        const ev = raw.trim().split('\n').map(l => JSON.parse(l))
            .filter(e => e.session === s.id && e.event === 'input');
        assert.equal(ev.length, 1, `input が記録されていない: ${ev.length}`);
        assert.equal(ev[0].bytes, Buffer.byteLength(`${SECRET}\n`, 'utf8'),
            'バイト数が記録されていない（何も分からなくなる）');
        s.abort();
    } finally { child.kill(); }
});

test('🔒 exec: input も関門を通る（トークン無し / 終了後 / 不正な本文）', async () => {
    const { child, url } = await startExec();
    try {
        const s = await startSession(url, [process.execPath, '-e', ECHO_SCRIPT]);
        // トークン無し
        const noTok = await fetch(`${url}/api/v0/exec/${s.id}/input`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ data: 'x\n' }),
        });
        assert.equal(noTok.status, 403, 'トークン無しで標準入力に書けてしまった');
        // GET では書けない（副作用を GET で起こさない）
        const viaGet = await fetch(`${url}/api/v0/exec/${s.id}/input`, {
            headers: { 'x-kjp-token': EXEC_TOKEN },
        });
        assert.notEqual(viaGet.status, 200, 'GET で標準入力に書けてしまった');
        // data も eof も無い
        const empty = await sendInput(url, s.id, { nothing: true });
        assert.equal(empty.status, 400);

        // 終了したセッションには書けない
        await sendInput(url, s.id, { eof: true });
        await s.until(r => r.t === 'exit');
        const done = await sendInput(url, s.id, { data: 'x\n' });
        assert.equal(done.status, 409);
        s.abort();
    } finally { child.kill(); }
});

// 🚨 #26: 1回 64KB を縛っても、相手が読まなければ書いた分は親のメモリに
//    無限に溜まる。README の「上限 1回 64KB」は総量を縛っていないのに
//    縛られているように読めた。しかも溜まっている間も ok:true を返すので
//    画面から滞留が見えなかった。
test('🚨 exec: 標準入力の総量と滞留に上限がある（ok:true で隠さない）', async () => {
    const { child, url } = await startExec();
    try {
        // stdin を**読まない**プロセス
        const s = await startSession(url, [process.execPath, '-e', 'setTimeout(()=>process.exit(0),30000)']);
        let total = 0;
        let stopped = null;
        // 64KB を積み続ける。総量 4MB / 滞留 1MB のどちらかで止まるはず
        // 4MB / 60KB ≒ 68 回で上限に当たる。200 回は無駄
        for (let i = 0; i < 80; i++) {
            const r = await sendInput(url, s.id, { data: `${'z'.repeat(60 * 1024)}\n` });
            if (r.status === 200) {
                const j = await r.json();
                total = j.totalBytes;
                // 応答が滞留を見せていること（隠さない）
                assert.equal(typeof j.pending, 'number', '滞留が応答に出ていない');
                continue;
            }
            stopped = { status: r.status, error: (await r.json()).error };
            break;
        }
        assert.ok(stopped, `無制限に受け付けている（総量 ${Math.round(total / 1024)}KB）`);
        assert.ok([413, 429].includes(stopped.status),
            `想定外の拒否コード: ${JSON.stringify(stopped)}`);
        assert.match(stopped.error, /上限|読んでいません/);

        // 一覧にも総量と滞留が出る（画面から見える）
        const st = JSON.parse(await (await fetch(`${url}/api/v0/state?fresh=1`)).text());
        const one = st.execSessions.find(x => x.id === s.id);
        assert.ok(one.inputBytes > 0, '総量が一覧に出ていない');
        assert.equal(typeof one.inputPending, 'number', '滞留が一覧に出ていない');
        s.abort();
        await fetch(`${url}/api/v0/exec/${s.id}/kill`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
        }).catch(() => {});
    } finally { child.kill(); }
});

test('exec: 大きすぎる入力は拒否する', async () => {
    const { child, url } = await startExec();
    try {
        const s = await startSession(url, [process.execPath, '-e', ECHO_SCRIPT]);
        const big = await sendInput(url, s.id, { data: `${'x'.repeat(80 * 1024)}\n` });
        // ⚠️ 413 で返ること自体が検査対象。以前は req.destroy() していたので
        //    クライアントには『fetch failed』しか見えず、原因が分からなかった
        assert.equal(big.status, 413, '64KB を超える入力が通った（または応答が届いていない）');
        assert.match((await big.json()).error, /大きすぎます/);
        s.abort();
    } finally { child.kill(); }
});

test('🔒 exec: 標準入力の経路も --allow-exec なしでは存在しない', async () => {
    const s = await startAuthServer([]);
    try {
        const r = await fetch(`http://127.0.0.1:${s.port}/api/v0/exec/0123456789abcdef/input`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ data: 'x\n' }),
        });
        assert.equal(r.status, 403);
    } finally { s.child.kill(); }
});

// 🚨 4回目のレビュー（BLOCKING）: spawn の失敗は **'error' イベント**で来て
//    'exit' は来ない。以前は finish() を呼ぶ経路が無く、セッションが永久に
//    running のままで枠も返らなかった（起動していないプロセスを「実行中」と表示）。
test('🚨 exec: 起動できないコマンドでもセッションが終端し、枠が返る', async () => {
    const { child, url } = await startExec();
    try {
        // 存在しないコマンド。Windows では拡張子なしの `npm` も同じ経路
        const s = await startSession(url, ['no-such-command-xyz-9c1f']);
        // exit が来ること（来なければ「実行中」の嘘が残る）
        await s.until(r => r.t === 'exit');
        const exit = s.seen.find(r => r.t === 'exit');
        assert.equal(exit.code, null);
        assert.ok(s.seen.some(r => r.t === 'err' && /ENOENT|起動できません|実行エラー/.test(r.d)),
            `理由が出ていない: ${JSON.stringify(s.seen)}`);

        // 台帳でも done になっていること
        const st = JSON.parse((await (await fetch(`${url}/api/v0/state?fresh=1`)).text()));
        const one = st.execSessions.find(x => x.id === s.id);
        assert.equal(one.state, 'done', '起動していないプロセスが running のまま');
        s.abort();

        // 🚨 枠が返ること。上限を超える回数投げても最後まで受理される
        for (let i = 0; i < 10; i++) {
            const r = await fetch(`${url}/api/v0/exec`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
                body: JSON.stringify({ worktree: repo, argv: ['no-such-command-xyz-9c1f'] }),
            });
            assert.equal(r.status, 200, `${i + 1} 回目で枠が尽きた（枠が返っていない）`);
            await r.text();
        }
    } finally { child.kill(); }
});

// 🚨 4回目のレビュー（BLOCKING）: stdin の書き込み失敗は非同期の 'error' で来る。
//    listener が無いと uncaughtException で**デーモンが落ちる**（走っている
//    全セッションが消え、監査に exit が1件も残らない）。
test('🚨 exec: 相手が終わった直後に標準入力へ送ってもデーモンが落ちない', async () => {
    const { child, url } = await startExec();
    let died = null;
    child.on('exit', code => { died = code; });
    try {
        // すぐ終わるが stdin は読まないプロセス
        const s = await startSession(url, [process.execPath, '-e',
            'process.stdout.write("done\\n")']);
        await s.until(r => r.t === 'exit');
        s.abort();

        // 終了後に書く（409 が返るべき。落ちてはいけない）
        const after = await sendInput(url, s.id, { data: 'x'.repeat(40 * 1024) });
        assert.ok([409, 200].includes(after.status), `想定外の応答: ${after.status}`);

        // 走っている相手に大量に書いて、途中で相手が終わる形も試す
        const s2 = await startSession(url, [process.execPath, '-e',
            'setTimeout(()=>process.exit(0),150)']);
        for (let i = 0; i < 6; i++) {
            await sendInput(url, s2.id, { data: `${'y'.repeat(60 * 1024)}\n` }).catch(() => {});
            await new Promise(r => setTimeout(r, 60));
        }
        s2.abort();

        // 🚨 サーバが生きていること（ここが本体）
        await new Promise(r => setTimeout(r, 500));
        assert.equal(died, null, `デーモンが落ちた（exit=${died}）`);
        const alive = await fetch(`${url}/api/v0/state?fresh=1`);
        assert.equal(alive.status, 200, 'サーバが応答しない');
    } finally { child.kill(); }
});

// 🚨 `res.write()` は相手が読まなくてもメモリに積む。ブラウザのタブが停止した
//    まま出力の多いコマンドを走らせると RSS が 72MB → 433MB まで伸びた（レビューで実測）。
//    上限を超えたら**その購読者を切る**（データはリングバッファに残るので再接続で追いつける）。
test('🚨 exec: 読まない購読者は切られ、応答が無制限に溜まらない', async () => {
    const { child, url } = await startExec();
    try {
        // 大量に出力し続けるコマンド。購読側は**1バイトも読まない**
        const res = await fetch(`${url}/api/v0/exec`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            body: JSON.stringify({
                worktree: repo,
                argv: [process.execPath, '-e',
                    'const s="x".repeat(64*1024);let i=0;'
                    + 'const t=setInterval(()=>{i++;process.stdout.write(s);'
                    + 'if(i>400)clearInterval(t)},1)'],
            }),
        });
        assert.equal(res.status, 200);
        // ⚠️ **1回だけ読んで、以後まったく読まない。**
        //    ループで読んでしまうと溜まらないので検査にならない（一度そう書いた）。
        //    読まないと undici がソケットから引き取らなくなり、
        //    サーバ側の res に溜まる = タブが停止した状態と同じ。
        const reader = res.body.getReader();
        await reader.read();

        // 監査に「切った」記録が出るまで待つ（固定時間で待たない）
        const { readFile: rf } = await import('node:fs/promises');
        const auditPath = join(repo, '.git', 'kjp-exec-audit.jsonl');
        let sawDrop = false;
        // ⚠️ 上限は短くする。4MB を超えるのは数秒なので 30 秒は無駄に待つだけ
        for (let i = 0; i < 60 && !sawDrop; i++) {
            await new Promise(r => setTimeout(r, 200));
            try { sawDrop = /drop-subscriber/.test(await rf(auditPath, 'utf8')); } catch { /* まだ無い */ }
        }
        assert.ok(sawDrop,
            '読まない購読者が切られない（応答が無制限に溜まる）。監査にも残っていない');

        // サーバは生きている（切ったのは購読者だけ）
        const st = JSON.parse(await (await fetch(`${url}/api/v0/state?fresh=1`)).text());
        assert.ok(Array.isArray(st.execSessions), 'サーバが応答しない');

        // ⚠️ **重いテストは自分の後始末をする。** 25MB を吐く子を残すと
        //    後続のテストが CPU / IO を奪われ、**別のテストが「起動しなかった」で
        //    落ちる**（CI で実際に2件落ちた。原因の心当たりはこれ）。
        //    サーバを kill するだけでは、Windows では SIGTERM ハンドラが走らず孫が残る。
        for (const s of st.execSessions.filter(x => x.state === 'running')) {
            await fetch(`${url}/api/v0/exec/${s.id}/kill`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            }).catch(() => {});
        }
    } finally { child.kill(); }
});

test('🔒 exec: 不正なセッション id と知らない id を弾く', async () => {
    const { child, url } = await startExec();
    try {
        const call = (id, path = 'stream') => fetch(`${url}/api/v0/exec/${id}/${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            body: '{}',
        });
        // 形が違うもの（長さ違い・大文字）は 400 で弾く
        for (const bad of ['xyz', '0123456789ABCDEF', '0123456789abcde', '0123456789abcdef0']) {
            const r = await call(bad);
            assert.equal(r.status, 400, `不正な id が通った: ${bad}`);
        }
        // パス走査は経路に届く前に消える。`..` も `%2e%2e` も new URL() が
        // デコードして正規化するので `/api/v0/stream` になり、どのルートにも当たらない。
        // **「400 で弾いた」ではなく「そもそも届いていない」**ので 404 を期待する。
        for (const bad of ['..', '%2e%2e', '%2E%2E']) {
            const r = await call(bad);
            assert.ok(r.status !== 200, `パス走査が通った: ${bad} → ${r.status}`);
            assert.equal(r.status, 404, `${bad} の扱いが変わった（正規化に頼っている前提が崩れた）`);
        }
        // 形は正しいが存在しない
        const r = await call('0123456789abcdef');
        assert.equal(r.status, 404);
        // 🔒 トークン無しでは経路そのものが無い
        const noTok = await fetch(`${url}/api/v0/exec/0123456789abcdef/kill`, { method: 'POST' });
        assert.equal(noTok.status, 403, 'トークン無しで kill できてしまった');
    } finally { child.kill(); }
});

test('実行セッションの一覧が state に出る（見えない取り残しを作らない）', async () => {
    const { child, url } = await startExec();
    try {
        const ac = new AbortController();
        const res = await fetch(`${url}/api/v0/exec`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            body: JSON.stringify({
                worktree: repo,
                // ⚠️ 秘密を argv に書かない。argv は「何を止めるか」の判断に必要なので
                //    一覧に**意図的に出している**。検査したいのは「出力が漏れないこと」
                argv: [process.execPath, '-e',
                    'process.stdout.write(["SECRET","EXEC","OUT","777"].join("-")+"\\n");'
                    + 'setTimeout(()=>process.exit(0),30000)'],
            }),
            signal: ac.signal,
        });
        const reader = res.body.getReader();
        await reader.read();
        await new Promise(r => setTimeout(r, 300));

        const st = await (await fetch(`${url}/api/v0/state?fresh=1`)).text();
        const s = JSON.parse(st);
        assert.ok(Array.isArray(s.execSessions), 'execSessions が出ていない');
        assert.equal(s.execSessions.length, 1);
        const one = s.execSessions[0];
        assert.equal(one.state, 'running');
        assert.equal(one.subscribers, 1);
        assert.ok(one.argv.includes(process.execPath), 'argv が出ていない（何を止めるか判断できない）');
        // ⚠️ 一覧に出力の中身を入れない（state は認証だけで読めるので）
        assert.ok(!st.includes('SECRET-EXEC-OUT-777'), '一覧に出力の中身が漏れている');
        ac.abort();
    } finally { child.kill(); }
});

test('--allow-exec なしでは execSessions が null（経路の存在も見せない）', async () => {
    const s = await startAuthServer([]);
    try {
        const st = JSON.parse((await authGet(s.port, '/api/v0/state?fresh=1')).body);
        assert.equal(st.execSessions, null);
    } finally { s.child.kill(); }
});

// 🚨 レビュアの指摘: 既存の「切断で子を殺す」テストは直接の子（node -e）しか見て
//    いなかった。Windows では libuv の job object が node 経由の孫まで巻き込むので、
//    その形では**永久に緑**だった。中間に cmd/sh を挟むと孫が残り、しかも孫が stdio を
//    握って `close` が来ないので枠が戻らず、8回のタイムアウトで exec が死んでいた。
test('🚨 exec: 中間シェルを挟んだ孫プロセスも殺し、枠を返す', async () => {
    const { child, url } = await startExec(['--exec-timeout', '2']);
    const beacon = join(repo, 'grandchild-beacon.txt');
    const script = join(repo, 'grandchild.mjs');
    try {
        // 🚨 **自死する仕込みにする。** 以前は `setInterval` だけで自分から
        //    終わらなかったので、テストが途中で止まった（SIGKILL / Ctrl+C）ときに
        //    **孫が無期限に生き残った**。実測で6本が動き続け、beacon が計 11MB、
        //    temp に33個のディレクトリが残っていた（レビューで指摘）。
        //    30秒で自死させる（この検査は数秒で終わるので影響しない）。
        await writeFile(script,
            'import {appendFileSync} from "node:fs";'
            + 'const t=setInterval(()=>{try{appendFileSync(process.argv[2],"x")}catch(e){}},100);'
            + 'setTimeout(()=>{clearInterval(t);process.exit(0)},30000);',
            'utf8');
        // 中間にシェルを挟む = Windows で npm test を動かす唯一の形
        const argv = process.platform === 'win32'
            ? ['cmd', '/c', process.execPath, script, beacon]
            : ['sh', '-c', `"${process.execPath}" "${script}" "${beacon}" & wait`];

        const r = await readExec(url, { worktree: repo, argv });
        // (a) 応答が完結する（exit が来る）。孫が stdio を握っていても閉じること
        assert.equal(r.status, 200);
        assert.equal(r.events.at(-1)?.t, 'exit',
            `応答が完結していない（close 待ちで固まっている）: ${JSON.stringify(r.events.slice(-3))}`);

        // (b) 孫が止まっている
        const { readFileSync } = await import('node:fs');
        await new Promise(res => setTimeout(res, 700));
        const a = readFileSync(beacon, 'utf8').length;
        await new Promise(res => setTimeout(res, 900));
        const b = readFileSync(beacon, 'utf8').length;
        assert.equal(b, a, `孫プロセスが生き残っている: ${a} → ${b}`);

        // (c) 枠が返っている（返らないと8回で exec が死ぬ）
        const ok = await readExec(url, { worktree: repo, argv: ['git', '--version'] });
        assert.equal(ok.status, 200, '枠が返っていない（429 になった）');
    } finally {
        child.kill();
        await rm(beacon, { force: true });
        await rm(script, { force: true });
    }
});

// 🚨 レビュアの指摘: 検査と予約の間に await があり、上限8に対して24本走った。
test('🚨 exec: 同時実行の上限が実際に効く', async () => {
    const { child, url } = await startExec();
    const controllers = [];
    try {
        const N = 14;
        const results = await Promise.all(Array.from({ length: N }, () => {
            const ac = new AbortController();
            controllers.push(ac);
            return fetch(`${url}/api/v0/exec`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
                body: JSON.stringify({
                    worktree: repo,
                    argv: [process.execPath, '-e', 'setTimeout(()=>process.exit(0),30000)'],
                }),
                signal: ac.signal,
            }).then(res => res.status).catch(() => 0);
        }));
        const accepted = results.filter(s => s === 200).length;
        const rejected = results.filter(s => s === 429).length;
        assert.ok(accepted <= 8, `上限 8 を超えて受理された: ${accepted} 本`);
        assert.ok(rejected >= N - 8, `429 が足りない（上限が効いていない）: 受理 ${accepted} / 拒否 ${rejected}`);
    } finally {
        for (const ac of controllers) ac.abort();
        await new Promise(r => setTimeout(r, 1200));
        child.kill();
    }
});

// 🚨 このテストは以前「bare worktree は smoke のフィクスチャに無いので、
//    無効な worktree で経路が閉じていることだけ確認する（bare の網羅は
//    unit 側の責務）」と書いていたが、**unit 側に bare のテストは無かった**。
//    つまり `wt.bare` / `wt.prunable` の門は exec も checkout も
//    **外しても全テストが緑**だった（過去2件と同じクラスの偽陽性。#33）。
//    ここで**本物の bare / prunable を作って**4つの門すべてを測る。
test('🚨 exec / checkout: bare と prunable の門が実際に効く', async () => {
    // 実体のある bare worktree と、実体を消した prunable worktree を用意する
    const stem = repo.split(/[\\/]/).pop();
    const bareWt = join(repo, '..', `${stem}-bare-real`);
    const goneWt = join(repo, '..', `${stem}-gone-real`);
    await g(['worktree', 'add', '--detach', goneWt, 'HEAD'], repo);
    // bare worktree は `worktree add` では作れないので、bare clone を追加する
    await g(['clone', '--bare', '--quiet', repo, bareWt], repo);

    const { child, url } = await startExec(['--allow-write']);
    try {
        // prunable にする（実体を消す。git はまだ台帳に持っている）
        await rm(goneWt, { recursive: true, force: true });
        const st = JSON.parse(await (await fetch(`${url}/api/v0/state?fresh=1`)).text());
        const prunable = st.worktrees.find(w => w.prunable);
        assert.ok(prunable, `prunable な worktree が payload に出ていない: `
            + `${JSON.stringify(st.worktrees.map(w => [w.name, w.prunable]))}`);

        // 1. exec は prunable を拒否する（cwd にすると ENOENT で経路が壊れる）
        const e1 = await readExec(url, { worktree: prunable.path, argv: ['git', '--version'] });
        assert.equal(e1.status, 409, 'exec が prunable を通した');

        // 2. checkout も prunable を拒否する
        const c1 = await fetch(`${url}/api/v0/checkout`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            body: JSON.stringify({ worktree: prunable.path, ref: 'main' }),
        });
        assert.equal(c1.status, 409, `checkout が prunable を通した: ${c1.status}`);
        // ⚠️ **理由まで見る。** 門を外しても git 自身が失敗して 409 を返すので、
        //    status だけでは「門が効いた」と「git が拒否した」を区別できない
        //    （最初そう書いて変異が生き残った）
        assert.match((await c1.json()).error, /作業ツリーが失われています/,
            '門ではなく git の失敗で 409 になっている（門を外しても緑になる）');

        // 🚨 2b. **merge も同じ門を持っているのに、検査が1件も無かった。**
        //     同じ形の門を後から足したときに測り忘れる（「規則を書いた場所から
        //     遠いコードには適用し忘れる」と同型）。理由まで見る。
        const m1 = await fetch(`${url}/api/v0/merge`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            body: JSON.stringify({ worktree: prunable.path, branch: 'main' }),
        });
        assert.equal(m1.status, 409, `merge が prunable を通した: ${m1.status}`);
        assert.match((await m1.json()).error, /作業ツリーが失われています/,
            'merge が門ではなく git の失敗で 409 になっている');

        // 3・4. bare は「既知の worktree」として出ないので、
        //       bare を cwd にしようとしても allowlist で止まる。
        //       ただし **bare が worktree 一覧に現れる構成**（bare リポジトリを
        //       --repo に渡した場合）では bare の門が唯一の守りになる。
        const bareSrv = spawn(process.execPath,
            [SERVER, '--repo', bareWt, '--port', '0', '--allow-exec',
                '--token', EXEC_TOKEN, '--allow-write'],
            { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
        bareSrv.stdout.setEncoding('utf8');
        bareSrv.stderr.setEncoding('utf8');
        let bnr = '';
        let berr = '';
        bareSrv.stderr.on('data', d => { berr += d; });
        try {
            const bUrl = await Promise.race([
                new Promise((res, rej) => {
                    bareSrv.stdout.on('data', d => {
                        bnr += d;
                        const m = bnr.match(/http:\/\/127\.0\.0\.1:\d+/);
                        if (m) setTimeout(() => res(m[0]), 400);
                    });
                    bareSrv.on('error', rej);
                    bareSrv.on('exit', () => setTimeout(() => rej(new Error(
                        `bare で起動しなかった\n  stdout: ${bnr}\n  stderr: ${berr}`)), 50));
                }),
                new Promise((_, rej) => setTimeout(() => rej(new Error(
                    `bare で起動しなかった\n  stdout: ${bnr}\n  stderr: ${berr}`)), 20000)),
            ]);
            const bst = JSON.parse(await (await fetch(`${bUrl}/api/v0/state?fresh=1`)).text());
            const bare = bst.worktrees.find(w => w.bare);
            assert.ok(bare, `bare な worktree が payload に出ていない: `
                + `${JSON.stringify(bst.worktrees.map(w => [w.name, w.bare]))}`);

            // 3. exec は bare を拒否する（作業ツリーが無い場所で任意コマンドが走る）
            const e2 = await fetch(`${bUrl}/api/v0/exec`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
                body: JSON.stringify({ worktree: bare.path, argv: ['git', '--version'] }),
            });
            assert.equal(e2.status, 400, 'exec が bare を通した（作業ツリーが無い場所で実行）');
            assert.match((await e2.json()).error, /bare/);

            // 4. checkout も bare を拒否する
            const c2 = await fetch(`${bUrl}/api/v0/checkout`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
                body: JSON.stringify({ worktree: bare.path, ref: 'main' }),
            });
            assert.equal(c2.status, 400, 'checkout が bare を通した');

            // 4b. merge も bare を拒否する（同じ門を後から足したので一緒に測る）
            const m2 = await fetch(`${bUrl}/api/v0/merge`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
                body: JSON.stringify({ worktree: bare.path, branch: 'main' }),
            });
            assert.equal(m2.status, 400, 'merge が bare を通した');
            assert.match((await m2.json()).error, /bare/);
        } finally {
            bareSrv.kill();
        }
    } finally {
        child.kill();
        await g(['worktree', 'prune'], repo).catch(() => {});
        await rm(bareWt, { recursive: true, force: true }).catch(() => {});
        await rm(goneWt, { recursive: true, force: true }).catch(() => {});
    }
});

test('🔒 --exec-timeout に数値でない値を渡したら起動を拒否する', async () => {
    for (const bad of ['abc', '0', '-5']) {
        const child = spawn(process.execPath,
            [SERVER, '--repo', repo, '--port', '0', '--allow-exec', '--token', EXEC_TOKEN,
                '--exec-timeout', bad],
            { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
        child.stderr.setEncoding('utf8');
        let err = '';
        child.stderr.on('data', d => { err += d; });
        const code = await new Promise(r => child.on('close', r));
        assert.equal(code, 1, `不正な値で起動してしまった: ${bad}`);
        assert.match(err, /--exec-timeout/);
    }
});

// 🚨 #1: `merge-tree --name-only` は**実在しないパス**を返す（実測: `thing~B`。
//    file と directory の衝突で git が退避先として作る名前）。それを普通の
//    ファイル名として出すと、押しても `/api/v0/diff` にも `blob` にも無いので
//    **開けない行き止まり**になっていた。判別して理由を添える。
test('🚨 衝突予測: 合成パスを印付けて「開けない理由」を出す', async () => {
    const stem = repo.split(/[\\/]/).pop();
    const wtA = join(repo, '..', `${stem}-synth-a`);
    const wtB = join(repo, '..', `${stem}-synth-b`);
    try {
        // 枝A: thing をディレクトリに / 枝B: thing をファイルに（file/directory 衝突）
        await g(['worktree', 'add', '-b', 'synth-a', wtA, 'main'], repo);
        await mkdir(join(wtA, 'thing'), { recursive: true });
        await writeFile(join(wtA, 'thing', 'inner.txt'), 'from A\n', 'utf8');
        // ⚠️ 候補ペアは「同じパスを触っている」ことで作るので、`thing` だけでは
        //    候補にならない（A は `thing/inner.txt`、B は `thing` で別のパス）。
        //    共通のファイルも衝突させて候補に入れる（候補生成の既知の限界）
        await writeFile(join(wtA, 'shared.txt'), 'A side\n', 'utf8');
        await g(['add', '-A'], wtA);
        await g(['commit', '-q', '-m', 'A: thing はディレクトリ'], wtA);

        await g(['worktree', 'add', '-b', 'synth-b', wtB, 'main'], repo);
        await writeFile(join(wtB, 'thing'), 'from B\n', 'utf8');
        await writeFile(join(wtB, 'shared.txt'), 'B side\n', 'utf8');
        await g(['add', '-A'], wtB);
        await g(['commit', '-q', '-m', 'B: thing はファイル'], wtB);

        const s = JSON.parse(await (await fetch(`${baseUrl}/api/v0/state?fresh=1`)).text());
        const pair = (s.conflicts ?? []).find(c => c.clean === false
            && (c.files ?? []).some(f => /~/.test(typeof f === 'string' ? f : f.path)));
        assert.ok(pair, '合成パスを含む衝突が出ていない'
            + `（conflicts: ${JSON.stringify((s.conflicts ?? []).map(c => [c.a, c.b, c.clean]))}）`);

        const synth = pair.files.find(f => typeof f === 'object' && f.synthetic);
        assert.ok(synth, `合成パスに印が付いていない: ${JSON.stringify(pair.files)}`);
        assert.match(synth.path, /~/);
        assert.equal(synth.of, 'thing', `実体のパスが分からない: ${JSON.stringify(synth)}`);
        assert.match(synth.why, /実在しません/);

        // 普通のファイルは印が付かない（過剰に印を付けていない）
        for (const f of pair.files) {
            if (typeof f !== 'object') continue;
            if (!/~/.test(f.path)) assert.equal(f.synthetic, false, `過剰に印を付けている: ${f.path}`);
        }
    } finally {
        await g(['worktree', 'remove', '--force', wtA], repo).catch(() => {});
        await g(['worktree', 'remove', '--force', wtB], repo).catch(() => {});
        await g(['branch', '-D', 'synth-a'], repo).catch(() => {});
        await g(['branch', '-D', 'synth-b'], repo).catch(() => {});
        await rm(wtA, { recursive: true, force: true }).catch(() => {});
        await rm(wtB, { recursive: true, force: true }).catch(() => {});
    }
});

/**
 * 🚨 **symlink 対 file の衝突でも合成パスに印が付くこと（#1）。**
 *
 * file/directory だけを検査していたので、もう一方の形（symlink 対 file）は
 * 未検証だった。⚠️ **Windows では symlink をファイルとして作れない**（EPERM。実測）。
 * そこで **git の index に mode 120000 で直接入れる**（`update-index --cacheinfo`）。
 * これならどのプラットフォームでも symlink のツリーを作れる。
 */
test('🚨 衝突予測: symlink 対 file の合成パスにも印が付く', async () => {
    const stem = repo.split(/[\\/]/).pop();
    const wtA = join(repo, '..', `${stem}-sym-a`);
    const wtB = join(repo, '..', `${stem}-sym-b`);
    try {
        // 枝A: link を **symlink** にする（index に mode 120000 で入れる）
        await g(['worktree', 'add', '-b', 'sym-a', wtA, 'main'], repo);
        // ⚠️ `hash-object --stdin` は入力を待って**ハングする**（stdin を渡していない）。
        //    ファイル経由にする。内容 = リンク先のパス（symlink の blob はそれ）
        await writeFile(join(wtA, '.link-target'), 'target.txt', 'utf8');
        const oid = (await g(['hash-object', '-w', join(wtA, '.link-target')], wtA)).trim();
        await g(['update-index', '--add', '--cacheinfo', `120000,${oid},link`], wtA);
        // 候補ペアにするため共通のファイルも衝突させる（候補生成の既知の限界）
        await writeFile(join(wtA, 'shared2.txt'), 'A side\n', 'utf8');
        await g(['add', 'shared2.txt'], wtA);
        await g(['commit', '-q', '-m', 'A: link は symlink'], wtA);
        const modeA = (await g(['ls-tree', 'sym-a', 'link'], wtA)).trim();
        assert.match(modeA, /^120000/, `symlink として入っていない: ${modeA}`);

        // 枝B: link を **通常ファイル**にする
        await g(['worktree', 'add', '-b', 'sym-b', wtB, 'main'], repo);
        await writeFile(join(wtB, 'link'), 'from B\n', 'utf8');
        await writeFile(join(wtB, 'shared2.txt'), 'B side\n', 'utf8');
        await g(['add', '-A'], wtB);
        await g(['commit', '-q', '-m', 'B: link は通常ファイル'], wtB);

        const st = JSON.parse(await (await fetch(`${baseUrl}/api/v0/state?fresh=1`)).text());
        // ⚠️ label は**ブランチ名ではなく worktree のディレクトリ名**（実測で気付いた）
        const isSym = v => /-sym-[ab]$/.test(String(v));
        const pair = (st.conflicts ?? []).find(c => isSym(c.a) && isSym(c.b));
        assert.ok(pair, `sym-a × sym-b の衝突が出ていない: ${JSON.stringify((st.conflicts ?? []).map(c => [c.a, c.b, c.clean]))}`);
        assert.equal(pair.clean, false, `衝突として出ていない: ${JSON.stringify(pair)}`);

        // 合成パス（`link~refs_heads_...`）に印と理由が付いていること
        const synth = (pair.files ?? []).find(f => typeof f === 'object' && f.synthetic);
        assert.ok(synth, `symlink 対 file で合成パスに印が付いていない: ${JSON.stringify(pair.files)}`);
        assert.match(synth.path, /~/);
        assert.equal(synth.of, 'link', `実体のパスが分からない: ${JSON.stringify(synth)}`);
        assert.match(synth.why, /実在しません/);
    } finally {
        await g(['worktree', 'remove', '--force', wtA], repo).catch(() => {});
        await g(['worktree', 'remove', '--force', wtB], repo).catch(() => {});
        await g(['branch', '-D', 'sym-a'], repo).catch(() => {});
        await g(['branch', '-D', 'sym-b'], repo).catch(() => {});
        await rm(wtA, { recursive: true, force: true }).catch(() => {});
        await rm(wtB, { recursive: true, force: true }).catch(() => {});
    }
});

// 🚨 #2: submodule は git 自身が「trivial なケースしか対応しない」と言う
//    （実測の stderr: `hint: Recursive merging with submodules currently only
//    supports trivial cases.`）。それを「衝突する」として出すのは
//    `{clean:false, conflicts:[]}` を返していた過去の不具合と同型の嘘。
test('🚨 衝突予測: submodule は「衝突する」ではなく「判定できない」', async () => {
    const stem = repo.split(/[\\/]/).pop();
    const subRepo = join(repo, '..', `${stem}-submod-src`);
    const wtA = join(repo, '..', `${stem}-submod-a`);
    const wtB = join(repo, '..', `${stem}-submod-b`);
    const allowFile = ['-c', 'protocol.file.allow=always'];
    try {
        // submodule 用のリポジトリ。**分岐した2つのコミット**を作る
        // （直系だと gitlink を fast-forward できて clean になる。実測で踏んだ）
        await mkdir(subRepo, { recursive: true });
        await g(['init', '-q', '-b', 'main'], subRepo);
        await writeFile(join(subRepo, 'f.txt'), 'v1\n', 'utf8');
        await g(['add', '-A'], subRepo);
        await g(['commit', '-q', '-m', 'v1'], subRepo);
        const c1 = (await g(['rev-parse', 'HEAD'], subRepo)).trim();
        await g(['checkout', '-q', '-b', 'x', c1], subRepo);
        await writeFile(join(subRepo, 'f.txt'), 'v2\n', 'utf8');
        await g(['add', '-A'], subRepo);
        await g(['commit', '-q', '-m', 'v2'], subRepo);
        const c2 = (await g(['rev-parse', 'HEAD'], subRepo)).trim();
        await g(['checkout', '-q', '-b', 'y', c1], subRepo);
        await writeFile(join(subRepo, 'f.txt'), 'v3\n', 'utf8');
        await g(['add', '-A'], subRepo);
        await g(['commit', '-q', '-m', 'v3'], subRepo);
        const c3 = (await g(['rev-parse', 'HEAD'], subRepo)).trim();

        // 親に submodule を入れて、2本の worktree で別のコミットを指す
        await g(['worktree', 'add', '-b', 'submod-a', wtA, 'main'], repo);
        await g([...allowFile, 'submodule', 'add', '-q', subRepo, 'mod'], wtA);
        await g(['-C', 'mod', 'checkout', '-q', c2], wtA);
        await writeFile(join(wtA, 'shared.txt'), 'A side\n', 'utf8');
        await g(['add', '-A'], wtA);
        await g(['commit', '-q', '-m', 'A: sub=v2'], wtA);

        await g(['worktree', 'add', '-b', 'submod-b', wtB, 'main'], repo);
        await g([...allowFile, 'submodule', 'add', '-q', subRepo, 'mod'], wtB);
        await g(['-C', 'mod', 'checkout', '-q', c3], wtB);
        await writeFile(join(wtB, 'shared.txt'), 'B side\n', 'utf8');
        await g(['add', '-A'], wtB);
        await g(['commit', '-q', '-m', 'B: sub=v3'], wtB);

        const s = JSON.parse(await (await fetch(`${baseUrl}/api/v0/state?fresh=1`)).text());
        // ⚠️ ラベルはブランチ名ではなく worktree のディレクトリ名由来
        //    （`kjp-smoke-XXXX-submod-a`）。末尾で照合する
        const pair = (s.conflicts ?? []).find(c =>
            [c.a, c.b].some(x => x.endsWith('-submod-a'))
            && [c.a, c.b].some(x => x.endsWith('-submod-b')));
        assert.ok(pair, `submodule のペアが候補に無い: `
            + `${JSON.stringify((s.conflicts ?? []).map(x => [x.a, x.b, x.clean]))}`);

        // submodule の path に「判定できない」印が付く
        const mod = (pair.files ?? []).find(f => typeof f === 'object' && f.undecidable);
        if (mod) {
            assert.match(mod.why, /submodule/);
            assert.equal(mod.path, 'mod');
        }
        // shared.txt も衝突しているので clean は false のまま（本物の衝突はある）。
        // 🚨 **submodule だけが衝突だった場合は null になる**ことが本題なので、
        //    そこは mergeplan の unit テストと git.mjs の実測で固定している。
        //    ここでは「submodule に理由が付く」ことを見る。
        assert.ok(mod || pair.clean === null,
            `submodule に理由が付いていない: ${JSON.stringify(pair)}`);
    } finally {
        await g(['worktree', 'remove', '--force', wtA], repo).catch(() => {});
        await g(['worktree', 'remove', '--force', wtB], repo).catch(() => {});
        await g(['branch', '-D', 'submod-a'], repo).catch(() => {});
        await g(['branch', '-D', 'submod-b'], repo).catch(() => {});
        for (const p of [wtA, wtB, subRepo]) await rm(p, { recursive: true, force: true }).catch(() => {});
    }
});

// ---------------------------------------------------------------------------
// 🔒 読み取り経路の認証（#6 の 1・2）
//
// これが無い間、読み取りを守っていたのは Host 許可 + Sec-Fetch-Site だけで、
// **トンネルに届く相手（tailnet の全端末）は誰でも差分を読めた。**
// 標準入力の経路（#18）を開ける前提なので、ここを固定する。
//
// ⚠️ Host を検証する種類のテストは fetch で書かない。undici は Host を
//    上書きできず黙って既定値を送るので、「防がれた」ではなく
//    「攻撃を送れていない」を見てしまう（実際に偽陽性を出した）。
//    ここは node:http の request() を使う。
// ---------------------------------------------------------------------------

/** 独立したサーバを起動して port と banner を返す */
async function startAuthServer(extra) {
    const child = spawn(process.execPath, [SERVER, '--repo', repo, '--port', '0', ...extra],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let banner = '';
    // 🚨 **stderr を捨てない。** 起動に失敗した理由は stderr に出るので、
    //    捨てると CI で「起動しなかった:」だけが残り**原因が完全に消える**
    //    （実際にそうなって1往復無駄にした）。終了コードも添える。
    let errOut = '';
    let exited = null;
    child.stderr.on('data', d => { errOut += d; });
    child.on('exit', (code, signal) => { exited = `exit=${code} signal=${signal}`; });
    // ⚠️ 何を待っていたのかも書く。「起動しなかった」だけでは、
    //    プロセスが出てこなかったのかトークンの案内を待っていたのか区別できない
    // 🚨 **経過時間と基準値を添える（#34）。** 起動は実測で**中央 107ms**
    //    （worktree 4本、`--allow-host` / `--watch-agents` を付けても同じ。
    //     疑われていた `git rev-parse` の正規化は原因ではなかった）。
    //    つまり上限に当たったなら「遅い経路」ではなく**200倍以上の飢餓**で、
    //    上限を上げるのは対策にならない。**数字を残して次回に判断させる。**
    const startedAt = Date.now();
    const why = () => `起動しなかった（${Date.now() - startedAt}ms 待った。`
        + '実測の基準は 107ms なので、これは遅さではなく飢餓か起動失敗）'
        + '\n  待っていたもの: URL'
        + `${extra.some(a => ['--require-auth', '--allow-host', '--allow-write',
            '--allow-exec', '--token-file', '--token'].includes(a)) ? ' + ?token=' : ''}`
        + `\n  argv: ${extra.join(' ') || '(なし)'}`
        + `\n  stdout: ${banner.trim() || '(空)'}`
        + `\n  stderr: ${errOut.trim() || '(空)'}\n  ${exited ?? '(まだ生きている)'}`;
    // 🚨 **トークンの案内は URL とは別のチャンクで来る。** 以前は URL が出てから
    //    固定 400ms 待っていたので、遅い CI では取り逃して `banner()` から token が
    //    取れず、テストは「起動しなかった」ではなく**401 の山**になっていた。
    // 🚨 **かわりに「出るまで待つ」だけにしてもいけない。** 案内を出さない変異を
    //    掛けたとき、**永久に待って `node --test` ごとハングした**（CI で HUNG）。
    //    テスト側には `assert.ok(m, 'トークン付き URL が案内されない')` があるので、
    //    **来れば即座に、来なければ短い猶予で先に進む**のが正しい
    //    （待ちを失敗にせず、assert に判定させる）。
    const wantsToken = extra.some(a => ['--require-auth', '--allow-host', '--allow-write',
        '--allow-exec', '--token-file', '--token'].includes(a));
    const port = await Promise.race([
        new Promise((res, rej) => {
            // ⚠️ **絶対時間で待たない。** 「URL が出てから固定 3 秒」にしたら、
            //    30本のサーバが同時に立ち上がる全体実行で足りなくなり、
            //    トークンを取り逃してテストが落ちた（#34 と同型の flake を自分で作った）。
            //    バナーは1 tick で書かれるので、**stdout が落ち着いたら揃っている**。
            //    「最後のデータから 300ms 動きが無い」を合図にする（負荷に自動追従する）。
            let idle = null;
            let cap = null;
            const settle = port => {
                clearTimeout(idle);
                clearTimeout(cap);
                // 🚨 **落ちる前に証拠を残す（#34）。** 起動が基準（107ms）から桁違いに
                //    遅いとき、緑のうちに記録しておかないと「次に落ちたとき」しか気付けない。
                //    flaky は落ちてから調べても再現しないので、**緑の側で観測する。**
                const took = Date.now() - startedAt;
                if (took > 3000) {
                    slowStarts.push({ argv: extra.join(' ') || '(なし)', ms: took });
                }
                res(port);
            };
            child.stdout.on('data', d => {
                banner += d;
                const m = banner.match(/http:\/\/127\.0\.0\.1:(\d+)/);
                if (!m) return;
                if (!wantsToken || /\?token=[A-Za-z0-9_-]+/.test(banner)) { settle(Number(m[1])); return; }
                clearTimeout(idle);
                idle = setTimeout(() => settle(Number(m[1])), 300);
                // 上限。ここに達したら**待ちを失敗にせず assert に判定させる**
                // （待ちを失敗にすると、案内を出さない変異でハングした。CI で HUNG）
                cap ??= setTimeout(() => settle(Number(m[1])), 15000);
            });
            child.on('error', e => rej(new Error(`${why()}\n  spawn: ${e.message}`)));
            // 起動前に落ちたら待たずに失敗させる（20秒待つ意味がない）
            child.on('exit', () => setTimeout(() => rej(new Error(why())), 50));
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error(why())), 20000)),
    // 🚨 **待ちが失敗したら子を殺す。** 呼び出し側の `finally { s.child.kill() }` は
    //    `s` に代入される前に throw すると走らないので、**サーバが生き残る**。
    //    子の stdio パイプは親のイベントループを生かし続けるので、
    //    `node --test` が永久に終わらず**要約が出ないまま SIGKILL される**
    //    （原因が完全に消える形。CI で HUNG として実際に出た）。
    ]).catch(err => { try { child.kill(); } catch { /* noop */ } throw err; });
    return { child, port, banner: () => banner, stderr: () => errOut };
}

function authGet(port, path, headers = {}) {
    return new Promise(res => {
        const r = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, x => {
            let b = '';
            x.on('data', d => { b += d; });
            x.on('end', () => res({
                code: x.statusCode, body: b,
                setCookie: (x.headers['set-cookie'] ?? []).join(' '),
                location: x.headers.location ?? null,
            }));
        });
        r.on('error', e => res({ code: 0, body: e.message, setCookie: '', location: null }));
        r.end();
    });
}

// 🚨 5回目のレビューの BLOCKING。`/api/v0/session` の払い出しを
//    「トークンを提示した要求だけ」に締めたとき、**受け渡し経路を
//    `--require-auth` の中だけに残してしまった**。既定のループバック運用で
//    `--allow-write` だけを付けると、トークンは生成されるが**表示も永続化もされず**、
//    ブラウザが入手する手段が1つも無い。それでも UI は checkout を描くので
//    「有効に見えて必ず 403」だった（推奨の起動口 `serve.mjs --write` がこれ）。
test('🚨 --allow-write だけでも、ブラウザがトークンを入手できる経路がある', async () => {
    const s = await startAuthServer(['--allow-write']);
    try {
        const m = /\?token=([A-Za-z0-9_-]+)/.exec(s.banner());
        assert.ok(m, '書き込みを有効にしたのにトークン付き URL が案内されない'
            + `（UI から checkout が絶対にできない）:\n${s.banner()}`);
        const token = m[1];
        // 🔒 **URL の鍵では取れない**（URL は履歴・ブックマークに残るので、
        //    そこに載る値から書き込みの鍵を取れてはいけない。8回目のレビュー）
        const viaUrl = JSON.parse((await authGet(s.port, `/api/v0/session?token=${token}`)).body);
        assert.equal(viaUrl.token, null, 'URL の鍵で書き込みの鍵が取れてしまう');
        assert.equal(viaUrl.allowWrite, true, 'capability の表示は URL の鍵でも出す');
        // 貼り付け用の生の鍵が案内に出ていて、それでは取れる
        // （= 画面の「鍵を貼る」でページが sessionStorage に持てる）
        const raw = /^\s{5}([A-Za-z0-9._~-]{20,})\s*$/m.exec(s.banner())?.[1];
        assert.ok(raw && raw !== token,
            `貼り付け用の鍵が案内に出ていない（UI から checkout が絶対にできない）:\n${s.banner()}`);
        const sess = JSON.parse((await authGet(s.port, `/api/v0/session?token=${raw}`)).body);
        assert.equal(sess.token, raw, '貼り付け用の鍵でも取れない');
        assert.equal(sess.allowWrite, true);
        // 提示しなければ返らない（Cookie 経由の取り戻しは塞いだまま）
        const anon = JSON.parse((await authGet(s.port, '/api/v0/session')).body);
        assert.equal(anon.token, null, '無認証で払い出している');
    } finally { s.child.kill(); }
});

test('🚨 --allow-exec でもトークン付き URL が案内される', async () => {
    const s = await startAuthServer(['--allow-exec', '--token', EXEC_TOKEN]);
    try {
        assert.match(s.banner(), /\?token=/,
            `実行を有効にしたのにトークン付き URL が案内されない:\n${s.banner()}`);
    } finally { s.child.kill(); }
});

test('既定（ループバックのみ）では読み取りに認証を要求しない', async () => {
    const s = await startAuthServer([]);
    try {
        assert.equal((await authGet(s.port, '/api/v0/state')).code, 200);
        const sess = JSON.parse((await authGet(s.port, '/api/v0/session')).body);
        assert.equal(sess.requireAuth, false, '既定で認証が要求されている（摩擦を増やしている）');
        assert.ok(!/require-auth/.test(s.banner()), '既定なのに認証の案内が出ている');
    } finally { s.child.kill(); }
});

test('🔒 --require-auth: トークンが無い / 違うと 401、Cookie とヘッダで通る', async () => {
    // ⚠️ 生の鍵を明示する（案内の URL に載るのは**読み取り専用の派生秘密**に
    //    なったので、URL からは生の鍵が取れない。8回目のレビュー）
    const RAW = 'smoke-auth-raw-token-0123456789ab';
    const s = await startAuthServer(['--require-auth', '--token', RAW]);
    try {
        const token = /\?token=([A-Za-z0-9_-]+)/.exec(s.banner())?.[1];
        assert.ok(token && token.length >= 24, `起動時に鍵付き URL が出ていない: ${s.banner()}`);
        assert.notEqual(token, RAW, '案内の URL に生の鍵が載っている');

        assert.equal((await authGet(s.port, '/api/v0/state')).code, 401, 'トークン無しが通った');
        assert.equal((await authGet(s.port, '/api/v0/state',
            { 'x-kjp-token': 'wrong-value-0123456789abc' })).code, 401, '誤ったトークンが通った');
        // 読み取り用の鍵でも、生の鍵でも読める（どちらも読み取りの資格）
        assert.equal((await authGet(s.port, '/api/v0/state', { 'x-kjp-token': token })).code, 200);
        assert.equal((await authGet(s.port, '/api/v0/state', { 'x-kjp-token': RAW })).code, 200);

        // 🚨 **Cookie には生の鍵を入れない**（ポート分離が無いので
        //    他のローカルサービスに渡る）。ブートストラップが焼いた値だけが通る
        const raw = await authGet(s.port, '/api/v0/state', { cookie: `kjp_auth=${RAW}` });
        assert.equal(raw.code, 401, 'Cookie に生の鍵を入れて通ってしまった');
        const baked = /kjp_auth=([^;]+)/.exec((await authGet(s.port, `/?token=${token}`)).setCookie)?.[1];
        assert.ok(baked, 'Cookie が焼かれていない');
        assert.equal((await authGet(s.port, '/api/v0/state', { cookie: `kjp_auth=${baked}` })).code, 200,
            '焼かれた Cookie で読めない');

        // 401 の本文でトークンの手掛かりを与えない
        const deny = await authGet(s.port, '/api/v0/state');
        assert.ok(!deny.body.includes(token), '401 の本文にトークンが混ざっている');
    } finally { s.child.kill(); }
});

// 🚨 **同名 Cookie が複数来ても、正しいものが1本あれば通す。**
//    Cookie はポートで分離されない（RFC 6265）ので、`http://127.0.0.1:3000` など
//    任意のローカルページが `document.cookie = 'kjp_auth=junk; path=/api/v0'` を焼ける。
//    RFC 6265 §5.4.2 は **path の長い Cookie を先に並べる**ことを要求するので、
//    junk は `/api/v0/*` への全要求で決定論的に先頭に来る。最初の一致で return
//    していたため、**手で Cookie を消すまで 401 のまま**になっていた（#43）。
//    サーバが焼き直すのは `Path=/` なので上書きでは復旧できない
//    （トンネル越しのスマホからは最も消しにくい相手）。
test('🔒 --require-auth: 他ポートが焼いた同名 Cookie を先頭に置かれても締め出されない', async () => {
    const s = await startAuthServer(['--require-auth']);
    try {
        const token = /\?token=([A-Za-z0-9_-]+)/.exec(s.banner())?.[1];
        const baked = /kjp_auth=([^;]+)/.exec((await authGet(s.port, `/?token=${token}`)).setCookie)?.[1];
        assert.ok(baked, 'Cookie が焼かれていない');

        // ブラウザが実際に送る順（path の長い junk が先）
        assert.equal((await authGet(s.port, '/api/v0/state',
            { cookie: `kjp_auth=junk; kjp_auth=${baked}` })).code, 200,
        '先頭の偽 Cookie で締め出された（最初の一致で return していた）');
        // ページ本体も同じ関門を通る
        assert.equal((await authGet(s.port, '/',
            { cookie: `kjp_auth=junk; kjp_auth=${baked}` })).code, 200,
        'ページ本体が先頭の偽 Cookie で締め出された');
        // 対照: 正しいものが1本も無ければ通らない（「全部試す」を「素通し」にしない）
        assert.equal((await authGet(s.port, '/api/v0/state',
            { cookie: 'kjp_auth=junk; kjp_auth=junk2' })).code, 401,
        '偽 Cookie だけで通ってしまった');
        // 空の値が混ざっても落ちない（`kjp_auth=` は実際に焼かれうる）
        assert.equal((await authGet(s.port, '/api/v0/state',
            { cookie: `kjp_auth=; kjp_auth=${baked}` })).code, 200);
    } finally { s.child.kill(); }
});

// 🚨 Cookie はポートで分離されない（RFC 6265）。127.0.0.1 に焼いた Cookie は
//    127.0.0.1 の**他のポート全部**に送られるので、同じブラウザで別のローカル
//    サーバを開くとその中身が渡る。**実行トークンをそこに入れていた**ので、
//    受け取った相手は X-Kjp-Token に詰めるだけで任意コマンドを実行できた。
test('🚨 Cookie の値は実行トークンと別で、実行には使えない', async () => {
    const s = await startAuthServer(['--require-auth', '--allow-exec', '--token', EXEC_TOKEN]);
    try {
        // ⚠️ **リダイレクトしない**（ページの JS が ?token= を読んで
        //    sessionStorage に入れ、URL から消す）。Cookie は同時に焼かれる。
        const boot = await authGet(s.port, '/?token=' + EXEC_TOKEN);
        assert.equal(boot.code, 200, 'リダイレクトすると JS がトークンを見られない');
        const cookieVal = /kjp_auth=([^;]+)/.exec(boot.setCookie)?.[1];
        assert.ok(cookieVal, 'Cookie が焼かれていない');
        assert.notEqual(decodeURIComponent(cookieVal), EXEC_TOKEN,
            'Cookie に実行トークンがそのまま入っている（他のローカルサービスに渡る）');

        // Cookie では読み取りは通る
        assert.equal((await authGet(s.port, '/api/v0/state',
            { cookie: 'kjp_auth=' + cookieVal })).code, 200, 'Cookie で読めない');

        // 🚨 攻撃の実際の形: 他のローカルサービスは **Cookie を受け取っている**ので、
        //    Cookie と「Cookie の値をヘッダに詰めたもの」の両方を送れる。
        //    入口の認証は Cookie で通るが、**実行の関門で止まらなければならない。**
        const asHeader = await fetch('http://127.0.0.1:' + s.port + '/api/v0/exec', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                cookie: 'kjp_auth=' + cookieVal,
                'x-kjp-token': decodeURIComponent(cookieVal),
            },
            body: JSON.stringify({ worktree: repo, argv: ['git', 'status'] }),
        });
        assert.equal(asHeader.status, 403,
            `Cookie の値で実行できてしまった（分離できていない）: ${asHeader.status}`);
        // ⚠️ **Cookie の値をヘッダに詰めた要求は入口を通る（403 で止まる）。**
        //    8回目のレビューで、案内の URL に載せる鍵を**読み取り専用の派生秘密**に
        //    変えた。その値は Cookie と同じなので、ヘッダで来ても**読み取りとしては
        //    正式に受理する**（スマホがこの値をヘッダで送って読む）。
        //    露出は増えていない: Cookie を受け取った相手は元々読み取りができる。
        //    **重要なのは実行が 403 で止まること**（上の asHeader と同じ）。
        const noCookie = await fetch('http://127.0.0.1:' + s.port + '/api/v0/exec', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': decodeURIComponent(cookieVal) },
            body: JSON.stringify({ worktree: repo, argv: ['git', 'status'] }),
        });
        assert.equal(noCookie.status, 403,
            `読み取り用の鍵で実行できてしまった: ${noCookie.status}`);

        // 🚨 **これが4回目のレビューの BLOCKING 本体。**
        //    以前は /api/v0/session が Cookie 認証の要求に実行トークンを返していた。
        //    Cookie はポートで分離されないので、他のポートを開いた相手が
        //    **リクエスト1本多いだけで任意コード実行に到達していた。**
        //    `sameOrigin` は `!site || ...` なので Sec-Fetch-Site を送らない
        //    非ブラウザは素通りで、偽装すら要らなかった。
        const sess = await authGet(s.port, '/api/v0/session', { cookie: 'kjp_auth=' + cookieVal });
        assert.equal(sess.code, 200);
        assert.equal(JSON.parse(sess.body).token, null,
            'Cookie だけの要求に実行トークンを渡している（1本で RCE に到達する）');
        // トークン本体を提示した要求には渡す（ブラウザは ?token= で1回受け取る）
        const withTok = await authGet(s.port, '/api/v0/session', { 'x-kjp-token': EXEC_TOKEN });
        assert.equal(JSON.parse(withTok.body).token, EXEC_TOKEN,
            'トークンを持っている要求にも渡していない（UI が書き込めなくなる）');
    } finally { s.child.kill(); }
});

test('Cookie の値は再起動をまたいで同じ（--token-file なら開き直さなくて済む）', async () => {
    const a = await startAuthServer(['--require-auth', '--token', EXEC_TOKEN]);
    let first;
    try {
        first = /kjp_auth=([^;]+)/.exec((await authGet(a.port, '/?token=' + EXEC_TOKEN)).setCookie)?.[1];
    } finally { a.child.kill(); }
    const b = await startAuthServer(['--require-auth', '--token', EXEC_TOKEN]);
    try {
        const second = /kjp_auth=([^;]+)/.exec((await authGet(b.port, '/?token=' + EXEC_TOKEN)).setCookie)?.[1];
        assert.equal(second, first, '同じトークンなのに Cookie の値が変わった');
        // 前のサーバで焼いた Cookie がそのまま通る
        assert.equal((await authGet(b.port, '/api/v0/state', { cookie: 'kjp_auth=' + first })).code, 200);
    } finally { b.child.kill(); }
});

test('🔒 ?token= は読み取り用の Cookie を焼き、ページ本体を返す', async () => {
    // ⚠️ `--allow-write` を付ける（貼り付け用の生の鍵が案内に出るのはそのときだけ。
    //    Cookie と比べる対象がそれなので、付けないと比較が空振りする）
    const s = await startAuthServer(['--require-auth', '--allow-write']);
    try {
        const token = /\?token=([A-Za-z0-9_-]+)/.exec(s.banner())?.[1];
        const boot = await authGet(s.port, `/?token=${token}`);
        // 🚨 **リダイレクトしない。** 302 で URL からトークンを落としていたので、
        //    ページの JS がトークンを一度も見られず、書き込み用のトークンを
        //    /api/v0/session から取り戻す作りになっていた。それが
        //    「Cookie を持つ相手が実行に到達する」穴の原因（4回目のレビュー）。
        //    今はページが ?token= を読んで sessionStorage に入れ、URL から消す。
        assert.equal(boot.code, 200, 'リダイレクトすると JS がトークンを見られない');
        assert.match(boot.setCookie, /HttpOnly/, 'Cookie が HttpOnly でない');
        assert.match(boot.setCookie, /SameSite=Strict/, 'Cookie が SameSite=Strict でない');
        // ⚠️ Secure を付けると http のループバックで保存されず、ローカルで動かなくなる
        assert.ok(!/Secure/.test(boot.setCookie), 'Secure が付いている');
        // 焼かれるのは読み取り用の別の秘密（書き込み・実行の鍵ではない）
        const cookieVal = decodeURIComponent(/kjp_auth=([^;]+)/.exec(boot.setCookie)?.[1] ?? '');
        const raw = /^\s{5}([A-Za-z0-9._~-]{20,})\s*$/m.exec(s.banner())?.[1];
        assert.ok(raw, `貼り付け用の鍵が案内に出ていない: ${JSON.stringify(s.banner())}`);
        assert.notEqual(cookieVal, raw, 'Cookie に書き込み・実行の鍵が入っている');
        // ⚠️ 案内の URL の鍵は**Cookie と同じ読み取り用の値**（8回目のレビューの設計）。
        //    ここが違う値になったら、URL に別の秘密が載っている＝設計が戻っている
        assert.equal(cookieVal, token,
            '案内の URL の鍵が Cookie と別（URL に別の秘密を載せている）');
        // 🚨 **ここで JS の字面を assert しない。** 以前は
        //    `/sessionStorage\.setItem\(TOKEN_KEY, t\)/` などの**文字列一致**で見ていたが、
        //    ページの JS を1度も走らせていないので、行を残したまま到達不能にする変更
        //    （早期 return / `if (false && t)` で囲む / 使われない関数へ移す）が
        //    **完全に見えなかった**（#41。`core.fsmonitor` / `pathspec magic` と同じ型の偽陽性）。
        //    実際の挙動（sessionStorage に入る / URL から消える）は
        //    `v0/render-check.mjs` が**実ブラウザで**測っている。
    } finally { s.child.kill(); }
});

test('🚨 --require-auth では /api/v0/session が無認証でトークンを払い出さない', async () => {
    const s = await startAuthServer(['--require-auth', '--allow-write']);
    try {
        const token = /\?token=([A-Za-z0-9_-]+)/.exec(s.banner())?.[1];
        // ここが無認証で通ると、読み取りにトークンを要求しても意味が無い
        // （届く相手が誰でも取れるので、トークンは CSRF 対策でしかなくなる）
        const anon = await authGet(s.port, '/api/v0/session');
        assert.equal(anon.code, 401, '無認証でトークンを払い出している');
        assert.ok(!anon.body.includes(token), '401 の本文にトークンが入っている');

        // 🔒 **案内の URL の鍵（読み取り専用の派生秘密）では払い出さない。**
        //    以前はここで「払い出された値 === 案内の URL の値」を固定していた =
        //    **指摘された挙動そのものをテストが承認していた**（8回目のレビュー）。
        //    URL は履歴・ブックマークに残るので、そこに載る値で
        //    書き込みの鍵が取れてはいけない。
        const ok = await authGet(s.port, '/api/v0/session', { 'x-kjp-token': token });
        assert.equal(ok.code, 200, '読み取り用の鍵で /api/v0/session が読めない');
        const body = JSON.parse(ok.body);
        assert.equal(body.presented, 'read', `presented が read でない: ${body.presented}`);
        assert.equal(body.token, null,
            '案内の URL の鍵で書き込みの鍵を払い出している（URL から昇格できる）');

        // 生トークンなら払い出す（守りが広すぎないことも見る）
        const raw = /^\s{5}([A-Za-z0-9._~-]{20,})\s*$/m.exec(s.banner())?.[1];
        assert.ok(raw && raw !== token,
            `案内に貼り付け用の鍵が出ていない: ${JSON.stringify(s.banner())}`);
        const full = await authGet(s.port, '/api/v0/session', { 'x-kjp-token': raw });
        assert.equal(full.code, 200);
        const fb = JSON.parse(full.body);
        assert.equal(fb.presented, 'token');
        assert.equal(fb.token, raw, '生トークンを提示したのに払い出していない');
    } finally { s.child.kill(); }
});

test('🔒 --allow-host を付けると認証が既定で必須になる', async () => {
    const s = await startAuthServer(['--allow-host', 'box.example.test']);
    try {
        assert.equal((await authGet(s.port, '/api/v0/state')).code, 401,
            'トンネルを開けたのに無認証で読める');
        assert.match(s.banner(), /require-auth/);
        assert.match(s.banner(), /box\.example\.test\/\?token=/,
            'トンネル用の URL が案内に出ていない');
    } finally { s.child.kill(); }
});

// 🚨 認可より手前の同期例外は async ハンドラの unhandled rejection になり
//    **デーモンを exit 1 で落とす**。`new URL()` で一度直した型を
//    `decodeURIComponent`（Cookie）で再発させた。無認証で撃てる DoS。
test('🚨 壊れた Cookie / ヘッダでデーモンが落ちない（無認証で撃てる DoS）', async () => {
    const s = await startAuthServer(['--require-auth']);
    let died = null;
    s.child.on('exit', c => { died = c; });
    try {
        // 不正なパーセント encoding。decodeURIComponent が URIError を投げる
        for (const bad of ['kjp_auth=%', 'kjp_auth=%zz', 'kjp_auth=%E0%A4', 'kjp_auth=a%',
            'other=%; kjp_auth=%', 'kjp_auth']) {
            const r = await authGet(s.port, '/api/v0/state', { cookie: bad });
            assert.ok([401, 200, 400].includes(r.code),
                `想定外の応答（接続が切れた可能性）: ${bad} → ${r.code} ${r.body}`);
        }
        await new Promise(r => setTimeout(r, 400));
        assert.equal(died, null, `デーモンが落ちた（exit=${died}）`);

        // 落ちていないなら、正常な要求は引き続き通る
        const token = /\?token=([A-Za-z0-9_-]+)/.exec(s.banner())?.[1];
        assert.equal((await authGet(s.port, '/api/v0/state', { 'x-kjp-token': token })).code, 200);
    } finally { s.child.kill(); }
});

/**
 * 🚨 **最後の砦（top-level `.catch()`）そのものを測る。**
 *
 * 認可の手前の同期例外でデーモンが exit 1 する事故を2回起こしている
 * （`new URL` と `decodeURIComponent`）。その2つには個別の try/catch と変異が
 * あるのに、**汎用の砦には検査が1つも無かった**: `.catch(...)` を丸ごと消しても
 * smoke は全緑だった（#42）。しかも `cookie-decode-crash` の `also` は
 * `.catch(err => { throw err; }).catch(本体)` と書いていて、
 * **直後の catch が再捕捉するので砦は外れていなかった**（記録が事実と違っていた）。
 */
test('🚨 ハンドラが throw しても 500 を返してデーモンが生き続ける（最後の砦）', async () => {
    // `--layout-probe` 配下にある検査専用の経路（既定では存在しない）
    const child = spawn(process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--layout-probe'],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => { /* 例外のログが出るのは正しい挙動 */ });
    let died = null;
    child.on('exit', c => { died = c; });
    const url = await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('起動しなかった')), 15000);
        let buf = '';
        child.stdout.on('data', d => {
            buf += d;
            const m = buf.match(/http:\/\/127\.0\.0\.1:\d+/);
            if (m) { clearTimeout(t); res(m[0]); }
        });
        child.on('error', rej);
    // 🚨 待ちが失敗したら子を殺す。子の stdio パイプが node --test を生かし続け、要約が出ないまま SIGKILL される（原因が消える）
    }).catch(e => { try { child.kill(); } catch { /* noop */ } throw e; });
    try {
        // ⚠️ 2つの層を別々に測る。`/__throw` は**内側の try より手前**で投げるので
        //    top-level `.catch()` だけが受け止める。`/__throw-inner` は内側。
        for (const path of ['/__throw', '/__throw-inner', '/__throw', '/__throw-inner']) {
            const r = await fetch(`${url}${path}`);
            assert.equal(r.status, 500, `例外に 500 を返していない: ${path}`);
            // 🔒 例外のメッセージを返さない（内部のパスや git の出力が入りうる）
            assert.deepEqual(await r.json(), { error: 'internal error' },
                `本文に内部の詳細を出している: ${path}`);
        }
        await new Promise(r => setTimeout(r, 400));
        assert.equal(died, null, `例外でデーモンが落ちた（exit=${died}）`);
        // 落ちていないなら、後続の要求は通る
        assert.equal((await fetch(`${url}/api/v0/state?fresh=1`)).status, 200,
            '例外の後にサーバが応答しない');
    } finally { child.kill(); }
});

test('🔒 --no-auth と --allow-host の併用は起動を拒否する', async () => {
    const child = spawn(process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--allow-host', 'x.test', '--no-auth'],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
    child.stderr.setEncoding('utf8');
    let err = '';
    child.stderr.on('data', d => { err += d; });
    // ⚠️ 拒否されなかったときにサーバは動き続けるので、素の await にしない
    const code = await Promise.race([
        new Promise(r => child.on('close', r)),
        new Promise(r => setTimeout(() => r('timeout'), 15000)),
    ]);
    try {
        assert.equal(code, 1, `無認証でトンネルに出せてしまった（${code}）`);
        assert.match(err, /併用できません/);
    } finally { child.kill(); }
});

// ---------------------------------------------------------------------------
// L2 エージェントの活動観測
//
// 🚨 この機能は「出してはいけないものを出さない」ことが本体なので、
//    サーバ経路の端から端まで（記録ファイル → payload）で漏れないことを固定する。
//    抽出ロジック単体のテストは v0/transcript.test.mjs。
// ---------------------------------------------------------------------------

const AGENT_SECRET = 'SMOKE-TRANSCRIPT-SECRET-98765';

/**
 * 偽の `~/.claude/projects/` を作る。
 *
 * ⚠️ `os.homedir()` は POSIX で `HOME`、Windows で `USERPROFILE` を見るので、
 *    子プロセスの env を差し替えれば**オプションを増やさずに**隔離できる。
 *    検査用の経路をサーバに足さないための選択（`--layout-probe` を
 *    既定オフにしているのと同じ理屈）。
 */
async function fakeHome(cwdForRecords) {
    const home = await mkdtemp(join(tmpdir(), 'kjp-home-'));
    const dir = join(home, '.claude', 'projects', 'fake-project');
    await mkdir(dir, { recursive: true });
    const rows = [
        { type: 'assistant', timestamp: new Date().toISOString(), sessionId: 'sm1', cwd: cwdForRecords,
            message: { content: [{ type: 'text', text: `発話 ${AGENT_SECRET}` }] } },
        { type: 'assistant', timestamp: new Date().toISOString(), sessionId: 'sm1', cwd: cwdForRecords,
            message: { content: [{ type: 'thinking', thinking: `内心 ${AGENT_SECRET}` }] } },
        { type: 'user', timestamp: new Date().toISOString(), sessionId: 'sm1', cwd: cwdForRecords,
            toolUseResult: { stdout: AGENT_SECRET, stderr: '' },
            message: { content: [{ type: 'tool_result', content: `出力 ${AGENT_SECRET}` }] } },
        { type: 'file-history-snapshot', messageId: 'm1', snapshot: { 'shared.txt': AGENT_SECRET } },
        { type: 'last-prompt', lastPrompt: AGENT_SECRET, sessionId: 'sm1' },
        { type: 'assistant', timestamp: new Date().toISOString(), sessionId: 'sm1', cwd: cwdForRecords,
            message: { content: [{ type: 'tool_use', name: 'Bash',
                input: { command: `echo ${AGENT_SECRET}`, description: AGENT_SECRET } }] } },
        { type: 'assistant', timestamp: new Date().toISOString(), sessionId: 'sm1', cwd: cwdForRecords,
            message: { content: [{ type: 'tool_use', name: 'Edit',
                input: { file_path: join(cwdForRecords, 'shared.txt'), new_string: AGENT_SECRET } }] } },
    ];
    await writeFile(join(dir, 'sm1.jsonl'), `${rows.map(r => JSON.stringify(r)).join('\n')}\n`, 'utf8');
    // ⚠️ .jsonl 以外は開かないことの確認材料
    await writeFile(join(dir, 'notes.txt'), AGENT_SECRET, 'utf8');
    return home;
}

/** 偽 home を持たせたサーバを起動して payload を取る */
async function stateWithFakeHome(extraArgs, home) {
    const child = spawn(process.execPath, [SERVER, '--repo', repo, '--port', '0', ...extraArgs], {
        shell: false, windowsHide: true,
        env: {
            ...process.env, ...isolatedConfig(),
            HOME: home, USERPROFILE: home,
        },
    });
    child.stdout.setEncoding('utf8');
    let banner = '';
    try {
        const url = await Promise.race([
            new Promise((res, rej) => {
                child.stdout.on('data', d => {
                    banner += d;
                    const m = banner.match(/http:\/\/127\.0\.0\.1:\d+/);
                    if (m) res(m[0]);
                });
                child.on('error', rej);
            }),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`起動しなかった: ${banner}`)), 20000)),
        ]);
        const body = await (await fetch(`${url}/api/v0/state?fresh=1`)).text();
        return { body, json: JSON.parse(body), banner };
    } finally {
        child.kill();
    }
}

test('--watch-agents なしでは活動観測の経路が存在しない', async () => {
    const home = await fakeHome(repo);
    try {
        const { json, body } = await stateWithFakeHome([], home);
        assert.equal(json.agents, null, '経路が無いのに agents が入っている');
        assert.equal(json.agentsText, false);
        assert.ok(!body.includes(AGENT_SECRET));
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('🚨 --watch-agents: 活動は見えるが自由文は payload に1文字も入らない', async () => {
    const home = await fakeHome(repo);
    try {
        const { json, body, banner } = await stateWithFakeHome(['--watch-agents'], home);
        // 起動時に必ず告知する（いつリポジトリ外を読み始めたか分かるように）
        assert.match(banner, /活動観測 有効/);
        assert.match(banner, /リポジトリの外/);
        assert.ok(json.agents.length >= 1, 'agents が空');
        // worktree に紐づいていること（path と name が payload の worktree と一致する）
        const wtPaths = new Set(json.worktrees.map(w => w.path));
        for (const a of json.agents) {
            assert.ok(wtPaths.has(a.path), `agents の要素が worktree に紐づいていない: ${a.path}`);
        }
        const main = json.agents.find(a => (a.toolCounts?.Bash ?? 0) > 0);
        assert.ok(main, `活動が対応付けられていない: ${JSON.stringify(json.agents)}`);
        assert.equal(main.toolCounts.Bash, 1);
        assert.equal(main.toolCounts.Edit, 1);
        assert.equal(main.state, 'active');
        assert.ok(main.talk >= 1, '発話の件数は数える');
        assert.deepEqual(main.text, [], '本文は入れない');
        // 🚨 これが本体
        assert.ok(!body.includes(AGENT_SECRET),
            `自由文が payload に漏れている:\n${body.slice(0, 800)}`);
        // パスは出す（差分と同じ情報なので新しく漏れるものではない）
        assert.ok(main.recent.some(r => r.path === 'shared.txt'),
            `パスが出ていない: ${JSON.stringify(main.recent)}`);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('🚨 --allow-transcript-text でも T5（ツール結果・thinking）は出さない', async () => {
    const home = await fakeHome(repo);
    try {
        const { json, body, banner } = await stateWithFakeHome(['--allow-transcript-text'], home);
        assert.match(banner, /発話とコマンド行も出します/);
        assert.equal(json.agentsText, true);
        const main = json.agents.find(a => (a.toolCounts?.Bash ?? 0) > 0);
        // 出て良いのは text（発話1件）と Bash の command だけ = 2箇所
        const hits = body.split(AGENT_SECRET).length - 1;
        assert.equal(hits, 2, `漏れているものがある（期待 2 箇所、実際 ${hits}）`);
        assert.equal(main.text.length, 1);
        assert.equal(main.recent.find(r => r.tool === 'Bash').command, `echo ${AGENT_SECRET}`);
        // Edit の new_string は出さない
        assert.equal(main.recent.find(r => r.tool === 'Edit').command, undefined);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('活動観測は git の起動回数を増やさない（fs だけで読む）', async () => {
    const home = await fakeHome(repo);
    try {
        const off = await stateWithFakeHome([], home);
        const on = await stateWithFakeHome(['--watch-agents'], home);
        assert.equal(on.json.stats.gitSpawns, off.json.stats.gitSpawns,
            '活動観測で git の起動が増えている');
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('記録の場所が無ければ理由を errors に出し、観測は無効にしない', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kjp-nohome-'));
    try {
        const { json } = await stateWithFakeHome(['--watch-agents'], home);
        assert.deepEqual(json.agents, []);
        const e = (json.errors ?? []).find(x => x.scope === 'agents');
        assert.ok(e, `理由が出ていない: ${JSON.stringify(json.errors)}`);
        assert.match(e.message, /読めません/);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// L1 運用（毎日使うための足回り）
// ---------------------------------------------------------------------------

test('--repo にサブディレクトリを渡すとリポジトリのルートに正規化される', async () => {
    const sub = join(repo, 'sub-dir-for-test');
    await mkdir(sub, { recursive: true });
    const child = spawn(process.execPath, [SERVER, '--repo', sub, '--port', '0'],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
    child.stdout.setEncoding('utf8');
    try {
        const { url, banner } = await new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('起動しなかった')), 15000);
            let buf = '';
            child.stdout.on('data', d => {
                buf += d;
                const m = buf.match(/http:\/\/127\.0\.0\.1:\d+/);
                if (m && /repo:/.test(buf)) { clearTimeout(t); res({ url: m[0], banner: buf }); }
            });
            child.on('error', rej);
        // 🚨 待ちが失敗したら子を殺す。子の stdio パイプが node --test を生かし続け、要約が出ないまま SIGKILL される（原因が消える）
        }).catch(e => { try { child.kill(); } catch { /* noop */ } throw e; });
        assert.match(banner, /ルートに解決しました/, `正規化のログが無い: ${banner}`);
        const s = await (await fetch(`${url}/api/v0/state?fresh=1`)).json();
        // ⚠️ ルートに正規化しないと merge-tree が cwd 相対で `../shared.txt` を返し、
        //    isSafeRepoPath が弾いて UI から開けなくなる（レビュー指摘）
        for (const c of s.conflicts ?? []) {
            for (const f0 of c.files) {
                const f = typeof f0 === 'string' ? f0 : f0.path;
                assert.ok(!f.startsWith('..'), `衝突パスが cwd 相対になっている: ${f}`);
            }
        }
        assert.ok(s.worktrees.length >= 3, 'worktree が見えていない');
    } finally {
        child.kill();
        await rm(sub, { recursive: true, force: true });
    }
});

/**
 * 🚨 **linked worktree と bare も「リポジトリの中」。**
 *
 * メイン worktree の `--show-toplevel` だけを見ていたので、
 * **このツールが存在理由にしている linked worktree** が全部素通りしていた。
 * N 個のエージェントは常時 `git add -A` するので、置いたトークンはそのまま
 * commit に入る（実測で `git show HEAD:token` にトークン本体が出た）。
 * bare では `--show-toplevel` が exit 128 で落ち、catch → false で
 * **門が丸ごと無効**だった（#39）。
 */
test('🔒 --token-file: linked worktree と bare の中も拒否する', async () => {
    const lab = await mkdtemp(join(tmpdir(), 'kjp-tokgate-'));
    /** 起動を試みて「拒否された（exit 1）」か「起動した」かを返す */
    const tryStart = async (repoPath, tokenPath) => {
        const child = spawn(process.execPath,
            [SERVER, '--repo', repoPath, '--port', '0', '--allow-exec', '--token-file', tokenPath],
            { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        let err = '', out = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err += d; });
        // ⚠️ `await close` だけにしない。拒否されないとサーバは listen し続けて
        //    **永久に閉じない**（node --test ごとハングして原因が消える）
        const code = await Promise.race([
            new Promise(r => child.on('close', r)),
            new Promise(r => setTimeout(() => r('running'), 15000)),
        ]);
        child.kill();
        return { code, err, out };
    };

    try {
        const main = join(lab, 'main');
        await mkdir(main, { recursive: true });
        await g(['init', '-q', '-b', 'main'], main);
        await writeFile(join(main, 'f.txt'), 'x\n', 'utf8');
        await g(['add', '-A'], main);
        await g(['commit', '-q', '-m', 'seed'], main);
        const wtA = join(lab, 'wt-a');
        await g(['worktree', 'add', '-q', '-b', 'agent-a', wtA], main);
        const bare = join(lab, 'bare.git');
        await g(['clone', '-q', '--bare', main, bare], lab);

        // (1) linked worktree の中 → 拒否
        const a = await tryStart(main, join(wtA, 'token'));
        assert.equal(a.code, 1,
            `linked worktree の中のトークンファイルで起動してしまった（${a.code}）`
            + ' — エージェントが git add -A したらコミットに入る');
        assert.match(a.err, /リポジトリの中に置かないで/);

        // (2) bare リポジトリの中 → 拒否（rev-parse の失敗を「外」と読まない）
        const b = await tryStart(bare, join(bare, 'token'));
        assert.equal(b.code, 1,
            `bare の中のトークンファイルで起動してしまった（${b.code}）`
            + ' — --show-toplevel の失敗を catch して門が無効になっている');
        assert.match(b.err, /リポジトリの中に置かないで/);

        // (3) .git の中 → 拒否
        //     ⚠️ `.git/token` は `git add -A` では追跡されないので「コミットされる」は
        //        当てはまらない。それでもリポジトリを消すと一緒に消えるので置き場所として誤り。
        //        **理由が違うことをメッセージ側で言い分けている**（門は同じ）
        const c = await tryStart(main, join(main, '.git', 'token'));
        assert.equal(c.code, 1, `.git の中のトークンファイルで起動してしまった（${c.code}）`);

        // (4) 対照: どれの外でもある場所なら起動する（門が全部を拒否していないこと）
        const ok = await tryStart(main, join(lab, 'token'));
        assert.equal(ok.code, 'running',
            `リポジトリ外のトークンファイルで起動できない（${ok.code}）: ${ok.err}`);
    } finally {
        await rm(lab, { recursive: true, force: true }).catch(() => {});
    }
});

test('🔒 --token-file: 無ければ生成し、リポジトリの中は拒否する', async () => {
    const outside = join(repo, '..', `${repo.split(/[\\/]/).pop()}-tok`);
    // (1) 生成される
    let child = spawn(process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--allow-exec', '--token-file', outside],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
    child.stdout.setEncoding('utf8');
    try {
        const url = await new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('起動しなかった')), 15000);
            let buf = '';
            child.stdout.on('data', d => {
                buf += d;
                const m = buf.match(/http:\/\/127\.0\.0\.1:\d+/);
                if (m) { clearTimeout(t); res(m[0]); }
            });
            child.on('error', rej);
        // 🚨 待ちが失敗したら子を殺す。子の stdio パイプが node --test を生かし続け、要約が出ないまま SIGKILL される（原因が消える）
        }).catch(e => { try { child.kill(); } catch { /* noop */ } throw e; });
        const { readFile } = await import('node:fs/promises');
        const tok = (await readFile(outside, 'utf8')).trim();
        assert.ok(tok.length >= 24, `短いトークンが書かれた: ${tok.length} 文字`);
        // そのトークンで実際に通る（提示した要求にだけ返る）
        const s = await (await fetch(`${url}/api/v0/session`, {
            headers: { 'x-kjp-token': tok },
        })).json();
        assert.equal(s.token, tok, 'ファイルのトークンが使われていない');
        // 提示しなければ返らない（Cookie 経由の取り戻しを塞いだ）
        const anon = await (await fetch(`${url}/api/v0/session`)).json();
        assert.equal(anon.token, null, '無認証でトークンを払い出している');
    } finally {
        child.kill();
    }
    // (2) 同じファイルなら再利用される（再起動でトークンが変わらない）
    const { readFile } = await import('node:fs/promises');
    const first = (await readFile(outside, 'utf8')).trim();
    child = spawn(process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--allow-exec', '--token-file', outside],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
    child.stdout.setEncoding('utf8');
    try {
        await new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('起動しなかった')), 15000);
            let buf = '';
            child.stdout.on('data', d => {
                buf += d;
                if (/http:\/\/127\.0\.0\.1:\d+/.test(buf)) { clearTimeout(t); res(); }
            });
            child.on('error', rej);
        // 🚨 待ちが失敗したら子を殺す。子の stdio パイプが node --test を生かし続け、要約が出ないまま SIGKILL される（原因が消える）
        }).catch(e => { try { child.kill(); } catch { /* noop */ } throw e; });
        assert.equal((await readFile(outside, 'utf8')).trim(), first,
            '再起動でトークンが変わった（永続化できていない）');
    } finally {
        child.kill();
        await rm(outside, { force: true });
    }
    // (3) リポジトリの中は拒否する（コミットされるので）
    const inside = join(repo, 'tok');
    const bad = spawn(process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--allow-exec', '--token-file', inside],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
    bad.stderr.setEncoding('utf8');
    let err = '';
    bad.stderr.on('data', d => { err += d; });
    // ⚠️ 素の `await close` にしない。拒否されないと**サーバは正常に listen し続けて
    //    永久に閉じない** → node --test がハングし、SIGKILL されて要約が出ず、
    //    「smoke (0 pass, 0 fail)」だけが残って原因が消える（実際にそうなった）。
    //    失敗は失敗として観測できる形にする。
    const code = await Promise.race([
        new Promise(r => bad.on('close', r)),
        new Promise(r => setTimeout(() => r('timeout'), 15000)),
    ]);
    try {
        assert.equal(code, 1,
            `リポジトリ内のトークンファイルで起動してしまった（${code}）`
            + ' — containsPath が表記の違いで外れている可能性');
        assert.match(err, /リポジトリの中に置かないで/);
    } finally {
        bad.kill();
        await rm(inside, { force: true });
    }
});

test('🔒 --audit-log でリポジトリ外に監査ログを出せる', async () => {
    const outside = join(repo, '..', `${repo.split(/[\\/]/).pop()}-audit.jsonl`);
    const { child, url } = await startExec(['--audit-log', outside]);
    try {
        await readExec(url, { worktree: repo, argv: ['git', '--version'] });
        const { readFile } = await import('node:fs/promises');
        const log = await readFile(outside, 'utf8');
        // ⚠️ 生の正規表現で `git --version` を探してはいけない。
        //    JSON の中は ["git","--version"] なのでその文字列は現れない。
        //    行を JSON として読んで argv を比べる（最初これで自分のテストを落とした）。
        const lines = log.split('\n').filter(Boolean).map(l => JSON.parse(l));
        assert.ok(lines.some(e => e.argv?.join(' ') === 'git --version'),
            `外部の監査ログに記録が無い: ${log.slice(0, 200)}`);
        // 既定の場所には書かれていない（切り替わっていること）
        const { existsSync } = await import('node:fs');
        const def = join(repo, '.git', 'kjp-exec-audit.jsonl');
        const before = existsSync(def) ? (await readFile(def, 'utf8')).length : 0;
        await readExec(url, { worktree: repo, argv: ['git', 'rev-parse', 'HEAD'] });
        const after = existsSync(def) ? (await readFile(def, 'utf8')).length : 0;
        assert.equal(after, before, '既定の場所にも書かれている（切り替わっていない）');
    } finally {
        child.kill();
        await rm(outside, { force: true });
    }
});

test('checkout: hex を渡すと detached を警告する（黙って ok:true にしない）', async () => {
    const { child, url, session } = await startWritable();
    const stem = repo.split(/[\\/]/).pop();
    const wt = join(repo, '..', `${stem}-wt-b`);
    try {
        const oid = (await g(['rev-parse', 'main'], repo)).trim();
        const r = await fetch(`${url}/api/v0/checkout`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [session.tokenHeader]: session.token },
            body: JSON.stringify({ worktree: wt, ref: oid }),
        });
        const d = await r.json();
        assert.equal(r.status, 200, `hex での checkout が失敗: ${JSON.stringify(d)}`);
        assert.equal(d.detached, true, 'detached が報告されていない');
        assert.match(d.warning ?? '', /detached HEAD/, '警告が無い');
    } finally {
        child.kill();
        await g(['checkout', '--force', 'agent-b'], wt).catch(() => {});
    }
});

test('exec の監査ログが書かれる', async () => {
    const { child, url } = await startExec();
    try {
        await readExec(url, { worktree: repo, argv: ['git', '--version'] });
        const { readFile } = await import('node:fs/promises');
        const log = await readFile(join(repo, '.git', 'kjp-exec-audit.jsonl'), 'utf8');
        const lines = log.split('\n').filter(Boolean).map(l => JSON.parse(l));
        assert.ok(lines.some(e => e.event === 'start' && e.argv.join(' ') === 'git --version'),
            '開始が記録されていない');
        const exit = lines.find(e => e.event === 'exit' && e.argv.join(' ') === 'git --version');
        assert.ok(exit, '終了が記録されていない');
        assert.equal(exit.code, 0);
        assert.ok(exit.at, 'タイムスタンプが無い');
    } finally {
        child.kill();
    }
});

// ---------------------------------------------------------------------------
// 敵対的レビューで実証された穴の回帰テスト。
// いずれも「テストが緑のまま通り抜けていた」ものなので、まず落ちる形で書く。
// ---------------------------------------------------------------------------

/** 生ソケットで任意の request-target を送る（fetch では不正な target を送れない） */
function rawTarget(urlStr, target) {
    const u = new URL(urlStr);
    return new Promise((resolve, reject) => {
        const sock = netConnect({ host: u.hostname, port: Number(u.port) }, () => {
            sock.write(`GET ${target} HTTP/1.1\r\nHost: ${u.host}\r\nConnection: close\r\n\r\n`);
        });
        let buf = '';
        sock.setEncoding('utf8');
        sock.on('data', d => { buf += d; });
        sock.on('close', () => resolve(buf));
        sock.on('error', reject);
        setTimeout(() => { sock.destroy(); resolve(buf); }, 3000);
    });
}

// 🚨 認可の手前にある同期例外はプロセスを殺す。1パケットで無認証 DoS だった。
test('🚨 不正な request-target でデーモンが落ちない（認証前 DoS）', async () => {
    for (const target of ['//[', '//%zz', 'http://', 'http://[', '//[::1']) {
        const body = await rawTarget(baseUrl, target);
        assert.match(body, /^HTTP\/1\.1 400/, `400 が返っていない: ${target}`);
        // 直後に正常なリクエストが通る = プロセスが生きている（これが本題）
        const after = await fetch(`${baseUrl}/api/v0/state`);
        assert.equal(after.status, 200, `${target} の後にデーモンが死んでいる`);
    }
});

test('🔒 blob: reflog 経由（@{…}）で捨てたコミットを読めない', async () => {
    for (const bad of ['agent-a@{1}', 'main@{upstream}', '@', 'HEAD@{0}']) {
        const q = new URLSearchParams({ ref: bad, path: 'shared.txt' });
        const res = await fetch(`${baseUrl}/api/v0/blob?${q}`);
        assert.equal(res.status, 400, `reflog 式が通った: ${bad}`);
        // ⚠️ 400 だけを見てはいけない。**拒否理由**を確認する。
        //    reflog に該当エントリが無い / そのパスが古いコミットに無い場合も
        //    「見つかりません」で 400 になるので、検証を外しても緑のまま通り抜ける
        //    （突然変異テストで実際に survive した）。
        const d = await res.json();
        assert.match(d.error, /ref が不正です/,
            `入口の検証ではなく git 側の失敗で 400 になっている: ${bad} → ${d.error}`);
    }
});

test('🔒 diff: pathspec magic で他のファイルを含む差分を取れない', async () => {
    for (const bad of [':(exclude)shared.txt', ':!shared.txt', ':/shared.txt']) {
        const q = new URLSearchParams({ base: 'main', ref: 'agent-a', path: bad });
        const res = await fetch(`${baseUrl}/api/v0/diff?${q}`);
        assert.equal(res.status, 400, `pathspec magic が通った: ${bad}`);
    }
});

// 🚨 読み取り専用でも観測対象の設定由来のコマンドが動いていた。
test('🚨 読み取り専用の経路がリポジトリ設定のコマンドを実行しない（core.fsmonitor）', async () => {
    const marker = join(repo, 'fsmonitor-ran.txt').replace(/\\/g, '/');
    const hook = join(repo, 'fsmon.sh').replace(/\\/g, '/');
    // ⚠️ フックは **シェルスクリプト**で書く。git は fsmonitor を sh 経由で起動するので、
    //    `node <空白を含むパス> <script>` を設定すると**クォート不足で起動に失敗し、
    //    発火しないので「守れている」と誤判定する**（実際にこの偽陽性を作った）。
    //    実測: sh スクリプトなら発火 / -c core.fsmonitor=false で発火しない。
    //    CLAUDE.md の「スクリプトは .mjs のみ」はプロジェクトのスクリプトの規則で、
    //    ここは git のフック機構を再現するためのテストフィクスチャなので .sh が必要。
    await writeFile(hook, `#!/bin/sh\nprintf ran >> "${marker}"\n`, 'utf8');
    // ⚠️ 実行ビットを立てる。**Linux では実行できないフックは起動しない**ので、
    //    立て忘れると「発火しないから守れている」という偽陽性になる
    //    （ubuntu CI の突然変異テストで survive して発覚。Windows は exec ビットの
    //     概念が無いので手元では気付けなかった。プラットフォーム固有の偽陽性）。
    const { chmod } = await import('node:fs/promises');
    await chmod(hook, 0o755);
    await g(['config', 'core.fsmonitor', hook], repo);
    try {
        await fetch(`${baseUrl}/api/v0/state?fresh=1`);
        await new Promise(r => setTimeout(r, 300));
        const { existsSync } = await import('node:fs');
        assert.equal(existsSync(marker), false,
            'core.fsmonitor のコマンドが実行された（読み取り専用のはずの経路）');
    } finally {
        await g(['config', '--unset', 'core.fsmonitor'], repo).catch(() => {});
        await rm(hook, { force: true });
        await rm(marker, { force: true });
    }
});

test('🚨 checkout: オプション名のブランチで未コミットの変更が破棄されない', async () => {
    const { child, url, session } = await startWritable();
    const stem = repo.split(/[\\/]/).pop();
    const wt = join(repo, '..', `${stem}-wt-b`);
    const file = join(wt, 'only-b.txt');
    try {
        // git update-ref なら `--force` という名前の ref を作れてしまう
        const oid = (await g(['rev-parse', 'main'], repo)).trim();
        await g(['update-ref', 'refs/heads/--force', oid], repo);

        const { readFileSync } = await import('node:fs');
        await writeFile(file, '大事な未コミットの作業\n', 'utf8');
        const before = readFileSync(file, 'utf8');

        const r = await fetch(`${url}/api/v0/checkout`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [session.tokenHeader]: session.token },
            body: JSON.stringify({ worktree: wt, ref: '--force' }),
        });
        assert.equal(r.status, 400, 'オプション名の ref が通った');
        assert.equal(readFileSync(file, 'utf8'), before,
            '未コミットの変更が破棄された（オプション注入が成立している）');
    } finally {
        child.kill();
        await g(['update-ref', '-d', 'refs/heads/--force'], repo).catch(() => {});
        await g(['checkout', '--force', 'agent-b'], wt).catch(() => {});
        await rm(file, { force: true }).catch(() => {});
        await g(['checkout', '--force', 'agent-b'], wt).catch(() => {});
    }
});

// 🚨 CHERRY_PICK_HEAD が消えても sequencer/todo は残る。
//    これを取りこぼすと v0 自身の checkout で「残りが切り替え先にリプレイ」される。
test('🚨 checkout: sequencer/todo が残っている状態を拒否する', async () => {
    const { child, url, session } = await startWritable();
    const stem = repo.split(/[\\/]/).pop();
    const wt = join(repo, '..', `${stem}-wt-a`);
    try {
        // ⚠️ フィクスチャの agent-b は main から1コミットしか無いので、
        //    cherry-pick 用に2コミット持つブランチをここで作る。
        //    1つ目が衝突して停止し、2つ目が sequencer/todo に残るのが必要な形。
        await g(['checkout', '-q', '-b', 'seq-src', 'main'], repo);
        // shared.txt は agent-a も追加しているので add/add で衝突する
        await writeFile(join(repo, 'shared.txt'), 'from seq-src\n', 'utf8');
        await g(['add', '-A'], repo);
        await g(['commit', '-q', '-m', 'seq: 衝突する1つ目'], repo);
        await writeFile(join(repo, 'seq-second.txt'), 'second\n', 'utf8');
        await g(['add', '-A'], repo);
        await g(['commit', '-q', '-m', 'seq: 残る2つ目'], repo);
        await g(['checkout', '-q', 'main'], repo);

        const list = (await g(['rev-list', '--reverse', 'main..seq-src'], repo))
            .trim().split('\n').filter(Boolean);
        assert.equal(list.length, 2, `cherry-pick 対象が2件でない: ${list.length}`);
        await g(['cherry-pick', ...list], wt).catch(() => {});   // 衝突するので非0
        // --continue ではなく手で commit する → CHERRY_PICK_HEAD は消えるが todo は残る
        await g(['checkout', '--theirs', '.'], wt).catch(() => {});
        await g(['add', '-A'], wt).catch(() => {});
        await g(['commit', '--no-edit'], wt).catch(() => {});

        const st = await (await fetch(`${url}/api/v0/state?fresh=1`)).json();
        const target = st.worktrees.find(w => w.path.endsWith('-wt-a'));
        assert.equal(target.sequencer.sequencing, true,
            'setup 失敗: sequencer/todo が残っていない。前提が成立していない');
        assert.ok(target.warnings.some(w => w.code === 'sequencer-todo-left'),
            `警告が出ていない: ${JSON.stringify(target.warnings)}`);

        const r = await fetch(`${url}/api/v0/checkout`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [session.tokenHeader]: session.token },
            body: JSON.stringify({ worktree: wt, ref: 'main' }),
        });
        const d = await r.json();
        assert.equal(r.status, 409, `sequencer 残留中の checkout が通った: ${JSON.stringify(d)}`);
        assert.match(d.error, /sequencer/);
    } finally {
        child.kill();
        await g(['cherry-pick', '--quit'], wt).catch(() => {});
        await g(['reset', '--hard', 'agent-a'], wt).catch(() => {});
        await g(['checkout', '--force', 'agent-a'], wt).catch(() => {});
        await g(['checkout', '-q', '--force', 'main'], repo).catch(() => {});
        await g(['branch', '-D', 'seq-src'], repo).catch(() => {});
    }
});

test('解決できない --base を渡してもエンドポイントは生きている', async () => {
    // 別プロセスを立てて、存在しない ref を --base に渡す
    const child = spawn(
        process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--base', 'refs/heads/no-such-branch'],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } },
    );
    child.stdout.setEncoding('utf8');
    try {
        const url = await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('起動しなかった')), 15000);
            let buf = '';
            child.stdout.on('data', d => {
                buf += d;
                const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
                if (m) { clearTimeout(t); resolve(m[0]); }
            });
            child.on('error', reject);
        // 🚨 待ちが失敗したら子を殺す。子の stdio パイプが node --test を生かし続け、要約が出ないまま SIGKILL される（原因が消える）
        }).catch(e => { try { child.kill(); } catch { /* noop */ } throw e; });
        const res = await fetch(`${url}/api/v0/state`);
        assert.equal(res.status, 200, '壊れた --base で 500 にしてはいけない');
        const s = await res.json();
        // 自動推測にフォールバックしている
        assert.notEqual(s.base, 'refs/heads/no-such-branch');
        assert.ok(s.graph.length > 0, 'グラフが空になっている');
    } finally {
        child.kill();
    }
});

/**
 * 🔒 **トンネル越しだと「誰が動かしたか」が記録から消える。**
 *
 * `tailscale serve` はこのマシンで TLS を終端して 127.0.0.1 に中継するので、
 * **スマホからの実行も母艦のブラウザからの実行も記録上は同じ 127.0.0.1** になる
 * （`--exec` をトンネルに開けた後の実データで確認した）。
 * 中継が `x-forwarded-for` を付けているなら残す。ただし
 * 🚨 **これは自己申告で認可には使えない**（ループバックに届く相手なら誰でも書ける）ので、
 *    `xffReported` という名前にして、**peer を上書きしない**ことを固定する。
 */
test('🔒 監査は中継の申告（x-forwarded-for）を peer と別に残す', async () => {
    const audit = join(repo, '..', `xff-audit-${Date.now()}.jsonl`);
    const { child, url } = await startExec(['--audit-log', audit]);
    try {
        const r = await readExec(url, { worktree: repo, argv: ['git', '--version'] },
            { 'x-forwarded-for': '100.88.242.31, 10.0.0.1' });
        assert.equal(r.status ?? 200, 200, `実行できていない: ${JSON.stringify(r).slice(0, 120)}`);
        await new Promise(res => setTimeout(res, 300));
        const { readFile: rf } = await import('node:fs/promises');
        const lines = (await rf(audit, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
        const start = lines.find(e => e.event === 'start');
        assert.ok(start, `start が記録されていない: ${JSON.stringify(lines).slice(0, 200)}`);
        // 申告は残る（左端 = 元の相手だけ。中継の連なりは残さない）
        assert.equal(start.xffReported, '100.88.242.31',
            `中継の申告が残っていない: ${JSON.stringify(start)}`);
        // 🚨 **peer は上書きされない**（申告を実際の接続元として記録しない）
        assert.match(start.peer, /127\.0\.0\.1|::1|::ffff:127/,
            `申告で peer を上書きしている: ${start.peer}`);
    } finally {
        child.kill();
        await rm(audit, { force: true }).catch(() => {});
    }
});

test('中継が申告しなければ null（「分からない」を「無い」と書かない）', async () => {
    const audit = join(repo, '..', `xff-none-${Date.now()}.jsonl`);
    const { child, url } = await startExec(['--audit-log', audit]);
    try {
        await readExec(url, { worktree: repo, argv: ['git', '--version'] });
        await new Promise(res => setTimeout(res, 300));
        const { readFile: rf } = await import('node:fs/promises');
        const lines = (await rf(audit, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
        const start = lines.find(e => e.event === 'start');
        assert.ok(start, 'start が記録されていない');
        assert.ok('xffReported' in start, 'キーごと落ちている（有無が読めない）');
        assert.equal(start.xffReported, null);
    } finally {
        child.kill();
        await rm(audit, { force: true }).catch(() => {});
    }
});

/**
 * 🚨 **`.gitattributes` の filter は capability ゼロで任意コマンドを実行する（8回目のレビュー）。**
 *
 * `core.fsmonitor` と**完全に同じクラス**の穴が filter 側に残っていた。
 * コミット済みの `.gitattributes`（`*.txt filter=evil`）と `.git/config` の
 * `[filter "evil"] clean = <コマンド>` の2つで、**フラグを1つも付けていない
 * 読み取り専用デーモンが `/api/v0/state` を1回処理するだけで実行する**
 * （`git status` は作業ツリーと index の中身を比べるときに clean filter を通す）。
 * ⚠️ 中身のサイズが同じでないと git は比較を省くので、**同じ長さで**書き換える。
 */
test('🚨 status がリポジトリ設定の filter を実行しない（capability ゼロでの RCE）', async () => {
    // ⚠️ git の設定に入れる値なので区切りを / に直す（バックスラッシュはエスケープ扱い）
    const marker = join(repo, 'filter-ran.txt').split(sep).join('/');
    const target = join(repo, 'filtered.txt');
    try {
        await writeFile(target, 'aaaa\n', 'utf8');
        await writeFile(join(repo, '.gitattributes'), 'filtered.txt filter=evil\n', 'utf8');
        await g(['add', '-A'], repo);
        await g(['commit', '-q', '-m', 'chore: filter のテスト用'], repo);
        await g(['config', 'filter.evil.clean', `sh -c "printf ran > '${marker}'; cat"`], repo);
        // 同じ長さで書き換える（サイズが違うと git は中身を比べない = filter が走らない）
        await writeFile(target, 'bbbb\n', 'utf8');

        const s = await state();
        await new Promise(r => setTimeout(r, 400));
        const { existsSync } = await import('node:fs');
        assert.equal(existsSync(marker), false,
            'filter が実行された（フラグ無しの読み取り経路から任意コード実行）');
        // 無効化したことを必ず伝える（変更ありの判定が実際と違いうるので）
        // 🚨 **`/filter/` のような緩い照合にしない。** 最初そう書いたら、
        //    告知を丸ごと空にする変異が **SURVIVED した**（別の errors 要素に
        //    "filter" の字が入っていて当たっていた）。**告知の文そのもの**を見る。
        const notices = s.errors.filter(e => /を無効化して読みました/.test(e.message));
        assert.equal(notices.length, 1,
            `filter を無効化した旨の告知が1件でない: ${JSON.stringify(s.errors)}`);
        assert.match(notices[0].message, /evil/, '何を無効化したのか言っていない');
    } finally {
        await g(['config', '--unset', 'filter.evil.clean'], repo).catch(() => {});
        await rm(marker, { force: true });
        await rm(target, { force: true });
        await rm(join(repo, '.gitattributes'), { force: true });
        await g(['add', '-A'], repo).catch(() => {});
        await g(['commit', '-q', '-m', 'chore: filter のテスト後片付け'], repo).catch(() => {});
    }
});

/**
 * 🚨 **編集の経路も filter を実行しない（`status` と同じクラスの穴を作っていないこと）。**
 *
 * `POST /api/v0/file` は `fs` で読み、`POST /api/v0/write` は `fs` で書くので
 * filter は通らない**はず**。だが「はず」はコメントであってテストではない。
 * 追跡確認のために `git ls-files` を1回起動しているので、**そこが content
 * conversion を伴わないこと**を実測で固定する（`status` は伴うので実行された）。
 *
 * 🚨 **空振り防止に positive control を置く。** 素の `git status` で marker が
 * 書かれることを先に確かめる（`sh` が使えない環境なら filter そのものが走らないので、
 * 「守った」ではなく「攻撃を送れていない」を見てしまう）。
 */
test('🚨 write: 編集の経路がリポジトリ設定の filter を実行しない', async () => {
    // ⚠️ git の設定に入れる値なので区切りを / に直す（バックスラッシュはエスケープ扱い）
    const marker = join(repo, 'filter-ran-write.txt').split(sep).join('/');
    const target = join(repo, 'filtered-write.txt');
    const { existsSync } = await import('node:fs');
    let child = null;
    try {
        await writeFile(target, 'aaaa\n', 'utf8');
        await writeFile(join(repo, '.gitattributes'), 'filtered-write.txt filter=evil\n', 'utf8');
        await g(['add', '-A'], repo);
        await g(['commit', '-q', '-m', 'chore: 編集経路の filter テスト用'], repo);
        await g(['config', 'filter.evil.clean', `sh -c "printf ran > '${marker}'; cat"`], repo);
        // 同じ長さで書き換える（サイズが違うと git は中身を比べない = filter が走らない）
        await writeFile(target, 'bbbb\n', 'utf8');

        // ---- positive control: この環境では filter が**実際に走る**
        await g(['status', '--porcelain'], repo);
        assert.equal(existsSync(marker), true,
            'filter が走らない環境なので、この検査は何も測れていない（空振り）');
        await rm(marker, { force: true });

        // ---- 本題: 編集の2経路を通しても marker が書かれないこと
        const started = await startWritable();
        child = started.child;
        const url = started.url;
        const opened = await editPost(url, '/api/v0/file',
            { worktree: repo, path: 'filtered-write.txt' });
        // ⚠️ 本文は1回しか読めない。assert のメッセージの中で await res.text() を
        //    書くとテンプレートが先に評価されて body を消費し、後続が
        //    「Body is unusable」で落ちる（CLAUDE.md に書いてある罠を踏んだ）
        const d = await opened.json();
        assert.equal(opened.status, 200, JSON.stringify(d));
        // fs で読んでいるので**作業ツリーの中身**が返る（index の中身ではない）
        assert.equal(d.text, 'bbbb\n');
        const wrote = await editPost(url, '/api/v0/write', {
            worktree: repo, path: 'filtered-write.txt', text: 'cccc\n', baseOid: d.oid,
        });
        const dw = await wrote.json();
        assert.equal(wrote.status, 200, JSON.stringify(dw));
        await new Promise(r => setTimeout(r, 400));
        assert.equal(existsSync(marker), false,
            '編集の経路から filter が実行された（capability を1段上げる穴）');
        assert.equal(await readFile(target, 'utf8'), 'cccc\n');
    } finally {
        child?.kill();
        await g(['config', '--unset', 'filter.evil.clean'], repo).catch(() => {});
        await rm(marker, { force: true }).catch(() => {});
        await rm(target, { force: true }).catch(() => {});
        await rm(join(repo, '.gitattributes'), { force: true }).catch(() => {});
        await g(['add', '-A'], repo).catch(() => {});
        await g(['commit', '-q', '-m', 'chore: 編集経路の filter テスト後片付け'], repo).catch(() => {});
    }
});

/**
 * 🔒 **案内の URL に「実行できる鍵」を載せない（8回目のレビュー。SERIOUS）。**
 *
 * `--exec` のデーモンでは秘密が1本だったので、「スマホで1回開いてください」と
 * 案内する URL に**任意コード実行の資格情報が平文で載っていた**。
 * URL はアドレスバーに出て、入力履歴に入り、ブックマーク（クラウド同期）に残り、
 * クエリを記録する中継にも残る。`history.replaceState` では消せない。
 *
 * 案内の URL に載るのは**読み取り専用の派生秘密**だけで、
 * それでは exec / checkout / 鍵の払い出しが通らないことを固定する。
 */
test('🔒 案内の URL の鍵では実行できない（読み取りだけ通る）', async () => {
    const child = spawn(process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--allow-exec',
            '--token', EXEC_TOKEN, '--allow-host', 'box.example.net'],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
    child.stdout.setEncoding('utf8');
    let banner = '';
    try {
        const url = await new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error(`起動しなかった: ${banner}`)), 15000);
            child.stdout.on('data', d => {
                banner += d;
                const m = banner.match(/http:\/\/127\.0\.0\.1:\d+/);
                if (m) { clearTimeout(t); setTimeout(() => res(m[0]), 300); }
            });
            child.on('error', rej);
        });
        // 案内された URL から鍵を取り出す
        const m = /\?token=([A-Za-z0-9._~-]+)/.exec(banner);
        assert.ok(m, `案内の URL に ?token= が無い: ${banner}`);
        const urlKey = m[1];
        // 🚨 **これが生トークンと一致してはいけない**（一致していたのが指摘の本体）
        assert.notEqual(urlKey, EXEC_TOKEN,
            '案内の URL に実行トークンがそのまま載っている（履歴とブックマークに残る）');

        const H = k => ({
            'content-type': 'application/json', 'x-kjp-token': k,
            'sec-fetch-site': 'same-origin',
        });
        // 読み取りは通る（そのための鍵なので）
        const read = await fetch(`${url}/api/v0/state?fresh=1`, { headers: H(urlKey) });
        assert.equal(read.status, 200, `URL の鍵で読めない: ${read.status}`);
        await read.text();

        // 🔒 実行は通らない
        const ex = await fetch(`${url}/api/v0/exec`, {
            method: 'POST', headers: H(urlKey),
            body: JSON.stringify({ worktree: repo, argv: ['git', '--version'] }),
        });
        assert.equal(ex.status, 403, `URL の鍵で実行できてしまった: ${ex.status}`);
        await ex.text();

        // 🔒 **編集（作業ツリーへの書き込み）も通らない。**
        //    ⚠️ 経路を足したときにここへ足し忘れると、この分界だけ穴が残る
        //    （`--no-textconv` が `core.fsmonitor` と同じコミットなのに
        //     片方しか測られていなかったのと同じ形）。
        //    読む側も**作業ツリーを fs で読む**ので、読み取り用の鍵では通してはいけない。
        for (const route of ['/api/v0/file', '/api/v0/write']) {
            const w = await fetch(`${url}${route}`, {
                method: 'POST', headers: H(urlKey),
                body: JSON.stringify({
                    worktree: repo, path: 'README.md', text: 'overwritten\n',
                    baseOid: '0000000000000000000000000000000000000000',
                }),
            });
            assert.equal(w.status, 403, `URL の鍵で ${route} が通った: ${w.status}`);
            await w.text();
        }
        // **数え直す**: 中身が変わっていないこと（生トークンで通ることは別のテストが測る）
        assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), '# smoke\n');

        // 🔒 鍵の払い出しも通らない（ここが通ると1往復で昇格できる）
        const ses = await fetch(`${url}/api/v0/session`, { headers: H(urlKey) });
        const sj = await ses.json();
        assert.equal(sj.token, null, 'URL の鍵で実行トークンを払い出している');
        assert.equal(sj.presented, 'read', `presented が read でない: ${sj.presented}`);

        // 生トークンなら実行できる（守りが広すぎないことも見る）
        const ok = await fetch(`${url}/api/v0/exec`, {
            method: 'POST', headers: H(EXEC_TOKEN),
            body: JSON.stringify({ worktree: repo, argv: ['git', '--version'] }),
        });
        assert.equal(ok.status, 200, `生トークンで実行できない: ${ok.status}`);
        await ok.text();
    } finally {
        child.kill();
    }
});

/**
 * 🔒 **監査ログを worktree の中に置かせない（8回目のレビュー。MINOR）。**
 *
 * 監査ログは exec の argv を**マスクせずに**保存する（画面に出す側は maskSecrets を
 * 通すので、**ファイルの方が UI より秘密が多い**）。worktree の中に落ちると、
 * このツールが前提にしている「常時 `git add -A` する N 個のエージェント」が
 * そのままコミットし、push で外に出る。
 * `--token-file` には同じ理由の門が4行の説明付きであったのに、**こちらは素通り**だった。
 * ⚠️ `.git` の中（既定の置き場所）は許す — `git add -A` では追跡されないので。
 */
test('🔒 --audit-log を worktree の中に置くと起動を拒否する', async () => {
    const inside = join(repo, 'kjp-audit-in-repo.jsonl');
    const child = spawn(process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--allow-exec',
            '--token', EXEC_TOKEN, '--audit-log', inside],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
    child.stderr.setEncoding('utf8');
    let err = '';
    child.stderr.on('data', d => { err += d; });
    // 🚨 **待ち続ける形にしない。** 門を外すとサーバは正常に起動して
    //    `close` が永久に来ないので、`node --test` ごとハングして SIGKILL され、
    //    要約が出ず**原因が完全に消える**（変異が HUNG で報告された）。
    //    上限を付けて「拒否されなかった」を失敗として観測できる形にする。
    const code = await Promise.race([
        new Promise(r => child.on('close', r)),
        new Promise(r => setTimeout(() => r('タイムアウト（起動してしまった）'), 8000)),
    ]);
    child.kill();
    assert.equal(code, 1, `worktree の中を指したのに起動した: ${code} ${err}`);
    assert.match(err, /worktree の中に置かないでください/);
    // 理由を言う（黙って拒否しない）
    assert.match(err, /git add -A/);
    await rm(inside, { force: true }).catch(() => {});
});

test('--audit-log は .git の中なら通す（既定の置き場所を否定しない）', async () => {
    const dotGit = join(repo, '.git', 'kjp-audit-ok.jsonl');
    const child = spawn(process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--allow-exec',
            '--token', EXEC_TOKEN, '--audit-log', dotGit],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
    child.stdout.setEncoding('utf8');
    try {
        const started = await new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('起動しなかった')), 15000);
            let buf = '';
            child.stdout.on('data', d => {
                buf += d;
                if (/http:\/\/127\.0\.0\.1:\d+/.test(buf)) { clearTimeout(t); res(true); }
            });
            child.on('close', () => { clearTimeout(t); rej(new Error('起動せず終了した')); });
        });
        assert.equal(started, true);
    } finally {
        child.kill();
        await rm(dotGit, { force: true }).catch(() => {});
    }
});
// ---------------------------------------------------------------------------
// 🔒 複数リポジトリの切り替え。
//
// **読める範囲は起動時に固定する。** UI から任意のパスを開けるようにすると、
// トークンが1本漏れた時点で「マシン上の全 git リポジトリが読める」に化けるので、
// クエリの `?repo=` は**登録済み一覧との samePath() 照合**しか通さない。
// ここで固定するのは:
//   1. 一覧が返る（表示名は basename、衝突したらフルパス）
//   2. `?repo=` で切り替わる（`state.repo` も worktree も切り替わる）
//   3. **未登録のパスは 400**（読み取り・書き込み・実行の全部で）
//   4. 指定なしは既定（1本目）= 後方互換
//   5. **TTL キャッシュがリポジトリごとに分かれる**（混ざると別リポジトリの payload が返る）
//   6. worktree の allowlist が「選択中のリポジトリ」の一覧に対して引かれる
// ---------------------------------------------------------------------------

/**
 * パスのゆるい一致（この検査の中の**表示上の**照合だけに使う）。
 * ⚠️ 認可の照合はサーバ側の `samePath()` が持つ。ここでそれを再実装しない。
 */
// 🚨 **実体に解決してから比べる。** サーバは repo を
//    `git rev-parse --show-toplevel` で正規化するので、**git の綴り**が返る:
//    Windows CI の `os.tmpdir()` は `RUNNER~1`（8.3 短縮名）なのに git は
//    `runneradmin` を返し、macOS の `/var` は実体 `/private/var`。
//    素の綴りで比べていたので、**Windows と macOS の CI だけで 6 件落ちた**
//    （手元の Windows では短縮名にならないので出ない。CLAUDE.md のパスの節）。
const realish = p => {
    try { return realpathSync.native(p); } catch { return p; }
};
const flatten = p => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
const sameish = (x, y) => typeof x === 'string' && typeof y === 'string'
    && flatten(realish(x)) === flatten(realish(y));

/** 使い捨てのリポジトリを1本作る（コミット1本 + worktree 1本） */
async function makeRepo(dir, branch) {
    await mkdir(dir, { recursive: true });
    await g(['init', '-q', '-b', 'main'], dir);
    await g(['config', 'user.name', 't'], dir);
    await g(['config', 'user.email', 't@example.com'], dir);
    await writeFile(join(dir, 'only-here.txt'), `${branch}\n`, 'utf8');
    await g(['add', '-A'], dir);
    await g(['commit', '-q', '-m', 'chore: 初期'], dir);
    const wt = `${dir}-wt`;
    await g(['worktree', 'add', '-q', '-b', branch, wt], dir);
    await writeFile(join(wt, 'x.txt'), 'x\n', 'utf8');
    await g(['add', '-A'], wt);
    await g(['commit', '-q', '-m', `feat: ${branch}`], wt);
    return { dir, wt };
}

/** 複数リポジトリを登録したサーバを立てる。呼び出し側が kill する。 */
const MULTI_TOKEN = 'smoke-multi-repo-token-0123456789ab';
async function startMulti(repos, extra = ['--allow-exec']) {
    const args = [SERVER, '--port', '0', '--token', MULTI_TOKEN, ...extra];
    for (const r of repos) args.push('--repo', r);
    const child = spawn(process.execPath, args,
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let out = '', err = '';
    child.stderr.on('data', d => { err += d; });
    const url = await new Promise((resolve, reject) => {
        // 🚨 待ちの失敗で stderr を捨てない（捨てると CI で原因が完全に消える）
        const t = setTimeout(() => reject(new Error(
            `起動しなかった\n  stdout: ${out.trim() || '(空)'}\n  stderr: ${err.trim() || '(空)'}`,
        )), 15000);
        child.stdout.on('data', d => {
            out += d;
            const m = out.match(/http:\/\/127\.0\.0\.1:\d+/);
            if (m) { clearTimeout(t); resolve(m[0]); }
        });
        child.on('error', reject);
    }).catch(e => { try { child.kill(); } catch { /* noop */ } throw e; });
    return { child, url, banner: () => out };
}

const MH = { 'content-type': 'application/json', 'x-kjp-token': MULTI_TOKEN };

/**
 * 検査用に2本のリポジトリを用意する（テストごとに作り直さない。git の起動が重い）。
 * ⚠️ basename はわざと衝突させない（衝突時の表示は別のテストで作る）。
 */
let multi = null;
async function twoRepos() {
    if (multi) return multi;
    const root = await mkdtemp(join(tmpdir(), 'kjp-multi-'));
    const a = await makeRepo(join(root, 'alpha'), 'agent-x');
    const b = await makeRepo(join(root, 'bravo'), 'agent-y');
    multi = { root, a, b };
    return multi;
}

after(async () => {
    if (multi) await rm(multi.root, { recursive: true, force: true }).catch(() => {});
});

test('🔒 登録済みリポジトリの一覧が返る（表示名 + 現在選択中）', async () => {
    const { a, b } = await twoRepos();
    const { child, url } = await startMulti([a.dir, b.dir]);
    try {
        const d = await (await fetch(`${url}/api/v0/repos`)).json();
        assert.equal(d.repos.length, 2, `2本返っていない: ${JSON.stringify(d)}`);
        assert.deepEqual(d.repos.map(r => r.label), ['alpha', 'bravo'],
            'basename が表示名になっていない');
        // 1本目が既定 = 指定なしのときの current
        assert.equal(d.repos[0].current, true, '1本目が current になっていない');
        assert.equal(d.repos[1].current, false);
        assert.ok(sameish(d.default, a.dir), `既定が1本目でない: ${d.default}`);

        // ?repo= を付けたら current がそちらに移る（UI がセレクトの初期値に使う）
        const d2 = await (await fetch(
            `${url}/api/v0/repos?repo=${encodeURIComponent(b.dir)}`)).json();
        assert.equal(d2.repos[1].current, true, '選択中が反映されていない');
        assert.equal(d2.repos[0].current, false);
    } finally { child.kill(); }
});

test('🔒 basename が衝突したらフルパスを出す（別リポジトリを取り違えない）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kjp-dup-'));
    const p = await makeRepo(join(root, 'p', 'same'), 'agent-p');
    const q = await makeRepo(join(root, 'q', 'same'), 'agent-q');
    const { child, url } = await startMulti([p.dir, q.dir], []);
    try {
        const d = await (await fetch(`${url}/api/v0/repos`)).json();
        assert.equal(d.repos.length, 2);
        // basename は両方 'same' なので、**そのまま出したら区別できない**
        assert.notEqual(d.repos[0].label, d.repos[1].label,
            `衝突しているのに同じ表示名になっている: ${JSON.stringify(d.repos)}`);
        for (const r of d.repos) {
            assert.equal(r.label, r.path, `衝突時はフルパスを出すこと: ${r.label}`);
        }
    } finally {
        child.kill();
        await rm(root, { recursive: true, force: true }).catch(() => {});
    }
});

test('🔒 ?repo= で対象を切り替えられる（指定なしは既定のリポジトリ）', async () => {
    const { a, b } = await twoRepos();
    const { child, url } = await startMulti([a.dir, b.dir]);
    try {
        // 指定なし = 既定（後方互換。今まで通りの URL が今まで通り動く）
        const def = await (await fetch(`${url}/api/v0/state?fresh=1`)).json();
        assert.ok(sameish(def.repo, a.dir), `既定が1本目でない: ${def.repo}`);
        assert.ok(def.worktrees.some(w => w.branch === 'agent-x'),
            `既定の worktree が出ていない: ${JSON.stringify(def.worktrees.map(w => w.branch))}`);
        assert.ok(!def.worktrees.some(w => w.branch === 'agent-y'),
            '別リポジトリの worktree が混ざっている');

        // 2本目に切り替える
        const other = await (await fetch(
            `${url}/api/v0/state?fresh=1&repo=${encodeURIComponent(b.dir)}`)).json();
        assert.ok(sameish(other.repo, b.dir), `切り替わっていない: ${other.repo}`);
        assert.ok(other.worktrees.some(w => w.branch === 'agent-y'),
            `切り替え先の worktree が出ていない: ${JSON.stringify(other.worktrees.map(w => w.branch))}`);
        assert.ok(!other.worktrees.some(w => w.branch === 'agent-x'),
            '切り替えたのに元のリポジトリの worktree が出ている');
    } finally { child.kill(); }
});

test('🔒 表記が違っても登録済みなら通る（samePath 照合。=== ではない）', async () => {
    const { a, b } = await twoRepos();
    const { child, url } = await startMulti([a.dir, b.dir], []);
    try {
        // 区切り文字と末尾セパレータを変える（git は `/`、path.join は `\`）
        for (const spelled of [b.dir.replace(/\\/g, '/'), `${b.dir}/`,
            `${b.dir.replace(/\\/g, '/')}/`]) {
            const r = await fetch(`${url}/api/v0/state?fresh=1&repo=${encodeURIComponent(spelled)}`);
            assert.equal(r.status, 200, `登録済みなのに拒否された: ${spelled}`);
            const d = await r.json();
            assert.ok(sameish(d.repo, b.dir), `別のリポジトリが返った: ${d.repo}`);
        }
    } finally { child.kill(); }
});

test('🚨 未登録のパスは 400（形式が正しくても登録外は拒否する）', async () => {
    const { a, b } = await twoRepos();
    const { child, url } = await startMulti([a.dir], []);   // b は**登録しない**
    try {
        // b は実在する git リポジトリで、パスとして何の問題も無い。
        // それでも**登録されていないから**拒否する、が守りの本体。
        for (const bad of [b.dir, tmpdir(), `${a.dir}-nope`, '/etc', 'C:/Windows',
            `${a.dir}/..`, 'relative/path']) {
            const r = await fetch(`${url}/api/v0/state?fresh=1&repo=${encodeURIComponent(bad)}`);
            assert.equal(r.status, 400, `未登録のパスが通った: ${bad}`);
            const d = await r.json();
            assert.match(d.error, /登録されていない/, `拒否理由が違う: ${bad} → ${d.error}`);
        }
        // 既定のリポジトリはそのまま読める（門が広すぎて全部落ちている、を潰す）
        const ok = await fetch(`${url}/api/v0/state?fresh=1`);
        assert.equal(ok.status, 200, '未登録の拒否が既定の経路まで壊している');
    } finally { child.kill(); }
});

test('🚨 未登録のパスは副作用の経路（exec / checkout / merge / diff）でも 400', async () => {
    const { a, b } = await twoRepos();
    const { child, url } = await startMulti([a.dir], ['--allow-exec']);
    try {
        const q = `repo=${encodeURIComponent(b.dir)}`;
        // 実行: 通れば**未登録のリポジトリでコマンドが動く**（RCE の範囲が広がる）
        const ex = await fetch(`${url}/api/v0/exec?${q}`, {
            method: 'POST', headers: MH,
            body: JSON.stringify({ worktree: b.wt, argv: ['git', '--version'] }),
        });
        assert.equal(ex.status, 400, '未登録のリポジトリで exec が通った');
        assert.match((await ex.json()).error, /登録されていない/);

        const co = await fetch(`${url}/api/v0/checkout?${q}`, {
            method: 'POST', headers: MH,
            body: JSON.stringify({ worktree: b.wt, ref: 'main' }),
        });
        assert.equal(co.status, 400, '未登録のリポジトリで checkout が通った');
        assert.match((await co.json()).error, /登録されていない/);

        const mg = await fetch(`${url}/api/v0/merge?${q}`, {
            method: 'POST', headers: MH,
            body: JSON.stringify({ worktree: b.wt, branch: 'main' }),
        });
        assert.equal(mg.status, 400, '未登録のリポジトリで merge が通った');
        assert.match((await mg.json()).error, /登録されていない/);

        // 読み取り（diff / blob）も同じ門
        for (const path of ['/api/v0/diff', '/api/v0/blob']) {
            const r = await fetch(`${url}${path}?${q}&ref=main&path=only-here.txt`);
            assert.equal(r.status, 400, `未登録のリポジトリで ${path} が通った`);
            assert.match((await r.json()).error, /登録されていない/);
        }
    } finally { child.kill(); }
});

test('🔒 worktree の allowlist は「選択中のリポジトリ」の一覧に対して引く', async () => {
    const { a, b } = await twoRepos();
    // 両方**登録した上で**、A を選んだまま B の worktree を狙う。
    // 登録済み照合だけでは止まらないので、allowlist が repo ごとに引かれていることが要る。
    const { child, url } = await startMulti([a.dir, b.dir], ['--allow-exec']);
    try {
        const ex = await fetch(`${url}/api/v0/exec?repo=${encodeURIComponent(a.dir)}`, {
            method: 'POST', headers: MH,
            body: JSON.stringify({ worktree: b.wt, argv: ['git', '--version'] }),
        });
        assert.equal(ex.status, 400, 'A を選んでいるのに B の worktree でコマンドが動いた');
        assert.match((await ex.json()).error, /既知の worktree ではありません/);

        // 逆に B を選べば B の worktree で動く（門が広すぎて全部落ちている、を潰す）
        const okRes = await fetch(`${url}/api/v0/exec?repo=${encodeURIComponent(b.dir)}`, {
            method: 'POST', headers: MH,
            body: JSON.stringify({ worktree: b.wt, argv: ['git', '--version'] }),
        });
        assert.equal(okRes.status, 200, 'B を選んでも B の worktree で動かない');
        // 応答は ndjson。読み切って閉じる（読まずに捨てると購読が残る）
        await okRes.text();

        // checkout も同じ（A を選んで B の worktree は既知でない）
        const co = await fetch(`${url}/api/v0/checkout?repo=${encodeURIComponent(a.dir)}`, {
            method: 'POST', headers: MH,
            body: JSON.stringify({ worktree: b.wt, ref: 'main' }),
        });
        assert.equal(co.status, 400, 'A を選んでいるのに B の worktree を checkout した');
        assert.match((await co.json()).error, /既知の worktree ではありません/);
    } finally { child.kill(); }
});

/**
 * 🚨 **キャッシュが混ざらないこと。**
 *
 * TTL キャッシュが1本の変数だと、A を読んだ直後（TTL 内）に B を読むと
 * **A の payload が B として返る**。`state.repo` も worktree も別リポジトリのものになる。
 *
 * ⚠️ **ここでは `?fresh=1` を付けない。** 測っているのがキャッシュそのものなので、
 *    付けると測りたい経路を飛ばしてしまう（CLAUDE.md の `?fresh=1` の規則は
 *    「リポジトリを変更した直後に読む」場合の話で、ここは変更していない）。
 */
test('🚨 TTL キャッシュがリポジトリごとに分かれる（別リポジトリの payload が返らない）', async () => {
    const { a, b } = await twoRepos();
    const { child, url } = await startMulti([a.dir, b.dir], []);
    try {
        // A を先に読んでキャッシュに載せる
        const first = await (await fetch(`${url}/api/v0/state?fresh=1`)).json();
        assert.ok(sameish(first.repo, a.dir));
        // 直後（TTL 1500ms 以内）に B を**キャッシュを許して**読む
        const second = await (await fetch(
            `${url}/api/v0/state?repo=${encodeURIComponent(b.dir)}`)).json();
        assert.ok(sameish(second.repo, b.dir), `A のキャッシュが B として返った: ${second.repo}`);
        assert.ok(second.worktrees.some(w => w.branch === 'agent-y'),
            '中身が A のもの（repo だけ差し替わっている、も許さない）');
        // A に戻しても A のまま（B のキャッシュに上書きされていない）
        const third = await (await fetch(`${url}/api/v0/state`)).json();
        assert.ok(sameish(third.repo, a.dir), `A が B に化けた: ${third.repo}`);
        assert.ok(third.worktrees.some(w => w.branch === 'agent-x'));
    } finally { child.kill(); }
});

// 🚨 **同時に来た要求の合流もリポジトリごとに分ける。**
//    in-flight を1本の変数で持つと、A の収集中に来た B の要求が
//    **A の Promise に合流して A の payload を受け取る**（TTL とは別の経路）。
test('🚨 同時要求の合流もリポジトリごと（in-flight を共有しない）', async () => {
    const { a, b } = await twoRepos();
    const { child, url } = await startMulti([a.dir, b.dir], []);
    try {
        const [ra, rb] = await Promise.all([
            fetch(`${url}/api/v0/state?fresh=1`).then(r => r.json()),
            fetch(`${url}/api/v0/state?fresh=1&repo=${encodeURIComponent(b.dir)}`)
                .then(r => r.json()),
        ]);
        assert.ok(sameish(ra.repo, a.dir), `A が別物になった: ${ra.repo}`);
        assert.ok(sameish(rb.repo, b.dir), `B が A に合流した: ${rb.repo}`);
    } finally { child.kill(); }
});

test('1本しか登録していなければ一覧は1件（既存の使い方は変わらない）', async () => {
    const d = await (await fetch(`${baseUrl}/api/v0/repos`)).json();
    assert.equal(d.repos.length, 1, `1件でない: ${JSON.stringify(d)}`);
    assert.equal(d.repos[0].current, true);
    assert.ok(sameish(d.repos[0].path, repo));
});

test('🚨 開けないリポジトリを1本でも渡したら起動しない（黙って落とさない）', async () => {
    const { a } = await twoRepos();
    const notRepo = await mkdtemp(join(tmpdir(), 'kjp-notrepo-'));
    const child = spawn(process.execPath,
        [SERVER, '--port', '0', '--repo', a.dir, '--repo', notRepo],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    try {
        // 🚨 **待ち続ける形にしない。** 起動してしまった場合に永久に閉じないので、
        //    上限を付けて「起動した」を失敗として観測する（CLAUDE.md）。
        const code = await Promise.race([
            new Promise(r => child.on('exit', c => r(c))),
            new Promise(r => setTimeout(() => r('timeout'), 15000)),
        ]);
        assert.equal(code, 1, '開けないリポジトリを渡したのに起動した'
            + `（code=${code}）\n  stdout: ${out}\n  stderr: ${err}`);
        assert.match(err, /git リポジトリとして開けません/);
        assert.ok(err.includes(notRepo), `どれが駄目なのかを言っていない: ${err}`);
    } finally {
        child.kill();
        await rm(notRepo, { recursive: true, force: true }).catch(() => {});
    }
});

test('同じ場所を2回渡したら1本にまとめる（キャッシュが2重にならない）', async () => {
    const { a } = await twoRepos();
    const { child, url } = await startMulti([a.dir, a.dir.replace(/\\/g, '/')], []);
    try {
        const d = await (await fetch(`${url}/api/v0/repos`)).json();
        assert.equal(d.repos.length, 1,
            `重複がまとめられていない: ${JSON.stringify(d.repos.map(r => r.path))}`);
    } finally { child.kill(); }
});

/**
 * 🚨 **`include.path` で filter を `.git` の外に置いても潰す（9回目のレビュー。BLOCKING）。**
 *
 * 8回目で入れた対策は「設定ファイルの場所が `.git` の中か」で判定していたので、
 * `.git/config` の `include.path` で **worktree 直下のファイル**を引くだけで
 * **capability ゼロの任意コード実行がそのまま復活**していた（実測で marker が2回）。
 * 判定を許可リストに反転した（`--show-scope` が `system` / `global` と言うもの以外は
 * すべてリポジトリ側）。`--show-scope` は include で引かれた値も `local` と報告する（実測）。
 */
test('🚨 include.path で外に置いた filter も潰す（capability ゼロの RCE）', async () => {
    const marker = join(repo, 'inc-filter-ran.txt').split(sep).join('/');
    const cfg = join(repo, 'inc-evil.cfg');
    const target = join(repo, 'inc-filtered.txt');
    try {
        await writeFile(target, 'aaaa\n', 'utf8');
        await writeFile(join(repo, '.gitattributes'), 'inc-filtered.txt filter=incevil\n', 'utf8');
        await g(['add', '-A'], repo);
        await g(['commit', '-q', '-m', 'chore: include filter のテスト用'], repo);
        // 🚨 filter の定義を **.git の外**に置き、include.path で引く
        await writeFile(cfg,
            `[filter "incevil"]\n\tclean = sh -c "printf ran > '${marker}'; cat"\n`, 'utf8');
        await g(['config', 'include.path', '../inc-evil.cfg'], repo);
        // 同じ長さで書き換え、mtime を古くして stat cache を無効化する
        await writeFile(target, 'bbbb\n', 'utf8');
        const old = new Date(Date.now() - 86400000);
        await (await import('node:fs/promises')).utimes(target, old, old);

        const s = await state();
        await new Promise(r => setTimeout(r, 400));
        const { existsSync } = await import('node:fs');
        assert.equal(existsSync(join(repo, 'inc-filter-ran.txt')), false,
            'include.path 経由の filter が実行された（capability ゼロで任意コード実行）');
        // 潰したことを告知している（名前も出す）
        const notices = s.errors.filter(e => /を無効化して読みました/.test(e.message));
        assert.equal(notices.length, 1, `告知が1件でない: ${JSON.stringify(s.errors)}`);
        assert.match(notices[0].message, /incevil/, '何を無効化したのか言っていない');
    } finally {
        await g(['config', '--unset', 'include.path'], repo).catch(() => {});
        await rm(cfg, { force: true }).catch(() => {});
        await rm(join(repo, 'inc-filter-ran.txt'), { force: true }).catch(() => {});
        await rm(target, { force: true }).catch(() => {});
        await rm(join(repo, '.gitattributes'), { force: true }).catch(() => {});
        await g(['add', '-A'], repo).catch(() => {});
        await g(['commit', '-q', '-m', 'chore: include filter の後片付け'], repo).catch(() => {});
    }
});

/**
 * 🚨 **filter の門は dirty の門より前（9回目のレビュー。BLOCKING）。**
 *
 * 以前は dirty の判定が先で、その `worktreeStatus()` に filter の名前を渡していなかったので、
 * **「filter は任意コマンドを起動するので断ります」と 409 で言う前に1回実行していた。**
 * 応答の文面と実際に起きたことが違うのは、このリポジトリが最も重いとする嘘。
 */
test('🚨 merge が filter を断るとき、その前に filter を実行していない', async () => {
    const { child, url } = await startWritable();
    const stem = repo.split(sep).pop();
    const wt = join(repo, '..', `${stem}-fgo`);
    const marker = join(repo, 'fgo-ran.txt').split(sep).join('/');
    try {
        await g(['worktree', 'add', '-q', '-b', 'fgo', wt, 'main'], repo);
        // 対象の worktree に「中身を比べる」状況を作る（同じ長さで書き換え + 古い mtime）
        await writeFile(join(wt, '.gitattributes'), 'fgo.txt filter=fgoevil\n', 'utf8');
        await writeFile(join(wt, 'fgo.txt'), 'aaaa\n', 'utf8');
        await g(['add', '-A'], wt);
        await g(['commit', '-q', '-m', 'fgo seed'], wt);
        await g(['config', 'filter.fgoevil.clean', `sh -c "printf ran > '${marker}'; cat"`], repo);
        await writeFile(join(wt, 'fgo.txt'), 'bbbb\n', 'utf8');
        const old = new Date(Date.now() - 86400000);
        await (await import('node:fs/promises')).utimes(join(wt, 'fgo.txt'), old, old);

        const r = await fetch(`${url}/api/v0/merge`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-kjp-token': WRITE_TOKEN,
                'sec-fetch-site': 'same-origin',
            },
            body: JSON.stringify({ worktree: wt, branch: 'agent-a' }),
        });
        assert.equal(r.status, 409, 'filter があるのに取り込んだ');
        assert.match((await r.json()).error, /filter/, '断った理由が filter でない');
        const { existsSync } = await import('node:fs');
        assert.equal(existsSync(join(repo, 'fgo-ran.txt')), false,
            '断る前に filter を実行した（応答の文面と実際に起きたことが違う）');
    } finally {
        child.kill();
        await g(['config', '--unset', 'filter.fgoevil.clean'], repo).catch(() => {});
        await g(['worktree', 'remove', '--force', wt], repo).catch(() => {});
        await g(['branch', '-D', 'fgo'], repo).catch(() => {});
        await rm(wt, { recursive: true, force: true }).catch(() => {});
        await rm(join(repo, 'fgo-ran.txt'), { force: true }).catch(() => {});
    }
});

/**
 * 🔒 **checkout も filter を断る（9回目のレビュー。SERIOUS）。**
 *
 * `git checkout` は作業ツリーを書き換えるので **smudge filter を起動する** =
 * `--allow-write` だけでリポジトリ設定の任意コマンドが走る。
 * merge には門を付けたのに checkout には1つも無かった。
 */
test('🔒 checkout: リポジトリ設定の filter があるときは切り替えない', async () => {
    const { child, url, session } = await startWritable();
    const stem = repo.split(sep).pop();
    const wt = join(repo, '..', `${stem}-cof`);
    try {
        await g(['worktree', 'add', '-q', '-b', 'cof', wt, 'main'], repo);
        await g(['config', 'filter.cofevil.clean', 'false'], repo);
        const r = await fetch(`${url}/api/v0/checkout`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                [session.tokenHeader]: session.token,
                'sec-fetch-site': 'same-origin',
            },
            body: JSON.stringify({ worktree: wt, ref: 'main' }),
        });
        assert.equal(r.status, 409, 'filter があるのに checkout した（smudge が走る）');
        assert.match((await r.json()).error, /filter/);
    } finally {
        child.kill();
        await g(['config', '--unset', 'filter.cofevil.clean'], repo).catch(() => {});
        await g(['worktree', 'remove', '--force', wt], repo).catch(() => {});
        await g(['branch', '-D', 'cof'], repo).catch(() => {});
        await rm(wt, { recursive: true, force: true }).catch(() => {});
    }
});

/**
 * 🚨 **編集を始める前の問い合わせ口（#59）。**
 *
 * `docs/s0-verification.md` が「他所に無い」と判定した中核はここ:
 * 見えるだけでなく、**エージェントが書く前に機械が聞ける**こと。
 * 検査で固定するのは「衝突を見つけること」より
 * **「調べられなかったときに『衝突なし』と答えないこと」**（そこが唯一の壁）。
 */
const precheck = (worktree, paths, method = 'POST') =>
    fetch(`${baseUrl}/api/v0/precheck`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'POST' ? JSON.stringify({ worktree, paths }) : undefined,
    });

test('precheck: 触るパスが他の worktree と衝突することを事前に答える', async () => {
    const s = await state();
    const a = s.worktrees.find(w => w.branch === 'agent-a');
    const b = s.worktrees.find(w => w.branch === 'agent-b');
    assert.ok(a && b, 'fixture の worktree が無い');
    const r = await precheck(a.path, ['shared.txt']);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.decided, true, `判定できていない: ${JSON.stringify(j.unknown)}`);
    const hit = j.conflicts.find(c => c.path === 'shared.txt');
    assert.ok(hit, `shared.txt の衝突が無い: ${JSON.stringify(j.conflicts)}`);
    assert.equal(hit.branch, 'agent-b', `衝突相手が agent-b ではない: ${hit.worktree}`);
    assert.equal(basename(hit.worktree), basename(b.path),
        `衝突相手の worktree が違う: ${hit.worktree}`);

    // paths で絞れる（触らないパスを聞いたら空）
    const other = await (await precheck(a.path, ['only-a.txt'])).json();
    assert.equal(other.conflicts.length, 0,
        `絞り込みが効いていない: ${JSON.stringify(other.conflicts)}`);
});

test('🚨 precheck: 知らない worktree に「衝突なし」と答えない', async () => {
    const r = await precheck(join(repo, '..', 'not-a-worktree'), ['x.txt']);
    assert.equal(r.status, 400, '知らない worktree を 200 で通している');
    const j = await r.json();
    assert.ok(!('conflicts' in j), `拒否のはずが結果を返している: ${JSON.stringify(j)}`);
});

test('🚨 precheck: GET では答えない（読み取り専用でも副作用のある形にしない）', async () => {
    const r = await precheck(repo, [], 'GET');
    assert.equal(r.status, 405);
});

test('🚨 precheck: 作業ツリーと ref に触らない', async () => {
    const s = await state();
    const a = s.worktrees.find(w => w.branch === 'agent-a');
    const before = await Promise.all([
        g(['rev-parse', 'HEAD'], a.path),
        g(['status', '--porcelain'], a.path),
        g(['for-each-ref', '--format=%(refname) %(objectname)'], repo),
    ]);
    await (await precheck(a.path, ['shared.txt'])).json();
    const after = await Promise.all([
        g(['rev-parse', 'HEAD'], a.path),
        g(['status', '--porcelain'], a.path),
        g(['for-each-ref', '--format=%(refname) %(objectname)'], repo),
    ]);
    assert.equal(after[0].stdout, before[0].stdout, 'HEAD が動いた');
    assert.equal(after[1].stdout, before[1].stdout, '作業ツリーが変わった');
    assert.equal(after[2].stdout, before[2].stdout, 'ref が変わった');
});

test('🚨 precheck: 自分がシーケンサ停止中なら self に出す（乗っ取りの本体）', async () => {
    const wt = join(repo, '..', `${basename(repo)}-clash-seq`);
    try {
        await g(['worktree', 'add', '-q', '-b', 'clash-seq', wt, 'main'], repo);
        await writeFile(join(wt, 'seq.txt'), 'one\n', 'utf8');
        await g(['add', '-A'], wt);
        await g(['commit', '-q', '-m', 'seq 1'], wt);
        await writeFile(join(wt, 'seq.txt'), 'two\n', 'utf8');
        await g(['add', '-A'], wt);
        await g(['commit', '-q', '-m', 'seq 2'], wt);
        // todo の先頭に break を入れて、clean index で止める
        await new Promise((resolve, reject) => {
            const child = spawn('git', ['rebase', '-i', 'HEAD~2'], {
                cwd: wt, shell: false, windowsHide: true,
                env: {
                    ...process.env,
                    ...isolatedConfig(),
                    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
                    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
                    GIT_SEQUENCE_EDITOR: `${JSON.stringify(process.execPath)} -e `
                        + JSON.stringify(
                            'const f=process.argv[1],fs=require("fs");'
                            + 'const l=fs.readFileSync(f,"utf8").split("\n");'
                            + 'l.splice(1,0,"break");fs.writeFileSync(f,l.join("\n"));'),
                },
            });
            child.on('error', reject);
            child.on('close', () => resolve());
        });
        const j = await (await precheck(wt, ['seq.txt'])).json();
        assert.ok(j.self, `self が無い: ${JSON.stringify(j)}`);
        assert.equal(j.self.rebasing, true,
            `rebase 停止中を見落としている: ${JSON.stringify(j.self)}`);
    } finally {
        await g(['rebase', '--abort'], wt).catch(() => {});
        await g(['worktree', 'remove', '--force', wt], repo).catch(() => {});
        await g(['branch', '-D', 'clash-seq'], repo).catch(() => {});
        await rm(wt, { recursive: true, force: true }).catch(() => {});
    }
});

/**
 * 🔒 **`/state` と `/session` の「実行トークンの当たり判定」も壁を通す（#63）。**
 *
 * 10回目のレビュー / SERIOUS。`--allow-exec` の壁（#48）は `gateMutation` の中にしか
 * 無く、`/api/v0/state` の `execSessions` 可視判定と `/api/v0/session` の
 * トークン払い出し判定は **`presentedToken()` を直接呼んでいた**ので、
 * 読み取りの鍵を持つ相手が**1要求1bitで実行トークンを総当たり**できた。
 * 実測: Cookie 付きで `?token=<誤り>` を300回 → **120ms（2500 req/s）、
 * 401 も 429 も遅延も無く、監査ログに1行も残らない**。
 * 当たれば execSessions（argv）が出て実行トークンが確定 = そのまま RCE に昇格する。
 *
 * ⚠️ **正規の読み取りを殴らないこと**も同時に測る。UI は15秒ごとに `/state` を叩き、
 *    スマホは案内 URL の `?token=<読み取り鍵>` で開く。これらを「失敗」に数えると
 *    壁が利用者を遅くする。
 */
test('🔒 state/session の実行トークン当て判定にも門・記録・遅延がある（#63）', async () => {
    const audit = join(repo, '..', `state-brute-${Date.now()}.jsonl`);
    const s = await startAuthServer(['--require-auth', '--allow-exec',
        '--token', EXEC_TOKEN, '--audit-log', audit]);
    const readSecret = (s.banner().match(/\?token=([A-Za-z0-9_-]+)/) ?? [])[1];
    const agent = new HttpAgent({ keepAlive: true, maxSockets: 320 });
    const guess = token => new Promise(res => {
        const r = httpRequest({
            host: '127.0.0.1', port: s.port, agent,
            path: `/api/v0/state?token=${encodeURIComponent(token)}`,
            headers: { cookie: `kjp_auth=${readSecret}` },
        }, x => {
            let b = '';
            x.on('data', d => { b += d; });
            x.on('end', () => res({ code: x.statusCode, body: b }));
        });
        r.on('error', e => res({ code: 0, body: e.message }));
        r.end();
    });
    try {
        assert.ok(readSecret, `案内 URL の読み取り鍵が取れない: ${s.banner().slice(0, 300)}`);
        const N = 200;
        const rs = await Promise.all(Array.from({ length: N }, (_, i) => guess(`wrong-state-${i}`)));
        const by = {};
        for (const r of rs) by[r.code] = (by[r.code] ?? 0) + 1;
        const shed = by[429] ?? 0;
        // 🔒 全部が比較されない（門が無いと 200 が N 件返る = 当て放題）
        assert.ok(shed >= 50,
            `429 で切られたのが ${shed} 件しかない: ${JSON.stringify(by)}`
            + '（修正前は 200 が全件で、当たり判定が無制限に取れた）');
        // 🔒 痕跡が残る
        await new Promise(r => setTimeout(r, 400));
        const grew = await sizeOrZero(audit);
        assert.ok(grew > 0, '誤った実行トークンを当て続けても監査に1行も残らない');
        const lines = (await readFile(audit, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
        const kinds = new Set(lines.map(r => r.event));
        assert.ok(kinds.has('mutation-token-failed') || kinds.has('mutation-token-failed-summary'),
            `当て判定の失敗が記録されていない: ${JSON.stringify([...kinds])}`);
        assert.equal(lines.some(r => JSON.stringify(r).includes('wrong-state-')), false,
            '試された値が記録に残っている');

        // ⚠️ **正規の読み取りは殴られない。** 読み取り鍵そのものを ?token= で出しても
        //    「実行トークンの試行」ではないので、遅延も 429 も付かない。
        const t0 = Date.now();
        for (let i = 0; i < 5; i++) {
            const r = await authGet(s.port, `/api/v0/state?token=${encodeURIComponent(readSecret)}`,
                { cookie: `kjp_auth=${readSecret}` });
            assert.equal(r.code, 200, `案内 URL の鍵で読めない（壁が利用者を殴っている）: ${r.code}`);
        }
        const ms = Date.now() - t0;
        assert.ok(ms < 3000, `読み取り鍵での5回が ${ms}ms かかった（遅延が正規利用に掛かっている）`);
    } finally {
        agent.destroy();
        s.child.kill();
        await rm(audit, { force: true }).catch(() => {});
    }
});

/**
 * 🔒 **検査専用の経路も門の後ろ（#64。10回目のレビュー / SERIOUS）。**
 *
 * `/__shutdown` と `/__throw` は `handleRequest` の**先頭**にあったので、
 * **Host 検証も認証も通らずにデーモンを落とせた**。
 * 「既定では存在しない経路」は「門の外にあってよい経路」ではない。
 *
 * ⚠️ 同時に `--layout-probe` と `--allow-host` の併用を起動時に拒否する
 *    （そもそもトンネルに出さない）。二段にする理由は、門は将来の変更で
 *    順序がずれうるが、起動を止める門は構成そのものを作らせないため。
 */
test('🔒 検査専用の /__shutdown は認証を通らないと落とせない（#64）', async () => {
    const s = await startAuthServer(['--layout-probe', '--require-auth', '--token', EXEC_TOKEN]);
    try {
        // 🔒 トークン無しでは 401（そして**デーモンは生きている**）
        const no = await authGet(s.port, '/__shutdown');
        assert.equal(no.code, 401, `無認証で /__shutdown が通った: ${no.code}`);
        const alive = await authGet(s.port, '/api/v0/state?fresh=1',
            { 'x-kjp-token': EXEC_TOKEN });
        assert.equal(alive.code, 200,
            '無認証の /__shutdown でデーモンが落ちた（門の外にある）');

        // 認証を通せば従来どおり落とせる（検査用の経路そのものは残す）
        const ok = await authGet(s.port, '/__shutdown', { 'x-kjp-token': EXEC_TOKEN });
        assert.equal(ok.code, 200, `認証付きの /__shutdown が通らない: ${ok.code}`);
        await new Promise(r => setTimeout(r, 800));
    } finally {
        s.child.kill();
    }
});

test('🔒 --layout-probe と --allow-host は併用できない（#64）', async () => {
    const child = spawn(process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--layout-probe',
            '--allow-host', 'probe.example.com'],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { err += d; });
    // 🚨 **「起動しないはず」を待ち続ける形にしない。** 守りを外すとサーバは
    //    正常に起動して**永久に終わらない**ので、`exit` だけを待つと
    //    `node --test` ごとハングして SIGKILL され、要約が消える
    //    （実測: この検査で変異が KILLED ではなく HUNG になった）。
    //    上限で打ち切り、**失敗として観測できる形**にする。
    let code;
    try {
        code = await Promise.race([
            new Promise((resolve, reject) => {
                child.on('exit', c => resolve(c));
                child.on('error', e => reject(e));
            }),
            new Promise(resolve => setTimeout(() => resolve('(15秒たっても終了しない)'), 15000)),
        ]);
    } finally {
        child.kill();
    }
    assert.equal(code, 1, `併用が起動できてしまった（exit=${code}）: ${err.slice(0, 200)}`);
    assert.match(err, /--layout-probe と --allow-host/,
        `理由が出ていない: ${err.slice(0, 200)}`);
});
