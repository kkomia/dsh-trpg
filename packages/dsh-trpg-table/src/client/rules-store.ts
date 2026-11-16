/**
 * M9.4 规则投影数据层（Client 半边，纯数据 + 命令 + SSE）。
 *
 * 口径（docs/RULES-MODEL §8、docs/UI-CONTRACT §5/§6）：
 * - host 权威：卡面 `SheetView`、战棋 `CombatView`、世界地图 `WorldMapView` 全部由 host 算好下发；
 *   客户端只渲染、只提交意图（equip / unequip / useItem / useAction / move / endTurn / rollCheck）。
 * - 本层不 import 任何规则执行代码，也不推导规则公式；`trace` 只展示 host 给的 `lines`。
 * - 右栏紧凑页签与主区域详细页共用这一个 store（同一次 SSE 订阅、同一份投影），
 *   两边一起挂载也只有一条事件流；主区域单独打开时由它自己 bind。
 */
import { callRpc, rpcErrorMessage } from './rpc.ts';
import type {
  ActionOutcomeView,
  CheckView,
  CombatEndResult,
  CombatEndTurnResult,
  CombatMoveResult,
  CombatRollCheckResult,
  CombatStartResult,
  CombatUpdatePayload,
  CombatUseActionResult,
  CombatView,
  CombatViewResult,
  DiceRollView,
  EquipmentSlotView,
  GameEvent,
  InventoryView,
  ItemCardView,
  ItemUseOutcomeView,
  MoveOutcomeView,
  RoomRulesView,
  RoomStateResult,
  RoomView,
  RulesErrorPayload,
  SheetCommandResult,
  SheetGetResult,
  SheetUpdatePayload,
  SheetView,
  WorldMapGetResult,
  WorldMapView,
} from '@dsh-trpg/protocol';

/** 与 index.ts 的 StoredSession 结构一致的只读子集（避免循环 import）。 */
export interface TableSessionRef {
  base: string;
  hostToken?: string;
  playerToken?: string;
  playerId?: string;
  roomId?: string;
  playerName?: string;
}

/** 主区域工具页（keyed `main` 面板）的视图类型。 */
export type MainViewKind = 'sheet' | 'equip' | 'bag' | 'map' | 'combat';

/** 命令/读操作的结果提示（中文；`lines` 只放 host 已结算的内容）。 */
export interface RulesNotice {
  tone: 'ok' | 'bad' | 'info';
  title: string;
  lines: string[];
}

export interface RulesSnapshot {
  session: TableSessionRef | null;
  room: RoomView | null;
  rules: RoomRulesView | null;
  /** 规则不可用/版本漂移：房间仍可续团，但规则页签停用并给可读提示。 */
  degraded: boolean;
  sheet: SheetView | null;
  inventory: InventoryView | null;
  combat: CombatView | null;
  worldMap: WorldMapView | null;
  /** `worldmap.get` 有 zones 才显示世界地图页（无 space 的模块不显示）。 */
  mapAvailable: boolean;
  /** 房主可切换要看谁的卡（玩家固定为自己）。 */
  targetPlayerId: string | null;
  loading: boolean;
  pending: string | null;
  /** 最近一次读/命令失败的中文错误（红字展示）。 */
  error: string | null;
  /** 卡面读取失败（通常是「未落座」）：只做提示，不当作全局错误。 */
  sheetError: string | null;
  /** `rules/error` 事件（全桌可见的规则钩子错误/降级）。 */
  ruleError: { text: string; degraded: boolean } | null;
  notice: RulesNotice | null;
  /** 主区域当前视图（右栏「详细」按钮直接切到对应页）。 */
  mainView: MainViewKind;
  /** 面板内选中的装备槽/物品/动作/目标（两档密度共享，切换视图不丢）。 */
  selectedSlotId: string | null;
  selectedItemId: string | null;
  selectedActionId: string | null;
  selectedTargetId: string | null;
  /** 背包筛选状态。 */
  bagCategory: string;
  bagQuery: string;
  bagSort: 'name' | 'rarity';
  connected: boolean;
}

