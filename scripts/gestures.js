/* ============================================================
 * gestures.js - MediaPipe Hand & Face landmark処理
 *
 * MediaPipe Tasks Vision (ESM via CDN) を動的読込し、
 * カメラフレームから以下を抽出してコールバックに渡す。
 *   - 手の位置 (x: 0..1, mirrored)
 *   - 指の状態 → fist / open / peace / point
 *   - 「前に突き出す」モーション（短期 z 変化）
 *   - 口の開き具合 (mouth open ratio)
 *   - 笑顔度 (smile score)
 * ============================================================ */

const VISION_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const HAND_MODEL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const WASM_BASE =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";

/**
 * GestureEngine
 *   video: HTMLVideoElement (カメラストリーム)
 *   onState: (state) => void  — フレームごとの最新状態
 */
export class GestureEngine {
  constructor(video, onState) {
    this.video = video;
    this.onState = onState;
    this.running = false;

    this.handLandmarker = null;
    this.faceLandmarker = null;

    this.lastVideoTime = -1;
    this._rafId = null;

    // 突き出し検出用の手首zバッファ
    this._wristZHistory = [];
    this._lastPunchTime = 0;

    // 直近のジェスチャー状態（外部公開）
    this.state = {
      handVisible: false,
      faceVisible: false,
      handX: 0.5,     // 0..1 (mirrored: 左→0)
      handY: 0.5,
      gesture: "none", // "open" | "fist" | "peace" | "point" | "none"
      punch: false,    // 一瞬trueになるエッジ
      mouthOpen: 0,    // 0..1
      smile: 0,        // 0..1
      mouthOpenTrigger: false,
      smileTrigger: false,
      raw: null,
    };

    // 表情系のトリガー制御（連続発火防止）
    this._mouthOpenState = false;
    this._smileState = false;
  }

  async init() {
    const { FilesetResolver, HandLandmarker, FaceLandmarker } = await import(
      VISION_URL
    );

    const filesetResolver = await FilesetResolver.forVisionTasks(WASM_BASE);

    [this.handLandmarker, this.faceLandmarker] = await Promise.all([
      HandLandmarker.createFromOptions(filesetResolver, {
        baseOptions: { modelAssetPath: HAND_MODEL, delegate: "GPU" },
        runningMode: "VIDEO",
        numHands: 1,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }),
      FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate: "GPU" },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: false,
      }),
    ]);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._loop();
  }

  stop() {
    this.running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
  }

  _loop = () => {
    if (!this.running) return;
    const v = this.video;
    if (v.readyState >= 2 && v.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = v.currentTime;
      const ts = performance.now();

      let handResult = null;
      let faceResult = null;
      try {
        handResult = this.handLandmarker?.detectForVideo(v, ts);
      } catch (e) { /* skip */ }
      try {
        faceResult = this.faceLandmarker?.detectForVideo(v, ts);
      } catch (e) { /* skip */ }

      this._updateState(handResult, faceResult);
      this.onState?.(this.state);
    }
    this._rafId = requestAnimationFrame(this._loop);
  };

  _updateState(handResult, faceResult) {
    const s = this.state;
    s.punch = false;
    s.mouthOpenTrigger = false;
    s.smileTrigger = false;

    /* --- 手 --- */
    if (handResult && handResult.landmarks && handResult.landmarks.length > 0) {
      const lm = handResult.landmarks[0]; // [{x,y,z}, ...] 21点
      s.handVisible = true;

      // 手のひら中心 = ランドマーク0(手首) と 9(中指根本) の中点
      const cx = (lm[0].x + lm[9].x) / 2;
      const cy = (lm[0].y + lm[9].y) / 2;
      // ※ video は表示時 scaleX(-1) で鏡像化される。
      //    Mediapipe座標は原画ベースなので、左右反転して使う。
      s.handX = 1 - cx;
      s.handY = cy;
      s.gesture = classifyHand(lm);

      // 突き出し検出 (z は前ほど負)
      const wristZ = lm[0].z;
      this._wristZHistory.push({ t: performance.now(), z: wristZ });
      // 直近 400ms 保持
      const cutoff = performance.now() - 400;
      while (this._wristZHistory.length && this._wristZHistory[0].t < cutoff)
        this._wristZHistory.shift();

      if (this._wristZHistory.length >= 4) {
        const minZ = Math.min(...this._wristZHistory.map((x) => x.z));
        const latestZ = wristZ;
        // 大きく前進した = punch
        const delta = minZ - latestZ; // 古いz - 新z（前進したら正）
        // 「open」ジェスチャーで一定以上の前進があった瞬間にトリガー
        if (
          s.gesture === "open" &&
          delta > 0.08 &&
          performance.now() - this._lastPunchTime > 500
        ) {
          s.punch = true;
          this._lastPunchTime = performance.now();
        }
      }
    } else {
      s.handVisible = false;
      s.gesture = "none";
    }

    /* --- 顔 --- */
    if (
      faceResult &&
      faceResult.faceBlendshapes &&
      faceResult.faceBlendshapes.length > 0
    ) {
      s.faceVisible = true;
      const bs = faceResult.faceBlendshapes[0].categories;
      // blendshape カテゴリ別取得
      const map = {};
      bs.forEach((c) => (map[c.categoryName] = c.score));

      const jawOpen = map.jawOpen ?? 0;
      s.mouthOpen = jawOpen;
      const smileL = map.mouthSmileLeft ?? 0;
      const smileR = map.mouthSmileRight ?? 0;
      s.smile = (smileL + smileR) / 2;

      // トリガー（state machine）
      if (!this._mouthOpenState && jawOpen > 0.5) {
        this._mouthOpenState = true;
        s.mouthOpenTrigger = true;
      } else if (this._mouthOpenState && jawOpen < 0.25) {
        this._mouthOpenState = false;
      }

      if (!this._smileState && s.smile > 0.55) {
        this._smileState = true;
        s.smileTrigger = true;
      } else if (this._smileState && s.smile < 0.3) {
        this._smileState = false;
      }
    } else {
      s.faceVisible = false;
      s.mouthOpen = 0;
      s.smile = 0;
    }

    s.raw = { handResult, faceResult };
  }
}

