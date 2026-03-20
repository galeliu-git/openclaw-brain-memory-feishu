# 飞书驱动的 OpenClaw 工作记忆插件

## 一、产品定位

**目标**：让AI真正理解用户的工作上下文，知道用户做什么项目、处于什么阶段、做过什么决定。

**核心价值**：
- 主动采集飞书数据，构建结构化工作记忆
- 按项目上下文注入记忆，而非无差别注入
- 支持工作日报等衍生功能

**差异化**：
- 主动采集 vs 被动等待（不等用户说"记住"才记忆）
- 项目维度隔离 vs 混在一起
- 生命周期管理 vs 只增不减

---

## 二、用户使用流程

```
┌─────────────────────────────────────────────────────────────┐
│  用户安装 brain-memory 插件                                   │
└────────────────────────┬────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  1. 初始扫描（一次性）                                        │
│     - 配置飞书权限                                           │
│     - 选择扫描范围：群聊/文档/会议/任务                         │
│     - 扫描历史数据 → 生成初始记忆                              │
└────────────────────────┬────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  2. 记忆生成                                                 │
│     - LLM分析内容 → 分类（project/task/decision...）          │
│     - 识别项目归属                                           │
│     - 评估重要性                                             │
└────────────────────────┬────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  3. 定时增量同步（每日）                                      │
│     - 自动扫描新增信息                                        │
│     - 增量更新记忆                                           │
│     - 归档过期记忆                                           │
└────────────────────────┬────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  4. 对话/任务时注入                                          │
│     - 识别当前项目上下文                                      │
│     - 注入相关记忆                                           │
└─────────────────────────────────────────────────────────────┘
```

### 工作日报场景

日报读取的是 memory 库（不是原始飞书数据），通过 memory 中的记录还原当日工作进展。

```
触发方式：
A. 用户对话触发："帮我生成今天的日报"
B. 定时任务触发：用户配置 cron 任务，每天 18:00 执行

         ↓
┌─────────────────────────────────────────────────────────────┐
│  1. 查询当日记忆                                              │
│     - 查询 date 范围内的 memory（按项目分组）                    │
│     - 读取各项目的最新进展                                      │
└────────────────────────┬────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│  2. 项目进展提炼                                              │
│     对每个项目，LLM提取：                                      │
│     - 今日完成                                                │
│     - 进行中                                                  │
│     - 问题/阻塞                                               │
└────────────────────────┬────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│  3. 生成日报                                                  │
│     【OpenClaw Brain Memory】                                  │
│     ✅ 完成：设计MemoryExtractionEngine架构                    │
│        [架构设计文档](https://xxx.feishu.cn/docx/xxx)          │
│     🔄 进行中：实现LLM分类逻辑                                 │
│        [会议纪要](https://xxx.feishu.cn/meeting/xxx)          │
│                                                               │
│     【支付系统重构】                                           │
│     ✅ 完成：数据库迁移方案评审                                 │
│     🔄 进行中：对接第三方支付API                               │
│     ⚠️ 阻塞：等待客户确认文档                                  │
│        [需求文档](https://xxx.feishu.cn/docx/xxx)             │
└─────────────────────────────────────────────────────────────┘
```

---

## 三、系统架构

### 3.1 插件目录结构

```
extensions/brain-memory/
├── src/
│   ├── index.ts                    # 插件入口（工具、CLI、钩子注册）
│   │
│   ├── config/
│   │   ├── types.ts               # 配置类型
│   │   └── schema.ts              # 配置Schema
│   │
│   ├── core/
│   │   ├── MemoryExtractionEngine.ts  # LLM批量提取引擎（核心）
│   │   ├── FeishuDataCollector.ts     # 数据采集入口
│   │   ├── BatchProcessor.ts          # 批次处理器（分组+攒批）
│   │   ├── LifecycleManager.ts        # 生命周期管理
│   │   ├── ReportGenerator.ts         # 日报生成
│   │   ├── SyncManager.ts            # 同步管理器
│   │   └── adapters/
│   │       ├── FeishuHttpAdapter.ts  # 飞书HTTP适配器（封装ctx.http）
│   │       └── LLMAdapter.ts          # LLM适配器（封装ctx.llm）
│   │
│   ├── memory/
│   │   └── store.ts                # LanceDB存储封装（支持ctx.embedding）
│   │
│   ├── types.ts                    # 共享类型定义
│   └── types/
│       └── stubs.d.ts              # 类型声明（plugin-sdk, lancedb）
│
├── dist/                           # 编译输出
│   └── index.js                    # 插件入口（供openclaw加载）
├── package.json
└── openclaw.plugin.json
```

