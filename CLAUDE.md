# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the **brain-memory** plugin for OpenClaw - a Feishu-driven working memory plugin that automatically collects Feishu data (chats, docs, meetings, tasks) and uses LLM to build structured working memories organized by project context.

**Plugin Directory**: `extensions/brain-memory/`
**Installed Location**: `/home/gale/.openclaw/extensions/brain-memory`

## Architecture

```
FeishuDataCollector ──► BatchProcessor ──► MemoryExtractionEngine ──► BrainMemoryStore (LanceDB)
     │                        │                       │
     │                        │                       ├── Groups messages by (sourceType, sourceId)
     │                        │                       ├── 5-hour batch window before processing
     │                        │                       └── LLM determines: link_to_project / create_new / discard
     │                        │
     └── Collects from: ──────└── chat, doc, meeting, task
        - ctx.http (OpenClaw)
        - ctx.llm (OpenClaw)
        - ctx.embedding (OpenClaw)
```

### OpenClaw Context Reuse

This plugin **maximizes reuse of OpenClaw's infrastructure**:

| Component | Reuses | Adapter |
|-----------|--------|---------|
| Feishu API | `ctx.http` + `ctx.feishu.token` | `FeishuHttpAdapter` |
| LLM | `ctx.llm` | `LLMAdapter` |
| Embedding | `ctx.embedding` | `BrainMemoryStore` |

### Data Flow

**Collection Phase:**
1. `FeishuDataCollector.collectAll()` gathers data from enabled sources (chats, docs, meetings, tasks)
2. Each `NormalizedEvent` is added to `BatchProcessor.addMessage()`
3. Events are grouped by `groupKey` into `PendingBatch` entries (in-memory cache)

**Batch Grouping Keys:**
- Group chats: `group_{chatId}`
- Private chats: `p2p_{chatId}`
- Documents: `doc_{docId}`
- Meetings: `meeting_{meetingId}`
- Tasks: `task_{taskId}`

**Processing Phase:**
- Every sync interval (default 5 min), `SyncManager.sync()` runs
- `BatchProcessor.getReadyBatches()` returns batches where `now - lastMessageTime >= batchWindowHours`
- Each ready batch goes to `MemoryExtractionEngine.processBatch()`

### LLM Extraction Decisions

`MemoryExtractionEngine` uses type-specific prompts. Each batch returns `ExtractionDecision[]`:

| Action | Description | Creates Project |
|--------|-------------|-----------------|
| `link_to_project` | Associate batch with existing project | No |
| `create_new` | User-initiated topic → new project | Yes |
| `discard` | No work-relevant content | No |

**Prompt strategy varies by source type:**
- **Chat**: User messages (`[USER]` tag) are basis for `create_new`; other messages indicate project progress
- **Doc**: Cannot `create_new`; only links to existing projects or discards
- **Meeting**: Can `create_new` only if user participated (spoke or was @mentioned)
- **Task**: Can `create_new` or `link_to_project`

## Core Modules

| Module | File | Purpose |
|--------|------|---------|
| Plugin Entry | `src/index.ts` | Registers tools, CLI commands, lifecycle hooks |
| FeishuDataCollector | `src/core/FeishuDataCollector.ts` | Collects normalized events from Feishu APIs |
| FeishuHttpAdapter | `src/core/adapters/FeishuHttpAdapter.ts` | Wraps ctx.http + ctx.feishu.token |
| LLMAdapter | `src/core/adapters/LLMAdapter.ts` | Wraps ctx.llm |
| BatchProcessor | `src/core/BatchProcessor.ts` | Batches messages by source, triggers on 5hr window |
| MemoryExtractionEngine | `src/core/MemoryExtractionEngine.ts` | LLM extraction of memories with importance scoring |
| LifecycleManager | `src/core/LifecycleManager.ts` | Memory lifecycle (recent/active/archived), context injection |
| ReportGenerator | `src/core/ReportGenerator.ts` | Generates daily work reports |
| SyncManager | `src/core/SyncManager.ts` | Manages periodic sync scheduling |
| BrainMemoryStore | `src/memory/store.ts` | LanceDB storage wrapper with vector search |

## Development Commands

```bash
# Install dependencies
cd extensions/brain-memory && npm install

# Build TypeScript
npm run build

# Run tests
npm run test:run

# Type check
npm run typecheck
```

## Plugin Installation

The plugin uses a **build-then-copy** workflow:
1. Build: `npm run build` in source directory
2. Copy: Copy entire plugin to `/home/gale/.openclaw/extensions/brain-memory/`
3. Install deps: `npm install` in target directory
4. Enable: `openclaw plugins enable brain-memory`

```bash
# Full deployment workflow
cd extensions/brain-memory
npm install
npm run build
rm -rf ~/.openclaw/extensions/brain-memory/dist
cp -r dist ~/.openclaw/extensions/brain-memory/
cd ~/.openclaw/extensions/brain-memory && npm install
openclaw plugins enable brain-memory
openclaw gateway restart
```

## Plugin Configuration

Config file: `~/.openclaw/openclaw.json`

**Note:** `feishu` and `embedding` configs are optional - plugin prefers OpenClaw's shared context:
- `ctx.feishu.token` for Feishu API
- `ctx.embedding` for embeddings

Key plugin settings in `plugins.entries.brain-memory`:
- `sources.chats/docs/meetings/tasks` - Data source toggles
- `scan.batchWindowHours` - Message batching window (default: 5)
- `memory.importanceThreshold` - Min importance to store (default: 0.3)

## Memory Categories

- `project` - Project definitions
- `task` - Work tasks
- `decision` - Key decisions
- `knowledge` - Technical/info records
- `event` - Events/activities
- `profile` - People profiles

**Source types:** `feishu_chat`, `feishu_doc`, `feishu_meeting`, `feishu_task`

**Memory status:** `active` (default) or `archived` (excluded from auto-injection)

## Tools Registered

- `feishu_scan` - Scan Feishu and build memories
- `memory_query` - Search memories
- `generate_daily_report` - Generate work daily report
- `memory_stats` - View memory statistics
- `project_list` / `project_rename` - Manage projects
- `brain scan/stats/projects/batches/sync/status` - CLI commands

## Lifecycle Hooks

- `before_agent_start` - Injects relevant memories into agent context (top 5 by relevance)
- `registerService` - Starts SyncManager on plugin start

## Key Implementation Details

- `BrainMemoryStore.getProjects()` reads from `category='project'` memories (project list is dynamic, derived from stored memories)
- `BatchProcessor` uses module-level `pendingBatches` Map (not instance state) - batches persist across sync cycles
- LanceDB doesn't support direct updates - `update()` deletes and re-inserts
- `SyncManager` is a singleton via `getSyncManager()` - call `resetSyncManager()` in tests
- `FeishuHttpAdapter` prioritizes `ctx.feishu.token` over configured credentials
- `BrainMemoryStore` prioritizes `ctx.embedding` over configured embedding

## Notes

- Plugin uses ES modules (`"type": "module"`)
- Database: `~/.openclaw/memory/brain-memory` (LanceDB, independent from memory-lancedb)
- Memory entries have `status: 'active' | 'archived'` - archived entries excluded from auto-injection
- **Importance threshold (default 0.3):** Memories with importance below this are discarded during LLM extraction
- **Lifecycle tiers:** `recent` (0-7 days), `active` (7-30 days), `archived` (30+ days)
- **Dependencies:** `@lancedb/lancedb` is a direct dependency (includes native modules)
