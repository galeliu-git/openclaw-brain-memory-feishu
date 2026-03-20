/**
 * 类型存根 - 用于 IDE 类型提示
 *
 * 实际类型由 OpenClaw 运行时提供，这里仅用于编译通过
 */

// OpenClaw Plugin SDK 类型存根
declare module 'openclaw/plugin-sdk' {
  export interface OpenClawPluginApi {
    config: any;
    logger: {
      info(msg: string): void;
      warn(msg: string): void;
      error(msg: string): void;
    };
    resolvePath(relativePath: string): string;
    registerTool(tool: any, handler?: Function): void;
    registerCli(handler: Function, opts?: any): void;
    registerService(service: { id: string; start?: () => void; stop?: () => void }): void;
    on(event: string, handler: (event?: any) => any): void;
    llm: {
      complete(options: {
        messages?: Array<{ role: string; content: string }>;
        prompt?: string;
        temperature?: number;
        maxTokens?: number;
        response_format?: { type: 'json_object' } | { type: 'text' };
      }): Promise<string>;
    };
    http: {
      get(path: string, options?: any): Promise<any>;
      post(path: string, data?: any, options?: any): Promise<any>;
    };
    embedding?: {
      embed(text: string): Promise<number[]>;
    };
  }
}

// LanceDB 类型存根
declare module '@lancedb/lancedb' {
  export interface Connection {
    openTable(name: string): Promise<Table>;
    tableNames(): Promise<string[]>;
    createTable(name: string, data: any[]): Promise<Table>;
  }

  export interface Table {
    add(data: any[]): Promise<void>;
    delete(where: string): Promise<void>;
    query(): Query;
    countRows(): Promise<number>;
    vectorSearch(vector: number[]): Query;
  }

  export interface Query {
    where(where: string): Query;
    limit(limit: number): Query;
    offset(offset: number): Query;
    toArray(): Promise<any[]>;
  }

  export function connect(path: string): Promise<Connection>;
}
