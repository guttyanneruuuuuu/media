/* ============================================================
 * game.js - Sky Duel ゲームエンジン
 *
 * - 2つのアリーナ (上=opponent, 下=self) に分割
 * - プレイヤー本体 + 魔法弾(projectile) + シールド + パーティクル
 * - ローカルプレイヤーは GestureEngine から入力を受け取り
 * - 対戦相手は AI または ネット相手 (NetController 経由)
 * - HPが先に0、または2分経過時にHPが多い方の勝ち
 * ============================================================ */

export const GAME_CONFIG = {
  matchSeconds: 120,
  maxHP: 100,
  maxEnergy: 100,
  bulletDamage: 8,
  specialDamage: 28,
  smileHeal: 4,
  smileCooldownMs: 1500,
  energyChargeRate: 22, // /sec while peace gesture
  shieldDecay: 18,      // /sec while fist
  bulletCost: 12,
  specialCost: 60,
  bulletSpeed: 0.85,    // 単位/秒（アリーナ高さに対する割合）
  specialSpeed: 0.65,
  playerSpeed: 0.0035,  // 補間係数
  bulletCooldownMs: 350,
};

/**
 * ゲーム状態を保持するクラス。
 *
 * canvasSelf / canvasOpp に絵を描き、毎フレーム updates する。
 * netSender? は友達対戦時の送信フック (action) => void
 */
export class GameEngine {
  constructor({
    canvasSelf,
    canvasOpp,
    onMatchEnd,
    onHudUpdate,
    onToast,
    role = "solo", // "solo" | "host" | "guest"
  }) {
    this.canvasSelf = canvasSelf;
    this.canvasOpp = canvasOpp;
    this.ctxSelf = canvasSelf.getContext("2d");
    this.ctxOpp = canvasOpp.getContext("2d");
    this.onMatchEnd = onMatchEnd;
    this.onHudUpdate = onHudUpdate;
    this.onToast = onToast;
    this.role = role; // ホスト権威モデル
    this._lastStateSyncAt = 0;

    this.players = {
      self: makePlayer("self"),
      opp: makePlayer("opp"),
    };

    this.bullets = []; // {ownerKey, x, y, vx, vy, type, dmg}
    this.particles = [];
    this.startTime = 0;
    this.elapsedMs = 0;
    this.running = false;
    this.ended = false;
    this._lastBulletAt = { self: 0, opp: 0 };
    this._lastSmileAt = { self: 0, opp: 0 };
    this._lastFrameAt = 0;
    this._rafId = null;

    this._inputBuf = { self: defaultInput(), opp: defaultInput() };

    // 統計
    this.stats = {
      self: { hits: 0, specials: 0 },
      opp: { hits: 0, specials: 0 },
    };

    this._resizeBound = this._handleResize.bind(this);
    window.addEventListener("resize", this._resizeBound);
    this._handleResize();
  }

  _handleResize() {
    [this.canvasSelf, this.canvasOpp].forEach((c) => {
      const r = c.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      c.width = Math.max(2, Math.round(r.width * dpr));
      c.height = Math.max(2, Math.round(r.height * dpr));
    });
  }

  /** ジェスチャー状態 → input へ反映 (ローカル自分側) */
  setLocalInputFromGestures(gestureState) {
    const inp = this._inputBuf.self;
    inp.handVisible = gestureState.handVisible;
    inp.handX = gestureState.handX;
    inp.gesture = gestureState.gesture;
    inp.punch = inp.punch || gestureState.punch;
    inp.mouthOpenTrigger = inp.mouthOpenTrigger || gestureState.mouthOpenTrigger;
    inp.smileTrigger = inp.smileTrigger || gestureState.smileTrigger;
  }

  /** ネット/AI から入力反映 (相手側) */
  setOpponentInput(partial) {
    Object.assign(this._inputBuf.opp, partial);
  }

