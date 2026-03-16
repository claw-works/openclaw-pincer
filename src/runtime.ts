/**
 * runtime.ts — holds the OpenClawPluginApi runtime reference
 * Pattern copied from openclaw built-in extensions (telegram, irc, etc.)
 */

let _runtime: any = null;

export function setPincerRuntime(runtime: any) {
  _runtime = runtime;
}

export function getPincerRuntime(): any {
  if (!_runtime) throw new Error("Pincer runtime not initialized");
  return _runtime;
}
