export interface PluginDiagnostic {
  phase: 'configuration' | 'loading' | 'execution' | 'parsing' | 'timeout';
  reason: string;
  detail?: string;
  plugin?: string;
  file?: string;
  line?: number;
  column?: number;
  severity?: 'error' | 'warning';
}

export type PluginEvent =
  | { type: 'diagnostics'; project: string; root: string; file?: string; diagnostics: PluginDiagnostic[] }
  | { type: 'clear'; project?: string; root?: string }
  | { type: 'log'; root: string; plugins: string[]; file?: string; level: 'stdout' | 'stderr' | 'info'; message: string };

export const pluginRecovery = 'See "Markdown Chroma: MyST Plugins" in Output for details. After fixing the plugin, save the file or run "Markdown Chroma: Reload Project Plugins".';
