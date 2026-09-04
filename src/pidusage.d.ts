declare module 'pidusage' {
  interface PidUsageStats {
    cpu: number;
    memory: number;
    pid: number;
    ctime: number;
    elapsed: number;
    timestamp: number;
  }
  function pidusage(pid: number): Promise<PidUsageStats>;
  export = pidusage;
}
