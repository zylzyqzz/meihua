import { useEffect, useState } from 'react';
import type { AppSettings, ProviderSecretStatus } from '@meihua/core-types';
import { adminRequest as api } from './adminApi.js';
import { AvatarClonePage, DigitalHumanSelectionPage, VoiceClonePage } from './digital-human/pages.js';
import { useDigitalHumanCenter } from './digital-human/useDigitalHumanCenter.js';
import './digital-human.css';

type Section = 'voice' | 'avatar' | 'selection';

const sections: Array<{ id: Section; label: string; note: string }> = [
  { id: 'voice', label: '声音克隆', note: '选择语言，上传素材' },
  { id: 'avatar', label: '数字人克隆', note: '上传正面人物视频' },
  { id: 'selection', label: '选择使用', note: '选择人物和声音' },
];

const speechTargetPresets = [20, 30, 40, 60] as const;

function speechBudgetDescription(seconds: number): string {
  const target = Math.max(10, Math.min(120, Math.round(seconds)));
  // Keep the operator preview aligned with answer-composer's direct-result
  // content contract: 20/30 seconds now reserve 60% more spoken units.
  const contentMultiplier = 1.6;
  const zh = Math.round(target * 2.2 * contentMultiplier);
  const en = Math.round(target * 1.05 * contentMultiplier);
  return `中文约 ${Math.floor(zh * 0.88)}–${Math.ceil(zh * 1.12)} 字（目标 ${zh} 字）；英文约 ${Math.floor(en * 0.88)}–${Math.ceil(en * 1.12)} 词`;
}

