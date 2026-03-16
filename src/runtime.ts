let _runtime: any = null;

export function setRuntime(runtime: any) {
  _runtime = runtime;
}

export function getRuntime(): any {
  return _runtime;
}