> **注**：工具直接在 `index.ts` 中注册；PendingBatches 缓存在 `BatchProcessor.ts` 内部以 module-level Map 存储；项目管理功能合并到 `MemoryExtractionEngine` 中。

### 3.1 OpenClaw 上下文复用

本插件**最大化复用 OpenClaw 的基础设施**，不重复配置飞书凭证和 LLM：

| 功能 | 设计文档旧版 | 实现版 |
|------|------------|--------|
| 飞书API | 直接使用 @larksuiteoapi/node-sdk | 封装 `ctx.http`（FeishuHttpAdapter） |
| LLM调用 | 直接使用 openai SDK | 封装 `ctx.llm`（LLMAdapter） |
| Embedding | 复用 memory-lancedb | 封装 `ctx.embedding`（BrainMemoryStore） |

**适配器模式**：
- `FeishuHttpAdapter` - 封装 ctx.http，优先使用 `ctx.feishu.token`
- `LLMAdapter` - 封装 ctx.llm，提供统一接口
- `BrainMemoryStore` - 支持 ctx.embedding 优先，回退到配置

### 3.2 数据流

```
飞书数据采集（定时轮询）
────────────────────────────────────────

FeishuDataCollector
    ├── ChatCollector ───┐
    ├── DocCollector ────├──→ NormalizedEvent[]
    ├── MeetingCollector ┤
    └── TaskCollector ───┘
              ↓
按 groupKey 分组
              ↓
PendingBatches（module-level Map in BatchProcessor）
    ├── group_群A     → messages: [...]
    ├── p2p_私聊ID    → messages: [...]
    ├── doc_docId1    → messages: [...]
    ├── meeting_xxx   → messages: [...]
    └── task_taskId   → messages: [...]
              ↓
5小时窗口触发（用户可配置）
              ↓
MemoryExtractionEngine
    ├── 查询已有项目列表
    ├── 按组调用LLM批量提取
    │   └── 返回数组（可能更新多个项目）
    └── 写入BrainMemoryStore (LanceDB)
              ↓
BrainMemoryStore (LanceDB)


对话注入流程
────────────────────────────────────────

用户消息
    ↓
LifecycleManager.getMemoriesForInjection()
    ├── 查询活跃记忆
    └── 格式化为上下文文本
              ↓
注入到 before_agent_start 钩子
```

---

## 四、核心模块设计

### 4.1 BatchProcessor（批次处理器）

**职责**：将飞书数据按来源分组、攒批，等待触发处理。

**分组策略**：
```typescript
interface PendingBatch {
  groupKey: string;        // `${sourceType}_${sourceId}`
  sourceType: 'chat' | 'doc' | 'meeting' | 'task';
  sourceId: string;
  sourceName: string;
  messages: NormalizedEvent[];
  firstMessageTime: number;  // 第一条消息时间
  lastMessageTime: number;   // 最后一条消息时间
}
```

**分组逻辑**：
- 同一群聊的消息 → `group_{chatId}`
- 同一私聊的消息 → `p2p_{chatId}`
- 同一文档的更新 → `doc_{docId}`
- 同一会议的内容 → `meeting_{meetingId}`
- 同一任务的变更 → `task_{taskId}`

**注**：PendingBatches 缓存在 `BatchProcessor.ts` 内部以 module-level Map 存储，非独立文件。

**攒批触发条件**：
- 固定窗口：5小时（用户可配置）
- 新消息到达时，重置该批次的计时器

**处理流程**：
```
定时器触发（默认5小时）
    ↓
遍历所有 PendingBatch
    ↓
if (now - lastMessageTime) >= 窗口时间 AND messages 非空
    → 触发 MemoryExtractionEngine 处理
    → 清空 messages（保留批次本身）
```

### 4.2 MemoryExtractionEngine（核心）

**职责**：批量判断一批消息是否值得记忆，并进行结构化提取。

**LLM 调用**：
```
MemoryExtractionEngine
    └── LLMAdapter   # 封装 ctx.llm
           └── ctx.llm   # OpenClaw 的 LLM 客户端
```