function TextModelConfig() {
  const [settings, setSettings] = useState<AppSettings>();
  const [secretStatus, setSecretStatus] = useState<ProviderSecretStatus>();
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    void Promise.all([
      api<AppSettings>('/api/settings'),
      api<ProviderSecretStatus>('/api/providers/secrets/status'),
    ]).then(([nextSettings, nextSecrets]) => {
      setSettings(nextSettings);
      setSecretStatus(nextSecrets);
    }).catch((error) => setMessage(error instanceof Error ? error.message : '文本模型配置读取失败'));
  }, []);

  const save = async (test: boolean) => {
    if (!settings) return;
    setBusy(test ? 'test' : 'save');
    setMessage('');
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          providers: { llm: settings.providers.llm },
          moderation: { llmTimeoutMs: settings.moderation.llmTimeoutMs },
          reading: { speechTargetSeconds: settings.reading.speechTargetSeconds },
        }),
      });
      if (apiKey.trim()) {
        const nextSecrets = await api<ProviderSecretStatus>('/api/providers/secrets/llm', {
          method: 'PUT', body: JSON.stringify({ apiKey: apiKey.trim() }),
        });
        setSecretStatus(nextSecrets);
        setApiKey('');
      }
      if (test) {
        await api('/api/providers/llm/test', { method: 'POST', body: JSON.stringify({ text: '请用一句话确认文本模型配置已经生效。' }) });
        setMessage('文本模型已保存，并通过真实连接测试');
      } else {
        setMessage('文本模型配置已保存');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '文本模型配置失败');
    } finally {
      setBusy('');
    }
  };

  if (!settings) return <section className="dh-text-model-card"><div className="dh-text-model-copy"><div><b>数字人播报大模型接口</b><small>文本大模型 → 克隆声音 → 数字人实时渲染；配置会保存到本地数据库。</small></div></div><p className="dh-config-hint">正在读取数字人播报配置…</p>{message && <p className="dh-config-message">{message}</p>}</section>;
  const llm = settings.providers.llm;
  const voiceModel = settings.providers.tts.voiceCloneApi?.targetModel ?? settings.providers.tts.model;
  const avatarModel = settings.providers.avatar.cloneApi?.model ?? settings.providers.avatar.adapter;
  const speechTargetSeconds = Math.round(settings.reading.speechTargetSeconds);
  const durationOptions = [...new Set([...speechTargetPresets, speechTargetSeconds])].sort((a, b) => a - b);
  return <section className="dh-text-model-card">
    <div className="dh-text-model-copy"><div><b>文本模型配置</b><small>先生成统一目标语言文本，再交给声音与 MuseTalk 链路；配置会保存到本地数据库。</small></div><span className={`dh-config-state ${llm.adapter === 'rule-based' ? 'is-local' : secretStatus?.llm.configured ? 'is-ready' : 'is-warn'}`}>{llm.adapter === 'rule-based' ? '本地规则' : secretStatus?.llm.configured ? '密钥已保存' : '待配置'}</span></div>
    <div className="dh-broadcast-chain" aria-label="数字人播报链路">
      <div className="dh-broadcast-chain-title"><b>统一播报链路</b><small>大模型负责出稿，声音和口型使用同一条播报快照</small></div>
      <div className="dh-broadcast-chain-steps"><span><i>1</i><b>{llm.adapter === 'rule-based' ? '本地规则' : llm.model || 'qwen-plus'}</b><small>文本大模型</small></span><em>→</em><span><i>2</i><b>{voiceModel || '未配置'}</b><small>声音 / 目标口音</small></span><em>→</em><span><i>3</i><b>{avatarModel || '未配置'}</b><small>数字人渲染</small></span></div>
      <p>保存后直播会按这条链路生成；选择视频数字人时必须先通过对应服务的 READY 检查，不会自动切到 VRM。</p>
    </div>
    <div className="dh-text-model-grid">
      <label>内容生成方式<select value={llm.adapter} onChange={(event) => setSettings({ ...settings, providers: { ...settings.providers, llm: { ...llm, adapter: event.target.value as typeof llm.adapter } } })}><option value="rule-based">本地规则引擎（无需 API）</option><option value="openai-compatible">阿里云百炼 / OpenAI 兼容模型</option></select></label>
      <label>模型 ID<input value={llm.model} placeholder="例如 gpt-4o-mini" disabled={llm.adapter === 'rule-based'} onChange={(event) => setSettings({ ...settings, providers: { ...settings.providers, llm: { ...llm, model: event.target.value } } })} /></label>
      <label className="wide">接口地址<input value={llm.baseUrl} placeholder="https://api.openai.com/v1" disabled={llm.adapter === 'rule-based'} onChange={(event) => setSettings({ ...settings, providers: { ...settings.providers, llm: { ...llm, baseUrl: event.target.value } } })} /></label>
      <label>请求超时（毫秒）<input type="number" min={250} max={20000} value={settings.moderation.llmTimeoutMs} onChange={(event) => setSettings({ ...settings, moderation: { ...settings.moderation, llmTimeoutMs: Number(event.target.value) } })} /></label>
      <label>单条话术时长<select value={speechTargetSeconds} onChange={(event) => setSettings({ ...settings, reading: { ...settings.reading, speechTargetSeconds: Number(event.target.value) } })}>{durationOptions.map((seconds) => <option key={seconds} value={seconds}>{seconds} 秒{seconds === speechTargetSeconds ? '（当前）' : ''}</option>)}</select><small>{speechBudgetDescription(speechTargetSeconds)}；模型会按此预算生成，音频也按此时长校准。</small></label>
      <label className="wide">API Key<input type="password" autoComplete="new-password" value={apiKey} placeholder={secretStatus?.llm.configured ? '已由 Windows DPAPI 加密保存；留空不覆盖' : '输入阿里云百炼 API Key'} disabled={llm.adapter === 'rule-based'} onChange={(event) => setApiKey(event.target.value)} /><small>密钥不会写入前端配置，保存后只存 Windows DPAPI。</small></label>
      <div className="dh-text-model-actions"><button disabled={Boolean(busy)} onClick={() => void save(false)}>{busy === 'save' ? '保存中…' : '保存配置'}</button><button className="primary" disabled={Boolean(busy) || llm.adapter === 'rule-based' || !llm.baseUrl.trim() || !llm.model.trim()} onClick={() => void save(true)}>{busy === 'test' ? '测试中…' : '保存并测试连接'}</button></div>
    </div>
    {message && <p className="dh-config-message">{message}</p>}
  </section>;
}

