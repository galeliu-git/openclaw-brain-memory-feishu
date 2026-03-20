/**
 * 日报生成器
 *
 * 负责根据记忆库生成工作日报。
 *
 * 日报结构：
 * - 每个项目的进展：完成 / 进行中 / 阻塞
 * - 日报链接指向原始飞书内容
 */

import type { BrainMemoryStore } from '../memory/store.js';
import type { DailyReport, ProjectSection, MemoryEntry } from '../types.js';
import type { LLMAdapter } from './adapters/LLMAdapter.js';

export interface ReportGeneratorConfig {
  store: BrainMemoryStore;
  llmAdapter: LLMAdapter;
}

export class ReportGenerator {
  constructor(private config: ReportGeneratorConfig) {}

  // ============================================================================
  // 生成日报
  // ============================================================================

  /**
   * 生成指定日期的日报
   */
  async generateReport(date: Date, projectIds?: string[]): Promise<DailyReport> {
    // 1. 查询当日所有记忆
    const memories = await this.queryMemoriesForDate(date, projectIds);

    // 2. 按项目分组
    const projectMemories = this.groupByProject(memories);

    // 3. 对每个项目生成进展
    const sections: ProjectSection[] = [];
    for (const [projectId, projectMemoryList] of Object.entries(projectMemories)) {
      const section = await this.generateProjectSection(projectId, projectMemoryList, date);
      sections.push(section);
    }

    // 4. 生成总体摘要
    const summary = await this.generateSummary(sections, date);

    return {
      date,
      sections,
      summary,
      generatedAt: new Date(),
    };
  }

  // ============================================================================
  // 查询和分组
  // ============================================================================