**处理流程**：
```
飞书消息
    ↓
按来源分组（每个 chatId/docId/meetingId/taskId 一个分组）
    ↓
每组调用 LLM（带上 currentUserId，Prompt 里标注 [USER]）
    ↓
LLM 输出：
├── link_to_project → 关联已有项目 + 提取 memories
├── create_new → 创建新项目（以用户消息为准）
└── discard → 丢弃整批
```

**输入**：
```typescript
interface BatchExtractionRequest {
  messages: NormalizedEvent[];    // 同一批次的飞书消息
  sourceType: 'chat' | 'doc' | 'meeting' | 'task';
  sourceName: string;
  currentUserId: string;          // 当前用户 ID，用于标记用户消息
  existingProjects: ProjectEntry[];  // 已有项目列表（从 memory 库读取）
}
```

**输出**：
```typescript
interface ExtractionDecision {
  action: 'link_to_project' | 'create_new' | 'discard';
  targetProjectId?: string;      // action=link_to_project 时
  targetProjectName?: string;
  newProject?: {
    name: string;
    description: string;
  };
  userMessageIndices: number[];    // 用户消息索引（用于创建/更新项目）
  otherMessageIndices: number[];  // 其他人消息索引（用于推进项目）
  memories: {
    text: string;
    category: MemoryCategory;
    importance: number;
    summary: string;
  }[];
  reasoning: string;
}

type BatchExtractionResult = ExtractionDecision[];
```

**消息来源标记**：
```typescript
// NormalizedEvent 增加 userId 字段
interface NormalizedEvent {
  id: string;
  type: 'chat' | 'doc' | 'meeting' | 'task';
  content: string;
  sourceId: string;
  url: string;
  userId: string;              // 发送者 ID，用于标记用户消息
  userName?: string;
  timestamp: number;
  chatId?: string;
  chatName?: string;
  mentionedUserIds?: string[]; // @了哪些人
  metadata?: Record<string, unknown>;
}
```

### 群聊 Prompt

```
你是一个信息分类专家。判断一群聊消息是否与用户的工作相关。

来源信息：
- 渠道类型：chat
- 群聊名称：{chatName}

已有项目：
{已有项目列表（从 memory 中读取）}

消息列表（标注了发送者，消息末尾标记了 [USER] 如果是用户自己发的）：
{消息内容，每条包含时间、发送者、内容，如果是用户发的则末尾标注 [USER]}

判断规则：
1. 用户发的消息（[USER]）是创建新项目的依据
2. 其他人的消息用于判断项目进展
3. 如果整批消息与用户无关或无价值，返回 discard

输出JSON（数组）：
[
  {
    "action": "link_to_project",
    "targetProjectId": "已有项目ID",
    "targetProjectName": "项目名",
    "userMessageIndices": [0, 3],       // 用户消息索引
    "otherMessageIndices": [1, 2, 4],    // 其他人消息索引
    "memories": [
      {
        "text": "团队决定采用结构化memory方案",
        "category": "decision",
        "importance": 0.85,
        "summary": "结构化memory方案决策"
      }
    ],
    "reasoning": "为什么关联到该项目"
  },
  {
    "action": "create_new",
    "newProject": {
      "name": "OpenClaw 记忆插件",
      "description": "开发飞书驱动的工作记忆插件"
    },
    "userMessageIndices": [5],           // 用户发起了新话题
    "otherMessageIndices": [6, 7, 8],    // 其他人在讨论这个新话题
    "memories": [
      {
        "text": "用户发起讨论 OpenClaw 记忆插件",
        "category": "event",
        "importance": 0.8,
        "summary": "用户发起新项目讨论"
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
]
```

### 文档 Prompt

```
你是一个信息分类专家。从一篇飞书文档中提取工作记忆。

来源信息：
- 文档标题：{title}
- 文档链接：{url}

已有项目：
{已有项目列表}

文档内容：
{文档正文}

重要规则：
- 文档不能创建新项目，只能关联到已有项目或丢弃

输出JSON（数组）：
[
  {
    "action": "link_to_project",
    "targetProjectId": "已有项目ID",
    "memories": [
      {
        "text": "...",
        "category": "knowledge",
        "importance": 0.85,
        "summary": "..."
      }
    ]
  },
  {
    "action": "discard",
    "reasoning": "文档内容与用户工作无关"
  }
]
```

### 会议纪要 Prompt