  /** ネット越しに弾アクションを受信 (相手が撃ってきたなど) */
  applyRemoteAction(action) {
    if (action.type === "bullet") {
      this._spawnBullet("opp", action.x, action.special);
    } else if (action.type === "heal") {
      const p = this.players.opp;
      p.hp = Math.min(GAME_CONFIG.maxHP, p.hp + GAME_CONFIG.smileHeal);
    } else if (action.type === "shield") {
      this.players.opp.shielding = action.on;
    } else if (action.type === "charge") {
      this.players.opp.charging = action.on;
    } else if (action.type === "move") {
      this.players.opp.targetX = action.x;
    } else if (action.type === "state") {
      // HP同期（ホストが権威）
      if (typeof action.selfHP === "number") this.players.opp.hp = action.selfHP;
      if (typeof action.oppHP === "number") this.players.self.hp = action.oppHP;
    }
  }

  /** ネット送信フック登録 */
  setNetSender(fn) { this._netSender = fn; }

  start() {
    this.running = true;
    this.ended = false;
    this.startTime = performance.now();
    this._lastFrameAt = this.startTime;
    this._loop();
  }

  stop() {
    this.running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    window.removeEventListener("resize", this._resizeBound);
  }

  _loop = () => {
    if (!this.running) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this._lastFrameAt) / 1000);
    this._lastFrameAt = now;
    this.elapsedMs = now - this.startTime;

    this._step(dt, now);
    this._draw();
    this._pushHud();

    // 勝敗判定
    if (!this.ended) {
      const { self, opp } = this.players;
      const remain = GAME_CONFIG.matchSeconds * 1000 - this.elapsedMs;
      if (self.hp <= 0 || opp.hp <= 0 || remain <= 0) {
        this._endMatch();
      }
    }

    this._rafId = requestAnimationFrame(this._loop);
  };

  _step(dt, now) {
    const cfg = GAME_CONFIG;

    // --- self 入力処理 ---
    this._processInput("self", dt, now);
    // --- opp 入力処理（ローカルAIまたは受信済みstate）---
    this._processInput("opp", dt, now);

    // 物理: 弾移動
    for (const b of this.bullets) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.age += dt;
    }

    // 当たり判定はホスト権威モードでは host のみが判定する
    const judgeHits = this.role !== "guest";
    // 当たり判定 (各弾 → 相手アリーナ中央付近の相手キャラ)
    for (const b of this.bullets) {
      if (b.dead) continue;
      if (!judgeHits) {
        // ゲスト側はホストから state を受け取るので、弾はビジュアルだけ。
        // 画面外に出たら消す。
        if (b.y < -1.2 || b.y > 2.2) b.dead = true;
        continue;
      }
      // 弾の所有者の「アリーナ」を出て相手の「アリーナ」に入ったかをy座標で判定
      // 座標系は normalize [0..1] per arena, y は 0=上端 / 1=下端
      // self は下アリーナで撃つ → y が小さくなる方向に飛ぶ → 自分アリーナを出る (y<0) と相手アリーナへ
      // opp は上アリーナで撃つ → y が大きくなる方向 → y>1 で自分アリーナへ
      const targetKey = b.ownerKey === "self" ? "opp" : "self";
      const target = this.players[targetKey];
      // 弾が「相手アリーナへ越境」したらヒットチェック
      if (b.ownerKey === "self" && b.y <= 0) {
        // 上アリーナへ移行: 相手座標もアリーナローカル(0..1)
        const oppLocalY = 1 + b.y; // -0.2 → 0.8 → 相手キャラ近く
        if (oppLocalY < 1 && this._hitsPlayer({ x: b.x, y: oppLocalY }, target)) {
          this._damage(targetKey, b);
          b.dead = true;
        } else if (b.y < -1) b.dead = true;
      } else if (b.ownerKey === "opp" && b.y >= 1) {
        const selfLocalY = b.y - 1;
        if (selfLocalY < 1 && this._hitsPlayer({ x: b.x, y: selfLocalY }, target)) {
          this._damage(targetKey, b);
          b.dead = true;
        } else if (b.y > 2) b.dead = true;
      }
    }
    this.bullets = this.bullets.filter((b) => !b.dead);

    // ホスト権威: 定期的にHPを送信
    if (this.role === "host" && this._netSender) {
      if (now - this._lastStateSyncAt > 150) {
        this._lastStateSyncAt = now;
        this._netSender({
          type: "state",
          // 相手から見れば 自分のHP = opp、相手のHP = self
          // 受信側 applyRemoteAction({type:"state", selfHP, oppHP}) で
          //   opp.hp = selfHP (送信者から見たself)
          //   self.hp = oppHP
          selfHP: this.players.self.hp,
          oppHP: this.players.opp.hp,
        });
      }
    }

    // パーティクル更新
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      p.vy += p.gravity * dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  _processInput(key, dt, now) {
    const p = this.players[key];
    const inp = this._inputBuf[key];
    const cfg = GAME_CONFIG;

    // 左右移動
    if (key === "self") {
      if (inp.handVisible) {
        p.targetX = clamp(inp.handX, 0.08, 0.92);
      }
    }
    p.x += (p.targetX - p.x) * Math.min(1, dt * 10);

    // ジェスチャー→状態
    if (key === "self") {
      const wasShield = p.shielding;
      const wasCharge = p.charging;
      p.shielding = inp.gesture === "fist";
      p.charging = inp.gesture === "peace";
      if (wasShield !== p.shielding && this._netSender) {
        this._netSender({ type: "shield", on: p.shielding });
      }
      if (wasCharge !== p.charging && this._netSender) {
        this._netSender({ type: "charge", on: p.charging });
      }
      // 移動は時々送信（節約）
      if (!p._lastSentX || Math.abs(p._lastSentX - p.targetX) > 0.03) {
        p._lastSentX = p.targetX;
        this._netSender?.({ type: "move", x: p.targetX });
      }
    }

    // チャージ中はエネルギー増加
    if (p.charging) {
      p.energy = Math.min(cfg.maxEnergy, p.energy + cfg.energyChargeRate * dt);
    } else {
      // 待機時の自然回復は弱く
      p.energy = Math.min(cfg.maxEnergy, p.energy + 4 * dt);
    }

    // シールドはエネルギーを消費
    if (p.shielding) {
      p.energy = Math.max(0, p.energy - cfg.shieldDecay * dt);
      if (p.energy <= 0) p.shielding = false;
    }

    // 通常弾 (パー+突き出し)
    if (inp.punch) {
      inp.punch = false;
      if (p.energy >= cfg.bulletCost && now - this._lastBulletAt[key] > cfg.bulletCooldownMs) {
        p.energy -= cfg.bulletCost;
        this._lastBulletAt[key] = now;
        this._spawnBullet(key, p.x, false);
        if (key === "self") this._netSender?.({ type: "bullet", x: p.x, special: false });
      }
    }
    // 必殺 (口を開く)
    if (inp.mouthOpenTrigger) {
      inp.mouthOpenTrigger = false;
      if (p.energy >= cfg.specialCost) {
        p.energy -= cfg.specialCost;
        this._spawnBullet(key, p.x, true);
        this.stats[key].specials += 1;
        if (key === "self") {
          this._netSender?.({ type: "bullet", x: p.x, special: true });
          this.onToast?.("⚡ 必殺技！");
        }
      } else if (key === "self") {
        this.onToast?.("エネルギー不足…");
      }
    }
    // 回復 (笑顔)
    if (inp.smileTrigger) {
      inp.smileTrigger = false;
      if (now - this._lastSmileAt[key] > cfg.smileCooldownMs) {
        this._lastSmileAt[key] = now;
        p.hp = Math.min(cfg.maxHP, p.hp + cfg.smileHeal);
        this._addSparkle(key, p.x, 0.3, "#ffd166");
        if (key === "self") {
          this._netSender?.({ type: "heal" });
          this.onToast?.("😊 ちょい回復");
        }
      }
    }
  }

  _spawnBullet(ownerKey, x, special) {
    const speed = special ? GAME_CONFIG.specialSpeed : GAME_CONFIG.bulletSpeed;
    const dir = ownerKey === "self" ? -1 : 1;
    // 始点: 自分側アリーナ上端付近（self→0.2, opp→0.8 の自分側ローカル座標）
    const startY = ownerKey === "self" ? 0.45 : 0.55;
    // self 弾は self アリーナを上昇 → グローバル y: 0.45 → 0 → -? を経て相手アリーナへ
    // 統一座標系: ownerKey === "self" の弾は y = startY からスタート (selfアリーナローカル) で
    //   y -= speed*dt し、y<=0 で相手アリーナへ
    this.bullets.push({
      ownerKey,
      x,
      y: ownerKey === "self" ? startY : 1 - startY, // 開始
      vx: 0,
      vy: dir * speed,
      type: special ? "special" : "normal",
      dmg: special ? GAME_CONFIG.specialDamage : GAME_CONFIG.bulletDamage,
      age: 0,
      dead: false,
      r: special ? 0.06 : 0.035,
    });
    this._addSparkle(ownerKey, x, ownerKey === "self" ? 0.4 : 0.6, special ? "#ff8f3f" : "#5fb1f6");
  }

  _hitsPlayer(point, target) {
    // playerは自分アリーナ内のy ≒ 0.65 付近に立っている
    const px = target.x;
    const py = 0.65;
    const dx = point.x - px;
    const dy = point.y - py;
    const d = Math.sqrt(dx * dx + dy * dy);
    return d < 0.13; // hit radius
  }

  _damage(targetKey, bullet) {
    const t = this.players[targetKey];
    let dmg = bullet.dmg;
    if (t.shielding && bullet.type !== "special") {
      dmg = Math.floor(dmg * 0.15); // シールドで大幅軽減
      this._addSparkle(targetKey, t.x, 0.55, "#95cdff");
    } else if (t.shielding && bullet.type === "special") {
      dmg = Math.floor(dmg * 0.6); // 必殺は半減程度
      this._addSparkle(targetKey, t.x, 0.55, "#ff8f3f");
    }
    t.hp = Math.max(0, t.hp - dmg);
    t.hurtUntil = performance.now() + 220;
    const attackerKey = targetKey === "self" ? "opp" : "self";
    this.stats[attackerKey].hits += 1;
    this._addSparkle(targetKey, t.x, 0.65, bullet.type === "special" ? "#ff6b88" : "#ff8f3f");
  }

  _addSparkle(arena, x, y, color) {
    const n = 10;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 0.2 + Math.random() * 0.6;
      this.particles.push({
        arena,
        x, y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        gravity: 0.6,
        life: 0.45 + Math.random() * 0.35,
        maxLife: 0.8,
        color,
        size: 2 + Math.random() * 3,
      });
    }
  }

  _endMatch() {
    if (this.ended) return;
    this.ended = true;
    this.running = false;
    const { self, opp } = this.players;
    let result = "draw";
    if (self.hp > opp.hp) result = "win";
    else if (self.hp < opp.hp) result = "lose";
    this.onMatchEnd?.({
      result,
      selfHP: self.hp,
      oppHP: opp.hp,
      stats: this.stats,
    });
  }

  _pushHud() {
    this.onHudUpdate?.({
      selfHP: this.players.self.hp,
      oppHP: this.players.opp.hp,
      selfEnergy: this.players.self.energy,
      oppEnergy: this.players.opp.energy,
      remainMs: Math.max(0, GAME_CONFIG.matchSeconds * 1000 - this.elapsedMs),
    });
  }

  /* ============= 描画 ============= */
  _draw() {
    // self アリーナ
    this._drawArena(this.ctxSelf, this.canvasSelf, "self");
    // opp アリーナ
    this._drawArena(this.ctxOpp, this.canvasOpp, "opp");
  }

  _drawArena(ctx, canvas, arenaKey) {
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // 背景: 雲とアリーナ床
    drawArenaBackground(ctx, W, H, arenaKey);

    const player = this.players[arenaKey];
    drawPlayer(ctx, W, H, player, arenaKey);

    // 弾: arenaKey の領域に該当する弾を描く
    for (const b of this.bullets) {
      let localY = null;
      if (b.ownerKey === arenaKey) {
        // 自分アリーナで y in [0..1]
        if (b.y >= 0 && b.y <= 1) localY = b.y;
      } else {
        // 越境した弾 (b.ownerKey は相手) → arenaKey 側に来ているか
        if (b.ownerKey === "self" && arenaKey === "opp" && b.y < 0) {
          localY = 1 + b.y; // -0.2 → 0.8
        } else if (b.ownerKey === "opp" && arenaKey === "self" && b.y > 1) {
          localY = b.y - 1;
        }
      }
      if (localY === null) continue;
      drawBullet(ctx, W, H, b, localY);
    }

    for (const p of this.particles) {
      if (p.arena !== arenaKey) continue;
      drawParticle(ctx, W, H, p);
    }

    // シールドエフェクト
    if (player.shielding) drawShield(ctx, W, H, player);
    // チャージエフェクト
    if (player.charging) drawCharge(ctx, W, H, player);
  }
}

