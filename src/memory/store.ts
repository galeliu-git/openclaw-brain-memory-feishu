/**
 * LanceDB Store for Brain Memory
 *
 * 复用 memory-lancedb 的数据库路径和 embedding 服务，
 * 但使用独立的表存储飞书工作记忆。
 */

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type * as LanceDB from '@lancedb/lancedb';
import OpenAI from 'openai';
import type {
  MemoryEntry,
  MemoryCategory,
  MemoryStatus,
  FeishuSourceType,
  ProjectEntry,
} from '../types.js';

// ============================================================================
// Types
// ============================================================================

type MemorySearchResult = {
  entry: MemoryEntry;
  score: number;
};

// ============================================================================
// LanceDB Provider
// ============================================================================

const TABLE_NAME = 'brain_memories';
const DEFAULT_DB_PATH = join(homedir(), '.openclaw', 'memory', 'lancedb');
const EMBEDDING_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
};

function vectorDimsForModel(model: string): number {
  const dims = EMBEDDING_DIMENSIONS[model];
  if (!dims) {
    throw new Error(`Unsupported embedding model: ${model}`);
  }
  return dims;
}

let lancedbImportPromise: Promise<typeof import('@lancedb/lancedb')> | null = null;
const loadLanceDB = async (): Promise<typeof import('@lancedb/lancedb')> => {
  if (!lancedbImportPromise) {
    lancedbImportPromise = import('@lancedb/lancedb');
  }
  try {
    return await lancedbImportPromise;
  } catch (err) {
    throw new Error(`brain-memory: failed to load LanceDB. ${String(err)}`, { cause: err });
  }
};

// ============================================================================
// Embeddings
// ============================================================================

export interface EmbeddingConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  dimensions?: number;
}

class Embeddings {
  private client: OpenAI;

  constructor(
    apiKey: string,
    private model: string,
    baseUrl?: string,
    private dimensions?: number,
  ) {
    this.client = new OpenAI({ apiKey, baseURL: baseUrl });
  }

  async embed(text: string): Promise<number[]> {
    const params: { model: string; input: string; dimensions?: number } = {
      model: this.model,
      input: text,
    };
    if (this.dimensions) {
      params.dimensions = this.dimensions;
    }
    const response = await this.client.embeddings.create(params);
    return response.data[0].embedding;
  }
}

// ============================================================================
// Memory Store
// ============================================================================

export interface BrainMemoryStoreConfig {
  dbPath?: string;
  embedding?: EmbeddingConfig;
  ctx?: any; // OpenClaw context for ctx.embedding
}

export class BrainMemoryStore {
  private db: LanceDB.Connection | null = null;
  private table: LanceDB.Table | null = null;
  private initPromise: Promise<void> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private embeddings: any = null;
  private useCtxEmbedding = false;

  constructor(private readonly config: BrainMemoryStoreConfig) {}

  private getEmbeddings(): Embeddings {
    if (this.embeddings) {
      return this.embeddings;
    }

    // 优先使用 ctx.embedding
    if (this.config.ctx?.embedding) {
      this.useCtxEmbedding = true;
      // 返回一个包装器，使用 ctx.embedding
      this.embeddings = {
        embed: async (text: string) => this.config.ctx!.embedding.embed(text),
      } as any;
      return this.embeddings;
    }

    // 回退到配置的 embedding
    if (!this.config.embedding) {
      throw new Error(
        'Embedding 不可用。请在插件配置中提供 embedding.apiKey，或确保 OpenClaw 配置了 ctx.embedding。'
      );
    }

    const model = this.config.embedding.model || 'text-embedding-3-small';
    const vectorDim = this.config.embedding.dimensions ?? vectorDimsForModel(model);
    this.embeddings = new Embeddings(
      this.config.embedding.apiKey,
      model,
      this.config.embedding.baseUrl,
      vectorDim,
    );
    return this.embeddings;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.table) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const lancedb = await loadLanceDB();
    const dbPath = this.config.dbPath || DEFAULT_DB_PATH;
    this.db = await lancedb.connect(dbPath);
    const tables = await this.db.tableNames();