```
你是一个信息分类专家。从一篇会议纪要中提取工作记忆。

来源信息：
- 会议主题：{title}
- 会议链接：{url}

当前用户：{userName}

已有项目：
{已有项目列表}

会议内容：
{会议纪要正文}

重要规则：
- 如果用户（{userName}）没有在会议中发言，也没有被@，只能关联到已有项目或丢弃
- 只有用户发言了或被@了，才能创建新项目

输出JSON（数组）：
[
  {
    "action": "link_to_project",
    "targetProjectId": "已有项目ID",
    "memories": [...]
  },
  {
    "action": "create_new",
    "newProject": {...},
    "memories": [...]
  },
  {
    "action": "discard",
    "reasoning": "无用户参与的讨论，无新项目创建"
  }
]
```

**各类型处理差异**：

| 类型 | 用户消息标注 | 可 create_new | 备注 |
|------|------------|--------------|------|
| 群聊 | ✅ [USER] | ✅ 可以 | 用户发起新话题可创建 |
| 文档 | ❌ 无 | ❌ 不能 | 只能关联已有项目或丢弃 |
| 会议纪要 | ❌ 无 | ✅ 可以（需用户参与） | 只有用户发言了或被@了才能创建 |

**已有项目列表获取**：
```typescript
// 从 memory 库读取所有 category=project 的 memory
async function getExistingProjects(): Promise<ProjectEntry[]> {
  const projectMemories = await store.searchByText('', {
    category: 'project',
    status: 'active',
    limit: 100,
  });
  return projectMemories.map(m => ({
    id: m.entry.id,
    name: m.entry.text,
    description: m.entry.projectId || ''
  }));
}
```

**重要性阈值**：
- 0.3 以下不存储（action=discard）
- 0.3-0.5：一般信息
- 0.5-0.7：重要信息
- 0.7-1.0：关键信息

### 4.3 项目管理（合并到 MemoryExtractionEngine）

**职责**：项目的创建、识别功能已合并到 `MemoryExtractionEngine` 中。

**ProjectEntry 结构**：
```typescript
interface ProjectEntry {
  id: string;
  name: string;              // LLM 命名，如 "OpenClaw Brain Memory"
  description: string;        // 项目一句话描述
  status: 'active' | 'archived';
  createdAt: number;
  lastActivityAt: number;
}
```

**项目来源**：
- LLM 判断消息需要创建新项目时，生成 ProjectEntry（作为 `category='project'` 的 memory）
- 项目列表从 `BrainMemoryStore.getProjects()` 动态读取

### 4.4 FeishuDataCollector

**内部架构**：
```
FeishuDataCollector
    └── FeishuHttpAdapter   # 封装 ctx.http + ctx.feishu.token
           └── ctx.http      # OpenClaw 的 HTTP 客户端
```

**FeishuHttpAdapter 令牌优先级**：
1. `ctx.feishu.token`（OpenClaw 飞书插件共享 token）
2. 配置的 `feishu.appId` + `feishu.appSecret`

**数据采集范围**：

| 数据源 | 采集内容 | API | 链接格式 |
|--------|---------|-----|---------|
| 群聊 | 消息内容、发送者、时间 | `chat().messages().list()` | `https://[tenant].feishu.cn/message/[chatId]/[messageId]` |
| 私聊 | 消息内容 | 同上 | 同上 |
| 文档 | 文档标题、段落内容 | `docx().document.get()` | `https://[tenant].feishu.cn/docx/[docId]` |
| 会议 | 会议纪要、参与人 | `meeting()` | `https://[tenant].feishu.cn/meeting/[meetingId]` |
| 任务 | 任务标题、状态、截止日期 | `task()` | `https://[tenant].feishu.cn/task/[taskId]` |

**统一数据格式**：
```typescript
interface NormalizedEvent {
  id: string;              // 唯一标识，格式：feishu_{type}_{原始ID}
  type: 'chat' | 'doc' | 'meeting' | 'task';
  content: string;        // 提取的文本内容
  sourceId: string;       // 飞书原始ID（用于去重）
  url: string;            // 飞书原始链接
  userId: string;         // 发送者 ID（用于标记用户消息）
  userName?: string;
  timestamp: number;
  chatId?: string;        // 来源群聊
  chatName?: string;
  mentionedUserIds?: string[];  // @了哪些人（用于规则过滤）
  metadata?: Record<string, unknown>;
}
```