const defaultVoiceCloneApi: NonNullable<AppSettings['providers']['tts']['voiceCloneApi']> = {
  provider: 'aliyun',
  baseUrl: 'https://dashscope.aliyuncs.com',
  model: 'qwen-voice-enrollment',
  targetModel: 'qwen3.5-omni-plus',
  region: 'cn-beijing',
  apiKeyEnv: 'DASHSCOPE_API_KEY',
  workspaceId: '',
  aliyun: { baseUrl: 'https://dashscope.aliyuncs.com', clonePath: '/api/v1/services/audio/tts/customization', synthesizePath: '/compatible-mode/v1/chat/completions', synthesizeStatusPath: '', protocol: 'ALIYUN_QWEN_OMNI', publicBaseUrl: '', model: 'qwen-voice-enrollment', targetModel: 'qwen3.5-omni-plus', region: 'cn-beijing', apiKeyEnv: 'DASHSCOPE_API_KEY', workspaceId: '' },
  baidu: { baseUrl: 'https://open.xiling.baidu.com', clonePath: '/api/digitalhuman/open/v1/tts/clone/v2', synthesizePath: '/api/digitalhuman/open/v1/tts/text2audio/submit', synthesizeStatusPath: '/api/digitalhuman/open/v1/tts/text2audio/task', protocol: 'BAIDU_XILING', uploadPath: '/api/digitalhuman/open/v1/file/upload', uploadProviderType: 'OPEN_TTS_CLONE', model: 'quality_v2', targetModel: 'quality_v2', region: 'cn', apiKeyEnv: 'BAIDU_XILING_APP_KEY', accessTokenEnv: 'BAIDU_XILING_APP_KEY', appId: '' },
};

const defaultAvatarCloneApi: NonNullable<AppSettings['providers']['avatar']['cloneApi']> = {
  provider: 'aliyun',
  baseUrl: 'https://avatar.cn-zhangjiakou.aliyuncs.com',
  model: 'StartInstance',
  region: 'cn-zhangjiakou',
  apiKeyEnv: 'ALIYUN_ACCESS_KEY_SECRET',
  tenantId: '',
  appId: '',
  instanceId: '',
  projectId: '',
  aliyun: { baseUrl: 'https://avatar.cn-zhangjiakou.aliyuncs.com', clonePath: '/?Action=Create2dAvatar', renderPath: '/?Action=StartInstance', statusPath: '/?Action=QueryAvatar', healthPath: '/?Action=QueryAvatarList', model: 'StartInstance', protocol: 'ALIYUN_AVATAR_OPENAPI', publicBaseUrl: '', portraitUrl: '', region: 'cn-zhangjiakou', apiKeyEnv: 'ALIYUN_ACCESS_KEY_SECRET', accessKeyIdEnv: 'ALIYUN_ACCESS_KEY_ID', accessKeySecretEnv: 'ALIYUN_ACCESS_KEY_SECRET', tenantId: '', appId: '', instanceId: '', projectId: '', streamMode: 'RTC' },
  baidu: { baseUrl: 'https://open.xiling.baidu.com', clonePath: '/api/digitalhuman/open/v1/figure/lite2d/train', renderPath: '/api/digitalhuman/open/v1/liveRooms', statusPath: '/api/digitalhuman/open/v1/figure/lite2d/query', healthPath: '/api/digitalhuman/open/v1/figure/lite2d/query?systemFigure=true&pageSize=1', protocol: 'BAIDU_XILING', uploadPath: '/api/digitalhuman/open/v1/file/upload', uploadProviderType: 'OPEN_CUSTOMIZATION_2D_GENERAL', customizeType: 'LITE_2D_GENERAL', gender: 'UNKNOWN', keepBackground: false, webSocketPath: '/live/2d/ws', model: 'quality_v2', region: 'cn', apiKeyEnv: 'BAIDU_XILING_APP_KEY', appId: '', streamMode: 'HTTP_STREAM' },
};

