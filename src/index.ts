/**
 * @truenas/mcp-server — standalone (community) TrueNAS MCP server.
 *
 * The stdio adapter over @truenas/mcp-base. The CLI (`truenas-mcp-server`) is
 * the product; this module exposes the pieces for tests and embedding.
 */

export { createServer } from '@/server';
export type { ServerDeps } from '@/server';
export { ElicitationGate, renderPlan } from '@/gate';
export {
  applyTlsPolicy,
  defaultConfigPath,
  fileCredentialProvider,
  loadConfig,
  parseConfig,
  resolveConfigPath,
} from '@/config';
export type { ServerConfig } from '@/config';
export { createAuditSink, jsonlAuditSink } from '@/audit';
export type { FlushableAuditSink } from '@/audit';
export { enableTracing, prepareTraceFile } from '@/trace';
export { runInit } from '@/init';
export type { InitOptions } from '@/init';
export { VERSION } from '@/version';
