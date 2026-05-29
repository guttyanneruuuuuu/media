/* ============================================================
 * main.js - Sky Duel エントリーポイント
 *
 * 画面遷移、カメラ、MediaPipe、ゲーム、AI、P2P を統括する。
 * ============================================================ */

import { GestureEngine, startCamera, stopCamera } from "./gestures.js";
import { GameEngine, GAME_CONFIG } from "./game.js";
import { AIController } from "./ai.js";
import { NetController } from "./net.js";

/* ====================== 画面管理 ====================== */
const screens = [
  "screen-title",
  "screen-howto",
  "screen-room",
  "screen-prepare",
  "screen-game",
  "screen-result",
];
function showScreen(id) {
  for (const s of screens) {
    document.getElementById(s)?.classList.toggle("active", s === id);
  }
}
function $(id) { return document.getElementById(id); }

/* ====================== グローバル状態 ====================== */
const state = {
  mode: null, // "ai" | "host" | "guest"
  gestureEngine: null,
  game: null,
  ai: null,
  net: null,
  cameraStream: null,
  gestureInitialized: false,
};

/* ====================== ローダー ====================== */
function showLoader(text = "読み込み中…") {
  $("loader-text").textContent = text;
  $("loader").hidden = false;
}
function hideLoader() { $("loader").hidden = true; }

/* ====================== 共通アクションリスナー ====================== */
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-action]");
  if (!t) return;
  const a = t.dataset.action;
  if (a === "goto-ai") startPrepare("ai");
  else if (a === "goto-room") { showScreen("screen-room"); resetRoomUI(); }
  else if (a === "goto-howto") showScreen("screen-howto");
  else if (a === "back-title") backToTitle();
  else if (a === "rematch") rematch();
});

/* ====================== タブ切り替え ====================== */
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    $("tab-" + tab.dataset.tab).classList.add("active");
  });
});

/* ====================== ルーム ====================== */
$("btn-create-room").addEventListener("click", async () => {
  showLoader("部屋を作成中…");
  ensureNet();
  state.net.createRoom();
  state.mode = "host";
});

$("btn-join-room").addEventListener("click", async () => {
  const code = $("input-room-code").value.trim().toUpperCase();
  if (code.length !== 6) {
    $("join-status").textContent = "コードは6文字で入力してください";
    return;
  }
  showLoader("接続中…");
  ensureNet();
  state.net.joinRoom(code);
  state.mode = "guest";
});

$("btn-copy-code").addEventListener("click", async () => {
  const code = $("room-code-display").textContent;
  try { await navigator.clipboard.writeText(code); $("room-status").textContent = "✅ コードをコピーしました"; } catch (e) {}
});

$("btn-share-code").addEventListener("click", async () => {
  const code = $("room-code-display").textContent;
  const url = location.href.split('?')[0] + `?room=${code}`;
  const text = `Sky Duel で対戦しよう！\nルームコード: ${code}\n${url}`;
  if (navigator.share) {
    try { await navigator.share({ title: "Sky Duel 対戦招待", text }); } catch (e) {}
  } else {
    try { await navigator.clipboard.writeText(text); $("room-status").textContent = "✅ 招待文をコピーしました"; } catch (e) {}
  }
});

function ensureNet() {
  if (state.net) { state.net.close(); }
  state.net = new NetController({
    onOpen: (id) => {
      hideLoader();
      if (state.mode === "host") {
        $("room-code-box").hidden = false;
        $("room-code-display").textContent = state.net.roomCode;
        $("room-status").textContent = "友達の参加を待っています…";
      }
    },
    onConnect: () => {
      hideLoader();
      if (state.mode === "host") {
        $("room-status").textContent = "✅ 友達が参加しました！準備に進みます";
      } else {
        $("join-status").textContent = "✅ 部屋に入りました！";
      }
      // ホストが対戦開始の主導権を持つ
      setTimeout(() => startPrepare(state.mode), 800);
    },
    onMessage: handleNetMessage,
    onClose: () => {
      showToast("通信が切断されました");
    },
    onError: (e) => {
      hideLoader();
      const msg = (state.mode === "guest" ? $("join-status") : $("room-status"));
      if (msg) msg.textContent = "⚠ 通信エラー: " + (e?.type || e?.message || "失敗");
      console.warn(e);
    },
  });
}

