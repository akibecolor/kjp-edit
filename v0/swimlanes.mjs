// SPDX-License-Identifier: MIT
//
// スイムレーン（コミットDAGのレーン割当）。
// アルゴリズムは microsoft/vscode の
// src/vs/workbench/contrib/scm/browser/scmHistory.ts (MIT) の
// toISCMHistoryItemViewModelArray() を参考に再実装したもの。
//
//   Copyright (c) Microsoft Corporation. All rights reserved.
//   Licensed under the MIT License.
//
// 単一の前進パス。各コミットについて:
//   1. lane = そのコミットを予約している input レーンの位置。無ければ空きスロット
//   2. output = input を歩き、自分のレーンは第一親に置き換え、
//      同じコミットを指す他のレーン（合流）は畳み、残りはそのまま
//   3. 第二親以降（マージ）を新レーンとして追加
//
// ⚠️ 実装上つまずいた2点（回帰テスト参照）:
//   - output のレーンは ID で重複排除しないと、同一コミットに2本開いたまま
//     1本しか消費されず残り続ける（16コミットで13レーンになった）
//   - しかし lane の割当まで畳んではいけない。兄弟ブランチが同じレーンになる
//     （agent-a と agent-b が両方 lane 0 になった）。
//     「どこに点を描くか」と「下にどのレーンが続くか」は別の概念。
//
// 既知の限界（VS Code と同じ）: 直線化パスもレーン圧縮も無いので密なマージ領域で線がうねる。
// 将来 pvigier の straight-branches に差し替える余地がある。

export const LANE_COLORS = [
    '#FFB000', '#DC267F', '#994F00', '#40B0A6', '#B66DFF',
];

/**
 * @param {{hash: string, parents: string[]}[]} commits 新しい順（--topo-order）
 * @returns {{hash: string, lane: number, color: string, firstParentLane: number,
 *            input: {id: string, color: string}[],
 *            output: {id: string, color: string}[]}[]}
 */
export function computeSwimlanes(commits) {
    /** @type {{id: string, color: string}[]} */
    let input = [];
    let colorIndex = -1;
    const nextColor = () => {
        colorIndex = (colorIndex + 1) % LANE_COLORS.length;
        return LANE_COLORS[colorIndex];
    };

    const rows = [];

    for (const commit of commits) {
        // 1. このコミットが座るレーン
        let lane = input.findIndex(n => n.id === commit.hash);
        let color;
        if (lane === -1) {
            // 表示範囲での新しい枝の先頭。input と衝突しない空きスロットへ
            lane = input.length;
            color = nextColor();
        } else {
            color = input[lane].color;
        }

        // 2. 下に続くレーンを組む（ID で重複排除する）
        const output = [];
        const push = node => {
            const at = output.findIndex(o => o.id === node.id);
            if (at !== -1) return at;
            output.push(node);
            return output.length - 1;
        };

        let firstParentLane = -1;
        for (let i = 0; i < input.length; i++) {
            const node = input[i];
            if (node.id === commit.hash) {
                // 自分のレーン（および自分に合流する他のレーン）
                if (i === lane && commit.parents.length > 0) {
                    firstParentLane = push({ id: commit.parents[0], color });
                }
                continue;
            }
            push({ id: node.id, color: node.color });
        }
        // 新しい枝の先頭だった場合はここで第一親を開く
        if (firstParentLane === -1 && commit.parents.length > 0) {
            firstParentLane = push({ id: commit.parents[0], color });
        }

        // 3. 第二親以降（マージ）
        for (let i = 1; i < commit.parents.length; i++) {
            push({ id: commit.parents[i], color: nextColor() });
        }

        rows.push({
            hash: commit.hash,
            lane,
            color,
            firstParentLane,   // 点から下へ引く線の着地レーン。-1 なら root
            input,
            output,
        });
        input = output;
    }

    return rows;
}

export const SWIMLANE_WIDTH = 11;
export const ROW_HEIGHT = 24;
