/**
 * 镜像帧 → DSH 会话事件映射（玩家侧）。
 *
 * 只写 DSH 已知事件类型（白名单见 {@link MIRROR_SESSION_EVENT_TYPES}）：
 * - 玩家行动 → `user/message`（`source.kind='user'`，原生用户气泡，带【角色名】）；
 * - GM 旁白/通知/奖励 → `assistant/message`（原生 GM 气泡，markdown）；
 * - 掷骰/战斗/工具卡 → `tool/call` + `tool/result`（原生工具卡，内容只有可读摘要）；
 * - 轮次结构由玩家侧本地合成（不复制 host 的 turn/step，避免跳号与外泄）；
 * - 标题 → `session/title`（`source.kind='user'`，钉住标题，不触发自动命名 LLM）。
 *
 * append 的 seq/time 由 DSH 重分配；本模块只负责事件类型与 payload 形状，便于单测。
 */
import type { MirrorFrame } from './types.ts';
import {
  buildMirrorTitle,
  formatActionText,
  formatAwardText,
  formatCombatText,
  formatDiceText,
  summarizeToolResult,
} from './projection.ts';

/** 镜像会话允许写入的 DSH 事件类型白名单。 */
export const MIRROR_SESSION_EVENT_TYPES = [
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'session/title',
] as const;

/** 白名单事件类型。 */
export type MirrorSessionEventType = (typeof MIRROR_SESSION_EVENT_TYPES)[number];

/** 一条待 append 的会话事件（`surfaceOp` 只对消息类事件出现）。 */
export interface MirrorSessionEventInput {
  type: MirrorSessionEventType;
  data: Record<string, unknown>;
  surfaceOp?: 'append';
}

/** 映射状态：本地轮次编号与未闭合的工具调用。 */
export interface MirrorMapState {
  /** 下一个本地 turn 编号（从 1 开始）。 */
  nextTurn: number;
  /** 当前打开的 turn（undefined = 未开 turn）。 */
  turn: number | undefined;
  /** 当前 turn 内的 step 编号。 */
  step: number;
  /** 当前 step 是否已经被内容占用（DSH 派生 UI 每个 turn:step 只有一个 assistant 节点）。 */
  stepUsed: boolean;
  /** 已发出 tool/call、等待 tool/result 的调用 → 当时的 turn/step。 */
  openCalls: Map<string, { turn: number; step: number }>;
}

/** 新建映射状态。 */
export function createMirrorMapState(): MirrorMapState {
  return { nextTurn: 1, turn: undefined, step: 1, stepUsed: false, openCalls: new Map() };
}

/** 映射选项。 */
export interface MirrorMapOptions {
  /** 消息/调用 id 生成器（服务端注入 randomUUID；测试注入固定值）。 */
  createId: (prefix: string) => string;
}

/** assistant 消息的 source：标明来源不是真实模型请求（只影响请求详情展示）。 */
const MIRROR_MODEL_SOURCE = { kind: 'model', provider: 'dsh-trpg-table', model: 'mirror' } as const;

/** 打开（或复用）当前 turn，返回需要追加的 turn/step 事件。 */
function ensureTurn(state: MirrorMapState): MirrorSessionEventInput[] {
  if (state.turn !== undefined) return [];
  const turn = state.nextTurn;
  state.nextTurn += 1;
  state.turn = turn;
  state.step = 1;
  state.stepUsed = false;
  return [
    { type: 'turn/start', data: { turn } },
    { type: 'step/start', data: { turn, step: 1 } },
  ];
}

/**
 * 为一段新内容准备一个「干净」的 step：DSH 的 assistant 节点按 `turn:step` 唯一，
 * 同一 step 里写两条 assistant/message 只有最后一条会显示，所以每条内容各占一个 step。
 * @returns 需要追加的 turn/step 事件（可能为空）。
 */