function CloneApiConfig() {
  const [settings, setSettings] = useState<AppSettings>();
  const [secretStatus, setSecretStatus] = useState<ProviderSecretStatus>();
  const [voiceAliyunKey, setVoiceAliyunKey] = useState('');
  const [voiceBaiduKey, setVoiceBaiduKey] = useState('');
  const [avatarAccessKeyId, setAvatarAccessKeyId] = useState('');
  const [avatarAccessKeySecret, setAvatarAccessKeySecret] = useState('');
  const [avatarBaiduKey, setAvatarBaiduKey] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    void Promise.all([
      api<AppSettings>('/api/settings'),
      api<ProviderSecretStatus>('/api/providers/secrets/status'),
    ]).then(([nextSettings, nextSecrets]) => {
      setSettings(nextSettings);
      setSecretStatus(nextSecrets);
    }).catch((error) => setMessage(error instanceof Error ? error.message : '克隆接口配置读取失败'));
  }, []);

  const save = async (kind: 'voice' | 'avatar') => {
    if (!settings) return;
    const voiceCloneApi = settings.providers.tts.voiceCloneApi ?? defaultVoiceCloneApi;
    const avatarCloneApi = settings.providers.avatar.cloneApi ?? defaultAvatarCloneApi;
    setBusy(kind);
    setMessage('');
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          providers: kind === 'voice'
            ? { tts: { voiceCloneApi } }
            : { avatar: { cloneApi: avatarCloneApi } },
        }),
      });
      if (kind === 'voice' && voice.provider === 'aliyun' && voiceAliyunKey.trim()) {
        const status = await api<ProviderSecretStatus>('/api/providers/secrets/voiceCloneAliyun', {
          method: 'PUT', body: JSON.stringify({ apiKey: voiceAliyunKey.trim() }),
        });
        setSecretStatus(status);
        setVoiceAliyunKey('');
      }
      if (kind === 'voice' && voice.provider === 'baidu' && voiceBaiduKey.trim()) {
        const status = await api<ProviderSecretStatus>('/api/providers/secrets/voiceCloneBaidu', {
          method: 'PUT', body: JSON.stringify({ apiKey: voiceBaiduKey.trim() }),
        });
        setSecretStatus(status);
        setVoiceBaiduKey('');
      }
      if (kind === 'avatar' && avatar.provider === 'aliyun' && (avatarAccessKeyId.trim() || avatarAccessKeySecret.trim())) {
        if (!avatarAccessKeyId.trim() || !avatarAccessKeySecret.trim()) throw new Error('阿里云数字人需要同时填写 AccessKey ID 和 AccessKey Secret');
        const status = await api<ProviderSecretStatus>('/api/providers/secrets/avatarCloneAliyun', {
          method: 'PUT', body: JSON.stringify({ apiKey: JSON.stringify({ accessKeyId: avatarAccessKeyId.trim(), accessKeySecret: avatarAccessKeySecret.trim() }) }),
        });
        setSecretStatus(status);
        setAvatarAccessKeyId('');
        setAvatarAccessKeySecret('');
      }
      if (kind === 'avatar' && avatar.provider === 'baidu' && avatarBaiduKey.trim()) {
        const status = await api<ProviderSecretStatus>('/api/providers/secrets/avatarCloneBaidu', {
          method: 'PUT', body: JSON.stringify({ apiKey: avatarBaiduKey.trim() }),
        });
        setSecretStatus(status);
        setAvatarBaiduKey('');
      }
      setMessage(kind === 'voice' ? '声音克隆接口配置已保存' : '数字人克隆接口配置已保存');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '克隆接口配置保存失败');
    } finally {
      setBusy('');
    }
  };

  if (!settings) return <section className="dh-clone-api-card"><div className="dh-text-model-copy"><div><b>声音与数字人克隆接口</b><small>配置云端 API 或本地模型服务，默认供应商为阿里云。</small></div></div><p className="dh-config-hint">正在读取克隆接口配置…</p>{message && <p className="dh-config-message">{message}</p>}</section>;
  const voice = settings.providers.tts.voiceCloneApi ?? defaultVoiceCloneApi;
  const avatar = settings.providers.avatar.cloneApi ?? defaultAvatarCloneApi;
  const voiceAliyun = voice.aliyun ?? defaultVoiceCloneApi.aliyun!;
  const voiceBaidu = voice.baidu ?? defaultVoiceCloneApi.baidu!;
  const avatarAliyun = avatar.aliyun ?? defaultAvatarCloneApi.aliyun!;
  const avatarBaidu = avatar.baidu ?? defaultAvatarCloneApi.baidu!;
  const voiceReady = voice.provider === 'local-openvoice' ? true : voice.provider === 'aliyun' ? Boolean(secretStatus?.voiceCloneAliyun?.configured) : Boolean(secretStatus?.voiceCloneBaidu?.configured);
  const avatarReady = avatar.provider === 'local-musetalk' ? true : avatar.provider === 'aliyun' ? Boolean(secretStatus?.avatarCloneAliyun?.configured) : Boolean(secretStatus?.avatarCloneBaidu?.configured);
  const activeVoiceConfig = voice.provider === 'baidu' ? voiceBaidu : voiceAliyun;
  const activeAvatarConfig = avatar.provider === 'baidu' ? avatarBaidu : avatarAliyun;
  const patchVoice = (patch: Record<string, unknown>) => {
    const nextConfig = { ...activeVoiceConfig, ...patch };
    const nextVoice = { ...voice, provider: voice.provider, baseUrl: nextConfig.baseUrl, model: nextConfig.model, targetModel: nextConfig.targetModel, region: voice.provider === 'aliyun' && nextConfig.region === 'ap-southeast-1' ? 'ap-southeast-1' as const : 'cn-beijing' as const, apiKeyEnv: nextConfig.apiKeyEnv, workspaceId: nextConfig.workspaceId, [voice.provider === 'baidu' ? 'baidu' : 'aliyun']: nextConfig };
    setSettings({ ...settings, providers: { ...settings.providers, tts: { ...settings.providers.tts, voiceCloneApi: nextVoice } } });
  };
  const patchAvatar = (patch: Record<string, unknown>) => {
    const nextConfig = { ...activeAvatarConfig, ...patch };
    const nextAvatar = { ...avatar, provider: avatar.provider, baseUrl: nextConfig.baseUrl, model: nextConfig.model, region: avatar.provider === 'aliyun' ? 'cn-zhangjiakou' as const : 'cn-beijing' as const, apiKeyEnv: nextConfig.apiKeyEnv, tenantId: nextConfig.tenantId, appId: nextConfig.appId, instanceId: nextConfig.instanceId, projectId: nextConfig.projectId, [avatar.provider === 'baidu' ? 'baidu' : 'aliyun']: nextConfig };
    setSettings({ ...settings, providers: { ...settings.providers, avatar: { ...settings.providers.avatar, cloneApi: nextAvatar } } });
  };
  return <section className="dh-clone-api-card">
    <div className="dh-text-model-copy"><div><b>声音与数字人克隆接口</b><small>阿里云、百度可以同时配置；每次克隆按当前选择调用一家，不会两家重复计费。没有凭证不会伪装成成功。</small></div><span className={`dh-config-state ${voiceReady && avatarReady ? 'is-ready' : 'is-warn'}`}>{voiceReady && avatarReady ? '当前供应商已配置' : '等待当前供应商凭证'}</span></div>
    <div className="dh-clone-api-grid">
      <article className="dh-clone-api-panel">
        <header><div><b>声音克隆 API</b><small>样音 → 云端音色 ID → 目标语言播报</small></div><span className={`dh-config-state ${voiceReady ? 'is-ready' : 'is-warn'}`}>{voice.provider === 'local-openvoice' ? '本地 CUDA' : voiceReady ? `${voice.provider === 'baidu' ? '百度' : '阿里云'}已配置` : '待填凭证'}</span></header>
        <label>当前声音供应商<select value={voice.provider} onChange={(event) => setSettings({ ...settings, providers: { ...settings.providers, tts: { ...settings.providers.tts, voiceCloneApi: { ...voice, provider: event.target.value as typeof voice.provider } } } })}><option value="aliyun">阿里云百炼 · CosyVoice</option><option value="baidu">百度曦灵</option><option value="local-openvoice">本地 CUDA · OpenVoice</option></select><small>两家的配置会同时保留，选择只决定本次克隆使用谁。</small></label>
        {voice.provider !== 'local-openvoice' && <><label>接口地址<input value={activeVoiceConfig.baseUrl} onChange={(event) => patchVoice({ baseUrl: event.target.value })} /></label>{voice.provider === 'aliyun' && <label>百炼 Workspace ID（可选）<input value={activeVoiceConfig.workspaceId ?? ''} placeholder="不填也可使用公共域名" onChange={(event) => patchVoice({ workspaceId: event.target.value })} /><small>填写后克隆请求会使用业务空间专属域名；目标模型必须和复刻时保持一致。</small></label>}<div className="dh-clone-api-fields"><label>克隆路径<input value={activeVoiceConfig.clonePath} onChange={(event) => patchVoice({ clonePath: event.target.value })} /></label><label>合成路径<input value={activeVoiceConfig.synthesizePath} onChange={(event) => patchVoice({ synthesizePath: event.target.value })} /></label></div><div className="dh-clone-api-fields"><label>克隆模型<input value={activeVoiceConfig.model} onChange={(event) => patchVoice({ model: event.target.value })} /></label><label>目标模型<input value={activeVoiceConfig.targetModel} onChange={(event) => patchVoice({ targetModel: event.target.value })} /></label></div>{voice.provider === 'aliyun' ? <label>百炼 API Key<input type="password" autoComplete="new-password" value={voiceAliyunKey} placeholder={secretStatus?.voiceCloneAliyun?.configured ? '已加密保存；留空不覆盖' : '粘贴 sk-...'} onChange={(event) => setVoiceAliyunKey(event.target.value)} /><small>只保存在本机 Windows DPAPI，不写入设置和前端。</small></label> : <><label>百度 App ID<input value={activeVoiceConfig.appId ?? ''} onChange={(event) => patchVoice({ appId: event.target.value })} /></label><label>百度 App Key<input type="password" autoComplete="new-password" value={voiceBaiduKey} placeholder={secretStatus?.voiceCloneBaidu?.configured ? '已加密保存；留空不覆盖' : '粘贴百度 App Key'} onChange={(event) => setVoiceBaiduKey(event.target.value)} /><small>百度使用 App ID + App Key 签名，密钥保存在本机 Windows DPAPI。</small></label></>}</>}
        <footer><small>声音克隆完成后会立刻调用当前供应商合成目标语言试听，通过后才标记 READY。</small><button className="primary" disabled={Boolean(busy)} onClick={() => void save('voice')}>{busy === 'voice' ? '保存中…' : '保存声音接口'}</button></footer>
      </article>
      <article className="dh-clone-api-panel">
        <header><div><b>数字人克隆 / 实时渲染 API</b><small>人物视频 → 云端数字人 ID → 实时视频流</small></div><span className={`dh-config-state ${avatarReady ? 'is-ready' : 'is-warn'}`}>{avatar.provider === 'local-musetalk' ? '本地 MuseTalk' : avatarReady ? `${avatar.provider === 'baidu' ? '百度' : '阿里云'}已配置` : '待填凭证'}</span></header>
        <label>当前数字人供应商<select value={avatar.provider} onChange={(event) => setSettings({ ...settings, providers: { ...settings.providers, avatar: { ...settings.providers.avatar, cloneApi: { ...avatar, provider: event.target.value as typeof avatar.provider } } } })}><option value="aliyun">阿里云虚拟数字人 OpenAPI</option><option value="baidu">百度曦灵直播 API</option><option value="local-musetalk">本地 CUDA · MuseTalk</option></select><small>两家的配置会同时保留，上传人物视频时选择当前供应商。</small></label>
        {avatar.provider !== 'local-musetalk' && <><label>接口地址<input value={activeAvatarConfig.baseUrl} onChange={(event) => patchAvatar({ baseUrl: event.target.value })} /></label><div className="dh-clone-api-fields"><label>克隆路径<input value={activeAvatarConfig.clonePath} onChange={(event) => patchAvatar({ clonePath: event.target.value })} /></label><label>实时渲染路径<input value={activeAvatarConfig.renderPath} onChange={(event) => patchAvatar({ renderPath: event.target.value })} /></label></div><div className="dh-clone-api-fields"><label>模型<input value={activeAvatarConfig.model} onChange={(event) => patchAvatar({ model: event.target.value })} /></label><label>输出方式<select value={activeAvatarConfig.streamMode} onChange={(event) => patchAvatar({ streamMode: event.target.value })}><option value="HTTP_STREAM">HTTP 视频流</option><option value="RTC">RTC 实时流</option></select></label></div>{avatar.provider === 'aliyun' ? <><div className="dh-clone-api-fields"><label>AccessKey ID<input value={avatarAccessKeyId} autoComplete="off" placeholder={secretStatus?.avatarCloneAliyun?.configured ? '已加密保存；留空不覆盖' : '阿里云 AK ID'} onChange={(event) => setAvatarAccessKeyId(event.target.value)} /></label><label>AccessKey Secret<input type="password" autoComplete="new-password" value={avatarAccessKeySecret} placeholder={secretStatus?.avatarCloneAliyun?.configured ? '已加密保存；留空不覆盖' : '阿里云 AK Secret'} onChange={(event) => setAvatarAccessKeySecret(event.target.value)} /></label></div><div className="dh-clone-api-fields"><label>Tenant ID<input value={activeAvatarConfig.tenantId ?? ''} onChange={(event) => patchAvatar({ tenantId: event.target.value })} /></label><label>App ID<input value={activeAvatarConfig.appId ?? ''} onChange={(event) => patchAvatar({ appId: event.target.value })} /></label></div></> : <><label>百度 App ID<input value={activeAvatarConfig.appId ?? ''} onChange={(event) => patchAvatar({ appId: event.target.value })} /></label><label>百度 App Key<input type="password" autoComplete="new-password" value={avatarBaiduKey} placeholder={secretStatus?.avatarCloneBaidu?.configured ? '已加密保存；留空不覆盖' : '粘贴百度 App Key'} onChange={(event) => setAvatarBaiduKey(event.target.value)} /></label></>}</>}
        <footer><small>云端接口必须返回真实数字人 ID 和视频/RTC 流地址；未返回时任务失败，不会切换到 VRM。</small><button className="primary" disabled={Boolean(busy)} onClick={() => void save('avatar')}>{busy === 'avatar' ? '保存中…' : '保存数字人接口'}</button></footer>
      </article>
    </div>
    {message && <p className="dh-config-message">{message}</p>}
  </section>;
}