/* ====================== ヘルパー ====================== */

function makePlayer(key) {
  return {
    key,
    x: 0.5,
    targetX: 0.5,
    hp: GAME_CONFIG.maxHP,
    energy: 40,
    shielding: false,
    charging: false,
  };
}

function defaultInput() {
  return {
    handVisible: false,
    handX: 0.5,
    gesture: "none",
    punch: false,
    mouthOpenTrigger: false,
    smileTrigger: false,
  };
}

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

/* ====================== 描画関数 ====================== */

function drawArenaBackground(ctx, W, H, arenaKey) {
  // パステル雲アリーナ
  const grd = ctx.createLinearGradient(0, 0, 0, H);
  if (arenaKey === "opp") {
    grd.addColorStop(0, "#ffd9b3");
    grd.addColorStop(1, "#ffe9d2");
  } else {
    grd.addColorStop(0, "#cfe8ff");
    grd.addColorStop(1, "#a8d4ff");
  }
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, H);

  // 雲
  const t = performance.now() / 4000;
  for (let i = 0; i < 4; i++) {
    const cx = ((t * (i % 2 === 0 ? 1 : -1) + i * 0.3) % 1.4) * W - 0.2 * W;
    const cy = (0.2 + (i * 0.2)) * H;
    drawCloud(ctx, cx, cy, 0.18 * W);
  }

  // アリーナ床（楕円のプラットホーム）
  ctx.fillStyle = arenaKey === "opp" ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.7)";
  ctx.beginPath();
  ctx.ellipse(W / 2, H * 0.78, W * 0.42, H * 0.08, 0, 0, Math.PI * 2);
  ctx.fill();
  // 床の影
  ctx.strokeStyle = "rgba(91,109,138,0.18)";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawCloud(ctx, x, y, size) {
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.beginPath();
  ctx.arc(x, y, size * 0.5, 0, Math.PI * 2);
  ctx.arc(x + size * 0.4, y - size * 0.15, size * 0.4, 0, Math.PI * 2);
  ctx.arc(x + size * 0.8, y, size * 0.45, 0, Math.PI * 2);
  ctx.arc(x + size * 0.3, y + size * 0.15, size * 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPlayer(ctx, W, H, player, arenaKey) {
  const px = player.x * W;
  const py = H * 0.72;
  const r = Math.min(W, H) * 0.11;
  const hurt = player.hurtUntil && performance.now() < player.hurtUntil;

  // 影
  ctx.fillStyle = "rgba(60,95,150,0.18)";
  ctx.beginPath();
  ctx.ellipse(px, py + r * 0.9, r * 0.8, r * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();

  // ボディ（丸い妖精キャラ）
  const bodyColor = arenaKey === "self" ? "#5fb1f6" : "#ff8f3f";
  const accentColor = arenaKey === "self" ? "#ffe28a" : "#fff8e6";

  // 翼（揺れアニメ）
  const wave = Math.sin(performance.now() / 200) * 0.15 + 1;
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.beginPath();
  ctx.ellipse(px - r * 0.7, py - r * 0.2, r * 0.5 * wave, r * 0.35, -0.4, 0, Math.PI * 2);
  ctx.ellipse(px + r * 0.7, py - r * 0.2, r * 0.5 * wave, r * 0.35, 0.4, 0, Math.PI * 2);
  ctx.fill();

  // 本体
  ctx.fillStyle = hurt ? "#ff6b88" : bodyColor;
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fill();
  if (hurt) {
    ctx.strokeStyle = "rgba(255,107,136,0.6)";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(px, py, r + 8, 0, Math.PI * 2);
    ctx.stroke();
  }

  // ハイライト
  ctx.fillStyle = accentColor;
  ctx.beginPath();
  ctx.arc(px - r * 0.3, py - r * 0.3, r * 0.3, 0, Math.PI * 2);
  ctx.fill();

  // 目
  ctx.fillStyle = "#2c3e5c";
  ctx.beginPath();
  ctx.arc(px - r * 0.25, py - r * 0.1, r * 0.08, 0, Math.PI * 2);
  ctx.arc(px + r * 0.25, py - r * 0.1, r * 0.08, 0, Math.PI * 2);
  ctx.fill();

  // 口
  ctx.strokeStyle = "#2c3e5c";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(px, py + r * 0.15, r * 0.18, 0.2, Math.PI - 0.2);
  ctx.stroke();
}

function drawBullet(ctx, W, H, b, localY) {
  const x = b.x * W;
  const y = localY * H;
  const r = b.r * Math.min(W, H);

  ctx.save();
  // グロー
  const grad = ctx.createRadialGradient(x, y, 0, x, y, r * 2.4);
  const col = b.type === "special"
    ? ["rgba(255,143,63,1)", "rgba(255,143,63,0)"]
    : ["rgba(95,177,246,1)", "rgba(95,177,246,0)"];
  grad.addColorStop(0, col[0]);
  grad.addColorStop(1, col[1]);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, r * 2.4, 0, Math.PI * 2);
  ctx.fill();

  // コア
  ctx.fillStyle = b.type === "special" ? "#ffe28a" : "#ffffff";
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = b.type === "special" ? "#ff6b88" : "#3994e0";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawParticle(ctx, W, H, p) {
  const x = p.x * W;
  const y = p.y * H;
  const a = Math.max(0, p.life / p.maxLife);
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = p.color;
  ctx.beginPath();
  ctx.arc(x, y, p.size, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawShield(ctx, W, H, player) {
  const px = player.x * W;
  const py = H * 0.72;
  const r = Math.min(W, H) * 0.18;
  const pulse = 1 + Math.sin(performance.now() / 120) * 0.06;
  ctx.save();
  ctx.strokeStyle = "rgba(95,177,246,0.85)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(px, py, r * pulse, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(200,230,255,0.25)";
  ctx.fill();
  ctx.restore();
}

function drawCharge(ctx, W, H, player) {
  const px = player.x * W;
  const py = H * 0.72;
  const r = Math.min(W, H) * 0.14;
  ctx.save();
  // 渦の粒
  const t = performance.now() / 200;
  for (let i = 0; i < 8; i++) {
    const ang = t + (i * Math.PI * 2) / 8;
    const x = px + Math.cos(ang) * r;
    const y = py + Math.sin(ang) * r;
    ctx.fillStyle = "rgba(255,226,138,0.95)";
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