function ensureFreshStep(state: MirrorMapState): MirrorSessionEventInput[] {
  const events = ensureTurn(state);
  if (state.turn === undefined || !state.stepUsed) return events;
  const turn = state.turn;
  const closedStep = state.step;
  state.step += 1;
  state.stepUsed = false;
  return [
    ...events,
    { type: 'step/end', data: { turn, step: closedStep } },
    { type: 'step/start', data: { turn, step: state.step } },
  ];
}

/** 关闭当前 turn（玩家行动打断 GM 输出时）。 */
function closeTurn(state: MirrorMapState): MirrorSessionEventInput[] {
  if (state.turn === undefined) return [];
  const turn = state.turn;
  const step = state.step;
  state.turn = undefined;
  state.step = 1;
  state.stepUsed = false;
  state.openCalls.clear();
  return [
    { type: 'step/end', data: { turn, step } },
    { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
  ];
}

/** 当前 turn/step（无打开 turn 时调用 ensureTurn 后的值）。 */
function currentLocation(state: MirrorMapState): { turn: number; step: number } {
  if (state.turn === undefined) throw new Error('mirror map: turn should be open');
  return { turn: state.turn, step: state.step };
}

/** 文本消息（assistant 气泡）。 */
function assistantMessageEvent(state: MirrorMapState, text: string, createId: (prefix: string) => string): MirrorSessionEventInput {
  const { turn, step } = currentLocation(state);
  return {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: {
      turn,
      step,
      message: {
        id: createId('mirror-assistant'),
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { ...MIRROR_MODEL_SOURCE },
      },
      stream: [],
    },
  };
}

/** 工具卡（tool/call + tool/result 成对写入）。 */
function toolResultEvents(
  state: MirrorMapState,
  callId: string,
  name: string,
  callSummary: string,
  resultText: string,
  createId: (prefix: string) => string,
  options: { isError?: boolean; location?: { turn: number; step: number } } = {},
): MirrorSessionEventInput[] {
  const location = options.location ?? currentLocation(state);
  state.openCalls.set(callId, location);
  const events: MirrorSessionEventInput[] = [
    {
      type: 'tool/call',
      data: {
        turn: location.turn,
        step: location.step,
        callId,
        name,
        arguments: JSON.stringify({ 摘要: callSummary }),
      },
    },
    {
      type: 'tool/result',
      surfaceOp: 'append',
      data: {
        turn: location.turn,
        step: location.step,
        message: {
          id: createId('mirror-tool'),
          role: 'tool',
          content: [{ type: 'text', text: resultText }],
          source: { kind: 'tool', callId },
          toolCallId: callId,
          ...(options.isError === true ? { isError: true } : {}),
        },
      },
    },
  ];
  state.openCalls.delete(callId);
  return events;
}

/**
 * 把一条镜像帧映射为需要 append 的会话事件（可能 0 条）。
 * @param frame - 已脱敏的镜像帧。
 * @param state - 映射状态（轮次编号/未闭合调用，跨帧累积）。
 * @param options - id 生成器。
 * @returns 按顺序写入的会话事件（空数组 = 该帧无可见内容）。
 */
export function mapMirrorFrame(
  frame: MirrorFrame,
  state: MirrorMapState,
  options: MirrorMapOptions,
): MirrorSessionEventInput[] {
  switch (frame.kind) {
    case 'action': {
      // 玩家行动：先收掉上一段 GM 输出的 turn，再写原生用户气泡。
      const events = closeTurn(state);
      events.push({
        type: 'user/message',
        surfaceOp: 'append',
        data: {
          id: options.createId('mirror-user'),
          role: 'user',
          content: [{ type: 'text', text: formatActionText(frame.data) }],
          source: { kind: 'user' },
        },
      });
      return events;
    }
    case 'narration': {
      const text = frame.data.text.trim();
      if (text.length === 0) return [];
      const stepEvents = ensureFreshStep(state);
      state.stepUsed = true;
      return [...stepEvents, assistantMessageEvent(state, text, options.createId)];
    }
    case 'notice': {
      const text = frame.data.text.trim();
      if (text.length === 0) return [];
      const stepEvents = ensureFreshStep(state);
      state.stepUsed = true;
      return [...stepEvents, assistantMessageEvent(state, text, options.createId)];
    }
    case 'award': {
      const stepEvents = ensureFreshStep(state);
      state.stepUsed = true;
      return [...stepEvents, assistantMessageEvent(state, formatAwardText(frame.data), options.createId)];
    }
    case 'dice': {
      const stepEvents = ensureFreshStep(state);
      state.stepUsed = true;
      return [
        ...stepEvents,
        ...toolResultEvents(
          state,
          `mirror-dice-${frame.seq}`,
          'trpg_roll_dice',
          frame.data.label ?? '掷骰',
          formatDiceText(frame.data),
          options.createId,
        ),
      ];
    }
    case 'combat': {
      const stepEvents = ensureFreshStep(state);
      state.stepUsed = true;
      return [
        ...stepEvents,
        ...toolResultEvents(
          state,
          `mirror-combat-${frame.seq}`,
          'trpg_combat',
          '战斗结算',
          frame.data.text,
          options.createId,
        ),
      ];
    }
    case 'tool': {
      const data = frame.data;
      if (data.phase === 'call') {
        const stepEvents = ensureFreshStep(state);
        state.stepUsed = true;
        const location = currentLocation(state);
        state.openCalls.set(data.callId, location);
        return [
          ...stepEvents,
          {
            type: 'tool/call',
            data: {
              turn: location.turn,
              step: location.step,
              callId: data.callId,
              name: `trpg_${data.name}`,
              arguments: JSON.stringify({ 摘要: data.summary }),
            },
          },
        ];
      }
      if (data.phase === 'result' || data.phase === 'error') {
        const known = state.openCalls.get(data.callId);
        const stepEvents = known !== undefined ? [] : ensureFreshStep(state);
        if (known === undefined) state.stepUsed = true;
        const target = known ?? currentLocation(state);
        state.openCalls.delete(data.callId);
        return [
          ...stepEvents,
          {
            type: 'tool/result',
            surfaceOp: 'append',
            data: {
              turn: target.turn,
              step: target.step,
              message: {
                id: options.createId('mirror-tool'),
                role: 'tool',
                content: [{ type: 'text', text: summarizeToolResult(data.name, data.summary) }],
                source: { kind: 'tool', callId: data.callId },
                toolCallId: data.callId,
                ...(data.phase === 'error' ? { isError: true } : {}),
              },
            },
          },
        ];
      }
      return [];
    }
    default:
      return [];
  }
}

/** 关闭当前打开的 turn（镜像停止/退房时收尾；返回 0–2 条事件）。 */
export function closeMirrorTurn(state: MirrorMapState): MirrorSessionEventInput[] {
  return closeTurn(state);
}

/** 断线重放跨过被淘汰历史的提示（写进镜像会话，玩家可见的上下文行）。 */
export function mirrorGapNoticeEvent(skipped: number, options: MirrorMapOptions): MirrorSessionEventInput {
  const text = `（镜像从中间开始：房主端缓冲已淘汰了更早的 ${skipped} 条事件；之后的内容会继续同步）`;
  return {
    type: 'user/message',
    surfaceOp: 'append',
    data: {
      id: options.createId('mirror-gap'),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'system' },
    },
  };
}

/** 镜像会话标题事件（钉住标题，不触发自动命名 LLM）。 */
export function mirrorTitleEvent(roomTitle: string | undefined): MirrorSessionEventInput {
  return {
    type: 'session/title',
    data: {
      title: buildMirrorTitle(roomTitle),
      messageSeqs: [],
      source: { kind: 'user' },
    },
  };
}
