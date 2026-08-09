// SPDX-License-Identifier: MIT
// node --test v0/theme.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    THEMES, DEFAULT_THEME, nextTheme, resolveTheme, parseColor, contrastRatio, MIN_CONTRAST,
} from './theme.mjs';

test('nextTheme: 巡回する（既定のダークから dark → auto → light）', () => {
    assert.equal(nextTheme('auto'), 'light');
    assert.equal(nextTheme('light'), 'dark');
    assert.equal(nextTheme('dark'), 'auto');
});

test('🚨 nextTheme: 知らない値は既定（ダーク）に戻す（localStorage は書き換えられる）', () => {
    for (const bad of ['', null, undefined, 'ネオン', '__proto__']) {
        assert.equal(THEMES.includes(nextTheme(bad)), true, `巡回から外れた: ${bad}`);
        assert.equal(nextTheme(bad), DEFAULT_THEME);
    }
});

test('resolveTheme: auto は OS に従い、固定したらそれを使う', () => {
    assert.deepEqual(resolveTheme('auto', true), { choice: 'auto', applied: 'dark' });
    assert.deepEqual(resolveTheme('auto', false), { choice: 'auto', applied: 'light' });
    // 🚨 固定しているなら OS の設定に**上書きされない**
    assert.deepEqual(resolveTheme('light', true), { choice: 'light', applied: 'light' });
    assert.deepEqual(resolveTheme('dark', false), { choice: 'dark', applied: 'dark' });
});

test('🚨 resolveTheme: 選んでいない／壊れているときは既定のダーク', () => {
    // 既定を auto にしていると、OS がライトの人には**選んでいないのにライト**が出る
    assert.equal(resolveTheme(null, false).choice, DEFAULT_THEME);
    assert.equal(resolveTheme(null, false).applied, 'dark');
    assert.equal(resolveTheme('ネオン', false).choice, DEFAULT_THEME);
    // auto を**明示的に選んだ**ときだけ OS に従う
    assert.equal(resolveTheme('auto', false).applied, 'light');
});

test('parseColor: ブラウザが返す形を解釈し、読めないものは null', () => {
    assert.deepEqual(parseColor('#1e1e1e'), [30, 30, 30]);
    assert.deepEqual(parseColor('#fff'), [255, 255, 255]);
    assert.deepEqual(parseColor('rgb(30, 30, 30)'), [30, 30, 30]);
    assert.deepEqual(parseColor('rgb(30 30 30 / 0.5)'), [30, 30, 30]);
    // 🚨 読めないものを「読めた」と言わない
    for (const bad of ['transparent', 'var(--bg)', '', null, 'rgb(a,b,c)']) {
        assert.equal(parseColor(bad), null, `解釈できないはず: ${bad}`);
    }
});

test('contrastRatio: 白黒は 21、同色は 1、読めなければ null', () => {
    assert.equal(Math.round(contrastRatio('#000', '#fff')), 21);
    assert.equal(contrastRatio('#123456', '#123456'), 1);
    assert.equal(contrastRatio('var(--fg)', '#fff'), null,
        '測れなかったのに数値を返している');
});

/**
 * 🚨 **配色は「用意した」ではなく「読める」を測る。**
 *
 * ダーク用に選んだ色をそのまま白地に流用すると読めない
 * （実測: `--warn: #cca700` は白地で 2.31、`--ok: #4ec9b0` は 2.04 で、
 *  大きい文字の基準 3.0 すら下回っていた）。ここは**値そのもの**を固定する。
 * ⚠️ 実際に描かれている色は `v0/layout-check.mjs` が実ブラウザで測る
 *    （CSS を書き換えて変数を外した場合はそちらが落ちる）。
 */
test('🚨 配色の値がコントラストの下限を満たす（ダーク / ライト）', () => {
    const palettes = {
        dark: { bg: '#1e1e1e', fg: '#d4d4d4', dim: '#808080',
            danger: '#f14c4c', warn: '#cca700', ok: '#4ec9b0', accent: '#4fc1ff' },
        light: { bg: '#ffffff', fg: '#1f1f1f', dim: '#5f5f5f',
            danger: '#b3261e', warn: '#7a5600', ok: '#0b6b5e', accent: '#0066bf' },
    };
    for (const [name, p] of Object.entries(palettes)) {
        const need = k => (k === 'fg' ? MIN_CONTRAST.fg
            : k === 'dim' ? MIN_CONTRAST.dim : MIN_CONTRAST.state);
        for (const [k, v] of Object.entries(p)) {
            if (k === 'bg') continue;
            const r = contrastRatio(v, p.bg);
            assert.ok(r !== null, `${name}.${k} を測れない: ${v}`);
            assert.ok(r >= need(k),
                `${name}.${k}（${v}）のコントラストが ${r.toFixed(2)} で下限 ${need(k)} 未満`);
        }
    }
});
