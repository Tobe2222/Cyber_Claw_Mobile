/**
 * SyncClient — connects to CyberClaw desktop's WebSocket sync server
 * Handles pairing, auth, state sync, and message routing.
 * 
 * Connection states (for UI):
 *   - 'disconnected': no connection, not trying
 *   - 'connecting': actively trying to connect
 *   - 'connected': WebSocket open + authenticated (paired)
 *   - 'reconnecting': temporarily lost, auto-recovering (still show as "connected" to user)
 *   - 'lost': failed to reconnect after multiple attempts
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY_TOKEN = 'cyberclaw-sync-token';
const STORAGE_KEY_HOST = 'cyberclaw-sync-host';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'lost';

type MessageHandler = (msg: any) => void;

class SyncClient {
  private ws: WebSocket | null = null;
  private host: string = '';
  private port: number = 9247;
  private token: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private handlers: Map<string, MessageHandler[]> = new Map();
  private _state: ConnectionState = 'disconnected';
  private _authenticated: boolean = false;
  private _reconnectAttempts: number = 0;
  private _maxReconnectAttempts: number = 20; // ~100 seconds before "lost"
  private _isReconnecting: boolean = false;
  private _connectingPromise: Promise<void> | null = null;

  on(type: string, handler: MessageHandler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type)!.push(handler);
  }

  off(type: string, handler: MessageHandler) {
    const list = this.handlers.get(type);
    if (list) {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  private emit(type: string, data: any) {
    const list = this.handlers.get(type);
    if (list) list.forEach(h => h(data));
  }

  private setState(state: ConnectionState) {
    if (this._state === state) return;
    this._state = state;
    this.emit('state_change', { state });
  }

  async loadSaved(): Promise<{ host: string; token: string | null }> {
    const host = await AsyncStorage.getItem(STORAGE_KEY_HOST) || '';
    const token = await AsyncStorage.getItem(STORAGE_KEY_TOKEN);
    this.host = host;
    this.token = token;
    return { host, token };
  }

  async connect(host?: string): Promise<void> {
    if (host) {
      // Clean up host input
      let cleaned = host.trim().replace(/^\[|\]$/g, '');
      // Only strip trailing :port for IPv4
      if (!cleaned.includes(':') || (cleaned.match(/:/g) || []).length === 1) {
        cleaned = cleaned.replace(/:\d+$/, '');
      }
      this.host = cleaned;
      await AsyncStorage.setItem(STORAGE_KEY_HOST, this.host);
    }

    if (!this.host) throw new Error('No host configured');

    // Prevent multiple simultaneous connect attempts
    if (this._connectingPromise) return this._connectingPromise;

    this._connectingPromise = this._doConnect();
    try {
      await this._connectingPromise;
    } finally {
      this._connectingPromise = null;
    }
  }

  private _doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Close existing connection cleanly
        if (this.ws) {
          try { this.ws.close(); } catch {}
          this.ws = null;
        }

        // Validate and build URL
        const isIPv6 = this.host.includes(':');
        if (isIPv6) {
          const groups = this.host.split(':').filter(g => g.length > 0);
          const hasShorthand = this.host.includes('::');
          if (!hasShorthand && groups.length !== 8) {
            throw new Error(`Invalid IPv6 address (${groups.length}/8 groups)`);
          }
        }

        const wsHost = isIPv6 ? `[${this.host}]` : this.host;
        const url = `ws://${wsHost}:${this.port}`;

        if (!this._isReconnecting) {
          this.setState('connecting');
        }

        this.ws = new WebSocket(url);

        const connectTimeout = setTimeout(() => {
          if (this.ws) {
            try { this.ws.close(); } catch {}
            this.ws = null;
          }
          reject(new Error('Connection timeout (10s). Server not reachable.'));
        }, 10000);

        this.ws.onopen = () => {
          clearTimeout(connectTimeout);
          this._reconnectAttempts = 0;

          // Auto-authenticate if we have a saved token
          if (this.token) {
            this.send({ type: 'auth', token: this.token });
          }
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data as string);
            this._handleMessage(msg);
          } catch (e) {
            console.error('[SyncClient] Bad message:', e);
          }
        };

        this.ws.onclose = () => {
          clearTimeout(connectTimeout);
          this.ws = null;
          // Stop keepalive ping
          if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }

          // If we were authenticated, this is a temporary disconnect — reconnect silently
          if (this._authenticated && this._reconnectAttempts < this._maxReconnectAttempts) {
            this._isReconnecting = true;
            this._authenticated = false;
            this.setState('reconnecting'); // UI keeps showing "connected" for this state
            this._scheduleReconnect();
          } else if (this._isReconnecting && this._reconnectAttempts < this._maxReconnectAttempts) {
            this._scheduleReconnect();
          } else if (this._reconnectAttempts >= this._maxReconnectAttempts) {
            this._isReconnecting = false;
            this._authenticated = false;
            this.setState('lost');
          } else {
            this._authenticated = false;
            this.setState('disconnected');
          }
        };

        this.ws.onerror = (err: any) => {
          clearTimeout(connectTimeout);
          console.error('[SyncClient] Error:', err?.message || err);
          // Don't reject if we're reconnecting — onclose handles that
          if (!this._isReconnecting) {
            reject(new Error(err?.message || 'WebSocket connection error'));
          }
        };
      } catch (e) {
        console.error('[SyncClient] Connection failed:', e);
        if (!this._isReconnecting) {
          this.host = '';
          AsyncStorage.removeItem(STORAGE_KEY_HOST);
        }
        reject(e);
      }
    });
  }

  disconnect() {
    this._isReconnecting = false;
    this._reconnectAttempts = 0;
    if (this.reconnectTimer) {
      if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this._authenticated = false;
    this.setState('disconnected');
  }

  pair(code: string, deviceName: string = 'Android') {
    this.send({ type: 'pair', code, deviceName });
  }

  sendChat(
    text: string,
    agentId: string = 'companion',
    deviceMeta?: { deviceName?: string; deviceType?: string },
  ) {
    this.send({ type: 'chat', text, agentId, ...(deviceMeta ? { deviceMeta } : {}) });
  }

  sendRemoteToolResult(id: string, ok: boolean, data?: any, error?: string) {
    this.send({ type: 'remote_tool_result', id, ok, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}) });
  }

  sendVoiceTranscript(transcript: string, context: string, lookbackMinutes: number) {
    this.send({ type: 'voice_transcript', transcript, context, lookbackMinutes });
  }

  sendAudioInput(audioBase64: string, mimeType: string = 'audio/m4a') {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('[SyncClient] Audio input failed: WebSocket not open (state: ' + (this.ws?.readyState || 'none') + ')');
      this.emit('send_error', { type: 'audio_input', reason: 'not_connected' });
      return;
    }
    try {
      this.send({ type: 'audio_input', audioBase64, mimeType });
    } catch (e: any) {
      console.error('[SyncClient] Audio input send failed:', e.message);
      this.emit('send_error', { type: 'audio_input', reason: e?.message });
    }
  }

  requestChatHistory() {
    this.send({ type: 'request_chat_history' });
  }

  // v3.1.17: per-agent chat history request for the companion tab bar.
  // Each companion has its own chat history on the desktop; when the
  // user switches to a different companion tab, we ask the desktop
  // for that companion's messages.
  requestAgentHistory(agentId: string) {
    this.send({ type: 'request_agent_history', agentId });
  }

  requestState() {
    this.send({ type: 'request_state' });
  }

  // v3.1.17: ask the desktop for the current agents list. The
  // mobile calls this on every HomeScreen mount so the companion
  // tab bar rebuilds even after the HomeScreen component was
  // unmounted (e.g. when the user opened Wake Mode and came back).
  // The desktop's sync server caches the last agents_list and
  // replays it as part of _sendFullState.
  //
  // v3.1.16: send a dedicated 'request_agents_list' message
  // instead of piggy-backing on 'request_state'. The desktop
  // handles it the same way (replay cache or trigger refresh),
  // but using a dedicated message means a future refactor of
  // _sendFullState won't accidentally drop the agents-list reply.
  requestAgentsList() {
    this.send({ type: 'request_agents_list' });
  }

  sendCompanionAction(action: any) {
    this.send({ type: 'companion_interaction', action });
  }

  // v3.1.91: ask the desktop to synthesize the wake
  // greeting audio and stream it back. The desktop calls
  // piper TTS via local-ai.synthesizeSpeech and replies
  // with an audio_response tagged requestId='greeting'.
  // Use this when the device-side native TTS is
  // unavailable (no engine installed) — the phone
  // caches the desktop's audio for instant playback on
  // every subsequent wake event.
  requestGreetingAudio(text: string) {
    this.send({ type: 'request_greeting_audio', text });
  }

  // v3.2.29: ask the desktop to synthesize the exit
  // reply audio and stream it back. Mirror of
  // requestGreetingAudio, but routes through a different
  // requestId ('exit_reply' vs 'greeting') so the desktop
  // response is written to the exit-reply cache (via
  // ExitReplyAudioCache) instead of the greeting cache.
  // Voice mode close plays the cached audio (or falls back
  // to speakText() if no cache yet).
  requestExitReplyAudio(text: string) {
    this.send({ type: 'request_exit_reply_audio', text });
  }

  setCompanionId(companionId: string) {
    this.send({ type: 'set_companion_id', companionId });
  }

  // v3.2.5: kick off a custom openWakeWord training job on the
  // desktop. The desktop spawns the Python training script, streams
  // progress back via 'wake_training_progress' messages, and finally
  // sends 'wake_training_result' with the trained .tflite path.
  //
  // Subscribers should listen for:
  //   syncClient.on('wake_training_progress', (msg) => ...)
  //   syncClient.on('wake_training_result', (msg) => ...)
  //
  // `samples` is an array of {name, data} where `name` is the
  // original .m4a filename and `data` is the base64-encoded file
  // contents. The desktop writes them to its training dir — the
  // mobile's filesystem is not reachable from the desktop process.
  requestWakeTraining(agentId: string, phrase: string, samples: Array<{ name: string; data: string }>) {
    this.send({ type: 'request_wake_training', agentId, phrase, samples });
  }

  // v3.2.6: ask the desktop for the most recent wake-training
  // result for an agent. The desktop caches the last result per
  // agent for 15 minutes, so a phone that lost its socket
  // mid-training (Android background-killed the WebSocket, network
  // blip, etc.) can pick up where it left off on reconnect.
  // The response is a normal 'wake_training_result' message.
  requestLatestWakeTrainingResult(agentId: string) {
    this.send({ type: 'get_latest_wake_training_result', agentId });
  }

  // v3.2.0: fetch the bytes of a trained .tflite as base64. Used
  // after wake_training_result returns with a tflitePath. The reply
  // comes back as a 'wake_model_data' message which is re-emitted
  // via the default case.
  readWakeModel(tflitePath: string) {
    this.send({ type: 'read_wake_model', tflitePath });
  }

  get state(): ConnectionState { return this._state; }
  get connected(): boolean { return this._state === 'connected' || this._state === 'reconnecting'; }
  get authenticated(): boolean { return this._authenticated; }

  private _handleMessage(msg: any) {
    switch (msg.type) {
      case 'hello':
        break;

      case 'pair_result':
        if (msg.success && msg.token) {
          this.token = msg.token;
          this._authenticated = true;
          this._isReconnecting = false;
          AsyncStorage.setItem(STORAGE_KEY_TOKEN, msg.token);
          this.setState('connected');
          this.emit('paired', { token: msg.token });
        } else {
          this.emit('pair_failed', { error: msg.error });
        }
        break;

      case 'auth_result':
        if (msg.success) {
          this._authenticated = true;
          this._isReconnecting = false;
          this._reconnectAttempts = 0;
          this.setState('connected');
          this.emit('authenticated', { name: msg.name });
          // Start keepalive ping every 10s to prevent Android killing idle WebSocket
          if (this.pingInterval) clearInterval(this.pingInterval);
          this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.send({ type: 'ping' });
            }
          }, 10000);
          // Auto-request chat history from desktop
          setTimeout(() => this.requestChatHistory(), 300);
          // v3.1.21: Also request the agents list on every successful
          // auth. The desktop's _sendFullState() handles request_state
          // too, but firing it here means we don't depend on the
          // HomeScreen useEffect to do it (which has its own retry
          // loop that can give up at 4s on a slow first connect).
          setTimeout(() => this.requestAgentsList(), 400);
        } else {
          this.token = null;
          AsyncStorage.removeItem(STORAGE_KEY_TOKEN);
          this.emit('auth_failed', { error: msg.error });
        }
        break;

      case 'chat_history':
        this.emit('chat_history', msg);
        break;

      case 'agent_history':
        // v3.1.17: per-agent chat history response. The mobile
        // companion tab bar shows the chat history of whichever
        // companion the user has selected. The response is tagged
        // with the agentId so we know which slot to fill.
        this.emit('agent_history', msg);
        break;

      case 'typing':
        this.emit('typing', msg);
        break;

      case 'state_sync':
        this.emit('state', msg);
        break;

      case 'chat_message':
        console.log('[SyncClient] Received chat_message:', msg.text?.substring(0, 50));
        this.emit('chat', msg);
        break;

      case 'arena_event':
        this.emit('arena', msg);
        break;

      case 'remote_tool':
        this.emit('remote_tool', msg);
        break;

      case 'audio_response':
        // v3.1.91: if the audio_response is tagged as a
        // greeting (requestId === 'greeting'), re-emit on
        // a separate 'greeting_audio' channel for the
        // cache handler AND suppress the regular
        // 'audio_response' channel so the AI-reply
        // playback path doesn't try to play it (which
        // would race with the greeting cache write and
        // cause duplicate playback).
        if (msg.requestId === 'greeting') {
          this.emit('greeting_audio', msg);
          break;
        }
        // v3.2.29: same routing for the exit reply —
        // re-emit on 'exit_reply_audio' so the
        // ExitReplyAudioCache handler can write the
        // file. The regular 'audio_response' channel
        // would also try to play it (the AI-reply
        // playback path), which would race with the
        // cache write and cause duplicate playback.
        if (msg.requestId === 'exit_reply') {
          this.emit('exit_reply_audio', msg);
          break;
        }
        this.emit('audio_response', msg);
        break;

      case 'agents_list':
        // v3.1.15: desktop sent the full list of agents so the mobile
        // can mirror the arena (one companion per agent). Re-emit
        // under a separate event so the HomeScreen can react without
        // touching the existing companion_id handler.
        console.log('[SyncClient] Received agents_list:', msg.agents?.length, 'agents');
        this.emit('agents_list', msg);
        break;

      case 'pong':
        break;

      case 'companion_id':
        this.emit('companion_id', msg);
        break;

      default:
        // v3.2.10: log every default-case message so the Log tab
        // shows the user what the desktop is sending. Especially
        // useful for wake_training_progress / wake_training_result
        // which fall through to here. With this, the Log tab
        // becomes a visible diagnostic of the wake training
        // data flow — if the bar isn't moving, the user can see
        // whether the messages are arriving on the phone at all.
        console.log(`[SyncClient] default-case msg: type=${msg.type}`, JSON.stringify(msg).slice(0, 120));
        this.emit(msg.type, msg);
    }
  }

  // v3.1.21: When a message can't be sent because the WS isn't
  // open, we used to silently drop it. That made the agents_list
  // data flow look broken on the mobile while the actual cause was
  // a half-closed socket. Now we log a warning so the Log tab
  // shows the dropped message and we can correlate with the
  // desktop log to find the race.
  private send(obj: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(obj));
      } catch (e: any) {
        this.emit('send_error', { type: obj.type, reason: e?.message });
      }
    } else {
      // v3.1.21: visible diagnostic. State 0=CONNECTING, 1=OPEN,
      // 2=CLOSING, 3=CLOSED. We only want to warn for non-trivial
      // message types (don't spam the log with pings).
      if (obj.type && obj.type !== 'ping') {
        const state = this.ws ? this.ws.readyState : 'no-ws';
        console.warn(`[SyncClient] Dropped '${obj.type}' — WS not open (readyState=${state}, state=${this._state})`);
      }
    }
  }

  private _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this._reconnectAttempts++;
    const delay = Math.min(5000, 1000 * this._reconnectAttempts); // 1s, 2s, 3s, 4s, 5s...
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.host) {
        this._doConnect().catch(() => {});
      }
    }, delay);
  }
}

export const syncClient = new SyncClient();
export default syncClient;