const INITIAL: RulesSnapshot = {
  session: null,
  room: null,
  rules: null,
  degraded: false,
  sheet: null,
  inventory: null,
  combat: null,
  worldMap: null,
  mapAvailable: false,
  targetPlayerId: null,
  loading: false,
  pending: null,
  error: null,
  sheetError: null,
  ruleError: null,
  notice: null,
  mainView: 'sheet',
  selectedSlotId: null,
  selectedItemId: null,
  selectedActionId: null,
  selectedTargetId: null,
  bagCategory: 'all',
  bagQuery: '',
  bagSort: 'name',
  connected: false,
};

function tokenOf(session: TableSessionRef | null): string | undefined {
  if (!session) return undefined;
  return session.hostToken ?? session.playerToken;
}

function isHostSession(session: TableSessionRef | null): boolean {
  return typeof session?.hostToken === 'string' && session.hostToken.length > 0;
}

function diceLines(rolls: DiceRollView[] | undefined): string[] {
  return (rolls ?? []).map((roll) => {
    const modifier = roll.modifier === 0 ? '' : roll.modifier > 0 ? ` + ${roll.modifier}` : ` − ${Math.abs(roll.modifier)}`;
    return `${roll.expression}：${roll.dice.join('、')}${modifier} = ${roll.total}`;
  });
}

function checkLines(check: CheckView): string[] {
  const lines: string[] = [];
  const subject = check.skillId ?? check.attributeId ?? check.kind;
  lines.push(`检定 ${subject}：d20 ${check.d20 ?? '（未掷）'} + ${check.modifier} = ${check.total}，DC ${check.dc} → ${check.success ? '成功' : '失败'}（${check.degree}）`);
  lines.push(...diceLines(check.rolls));
  lines.push(...check.trace.lines);
  return lines;
}

function actionLines(action: ActionOutcomeView, targetName?: string): string[] {
  const lines: string[] = [];
  if (action.hit !== undefined) {
    lines.push(action.hit ? `命中${action.crit ? '（暴击）' : ''}${targetName ? `：${targetName}` : ''}` : '未命中');
  }
  if (action.damage !== undefined) {
    lines.push(
      `伤害 ${action.damage.amount}${action.damage.absorbedByTempHp > 0 ? `（护盾吸收 ${action.damage.absorbedByTempHp}）` : ''}：HP ${action.damage.hpBefore} → ${action.damage.hpAfter}${action.damage.dead ? '，已倒下' : ''}`,
    );
  }
  if (action.check !== undefined) lines.push(...checkLines(action.check));
  lines.push(...diceLines(action.rolls));
  lines.push(...action.trace.lines);
  if (action.autoEndedTurn) lines.push('行动经济耗尽：已自动结束回合');
  return lines;
}

function moveLines(move: MoveOutcomeView): string[] {
  const to = move.to.cell !== undefined ? `(${move.to.cell.x},${move.to.cell.y})` : (move.to.zoneId ?? '未知位置');
  return [
    `移动到 ${to}，路径 ${move.path.length} 格，消耗 ${move.cost}${move.remaining === null ? '' : `，剩余 ${move.remaining}`}`,
    ...move.trace.lines,
  ];
}

function itemUseLines(item: ItemUseOutcomeView | undefined): string[] {
  if (!item) return [];
  const lines = [`使用「${item.name}」${item.consumed ? `（已消耗，来自${item.removedFrom === 'slot' ? '装备槽' : '背包'}）` : '（未消耗）'}`];
  if (item.action !== undefined) lines.push(...actionLines(item.action));
  return lines;
}

/**
 * 规则投影 store：bind(session) 后自行读 room.state + 三份投影并订阅 SSE；
 * 视图组件只订阅快照 + 调命令方法。
 */
export class RulesStore {
  private snapshot: RulesSnapshot = { ...INITIAL };
  private listeners = new Set<() => void>();
  private source: { close: () => void } | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private boundKey = '';
  private lastSeq = 0;