/** Public asset URLs are separate from vendor credentials: Alibaba fetches the
 * uploaded sample from these URLs during enrollment. */
function CloudAssetConfig() {
  const [settings, setSettings] = useState<AppSettings>();
  const [voicePublicBaseUrl, setVoicePublicBaseUrl] = useState('');
  const [avatarPublicBaseUrl, setAvatarPublicBaseUrl] = useState('');
  const [portraitUrl, setPortraitUrl] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<AppSettings>('/api/settings').then((next) => {
      setSettings(next);
      setVoicePublicBaseUrl(next.providers.tts.voiceCloneApi?.aliyun?.publicBaseUrl ?? '');
      setAvatarPublicBaseUrl(next.providers.avatar.cloneApi?.aliyun?.publicBaseUrl ?? '');
      setPortraitUrl(next.providers.avatar.cloneApi?.aliyun?.portraitUrl ?? '');
    }).catch((error) => setMessage(error instanceof Error ? error.message : '公网素材配置读取失败'));
  }, []);

  const save = async () => {
    if (!settings) return;
    const voiceApi = settings.providers.tts.voiceCloneApi ?? defaultVoiceCloneApi;
    const avatarApi = settings.providers.avatar.cloneApi ?? defaultAvatarCloneApi;
    const aliyunVoice = voiceApi.aliyun ?? defaultVoiceCloneApi.aliyun!;
    const aliyunAvatar = avatarApi.aliyun ?? defaultAvatarCloneApi.aliyun!;
    setBusy(true);
    setMessage('');
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify({ providers: {
        tts: { voiceCloneApi: { ...voiceApi, aliyun: { ...aliyunVoice, publicBaseUrl: voicePublicBaseUrl.trim() } } },
        avatar: { cloneApi: { ...avatarApi, aliyun: { ...aliyunAvatar, publicBaseUrl: avatarPublicBaseUrl.trim(), portraitUrl: portraitUrl.trim() } } },
      } }) });
      setMessage('阿里云样音、视频和头像公网地址已保存；两家供应商配置仍同时保留。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '公网素材配置保存失败');
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return null;
  return <section className="dh-clone-api-card">
    <div className="dh-text-model-copy"><div><b>云端克隆素材访问配置</b><small>阿里云官方克隆接口需要云端能访问样音/视频；这里填可从公网访问本机的 HTTPS 地址或对象存储地址。百度上传接口不依赖这些地址。</small></div></div>
    <div className="dh-clone-api-grid">
      <article className="dh-clone-api-panel">
        <header><div><b>阿里云声音样音 URL</b><small>本机生成的随机样音会挂在 /api/public-audio/ 下</small></div></header>
        <label>公网基础地址<input value={voicePublicBaseUrl} placeholder="https://你的域名" onChange={(event) => setVoicePublicBaseUrl(event.target.value)} /></label>
      </article>
      <article className="dh-clone-api-panel">
        <header><div><b>阿里云数字人素材 URL</b><small>人物视频挂在 /api/public-media/，头像使用现成公网 PNG</small></div></header>
        <label>公网基础地址<input value={avatarPublicBaseUrl} placeholder="https://你的域名" onChange={(event) => setAvatarPublicBaseUrl(event.target.value)} /></label>
        <label>头像 PNG URL<input value={portraitUrl} placeholder="https://.../portrait.png" onChange={(event) => setPortraitUrl(event.target.value)} /></label>
      </article>
    </div>
    <footer><small>未配置公网地址时，阿里云声音/数字人任务会明确失败，不会伪装成 READY；百度仍可使用自己的上传链路。</small><button className="primary" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存云端素材配置'}</button></footer>
    {message && <p className="dh-config-message">{message}</p>}
  </section>;
}

export function DigitalHumanStudio() {
  const [section, setSection] = useState<Section>('voice');
  const store = useDigitalHumanCenter();
  const page = section === 'voice'
    ? <VoiceClonePage store={store} onDone={() => setSection('avatar')} />
    : section === 'avatar'
      ? <AvatarClonePage store={store} onDone={() => setSection('selection')} />
      : <DigitalHumanSelectionPage store={store} />;

  return <section className="dh-center dh-simple-center">
    <header className="dh-center-header">
      <div><h2>数字人中心</h2><p>克隆声音、克隆人物、选择使用。播报内容、口型和动作由后台自动处理。</p></div>
      <div className="dh-simple-summary">
        <span>当前人物 <b>{store.activeAvatar?.name ?? '未选择'}</b></span>
        <span>当前声音 <b>{store.activeVoice?.name ?? '未选择'}</b></span>
      </div>
    </header>
    <TextModelConfig />
    <CloneApiConfig />
    <CloudAssetConfig />
    <nav className="dh-simple-nav" aria-label="数字人设置步骤">
      {sections.map((item, index) => <button key={item.id} className={section === item.id ? 'active' : ''} onClick={() => setSection(item.id)}>
        <i>{index + 1}</i><span><b>{item.label}</b><small>{item.note}</small></span>
      </button>)}
    </nav>
    {store.message && <div className="dh-message" role="status">{store.message}</div>}
    {!store.profiles ? <div className="dh-loading"><strong>正在读取人物与声音…</strong><button onClick={() => void store.refresh()}>重新连接</button></div> : page}
  </section>;
}
