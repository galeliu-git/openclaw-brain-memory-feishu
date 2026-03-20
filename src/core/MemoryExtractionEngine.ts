/**
 * 记忆提取引擎（核心）
 *
 * 负责批量判断飞书消息是否值得记忆，并进行结构化提取。
 *
 * 处理流程：
 * 1. 收集待处理的批次
 * 2. 从 memory 库读取已有项目列表
 * 3. 根据来源类型调用不同的 LLM Prompt
 * 4. 解析 LLM 输出，生成记忆
 */

import type {
  NormalizedEvent,
  PendingBatch,
  ExtractionDecision,
  BatchExtractionResult,
  MemoryEntry,
  ProjectEntry,
} from '../types.js';
import type { BrainMemoryStore } from '../memory/store.js';
import type { LLMAdapter } from './adapters/LLMAdapter.js';

export interface MemoryExtractionEngineConfig {
  store: BrainMemoryStore;
  importanceThreshold: number;
  llmAdapter: LLMAdapter;
}

export class MemoryExtractionEngine {
  constructor(private config: MemoryExtractionEngineConfig) {}

  /**
   * 处理一个批次的消息
   */
  async processBatch(batch: PendingBatch, existingProjects: ProjectEntry[]): Promise<BatchExtractionResult> {
    switch (batch.sourceType) {
      case 'chat':
        return this.processChatBatch(batch, existingProjects);

      case 'doc':
        return this.processDocBatch(batch, existingProjects);

      case 'meeting':
        return this.processMeetingBatch(batch, existingProjects);

      case 'task':
        return this.processTaskBatch(batch, existingProjects);

      default:
        return [];
    }
  }

  /**
   * 处理群聊/私聊批次
   */
  private async processChatBatch(
    batch: PendingBatch,
    existingProjects: ProjectEntry[],
  ): Promise<BatchExtractionResult> {
    // 区分群聊和私聊
    const isGroupChat = batch.groupKey.startsWith('group_');

    // 构建消息列表，标注用户消息
    const messageList = batch.messages
      .map((msg, idx) => {
        const userTag = '[USER]';
        return `[${idx}] [${msg.userName || msg.userId}] ${msg.content} ${userTag}`;
      })
      .join('\n');

    // 构建已有项目列表
    const projectList = existingProjects
      .map((p) => `- ${p.name}: ${p.description}`)
      .join('\n') || '（暂无已有项目）';

    const prompt = `你是一个信息分类专家。判断一群聊消息是否与用户的工作相关。

来源信息：
- 渠道类型：${isGroupChat ? '群聊' : '私聊'}
- 群聊名称：${batch.sourceName}

已有项目：
${projectList}

消息列表（消息末尾标注了 [USER] 表示用户自己发的消息）：
${messageList}

判断规则：
1. 用户发的消息（[USER]）是创建新项目的依据
2. 其他人的消息用于判断项目进展
3. 如果整批消息与用户无关或无价值，返回 discard

输出JSON（数组）：
[
  {
    "action": "link_to_project",
    "targetProjectId": "已有项目ID（如果没有匹配的已有项目则不填）",
    "targetProjectName": "项目名",
    "userMessageIndices": [0, 3],
    "otherMessageIndices": [1, 2, 4],
    "memories": [
      {
        "text": "记忆内容",
        "category": "decision/task/knowledge/event",
        "importance": 0.85,
        "summary": "一句话总结"
      }
    ],
    "reasoning": "为什么关联到该项目"
  },
  {
    "action": "create_new",
    "newProject": {
      "name": "新项目名称",
      "description": "项目一句话描述"
    },
    "userMessageIndices": [5],
    "otherMessageIndices": [6, 7],
    "memories": [
      {
        "text": "用户发起讨论新项目",
        "category": "event",
        "importance": 0.8,
        "summary": "用户发起新话题"
      }
    ],
    "reasoning": "用户发起了新话题，创建新项目"
  },
  {
    "action": "discard",
    "userMessageIndices": [],
    "otherMessageIndices": [9, 10, 11],
    "reasoning": "日常闲聊无工作价值"
  }
]`;

    return this.callLLM(prompt, batch.messages);
  }