**增量采集策略**：
- 记录上次同步时间戳
- 通过 `sourceId` 去重

> **注意**：`collectSince()` 目前调用 `collectAll()` 返回全量数据，真正的增量采集逻辑待实现。

### 4.5 LifecycleManager

**记忆分层**：

| 层级 | 定义 | 行为 |
|------|------|------|
| recent | 最近7天 | 优先检索，默认注入 |
| active | 7-30天 | 正常检索，按需注入 |
| archived | 30天以上 | 不自动注入，只在明确查询历史时召回 |

**归档规则**：
```typescript
interface ArchiveRule {
  inactiveDays: number;    // 30天无访问
  minImportance: number;  // 低于此重要性的也归档
}

// 归档判断
if (now - lastAccessedAt > 30days && importance < 0.3) {
  archive(memory);
}
```

**归档后处理**：
- 保留在数据库，status 改为 archived
- 不参与向量检索
- 只在用户明确查询"历史记忆"时召回

> **注意**：归档功能尚未完全实现。`archiveOldMemories()` 方法体为 TODO 状态，LanceDB 不支持直接条件更新，需要用删除+重插入的方式实现。

### 4.6 ReportGenerator

**输入**：
```typescript
interface ReportRequest {
  date: Date;              // 哪天的日报
  projectIds?: string[];    // 指定项目，默认全部
}
```

**输出**：
```typescript
interface DailyReport {
  date: Date;
  sections: ProjectSection[];
  summary: string;         // 总体摘要
  generatedAt: Date;
}

interface ProjectSection {
  project: string;
  progress: string[];      // 今日完成
  ongoing: string[];       // 进行中
  blockers: string[];      // 阻塞点
}
```

---

## 五、数据模型

### 5.1 Memory存储

**独立管理 LanceDB**，数据库路径 `~/.openclaw/memory/brain-memory`：

```typescript
interface MemoryEntry {
  id: string;                    // UUID
  text: string;                  // 记忆文本
  vector: number[];              // 向量嵌入
  importance: number;            // 重要性 0-1
  category: MemoryCategory;     // 分类
  createdAt: number;             // 创建时间

  // 飞书扩展字段
  source: 'feishu_chat' | 'feishu_doc' | 'feishu_meeting' | 'feishu_task';
  sourceId: string;              // 飞书原始ID（去重）
  url: string;                   // 飞书原始链接
  projectId?: string;            // 项目ID
  lastAccessedAt?: number;        // 最后访问时间
  status?: 'active' | 'archived';
}
```

> 注：项目信息不再使用 keywords 字段，项目识别完全依赖 LLM 判断。

**Embedding 配置优先级**：
1. 优先使用 `ctx.embedding`（OpenClaw 配置的 embedding 服务）
2. 回退到插件配置的 `embedding.apiKey/baseUrl/model`

### 5.2 LanceDB索引

```typescript
// 复用memory-lancedb的embedding服务
// 新增索引
{
  name: 'source',
  type: 'btree'
},
{
  name: 'projectId',
  type: 'btree'
},
{
  name: 'status',
  type: 'btree'
}
```

---

## 六、用户配置

### 6.1 配置项

```typescript
interface BrainMemoryConfig {
  // 飞书凭证（可选，优先使用 OpenClaw 共享的 ctx.feishu.token）
  feishu?: {
    appId: string;
    appSecret: string;
  };

  // Embedding 配置（可选，优先使用 ctx.embedding）
  embedding?: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
    dimensions?: number;
  };

  // 数据源开关
  sources: {
    chats: boolean;        // 群聊/私聊
    docs: boolean;         // 文档
    meetings: boolean;     // 会议
    tasks: boolean;        // 任务
  };

  // 扫描配置
  scan: {
    schedule: string;      // cron表达式，默认 "0 2 * * *"
    initialRange: '30d' | '90d' | 'all';  // 初始扫描范围
    batchWindowHours: number;  // 批次窗口小时数，默认5小时
  };

  // 记忆配置
  memory: {
    importanceThreshold: number;  // 默认0.3
    archiveAfterDays: number;     // 默认30天
    maxPerDay: number;             // 每日最大记忆条数，默认100
  };

  // 日报配置
  report: {
    autoGenerate: boolean;       // 定时生成
    time: string;                // 发送时间，默认 "18:00"
    channel: 'feishu' | 'display'; // 发送渠道
  };
}
```

