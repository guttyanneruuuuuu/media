/* ============================================================
 * net.js - PeerJS を使ったP2P対戦
 *
 * - host: createRoom() で 6文字コードのpeer idを発行し待ち受け
 * - guest: joinRoom(code) でhostへ接続
 * - 接続後、JSONメッセージを送受信
 *   {type:"hello", name}
 *   {type:"ready"}
 *   {type:"start", seed, hostName}
 *   {type:"action", action: {...}}   // 各種ゲームアクション
 *   {type:"end", winner}
 *
 * 既存の公開 PeerJS クラウドを利用 (peerjs.min.js が <script> で読込み済み)
 * ============================================================ */

export class NetController {
  constructor({ onOpen, onConnect, onMessage, onClose, onError }) {
    this.onOpen = onOpen;
    this.onConnect = onConnect;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.onError = onError;
    this.peer = null;
    this.conn = null;
    this.isHost = false;
    this.roomCode = null;
  }

  /** 部屋を作る (ホスト) */
  createRoom() {
    this.isHost = true;
    const code = randomCode();
    this.roomCode = code;
    // peer id にプレフィックスをつけて衝突回避
    const id = `skyduel-${code}`;
    this._initPeer(id);
    this.peer.on("connection", (conn) => {
      this._attachConn(conn);
    });
  }

  /** 部屋に入る (ゲスト) */
  joinRoom(code) {
    this.isHost = false;
    this.roomCode = code;
    const id = `skyduel-${code}`;
    // ゲストは自分のidを ランダムにし、hostへ connect する
    this._initPeer(undefined);
    this.peer.on("open", () => {
      const conn = this.peer.connect(id, { reliable: true });
      this._attachConn(conn);
    });
  }

  _initPeer(id) {
    // eslint-disable-next-line no-undef
    this.peer = id ? new Peer(id) : new Peer();
    this.peer.on("open", (pid) => {
      this.onOpen?.(this.roomCode || pid);
    });
    this.peer.on("error", (err) => {
      console.warn("[peer error]", err);
      this.onError?.(err);
    });
    this.peer.on("disconnected", () => {
      // try reconnect once
      try { this.peer.reconnect(); } catch (e) {}
    });
  }

  _attachConn(conn) {
    this.conn = conn;
    conn.on("open", () => this.onConnect?.());
    conn.on("data", (data) => {
      try {
        const msg = typeof data === "string" ? JSON.parse(data) : data;
        this.onMessage?.(msg);
      } catch (e) { console.warn("bad msg", e); }
    });
    conn.on("close", () => this.onClose?.());
    conn.on("error", (e) => this.onError?.(e));
  }

  send(msg) {
    if (this.conn && this.conn.open) {
      this.conn.send(msg);
    }
  }

  close() {
    try { this.conn?.close(); } catch (e) {}
    try { this.peer?.destroy(); } catch (e) {}
    this.conn = null;
    this.peer = null;
  }
}

function randomCode() {
  // 紛らわしい文字を除外
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