    if (tables.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
    } else {
      const vectorDim = this.config.embedding?.dimensions ?? 1536;
      this.table = await this.db.createTable(TABLE_NAME, [
        {
          id: '__schema__',
          text: '',
          vector: Array.from({ length: vectorDim }).fill(0),
          importance: 0,
          category: 'other',
          createdAt: 0,
          source: 'feishu_chat',
          sourceId: '',
          url: '',
          projectId: null,
          lastAccessedAt: null,
          status: 'active',
        },
      ]);
      await this.table.delete('id = "__schema__"');
    }
  }

  // ========================================================================
  // Memory Operations
  // ========================================================================

  async store(entry: Omit<MemoryEntry, 'id' | 'createdAt'>): Promise<MemoryEntry> {
    await this.ensureInitialized();

    const fullEntry: MemoryEntry = {
      ...entry,
      id: randomUUID(),
      createdAt: Date.now(),
    };

    await this.table!.add([fullEntry]);
    return fullEntry;
  }

  async storeMany(entries: Omit<MemoryEntry, 'id' | 'createdAt'>[]): Promise<MemoryEntry[]> {
    await this.ensureInitialized();

    const fullEntries: MemoryEntry[] = entries.map((entry) => ({
      ...entry,
      id: randomUUID(),
      createdAt: Date.now(),
    }));

    await this.table!.add(fullEntries);
    return fullEntries;
  }

  async search(
    vector: number[],
    options: {
      limit?: number;
      minScore?: number;
      projectId?: string;
      category?: MemoryCategory;
      status?: MemoryStatus;
    } = {},
  ): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    const { limit = 5, minScore = 0.5, projectId, category, status } = options;

    let query = this.table!.vectorSearch(vector);

    if (projectId) {
      query = query.where(`projectId = '${projectId}'`);
    }
    if (category) {
      query = query.where(`category = '${category}'`);
    }
    if (status) {
      query = query.where(`status = '${status}'`);
    }

    const results = await query.limit(limit).toArray();

    const mapped = results.map((row) => {
      const distance = row._distance ?? 0;
      const score = 1 / (1 + distance);
      return {
        entry: {
          id: row.id as string,
          text: row.text as string,
          vector: row.vector as number[],
          importance: row.importance as number,
          category: row.category as MemoryEntry['category'],
          createdAt: row.createdAt as number,
          source: row.source as FeishuSourceType,
          sourceId: row.sourceId as string,
          url: row.url as string,
          projectId: row.projectId as string | undefined,
          lastAccessedAt: row.lastAccessedAt as number | undefined,
          status: row.status as MemoryStatus | undefined,
        },
        score,
      };
    });

    return mapped.filter((r) => r.score >= minScore);
  }

  async searchByText(
    text: string,
    options: {
      limit?: number;
      minScore?: number;
      projectId?: string;
      category?: MemoryCategory;
      status?: MemoryStatus;
    } = {},
  ): Promise<MemorySearchResult[]> {
    const vector = await this.getEmbeddings().embed(text);
    return this.search(vector, options);
  }

  async update(id: string, updates: Partial<MemoryEntry>): Promise<boolean> {
    await this.ensureInitialized();

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }

    // 获取现有记录
    const existing = await this.getById(id);
    if (!existing) {
      return false;
    }

    // 合并更新
    const updated: MemoryEntry = {
      ...existing,
      ...updates,
      id, // 保证 ID 不变
      createdAt: existing.createdAt, // 创建时间不变
    };

    // 删除旧记录，插入新记录
    await this.table!.delete(`id = '${id}'`);
    await this.table!.add([updated]);

    return true;
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureInitialized();

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }

    await this.table!.delete(`id = '${id}'`);
    return true;
  }

  async getById(id: string): Promise<MemoryEntry | null> {
    await this.ensureInitialized();

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }

    const results = await this.table!.query().where(`id = '${id}'`).toArray();
    if (results.length === 0) {
      return null;
    }

    const row = results[0];
    return {
      id: row.id as string,
      text: row.text as string,
      vector: row.vector as number[],
      importance: row.importance as number,
      category: row.category as MemoryEntry['category'],
      createdAt: row.createdAt as number,
      source: row.source as FeishuSourceType,
      sourceId: row.sourceId as string,
      url: row.url as string,
      projectId: row.projectId as string | undefined,
      lastAccessedAt: row.lastAccessedAt as number | undefined,
      status: row.status as MemoryStatus | undefined,
    };
  }

  async count(): Promise<number> {
    await this.ensureInitialized();
    return this.table!.countRows();
  }

  /**
   * 查询所有记忆（支持分页和状态过滤）
   */
  async queryAll(options: {
    status?: MemoryStatus;
    limit?: number;
    offset?: number;
  } = {}): Promise<MemoryEntry[]> {
    await this.ensureInitialized();

    const { status, limit = 1000, offset = 0 } = options;

    let query = this.table!.query();
    if (status) {
      query = query.where(`status = '${status}'`);
    }

    const results = await query.limit(limit).offset(offset).toArray();

    return results.map((row) => ({
      id: row.id as string,
      text: row.text as string,
      vector: row.vector as number[],
      importance: row.importance as number,
      category: row.category as MemoryEntry['category'],
      createdAt: row.createdAt as number,
      source: row.source as FeishuSourceType,
      sourceId: row.sourceId as string,
      url: row.url as string,
      projectId: row.projectId as string | undefined,
      lastAccessedAt: row.lastAccessedAt as number | undefined,
      status: row.status as MemoryStatus | undefined,
    }));
  }

  // ========================================================================
  // Project Operations
  // ========================================================================

  async getProjects(): Promise<ProjectEntry[]> {
    const results = await this.searchByText('', {
      limit: 100,
      category: 'project',
      status: 'active',
    });

    return results.map((r) => ({
      id: r.entry.id,
      name: r.entry.text,
      description: r.entry.projectId || '',
      status: r.entry.status || 'active',
      createdAt: r.entry.createdAt,
      lastActivityAt: r.entry.lastAccessedAt || r.entry.createdAt,
    }));
  }

  async getProjectById(projectId: string): Promise<ProjectEntry | null> {
    const entry = await this.getById(projectId);
    if (!entry || entry.category !== 'project') {
      return null;
    }

    return {
      id: entry.id,
      name: entry.text,
      description: entry.projectId || '',
      status: entry.status || 'active',
      createdAt: entry.createdAt,
      lastActivityAt: entry.lastAccessedAt || entry.createdAt,
    };
  }

  async updateProjectLastActivity(projectId: string): Promise<void> {
    await this.ensureInitialized();

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(projectId)) {
      throw new Error(`Invalid project ID format: ${projectId}`);
    }

    // Note: LanceDB doesn't support direct updates
    // In production, consider using merge mode or batch operations
    await this.table!.add([
      {
        id: projectId,
        text: '',
        vector: [],
        importance: 0,
        category: 'project',
        createdAt: 0,
        source: 'feishu_chat' as FeishuSourceType,
        sourceId: '',
        url: '',
        projectId: null,
        lastAccessedAt: Date.now(),
        status: 'active',
      },
    ]);
  }

  // ========================================================================
  // Stats
  // ========================================================================

  async getStats(): Promise<{
    total: number;
    byCategory: Record<string, number>;
    byProject: Record<string, number>;
    archived: number;
  }> {
    await this.ensureInitialized();

    const total = await this.count();

    // Get all entries (limit to 1000 for stats)
    const all = await this.table!.query().limit(1000).toArray();

    const byCategory: Record<string, number> = {};
    const byProject: Record<string, number> = {};
    let archived = 0;

    for (const row of all) {
      const cat = row.category as string;
      byCategory[cat] = (byCategory[cat] || 0) + 1;

      if (row.projectId) {
        byProject[row.projectId as string] = (byProject[row.projectId as string] || 0) + 1;
      }

      if (row.status === 'archived') {
        archived++;
      }
    }

    return { total, byCategory, byProject, archived };
  }

  // ========================================================================
  // Embedding
  // ========================================================================

  async embed(text: string): Promise<number[]> {
    return this.getEmbeddings().embed(text);
  }
}