### 6.2 默认配置

```typescript
const DEFAULT_CONFIG: BrainMemoryConfig = {
  sources: {
    chats: true,
    docs: true,
    meetings: true,
    tasks: true,
  },
  scan: {
    schedule: '0 2 * * *',    // 每天凌晨2:00
    initialRange: '30d',
    batchWindowHours: 5,      // 5小时批次窗口
  },
  memory: {
    importanceThreshold: 0.3,
    archiveAfterDays: 30,
    maxPerDay: 100,
  },
  report: {
    autoGenerate: false,
    time: '18:00',
    channel: 'display',
  },
};
```

---

## 七、工具设计

### 工具注册模式

根据 SDK 指南，工具使用以下模式注册：

```typescript
api.registerTool({
  name: "tool_name",
  description: "工具描述",
  parameters: Type.Object({...}),
  execute: async ({ args, context }) => {
    // args - 工具参数对象
    // context - 执行上下文
    return {
      type: "text" | "json",
      content: "返回内容"
    };
  },
});
```

> **注意**：`execute` 参数是 `{ args, context }` 解构形式，不是 `(toolCallId, params)`。

### 7.1 feishu_scan

扫描飞书数据源，构建工作记忆。

```
参数：
- sources?: string[]    // ['chat', 'doc', 'meeting', 'task']，默认全部
- range?: { start: string, end: string }  // 扫描日期范围

execute 返回：
{
  type: "text",
  content: "扫描完成！采集到 X 条数据，处理了 Y 个批次，生成 Z 条记忆。"
}
```

### 7.2 memory_query

查询工作记忆。

```
参数：
- query?: string        // 搜索文本
- project?: string      // 项目过滤
- category?: string     // 类别过滤：project/task/decision/knowledge/profile/event
- limit?: number        // 返回数量，默认10

execute 返回：
{
  type: "text",
  content: "找到 N 条记忆:\n1. [category] text (score%)\n..."
}
```

### 7.3 generate_daily_report

生成工作日报。

```
参数：
- date?: string         // 日期，默认今天，格式：YYYY-MM-DD
- projectIds?: string[]  // 项目ID列表

execute 返回：
{
  type: "text",
  content: "Markdown 格式的日报"
}
```

### 7.4 memory_stats

查看记忆统计。

```
execute 返回：
{
  type: "text",
  content: "总记忆数: X\n按类别分布:\n  - project: Y\n..."
}
```

### 7.5 project_list

查看已识别的项目列表。

```
execute 返回：
{
  type: "text",
  content: "项目列表:\n1. 项目名 (status) - 最后活动: 日期"
}
```

### 7.6 project_rename

重命名项目（修正LLM识别不准确的项目名）。

```
参数：
- projectId: string      // 项目ID（必填）
- newName: string        // 新名称（必填）

execute 返回：
{
  type: "text",
  content: "项目已重命名为: {newName}"
}
```

---

## 八、与现有系统的兼容

### 8.1 数据存储

- **独立数据库**：`~/.openclaw/memory/brain-memory`（LanceDB）
- Embedding 服务优先复用 OpenClaw 的 `ctx.embedding`
- 与 memory-lancedb 的数据库**隔离**，避免互相干扰

### 8.2 上下文注入

在 `before_agent_start` 钩子中注入：

```typescript
api.on('before_agent_start', async (event) => {
  // 获取需要注入的记忆（top 5 by relevance）
  const memories = await lifecycleManager.getMemoriesForInjection(5);

  if (!memories) {
    return;
  }

  return {
    prependContext: memories,
  };
});
```

> **注**：当前实现不识别当前项目上下文，直接返回 top 5 活跃记忆。

### 8.3 MEMORY.md兼容

生成与OpenClaw原生格式兼容的MEMORY.md：

```markdown
# Active Projects
- OpenClaw Brain Memory: active
- 支付系统重构: active

# Recent Decisions
- 决定采用结构化memory设计
- 决定使用LLM进行内容提取

# User Context
当前项目：OpenClaw Brain Memory
最近任务：完成MemoryExtractionEngine设计
```

---

