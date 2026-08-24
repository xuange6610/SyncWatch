'use strict';

const AI_CONFIG_STORAGE_KEY = 'syncwatchAiWorkbenchConfigV2';
const AI_HISTORY_STORAGE_KEY = 'syncwatchAiWorkbenchHistoryV2';
const AI_MAX_CONVERSATIONS = 50;
const AI_MAX_MESSAGES = 200;
const AI_CONFIG_FORMAT = 'syncwatch-ai-config';
const AI_KNOWN_ENDPOINT_SUFFIXES = [
  '/chat/completions', '/images/generations', '/audio/speech', '/audio/transcriptions',
  '/responses', '/models', '/videos'
];

const AI_CONFIG_IMPORT_FIELDS = {
  baseUrl: ['baseUrl', 'baseURL', 'base_url', 'apiBase', 'api_base', 'apiHost', 'api_host', 'host', 'endpoint', 'baseEndpoint', 'url'],
  apiKey: ['apiKey', 'api_key', 'accessToken', 'access_token', 'secretKey', 'secret_key', 'token', 'key', 'authorization'],
  imageBaseUrl: ['imageBaseUrl', 'imageBaseURL', 'image_base_url', 'imageApiBase', 'image_api_base'],
  imageApiKey: ['imageApiKey', 'image_api_key', 'imageAccessToken', 'image_access_token'],
  videoBaseUrl: ['videoBaseUrl', 'videoBaseURL', 'video_base_url', 'videoApiBase', 'video_api_base'],
  videoApiKey: ['videoApiKey', 'video_api_key', 'videoAccessToken', 'video_access_token'],
  protocol: ['protocol', 'apiProtocol', 'api_protocol'],
  modelsPath: ['modelsPath', 'models_path', 'modelPath', 'model_path'],
  responsesPath: ['responsesPath', 'responses_path'],
  chatPath: ['chatPath', 'chat_path', 'completionsPath', 'completions_path'],
  imagePath: ['imagePath', 'image_path', 'imagesPath', 'images_path'],
  videoPath: ['videoPath', 'video_path'],
  chatModel: ['chatModel', 'chat_model', 'model', 'defaultModel', 'default_model'],
  imageModel: ['imageModel', 'image_model'],
  videoModel: ['videoModel', 'video_model'],
  modelCatalog: ['modelCatalog', 'model_catalog', 'models'],
  systemPrompt: ['systemPrompt', 'system_prompt'],
  imageSize: ['imageSize', 'image_size', 'size'],
  imageQuality: ['imageQuality', 'image_quality', 'quality'],
  videoSize: ['videoSize', 'video_size'],
  videoSeconds: ['videoSeconds', 'video_seconds', 'duration', 'seconds']
};

function aiOwn(source, key) { return Object.prototype.hasOwnProperty.call(source || {}, key); }

function aiConfigSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须是 JSON 对象');
  if (value.format === AI_CONFIG_FORMAT && value.config && typeof value.config === 'object') return value.config;
  for (const key of ['config', 'ai', 'openai', 'provider']) {
    if (value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])) return value[key];
  }
  if (Array.isArray(value.providers) && value.providers[0] && typeof value.providers[0] === 'object') return value.providers[0];
  if (value.settings && typeof value.settings === 'object' && !Array.isArray(value.settings)) return value.settings;
  return value;
}

function aiNormalizeBaseUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); } catch (_) { throw new Error('配置中的 API 地址格式不正确'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) throw new Error('API 地址必须使用不含账号密码的 HTTPS 地址');
  parsed.hash = ''; parsed.search = ''; parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  const lowerPath = parsed.pathname.toLowerCase();
  const suffix = AI_KNOWN_ENDPOINT_SUFFIXES.find((item) => lowerPath.endsWith(item));
  if (suffix) parsed.pathname = parsed.pathname.slice(0, -suffix.length).replace(/\/+$/, '') || '/';
  return parsed.toString().replace(/\/$/, '');
}

function aiNormalizeModelCatalog(value) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const models = [];
  for (const entry of source) {
    const id = String(typeof entry === 'string' ? entry : entry?.id || entry?.model || entry?.name || '').trim().slice(0, 160);
    if (!id || seen.has(id)) continue;
    seen.add(id); models.push(id);
    if (models.length >= 500) break;
  }
  return models;
}

function aiNormalizeImportedConfig(value) {
  const source = aiConfigSource(value);
  const result = {};
  let recognized = 0;
  for (const [field, aliases] of Object.entries(AI_CONFIG_IMPORT_FIELDS)) {
    const alias = aliases.find((key) => aiOwn(source, key) && source[key] !== null && source[key] !== undefined);
    if (!alias) continue;
    let item = source[alias];
    if (['apiKey', 'imageApiKey', 'videoApiKey'].includes(field)) item = String(item).replace(/^Bearer\s+/i, '').trim();
    if (field === 'modelCatalog') {
      const models = aiNormalizeModelCatalog(item);
      if (models.length) { result.modelCatalog = models; recognized += 1; }
      continue;
    }
    if (field === 'videoSeconds') item = Math.max(1, Math.min(60, Number(item) || 8));
    const text = typeof item === 'string' ? item.trim() : String(item);
    if (!text && field !== 'systemPrompt') continue;
    result[field] = text.slice(0, field.endsWith('ApiKey') || field === 'apiKey' ? 4096 : field === 'systemPrompt' ? 20000 : 500);
    recognized += 1;
  }
  for (const field of ['baseUrl', 'imageBaseUrl', 'videoBaseUrl']) if (result[field]) result[field] = aiNormalizeBaseUrl(result[field]);
  for (const field of ['apiKey', 'imageApiKey', 'videoApiKey']) if (result[field] && result[field].length > 4096) throw new Error('API 密钥长度超过限制');
  if (result.protocol && !['auto', 'responses', 'chat'].includes(result.protocol.toLowerCase())) throw new Error('API 协议只能是自动检测、Responses 或 Chat Completions');
  if (result.protocol) result.protocol = result.protocol.toLowerCase();
  else delete result.protocol;
  for (const field of ['modelsPath', 'responsesPath', 'chatPath', 'imagePath', 'videoPath']) {
    if (!result[field]) continue;
    if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,240}$/.test(result[field]) || result[field].includes('..') || result[field].includes('//')) {
      throw new Error(`${field} 路径格式不正确`);
    }
  }
  if (!recognized) throw new Error('剪贴板或文件中没有识别到 AI API 配置字段');
  return result;
}

