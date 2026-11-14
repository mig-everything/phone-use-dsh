import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PhoneError } from './errors.js';

/** Host identity is supplied by an adapter, never by model arguments. */
export interface ToolContext {
  scope: string;
  signal: AbortSignal;
  hasUi?: boolean;
}
export interface PhoneTool {
  name: string;
  description?: string;
  title?: string;
  schema: z.ZodObject;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, any>;
  execute(args: unknown, context: ToolContext): Promise<CallToolResult>;
}

/** One validated tool contract for MCP, DSH, and embedded integrations. */
export class PhoneToolCatalog {
  readonly tools = new Map<string, PhoneTool>();
  registerTool<S extends z.ZodRawShape>(
    name: string,
    definition: {
      inputSchema: S;
      description?: string;
      title?: string;
      annotations?: Record<string, unknown>;
      _meta?: Record<string, any>;
    },
    handler: (args: z.output<z.ZodObject<S>>, context: ToolContext) => Promise<CallToolResult>,
  ) {
    if (this.tools.has(name)) throw new Error(`Duplicate phone tool: ${name}`);
    const { inputSchema, ...metadata } = definition;
    const schema = z.strictObject(inputSchema);
    this.tools.set(name, {
      ...metadata,
      name,
      schema,
      async execute(args, context) {
        context.signal.throwIfAborted();
        return handler(schema.parse(args) as z.output<z.ZodObject<S>>, context);
      },
    });
  }
  call(name: string, args: unknown, context: ToolContext) {
    const tool = this.tools.get(name);
    if (!tool) throw new PhoneError('UNKNOWN_TOOL', 'Unknown Phone Use operation.');
    return tool.execute(args, context);
  }
}
