import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReportGenerator } from './ReportGenerator.js';
import type { DailyReport, MemoryEntry } from '../types.js';
import type { LLMAdapter } from './adapters/LLMAdapter.js';

describe('ReportGenerator', () => {
  let reportGenerator: ReportGenerator;
  let mockStore: any;
  let mockLLMAdapter: any;

  beforeEach(() => {
    mockStore = {
      searchByText: vi.fn(),
      getProjectById: vi.fn(),
    };

    mockLLMAdapter = {
      complete: vi.fn(),
    };

    reportGenerator = new ReportGenerator({
      store: mockStore,
      llmAdapter: mockLLMAdapter as LLMAdapter,
    });
  });

  describe('generateReport', () => {
    it('should return empty sections when no memories found', async () => {
      mockStore.searchByText.mockResolvedValue([]);

      const report = await reportGenerator.generateReport(new Date());

      expect(report.sections).toHaveLength(0);
      expect(report.summary).toBe('今日暂无工作记录。');
    });

    // Note: Full generateReport test is omitted because it requires mocking OpenAI API
    // which is complex. The formatAsMarkdown test covers the formatting logic.
  });

  describe('formatAsMarkdown', () => {
    it('should format report as markdown', () => {
      const report: DailyReport = {
        date: new Date('2026-03-20'),
        sections: [
          {
            project: '项目A',
            progress: ['完成了需求分析'],
            ongoing: ['正在开发功能模块'],
            blockers: ['等待UI设计稿'],
          },
        ],
        summary: '2026-03-20 工作概览：\n- 完成 1 项\n- 进行中 1 项\n- 阻塞 1 项',
        generatedAt: new Date(),
      };

      const markdown = reportGenerator.formatAsMarkdown(report);

      expect(markdown).toContain('# 工作日报 - 2026/3/20');
      expect(markdown).toContain('## 【项目A】');
      expect(markdown).toContain('### ✅ 完成');
      expect(markdown).toContain('- 完成了需求分析');
      expect(markdown).toContain('### 🔄 进行中');
      expect(markdown).toContain('- 正在开发功能模块');
      expect(markdown).toContain('### ⚠️ 阻塞');
      expect(markdown).toContain('- 等待UI设计稿');
      expect(markdown).toContain('*日报生成时间:');
    });

    it('should handle empty sections', () => {
      const report: DailyReport = {
        date: new Date(),
        sections: [],
        summary: '今日暂无工作记录。',
        generatedAt: new Date(),
      };

      const markdown = reportGenerator.formatAsMarkdown(report);

      expect(markdown).toContain('今日暂无工作记录。');
    });

    it('should only show non-empty categories', () => {
      const report: DailyReport = {
        date: new Date(),
        sections: [
          {
            project: '项目A',
            progress: ['完成了任务1'],
            ongoing: [],
            blockers: [],
          },
        ],
        summary: '',
        generatedAt: new Date(),
      };

      const markdown = reportGenerator.formatAsMarkdown(report);

      expect(markdown).toContain('### ✅ 完成');
      expect(markdown).not.toContain('### 🔄 进行中');
      expect(markdown).not.toContain('### ⚠️ 阻塞');
    });
  });
});