function aiParseConfigText(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 128 * 1024) throw new Error('配置内容为空或超过 128 KB');
  const unfenced = text.replace(/^```(?:json|javascript|env)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return aiNormalizeImportedConfig(JSON.parse(unfenced)); } catch (error) {
    // Continue with common .env / key-value clipboard formats only when JSON parsing failed.
    if (/^配置必须是 JSON|^API 地址|^API 密钥|^API 协议|路径格式|没有识别/.test(error.message || '')) {
      if (/^\s*[\[{]/.test(unfenced)) throw error;
    }
  }
  const env = {};
  for (const line of unfenced.split(/\r?\n/)) {
    const match = line.match(/^\s*(OPENAI_API_BASE|OPENAI_BASE_URL|OPENAI_API_URL|OPENAI_API_HOST|OPENAI_COMPATIBLE_BASE_URL|API_BASE_URL|BASE_URL|OPENAI_API_KEY|API_KEY|OPENAI_MODEL|OPENAI_CHAT_MODEL|MODEL|OPENAI_MODELS_PATH)\s*[:=]\s*["']?(.+?)["']?\s*$/i);
    if (match) env[match[1].toLowerCase()] = match[2].trim();
  }
  if (Object.keys(env).length) {
    return aiNormalizeImportedConfig({
      baseUrl: env.openai_api_base || env.openai_base_url || env.openai_api_url || env.openai_api_host || env.openai_compatible_base_url || env.api_base_url || env.base_url,
      apiKey: env.openai_api_key || env.api_key,
      model: env.openai_chat_model || env.openai_model || env.model,
      modelsPath: env.openai_models_path
    });
  }
  const plainLines = unfenced.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const plainUrl = plainLines.find((line) => /^https:\/\/\S+$/i.test(line));
  const plainKey = plainLines.find((line) => /^(?:Bearer\s+)?[A-Za-z0-9._~+\/=:-]{16,4096}$/i.test(line) && line !== plainUrl);
  if (plainUrl && plainKey) return aiNormalizeImportedConfig({ baseUrl: plainUrl, apiKey: plainKey });
  if (/^https:\/\//i.test(unfenced) && !/[\s\n]/.test(unfenced)) return aiNormalizeImportedConfig({ baseUrl: unfenced });
  if (/^(?:Bearer\s+)?[A-Za-z0-9._~+/=-]{16,4096}$/i.test(unfenced)) return aiNormalizeImportedConfig({ apiKey: unfenced });
  throw new Error('无法识别配置。请粘贴 SyncWatch同步观影 JSON、OpenAI 兼容 .env，或单独的 HTTPS 地址/API 密钥');
}

function aiDefaultConfig() {
  return {
    baseUrl: '', apiKey: '', protocol: 'auto', modelsPath: '/models',
    imageBaseUrl: '', imageApiKey: '', videoBaseUrl: '', videoApiKey: '',
    responsesPath: '/responses', chatPath: '/chat/completions',
    imagePath: '/images/generations', videoPath: '/videos',
    chatModel: '', imageModel: '', videoModel: '', systemPrompt: '',
    imageSize: '1024x1024', imageQuality: 'auto', videoSize: '1280x720', videoSeconds: 8,
    modelCatalog: [], modelCatalogUpdatedAt: ''
  };
}

function aiReadJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value === null ? fallback : value;
  } catch (_) { return fallback; }
}

function aiCreateConversation(title = '新对话') {
  return {
    id: typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `ai-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: String(title || '新对话').slice(0, 60), createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), messages: []
  };
}

// Video jobs are keyed by their originating conversation and message.  The
// JSON key keeps user-imported IDs unambiguous even if they contain a colon.
function aiVideoPollKey(conversationId, messageId) {
  return JSON.stringify([String(conversationId || ''), String(messageId || '')]);
}

