/**
 * 房间层错误（M2 起沿用）：`code` 直接对应协议 `RpcError['code']`，`message` 是中文人话。
 *
 * 独立成文件是为了让 `rules-host.ts` / `rules-view.ts` 等模块能引用它而不产生
 * `index.ts ↔ 子模块` 的循环导入（index.ts 再 re-export，保持对外的旧导入路径不变）。
 */
import type { RuleErrorCode, RuleRuntimeErrorInfo } from '@dsh-trpg/rules';
import type { RpcError } from '@dsh-trpg/protocol';

export class RoomError extends Error {
  readonly code: RpcError['code'];

  constructor(code: RpcError['code'], message: string) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
  }
}

/** 规则错误码 → 协议错误码（保持客户端只需处理一套 code）。 */
const NOT_FOUND_CODES: ReadonlySet<RuleErrorCode> = new Set([
  'unknown_actor',
  'unknown_action',
  'unknown_table',
  'unknown_map',
  'formula_missing',
]);

const CONFLICT_CODES: ReadonlySet<RuleErrorCode> = new Set([
  'combat_active',
  'no_combat',
  'not_active',
  'actor_dead',
  'insufficient_resource',
  'insufficient_turn_resource',
  'invalid_target',
  'out_of_range',
  'blocked',
]);

/** 把规则运行时错误转成房间错误（中文 message；hint 附在括号里）。 */
export function roomErrorFromRule(error: RuleRuntimeErrorInfo): RoomError {
  const code: RpcError['code'] = NOT_FOUND_CODES.has(error.code)
    ? 'not-found'
    : CONFLICT_CODES.has(error.code)
      ? 'conflict'
      : error.code === 'internal'
        ? 'internal'
        : 'bad-request';
  const message = error.hint !== undefined && error.hint.length > 0
    ? `${error.messageZh}（${error.hint}）`
    : error.messageZh;
  return new RoomError(code, message);
}