function resetRoomUI() {
  $("room-code-box").hidden = true;
  $("room-status").textContent = "";
  $("join-status").textContent = "";
  $("input-room-code").value = "";
}

function handleNetMessage(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === "action" && state.game) {
    state.game.applyRemoteAction(msg.action);
  } else if (msg.type === "ready") {
    // 相手も準備完了。何もしない（カウントダウンはホスト側でトリガー）
  } else if (msg.type === "start") {
    // ホストからの開始合図
    startCountdown();
  } else if (msg.type === "end") {
    // 相手側の判定（一応保険）
  }
}

/* ====================== カメラ準備 → ゲーム ====================== */
async function startPrepare(mode) {
  state.mode = mode;
  showScreen("screen-prepare");
  showLoader("カメラを起動しています…");
  try {
    const video = $("prep-video");
    state.cameraStream = await startCamera(video);
    showLoader("AIモデルを読み込み中…");
    if (!state.gestureEngine) {
      state.gestureEngine = new GestureEngine(video, onPrepGesture);
      await state.gestureEngine.init();
    } else {
      // 既存のengineを新しいvideoに付け替え
      state.gestureEngine.video = video;
      state.gestureEngine.onState = onPrepGesture;
    }
    state.gestureEngine.start();
    hideLoader();

    $("btn-start-game").disabled = true;
    $("check-hand").innerHTML = "✋ 手が見える: <b>未検出</b>";
    $("check-face").innerHTML = "😀 顔が見える: <b>未検出</b>";

  } catch (e) {
    hideLoader();
    let msg = "カメラ起動に失敗しました";
    if (e?.name === "NotAllowedError") msg = "📷 カメラ権限が許可されていません。\nブラウザの設定からカメラを許可してください。";
    else if (e?.name === "NotFoundError") msg = "📷 カメラが見つかりません。";
    else if (e?.message) msg += ": " + e.message;
    alert(msg);
    backToTitle();
  }
}

let prepReady = { hand: false, face: false };
function onPrepGesture(s) {
  // プレビュー描画
  drawPrepOverlay(s);

  // 検出状況UI
  if (s.handVisible !== prepReady.hand) {
    prepReady.hand = s.handVisible;
    const el = $("check-hand");
    el.innerHTML = "✋ 手が見える: <b>" + (s.handVisible ? "OK" : "未検出") + "</b>";
    el.classList.toggle("ok", s.handVisible);
  }
  if (s.faceVisible !== prepReady.face) {
    prepReady.face = s.faceVisible;
    const el = $("check-face");
    el.innerHTML = "😀 顔が見える: <b>" + (s.faceVisible ? "OK" : "未検出") + "</b>";
    el.classList.toggle("ok", s.faceVisible);
  }
  $("btn-start-game").disabled = !(prepReady.hand && prepReady.face);
}

