/** SyncClient — connects to CyberClaw desktop's WebSocket sync server Handles pairing, auth, state sync, and message routing. */

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
  // The name the desktop paired us under (from auth_result.name).
  private _deviceName: string = 'Android Phone';
  getDeviceName(): string {
    return this._deviceName;
  }

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
          } else {
            // v3.11.43: no token → this desktop needs a pairing code.
            this.emit('pairing_required', { reason: 'no_token' });
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

  // v3.11.44: switch the shared chat context (casual vs active quest).
  setChatContext(casual: boolean) {
    this.send({ type: 'set_chat_context', casual: !!casual });
  }

  pair(code: string, deviceName: string = 'Android') {
    this.send({ type: 'pair', code, deviceName });
  }

  sendChat(
    text: string,
    agentId: string = 'companion',
    deviceMeta?: { deviceName?: string; deviceType?: string },
    attachmentCount: number = 0,
  ) {
    // v3.11.54: tell the desktop how many images follow, so it waits for them.
    this.send({ type: 'chat', text, agentId, ...(deviceMeta ? { deviceMeta } : {}), ...(attachmentCount > 0 ? { attachmentCount } : {}) });
  }

  // Mobile-initiated companion wake.
  sendWakeAgent(agentId: string = 'companion') {
    this.send({ type: 'mobile_wake_agent', agentId });
  }

  // Mobile-initiated LLM pill action.
  sendLlmAction(model: string, action: 'start' | 'warm' | 'unload') {
    this.send({ type: 'llm_action', model, action });
  }

  // Periodic activity ping from mobile to desktop.
  sendActivityPing(agentId: string = 'companion') {
    this.send({ type: 'mobile_activity_ping', agentId });
  }

  sendRemoteToolResult(id: string, ok: boolean, data?: any, error?: string) {
    this.send({ type: 'remote_tool_result', id, ok, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}) });
  }

  sendVoiceTranscript(transcript: string, context: string, lookbackMinutes: number) {
    this.send({ type: 'voice_transcript', transcript, context, lookbackMinutes });
  }

  // v3.11.47: end-of-turn check — desktop transcribes what's recorded so far
  // and answers voice_peek_result { id, text, complete }.
  peekVoice(id: string, audioBase64: string, mimeType: string = 'audio/wav') {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try { this.send({ type: 'voice_peek', id, audioBase64, mimeType }); return true; } catch { return false; }
  }

  sendAudioInput(audioBase64: string, mimeType: string = 'audio/wav', transcript?: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('[SyncClient] Audio input failed: WebSocket not open (state: ' + (this.ws?.readyState || 'none') + ')');
      this.emit('send_error', { type: 'audio_input', reason: 'not_connected' });
      return;
    }
    try {
      this.send({ type: 'audio_input', audioBase64, mimeType, ...(transcript ? { transcript } : {}) });
    } catch (e: any) {
      console.error('[SyncClient] Audio input send failed:', e.message);
      this.emit('send_error', { type: 'audio_input', reason: e?.message });
    }
  }

  requestChatHistory() {
    this.send({ type: 'request_chat_history' });
  }

  // Attachment (image) upload to desktop.
  sendAttachment(base64: string, mimeType: string, fileName: string) {
    if (!this.connected) {
      console.warn('[SyncClient] sendAttachment: not connected');
      return false;
    }
    try {
      this.send({ type: 'attachment', data: base64, mimeType, fileName });
      return true;
    } catch (e: any) {
      console.error('[SyncClient] Attachment send failed:', e?.message);
      return false;
    }
  }

  // Per-agent chat history request for the companion tab bar.
  requestAgentHistory(agentId: string) {
    this.send({ type: 'request_agent_history', agentId });
  }

  requestState() {
    this.send({ type: 'request_state' });
  }

  // Ask the desktop for the current agents list.
  requestAgentsList() {
    this.send({ type: 'request_agents_list' });
  }

  // Ask the desktop for the full quests list.
  requestQuestsList() {
    this.send({ type: 'request_quests_list' });
  }

  // Skills library — mirror the desktop IPCs over the sync WebSocket.
  requestSkillsList() {
    this.send({ type: 'request_skills_list' });
  }
  requestSkillRead(skillId: string) {
    this.send({ type: 'request_skill_read', skillId });
  }
  createSkill(payload: { name: string; description?: string; icon?: string; triggers?: string[]; body?: string }) {
    this.send({ type: 'create_skill', payload });
  }
  updateSkill(skillId: string, payload: { name?: string; description?: string; icon?: string; triggers?: string[]; body?: string }) {
    this.send({ type: 'update_skill', skillId, payload });
  }
  deleteSkill(skillId: string) {
    this.send({ type: 'delete_skill', skillId });
  }
  seedStarterSkills() {
    this.send({ type: 'seed_starter_skills' });
  }
  requestEnabledSkills(agentId: string) {
    this.send({ type: 'request_enabled_skills', agentId });
  }
  setEnabledSkills(agentId: string, skillIds: string[]) {
    this.send({ type: 'set_enabled_skills', agentId, skillIds });
  }

  // Phone-side quest edit.
  setQuestActive(id: string | null) {
    this.send({ type: 'set_quest_active', id });
  }
  updateQuest(id: string, updates: Record<string, any>) {
    this.send({ type: 'update_quest', id, updates });
  }
  deleteQuest(id: string) {
    this.send({ type: 'delete_quest', id });
  }
  markQuestGoalDone(id: string, goalIndex: number, completed: boolean) {
    this.send({ type: 'mark_quest_goal_done', id, goalIndex, completed });
  }
  createQuest(quest: {
    name?: string;
    description?: string;
    directory?: string;
    defaultQuestDir?: string; // v3.10.156: forwarded so the
                              // desktop's auto-derive can pick
                              // the user's preferred default
                              // location instead of always
                              // falling back to ~/quests/<name>
    goals?: any[];
  }) {
    this.send({ type: 'create_quest', quest });
  }

  // Per-quest instructions.
  requestQuestInstructions(questId: string) {
    this.send({ type: 'request_quest_instructions', questId });
  }

  // Save the quest instructions file.
  saveQuestInstructions(questId: string, content: string) {
    this.send({ type: 'save_quest_instructions', questId, content });
  }

  // Per-quest conversation log.
  getConversationLog(questId: string) {
    this.send({ type: 'request_quest_conversation_log', questId });
  }
  getConversationFile(questId: string) {
    this.send({ type: 'request_quest_conversation_file', questId });
  }
  clearConversationLog(questId: string) {
    this.send({ type: 'clear_quest_conversation_log', questId });
  }

  // CYBERCLAW.md (the overarching system prompt) read / write / reset, round-tripped through the desktop's SyncServer callbacks (v3.2.62) +…
  requestCyberclawSystem() {
    this.send({ type: 'request_cyberclaw_system' });
  }
  saveCyberclawSystem(content: string) {
    this.send({ type: 'save_cyberclaw_system', content });
  }
  resetCyberclawSystem() {
    this.send({ type: 'reset_cyberclaw_system' });
  }

  // Ask the desktop for a companion's soul.md.
  requestCompanionSoul(agentId: string) {
    this.send({ type: 'read_companion_soul', agentId });
  }

  // Ask the desktop for a companion's memory.md.
  requestCompanionMemory(agentId: string) {
    this.send({ type: 'read_companion_memory', agentId });
  }

  // Ask the desktop to clear a companion's memory.md.
  clearCompanionMemory(agentId: string) {
    this.send({ type: 'clear_companion_memory', agentId });
  }

  sendCompanionAction(action: any) {
    this.send({ type: 'companion_interaction', action });
  }

  // Ask the desktop to synthesize the wake greeting audio and stream it back.
  requestGreetingAudio(text: string, voice?: string) {
    this.send({ type: 'request_greeting_audio', text, voice: voice || 'lessac' });
  }

  // Ask the desktop to synthesize the exit reply audio and stream it back.
  requestExitReplyAudio(text: string, voice?: string) {
    this.send({ type: 'request_exit_reply_audio', text, voice: voice || 'lessac' });
  }

  // Ask the desktop to synthesize the working speech audio and stream it back.
  requestWorkingSpeechAudio(text: string, voice?: string) {
    this.send({ type: 'request_working_audio', text, voice: voice || 'lessac' });
  }

  // TTS voice picker mirror.
  requestTtsSettings() {
    this.send({ type: 'request_tts_settings' });
  }

  // Set the desktop's piper voice.
  setTtsVoice(voice: string) {
    this.send({ type: 'set_tts_voice', voice });
  }

  setCompanionId(companionId: string) {
    this.send({ type: 'set_companion_id', companionId });
  }

  // Push a per-companion silence value to the desktop for persistence.
  setCompanionSilence(agentId: string, silenceMs: number) {
    this.send({ type: 'set_companion_silence', agentId, silenceMs });
  }

  // Personalize screen — push a partial sprite config patch to the desktop.
  setSpriteConfig(agentId: string, patch: Record<string, any>) {
    this.send({ type: 'sprite_config_sync', agentId, config: patch });
  }

  // Send an API key for a provider to the desktop.
  sendProviderKey(providerId: string, apiKey: string, extras?: { baseUrl?: string; defaultModel?: string }) {
    if (!providerId || !apiKey) return;
    const provider = {
      id: providerId,
      name: providerId.charAt(0).toUpperCase() + providerId.slice(1),
      apiKey,
      baseUrl: extras?.baseUrl || '',
      defaultModel: extras?.defaultModel || '',
      api: 'openai-completions',
    };
    this.send({ type: 'provider_save', provider });
  }

  // Kick off a custom openWakeWord training job on the desktop.
  requestWakeTraining(
    agentId: string,
    phrase: string,
    samples: Array<{ name: string; data: string }>,
    nearMissSamples?: Array<{ name: string; data: string }>,
  ) {
    this.send({
      type: 'request_wake_training',
      agentId,
      phrase,
      samples,
      ...(nearMissSamples && nearMissSamples.length > 0 ? { nearMissSamples } : {}),
    });
  }

  // Ask the desktop for the most recent wake-training result for an agent.
  requestLatestWakeTrainingResult(agentId: string) {
    this.send({ type: 'get_latest_wake_training_result', agentId });
  }

  // Fetch the bytes of a trained .tflite as base64.
  readWakeModel(tflitePath: string) {
    this.send({ type: 'read_wake_model', tflitePath });
  }

  // Trainer manager wire protocol.

  requestListWakeSetsFromDesktop() {
    this.send({ type: 'list_wake_sets_from_desktop' });
  }

  importWakeSetFromDesktop(setId: string, sourcePath: string) {
    this.send({ type: 'import_wake_set_from_desktop', setId, sourcePath });
  }

  exportWakeSetToDesktop(setId: string, base64: string, phrase: string) {
    this.send({ type: 'export_wake_set_to_desktop', setId, base64, phrase });
  }

  // Parallel exit-phrase training pipeline.
  requestExitTraining(phrase: string, samples: Array<{ name: string; data: string }>) {
    this.send({ type: 'request_exit_training', phrase, samples });
  }
  requestLatestExitTrainingResult() {
    this.send({ type: 'get_latest_exit_training_result' });
  }
  readExitModel(tflitePath: string) {
    this.send({ type: 'read_exit_model', tflitePath });
  }

  // Send-word training pipeline.
  requestSendTraining(phrase: string, samples: Array<{ name: string; data: string }>) {
    this.send({ type: 'request_send_training', phrase, samples });
  }
  requestLatestSendTrainingResult() {
    this.send({ type: 'get_latest_send_training_result' });
  }
  readSendModel(tflitePath: string) {
    this.send({ type: 'read_send_model', tflitePath });
  }

  get state(): ConnectionState { return this._state; }
  get connected(): boolean { return this._state === 'connected' || this._state === 'reconnecting'; }
  get authenticated(): boolean { return this._authenticated; }
  // v3.11.43: socket open (may still be unpaired). `connected` only
  // flips true after auth, so the pairing UI can't key off it.
  get socketOpen(): boolean { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }

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
          // Flush any chat / attachment messages that were buffered while the WS was reconnecting.
          this._flushSendBuffer();
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
          // v3.10.109: same flush as pair_result. After a
          // reconnect, the auth round-trip just landed;
          // push any buffered chat through now.
          this._flushSendBuffer();
          // v3.10.68: cache the device name so outgoing
          // local messages can prefix `[From: <name>]`
          // to match the desktop's echo format.
          if (msg.name) {
            this._deviceName = msg.name;
          }
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
          // Also request the agents list on every successful auth.
          setTimeout(() => this.requestAgentsList(), 400);
          // v3.1.95: same idea for quests. Slight stagger so
          // we don't fire six messages in the same tick if more
          // one-shot pulls get added later.
          setTimeout(() => this.requestQuestsList(), 500);
        } else {
          this.token = null;
          AsyncStorage.removeItem(STORAGE_KEY_TOKEN);
          this.emit('auth_failed', { error: msg.error });
          // v3.11.43: old token rejected (new desktop / reinstall) → ask for a code.
          this.emit('pairing_required', { reason: 'token_rejected', error: msg.error });
        }
        break;

      case 'voice_peek_result':
        this.emit('voice_peek_result', msg);
        break;

      case 'chat_context':
        this.emit('chat_context', msg);
        break;

      case 'chat_history':
        this.emit('chat_history', msg);
        break;

      case 'agent_history':
        // Per-agent chat history response.
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
        // If the audio_response is tagged as a greeting (requestId === 'greeting'), re-emit on a separate 'greeting_audio' channel for the cache…
        if (msg.requestId === 'greeting') {
          this.emit('greeting_audio', msg);
          break;
        }
        // Same routing for the exit reply — re-emit on 'exit_reply_audio' so the ExitReplyAudioCache handler can write the file.
        if (msg.requestId === 'exit_reply') {
          this.emit('exit_reply_audio', msg);
          break;
        }
        // Same routing for the working speech.
        if (msg.requestId === 'working_speech') {
          this.emit('working_speech_audio', msg);
          break;
        }
        this.emit('audio_response', msg);
        break;

      case 'agents_list':
        // Desktop sent the full list of agents so the mobile can mirror the arena (one companion per agent).
        console.log('[SyncClient] Received agents_list:', msg.agents?.length, 'agents');
        this.emit('agents_list', msg);
        break;

      case 'quests_list':
        // Desktop sent the full quests list so the mobile can mirror the desktop's quest panel.
        console.log('[SyncClient] Received quests_list:', msg.quests?.length, 'quest(s)');
        this.emit('quests_list', msg);
        break;

      case 'quests_update_failed':
        // The desktop rejected a quest edit we sent.
        console.warn('[SyncClient] Quest edit failed:', msg);
        this.emit('quests_update_failed', msg);
        break;

      case 'quest_instructions':
        // The desktop responded to a request_quest_instructions with the file's content.
        console.log('[SyncClient] Received quest_instructions for', msg.questId, 'ok=' + msg.ok);
        this.emit('quest_instructions', msg);
        break;

      // v3.10.173: skills library responses + broadcasts.
      // Each shape matches the desktop IPC (ok/error/skill).
      case 'skills_list':
        console.log('[SyncClient] Received skills_list:', msg.skills?.length, 'skill(s)');
        this.emit('skills_list', msg);
        break;
      case 'skills_list_broadcast':
        // Desktop pushed this after a create/update/delete.
        // Refresh the local cache so any open SkillScreen
        // shows the new list without an explicit re-fetch.
        console.log('[SyncClient] Received skills_list_broadcast:', msg.skills?.length, 'skill(s)');
        this.emit('skills_list_broadcast', msg);
        break;
      case 'skill_read':
        console.log('[SyncClient] Received skill_read:', msg.skill?.id, 'ok=' + msg.ok);
        this.emit('skill_read', msg);
        break;
      case 'skill_create_result':
        console.log('[SyncClient] Received skill_create_result:', msg.ok, msg.skill?.id);
        this.emit('skill_create_result', msg);
        break;
      case 'skill_update_result':
        console.log('[SyncClient] Received skill_update_result:', msg.ok, msg.skill?.id);
        this.emit('skill_update_result', msg);
        break;
      case 'skill_delete_result':
        console.log('[SyncClient] Received skill_delete_result:', msg.ok, msg.skillId);
        this.emit('skill_delete_result', msg);
        break;
      case 'skill_seed_result':
        console.log('[SyncClient] Received skill_seed_result:', msg.ok, msg.seeded?.length, 'seeded');
        this.emit('skill_seed_result', msg);
        break;
      case 'enabled_skills':
        console.log('[SyncClient] Received enabled_skills for', msg.agentId, ':', msg.enabled?.length);
        this.emit('enabled_skills', msg);
        break;
      case 'enabled_skills_set':
        console.log('[SyncClient] Received enabled_skills_set for', msg.agentId, 'ok=' + msg.ok);
        this.emit('enabled_skills_set', msg);
        break;

      case 'quest_instructions_saved':
        // The desktop acked a save from the mobile's quest editor.
        console.log('[SyncClient] Received quest_instructions_saved for', msg.questId, 'ok=' + msg.ok);
        this.emit('quest_instructions_saved', msg);
        break;

      case 'companion_soul':
        // The desktop responded to a requestCompanionSoul with the soul.md content + preset table.
        console.log('[SyncClient] Received companion_soul for', msg.agentId, 'ok=' + msg.ok);
        this.emit('companion_soul', msg);
        break;

      case 'companion_memory':
        // The desktop responded to a requestCompanionMemory with the memory.md content.
        console.log('[SyncClient] Received companion_memory for', msg.agentId, 'ok=' + msg.ok);
        this.emit('companion_memory', msg);
        break;

      case 'companion_memory_cleared':
        // The desktop acked a clear-memory request.
        console.log('[SyncClient] Received companion_memory_cleared for', msg.agentId, 'ok=' + msg.ok);
        this.emit('companion_memory_cleared', msg);
        break;

      case 'pong':
        break;

      // TTS voice picker mirror.
      case 'tts_settings':
        console.log('[SyncClient] Received tts_settings ok=' + msg.ok + ' voices=' + (msg.voices?.length || 0) + ' current=' + msg.current);
        this.emit('tts_settings', msg);
        break;
      // v3.10.165: ack of setTtsVoice(). Shape:
      // { ok, current, error, ts }. Emitted so the picker
      // can show a saved toast or revert on failure.
      case 'tts_voice_set':
        console.log('[SyncClient] Received tts_voice_set ok=' + msg.ok + ' current=' + msg.current);
        this.emit('tts_voice_set', msg);
        break;
      // Desktop broadcasts tts_settings_changed when the voice changes (e.g.
      case 'tts_settings_changed':
        console.log('[SyncClient] Received tts_settings_changed current=' + msg.current);
        this.emit('tts_settings_changed', msg);
        break;

      case 'companion_id':
        this.emit('companion_id', msg);
        break;

      case 'companion_settings_sync':
        // Per-companion settings pushed by the desktop (or replayed on auth from companion-settings.json).
        console.log('[SyncClient] Received companion_settings_sync:', Object.keys(msg.settings || {}).length, 'companions');
        this.emit('companion_settings_sync', msg);
        break;

      case 'sprite_config_sync_ok':
        // Desktop confirmed the Personalize save.
        console.log('[SyncClient] sprite_config_sync_ok for', msg.agentId);
        this.emit('sprite_config_sync_ok', msg);
        break;

      case 'sprite_config_sync_failed':
        // Desktop rejected the Personalize save.
        console.warn('[SyncClient] sprite_config_sync_failed:', msg);
        this.emit('sprite_config_sync_failed', msg);
        break;

      // Local-LLM status pill broadcast.
      case 'llm_status':
        console.log('[SyncClient] Received llm_status state=' + msg.state + ' model=' + msg.model);
        this.emit('llm_status', msg);
        break;

      default:
        // Log every default-case message so the Log tab shows the user what the desktop is sending.
        console.log(`[SyncClient] default-case msg: type=${msg.type}`, JSON.stringify(msg).slice(0, 120));
        this.emit(msg.type, msg);
    }
  }

  // When a message can't be sent because the WS isn't open, we used to silently drop it.
  private _sendBuffer: any[] = [];
  private _maxBufferSize = 50;

  // Flush the buffer. Called from setState('connected')
  // once the auth round-trip has completed.
  private _flushSendBuffer() {
    if (this._sendBuffer.length === 0) return;
    const buf = this._sendBuffer;
    this._sendBuffer = [];
    console.log(`[SyncClient] Flushing ${buf.length} buffered message(s) after reconnect`);
    for (const obj of buf) {
      this._attemptSend(obj);
    }
  }

  private _attemptSend(obj: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(obj));
      } catch (e: any) {
        this.emit('send_error', { type: obj?.type, reason: e?.message });
      }
    } else {
      // Re-buffer if still not open (rare — usually only if
      // a SECOND reconnect cycle starts mid-flush).
      if (this._sendBuffer.length < this._maxBufferSize) {
        this._sendBuffer.push(obj);
      }
    }
  }

  private send(obj: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._attemptSend(obj);
    } else {
      // Visible diagnostic.
      if (obj && obj.type && obj.type !== 'ping') {
        if (this._sendBuffer.length < this._maxBufferSize) {
          this._sendBuffer.push(obj);
          const state = this.ws ? this.ws.readyState : 'no-ws';
          console.warn(`[SyncClient] Buffered '${obj.type}' (state=${this._state}, readyState=${state}, buffer=${this._sendBuffer.length})`);
        } else {
          console.warn(`[SyncClient] Dropped '${obj.type}' — buffer full (${this._maxBufferSize})`);
          this.emit('send_error', { type: obj.type, reason: 'send buffer full — desktop unreachable' });
        }
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