function aiNormalizeConversations(value) {
  const source = Array.isArray(value) ? value : [];
  return source.slice(0, AI_MAX_CONVERSATIONS).map((entry) => ({
    id: String(entry?.id || aiCreateConversation().id).slice(0, 100),
    title: String(entry?.title || '新对话').slice(0, 60),
    createdAt: String(entry?.createdAt || new Date().toISOString()),
    updatedAt: String(entry?.updatedAt || entry?.createdAt || new Date().toISOString()),
    messages: (Array.isArray(entry?.messages) ? entry.messages : []).slice(-AI_MAX_MESSAGES).map((message) => ({
      id: String(message?.id || aiCreateConversation().id).slice(0, 100),
      role: ['user', 'assistant', 'system'].includes(message?.role) ? message.role : 'assistant',
      kind: ['text', 'image', 'video', 'status', 'error'].includes(message?.kind) ? message.kind : 'text',
      content: String(message?.content || '').slice(0, 50000),
      createdAt: String(message?.createdAt || new Date().toISOString()),
      images: (Array.isArray(message?.images) ? message.images : []).map(String).filter((url) => /^https:\/\//i.test(url)).slice(0, 4),
      videoUrl: /^https:\/\//i.test(String(message?.videoUrl || '')) ? String(message.videoUrl) : '',
      videoId: String(message?.videoId || '').slice(0, 180), status: String(message?.status || '').slice(0, 80)
    }))
  }));
}

function initializeAiWorkbench() {
  const actionBar = document.querySelector('.topbar-scroll-actions');
  if (actionBar && !document.getElementById('aiWorkbenchBtn')) {
    const button = document.createElement('button');
    button.id = 'aiWorkbenchBtn'; button.className = 'ghost-button header-feature-button is-hidden'; button.type = 'button';
    button.title = '打开 AI 对话、生图与视频工作台';
    button.innerHTML = '<span class="ai-button-mark" aria-hidden="true">AI</span><span class="button-label">AI聊天</span>';
    actionBar.insertBefore(button, document.getElementById('masterMuteBtn') || actionBar.firstChild);
  }

  if (!document.getElementById('aiWorkbenchModal')) {
    const modal = document.createElement('div');
    modal.id = 'aiWorkbenchModal'; modal.className = 'modal ai-workbench-modal is-hidden';
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'aiWorkbenchTitle');
    modal.innerHTML = `
      <div class="modal-card ai-workbench-card">
        <button id="closeAiWorkbenchBtn" class="modal-close" type="button" aria-label="关闭 AI 工作台">×</button>
        <header class="ai-workbench-header">
          <div><p class="eyebrow">SyncWatch同步观影 智能创作</p><h2 id="aiWorkbenchTitle">AI 聊天</h2><p>通过服务器安全中转连接兼容 API，支持对话、图片和视频生成。</p></div>
          <div class="ai-mode-switch" role="tablist" aria-label="AI 模式">
            <button class="active" data-ai-mode="chat" type="button">对话</button>
            <button data-ai-mode="image" type="button">生图</button>
            <button data-ai-mode="video" type="button">视频</button>
          </div>
        </header>
        <div class="ai-workbench-layout">
          <aside class="ai-conversation-panel">
            <button id="newAiConversationBtn" class="primary-button full" type="button">＋ 新建对话</button>
            <div class="ai-conversation-actions"><button id="renameAiConversationBtn" class="text-button" type="button">重命名</button><button id="deleteAiConversationBtn" class="danger-text-button" type="button">删除</button></div>
            <div id="aiConversationList" class="ai-conversation-list" aria-label="AI 对话列表"></div>
            <div class="ai-history-actions"><button id="exportAiHistoryBtn" class="secondary-button" type="button">导出</button><button id="importAiHistoryBtn" class="secondary-button" type="button">导入</button><input id="importAiHistoryInput" class="visually-hidden" type="file" accept="application/json,.json"></div>
          </aside>
          <section class="ai-creation-panel">
            <div class="ai-model-toolbar">
              <label class="ai-model-field"><span>当前模型</span><span class="ai-model-control"><select id="aiModelPicker" aria-label="选择已读取的模型"><option value="">请先刷新模型</option></select><input id="aiActiveModel" list="aiModelOptions" autocomplete="off" placeholder="也可填写自定义模型"><datalist id="aiModelOptions"></datalist></span><small id="aiModelSummary">尚未读取模型列表</small></label>
              <button id="refreshAiModelsBtn" class="secondary-button" type="button">刷新模型</button>
              <button id="toggleAiConfigBtn" class="secondary-button" type="button" aria-expanded="false">API 配置</button>
            </div>
            <section id="aiConfigPanel" class="ai-config-panel is-hidden">
              <section class="ai-provider-config" aria-labelledby="aiChatProviderTitle"><div><h3 id="aiChatProviderTitle">对话与模型测试</h3><p>用于读取模型、测试连接和 AI 对话。</p></div><div class="ai-config-grid ai-config-basic-grid"><label class="span-2">API 中转地址<input id="aiBaseUrl" type="url" placeholder="https://api.openai.com/v1"></label><label class="span-2">API 密钥<input id="aiApiKey" type="password" autocomplete="new-password" placeholder="始终遮罩，仅保存在当前设备"></label><label>API 协议<select id="aiProtocol"><option value="auto">自动检测</option><option value="responses">Responses API</option><option value="chat">Chat Completions</option></select></label><label>模型列表路径<input id="aiModelsPath" value="/models"></label></div></section>
              <section class="ai-provider-config" aria-labelledby="aiImageProviderTitle"><div><h3 id="aiImageProviderTitle">图片生成</h3><p>可使用与对话不同的中转地址和密钥；留空时沿用对话配置。</p></div><div class="ai-config-grid"><label class="span-2">生图 API 地址<input id="aiImageBaseUrl" type="url" placeholder="留空沿用对话 API 地址"></label><label class="span-2">生图 API 密钥<input id="aiImageApiKey" type="password" autocomplete="new-password" placeholder="留空沿用对话密钥"></label><label>图片生成路径<input id="aiImagePath" value="/images/generations"></label><label>图片模型<input id="aiImageModel" list="aiModelOptions"></label></div></section>
              <section class="ai-provider-config" aria-labelledby="aiVideoProviderTitle"><div><h3 id="aiVideoProviderTitle">视频生成</h3><p>视频服务可单独配置；未填写时同样沿用对话配置。</p></div><div class="ai-config-grid"><label class="span-2">视频 API 地址<input id="aiVideoBaseUrl" type="url" placeholder="留空沿用对话 API 地址"></label><label class="span-2">视频 API 密钥<input id="aiVideoApiKey" type="password" autocomplete="new-password" placeholder="留空沿用对话密钥"></label><label>视频生成路径<input id="aiVideoPath" value="/videos"></label><label>视频模型<input id="aiVideoModel" list="aiModelOptions"></label></div></section>
              <details class="ai-advanced-config">
                <summary>对话高级路径与系统提示词</summary>
                <div class="ai-config-grid">
                  <label>Responses 路径<input id="aiResponsesPath" value="/responses"></label>
                  <label>聊天兼容路径<input id="aiChatPath" value="/chat/completions"></label>
                  <label>对话模型<input id="aiChatModel" list="aiModelOptions"></label>
                  <label class="span-2">系统提示词<textarea id="aiSystemPrompt" rows="2" placeholder="可选：设置 AI 的角色与回答方式"></textarea></label>
                </div>
              </details>
              <div class="ai-config-actions"><div class="ai-config-command-row"><button id="saveAiConfigBtn" class="primary-button" type="button">保存并读取模型</button><button id="testAiConnectionBtn" class="secondary-button" type="button">测试并刷新</button><button id="syncAiConfigBtn" class="secondary-button" type="button">安全同步配置</button><button id="exportAiConfigBtn" class="secondary-button" type="button">导出（不含密钥）</button><button id="importAiConfigBtn" class="secondary-button" type="button">导入 JSON</button><button id="pasteAiConfigBtn" class="secondary-button" type="button">识别剪贴板</button><input id="importAiConfigInput" class="visually-hidden" type="file" accept="application/json,.json,text/plain,.env"></div><small id="aiConfigStatus">API 密钥始终遮罩。同步时会先征得对方同意，再由服务器在内存中一次性转交完整配置，不会写入服务器文件或日志。</small></div>
            </section>
            <div id="aiMessages" class="ai-messages" aria-live="polite"></div>
            <form id="aiComposer" class="ai-composer">
              <textarea id="aiPromptInput" rows="3" maxlength="20000" placeholder="输入想和 AI 讨论的内容…"></textarea>
              <div id="aiGenerationOptions" class="ai-generation-options is-hidden">
                <label data-ai-option="image">尺寸<select id="aiImageSize"><option value="1024x1024">1024 × 1024</option><option value="1536x1024">1536 × 1024</option><option value="1024x1536">1024 × 1536</option></select></label>
                <label data-ai-option="image">画质<select id="aiImageQuality"><option value="auto">自动</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
                <label data-ai-option="video">尺寸<select id="aiVideoSize"><option value="1280x720">1280 × 720</option><option value="720x1280">720 × 1280</option><option value="1024x1024">1024 × 1024</option></select></label>
                <label data-ai-option="video">时长<select id="aiVideoSeconds"><option value="4">4 秒</option><option value="8">8 秒</option><option value="12">12 秒</option></select></label>
              </div>
              <div class="ai-composer-actions"><span id="aiRequestStatus">准备就绪</span><button id="stopAiRequestBtn" class="secondary-button is-hidden" type="button">停止</button><button id="clearAiConversationBtn" class="secondary-button" type="button">清空</button><button id="sendAiPromptBtn" class="primary-button" type="submit">发送</button></div>
            </form>
          </section>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }

  const ids = `aiWorkbenchBtn aiWorkbenchModal aiWorkbenchTitle closeAiWorkbenchBtn newAiConversationBtn renameAiConversationBtn deleteAiConversationBtn aiConversationList exportAiHistoryBtn importAiHistoryBtn importAiHistoryInput aiModelPicker aiActiveModel aiModelOptions aiModelSummary refreshAiModelsBtn toggleAiConfigBtn aiConfigPanel aiBaseUrl aiApiKey aiImageBaseUrl aiImageApiKey aiVideoBaseUrl aiVideoApiKey aiProtocol aiModelsPath aiResponsesPath aiChatPath aiImagePath aiVideoPath aiChatModel aiImageModel aiVideoModel aiSystemPrompt saveAiConfigBtn testAiConnectionBtn syncAiConfigBtn exportAiConfigBtn importAiConfigBtn pasteAiConfigBtn importAiConfigInput aiConfigStatus aiMessages aiComposer aiPromptInput aiGenerationOptions aiImageSize aiImageQuality aiVideoSize aiVideoSeconds aiRequestStatus stopAiRequestBtn clearAiConversationBtn sendAiPromptBtn`.split(/\s+/);
  for (const id of ids) elements[id] = document.getElementById(id);

  const storedConfig = aiReadJson(AI_CONFIG_STORAGE_KEY, {});
  const config = { ...aiDefaultConfig(), ...(storedConfig && typeof storedConfig === 'object' ? storedConfig : {}) };
  config.modelCatalog = aiNormalizeModelCatalog(config.modelCatalog);
  let conversations = aiNormalizeConversations(aiReadJson(AI_HISTORY_STORAGE_KEY, []));
  if (!conversations.length) conversations = [aiCreateConversation()];
  state.aiWorkbench = {
    config, conversations, activeId: conversations[0].id, mode: 'chat', models: config.modelCatalog,
    busy: false, abortController: null, videoPollers: new Map(), modelAutoLoadAttempted: false
  };
  aiFillConfigForm(); aiRenderModelCatalog(); aiRenderConversationList(); aiRenderMessages(); aiSetMode('chat');

  elements.aiWorkbenchBtn?.addEventListener('click', aiOpenWorkbench);
  elements.closeAiWorkbenchBtn?.addEventListener('click', aiCloseWorkbench);
  elements.aiWorkbenchModal?.addEventListener('click', (event) => { if (event.target === elements.aiWorkbenchModal) aiCloseWorkbench(); });
  elements.aiWorkbenchModal?.querySelectorAll('[data-ai-mode]').forEach((button) => button.addEventListener('click', () => aiSetMode(button.dataset.aiMode)));
  elements.newAiConversationBtn?.addEventListener('click', aiNewConversation);
  elements.renameAiConversationBtn?.addEventListener('click', aiRenameConversation);
  elements.deleteAiConversationBtn?.addEventListener('click', aiDeleteConversation);
  elements.aiConversationList?.addEventListener('click', aiSelectConversation);
  elements.toggleAiConfigBtn?.addEventListener('click', aiToggleConfig);
  elements.saveAiConfigBtn?.addEventListener('click', async () => { if (aiSaveConfig(true)) await aiRefreshModels(false); });
  elements.testAiConnectionBtn?.addEventListener('click', () => aiRefreshModels(true));
  elements.refreshAiModelsBtn?.addEventListener('click', () => aiRefreshModels(false));
  elements.aiModelPicker?.addEventListener('change', aiSelectCatalogModel);
  elements.aiActiveModel?.addEventListener('input', aiCommitActiveModel);
  elements.aiActiveModel?.addEventListener('change', () => { aiCommitActiveModel(); aiPersist(); });
  elements.aiComposer?.addEventListener('submit', aiSubmitPrompt);
  elements.stopAiRequestBtn?.addEventListener('click', aiStopRequest);
  elements.clearAiConversationBtn?.addEventListener('click', aiClearConversation);
  elements.exportAiHistoryBtn?.addEventListener('click', aiExportHistory);
  elements.importAiHistoryBtn?.addEventListener('click', () => elements.importAiHistoryInput?.click());
  elements.importAiHistoryInput?.addEventListener('change', aiImportHistory);
  elements.exportAiConfigBtn?.addEventListener('click', aiExportConfig);
  elements.syncAiConfigBtn?.addEventListener('click', aiSyncConfig);
  elements.importAiConfigBtn?.addEventListener('click', () => elements.importAiConfigInput?.click());
  elements.importAiConfigInput?.addEventListener('change', aiImportConfigFile);
  elements.pasteAiConfigBtn?.addEventListener('click', aiImportConfigClipboard);
  elements.aiPromptInput?.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); elements.aiComposer?.requestSubmit(); } });
  queueMicrotask(syncEnhancedSelects);
}

function aiActiveConversation() {
  const workbench = state.aiWorkbench;
  return workbench?.conversations.find((entry) => entry.id === workbench.activeId) || workbench?.conversations[0] || null;
}

function aiConversationById(conversationId) {
  const workbench = state.aiWorkbench;
  if (!workbench) return null;
  return workbench.conversations.find((entry) => entry.id === conversationId) || null;
}

function aiPersist() {
  const workbench = state.aiWorkbench;
  if (!workbench) return;
  try {
    localStorage.setItem(AI_CONFIG_STORAGE_KEY, JSON.stringify(workbench.config));
    localStorage.setItem(AI_HISTORY_STORAGE_KEY, JSON.stringify(aiNormalizeConversations(workbench.conversations)));
  } catch (_) {
    if (elements.aiConfigStatus) elements.aiConfigStatus.textContent = '本地存储空间不足；文本已保留到当前会话，较大的生成结果不会持久保存。';
  }
}

function aiOpenWorkbench() {
  if (!state.authenticated || !state.token) return toast('请先登录后使用 AI 工作台', 'error');
  elements.aiWorkbenchModal?.classList.remove('is-hidden');
  aiRenderModelCatalog(); aiRenderConversationList(); aiRenderMessages();
  const workbench = state.aiWorkbench;
  if (workbench?.config.baseUrl && workbench.config.apiKey && !workbench.models.length && !workbench.modelAutoLoadAttempted) {
    workbench.modelAutoLoadAttempted = true;
    queueMicrotask(() => aiRefreshModels(false));
  }
  requestAnimationFrame(() => elements.aiPromptInput?.focus());
}

function aiCloseWorkbench() {
  elements.aiWorkbenchModal?.classList.add('is-hidden');
}

function aiModelKey(mode = state.aiWorkbench?.mode) {
  return mode === 'image' ? 'imageModel' : mode === 'video' ? 'videoModel' : 'chatModel';
}

function aiRenderModelCatalog() {
  const workbench = state.aiWorkbench;
  if (!workbench) return;
  workbench.models = aiNormalizeModelCatalog(workbench.models);
  const current = String(workbench.config[aiModelKey()] || '').trim();
  const options = [...workbench.models];
  if (current && !options.includes(current)) options.unshift(current);
  if (elements.aiModelOptions) elements.aiModelOptions.innerHTML = options.map((model) => `<option value="${escapeHtml(model)}"></option>`).join('');
  if (elements.aiModelPicker) {
    elements.aiModelPicker.innerHTML = `<option value="">${workbench.models.length ? '选择已读取模型' : '尚未读取模型'}</option>${options.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}${!workbench.models.includes(model) ? '（自定义）' : ''}</option>`).join('')}`;
    elements.aiModelPicker.disabled = !options.length;
    elements.aiModelPicker.value = options.includes(current) ? current : '';
  }
  if (elements.aiActiveModel) elements.aiActiveModel.value = current;
  if (elements.aiModelSummary) {
    const updatedAt = workbench.config.modelCatalogUpdatedAt ? ` · ${formatDate(workbench.config.modelCatalogUpdatedAt)}` : '';
    elements.aiModelSummary.textContent = workbench.models.length ? `已读取 ${workbench.models.length} 个模型${updatedAt}` : '未读取到列表时可直接填写自定义模型';
  }
}