/**
 * 21点ランドマークから簡易ジェスチャー分類
 *   open / fist / peace / point / none
 */
function classifyHand(lm) {
  // tip indices for each finger
  const TIPS = { thumb: 4, index: 8, middle: 12, ring: 16, pinky: 20 };
  const PIPS = { thumb: 2, index: 6, middle: 10, ring: 14, pinky: 18 };

  // 指が伸びているか: tip が pip より MCP (5,9,13,17) から遠ければ伸びている
  // 簡単化: y座標で tip が pip より上(y小)なら伸びていると判定（手が立っていれば妥当）
  const wrist = lm[0];
  function isExtended(tip, pip) {
    // 手首からtip距離 と pip距離の比で判定（手の向きに頑健）
    const dTip = dist(lm[tip], wrist);
    const dPip = dist(lm[pip], wrist);
    return dTip > dPip * 1.15;
  }

  const index = isExtended(TIPS.index, PIPS.index);
  const middle = isExtended(TIPS.middle, PIPS.middle);
  const ring = isExtended(TIPS.ring, PIPS.ring);
  const pinky = isExtended(TIPS.pinky, PIPS.pinky);

  const extendedCount = [index, middle, ring, pinky].filter(Boolean).length;

  if (index && middle && !ring && !pinky) return "peace";
  if (extendedCount >= 3) return "open";
  if (extendedCount === 0) return "fist";
  if (index && !middle && !ring && !pinky) return "point";
  return "none";
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z ?? 0) - (b.z ?? 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * カメラ起動ユーティリティ
 */
export async function startCamera(videoEl) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "user",
      width: { ideal: 480 },
      height: { ideal: 640 },
      frameRate: { ideal: 30, max: 30 },
    },
    audio: false,
  });
  videoEl.srcObject = stream;
  await new Promise((res) => {
    if (videoEl.readyState >= 2) return res();
    videoEl.onloadedmetadata = () => res();
  });
  await videoEl.play();
  return stream;
}

export function stopCamera(videoEl) {
  const stream = videoEl?.srcObject;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (videoEl) videoEl.srcObject = null;
}
