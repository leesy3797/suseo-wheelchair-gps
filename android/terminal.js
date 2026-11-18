import * as FileSystem from 'expo-file-system';
import * as TaskManager from 'expo-task-manager';
import { io } from 'socket.io-client';
import { LocationTransport } from './transport.mjs';

export const LOCATION_TASK = 'suseo-background-location';
const settingsFile = `${FileSystem.documentDirectory}suseo-terminal.json`;
export const SERVER_URL = 'https://suseo-wheelchair-gps.duckdns.org';
let settingsPromise;
let status = { connection: 'pending', message: '단말기를 준비하고 있어요.' };
const listeners = new Set();
function notify(change) {
  status = { ...status, ...change };
  for (const listener of listeners) listener(status);
}
export function subscribe(listener) {
  listeners.add(listener); listener(status);
  return () => listeners.delete(listener);
}
export const transport = new LocationTransport(
  (url) => io(url, { autoConnect: false, transports: ['websocket', 'polling'] }), notify,
);
export function newDeviceId() {
  return `suseo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
async function readSettings() {
  const info = await FileSystem.getInfoAsync(settingsFile);
  const saved = info.exists ? JSON.parse(await FileSystem.readAsStringAsync(settingsFile)) : {};
  const deviceId = saved.device_id || newDeviceId();
  const settings = {
    ...saved,
    device_id: deviceId,
    device_name: saved.device_name || `휠체어 ${deviceId.slice(-4).toUpperCase()}`,
    server_url: SERVER_URL,
    configured: Boolean(saved.configured && saved.device_name?.trim()),
    enabled: saved.enabled ?? true,
  };
  await FileSystem.writeAsStringAsync(settingsFile, JSON.stringify(settings));
  return settings;
}
export function loadSettings() {
  if (!settingsPromise) settingsPromise = readSettings().catch((error) => { settingsPromise = null; throw error; });
  return settingsPromise;
}
export async function saveSettings(settings) {
  await FileSystem.writeAsStringAsync(settingsFile, JSON.stringify(settings));
  settingsPromise = Promise.resolve(settings);
}
TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error) { notify({ connection: 'error', message: `위치 수집 오류: ${error.message}` }); return; }
  try {
    const settings = await loadSettings();
    if (!settings.enabled || !settings.configured) return;
    transport.start(settings);
    const locations = data?.locations;
    if (locations?.length) {
      transport.offer(locations[locations.length - 1]);
      // Keep a headless task alive until receipt or a bounded timeout.
      await transport.waitForDelivery();
    }
  } catch (failure) { notify({ connection: 'error', message: `설정을 확인해주세요: ${failure.message}` }); }
});
