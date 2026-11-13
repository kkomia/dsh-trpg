/**
 * 房间存档（M4）：把房间权威状态以 JSON 落盘，DSH 重启后自动续团。
 *
 * 存储位置：`$DSH_HOME/profile-data/<profile>/dsh-trpg-table/rooms/<roomId>.json`
 * （与 dsh-tavern 等插件的 profile-data 约定一致）。
 * 写入策略：事件触发的 debounce 快照 + 原子写（tmp → rename），避免半截文件。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RoomService, RoomSnapshot } from '@dsh-trpg/rooms';

export interface RoomPersistenceOptions {
  /** 显式目录（测试用）；默认走 DSH profile-data。 */
  dir?: string;
  debounceMs?: number;
  log?: (message: string) => void;
}

export function defaultRoomsDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  const profile = env.DSH_PROFILE?.trim() || 'desktop';
  return join(home, 'profile-data', profile, 'dsh-trpg-table', 'rooms');
}

export class RoomPersistence {
  readonly dir: string;
  private readonly debounceMs: number;
  private readonly log: (message: string) => void;
  private service: RoomService | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(options: RoomPersistenceOptions = {}) {
    this.dir = options.dir ?? defaultRoomsDir();
    this.debounceMs = options.debounceMs ?? 800;
    this.log = options.log ?? (() => {});
  }

  attach(service: RoomService): void {
    this.service = service;
  }

  /** 从磁盘恢复所有房间；返回恢复数量。 */
  restoreInto(service: RoomService): number {
    let restored = 0;
    try {
      if (!existsSync(this.dir)) return 0;
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith('.json')) continue;
        try {
          const snapshot = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as RoomSnapshot;
          if (service.restore(snapshot)) restored += 1;
        } catch (error) {
          this.log(`room snapshot ${name} unreadable: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      this.log(`room persistence restore failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return restored;
  }

  /** 事件触发的延迟快照（合并高频写入）。 */
  schedule(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** 立即落盘；保留当前所有房间，清理已不存在的房间文件。 */
  flush(): void {
    if (!this.service || this.closed) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      const snapshots = this.service.snapshotAll();
      const keep = new Set<string>();
      for (const snapshot of snapshots) {
        const file = join(this.dir, `${snapshot.room.id}.json`);
        keep.add(`${snapshot.room.id}.json`);
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
        renameSync(tmp, file);
      }
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith('.json') || keep.has(name)) continue;
        try {
          unlinkSync(join(this.dir, name));
        } catch {
          /* 并发删除忽略 */
        }
      }
    } catch (error) {
      this.log(`room persistence flush failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flush();
    this.closed = true;
  }
}