function aiSelectCatalogModel() {
  const value = String(elements.aiModelPicker?.value || '').trim();
  if (!value || !elements.aiActiveModel) return;
  elements.aiActiveModel.value = value;
  aiCommitActiveModel(); aiPersist();
}

function aiSetMode(mode) {
  const workbench = state.aiWorkbench;
  if (!workbench || !['chat', 'image', 'video'].includes(mode)) return;
  aiCommitActiveModel(); workbench.mode = mode;
  if (elements.aiWorkbenchTitle) elements.aiWorkbenchTitle.textContent = mode === 'image' ? 'AI 生图' : mode === 'video' ? 'AI 视频' : 'AI 聊天';
  if (elements.aiPromptInput) elements.aiPromptInput.placeholder = mode === 'image' ? '描述希望生成的图片内容、风格和构图…' : mode === 'video' ? '描述视频主体、镜头运动和画面变化…' : '输入想和 AI 讨论的内容…';
  if (elements.aiActiveModel) elements.aiActiveModel.value = workbench.config[aiModelKey(mode)] || '';
  elements.aiGenerationOptions?.classList.toggle('is-hidden', mode === 'chat');
  elements.aiGenerationOptions?.querySelectorAll('[data-ai-option]').forEach((label) => label.classList.toggle('is-hidden', label.dataset.aiOption !== mode));
  elements.aiWorkbenchModal?.querySelectorAll('[data-ai-mode]').forEach((button) => button.classList.toggle('active', button.dataset.aiMode === mode));
  if (elements.sendAiPromptBtn) elements.sendAiPromptBtn.textContent = mode === 'image' ? '生成图片' : mode === 'video' ? '生成视频' : '发送';
  aiRenderModelCatalog(); aiRenderMessages(); queueMicrotask(syncEnhancedSelects);
}

function aiFillConfigForm() {
  const config = state.aiWorkbench?.config || aiDefaultConfig();
  const map = {
    aiBaseUrl: 'baseUrl', aiApiKey: 'apiKey', aiImageBaseUrl: 'imageBaseUrl', aiImageApiKey: 'imageApiKey', aiVideoBaseUrl: 'videoBaseUrl', aiVideoApiKey: 'videoApiKey',
    aiProtocol: 'protocol', aiModelsPath: 'modelsPath', aiResponsesPath: 'responsesPath',
    aiChatPath: 'chatPath', aiImagePath: 'imagePath', aiVideoPath: 'videoPath', aiChatModel: 'chatModel', aiImageModel: 'imageModel',
    aiVideoModel: 'videoModel', aiSystemPrompt: 'systemPrompt', aiImageSize: 'imageSize', aiImageQuality: 'imageQuality', aiVideoSize: 'videoSize', aiVideoSeconds: 'videoSeconds'
  };
  for (const [id, key] of Object.entries(map)) if (elements[id]) elements[id].value = String(config[key] ?? '');
  if (elements.aiActiveModel) elements.aiActiveModel.value = config[aiModelKey()] || '';
  aiRenderModelCatalog();
}

function aiSaveConfig(showNotice = false) {
  const workbench = state.aiWorkbench;
  if (!workbench) return false;
  aiCommitActiveModel();
  const fieldMap = {
    baseUrl: 'aiBaseUrl', apiKey: 'aiApiKey', imageBaseUrl: 'aiImageBaseUrl', imageApiKey: 'aiImageApiKey', videoBaseUrl: 'aiVideoBaseUrl', videoApiKey: 'aiVideoApiKey',
    protocol: 'aiProtocol', modelsPath: 'aiModelsPath', responsesPath: 'aiResponsesPath',
    chatPath: 'aiChatPath', imagePath: 'aiImagePath', videoPath: 'aiVideoPath', chatModel: 'aiChatModel', imageModel: 'aiImageModel',
    videoModel: 'aiVideoModel', systemPrompt: 'aiSystemPrompt', imageSize: 'aiImageSize', imageQuality: 'aiImageQuality', videoSize: 'aiVideoSize', videoSeconds: 'aiVideoSeconds'
  };
  for (const [key, id] of Object.entries(fieldMap)) workbench.config[key] = String(elements[id]?.value || '').trim();
  try {
    for (const key of ['baseUrl', 'imageBaseUrl', 'videoBaseUrl']) if (workbench.config[key]) workbench.config[key] = aiNormalizeBaseUrl(workbench.config[key]);
    for (const key of ['modelsPath', 'responsesPath', 'chatPath', 'imagePath', 'videoPath']) {
      const value = workbench.config[key];
      if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,240}$/.test(value) || value.includes('..') || value.includes('//')) {
        const label = { modelsPath: '模型列表', responsesPath: 'Responses', chatPath: '聊天兼容', imagePath: '图片生成', videoPath: '视频生成' }[key];
        throw new Error(`${label}接口路径格式不正确`);
      }
    }
  } catch (error) {
    elements.aiConfigStatus.textContent = error.message;
    if (showNotice) toast(error.message, 'error');
    return false;
  }
  for (const [id, key] of [['aiBaseUrl', 'baseUrl'], ['aiImageBaseUrl', 'imageBaseUrl'], ['aiVideoBaseUrl', 'videoBaseUrl']]) if (elements[id]) elements[id].value = workbench.config[key];
  aiPersist();
  elements.aiConfigStatus.textContent = '配置已保存在当前设备，API 密钥不会写入服务器数据文件。';
  if (showNotice) toast('AI 配置已保存', 'success');
  return true;
}

function aiCommitActiveModel() {
  const workbench = state.aiWorkbench;
  if (!workbench || !elements.aiActiveModel) return;
  const value = String(elements.aiActiveModel.value || '').trim().slice(0, 160);
  workbench.config[aiModelKey(workbench.mode)] = value;
  const form = elements[workbench.mode === 'image' ? 'aiImageModel' : workbench.mode === 'video' ? 'aiVideoModel' : 'aiChatModel'];
  if (form) form.value = value;
  if (elements.aiModelPicker) elements.aiModelPicker.value = workbench.models.includes(value) ? value : '';
}

function aiToggleConfig() {
  const open = elements.aiConfigPanel.classList.toggle('is-hidden') === false;
  elements.toggleAiConfigBtn.setAttribute('aria-expanded', String(open));
  elements.toggleAiConfigBtn.textContent = open ? '收起配置' : 'API 配置';
}

function aiRenderConversationList() {
  const workbench = state.aiWorkbench;
  if (!workbench || !elements.aiConversationList) return;
  workbench.conversations.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  elements.aiConversationList.innerHTML = workbench.conversations.map((entry) => `<button class="ai-conversation-item ${entry.id === workbench.activeId ? 'active' : ''}" data-ai-conversation-id="${escapeHtml(entry.id)}" type="button"><strong>${escapeHtml(entry.title)}</strong><small>${formatDate(entry.updatedAt)} · ${entry.messages.length} 条</small></button>`).join('');
}

function aiRenderMessages() {
  const conversation = aiActiveConversation();
  if (!elements.aiMessages) return;
  const messages = conversation?.messages || [];
  if (!messages.length) {
    const mode = state.aiWorkbench?.mode || 'chat';
    elements.aiMessages.innerHTML = `<div class="ai-empty-state"><span aria-hidden="true">AI</span><strong>${mode === 'image' ? '把画面描述清楚' : mode === 'video' ? '从一个镜头开始' : '开始一段新对话'}</strong><p>${mode === 'chat' ? '选择模型后输入问题，回答和配置会保存在当前设备。' : '生成任务通过服务器中转提交，不占用房间视频带宽。'}</p></div>`;
    return;
  }
  elements.aiMessages.innerHTML = messages.map((message) => {
    const roleLabel = message.role === 'user' ? '你' : message.kind === 'error' ? '请求失败' : 'AI 助手';
    const images = (message.images || []).map((url) => `<figure><img src="${escapeHtml(url)}" alt="AI 生成图片" loading="lazy"><a class="secondary-button" href="${escapeHtml(url)}" download target="_blank" rel="noopener">下载/打开</a></figure>`).join('');
    const video = message.videoUrl ? `<video controls preload="metadata" src="${escapeHtml(message.videoUrl)}"></video><a class="secondary-button" href="${escapeHtml(message.videoUrl)}" target="_blank" rel="noopener">打开视频</a>` : '';
    const status = message.status ? `<small class="ai-job-status">任务状态：${escapeHtml(message.status)}${message.videoId ? ` · ${escapeHtml(message.videoId)}` : ''}</small>` : '';
    return `<article class="ai-message ${message.role === 'user' ? 'mine' : ''} ${message.kind === 'error' ? 'error' : ''}" data-ai-message-id="${escapeHtml(message.id)}"><header><strong>${roleLabel}</strong><time>${formatDate(message.createdAt)}</time></header>${message.content ? `<p>${escapeHtml(message.content).replace(/\n/g, '<br>')}</p>` : ''}${images ? `<div class="ai-image-grid">${images}</div>` : ''}${video}${status}</article>`;
  }).join('');
  elements.aiMessages.scrollTop = elements.aiMessages.scrollHeight;
}

function aiSelectConversation(event) {
  const button = event.target.closest('[data-ai-conversation-id]');
  if (!button || !state.aiWorkbench) return;
  state.aiWorkbench.activeId = button.dataset.aiConversationId;
  aiRenderConversationList(); aiRenderMessages();
}

function aiNewConversation() {
  const conversation = aiCreateConversation();
  state.aiWorkbench.conversations.unshift(conversation); state.aiWorkbench.conversations = state.aiWorkbench.conversations.slice(0, AI_MAX_CONVERSATIONS);
  state.aiWorkbench.activeId = conversation.id; aiPersist(); aiRenderConversationList(); aiRenderMessages(); elements.aiPromptInput?.focus();
}

async function aiRenameConversation() {
  const conversation = aiActiveConversation();
  if (!conversation) return;
  const title = await showAppInput({ title: '重命名 AI 对话', label: '对话名称', initialValue: conversation.title, maxLength: 60, confirmText: '保存' });
  if (title === null) return;
  conversation.title = String(title || '新对话').trim().slice(0, 60) || '新对话'; conversation.updatedAt = new Date().toISOString();
  aiPersist(); aiRenderConversationList();
}

async function aiDeleteConversation() {
  const conversation = aiActiveConversation();
  if (!conversation || !await showAppConfirm(`确定删除“${conversation.title}”及其全部本地记录吗？`, { title: '删除 AI 对话', confirmText: '删除', danger: true })) return;
  aiCancelVideoPolls(conversation.id);
  state.aiWorkbench.conversations = state.aiWorkbench.conversations.filter((entry) => entry.id !== conversation.id);
  if (!state.aiWorkbench.conversations.length) state.aiWorkbench.conversations.push(aiCreateConversation());
  state.aiWorkbench.activeId = state.aiWorkbench.conversations[0].id; aiPersist(); aiRenderConversationList(); aiRenderMessages();
}

async function aiClearConversation() {
  const conversation = aiActiveConversation();
  if (!conversation?.messages.length || !await showAppConfirm('清空当前 AI 对话中的全部消息？', { title: '清空对话', confirmText: '清空', danger: true })) return;
  conversation.messages = []; conversation.updatedAt = new Date().toISOString(); aiPersist(); aiRenderConversationList(); aiRenderMessages();
}

function aiAddMessage(message, conversationId = '') {
  const conversation = conversationId ? aiConversationById(conversationId) : aiActiveConversation();
  if (!conversation) return null;
  const entry = {
    id: typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `msg-${Date.now()}-${Math.random()}`,
    role: message.role || 'assistant', kind: message.kind || 'text', content: String(message.content || '').slice(0, 50000),
    createdAt: new Date().toISOString(), images: Array.isArray(message.images) ? message.images.slice(0, 4) : [],
    videoUrl: message.videoUrl || '', videoId: message.videoId || '', status: message.status || ''
  };
  conversation.messages.push(entry); conversation.messages = conversation.messages.slice(-AI_MAX_MESSAGES);
  if (conversation.title === '新对话' && entry.role === 'user' && entry.content) conversation.title = entry.content.replace(/\s+/g, ' ').slice(0, 28);
  conversation.updatedAt = entry.createdAt; aiPersist(); aiRenderConversationList(); aiRenderMessages();
  return entry;
}

function aiSetBusy(busy, label = '') {
  const workbench = state.aiWorkbench;
  if (!workbench) return;
  workbench.busy = busy;
  elements.sendAiPromptBtn.disabled = busy; elements.refreshAiModelsBtn.disabled = busy;
  if (elements.testAiConnectionBtn) elements.testAiConnectionBtn.disabled = busy;
  if (elements.saveAiConfigBtn) elements.saveAiConfigBtn.disabled = busy;
  elements.stopAiRequestBtn.classList.toggle('is-hidden', !busy);
  elements.aiRequestStatus.textContent = label || (busy ? '正在请求…' : '准备就绪');
}

async function aiApiRequest(path, payload, timeoutMs = 180000, requestContext = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const foreground = !requestContext;
  if (requestContext) requestContext.controller = controller;
  else state.aiWorkbench.abortController = controller;
  try {
    const response = await fetch(path, {
      method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload), signal: controller.signal
    });
    let body = {};
    try { body = await response.json(); } catch (_) {}
    if (!response.ok || body.success === false) throw new Error(body.error || `AI 服务返回 ${response.status}`);
    return body;
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (controller.syncWatchManualAbort) throw new Error('请求已手动停止');
      throw new Error(`请求超过 ${Math.max(1, Math.round(timeoutMs / 1000))} 秒未完成，请检查中转地址、模型服务和服务器网络`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (foreground) {
      if (state.aiWorkbench?.abortController === controller) state.aiWorkbench.abortController = null;
    } else if (requestContext?.controller === controller) {
      requestContext.controller = null;
    }
  }
}

function aiRequestConfig() {
  aiSaveConfig(false);
  const config = state.aiWorkbench.config;
  const mode = state.aiWorkbench.mode;
  const baseUrl = mode === 'image' ? config.imageBaseUrl || config.baseUrl : mode === 'video' ? config.videoBaseUrl || config.baseUrl : config.baseUrl;
  const apiKey = mode === 'image' ? config.imageApiKey || config.apiKey : mode === 'video' ? config.videoApiKey || config.apiKey : config.apiKey;
  if (!baseUrl || !apiKey) throw new Error(`请先填写${mode === 'image' ? '生图' : mode === 'video' ? '视频' : '对话'} API 的 HTTPS 中转地址和密钥`);
  const model = config[aiModelKey()];
  if (!model) throw new Error('请填写或选择当前模式使用的模型');
  return { ...config, baseUrl, apiKey, model };
}

async function aiSubmitPrompt(event) {
  event.preventDefault();
  const workbench = state.aiWorkbench;
  const prompt = String(elements.aiPromptInput.value || '').trim();
  if (!workbench || workbench.busy || !prompt) return;
  // Keep the result attached to the conversation where the request started;
  // users can switch conversations while a provider is still working.
  const conversationId = workbench.activeId;
  let config;
  try { config = aiRequestConfig(); } catch (error) { toast(error.message, 'error'); aiToggleConfig(); return; }
  elements.aiPromptInput.value = '';
  aiAddMessage({ role: 'user', kind: 'text', content: prompt }, conversationId);
  aiSetBusy(true, workbench.mode === 'image' ? '正在生成图片…' : workbench.mode === 'video' ? '正在创建视频任务…' : 'AI 正在思考…');
  try {
    if (workbench.mode === 'image') await aiGenerateImage(prompt, config, conversationId);
    else if (workbench.mode === 'video') await aiGenerateVideo(prompt, config, conversationId);
    else await aiGenerateChat(config, conversationId);
  } catch (error) {
    aiAddMessage({ role: 'assistant', kind: 'error', content: localizedError(error, 'AI 请求失败') }, conversationId);
  } finally { aiSetBusy(false); }
}

async function aiGenerateChat(config, conversationId = state.aiWorkbench?.activeId) {
  const conversation = aiConversationById(conversationId) || aiActiveConversation();
  const messages = conversation.messages.filter((entry) => entry.kind === 'text' && ['user', 'assistant'].includes(entry.role)).slice(-60).map((entry) => ({ role: entry.role, content: entry.content }));
  const result = await aiApiRequest('/api/ai/chat', {
    baseUrl: config.baseUrl, apiKey: config.apiKey, protocol: config.protocol, model: config.chatModel,
    modelsPath: config.modelsPath, responsesPath: config.responsesPath, chatPath: config.chatPath,
    systemPrompt: config.systemPrompt, messages
  }, 3 * 60 * 1000);
  aiAddMessage({ role: 'assistant', kind: 'text', content: result.text || 'AI 没有返回可显示的文本。' }, conversationId);
}

async function aiGenerateImage(prompt, config, conversationId = state.aiWorkbench?.activeId) {
  const result = await aiApiRequest('/api/ai/image', {
    baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.imageModel, imagePath: config.imagePath,
    prompt, n: 1, size: config.imageSize, quality: config.imageQuality, responseFormat: 'b64_json'
  }, 8 * 60 * 1000);
  const images = (Array.isArray(result.images) ? result.images : []).map((entry) => {
    if (/^https:\/\//i.test(String(entry?.url || ''))) return String(entry.url);
    if (entry?.b64_json) return `data:image/png;base64,${entry.b64_json}`;
    return '';
  }).filter(Boolean);
  if (!images.length) throw new Error('图片生成成功，但服务没有返回可显示的图片');
  aiAddMessage({ role: 'assistant', kind: 'image', content: '图片已生成。', images }, conversationId);
}

function aiFindUrl(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return '';
  if (typeof value === 'string') return /^https:\/\//i.test(value) ? value : '';
  if (Array.isArray(value)) for (const entry of value) { const found = aiFindUrl(entry, depth + 1); if (found) return found; }
  if (typeof value === 'object') {
    for (const key of ['url', 'video_url', 'download_url', 'output_url', 'content_url', 'asset_url']) {
      const found = aiFindUrl(value[key], depth + 1); if (found) return found;
    }
    for (const entry of Object.values(value)) { const found = aiFindUrl(entry, depth + 1); if (found) return found; }
  }
  return '';
}

function aiVideoStatus(video) {
  return String(video?.status || video?.state || video?.data?.status || '').toLocaleLowerCase();
}

async function aiGenerateVideo(prompt, config, conversationId = state.aiWorkbench?.activeId) {
  const result = await aiApiRequest('/api/ai/video', {
    action: 'create', baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.videoModel,
    videoPath: config.videoPath, prompt, size: config.videoSize, seconds: Number(config.videoSeconds)
  }, 10 * 60 * 1000);
  const video = result.video || {};
  const videoId = String(video.id || video.video_id || video.data?.id || '');
  const videoUrl = aiFindUrl(video);
  const entry = aiAddMessage({ role: 'assistant', kind: 'video', content: videoUrl ? '视频已生成。' : '视频任务已提交，正在等待生成。', videoId, videoUrl, status: aiVideoStatus(video) || (videoUrl ? 'completed' : 'queued') }, conversationId);
  if (!videoUrl && videoId && entry) aiPollVideo(entry.id, videoId, config, Date.now() + 30 * 60 * 1000, conversationId);
}

function aiCancelVideoPolls(conversationId = '') {
  const workbench = state.aiWorkbench;
  if (!workbench?.videoPollers) return;
  for (const [key, task] of workbench.videoPollers) {
    if (conversationId && task.conversationId !== conversationId) continue;
    task.cancelled = true;
    if (task.timer) clearTimeout(task.timer);
    task.controller?.abort();
    workbench.videoPollers.delete(key);
  }
}

function aiPollVideo(messageId, videoId, config, deadline, conversationId = state.aiWorkbench?.activeId) {
  const workbench = state.aiWorkbench;
  if (!workbench) return;
  if (!(workbench.videoPollers instanceof Map)) workbench.videoPollers = new Map();
  const key = aiVideoPollKey(conversationId, messageId);
  const previous = workbench.videoPollers.get(key);
  if (previous?.timer) clearTimeout(previous.timer);
  const task = previous || {
    key, conversationId, messageId, videoId, config, deadline, timer: null, controller: null, cancelled: false
  };
  task.conversationId = conversationId; task.messageId = messageId; task.videoId = videoId;
  task.config = config; task.deadline = deadline; task.cancelled = false;
  workbench.videoPollers.set(key, task);
  task.timer = setTimeout(async () => {
    task.timer = null;
    if (task.cancelled) return;
    const conversation = aiConversationById(task.conversationId);
    const message = conversation?.messages.find((entry) => entry.id === task.messageId);
    if (!message || Date.now() > task.deadline) {
      workbench.videoPollers.delete(task.key);
      return;
    }
    try {
      const result = await aiApiRequest('/api/ai/video', {
        action: 'status', baseUrl: task.config.baseUrl, apiKey: task.config.apiKey,
        videoPath: task.config.videoPath, videoId: task.videoId
      }, 60000, task);
      if (task.cancelled) {
        workbench.videoPollers.delete(task.key);
        return;
      }
      const video = result.video || {};
      message.status = aiVideoStatus(video) || message.status; message.videoUrl = aiFindUrl(video) || message.videoUrl;
      if (message.videoUrl) message.content = '视频已生成。';
      conversation.updatedAt = new Date().toISOString(); aiPersist(); aiRenderConversationList();
      if (workbench.activeId === task.conversationId) aiRenderMessages();
      const terminal = ['failed', 'cancelled', 'canceled', 'error'].includes(message.status);
      if (!message.videoUrl && !terminal && Date.now() < task.deadline) aiPollVideo(task.messageId, task.videoId, task.config, task.deadline, task.conversationId);
      else workbench.videoPollers.delete(task.key);
    } catch (error) {
      if (task.cancelled) {
        workbench.videoPollers.delete(task.key);
        return;
      }
      message.status = localizedError(error, '状态查询失败'); aiPersist(); aiRenderConversationList();
      if (workbench.activeId === task.conversationId) aiRenderMessages();
      if (Date.now() < task.deadline) aiPollVideo(task.messageId, task.videoId, task.config, task.deadline, task.conversationId);
      else workbench.videoPollers.delete(task.key);
    }
  }, 5000);
}

function aiStopRequest() {
  const workbench = state.aiWorkbench;
  const controller = workbench?.abortController;
  if (controller) controller.syncWatchManualAbort = true;
  controller?.abort();
  // Stop foreground work and only the active conversation's polling jobs;
  // background jobs in other conversations continue to update their history.
  aiCancelVideoPolls(workbench?.activeId || '');
  aiSetBusy(false, '已停止当前等待');
}

function aiSuggestedModel(models, mode) {
  const imagePattern = /(dall|image|imagen|flux|stable[-_. ]?diffusion|sdxl)/i;
  const videoPattern = /(video|sora|veo|kling|hailuo|runway|wan[-_. ]?\d)/i;
  if (mode === 'image') return models.find((model) => imagePattern.test(model)) || '';
  if (mode === 'video') return models.find((model) => videoPattern.test(model)) || '';
  return models.find((model) => !imagePattern.test(model) && !videoPattern.test(model)) || models[0] || '';
}

async function aiRefreshModels(testOnly = false) {
  if (state.aiWorkbench?.busy) return;
  if (!aiSaveConfig(false)) return;
  const config = state.aiWorkbench.config;
  if (!config.baseUrl || !config.apiKey) { aiToggleConfig(); return toast('请先填写 API 地址和密钥', 'error'); }
  aiSetBusy(true, '正在读取模型列表…');
  try {
    const result = await aiApiRequest('/api/ai/models', { baseUrl: config.baseUrl, apiKey: config.apiKey, modelsPath: config.modelsPath }, 60000);
    state.aiWorkbench.models = aiNormalizeModelCatalog(result.models);
    state.aiWorkbench.modelAutoLoadAttempted = true;
    config.modelCatalog = state.aiWorkbench.models;
    config.modelCatalogUpdatedAt = new Date().toISOString();
    if (!config.chatModel) config.chatModel = aiSuggestedModel(state.aiWorkbench.models, 'chat');
    if (!config.imageModel) config.imageModel = aiSuggestedModel(state.aiWorkbench.models, 'image');
    if (!config.videoModel) config.videoModel = aiSuggestedModel(state.aiWorkbench.models, 'video');
    aiFillConfigForm(); aiPersist();
    const endpointText = result.endpoint ? `接口 ${result.endpoint}` : '模型接口';
    if (state.aiWorkbench.models.length) {
      elements.aiConfigStatus.textContent = `连接成功，${endpointText}已返回 ${state.aiWorkbench.models.length} 个模型。`;
      toast(testOnly ? `AI 连接测试成功，读取到 ${state.aiWorkbench.models.length} 个模型` : `已读取 ${state.aiWorkbench.models.length} 个模型`, 'success');
    } else {
      elements.aiConfigStatus.textContent = `${endpointText}连接成功，但中转服务没有公开模型列表。请在“当前模型”中填写服务商提供的模型 ID。`;
      toast('接口已连接，但未返回模型列表；可手动填写模型 ID', 'success');
    }
  } catch (error) {
    const message = localizedError(error, 'AI 连接失败'); elements.aiConfigStatus.textContent = message; toast(message, 'error');
  } finally { aiSetBusy(false); }
}

function aiExportHistory() {
  const payload = { format: 'syncwatch-ai-history', version: 2, exportedAt: new Date().toISOString(), conversations: aiNormalizeConversations(state.aiWorkbench?.conversations || []) };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `SyncWatch同步观影-AI-${new Date().toISOString().slice(0, 10)}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function aiImportHistory(event) {
  const file = event.target.files?.[0]; event.target.value = '';
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    if (payload?.format !== 'syncwatch-ai-history' || !Array.isArray(payload.conversations)) throw new Error('不是有效的 SyncWatch同步观影 AI 历史文件');
    const imported = aiNormalizeConversations(payload.conversations);
    if (!imported.length) throw new Error('导入文件中没有对话记录');
    aiCancelVideoPolls();
    state.aiWorkbench.conversations = imported; state.aiWorkbench.activeId = imported[0].id; aiPersist(); aiRenderConversationList(); aiRenderMessages(); toast(`已导入 ${imported.length} 个 AI 对话`, 'success');
  } catch (error) { toast(localizedError(error, 'AI 历史导入失败'), 'error'); }
}

function aiDownloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.rel = 'noopener';
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function aiApplyImportedConfig(imported, sourceLabel = '配置') {
  const workbench = state.aiWorkbench;
  if (!workbench) throw new Error('AI 工作台尚未初始化');
  const fields = Object.keys(imported);
  const connectionChanged = (imported.baseUrl && imported.baseUrl !== workbench.config.baseUrl)
    || (imported.imageBaseUrl && imported.imageBaseUrl !== workbench.config.imageBaseUrl)
    || (imported.videoBaseUrl && imported.videoBaseUrl !== workbench.config.videoBaseUrl)
    || (imported.apiKey && imported.apiKey !== workbench.config.apiKey)
    || (imported.imageApiKey && imported.imageApiKey !== workbench.config.imageApiKey)
    || (imported.videoApiKey && imported.videoApiKey !== workbench.config.videoApiKey);
  Object.assign(workbench.config, imported);
  if (Array.isArray(imported.modelCatalog)) workbench.models = aiNormalizeModelCatalog(imported.modelCatalog);
  else if (connectionChanged) { workbench.models = []; workbench.config.modelCatalog = []; workbench.config.modelCatalogUpdatedAt = ''; }
  workbench.modelAutoLoadAttempted = false;
  aiFillConfigForm(); aiPersist(); queueMicrotask(syncEnhancedSelects);
  if (elements.aiConfigStatus) elements.aiConfigStatus.textContent = `${sourceLabel}已识别：${fields.map((field) => ({ baseUrl: '地址', apiKey: '密钥', chatModel: '聊天模型', imageModel: '图片模型', videoModel: '视频模型' }[field] || field)).join('、')}`;
  toast(`已导入 AI ${sourceLabel}`, 'success');
}

async function aiExportConfig() {
  if (!aiSaveConfig(false)) return;
  const config = state.aiWorkbench?.config;
  if (!config) return;
  const exported = aiShareableConfig(config);
  aiDownloadJson({ format: AI_CONFIG_FORMAT, version: 2, exportedAt: new Date().toISOString(), secretsIncluded: false, config: exported }, `SyncWatch同步观影-AI-Config-${new Date().toISOString().slice(0, 10)}.json`);
  if (elements.aiConfigStatus) elements.aiConfigStatus.textContent = '配置已安全导出，文件不包含任何 API 密钥。';
}

function aiShareableConfig(config = state.aiWorkbench?.config || {}) {
  const { apiKey: _chatSecret, imageApiKey: _imageSecret, videoApiKey: _videoSecret, ...shareable } = config;
  return { ...shareable, modelCatalog: aiNormalizeModelCatalog(shareable.modelCatalog) };
}

async function aiSyncConfig() {
  if (!state.authenticated || !state.socketAuthenticated) return toast('请先登录并进入房间后同步 AI 配置', 'error');
  if (!aiSaveConfig(false)) return;
  const scope = await showAppSelect({
    title: '选择 AI 配置同步范围', description: '每个接收者都会单独收到确认请求，只有同意的设备才会收到完整配置。', label: '同步范围',
    options: [
      { value: 'room', label: '当前房间的在线成员' },
      { value: 'online', label: '当前服务器的所有在线用户' }
    ],
    initialValue: 'room', confirmText: '下一步', cancelText: '取消'
  });
  if (scope === null) return;
  const decision = await openAppDialog({
    mode: 'confirm', description: `将向${scope === 'online' ? '当前服务器的所有在线用户' : '当前房间成员'}发送同步请求。对方同意后，服务器才会从内存中一次性转交包含 API 密钥的完整配置；配置不写入服务器文件或日志。`,
    title: '安全同步 AI 完整配置', confirmText: '发送同步请求', cancelText: '取消', allowBack: true
  });
  if (decision === APP_DIALOG_BACK) return aiSyncConfig();
  if (decision !== true) return;
  if (elements.syncAiConfigBtn) elements.syncAiConfigBtn.disabled = true;
  try {
    const result = await emitAck('ai-config-sync-request', {
      scope,
      config: { ...state.aiWorkbench.config, modelCatalog: aiNormalizeModelCatalog(state.aiWorkbench.config.modelCatalog) },
      preview: aiShareableConfig(state.aiWorkbench.config)
    }, 20000);
    toast(result.message || result.error || (result.success ? '同步请求已发送' : '同步请求发送失败'), result.success ? 'success' : 'error', 7000);
  } finally { if (elements.syncAiConfigBtn) elements.syncAiConfigBtn.disabled = false; }
}

async function aiHandleConfigSyncRequest(request = {}) {
  const preview = request.preview && typeof request.preview === 'object' ? request.preview : {};
  const previewText = [preview.baseUrl, preview.chatModel, preview.imageModel, preview.videoModel].filter(Boolean).join(' · ');
  const actor = String(request.displayName || request.username || '房间成员');
  void window.SyncWatchDesktop?.showNotification?.({ title: 'SyncWatch AI 配置申请', body: `${actor} 请求向您同步 AI 配置。` }).catch(() => {});
  const accepted = await showAppConfirm(`${actor} 希望向您同步完整 AI 配置${previewText ? `：${previewText}` : ''}。同意后服务器才会在内存中转交包含 API 密钥的配置，密钥会保存到当前设备并始终遮罩，服务器不持久化。`, {
    title: 'AI 完整配置同步请求', confirmText: '同意并安全接收', cancelText: '拒绝'
  });
  const result = await emitAck('ai-config-sync-response', { requestId: request.id, accepted }, 12000);
  if (!result.success) toast(result.error || '同步结果反馈失败', 'error');
  if (accepted && result.config) aiHandleConfigSyncDelivered({ ...result, displayName: actor });
}

function aiHandleConfigSyncDelivered(payload = {}) {
  const raw = payload.config && typeof payload.config === 'object' ? payload.config : null;
  if (!raw) return toast('AI 配置同步已同意，但没有收到可用配置', 'error');
  try {
    const imported = aiNormalizeImportedConfig(raw);
    aiApplyImportedConfig(imported, `${payload.displayName || payload.username || '房间成员'} 的完整同步配置`);
    if (elements.aiConfigStatus) elements.aiConfigStatus.textContent = '完整配置已安全接收，API 密钥已保存到当前设备并保持遮罩。';
  } catch (error) { toast(localizedError(error, 'AI 同步配置无法应用'), 'error'); }
}

function aiHandleConfigSyncResolved(result = {}) {
  const actor = result.displayName || result.username || '房间成员';
  toast(`${actor}${result.accepted ? '已同意并应用' : '已拒绝'} AI 配置同步`, result.accepted ? 'success' : '', 7000);
}

function aiBindSocketEvents(socket) {
  if (!socket || socket.__syncWatchAiConfigBound) return;
  socket.__syncWatchAiConfigBound = true;
  socket.on('ai-config-sync-requested', aiHandleConfigSyncRequest);
  socket.on('ai-config-sync-delivered', aiHandleConfigSyncDelivered);
  socket.on('ai-config-sync-resolved', aiHandleConfigSyncResolved);
}

function aiImportConfigText(text, sourceLabel = '配置') {
  try {
    const imported = aiParseConfigText(text);
    aiApplyImportedConfig(imported, sourceLabel);
    return true;
  } catch (error) {
    const message = localizedError(error, 'AI 配置导入失败');
    if (elements.aiConfigStatus) elements.aiConfigStatus.textContent = message;
    toast(message, 'error');
    return false;
  }
}

async function aiImportConfigFile(event) {
  const file = event.target.files?.[0]; event.target.value = '';
  if (!file) return;
  try { aiImportConfigText(await file.text(), '配置文件'); }
  catch (error) { toast(localizedError(error, 'AI 配置文件读取失败'), 'error'); }
}

async function aiImportConfigClipboard() {
  let text = '';
  try {
    if (typeof readClipboardTextFromAvailableSources === 'function') text = await readClipboardTextFromAvailableSources();
    else if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function') text = await navigator.clipboard.readText();
  } catch (_) {}
  if (!text && typeof showAppInput === 'function') {
    text = await showAppInput({ title: '识别剪贴板配置', description: '读取剪贴板失败时，可直接粘贴 JSON、.env 或 API 地址/密钥。', label: '配置内容', placeholder: '粘贴配置内容', maxLength: 128 * 1024, confirmText: '识别导入' });
  }
  if (text) aiImportConfigText(text, '剪贴板配置');
  else toast('没有读取到剪贴板内容，请先复制 AI 配置后重试', 'error');
}

if (typeof module !== 'undefined' && module.exports) module.exports = {
  aiDefaultConfig,
  aiNormalizeBaseUrl,
  aiNormalizeImportedConfig,
  aiNormalizeModelCatalog,
  aiParseConfigText,
  aiVideoPollKey
};