  /**
   * 查询指定日期的记忆
   */
  private async queryMemoriesForDate(
    date: Date,
    projectIds?: string[],
  ): Promise<MemoryEntry[]> {
    try {
      // 计算日期范围（当天 00:00:00 到 23:59:59）
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);

      const startTimestamp = startOfDay.getTime();
      const endTimestamp = endOfDay.getTime();

      // 查询所有记忆并过滤日期范围
      // 注意：这是一个简化实现，实际应该使用数据库的时间范围查询
      const allMemories: MemoryEntry[] = [];

      // 按项目查询
      if (projectIds && projectIds.length > 0) {
        for (const projectId of projectIds) {
          const results = await this.config.store.searchByText('', {
            limit: 100,
            projectId,
            status: 'active',
          });

          for (const result of results) {
            if (
              result.entry.createdAt >= startTimestamp &&
              result.entry.createdAt <= endTimestamp
            ) {
              allMemories.push(result.entry);
            }
          }
        }
      } else {
        // 查询所有活跃记忆
        const results = await this.config.store.searchByText('', {
          limit: 100,
          status: 'active',
        });

        for (const result of results) {
          if (
            result.entry.createdAt >= startTimestamp &&
            result.entry.createdAt <= endTimestamp
          ) {
            allMemories.push(result.entry);
          }
        }
      }

      return allMemories;
    } catch (error) {
      console.error('[ReportGenerator] 查询记忆失败:', error);
      return [];
    }
  }

  /**
   * 按项目分组记忆
   */
  private groupByProject(memories: MemoryEntry[]): Record<string, MemoryEntry[]> {
    const grouped: Record<string, MemoryEntry[]> = {};

    for (const memory of memories) {
      const projectId = memory.projectId || 'unknown';
      if (!grouped[projectId]) {
        grouped[projectId] = [];
      }
      grouped[projectId].push(memory);
    }

    return grouped;
  }

  // ============================================================================
  // 生成项目进展
  // ============================================================================

  /**
   * 生成单个项目的进展
   */
  private async generateProjectSection(
    projectId: string,
    memories: MemoryEntry[],
    date: Date,
  ): Promise<ProjectSection> {
    const project = await this.config.store.getProjectById(projectId);
    const projectName = project?.name || '未知项目';

    // 按类别分组
    const decisions: MemoryEntry[] = [];
    const tasks: MemoryEntry[] = [];
    const events: MemoryEntry[] = [];
    const knowledge: MemoryEntry[] = [];

    for (const memory of memories) {
      switch (memory.category) {
        case 'decision':
          decisions.push(memory);
          break;
        case 'task':
          tasks.push(memory);
          break;
        case 'event':
          events.push(memory);
          break;
        case 'knowledge':
          knowledge.push(memory);
          break;
      }
    }

    // 使用 LLM 分析并生成进展描述
    const progress = await this.analyzeProgress(decisions, tasks, 'completed', date);
    const ongoing = await this.analyzeProgress(decisions, tasks, 'ongoing', date);
    const blockers = await this.analyzeBlockers(events, knowledge);

    return {
      project: projectName,
      progress,
      ongoing,
      blockers,
    };
  }

  /**
   * 分析进展（使用 LLM）
   */
  private async analyzeProgress(
    decisions: MemoryEntry[],
    tasks: MemoryEntry[],
    type: 'completed' | 'ongoing',
    date: Date,
  ): Promise<string[]> {
    // 构建记忆上下文
    const memories = [...decisions, ...tasks];
    if (memories.length === 0) {
      return [];
    }

    const memoryTexts = memories.map((m, i) => `[${i}] [${m.category}] ${m.text}`).join('\n');
    const dateStr = date.toLocaleDateString('zh-CN');

    const prompt = `你是一个工作日志分析助手。分析以下记忆，判断哪些是"${type === 'completed' ? '已完成' : '进行中'}"的工作项。

日期：${dateStr}

记忆列表：
${memoryTexts}

请分析哪些记忆表明工作"${type === 'completed' ? '已完成' : '进行中'}"。

输出JSON格式：
{
  "items": ["已完成项目1", "已完成项目2"]
}

注意：
- "已完成"指明确表达了完成状态（如"完成了XX"、"通过了XX评审"、"确定了XX方案"）
- "进行中"指还在执行中但未完成的工作
- 只输出明确的已完成项，如果不确定则不输出
- 每个项不超过50字`;

    try {
      const content = await this.config.llmAdapter.complete({
        messages: [
          {
            role: 'system',
            content: '你是一个工作日志分析助手。请只返回JSON，不要有其他文字。',
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
      return (result.items || []).slice(0, 5);
    } catch (error) {
      console.error('[ReportGenerator] LLM 分析进展失败:', error);
      return [];
    }
  }

  /**
   * 分析阻塞点（使用 LLM）
   */
  private async analyzeBlockers(events: MemoryEntry[], knowledge: MemoryEntry[]): Promise<string[]> {
    // 构建记忆上下文
    const memories = [...events, ...knowledge];
    if (memories.length === 0) {
      return [];
    }

    const memoryTexts = memories.map((m, i) => `[${i}] [${m.category}] ${m.text}`).join('\n');

    const prompt = `你是一个工作日志分析助手。分析以下记忆，找出可能的工作阻塞点或问题。

记忆列表：
${memoryTexts}

请分析哪些记忆表明存在"阻塞"或"问题"。

输出JSON格式：
{
  "blockers": ["阻塞点1", "阻塞点2"]
}

注意：
- 阻塞点指：等待他人响应、遇到困难需要帮助、依赖外部条件、存在问题需要解决等
- 如果不确定则不输出
- 每个项不超过50字`;

    try {
      const content = await this.config.llmAdapter.complete({
        messages: [
          {
            role: 'system',
            content: '你是一个工作日志分析助手。请只返回JSON，不要有其他文字。',
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
      return (result.blockers || []).slice(0, 5);
    } catch (error) {
      console.error('[ReportGenerator] LLM 分析阻塞点失败:', error);
      return [];
    }
  }

  // ============================================================================
  // 生成摘要
  // ============================================================================

  /**
   * 生成总体摘要
   */
  private async generateSummary(sections: ProjectSection[], date: Date): Promise<string> {
    if (sections.length === 0) {
      return '今日暂无工作记录。';
    }

    // 统计
    let totalCompleted = 0;
    let totalOngoing = 0;
    let totalBlockers = 0;

    for (const section of sections) {
      totalCompleted += section.progress.length;
      totalOngoing += section.ongoing.length;
      totalBlockers += section.blockers.length;
    }

    // 生成简单摘要
    let summary = `${date.toLocaleDateString('zh-CN')} 工作概览：`;

    if (totalCompleted > 0) {
      summary += `\n- 完成 ${totalCompleted} 项`;
    }
    if (totalOngoing > 0) {
      summary += `\n- 进行中 ${totalOngoing} 项`;
    }
    if (totalBlockers > 0) {
      summary += `\n- 阻塞 ${totalBlockers} 项`;
    }

    // 如果有阻塞，提示关注
    if (totalBlockers > 0) {
      summary += '\n\n⚠️ 有阻塞事项需要关注';
    }

    return summary;
  }

  // ============================================================================
  // 格式化输出
  // ============================================================================

  /**
   * 格式化日报为 Markdown
   */
  formatAsMarkdown(report: DailyReport): string {
    const lines: string[] = [];

    // 标题
    lines.push(`# 工作日报 - ${report.date.toLocaleDateString('zh-CN')}`);
    lines.push('');

    // 总体摘要
    if (report.summary) {
      lines.push(report.summary);
      lines.push('');
    }

    // 各项目进展
    for (const section of report.sections) {
      lines.push(`## 【${section.project}】`);
      lines.push('');

      if (section.progress.length > 0) {
        lines.push('### ✅ 完成');
        for (const item of section.progress) {
          lines.push(`- ${item}`);
        }
        lines.push('');
      }

      if (section.ongoing.length > 0) {
        lines.push('### 🔄 进行中');
        for (const item of section.ongoing) {
          lines.push(`- ${item}`);
        }
        lines.push('');
      }

      if (section.blockers.length > 0) {
        lines.push('### ⚠️ 阻塞');
        for (const item of section.blockers) {
          lines.push(`- ${item}`);
        }
        lines.push('');
      }
    }

    // 页脚
    lines.push('---');
    lines.push('');
    lines.push(`*日报生成时间: ${report.generatedAt.toLocaleString('zh-CN')}*`);

    return lines.join('\n');
  }
}
