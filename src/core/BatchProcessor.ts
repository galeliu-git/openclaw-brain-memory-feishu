/**
 * 批次处理器
 *
 * 负责将飞书数据按来源分组、攒批，等待触发处理。
 * - 群聊（group）：按 (chatId) 分组
 * - 私聊（p2p）：按 (chatId) 分组，但作为独立来源处理
 * - 文档（doc）：按 (docId) 分组
 * - 会议（meeting）：按 (meetingId) 分组
 * - 任务（task）：按 (taskId) 分组
 */

import type { NormalizedEvent, PendingBatch } from '../types.js';
import type { BrainMemoryStore } from '../memory/store.js';

export interface BatchProcessorConfig {
  batchWindowHours: number;
  store: BrainMemoryStore;
}

// 待处理的批次缓存
const pendingBatches = new Map<string, PendingBatch>();

export class BatchProcessor {
  private batchWindowMs: number;

  constructor(private config: BatchProcessorConfig) {
    this.batchWindowMs = config.batchWindowHours * 60 * 60 * 1000;
  }

  /**
   * 添加消息到对应的批次
   */
  addMessage(event: NormalizedEvent): void {
    const groupKey = this.getGroupKey(event);
    const existing = pendingBatches.get(groupKey);

    if (existing) {
      existing.messages.push(event);
      existing.lastMessageTime = event.timestamp;
    } else {
      pendingBatches.set(groupKey, {
        groupKey,
        sourceType: event.type,
        sourceId: event.sourceId,
        sourceName: event.chatName || event.sourceId,
        messages: [event],
        firstMessageTime: event.timestamp,
        lastMessageTime: event.timestamp,
      });
    }
  }

  /**
   * 获取批次分组 Key
   * 群聊和私聊分开处理
   */
  private getGroupKey(event: NormalizedEvent): string {
    switch (event.type) {
      case 'chat':
        // 群聊和私聊使用不同的前缀，避免冲突
        if (event.chatType === 'p2p') {
          return `p2p_${event.chatId || event.sourceId}`;
        }
        return `group_${event.chatId || event.sourceId}`;

      case 'doc':
        return `doc_${event.sourceId}`;

      case 'meeting':
        return `meeting_${event.sourceId}`;

      case 'task':
        return `task_${event.sourceId}`;

      default:
        return `unknown_${event.sourceId}`;
    }
  }

  /**
   * 获取所有待处理的批次
   */
  getPendingBatches(): PendingBatch[] {
    return Array.from(pendingBatches.values());
  }

  /**
   * 获取需要处理的批次（超过时间窗口的批次）
   */
  getReadyBatches(): PendingBatch[] {
    const now = Date.now();
    return this.getPendingBatches().filter(
      (batch) => now - batch.lastMessageTime >= this.batchWindowMs && batch.messages.length > 0,
    );
  }

  /**
   * 清除指定批次的缓存
   */
  clearBatch(groupKey: string): void {
    pendingBatches.delete(groupKey);
  }

  /**
   * 清除所有批次缓存
   */
  clearAll(): void {
    pendingBatches.clear();
  }

  /**
   * 检查并处理到期的批次
   */
  async checkAndProcess(): Promise<PendingBatch[]> {
    const readyBatches = this.getReadyBatches();

    for (const batch of readyBatches) {
      // 触发处理后清空消息，但保留批次用于后续追踪
      batch.messages = [];
    }

    return readyBatches;
  }

  /**
   * 获取指定类型的批次数量
   */
  getBatchCount(): { group: number; p2p: number; doc: number; meeting: number; task: number } {
    let group = 0;
    let p2p = 0;
    let doc = 0;
    let meeting = 0;
    let task = 0;

    for (const key of pendingBatches.keys()) {
      if (key.startsWith('group_')) group++;
      else if (key.startsWith('p2p_')) p2p++;
      else if (key.startsWith('doc_')) doc++;
      else if (key.startsWith('meeting_')) meeting++;
      else if (key.startsWith('task_')) task++;
    }

    return { group, p2p, doc, meeting, task };
  }
}