function drawPrepOverlay(s) {
  const cv = $("prep-canvas");
  const vid = $("prep-video");
  if (!cv || !vid.videoWidth) return;
  if (cv.width !== vid.videoWidth) {
    cv.width = vid.videoWidth;
    cv.height = vid.videoHeight;
  }
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, cv.width, cv.height);
  // 手のランドマーク描画
  const hr = s.raw?.handResult;
  if (hr?.landmarks?.length) {
    const lm = hr.landmarks[0];
    ctx.strokeStyle = "#5fb1f6";
    ctx.fillStyle = "#ff8f3f";
    ctx.lineWidth = 2;
    const connections = [
      [0,1],[1,2],[2,3],[3,4],
      [0,5],[5,6],[6,7],[7,8],
      [5,9],[9,10],[10,11],[11,12],
      [9,13],[13,14],[14,15],[15,16],
      [13,17],[17,18],[18,19],[19,20],[0,17]
    ];
    ctx.beginPath();
    for (const [a,b] of connections) {
      ctx.moveTo(lm[a].x * cv.width, lm[a].y * cv.height);
      ctx.lineTo(lm[b].x * cv.width, lm[b].y * cv.height);
    }
    ctx.stroke();
    for (const p of lm) {
      ctx.beginPath();
      ctx.arc(p.x * cv.width, p.y * cv.height, 3, 0, Math.PI*2);
      ctx.fill();
    }
  }
  // 顔（少しだけ目立たない目印）
  const fr = s.raw?.faceResult;
  if (fr?.faceLandmarks?.length) {
    const lm = fr.faceLandmarks[0];
    ctx.fillStyle = "rgba(255,177,193,0.7)";
    for (let i = 0; i < lm.length; i += 8) {
      ctx.beginPath();
      ctx.arc(lm[i].x * cv.width, lm[i].y * cv.height, 1.2, 0, Math.PI*2);
      ctx.fill();
    }
  }
}

$("btn-start-game").addEventListener("click", () => {
  if (state.mode === "host") {
    // ホストはゲスト側にもスタートを通知
    state.net?.send({ type: "start" });
    startCountdown();
  } else if (state.mode === "guest") {
    // ゲストは ready を送って待つ（ホストが start を送ってくる）
    state.net?.send({ type: "ready" });
    showToast("ホストの開始合図を待っています…");
    // 上記の handleNetMessage("start") でカウントダウン開始
  } else {
    // AI
    startCountdown();
  }
});

/* ====================== カウントダウン → ゲーム開始 ====================== */
async function startCountdown() {
  showScreen("screen-game");
  // ゲーム用ビデオに同じストリームを表示
  const gameVideo = $("game-video");
  if (state.cameraStream) {
    gameVideo.srcObject = state.cameraStream;
    await gameVideo.play().catch(()=>{});
  }
  // gestureEngine を game-video に切替
  state.gestureEngine.stop();
  state.gestureEngine.video = gameVideo;
  state.gestureEngine.onState = onGameGesture;
  state.gestureEngine.start();

  // カウントダウン表示
  const cd = $("countdown");
  cd.hidden = false;
  for (const n of ["3", "2", "1", "START!"]) {
    cd.textContent = n;
    cd.classList.remove("beat");
    void cd.offsetWidth;
    cd.classList.add("beat");
    await sleep(900);
  }
  cd.hidden = true;

  // ゲームエンジン起動
  const role = state.mode === "host" ? "host"
            : state.mode === "guest" ? "guest"
            : "solo";
  const engine = new GameEngine({
    canvasSelf: $("canvas-self"),
    canvasOpp: $("canvas-opponent"),
    onHudUpdate: updateHud,
    onToast: showToast,
    onMatchEnd: handleMatchEnd,
    role,
  });
  state.game = engine;

  if (state.mode === "ai") {
    state.ai = new AIController(engine, { difficulty: "normal" });
    state.ai.start();
    $("opponent-name").textContent = "AI";
  } else {
    // 友達対戦: net送信フックを接続
    engine.setNetSender((action) => {
      state.net?.send({ type: "action", action });
    });
    $("opponent-name").textContent = state.mode === "host" ? "ゲスト" : "ホスト";
  }

  engine.start();
  state._gameLoop = setInterval(() => {
    if (state.ai && state.game?.running) state.ai.update();
  }, 50);
}

function onGameGesture(s) {
  if (state.game) state.game.setLocalInputFromGestures(s);
  // ジェスチャータグ
  let tag = "-";
  if (!s.handVisible) tag = "手なし";
  else if (s.gesture === "fist") tag = "✊ シールド";
  else if (s.gesture === "peace") tag = "✌️ チャージ";
  else if (s.gesture === "open") tag = "🖐️ 射撃";
  else if (s.gesture === "point") tag = "☝️ 指";
  else tag = "・";
  if (s.mouthOpenTrigger) tag = "😮 必殺！";
  else if (s.smileTrigger) tag = "😊 回復";
  $("gesture-tag").textContent = tag;
}

