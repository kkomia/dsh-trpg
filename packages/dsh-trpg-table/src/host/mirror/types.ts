/**
 * 玩家侧对话镜像（M7）：host 投影帧、可见性、SSE 线协议与本地镜像 API 的类型。
 *
 * 数据流：房主的 DSH 会话（牌桌）+ 房间事件 → `RoomMirrorHub` 按收件人投影/脱敏 →
 * `GET /trpg/mirror`（SSE，玩家 token 鉴权）→ 玩家插件 host 的 `MirrorClientService` →
 * 玩家本机镜像会话 `session.append()` → 玩家用 DSH 原生会话界面看整局。
 *
 * 设计红线：
 * - 帧只携带**已脱敏**内容：GM 秘密工具调用/暗骰只投给 GM，`trpg_secret_note` 只投目标玩家，
 *   其他玩家的私密内容不出现；
 * - 帧 seq 由 hub 单调递增，环形缓冲 + 断线重放（`lastSeq`）；
 * - 玩家侧只写 DSH 已知事件类型（user/assistant/tool/turn/step/session-title），不写自定义事件。
 */

/** 镜像线协议版本（帧格式变化时递增）。 */
export const MIRROR_PROTOCOL_VERSION = 1;

/** 环形缓冲上限（≥500；断线重放窗口）。 */
export const MIRROR_MAX_BUFFER = 500;

/** 一帧的收件人：全桌 / 仅 GM / 指定玩家（GM 也可见）。 */
export type MirrorVisibility = 'all' | 'host' | { playerId: string };

/** 检定结果摘要（来自房间 dice 事件，不重新掷骰）。 */
export interface MirrorCheckInfo {
  kind: 'ability' | 'skill' | 'attack' | 'save';
  name: string;
  dc: number;
  success: boolean;
}

/** 玩家行动（带角色名；私密行动只投行动者 + GM）。 */
export interface MirrorActionData {
  playerId?: string;
  playerName?: string;
  characterName?: string;
  text: string;
  private?: boolean;
}

/** GM 旁白（公共叙事或私密消息）。 */
export interface MirrorNarrationData {
  text: string;
  speakerName?: string;
  private?: boolean;
}

/** 掷骰/检定（公开骰全桌可见，私骰只投本人 + GM）。 */
export interface MirrorDiceData {
  expression: string;
  dice: number[];
  modifier: number;
  total: number;
  label?: string;
  rollerName: string;
  private: boolean;
  check?: MirrorCheckInfo;
}

/** 工具卡摘要：只带可读摘要与状态，不带 GM 秘密参数/原始结果。 */
export interface MirrorToolData {
  phase: 'call' | 'result' | 'error';
  callId: string;
  /** 工具短名（去掉 `trpg_` 前缀，例如 roll_check / attack）。 */
  name: string;
  summary: string;
}

/** 战斗事件摘要（全桌可见）。 */
export interface MirrorCombatData {
  text: string;
}

/** 奖励（只投目标玩家 + GM）。 */
export interface MirrorAwardData {
  playerName: string;
  xp: number;
  items: string[];
  note?: string;
}

/** 场景/系统提示（全桌可见）。 */
export interface MirrorNoticeData {
  text: string;
  level?: 'info' | 'warning';
}

/** 镜像帧：host 投影后的最小对话单元。 */
export type MirrorFrame =
  | { v: typeof MIRROR_PROTOCOL_VERSION; seq: number; at: number; kind: 'action'; data: MirrorActionData }
  | { v: typeof MIRROR_PROTOCOL_VERSION; seq: number; at: number; kind: 'narration'; data: MirrorNarrationData }
  | { v: typeof MIRROR_PROTOCOL_VERSION; seq: number; at: number; kind: 'dice'; data: MirrorDiceData }
  | { v: typeof MIRROR_PROTOCOL_VERSION; seq: number; at: number; kind: 'tool'; data: MirrorToolData }
  | { v: typeof MIRROR_PROTOCOL_VERSION; seq: number; at: number; kind: 'combat'; data: MirrorCombatData }
  | { v: typeof MIRROR_PROTOCOL_VERSION; seq: number; at: number; kind: 'award'; data: MirrorAwardData }
  | { v: typeof MIRROR_PROTOCOL_VERSION; seq: number; at: number; kind: 'notice'; data: MirrorNoticeData };

/** 镜像帧 kind。 */
export type MirrorFrameKind = MirrorFrame['kind'];

/** 连接握手帧（SSE `event: ready`）：告知缓冲窗口与是否因淘汰而跳号。 */
export interface MirrorReadyFrame {
  type: 'ready';
  v: typeof MIRROR_PROTOCOL_VERSION;
  roomId: string;
  roomTitle?: string;
  /** 请求方声明的最后一条 seq（服务端按此重放）。 */
  lastSeq: number;
  /** 环形缓冲里最旧/最新的 seq（空缓冲时都为 lastSeq）。 */
  oldestSeq: number;
  latestSeq: number;
  /** lastSeq 早于缓冲窗口而丢失的条数（>0 表示历史不完整）。 */
  skipped: number;
}

/** SSE `event: close`：房间关闭/插件卸载时收场。 */
export interface MirrorCloseFrame {
  type: 'close';
  reason: string;
}

/** 镜像 SSE 的收信条目。 */
export type MirrorSseItem = MirrorFrame | MirrorReadyFrame | MirrorCloseFrame;

/** 镜像中枢的下沉点（SSE 处理器实现；房间关闭时 `close` 收场）。 */
export interface MirrorSink {
  frame(frame: MirrorFrame): void;
  close(reason: string): void;
}

/** 玩家侧镜像会话的启动参数（客户端 → 本机插件 host）。 */
export interface MirrorStartRequest {
  /** 房主房间服务地址（如 http://192.168.1.5:45871）。 */
  base: string;
  roomId: string;
  /** 玩家 token（与房间 token 一致）。 */
  token: string;
  /** 玩家名（仅展示/标题用）。 */
  playerName?: string;
  /** 房名（镜像会话标题 `跑团桌：<房名>`）。 */
  roomTitle?: string;
  /** 断点续传起点（默认 0 = 从头重放缓冲内全部历史）。 */
  lastSeq?: number;
}

/** 镜像服务状态。 */
export interface MirrorStatus {
  state: 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error' | 'stopped' | 'unavailable';
  roomId?: string;
  roomTitle?: string;
  /** 本机镜像会话 id（创建成功才有）。 */
  sessionId?: string;
  /** 已写入镜像会话的帧数。 */
  synced: number;
  /** 已消费的最后一条镜像 seq。 */
  lastSeq: number;
  error?: string;
}