  /**
   * 处理文档批次
   * 文档只能关联已有项目，不能创建新项目
   */
  private async processDocBatch(
    batch: PendingBatch,
    existingProjects: ProjectEntry[],
  ): Promise<BatchExtractionResult> {
    // 构建已有项目列表
    const projectList = existingProjects
      .map((p) => `- ${p.name}: ${p.description}`)
      .join('\n') || '（暂无已有项目）';

    // 合并所有消息内容作为文档正文
    const docContent = batch.messages.map((msg) => msg.content).join('\n\n');

    const prompt = `你是一个信息分类专家。从一篇飞书文档中提取工作记忆。

来源信息：
- 文档标题：${batch.sourceName}
- 文档链接：${batch.messages[0]?.url || ''}

已有项目：
${projectList}

文档内容：
${docContent}

重要规则：
- 文档不能创建新项目，只能关联到已有项目或丢弃
- 关联时考虑文档内容与哪个项目相关

输出JSON（数组）：
[
  {
    "action": "link_to_project",
    "targetProjectId": "已有项目ID",
    "memories": [
      {
        "text": "记忆内容",
        "category": "knowledge/decision/event",
        "importance": 0.85,
        "summary": "一句话总结"
      }
    ]
  },
  {
    "action": "discard",
    "reasoning": "文档内容与用户工作无关"
  }
]`;

    return this.callLLM(prompt, batch.messages);
  }

  /**
   * 处理会议纪要批次
   * 会议纪要需要判断用户是否参与才能创建新项目
   */
  private async processMeetingBatch(
    batch: PendingBatch,
    existingProjects: ProjectEntry[],
  ): Promise<BatchExtractionResult> {
    // 构建已有项目列表
    const projectList = existingProjects
      .map((p) => `- ${p.name}: ${p.description}`)
      .join('\n') || '（暂无已有项目）';

    // 获取当前用户 ID
    const currentUserId = batch.messages[0]?.userId || '';

    // 合并所有消息内容作为会议纪要正文
    const meetingContent = batch.messages.map((msg) => msg.content).join('\n\n');

    const prompt = `你是一个信息分类专家。从一篇会议纪要中提取工作记忆。

来源信息：
- 会议主题：${batch.sourceName}
- 会议链接：${batch.messages[0]?.url || ''}
- 当前用户：${currentUserId}

已有项目：
${projectList}

会议内容：
${meetingContent}

重要规则：
- 如果用户没有在会议中发言，也没有被@，只能关联到已有项目或丢弃
- 只有用户发言了或被@了，才能创建新项目

输出JSON（数组）：
[
  {
    "action": "link_to_project",
    "targetProjectId": "已有项目ID",
    "memories": [
      {
        "text": "会议决定采用XX方案",
        "category": "decision",
        "importance": 0.85,
        "summary": "会议决策"
      }
    ]
  },
  {
    "action": "create_new",
    "newProject": {
      "name": "新项目名称",
      "description": "项目一句话描述"
    },
    "memories": [...],
    "reasoning": "用户在会议中发起了新话题"
  },
  {
    "action": "discard",
    "reasoning": "无用户参与的讨论，无新项目创建"
  }
]`;

    return this.callLLM(prompt, batch.messages);
  }