/* ====================== HUD ====================== */
function updateHud({ selfHP, oppHP, selfEnergy, oppEnergy, remainMs }) {
  $("self-hp").textContent = Math.ceil(selfHP);
  $("opponent-hp").textContent = Math.ceil(oppHP);
  $("self-hp-fill").style.width = (selfHP / GAME_CONFIG.maxHP * 100) + "%";
  $("opponent-hp-fill").style.width = (oppHP / GAME_CONFIG.maxHP * 100) + "%";
  $("self-hp-fill").classList.toggle("low", selfHP < 30);
  $("opponent-hp-fill").classList.toggle("low", oppHP < 30);
  $("self-energy-fill").style.width = (selfEnergy / GAME_CONFIG.maxEnergy * 100) + "%";
  $("opponent-energy-fill").style.width = (oppEnergy / GAME_CONFIG.maxEnergy * 100) + "%";

  const total = Math.ceil(remainMs / 1000);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  const t = $("timer-display");
  t.textContent = `${m}:${String(sec).padStart(2, "0")}`;
  t.classList.toggle("urgent", total <= 15);
}

/* ====================== トースト ====================== */
let _toastTimer = null;
function showToast(msg) {
  const el = $("game-toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove("show"), 1200);
}

/* ====================== 試合終了 ====================== */
function handleMatchEnd({ result, selfHP, oppHP, stats }) {
  if (state._gameLoop) { clearInterval(state._gameLoop); state._gameLoop = null; }
  // net 相手にも通知
  state.net?.send({ type: "end", winner: result === "win" ? (state.mode === "host" ? "host" : "guest") : "" });

  showScreen("screen-result");
  const title = $("result-title");
  const emoji = $("result-emoji");
  title.classList.remove("win", "lose", "draw");
  if (result === "win") {
    title.textContent = "勝利！";
    title.classList.add("win");
    emoji.textContent = "🏆";
  } else if (result === "lose") {
    title.textContent = "敗北…";
    title.classList.add("lose");
    emoji.textContent = "😢";
  } else {
    title.textContent = "引き分け";
    title.classList.add("draw");
    emoji.textContent = "🤝";
  }
  $("stat-hp").textContent = Math.ceil(selfHP);
  $("stat-hits").textContent = stats.self.hits;
  $("stat-specials").textContent = stats.self.specials;
}

/* ====================== Rematch / 戻る ====================== */
function rematch() {
  cleanupGame();
  if (state.mode === "ai") startPrepare("ai");
  else if (state.mode === "host" || state.mode === "guest") {
    // 同じ接続のままならそのまま再戦
    if (state.net?.conn?.open) startPrepare(state.mode);
    else { resetRoomUI(); showScreen("screen-room"); }
  } else {
    backToTitle();
  }
}

function backToTitle() {
  cleanupGame();
  state.net?.close();
  state.net = null;
  stopCamera($("prep-video"));
  stopCamera($("game-video"));
  state.cameraStream = null;
  state.gestureEngine?.stop();
  state.gestureEngine = null;
  resetRoomUI();
  showScreen("screen-title");
}

function cleanupGame() {
  if (state._gameLoop) { clearInterval(state._gameLoop); state._gameLoop = null; }
  state.game?.stop();
  state.game = null;
  state.ai = null;
}

/* ====================== URL ?room=XXXX で自動参加 ====================== */
(function autoJoin() {
  const params = new URLSearchParams(location.search);
  const code = params.get("room");
  if (code && /^[A-Z0-9]{6}$/i.test(code)) {
    showScreen("screen-room");
    // join タブにする
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelector('.tab[data-tab="join"]').classList.add("active");
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    $("tab-join").classList.add("active");
    $("input-room-code").value = code.toUpperCase();
  }
})();

/* ====================== utils ====================== */
function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }
