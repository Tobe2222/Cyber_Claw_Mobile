/**
 * RemoteToolPermissions — AsyncStorage-backed permission toggles for Agent Reach.
 * Each permission controls whether the desktop AI agent can invoke a category
 * of operations on this device remotely.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export type PermissionKey =
  | 'file_read'
  | 'file_write'
  | 'launch_intent'
  | 'get_location'
  | 'get_camera'
  | 'read_notifications';

export const PERMISSION_LABELS: Record<PermissionKey, string> = {
  file_read: 'Read files',
  file_write: 'Write / create files',
  launch_intent: 'Launch apps & intents',
  get_location: 'Location',
  get_camera: 'Camera',
  read_notifications: 'Notifications',
};

// Default all off for safety
const DEFAULTS: Record<PermissionKey, boolean> = {
  file_read: false,
  file_write: false,
  launch_intent: false,
  get_location: false,
  get_camera: false,
  read_notifications: false,
};

const STORAGE_KEY = 'cyberclaw-agent-reach-permissions';

export async function getPermissions(): Promise<Record<PermissionKey, boolean>> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function setPermission(key: PermissionKey, value: boolean): Promise<void> {
  const current = await getPermissions();
  current[key] = value;
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(current));
}

// Map remote_tool op names to permission keys
export function opToPermission(op: string): PermissionKey | null {
  if (op === 'file_read' || op === 'file_list') return 'file_read';
  if (op === 'file_write' || op === 'file_mkdir') return 'file_write';
  if (op === 'launch_intent') return 'launch_intent';
  if (op === 'get_location') return 'get_location';
  if (op === 'camera_snap') return 'get_camera';
  if (op === 'list_notifications') return 'read_notifications';
  return null;
}

export async function isAllowed(op: string): Promise<boolean> {
  const permKey = opToPermission(op);
  if (!permKey) return false;
  const perms = await getPermissions();
  return perms[permKey] === true;
}
