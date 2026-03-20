/**
 * 同步管理器
 *
 * 负责定时采集飞书数据并处理。
 *
 * 处理流程：
 * 1. 定时触发数据采集
 * 2. 将数据加入批次处理器
 * 3. 检查并处理到期的批次
 * 4. 调用 LLM 提取记忆
 */

import type { BrainMemoryStore } from '../memory/store.js';
import type { FeishuDataCollector } from './FeishuDataCollector.js';
import type { BatchProcessor } from './BatchProcessor.js';
import type { MemoryExtractionEngine } from './MemoryExtractionEngine.js';
import type { ProjectEntry } from '../types.js';

export interface SyncManagerConfig {
  store: BrainMemoryStore;
  dataCollector: FeishuDataCollector;
  batchProcessor: BatchProcessor;
  extractionEngine: MemoryExtractionEngine;
  // 归档管理器（可选）
  lifecycleManager?: {
    archiveOldMemories: () => Promise<number>;
  };
  // 同步间隔（毫秒），默认 5 分钟检查一次
  syncIntervalMs?: number;
  // 上次归档时间（毫秒）
  lastArchiveTime?: number;
  // 上次同步时间
  lastSyncTime?: number;
}

export class SyncManager {
  private syncIntervalMs: number;
  private lastSyncTime: number;
  private lastArchiveTime: number;
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(private config: SyncManagerConfig) {
    this.syncIntervalMs = config.syncIntervalMs || 5 * 60 * 1000; // 默认 5 分钟
    this.lastSyncTime = config.lastSyncTime || Date.now();
    this.lastArchiveTime = config.lastArchiveTime || Date.now();
  }

  // ============================================================================
  // 启动和停止
  // ============================================================================

  /**
   * 启动同步管理器
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    console.log(`[SyncManager] 启动同步管理器，间隔 ${this.syncIntervalMs / 1000 / 60} 分钟`);

    // 立即执行一次同步
    this.sync().catch((err) => console.error('[SyncManager] 同步失败:', err));

    // 设置定时器
    this.timer = setInterval(() => {
      this.sync().catch((err) => console.error('[SyncManager] 同步失败:', err));
    }, this.syncIntervalMs);
  }

  /**
   * 停止同步管理器
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[SyncManager] 同步管理器已停止');
  }

  // ============================================================================
  // 同步流程
  // ============================================================================

  /**
   * 执行一次完整的同步
   */
  async sync(): Promise<void> {
    console.log('[SyncManager] 开始同步...');
    const startTime = Date.now();

    try {
      // 1. 采集飞书数据
      const events = await this.config.dataCollector.collectSince(this.lastSyncTime);
      console.log(`[SyncManager] 采集到 ${events.length} 条数据`);

      // 2. 将数据加入批次处理器
      for (const event of events) {
        this.config.batchProcessor.addMessage(event);
      }

      // 3. 获取当前已有项目列表
      const existingProjects = await this.config.store.getProjects();
      console.log(`[SyncManager] 当前有 ${existingProjects.length} 个项目`);

      // 4. 检查并处理到期的批次
      const readyBatches = this.config.batchProcessor.getReadyBatches();
      console.log(`[SyncManager] 有 ${readyBatches.length} 个批次准备处理`);

      let processedCount = 0;
      let memoryCount = 0;

      for (const batch of readyBatches) {
        // 调用 LLM 处理批次
        const decisions = await this.config.extractionEngine.processBatch(
          batch,
          existingProjects,
        );

        // 创建记忆
        const memories = await this.config.extractionEngine.createMemoriesFromDecisions(
          decisions,
          batch,
        );

        // 更新项目最后活动时间
        for (const decision of decisions) {
          if (decision.action === 'link_to_project' && decision.targetProjectId) {
            await this.config.store.updateProjectLastActivity(decision.targetProjectId);
          }
          if (decision.action === 'create_new' && decision.newProject) {
            // 新项目刚创建，已经在 createMemoriesFromDecisions 中处理了
          }
        }

        // 清除已处理的批次
        this.config.batchProcessor.clearBatch(batch.groupKey);

        processedCount++;
        memoryCount += memories.length;
      }

      // 5. 更新同步时间
      this.lastSyncTime = Date.now();

      // 6. 检查是否需要归档（每天检查一次）
      const now = Date.now();
      const archiveInterval = 24 * 60 * 60 * 1000; // 24小时
      if (
        this.config.lifecycleManager &&
        now - this.lastArchiveTime >= archiveInterval
      ) {
        console.log('[SyncManager] 开始归档旧记忆...');
        const archivedCount = await this.config.lifecycleManager.archiveOldMemories();
        console.log(`[SyncManager] 归档完成，共归档 ${archivedCount} 条记忆`);
        this.lastArchiveTime = now;
      }

      const elapsed = Date.now() - startTime;
      console.log(
        `[SyncManager] 同步完成: 处理 ${processedCount} 个批次，生成 ${memoryCount} 条记忆，耗时 ${elapsed}ms`,
      );
    } catch (error) {
      console.error('[SyncManager] 同步出错:', error);
    }
  }

  /**
   * 手动触发一次同步
   */
  async triggerSync(): Promise<void> {
    await this.sync();
  }

  /**
   * 获取同步状态
   */
  getStatus(): {
    isRunning: boolean;
    lastSyncTime: number;
    lastArchiveTime: number;
    batchCount: ReturnType<BatchProcessor['getBatchCount']>;
    pendingBatches: number;
  } {
    return {
      isRunning: this.isRunning,
      lastSyncTime: this.lastSyncTime,
      lastArchiveTime: this.lastArchiveTime,
      batchCount: this.config.batchProcessor.getBatchCount(),
      pendingBatches: this.config.batchProcessor.getReadyBatches().length,
    };
  }
}

// 导出单例
let syncManagerInstance: SyncManager | null = null;

/**
 * 获取或创建同步管理器实例
 */
export function getSyncManager(config: SyncManagerConfig): SyncManager {
  if (!syncManagerInstance) {
    syncManagerInstance = new SyncManager(config);
  }
  return syncManagerInstance;
}

/**
 * 重置同步管理器实例（用于测试）
 */
export function resetSyncManager(): void {
  if (syncManagerInstance) {
    syncManagerInstance.stop();
    syncManagerInstance = null;
  }
}