## 九、用户可配置选项

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 扫描范围 | 30天 | 初始扫描的历史范围 |
| 同步时间 | 每天2:00 | 定时增量同步 |
| 批次窗口 | 5小时 | 飞书消息攒批处理的时间窗口 |
| 重要性阈值 | 0.3 | 低于此值不存储 |
| 归档周期 | 30天 | 无访问后归档 |
| 日报触发方式 | 对话/定时任务 | 用户对话触发或配置定时任务 |
| 日报推送时间 | 18:00 | 下班前 |
| 日报推送渠道 | display | 仅在助手对话中显示 |

---

## 十、实现优先级

```
Phase 1: 基础框架（Week 1-2）
├── 插件骨架搭建
├── 配置系统
├── LanceDB存储封装
└── 基础CRUD

Phase 2: 数据采集（Week 2-3）
├── 飞书SDK集成
├── 群聊/文档采集
├── 会议/任务采集
└── 数据归一化

Phase 3: 核心引擎（Week 3-4）
├── MemoryExtractionEngine
│   ├── 分类器
│   ├── 重要性评估
│   └── 项目识别
├── 向量化处理
└── 去重逻辑

Phase 4: 生命周期（Week 4-5）
├── 归档管理
├── 上下文注入
└── MEMORY.md生成

Phase 5: 日报功能（Week 5-6）
├── 日报生成器
├── 定时任务
└── 飞书通知（可选）
```

---

## 十一、关键设计决策

### 决策1：OpenClaw 上下文复用

**选项A**：插件自己管理所有凭证
- 优点：完全独立
- 缺点：用户需要配置两份（OpenClaw + 插件）

**选项B**：最大化复用 OpenClaw 的 ctx
- 优点：用户只需配置一次
- 缺点：依赖 OpenClaw 实现

**选择**：选项B
- 飞书 API：通过 `ctx.http` + `ctx.feishu.token`
- LLM：通过 `ctx.llm`
- Embedding：通过 `ctx.embedding`

### 决策2：存储方案

**选项A**：新建独立数据库
- 优点：完全可控
- 缺点：与memory-lancedb不兼容，用户需要管理两份数据

**选项B**：复用memory-lancedb
- 优点：用户只需一份数据，embedding复用
- 缺点：需要扩展schema

**选择**：选项B，复用memory-lancedb的LanceDB实例

### 决策2：存储方案

**选项A**：新建独立数据库
- 优点：完全可控
- 缺点：与memory-lancedb不兼容，用户需要管理两份数据

**选项B**：复用memory-lancedb
- 优点：用户只需一份数据，embedding复用
- 缺点：需要扩展schema

**选择**：选项B，独立管理 LanceDB，但共享 ctx.embedding

### 决策3：项目识别

**选项A**：飞书群组映射
- 优点：简单准确
- 缺点：需要用户手动配置

**选项B**：LLM自动识别
- 优点：开箱即用
- 缺点：可能有误差

**选择**：选项B + 手动映射兜底，用户可配置群组→项目映射表

### 决策4：提取策略

**选择**：批量LLM提取，按(来源类型,来源ID)分组攒批，5小时窗口触发

**设计要点**：
- 同一群聊/文档/会议的消息一起交给 LLM
- LLM 标注哪些是用户发的（[USER]），哪些是其他人发的
- 用户发的消息作为创建新项目的依据
- 其他人的消息用于推进项目进展

### 决策5：项目识别策略

**选择**：LLM自动识别，项目列表从 memory 库动态获取

**设计要点**：
- 不使用关键词匹配（聊天消息碎片化，关键词意义不大）
- 已有项目列表从 memory 库读取（所有 `category=project` 的 memory）
- LLM 判断消息属于哪个已有项目，或需要创建新项目

### 决策6：LanceDB 依赖

**选择**：`@lancedb/lancedb` 作为直接依赖

**风险**：包含 native 模块（lancedb-linux-x64-gnu），需要在目标机器编译

**注意事项**：
- 插件部署时需要 `npm install`
- 不能使用纯 URL 的 CDN 加载方式

---

## 十二、风险与挑战

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| LLM调用成本 | 高频调用费用高 | 重要性阈值过滤 + 每日条数限制 |
| 项目识别不准 | 记忆混乱 | 手动映射兜底 + 用户可修正 |
| 飞书API限制 | 频率限制 | 增量采集 + 请求间隔 |
| 隐私问题 | 用户顾虑 | 数据本地存储 + 明确告知 |
| 向量检索质量 | 检索不准确 | 向量相似度阈值 + 多维度过滤 |