  /**
   * 处理任务批次
   * 任务可以创建新项目或关联已有项目
   */
  private async processTaskBatch(
    batch: PendingBatch,
    existingProjects: ProjectEntry[],
  ): Promise<BatchExtractionResult> {
    // 构建已有项目列表
    const projectList = existingProjects
      .map((p) => `- ${p.name}: ${p.description}`)
      .join('\n') || '（暂无已有项目）';

    // 合并所有消息内容
    const taskContent = batch.messages.map((msg) => msg.content).join('\n\n');

    const prompt = `你是一个信息分类专家。从飞书任务中提取工作记忆。

来源信息：
- 任务标题：${batch.sourceName}
- 任务链接：${batch.messages[0]?.url || ''}

已有项目：
${projectList}

任务内容：
${taskContent}

重要规则：
- 任务可以创建新项目（如果是新任务）或关联到已有项目
- 任务完成后标记为已完成

输出JSON（数组）：
[
  {
    "action": "link_to_project",
    "targetProjectId": "已有项目ID",
    "memories": [
      {
        "text": "任务内容",
        "category": "task",
        "importance": 0.8,
        "summary": "任务一句话描述"
      }
    ]
  },
  {
    "action": "create_new",
    "newProject": {
      "name": "新项目名称",
      "description": "项目一句话描述"
    },
    "memories": [...],
    "reasoning": "新任务属于新项目"
  }
]`;

    return this.callLLM(prompt, batch.messages);
  }

  /**
   * 调用 LLM
   */
  private async callLLM(prompt: string, _messages: NormalizedEvent[]): Promise<BatchExtractionResult> {
    try {
      const content = await this.config.llmAdapter.complete({
        messages: [
          {
            role: 'system',
            content:
              '你是一个工作记忆提取助手。请根据用户输入判断并返回JSON数组。只能返回JSON，不要有其他文字。',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.3,
        responseFormat: { type: 'json_object' },
      });

      if (!content) {
        return [];
      }

      const result = JSON.parse(content);

      // 兼容返回数组或对象
      if (Array.isArray(result)) {
        return result;
      }

      // 如果是对象但有 decisions 字段
      if (result.decisions) {
        return result.decisions;
      }

      // 如果只有一个 decision
      if (result.action) {
        return [result];
      }

      return [];
    } catch (error) {
      console.error('LLM 调用失败:', error);
      return [];
    }
  }

  /**
   * 根据 LLM 输出创建记忆条目
   */
  async createMemoriesFromDecisions(
    decisions: BatchExtractionResult,
    batch: PendingBatch,
  ): Promise<MemoryEntry[]> {
    const entries: Omit<MemoryEntry, 'id' | 'createdAt'>[] = [];

    for (const decision of decisions) {
      if (decision.action === 'discard') {
        continue;
      }

      if (decision.action === 'create_new') {
        // 创建新项目记忆
        const projectMemory: Omit<MemoryEntry, 'id' | 'createdAt'> = {
          text: decision.newProject!.name,
          vector: [], // 稍后填充
          importance: 0.9,
          category: 'project',
          source: 'feishu_chat',
          sourceId: batch.sourceId,
          url: batch.messages[0]?.url || '',
          projectId: undefined,
          status: 'active',
        };
        entries.push(projectMemory);

        // 为每个 memory 设置项目 ID
        for (const memory of decision.memories) {
          if (memory.importance >= this.config.importanceThreshold) {
            entries.push({
              text: memory.text,
              vector: [],
              importance: memory.importance,
              category: memory.category,
              source: 'feishu_chat',
              sourceId: batch.sourceId,
              url: batch.messages[0]?.url || '',
              projectId: undefined, // 稍后更新
              status: 'active',
            });
          }
        }
      }

      if (decision.action === 'link_to_project') {
        for (const memory of decision.memories) {
          if (memory.importance >= this.config.importanceThreshold) {
            entries.push({
              text: memory.text,
              vector: [],
              importance: memory.importance,
              category: memory.category,
              source: 'feishu_chat',
              sourceId: batch.sourceId,
              url: batch.messages[0]?.url || '',
              projectId: decision.targetProjectId,
              status: 'active',
            });
          }
        }
      }
    }

    // 向量化并存储
    const fullEntries: MemoryEntry[] = [];
    for (const entry of entries) {
      try {
        const vector = await this.config.store.embed(entry.text);
        const fullEntry = await this.config.store.store({
          ...entry,
          vector,
        });
        fullEntries.push(fullEntry);
      } catch (error) {
        console.error('存储记忆失败:', error);
      }
    }

    return fullEntries;
  }
}
