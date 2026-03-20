// ============================================================================
// Configuration Types
// ============================================================================

export interface BrainMemoryConfig {
  feishu?: {
    appId: string;
    appSecret: string;
  };
  sources: {
    chats: boolean;
    docs: boolean;
    meetings: boolean;
    tasks: boolean;
  };
  scan: {
    schedule: string;
    batchWindowHours: number;
    initialRange: '30d' | '90d' | 'all';
  };
  memory: {
    importanceThreshold: number;
    archiveAfterDays: number;
    maxPerDay: number;
  };
  report: {
    autoGenerate: boolean;
    time: string;
    channel: 'feishu' | 'display';
  };
}

export const DEFAULT_CONFIG: Partial<BrainMemoryConfig> = {
  sources: {
    chats: true,
    docs: true,
    meetings: true,
    tasks: true,
  },
  scan: {
    schedule: '0 2 * * *',
    batchWindowHours: 5,
    initialRange: '30d',
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
