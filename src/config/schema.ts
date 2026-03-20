import { Type } from '@sinclair/typebox';
import type { BrainMemoryConfig } from './types.js';

// ============================================================================
// Config Schema
// ============================================================================

export const brainMemoryConfigSchema = Type.Object({
  feishu: Type.Object({
    appId: Type.String(),
    appSecret: Type.String(),
  }),
  sources: Type.Object({
    chats: Type.Boolean({ default: true }),
    docs: Type.Boolean({ default: true }),
    meetings: Type.Boolean({ default: true }),
    tasks: Type.Boolean({ default: true }),
  }),
  scan: Type.Object({
    schedule: Type.String({ default: '0 2 * * *' }),
    batchWindowHours: Type.Number({ default: 5 }),
    initialRange: Type.Union([Type.Literal('30d'), Type.Literal('90d'), Type.Literal('all')], {
      default: '30d',
    }),
  }),
  memory: Type.Object({
    importanceThreshold: Type.Number({ default: 0.3 }),
    archiveAfterDays: Type.Number({ default: 30 }),
    maxPerDay: Type.Number({ default: 100 }),
  }),
  report: Type.Object({
    autoGenerate: Type.Boolean({ default: false }),
    time: Type.String({ default: '18:00' }),
    channel: Type.Union([Type.Literal('feishu'), Type.Literal('display')], { default: 'display' }),
  }),
});

export type ConfigSchemaType = typeof brainMemoryConfigSchema;