  getSnapshot = (): RulesSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        /* 单个订阅者异常不阻塞其他视图 */
      }
    }
  }

  private set(patch: Partial<RulesSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  // ---------------------------------------------------------------- 绑定/生命周期

  /**
   * 绑定到当前房间会话：切换房间/身份时重建 SSE 与投影；同一会话重复调用只同步 room。
   * @param session - 客户端已保存的房间会话（host 或 player）。
   * @param room - 调用方已有的房间视图（右栏 tab 有；主区域自行拉）。
   */
  bind(session: TableSessionRef | null, room?: RoomView | null): void {
    if (!session || session.roomId === undefined) {
      if (this.snapshot.session !== null) this.reset();
      return;
    }
    const key = `${session.base}|${tokenOf(session) ?? ''}|${session.roomId}|${session.playerId ?? ''}`;
    if (key === this.boundKey) {
      if (room !== undefined && room !== null) this.applyRoom(room, true);
      return;
    }
    this.boundKey = key;
    this.lastSeq = 0;
    this.closeSource();
    const keepView = this.snapshot.mainView;
    this.snapshot = { ...INITIAL, session, mainView: keepView, loading: true };
    this.emit();
    if (room !== undefined && room !== null) this.applyRoom(room, false);
    void this.bootstrap();
  }

  /** 退出房间/换身份时清空（SSE 与投影一起丢，避免残留上一桌的卡面）。 */
  reset(): void {
    this.boundKey = '';
    this.lastSeq = 0;
    this.closeSource();
    this.snapshot = { ...INITIAL };
    this.emit();
  }

  /**
   * 插件卸载/开发期模块热替换时释放 SSE 与订阅。
   * 不做这一步的话，每次 HMR 都会留一条重连中的 EventSource，最终占满浏览器
   * 对同一 origin 的 6 条连接，后来的 RPC 会永远排队（表现为命令一直「处理中」）。
   */
  dispose(): void {
    this.boundKey = '';
    this.lastSeq = 0;
    this.closeSource();
    this.listeners.clear();
  }

  private closeSource(): void {
    this.source?.close();
    this.source = null;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private token(): string | undefined {
    return tokenOf(this.snapshot.session);
  }

  private async bootstrap(): Promise<void> {
    const session = this.snapshot.session;
    const token = this.token();
    if (!session || !token) return;
    try {
      const state = await callRpc<RoomStateResult>(session.base, 'room.state', {}, token);
      this.applyRoom(state.room, false);
    } catch (error) {
      this.set({ loading: false, error: `读取房间失败：${rpcErrorMessage(error)}` });
      return;
    }
    await this.reloadAll();
    this.connectSse();
  }

  /** 把房间视图（含 rules/degraded）同步进快照；规则引用/目标角色变化时重拉投影。 */
  applyRoom(room: RoomView, refetch = true): void {
    const previous = this.snapshot.rules;
    const next = room.rules ?? null;
    const changed = (previous?.rulesId ?? '') !== (next?.rulesId ?? '') || (previous?.rulesVersion ?? '') !== (next?.rulesVersion ?? '');
    const previousTarget = this.snapshot.targetPlayerId;
    const target = this.resolveTargetPlayer(room);
    this.set({
      room,
      rules: next,
      degraded: next?.degraded === true,
      targetPlayerId: target,
      ...(next === null ? { sheet: null, inventory: null, combat: null, worldMap: null, mapAvailable: false, loading: false } : {}),
    });
    if (!refetch) return;
    if (changed) {
      void this.reloadAll();
      return;
    }
    if (target !== previousTarget || this.snapshot.sheet === null || this.snapshot.sheetError !== null) {
      // 落座/换目标后卡面可能刚变得可读：房间事件到达时补拉一次（失败过的卡面也会重试）。
      void this.reloadSheet();
    }
  }

  /** 目标角色：玩家固定自己；房主优先自己（已落座），否则第一个玩家。 */
  private resolveTargetPlayer(room: RoomView): string | null {
    const session = this.snapshot.session;
    if (!session) return null;
    if (!isHostSession(session)) return session.playerId ?? null;
    const previous = this.snapshot.targetPlayerId;
    const ids = new Set(room.players.map((player) => player.playerId));
    if (previous !== null && ids.has(previous)) return previous;
    if (ids.has('host')) return 'host';
    return room.players.find((player) => player.playerId !== 'host')?.playerId ?? 'host';
  }

  // ---------------------------------------------------------------- 读取投影

  /** 重拉全部规则投影（卡面 + 战斗 + 世界地图）；无规则房间直接跳过。 */
  async reloadAll(): Promise<void> {
    if (this.snapshot.rules === null) {
      this.set({ loading: false, sheet: null, inventory: null, combat: null, worldMap: null, mapAvailable: false });
      return;
    }
    if (this.snapshot.degraded) {
      this.set({ loading: false, sheetError: null });
      return;
    }
    await Promise.all([this.reloadSheet(), this.reloadCombat(), this.reloadWorldMap()]);
    this.set({ loading: false });
  }

  /** `sheet.get` → 卡面 + 背包（玩家读自己；房主读 targetPlayerId）。 */
  async reloadSheet(): Promise<void> {
    const session = this.snapshot.session;
    const token = this.token();
    if (!session || !token || this.snapshot.rules === null || this.snapshot.degraded) return;
    try {
      const result = await callRpc<SheetGetResult>(session.base, 'sheet.get', this.selector(), token);
      this.syncSheet(result.sheet, result.inventory);
      this.set({ sheetError: null });
    } catch (error) {
      this.set({ sheet: null, inventory: null, sheetError: rpcErrorMessage(error) });
    }
  }

  /** `combat.view`（未开战也返回稳定形状；全桌可读）。 */
  async reloadCombat(): Promise<void> {
    const session = this.snapshot.session;
    const token = this.token();
    if (!session || !token || this.snapshot.rules === null || this.snapshot.degraded) return;
    try {
      const result = await callRpc<CombatViewResult>(session.base, 'combat.view', {}, token);
      this.set({ combat: result.combat, connected: true });
    } catch {
      /* 未开战/接口异常：保留上一次视图，不打断界面 */
    }
  }

  /** `worldmap.get`：zones 为空 = 无 space 模型，不显示世界地图页。 */
  async reloadWorldMap(): Promise<void> {
    const session = this.snapshot.session;
    const token = this.token();
    if (!session || !token || this.snapshot.rules === null || this.snapshot.degraded) return;
    try {
      const result = await callRpc<WorldMapGetResult>(session.base, 'worldmap.get', {}, token);
      this.set({ worldMap: result.worldMap, mapAvailable: result.worldMap.zones.length > 0 });
    } catch {
      this.set({ worldMap: null, mapAvailable: false });
    }
  }

  /** 刷新当前视图相关的投影（右栏「刷新」按钮）。 */
  async refresh(): Promise<void> {
    await this.runRead('刷新中…', async () => {
      await this.reloadAll();
    });
  }

  /** 卡面 + 背包（装备/背包页的刷新只要这两份）。 */
  async refreshSheet(): Promise<void> {
    await this.runRead('刷新中…', async () => {
      await this.reloadSheet();
      await this.reloadCombat();
    });
  }

  // ---------------------------------------------------------------- 命令

  private selector(): { playerId?: string } {
    const session = this.snapshot.session;
    if (!session) return {};
    if (!isHostSession(session)) return {};
    const target = this.snapshot.targetPlayerId;
    if (target === null || target === 'host') return {};
    return { playerId: target };
  }

  private async runRead(label: string, task: () => Promise<void>): Promise<void> {
    if (this.snapshot.pending !== null) return;
    this.set({ pending: label, error: null });
    try {
      await task();
    } catch (error) {
      this.set({ error: `读取失败：${rpcErrorMessage(error)}` });
    } finally {
      this.set({ pending: null });
    }
  }

  private async run(label: string, task: () => Promise<void>): Promise<void> {
    if (this.snapshot.pending !== null) return;
    this.set({ pending: label, error: null });
    try {
      await task();
    } catch (error) {
      // host 的中文错误直接展示（命令类失败只留一个通知，避免同一错误出现两次）。
      this.set({ notice: { tone: 'bad', title: '命令被 host 拒绝', lines: [rpcErrorMessage(error)] } });
    } finally {
      this.set({ pending: null });
    }
  }

  private base(): string | undefined {
    return this.snapshot.session?.base;
  }

  /** `sheet.equip`：把背包/其他槽的物品装到 slotId（accepts/容量由 host 校验）。 */
  async equip(slotId: string, instanceId: string): Promise<void> {
    const base = this.base();
    const token = this.token();
    if (!base || !token) return;
    await this.run('装备中…', async () => {
      const result = await callRpc<SheetCommandResult>(base, 'sheet.equip', { slotId, instanceId, ...this.selector() }, token);
      this.syncSheet(result.sheet, result.inventory);
      this.set({
        selectedItemId: null,
        notice: { tone: 'ok', title: '已装备', lines: [`物品已放入槽位「${this.slotName(slotId)}」，词条由 host 重算`] },
      });
    });
  }

  /** `sheet.unequip`：卸下槽位物品回背包。 */
  async unequip(slotId: string, instanceId: string): Promise<void> {
    const base = this.base();
    const token = this.token();
    if (!base || !token) return;
    await this.run('卸下中…', async () => {
      const result = await callRpc<SheetCommandResult>(base, 'sheet.unequip', { slotId, instanceId, ...this.selector() }, token);
      this.syncSheet(result.sheet, result.inventory);
      this.set({ notice: { tone: 'ok', title: '已卸下', lines: [`物品已放回背包（${this.slotName(slotId)}）`] } });
    });
  }

  /** `sheet.useItem`：使用物品（效果走规则包 useAction，host 结算）。 */
  async useItem(instanceId: string, targetId?: string): Promise<void> {
    const base = this.base();
    const token = this.token();
    if (!base || !token) return;
    const name = this.findItem(instanceId)?.name ?? instanceId;
    await this.run('使用物品中…', async () => {
      const result = await callRpc<SheetCommandResult>(
        base,
        'sheet.useItem',
        { instanceId, ...(targetId !== undefined ? { targetId } : {}), ...this.selector() },
        token,
      );
      this.syncSheet(result.sheet, result.inventory);
      const lines = itemUseLines(result.item);
      this.set({ notice: { tone: 'ok', title: `使用「${name}」`, lines: lines.length > 0 ? lines : ['host 已结算（未返回效果明细）'] } });
      await this.reloadCombat();
    });
  }

  /** 发起战斗（房主）：临时加入一个示例敌人，供战棋/theater-of-mind 视图与验证使用。 */
  async startCombat(enemyName: string): Promise<void> {
    const base = this.base();
    const token = this.token();
    if (!base || !token) return;
    await this.run('发起战斗中…', async () => {
      const result = await callRpc<CombatStartResult>(
        base,
        'combat.start',
        { enemies: [{ name: enemyName }], reason: '战棋视图' },
        token,
      );
      const lines = [ `第 ${result.combat.round}/${result.combat.maxRounds || '∞'} 回合，先攻：${result.combat.initiative.map((entry) => `${entry.name}(${entry.initiative})`).join(' → ')}`, ...diceLines(result.rolls) ];
      this.set({ combat: result.combat, notice: { tone: 'ok', title: '战斗开始', lines } });
      await this.reloadSheet();
    });
  }

  /** 收场（房主）。 */
  async endCombat(): Promise<void> {
    const base = this.base();
    const token = this.token();
    if (!base || !token) return;
    await this.run('结束战斗中…', async () => {
      const result = await callRpc<CombatEndResult>(base, 'combat.end', { reason: '收场' }, token);
      this.set({
        combat: result.combat,
        selectedActionId: null,
        selectedTargetId: null,
        notice: { tone: 'info', title: '战斗结束', lines: [ result.combat.endedReason ?? '已收场' ] },
      });
      await this.reloadSheet();
    });
  }

  /** `combat.useAction`：提交动作意图（目标/骰面/伤害全部由 host 判）。 */
  async useAction(actionId: string, targetId?: string): Promise<void> {
    const base = this.base();
    const token = this.token();
    if (!base || !token) return;
    const actionName = this.snapshot.sheet?.actions.find((action) => action.actionId === actionId)?.name ?? actionId;
    const targetName = this.snapshot.combat?.tokens.find((tokenView) => tokenView.actorId === targetId)?.name;
    await this.run('结算动作中…', async () => {
      const result = await callRpc<CombatUseActionResult>(
        base,
        'combat.useAction',
        { actionId, ...(targetId !== undefined ? { targetId } : {}), ...this.selector() },
        token,
      );
      this.set({ combat: result.combat });
      if (result.sheet !== undefined) this.syncSheet(result.sheet, this.snapshot.inventory);
      const lines = actionLines(result.action, targetName);
      this.set({
        selectedActionId: null,
        notice: {
          tone: result.action.hit === false ? 'bad' : 'ok',
          title: `动作：${actionName}`,
          lines: lines.length > 0 ? lines : ['host 已结算（未返回明细）'],
        },
      });
    });
  }

  /** `combat.move`：点格子移动（距离/地形/移动力由 host 判）。 */
  async move(cell: { x: number; y: number }): Promise<void> {
    const base = this.base();
    const token = this.token();
    if (!base || !token) return;
    await this.run('移动中…', async () => {
      const result = await callRpc<CombatMoveResult>(base, 'combat.move', { to: { cell }, ...this.selector() }, token);
      this.set({ combat: result.combat, notice: { tone: 'ok', title: '移动结算', lines: moveLines(result.move) } });
      await this.reloadSheet();
    });
  }

  /** `combat.endTurn`：结束当前行动者的回合（房主可代管当前行动者推进回合）。 */
  async endTurn(): Promise<void> {
    const base = this.base();
    const token = this.token();
    if (!base || !token) return;
    // 房主视角下「当前行动者」可能不是自己的角色：显式指定 actorId 交给 host 判定（host 可代管）。
    const activeActorId = this.snapshot.combat?.activeActorId ?? null;
    const ownActorId = this.snapshot.sheet?.actorId;
    const proxy = isHostSession(this.snapshot.session) && activeActorId !== null && activeActorId !== ownActorId;
    await this.run('结束回合…', async () => {
      const result = await callRpc<CombatEndTurnResult>(
        base,
        'combat.endTurn',
        proxy && activeActorId !== null ? { actorId: activeActorId } : {},
        token,
      );
      const active = result.combat.tokens.find((tokenView) => tokenView.actorId === result.combat.activeActorId);
      this.set({
        combat: result.combat,
        selectedActionId: null,
        notice: {
          tone: 'info',
          title: '回合推进',
          lines: [ `第 ${result.combat.round}/${result.combat.maxRounds || '∞'} 回合，当前行动者：${active?.name ?? '无'}` ],
        },
      });
      await this.reloadSheet();
    });
  }

  /** `combat.rollCheck`：请求 host 掷检定（技能/属性/豁免；客户端不本地掷）。 */
  async rollCheck(skillId: string, dc?: number): Promise<void> {
    const base = this.base();
    const token = this.token();
    if (!base || !token) return;
    const skillName = this.snapshot.sheet?.skills.find((skill) => skill.id === skillId)?.name ?? skillId;
    await this.run('检定中…', async () => {
      const result = await callRpc<CombatRollCheckResult>(
        base,
        'combat.rollCheck',
        { skillId, ...(dc !== undefined ? { dc } : {}) },
        token,
      );
      this.set({
        notice: {
          tone: result.check.success ? 'ok' : 'bad',
          title: `检定：${skillName}`,
          lines: checkLines(result.check),
        },
      });
    });
  }

  // ---------------------------------------------------------------- 视图状态

  setMainView(view: MainViewKind): void {
    this.set({ mainView: view });
  }

  setTargetPlayer(playerId: string): void {
    if (playerId === this.snapshot.targetPlayerId) return;
    this.set({ targetPlayerId: playerId, sheet: null, inventory: null, selectedSlotId: null, selectedItemId: null });
    void this.reloadSheet();
  }

  selectSlot(slotId: string | null): void {
    this.set({ selectedSlotId: slotId, selectedItemId: null });
  }

  selectItem(instanceId: string | null): void {
    this.set({ selectedItemId: instanceId });
  }

  selectAction(actionId: string | null): void {
    this.set({ selectedActionId: actionId });
  }

  selectTarget(actorId: string | null): void {
    this.set({ selectedTargetId: actorId });
  }

  setBagFilter(patch: { category?: string; query?: string; sort?: 'name' | 'rarity' }): void {
    this.set({
      ...(patch.category !== undefined ? { bagCategory: patch.category } : {}),
      ...(patch.query !== undefined ? { bagQuery: patch.query } : {}),
      ...(patch.sort !== undefined ? { bagSort: patch.sort } : {}),
    });
  }

  dismissError(): void {
    this.set({ error: null, ruleError: null });
  }

  dismissNotice(): void {
    this.set({ notice: null });
  }

  /** 物品在卡面/背包里查找（UI 取名字/图标用）。 */
  findItem(instanceId: string): ItemCardView | undefined {
    const sheet = this.snapshot.sheet;
    if (!sheet) return undefined;
    return sheet.items.find((item) => item.instanceId === instanceId);
  }

  /** 槽位名字（错误/提示用）。 */
  slotName(slotId: string): string {
    const slot = this.snapshot.sheet?.equipment.slots.find((entry: EquipmentSlotView) => entry.slotId === slotId);
    return slot?.name ?? slotId;
  }

  // ---------------------------------------------------------------- 内部同步

  private syncSheet(sheet: SheetView, inventory?: InventoryView | null): void {
    const nextInventory = inventory ?? (this.snapshot.inventory !== null ? { ...this.snapshot.inventory, items: sheet.items } : { items: sheet.items });
    this.set({ sheet, inventory: nextInventory });
  }

  // ---------------------------------------------------------------- SSE

  private connectSse(): void {
    if (typeof EventSource === 'undefined') return;
    const session = this.snapshot.session;
    const token = this.token();
    if (!session || !token) return;
    const url = `${session.base.replace(/\/+$/, '')}/trpg/events?token=${encodeURIComponent(token)}&lastSeq=${this.lastSeq}`;
    let closed = false;
    const source = new EventSource(url);
    const close = (): void => {
      closed = true;
      source.close();
      if (this.retryTimer !== null) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
    };
    source.addEventListener('game', (raw: { data: string }) => {
      try {
        this.handleEvent(JSON.parse(raw.data) as GameEvent);
      } catch {
        /* 忽略坏帧 */
      }
    });
    source.onopen = () => {
      this.set({ connected: true });
    };
    source.onerror = () => {
      source.close();
      if (closed) return;
      this.set({ connected: false });
      this.retryTimer = setTimeout(() => {
        if (!closed) this.connectSse();
      }, 2000);
    };
    this.source = { close };
  }

  /** SSE 事件：只吃 M9.4 三类 + room（房间规则引用可能变化）。 */
  handleEvent(event: GameEvent): void {
    if (event.kind !== 'room' && event.seq <= this.lastSeq) return;
    this.lastSeq = Math.max(this.lastSeq, event.seq);
    if (event.kind === 'room') {
      this.applyRoom(event.payload as RoomView, true);
      return;
    }
    if (event.kind === 'sheet/update') {
      const payload = event.payload as SheetUpdatePayload;
      if (this.snapshot.targetPlayerId !== null && payload.playerId !== this.snapshot.targetPlayerId) return;
      const inventory = this.snapshot.inventory;
      this.set({
        sheet: payload.sheet,
        inventory: inventory !== null ? { ...inventory, items: payload.sheet.items } : { items: payload.sheet.items },
      });
      return;
    }
    if (event.kind === 'combat/update') {
      const payload = event.payload as CombatUpdatePayload;
      this.set({ combat: payload.combat });
      return;
    }
    if (event.kind === 'rules/error') {
      const payload = event.payload as RulesErrorPayload;
      this.set({ ruleError: { text: payload.text || payload.message || '规则钩子出错', degraded: payload.degraded === true } });
    }
  }
}

/** 跨模块热替换保留的 store 槽位（开发期避免遗留 SSE 连接；生产只创建一次）。 */
const STORE_SLOT = Symbol.for('dsh-trpg-table.rules-store');

/** 每个插件实例一个 store（同一页面上同一时刻只有一个牌桌上下文）。 */
export function createRulesStore(): RulesStore {
  const holder = globalThis as unknown as Record<symbol, RulesStore | undefined>;
  try {
    holder[STORE_SLOT]?.dispose();
  } catch {
    /* 旧实例清理失败不阻塞新实例 */
  }
  const store = new RulesStore();
  holder[STORE_SLOT] = store;
  return store;
}
