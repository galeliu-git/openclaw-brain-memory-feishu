// ============================================================================
// Core Types
// ============================================================================

// Memory categories matching memory-lancedb
export type MemoryCategory =
  | 'project'
  | 'task'
  | 'decision'
  | 'knowledge'
  | 'profile'
  | 'event'
  | 'preference'
  | 'entity'
  | 'fact'
  | 'other';

// Feishu data source type
export type FeishuSourceType = 'feishu_chat' | 'feishu_doc' | 'feishu_meeting' | 'feishu_task';

// Memory status
export type MemoryStatus = 'active' | 'archived';

// Memory entry for LanceDB
export interface MemoryEntry {
  id: string;
  text: string;
  vector: number[];
  importance: number;
  category: MemoryCategory;
  createdAt: number;

  // Feishu extension fields
  source: FeishuSourceType;
  sourceId: string;
  url: string;
  projectId?: string;
  lastAccessedAt?: number;
  status?: MemoryStatus;
}

// Normalized event from Feishu
export interface NormalizedEvent {
  id: string;
  type: 'chat' | 'doc' | 'meeting' | 'task';
  content: string;
  sourceId: string;
  url: string;
  userId: string;
  userName?: string;
  timestamp: number;
  chatId?: string;           // 来源群聊/私聊 ID
  chatName?: string;         // 来源群聊/私聊 名称
  chatType?: 'group' | 'p2p'; // 区分群聊和私聊
  mentionedUserIds?: string[]; // @了哪些人
  metadata?: Record<string, unknown>;
}

// Project entry (derived from project memories)
export interface ProjectEntry {
  id: string;
  name: string;
  description: string;
  status: MemoryStatus;
  createdAt: number;
  lastActivityAt: number;
}

// Pending batch for攒批 processing
export interface PendingBatch {
  groupKey: string;
  sourceType: 'chat' | 'doc' | 'meeting' | 'task';
  sourceId: string;
  sourceName: string;
  messages: NormalizedEvent[];
  firstMessageTime: number;
  lastMessageTime: number;
}

// Extraction action types
export type ExtractionAction = 'link_to_project' | 'create_new' | 'discard';

// Extraction decision from LLM
export interface ExtractionDecision {
  action: ExtractionAction;
  targetProjectId?: string;
  targetProjectName?: string;
  newProject?: {
    name: string;
    description: string;
  };
  userMessageIndices: number[];
  otherMessageIndices: number[];
  memories: {
    text: string;
    category: MemoryCategory;
    importance: number;
    summary: string;
  }[];
  reasoning: string;
}

// Batch extraction result
export type BatchExtractionResult = ExtractionDecision[];

// Report types
export interface ProjectSection {
  project: string;
  progress: string[];
  ongoing: string[];
  blockers: string[];
}

export interface DailyReport {
  date: Date;
  sections: ProjectSection[];
  summary: string;
  generatedAt: Date;
}
