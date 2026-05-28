/* ============================================================
 * ai.js - CPU 対戦相手のロジック
 *
 * 簡単なステートマシンで人間っぽい挙動を再現する。
 *  - 自分のHP/エネルギー、相手位置、飛んでくる弾を見て
 *    move / shield / charge / shoot / special / heal を決める。
 * ============================================================ */

import { GAME_CONFIG } from "./game.js";

export class AIController {
  constructor(engine, { difficulty = "normal" } = {}) {
    this.engine = engine;
    this.difficulty = difficulty;
    this._t = 0;
    this._nextDecisionAt = 0;
    this._targetX = 0.5;
    this._lastShotAt = 0;
    this._mood = "neutral"; // neutral / aggressive / defensive
  }

  start() {
    this._t = performance.now();
    this._nextDecisionAt = this._t + 400;
  }

  /** 毎フレーム呼び出し */
  update(dtMs) {
    const now = performance.now();
    const eng = this.engine;
    const opp = eng.players.opp;
    const self = eng.players.self;

    // 飛んでくる弾を見て防御判断
    const incoming = eng.bullets.find(
      (b) => b.ownerKey === "self" && b.y < 0.4 // 弾が opp 側に近い
    );

    // 状況評価
    if (opp.hp < 35) this._mood = "defensive";
    else if (self.hp < 40 && opp.energy > 40) this._mood = "aggressive";
    else this._mood = "neutral";

    // === 移動 (目標xを少しランダムに更新) ===
    if (now > this._nextDecisionAt) {
      this._nextDecisionAt = now + (350 + Math.random() * 500);
      // 相手のx に対しオフセットで動く（撃つときは正面に来る）
      const wantAlign = Math.random() < 0.55;
      if (wantAlign) {
        this._targetX = clamp(self.x + (Math.random() - 0.5) * 0.1, 0.1, 0.9);
      } else {
        this._targetX = 0.15 + Math.random() * 0.7;
      }
    }

    // 緊急回避: 弾が来ていて自分の真上付近なら逃げる
    if (incoming && Math.abs(incoming.x - opp.x) < 0.12) {
      // 横にステップ
      this._targetX = clamp(opp.x + (incoming.x < opp.x ? 0.25 : -0.25), 0.1, 0.9);
    }

    // 緩やかに目標へ
    eng.setOpponentInput({ handVisible: true, handX: this._targetX });

    // === シールド ===
    let wantShield = false;
    if (incoming && Math.abs(incoming.x - opp.x) < 0.08 && opp.energy > 20) {
      wantShield = true;
    } else if (this._mood === "defensive" && opp.energy > 40 && Math.random() < 0.01) {
      wantShield = true;
    }
    if (wantShield !== opp.shielding) {
      eng.setOpponentInput({ gesture: wantShield ? "fist" : "none" });
    }

    // === チャージ ===
    if (!wantShield && opp.energy < 60 && Math.random() < 0.015) {
      eng.setOpponentInput({ gesture: "peace" });
    } else if (!wantShield && opp.energy >= 95) {
      // 満タンなら別ジェスチャーへ
      eng.setOpponentInput({ gesture: "none" });
    }

    // === 攻撃 ===
    const shootCooldown = this.difficulty === "easy" ? 1400 : this.difficulty === "hard" ? 600 : 950;
    if (now - this._lastShotAt > shootCooldown && opp.energy >= GAME_CONFIG.bulletCost && !wantShield) {
      // 自分の x が相手の x に近ければ高確率で撃つ
      const aligned = Math.abs(opp.x - self.x) < 0.18;
      if (aligned && Math.random() < (this.difficulty === "hard" ? 0.9 : 0.55)) {
        this._lastShotAt = now;
        // たまに必殺
        if (opp.energy >= GAME_CONFIG.specialCost && Math.random() < 0.2) {
          eng.setOpponentInput({ mouthOpenTrigger: true });
        } else {
          eng.setOpponentInput({ punch: true });
        }
      }
    }

    // === 回復 ===
    if (opp.hp < 60 && opp.hp > 10 && Math.random() < 0.005) {
      eng.setOpponentInput({ smileTrigger: true });
    }
  }
}

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
