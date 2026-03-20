/**
 * OpenClaw Brain Memory Plugin
 *
 * 飞书驱动的工作记忆插件
 *
 * 核心功能：
 * - 自动采集飞书数据（群聊、私聊、文档，会议、任务）
 * - LLM 批量提取工作记忆
 * - 按项目上下文注入记忆
 * - 支持工作日报生成
 */

import { Type } from '@sinclair/typebox';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { brainMemoryConfigSchema, type ConfigSchemaType } from './config/schema.js';
import type { BrainMemoryConfig } from './config/types.js';
import { DEFAULT_CONFIG } from './config/types.js';
import { BrainMemoryStore, type EmbeddingConfig } from './memory/store.js';
import { BatchProcessor } from './core/BatchProcessor.js';
import { MemoryExtractionEngine } from './core/MemoryExtractionEngine.js';
import { FeishuDataCollector } from './core/FeishuDataCollector.js';
import { LifecycleManager } from './core/LifecycleManager.js';
import { ReportGenerator } from './core/ReportGenerator.js';
import { SyncManager, getSyncManager } from './core/SyncManager.js';
import { LLMAdapter } from './core/adapters/LLMAdapter.js';

// ============================================================================
// 插件定义
// ============================================================================

const brainMemoryPlugin = {
  id: 'brain-memory',
  name: 'Brain Memory',
  description: '飞书驱动的工作记忆插件 - 自动采集飞书数据构建结构化工作记忆',
  kind: 'memory' as const,
  configSchema: brainMemoryConfigSchema,

  // ============================================================================
  // 注册插件
  // ============================================================================

  register(api: OpenClawPluginApi) {
    // 解析配置
    const rawConfig = api.config as ConfigSchemaType;
    const config: BrainMemoryConfig = {
      feishu: rawConfig.feishu || { appId: '', appSecret: '' },
      sources: { ...DEFAULT_CONFIG.sources, ...rawConfig.sources },
      scan: { ...DEFAULT_CONFIG.scan, ...rawConfig.scan },
      memory: { ...DEFAULT_CONFIG.memory, ...rawConfig.memory },
      report: { ...DEFAULT_CONFIG.report, ...rawConfig.report },
    };

    api.logger.info(
      `brain-memory: 插件注册成功 (批次窗口: ${config.scan.batchWindowHours}小时, 重要性阈值: ${config.memory.importanceThreshold})`,
    );

    // ============================================================================
    // 初始化存储
    // ============================================================================

    // embedding 配置（可选，如果 ctx.embedding 不可用则需要）
    const embedding = rawConfig.embedding || {};
    const embeddingConfig: EmbeddingConfig | undefined = embedding.apiKey
      ? {
          apiKey: embedding.apiKey,
          baseUrl: embedding.baseUrl,
          model: embedding.model || 'text-embedding-3-small',
        }
      : undefined;

    const store = new BrainMemoryStore({
      dbPath: api.resolvePath('~/.openclaw/memory/brain-memory'),
      embedding: embeddingConfig,
      ctx: api, // 传入 ctx 以支持 ctx.embedding
    });

    // ============================================================================
    // 初始化核心模块
    // ============================================================================

    // LLM 适配器（通过 OpenClaw ctx.llm）
    const llmAdapter = new LLMAdapter(api);

    // 批次处理器
    const batchProcessor = new BatchProcessor({
      batchWindowHours: config.scan.batchWindowHours,
      store,
    });

    // 记忆提取引擎
    const extractionEngine = new MemoryExtractionEngine({
      store,
      importanceThreshold: config.memory.importanceThreshold,
      llmAdapter,
    });

    // 飞书数据采集器（通过 OpenClaw ctx.http）
    // token 从 ctx.feishu.token 获取（由 OpenClaw 飞书插件统一管理）
    const dataCollector = new FeishuDataCollector(api, {
      sources: config.sources,
    });

    // 生命周期管理器
    const lifecycleManager = new LifecycleManager({
      store,
      archiveAfterDays: config.memory.archiveAfterDays,
    });

    // 日报生成器
    const reportGenerator = new ReportGenerator({
      store,
      llmAdapter,
    });

    // 同步管理器
    const syncManager = getSyncManager({
      store,
      dataCollector,
      batchProcessor,
      extractionEngine,
      syncIntervalMs: 5 * 60 * 1000, // 5 分钟检查一次
    });

    // ============================================================================
    // 注册工具
    // ============================================================================

    // 飞书扫描工具
    api.registerTool(
      {
        name: 'feishu_scan',
        description: '扫描飞书数据源，构建工作记忆',
        parameters: Type.Object({
          sources: Type.Optional(
            Type.Array(
              Type.Union([
                Type.Literal('chat'),
                Type.Literal('doc'),
                Type.Literal('meeting'),
                Type.Literal('task'),
              ]),
            ),
          ),
          range: Type.Optional(
            Type.Object({
              start: Type.String(),
              end: Type.String(),
            }),
          ),
        }),
        async execute({ args }: { args: any }) {
          const { range } = args as {
            sources?: string[];
            range?: { start: string; end: string };
          };

          api.logger.info(`brain-memory: feishu_scan 调用，range=${range}`);

          try {
            let startTime: number;
            let endTime: number;

            if (range) {
              startTime = new Date(range.start).getTime();
              endTime = new Date(range.end).getTime();
            } else {
              // 默认扫描最近一天
              endTime = Date.now();
              startTime = endTime - 24 * 60 * 60 * 1000;
            }

            // 采集数据
            const events = await dataCollector.collectSince(startTime);
            api.logger.info(`brain-memory: 采集到 ${events.length} 条数据`);

            // 添加到批次处理器
            for (const event of events) {
              batchProcessor.addMessage(event);
            }

            // 获取已有项目
            const existingProjects = await store.getProjects();

            // 处理到期的批次
            const readyBatches = batchProcessor.getReadyBatches();
            let totalMemories = 0;

            for (const batch of readyBatches) {
              const decisions = await extractionEngine.processBatch(batch, existingProjects);
              const memories = await extractionEngine.createMemoriesFromDecisions(decisions, batch);
              totalMemories += memories.length;
              batchProcessor.clearBatch(batch.groupKey);
            }

            return {
              type: 'text' as const,
              content: `扫描完成！采集到 ${events.length} 条数据，处理了 ${readyBatches.length} 个批次，生成 ${totalMemories} 条记忆。`,
            };
          } catch (error) {
            api.logger.error(`feishu_scan 失败: ${error}`);
            return {
              type: 'text' as const,
              content: `扫描失败: ${error}`,
            };
          }
        },
      },
    );

    // 记忆查询工具
    api.registerTool({
      name: 'memory_query',
      description: '查询工作记忆',
      parameters: Type.Object({
        query: Type.Optional(Type.String()),
        project: Type.Optional(Type.String()),
        category: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
      }),
      async execute({ args }: { args: any }) {
        const { query, project, category, limit = 10 } = args as {
          query?: string;
          project?: string;
          category?: string;
          limit?: number;
        };

        api.logger.info(`brain-memory: memory_query 调用`);

        try {
          const results = await store.searchByText(query || '', {
            limit,
            projectId: project,
            category: category as any,
          });

          if (results.length === 0) {
            return {
              type: 'text' as const,
              content: '未找到相关记忆。',
            };
          }

          const text = results
            .map(
              (r, i) =>
                `${i + 1}. [${r.entry.category}] ${r.entry.text} (${(r.score * 100).toFixed(0)}%)`,
            )
            .join('\n');

          return {
            type: 'text' as const,
            content: `找到 ${results.length} 条记忆:\n\n${text}`,
          };
        } catch (error) {
          api.logger.error(`memory_query 失败: ${error}`);
          return {
            type: 'text' as const,
            content: '查询失败',
          };
        }
      },
    });

    // 生成日报工具
    api.registerTool({
      name: 'generate_daily_report',
      description: '生成工作日报',
      parameters: Type.Object({
        date: Type.Optional(Type.String()),
        projectIds: Type.Optional(Type.Array(Type.String())),
      }),
      async execute({ args }: { args: any }) {
        const { date, projectIds } = args as {
          date?: string;
          projectIds?: string[];
        };

        api.logger.info(`brain-memory: generate_daily_report 调用，date=${date}`);

        try {
          const targetDate = date ? new Date(date) : new Date();
          const report = await reportGenerator.generateReport(targetDate, projectIds);
          const markdown = reportGenerator.formatAsMarkdown(report);

          return {
            type: 'text' as const,
            content: markdown,
          };
        } catch (error) {
          api.logger.error(`generate_daily_report 失败: ${error}`);
          return {
            type: 'text' as const,
            content: '日报生成失败',
          };
        }
      },
    });

    // 记忆统计工具
    api.registerTool({
      name: 'memory_stats',
      description: '查看记忆统计',
      parameters: Type.Object({}),
      async execute() {
        api.logger.info(`brain-memory: memory_stats 调用`);

        try {
          const stats = await store.getStats();
          const lines = [
            `总记忆数: ${stats.total}`,
            `按类别分布:`,
            ...Object.entries(stats.byCategory).map(([cat, count]) => `  - ${cat}: ${count}`),
            `归档数: ${stats.archived}`,
          ];

          return {
            type: 'text' as const,
            content: lines.join('\n'),
          };
        } catch (error) {
          api.logger.error(`memory_stats 失败: ${error}`);
          return {
            type: 'text' as const,
            content: '统计失败',
          };
        }
      },
    });

    // 项目列表工具
    api.registerTool({
      name: 'project_list',
      description: '查看已识别的项目列表',
      parameters: Type.Object({}),
      async execute() {
        api.logger.info(`brain-memory: project_list 调用`);

        try {
          const projects = await store.getProjects();

          if (projects.length === 0) {
            return {
              type: 'text' as const,
              content: '暂无项目记忆。',
            };
          }

          const lines = projects.map(
            (p, i) =>
              `${i + 1}. ${p.name} (${p.status}) - 最后活动: ${new Date(p.lastActivityAt).toLocaleDateString()}`,
          );

          return {
            type: 'text' as const,
            content: `项目列表:\n\n${lines.join('\n')}`,
          };
        } catch (error) {
          api.logger.error(`project_list 失败: ${error}`);
          return {
            type: 'text' as const,
            content: '获取项目列表失败',
          };
        }
      },
    });

    // 项目重命名工具
    api.registerTool({
      name: 'project_rename',
      description: '重命名项目（修正LLM识别不准确的项目名）',
      parameters: Type.Object({
        projectId: Type.String(),
        newName: Type.String(),
      }),
      async execute({ args }: { args: any }) {
        const { projectId, newName } = args as {
          projectId: string;
          newName: string;
        };

        api.logger.info(`brain-memory: project_rename 调用 ${projectId} -> ${newName}`);

        try {
          // 获取项目
          const project = await store.getProjectById(projectId);
          if (!project) {
            return {
              type: 'text' as const,
              content: `项目不存在: ${projectId}`,
            };
          }

          // 更新项目名称（通过创建新的 project memory 并标记旧的为归档）
          await store.store({
            text: newName,
            vector: [],
            importance: 0.9,
            category: 'project',
            source: project.id ? 'feishu_chat' : 'feishu_chat',
            sourceId: projectId,
            url: '',
            projectId: undefined,
            status: 'active',
          });

          // 归档旧的项目记忆
          await store.update(projectId, { status: 'archived' });

          return {
            type: 'text' as const,
            content: `项目已重命名为: ${newName}`,
          };
        } catch (error) {
          api.logger.error(`project_rename 失败: ${error}`);
          return {
            type: 'text' as const,
            content: '重命名失败',
          };
        }
      },
    });

    // ============================================================================
    // 注册 CLI 命令
    // ============================================================================

    api.registerCli(
      ({ program }: { program: any }) => {
        const brain = program.command('brain').description('Brain Memory 插件命令');

        brain
          .command('scan')
          .description('扫描飞书数据并构建记忆')
          .option('--sources <sources>', '要扫描的数据源（逗号分隔）')
          .action(async (opts: any) => {
            console.log('brain scan 调用', opts);
            await syncManager.triggerSync();
          });

        brain
          .command('stats')
          .description('显示记忆统计')
          .action(async () => {
            const stats = await store.getStats();
            console.log('记忆统计:', JSON.stringify(stats, null, 2));
          });

        brain
          .command('projects')
          .description('列出项目')
          .action(async () => {
            const projects = await store.getProjects();
            console.log('项目列表:', JSON.stringify(projects, null, 2));
          });

        brain
          .command('batches')
          .description('显示当前待处理批次状态')
          .action(async () => {
            const counts = batchProcessor.getBatchCount();
            console.log('批次统计:', JSON.stringify(counts, null, 2));
          });

        brain
          .command('sync')
          .description('手动触发一次同步')
          .action(async () => {
            console.log('触发同步...');
            await syncManager.triggerSync();
          });

        brain
          .command('status')
          .description('显示同步状态')
          .action(async () => {
            const status = syncManager.getStatus();
            console.log('同步状态:', JSON.stringify(status, null, 2));
          });
      },
      { commands: ['brain'] },
    );

    // ============================================================================
    // 注册生命周期钩子
    // ============================================================================

    // 自动注入记忆到上下文
    api.on('before_agent_start', async (event: any) => {
      if (!event.prompt || event.prompt.length < 5) {
        return;
      }

      try {
        const memories = await lifecycleManager.getMemoriesForInjection(5);
        if (!memories) {
          return;
        }

        api.logger.info('brain-memory: 注入记忆到上下文');

        return {
          prependContext: memories,
        };
      } catch (err) {
        api.logger.warn(`brain-memory: 记忆注入失败: ${String(err)}`);
      }
    });

    // ============================================================================
    // 注册服务
    // ============================================================================

    api.registerService({
      id: 'brain-memory',
      start: () => {
        api.logger.info(
          `brain-memory: 服务启动 (批次窗口: ${config.scan.batchWindowHours}小时, 阈值: ${config.memory.importanceThreshold})`,
        );
        // 启动同步管理器
        syncManager.start();
      },
      stop: () => {
        api.logger.info('brain-memory: 服务停止');
        // 停止同步管理器
        syncManager.stop();
      },
    });
  },
};

// ============================================================================
// 导出插件
// ============================================================================

export default brainMemoryPlugin;
