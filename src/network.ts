/**
 * network.ts — port checks, IP discovery, and the persistent
 * port-allocation store (config/network-allocations.json).
 */

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import axios from 'axios';
import { NETWORK_DB_PATH, CONFIG_DIR } from './config';
import { log } from './logger';
import type { NetworkStatus, PortAllocation } from './types';

export const DEFAULT_PORTS: Array<{ port: number; service: string }> = [
  { port: 25565, service: 'Minecraft Primary' },
  { port: 25566, service: 'Minecraft Secondary' },
  { port: 8123, service: 'Dynmap Web' },
  { port: 19132, service: 'Minecraft Bedrock' },
  { port: 25577, service: 'RCON' }
];

/** True when a port is free (bindable) on this host. */
export function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    const timeout = setTimeout(() => { srv.close(); resolve(false); }, 3000);
    srv.once('error', () => { clearTimeout(timeout); resolve(false); });
    srv.once('listening', () => { clearTimeout(timeout); srv.close(); resolve(true); });
    srv.listen(port, '0.0.0.0');
  });
}

export async function getPublicIP(): Promise<string | null> {
  try {
    const response = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
    return response.data.ip as string;
  } catch (err) {
    log(`Failed to get public IP: ${(err as Error).message}`, 'warn');
    return null;
  }
}

export function getLocalIP(): { address: string; mac: string | null } {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return { address: iface.address, mac: iface.mac };
      }
    }
  }
  return { address: '127.0.0.1', mac: null };
}

export function loadAllocations(): PortAllocation[] {
  try {
    if (fs.existsSync(NETWORK_DB_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(NETWORK_DB_PATH, 'utf8'));
      if (Array.isArray(parsed)) return parsed as PortAllocation[];
    }
  } catch (err) {
    log(`Failed to load allocations: ${(err as Error).message}`, 'warn');
  }
  return [];
}

export function saveAllocations(allocations: PortAllocation[]): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(NETWORK_DB_PATH, JSON.stringify(allocations, null, 2));
}

export async function getNetworkStatus(): Promise<NetworkStatus> {
  const localIP = getLocalIP();
  const publicIP = await getPublicIP();

  const portChecks = await Promise.all(
    DEFAULT_PORTS.map(async ({ port, service }) => ({
      port,
      service,
      status: (await checkPort(port)) ? ('free' as const) : ('in-use' as const)
    }))
  );

  const allocations = loadAllocations().filter((a) => a.status === 'active');

  return {
    publicIP,
    localIP: localIP.address,
    hostname: os.hostname(),
    mac: localIP.mac,
    defaultPorts: portChecks,
    allocations,
    timestamp: new Date().toISOString()
  };
}
