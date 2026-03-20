/**
 * 生命周期管理器
 *
 * 负责记忆的归档和上下文注入。
 *
 * 记忆分层：
 * - recent: 最近7天，优先检索，默认注入
 * - active: 7-30天，正常检索，按需注入
 * - archived: 30天以上，不自动注入，只在明确查询历史时召回
 */

import type { BrainMemoryStore } from '../memory/store.js';

export interface LifecycleManagerConfig {
  store: BrainMemoryStore;
  archiveAfterDays: number;
}

export class LifecycleManager {
  constructor(private config: LifecycleManagerConfig) {}

  // ============================================================================
  // 归档管理
  // ============================================================================

  /**
   * 执行归档任务
   *
   * 归档规则：
   * - 30天无访问 且 重要性 < 0.3 的记忆归档
   */
  async archiveOldMemories(): Promise<number> {
    try {
      const now = Date.now();
      const archiveThreshold = this.config.archiveAfterDays * 24 * 60 * 60 * 1000;
      const importantThreshold = 0.3;

      // 获取所有活跃记忆
      const allMemories = await this.config.store.queryAll({
        status: 'active',
        limit: 1000,
      });

      let archivedCount = 0;

      for (const memory of allMemories) {
        // 计算无访问时间
        const lastAccessed = memory.lastAccessedAt || memory.createdAt;
        const inactiveTime = now - lastAccessed;

        // 判断是否应该归档：
        // 1. 30天无访问（inactiveTime > archiveThreshold）
        // 2. 重要性 < 0.3（importance < importantThreshold）
        if (inactiveTime > archiveThreshold && memory.importance < importantThreshold) {
          // 使用 store.update() 方法归档（该方法内部会删除+重插入）
          await this.config.store.update(memory.id, { status: 'archived' });
          archivedCount++;
        }
      }

      console.log(`[LifecycleManager] 归档完成，共归档 ${archivedCount} 条记忆`);
      return archivedCount;
    } catch (error) {
      console.error('[LifecycleManager] 归档失败:', error);
      return 0;
    }
  }

  // ============================================================================
  // 上下文注入
  // ============================================================================

  /**
   * 获取需要注入到上下文的记忆
   *
   * @param limit 返回的记忆数量限制
   * @returns 格式化的记忆文本，用于注入到上下文
   */
  async getMemoriesForInjection(limit: number = 5): Promise<string> {
    try {
      // 查询最近活跃的记忆（最近7天）
      const results = await this.config.store.searchByText('', {
        limit: limit * 2, // 多取一些用于筛选
        status: 'active',
      });

      // 过滤并限制数量
      const memories = results
        .filter((r) => r.score >= 0.3)
        .slice(0, limit)
        .map((r) => ({
          category: r.entry.category,
          text: r.entry.text,
          importance: r.entry.importance,
          url: r.entry.url,
        }));

      if (memories.length === 0) {
        return '';
      }

      // 更新这些记忆的访问时间
      for (const result of results.slice(0, limit)) {
        await this.touchMemory(result.entry.id);
      }

      return this.formatMemoryContext(memories);
    } catch (error) {
      console.error('[LifecycleManager] 获取注入记忆失败:', error);
      return '';
    }
  }

  /**
   * 格式化记忆用于注入上下文
   */
  formatMemoryContext(
    memories: Array<{ category: string; text: string; importance: number; url?: string }>,
  ): string {
    if (memories.length === 0) {
      return '';
    }

    const lines = memories.map((m, i) => {
      let line = `${i + 1}. [${m.category}] ${m.text}`;
      if (m.url) {
        line += ` (来源: ${m.url})`;
      }
      return line;
    });

    return `<relevant-memories>
这些是你过去记住的重要工作信息：
${lines.join('\n')}
</relevant-memories>`;
  }

  /**
   * 更新记忆的最后访问时间
   */
  async touchMemory(memoryId: string): Promise<void> {
    try {
      const entry = await this.config.store.getById(memoryId);
      if (entry) {
        await this.config.store.update(memoryId, {
          lastAccessedAt: Date.now(),
        });
      }
    } catch (error) {
      console.error(`[LifecycleManager] 更新访问时间失败: ${error}`);
    }
  }

  // ============================================================================
  // 记忆状态管理
  // ============================================================================

  /**
   * 检查记忆是否应该归档
   */
  shouldArchive(memory: { lastAccessedAt?: number; importance: number }): boolean {
    const now = Date.now();
    const archiveThreshold = this.config.archiveAfterDays * 24 * 60 * 60 * 1000;
    const inactiveTime = memory.lastAccessedAt ? now - memory.lastAccessedAt : now;

    // 30天无访问 且 重要性 < 0.3
    return inactiveTime > archiveThreshold && memory.importance < 0.3;
  }

  /**
   * 获取记忆的层级
   */
  getMemoryTier(
    createdAt: number,
    lastAccessedAt?: number,
  ): 'recent' | 'active' | 'archived' {
    const now = Date.now();
    const recentThreshold = 7 * 24 * 60 * 60 * 1000; // 7天
    const activeThreshold = 30 * 24 * 60 * 60 * 1000; // 30天

    const age = now - createdAt;

    if (age < recentThreshold) {
      return 'recent';
    } else if (age < activeThreshold) {
      return 'active';
    } else {
      return 'archived';
    }
  }
}
