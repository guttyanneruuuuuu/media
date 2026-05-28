# 🌤️ Sky Duel - ハンドジェスチャー対戦ゲーム

スマホ縦画面専用の、MediaPipe を使ったジェスチャー操作のオンライン1vs1対戦アクションゲーム。

## 🎮 ゲーム概要

「**Sky Duel**」は、雲の上のアリーナで魔法弾を撃ち合う2分間の対戦アクションです。
カメラに映る手の動きと表情で全ての操作を行います。

### 操作方法（MediaPipe）

| ジェスチャー | アクション |
|---|---|
| ✋ 手を左右に動かす | キャラクター移動 |
| ✊ グー | シールド（防御） |
| ✌️ チョキ | エネルギーチャージ |
| 🖐️ パー（前に突き出す） | 魔法弾を発射 |
| 😮 口を大きく開く | 必殺技（チャージ消費） |
| 😊 笑顔 | HPを少し回復 |

## 🕹️ モード

- **AI対戦**：CPUと即対戦
- **友達対戦**：ルームコードで招待してP2P対戦（PeerJS）

## 🎨 デザイン

ネオン系ではなく、明るく爽やかな空・パステル（スカイブルー × ピーチ × クリーム）の昼間のアリーナ。

## 🛠️ 技術スタック

- HTML / CSS / Vanilla JS（ビルド不要・スマホブラウザで即動作）
- [MediaPipe Tasks Vision](https://developers.google.com/mediapipe) - Hand & Face Landmarker
- [PeerJS](https://peerjs.com/) - WebRTC P2P 通信
- ローカル実行は `python -m http.server` などでOK

## 🚀 起動

```bash
python3 -m http.server 8000
# スマホで https でアクセスする必要あり（カメラ権限のため）
```

