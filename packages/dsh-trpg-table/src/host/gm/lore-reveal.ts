/**
 * 本场已揭示世界书条目的进程级登记（M8.4）。
 *
 * `reveal_lore` 工具把条目揭示给全桌时登记 roomId → entryId；GM 提示组装
 * （系统提示 / 每次行动）据此把「已 reveal」条目重新注入，避免揭示后反而查不到。
 *
 * 为什么不用房间快照：rooms 包的房间态没有 revealedLoreIds 字段（M9.4 契约未包含），
 * 本任务不改协议/房间；这里用 host 侧登记表兜底，房间关闭时由 index.ts 清理。
 * 续团（host 重启）后登记表为空——已揭示内容仍在事件流里，GM 仍可用 check_lore 查到。
 */

const revealedByRoom = new Map<string, Set<string>>();

/** 登记一次揭示。 */
export function noteRevealedLore(roomId: string, entryId: string): void {
  const normalizedRoom = roomId.trim();
  const normalizedEntry = entryId.trim();
  if (normalizedRoom.length === 0 || normalizedEntry.length === 0) return;
  const set = revealedByRoom.get(normalizedRoom) ?? new Set<string>();
  set.add(normalizedEntry);
  revealedByRoom.set(normalizedRoom, set);
}

/** 本场已揭示条目 id（按揭示顺序；无则空数组）。 */
export function revealedLoreIds(roomId: string): string[] {
  const set = revealedByRoom.get(roomId.trim());
  return set === undefined ? [] : [...set];
}

/** 是否已揭示。 */
export function isLoreRevealed(roomId: string, entryId: string): boolean {
  return revealedByRoom.get(roomId.trim())?.has(entryId.trim()) ?? false;
}

/** 房间关闭/解绑时清理登记。 */
export function resetRevealedLore(roomId: string): void {
  revealedByRoom.delete(roomId.trim());
}

/** 测试用：清空全部登记。 */
export function clearAllRevealedLore(): void {
  revealedByRoom.clear();
}
