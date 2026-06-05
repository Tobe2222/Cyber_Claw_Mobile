/**
 * RemoteToolHandler — handles incoming `remote_tool` messages from the desktop
 * agent, checks permissions, executes the requested operation natively, and
 * sends back a `remote_tool_result` via SyncClient.
 *
 * Supported ops:
 *   file_read     — read file as base64 (scoped to safe paths)
 *   file_write    — write base64 content to path
 *   file_mkdir    — create directory
 *   file_list     — list directory (name, size, isDir)
 *   get_location  — return current GPS coords
 *   launch_intent — open an Android intent URI via Linking
 *   camera_snap   — take a photo, return base64 JPEG
 *   list_notifications — not supported in RN, returns ok:false
 */

import { Linking, PermissionsAndroid, Platform } from 'react-native';
import * as RNFS from 'react-native-fs';
import { launchCamera } from 'react-native-image-picker';
import { isAllowed } from './RemoteToolPermissions';

// react-native ships Geolocation built-in
const { Geolocation: RNGeo } = require('react-native') as any;
const RNGeolocation: {
  getCurrentPosition: (success: (pos: any) => void, error: (err: any) => void, opts?: any) => void;
} = RNGeo ?? (require('react-native') as any).default?.Geolocation;

// Safe base paths — all file ops must resolve inside one of these
const SAFE_PATHS = [
  RNFS.ExternalStorageDirectoryPath,
  RNFS.DocumentDirectoryPath,
  RNFS.DownloadDirectoryPath,
];

function isSafePath(p: string): boolean {
  if (!p || p.includes('..')) return false;
  // Normalise double slashes
  const norm = p.replace(/\/+/g, '/');
  return SAFE_PATHS.some(base => norm.startsWith(base));
}

type RemoteToolMsg = {
  type: 'remote_tool';
  id: string;
  op: string;
  [key: string]: any;
};

class RemoteToolHandler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;
  private _handler: ((msg: RemoteToolMsg) => void) | null = null;

  constructor(client: any) {
    this.client = client;
  }

  init() {
    this._handler = (msg: RemoteToolMsg) => this._handleTool(msg);
    this.client.on('remote_tool', this._handler);
  }

  destroy() {
    if (this._handler) {
      this.client.off('remote_tool', this._handler);
      this._handler = null;
    }
  }

  private async _handleTool(msg: RemoteToolMsg) {
    const { id, op } = msg;
    try {
      const allowed = await isAllowed(op);
      if (!allowed) {
        this._result(id, false, undefined, 'permission_denied');
        return;
      }
      const result = await this._execute(op, msg);
      this._result(id, true, result);
    } catch (e: any) {
      this._result(id, false, undefined, e?.message || String(e));
    }
  }

  private _result(id: string, ok: boolean, data?: any, error?: string) {
    this.client.sendRemoteToolResult(id, ok, data, error);
  }

  private async _execute(op: string, msg: RemoteToolMsg): Promise<any> {
    switch (op) {
      case 'file_read': {
        const path: string = msg.path;
        if (!isSafePath(path)) throw new Error('path_not_allowed');
        const content = await RNFS.readFile(path, 'base64');
        return { content };
      }

      case 'file_write': {
        const path: string = msg.path;
        const content: string = msg.content; // base64
        if (!isSafePath(path)) throw new Error('path_not_allowed');
        await RNFS.writeFile(path, content, 'base64');
        return { written: true };
      }

      case 'file_mkdir': {
        const path: string = msg.path;
        if (!isSafePath(path)) throw new Error('path_not_allowed');
        await RNFS.mkdir(path);
        return { created: true };
      }

      case 'file_list': {
        const path: string = msg.path;
        if (!isSafePath(path)) throw new Error('path_not_allowed');
        const items = await RNFS.readDir(path);
        return {
          entries: items.map(item => ({
            name: item.name,
            path: item.path,
            size: item.size,
            isDir: item.isDirectory(),
            mtime: item.mtime?.toISOString() ?? null,
          })),
        };
      }

      case 'get_location': {
        const coords = await this._getLocation();
        return coords;
      }

      case 'launch_intent': {
        const uri: string = msg.uri;
        if (!uri) throw new Error('missing_uri');
        await Linking.openURL(uri);
        return { opened: true };
      }

      case 'camera_snap': {
        const result = await this._takeCameraPhoto();
        return result;
      }

      case 'list_notifications': {
        return { ok: false, reason: 'not_supported' };
      }

      default:
        throw new Error(`unknown_op: ${op}`);
    }
  }

  private _getLocation(): Promise<{ latitude: number; longitude: number; accuracy: number }> {
    return new Promise(async (resolve, reject) => {
      // Request location permission on Android
      if (Platform.OS === 'android') {
        try {
          const granted = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
            {
              title: 'Location Permission',
              message: 'CyberClaw needs location access for Agent Reach.',
              buttonPositive: 'Allow',
            },
          );
          if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
            reject(new Error('location_permission_denied'));
            return;
          }
        } catch (e) {
          reject(e);
          return;
        }
      }

      RNGeolocation.getCurrentPosition(
        (pos: any) => {
          resolve({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          });
        },
        (err: any) => reject(new Error(err.message)),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
      );
    });
  }

  private _takeCameraPhoto(): Promise<{ base64: string; mimeType: string }> {
    return new Promise((resolve, reject) => {
      launchCamera(
        {
          mediaType: 'photo',
          cameraType: 'back',
          includeBase64: true,
          quality: 0.7,
          saveToPhotos: false,
        },
        response => {
          if (response.didCancel) {
            reject(new Error('camera_cancelled'));
            return;
          }
          if (response.errorCode) {
            reject(new Error(response.errorMessage || response.errorCode));
            return;
          }
          const asset = response.assets?.[0];
          if (!asset?.base64) {
            reject(new Error('no_image_data'));
            return;
          }
          resolve({ base64: asset.base64, mimeType: asset.type || 'image/jpeg' });
        },
      );
    });
  }
}

export default RemoteToolHandler;
