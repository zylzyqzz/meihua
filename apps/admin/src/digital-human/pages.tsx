import { useEffect, useMemo, useState } from 'react';
import { authenticatedAudioUrl, authenticatedMediaThumbnailUrl, authenticatedMediaUrl } from '../adminApi.js';
import type { DigitalHumanCenterStore } from './useDigitalHumanCenter.js';

const languages = [
  ['auto', '自动识别'], ['zh', '中文'], ['en', 'English'], ['yue', '粤语'], ['ja', '日本語'], ['ko', '한국어'],
] as const;

const targets = [
  ['CN', 'zh-CN', '中国普通话', 'zh-cn-standard'], ['HK', 'yue-HK', '中国粤语', 'yue-hk'],
  ['US', 'en-US', '美国英语', 'en-us'], ['GB', 'en-GB', '英国英语', 'en-gb'],
  ['JP', 'ja-JP', '日本日语', 'ja-jp'], ['KR', 'ko-KR', '韩国韩语', 'ko-kr'],
] as const;

function fileNameWithoutExtension(name: string) {
  return name.replace(/\.[^.]+$/, '').trim() || '未命名素材';
}

function readableError(value?: string) {
  if (!value) return '';
  if (value.includes('VOICE_REAL_TEST_REQUIRED')) return '等待生成试听';
  if (value.includes('VOICE_ASR_FAILED')) return '没有识别到清晰人声，请换一段安静、清楚的样音';
  if (value.includes('VOICE_REFERENCE_LANGUAGE_MISMATCH')) return '样音语言与手动填写的语言不一致，已阻止进入可用状态';
  if (value.includes('VOICE_TARGET_LANGUAGE_MISMATCH')) return '目标播报语言校验不一致，已阻止进入可用状态';
  if (value.includes('GPTSOVITS_HTTP_500')) return '声音生成失败，请重新处理';
  if (value.includes('ACCENT_ENGINE_NOT_READY') || value.includes('ACCENT_MODEL_MISSING')) return '目标国家口音服务未就绪，请安装 OpenVoice 模型并启用 CUDA';
  if (value.includes('CUDA_REQUIRED_FOR_LIVE')) return '当前只有 CPU 离线验证能力，实时直播必须安装 NVIDIA 驱动并启用 CUDA';
  if (value.includes('VOICE_TARGET_UNSUPPORTED')) return '暂不支持这个目标国家口音，请选择已有口音配置';
  if (value.includes('CLOUD_VOICE_API_KEY_REQUIRED')) return '当前云端声音供应商还没有保存 API 凭证，请到上方克隆接口配置中填写';
  if (value.includes('CLOUD_VOICE')) return `云端声音接口失败：${value}`;
  if (value.includes('CLOUD_AVATAR') || value.includes('ALIYUN_CLOUD_AVATAR') || value.includes('BAIDU_CLOUD_AVATAR')) return `云端数字人接口失败：${value}`;
  if (value.includes('MUSETALK_NOT_READY') || value.includes('AVATAR_PROVIDER_NOT_CONNECTED')) return '人物处理服务未启动，请重启一体包后再试';
  if (value.includes('AVATAR_REAL_LIPSYNC_TEST_REQUIRED')) return '需要重新处理人物素材';
  if (value.includes('没有可用的历史语音')) return '请先克隆一个声音';
  return value;
}

function Status({ value }: { value?: string }) {
  const label = value === 'READY' ? '可用' : value === 'FAILED' ? '处理失败' : value === 'DISABLED' ? '已停用' : value === 'PREPARING' || value === 'PROCESSING' ? '处理中' : '待处理';
  return <span className={`dh-status is-${String(value ?? 'UNKNOWN').toLowerCase()}`}>{label}</span>;
}

function Foundation({ ok, label, detail }: { ok?: boolean; label: string; detail?: string }) {
  if (ok) return null;
  return <div className="dh-foundation is-blocked"><b>{label}暂未启动</b><span>{detail || '请重启梅花一体包后再试'}</span></div>;
}

export function VoiceClonePage({ store }: { store: DigitalHumanCenterStore; onDone: () => void }) {
  const [language, setLanguage] = useState('auto');
  const [target, setTarget] = useState('CN');
  const [file, setFile] = useState<File>();
  const [testTexts, setTestTexts] = useState<Record<string, string>>({});
  const voices = store.profiles?.voices ?? [];
  const clone = async () => {
    if (!file) return;
    try {
      const selectedTarget = targets.find(([country]) => country === target) ?? targets[0];
      await store.act('voice-clone', () => store.uploadVoice({ file, language, targetCountry: selectedTarget[0], targetLocale: selectedTarget[1], accentProfileId: selectedTarget[3] }), `声音“${fileNameWithoutExtension(file.name)}”已提交，可以查看目标口音试听`);
      setFile(undefined);
    } catch { /* store shows the real backend failure */ }
  };
  return <div className="dh-simple-page">
    <section className="dh-simple-form">
      <header><h3>声音克隆</h3><p>上传你的样音，再选择目标国家；系统会用当前配置的云端声音模板生成对应语言试听。</p></header>
      {store.profiles?.voiceCloneProvider === 'local-openvoice' ? <><Foundation ok={store.serviceStatus?.gptsovits.ok} label="声音服务" detail={store.serviceStatus?.gptsovits.detail} /><Foundation ok={store.serviceStatus?.accent.ok} label="目标口音服务" detail={store.serviceStatus?.accent.detail} /></> : <div className={`dh-foundation ${store.profiles?.voiceCloneConfigured ? '' : 'is-blocked'}`}><b>{store.profiles?.voiceCloneProvider === 'baidu' ? '百度曦灵' : '阿里云百炼'}声音模板</b><span>{store.profiles?.voiceCloneConfigured ? '云端凭证已配置：样音会先创建云端音色，再用同一音色读取目标语言文案。' : '请先在“接入与播报”中保存云端 API 凭证。'}</span></div>}
      <label>样音语言<select value={language} onChange={(event) => setLanguage(event.target.value)}>{languages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><small>用于识别上传样音，不代表最终国家口音</small></label>
      <label>目标国家/地区<select value={target} onChange={(event) => setTarget(event.target.value)}>{targets.map(([country, _locale, label]) => <option key={country} value={country}>{label}</option>)}</select><small>最终播报语言和口音由此选择</small></label>
      <label className="dh-file-drop"><input key={file?.name ?? 'empty'} type="file" accept="audio/*,video/mp4,video/quicktime,video/webm,.wav,.mp3,.flac,.m4a,.mp4,.mov,.webm" onChange={(event) => setFile(event.target.files?.[0])} /><b>{file ? file.name : '选择声音或视频'}</b><small>10–30 秒，单人说话，环境安静；MP4 也可以直接上传</small></label>
      <p className="dh-consent">上传即表示你拥有该声音的克隆与直播使用授权。</p>
      <button className="primary dh-simple-primary" disabled={!file || Boolean(store.busy)} onClick={() => void clone()}>{store.busy === 'voice-clone' ? '正在识别并克隆…' : '开始克隆'}</button>
    </section>
    <aside className="dh-simple-library"><header><h3>我的声音</h3><span>{voices.filter((voice) => voice.status === 'READY').length} 个可用</span></header>
      {voices.map((voice) => { const id = voice.id ?? voice.voiceId; return <article key={id} className={id === store.profiles?.activeVoiceProfileId ? 'active' : ''}>
        <div className="dh-library-row"><span><b>{voice.name}</b><small>{voice.targetCountry ? `${voice.targetCountry} · ${voice.targetLocale ?? voice.language}` : voice.language}</small></span><Status value={voice.status} /></div>
        {voice.previewUrl ? <audio controls preload="none" src={authenticatedAudioUrl(voice.previewUrl)} /> : <p className="dh-real-error">{readableError(voice.lastError) || '还没有试听'}</p>}
        <div className="dh-voice-audition"><textarea rows={2} value={testTexts[id] ?? ''} placeholder="输入文案测试这套音色（留空使用默认试听文案）" onChange={(event) => setTestTexts({ ...testTexts, [id]: event.target.value })} /><div className="dh-preview-actions"><button disabled={Boolean(store.busy) || voice.status !== 'READY'} onClick={() => void store.act(`voice-test-${id}`, () => store.testVoice(id, testTexts[id]), '文案试听已生成')}>{store.busy === `voice-test-${id}` ? '合成中…' : '用文案试听'}</button>{voice.status !== 'READY' && <button disabled={Boolean(store.busy)} onClick={() => void store.act(`voice-test-${id}`, () => store.testVoice(id), '试听已生成')}>{store.busy === `voice-test-${id}` ? '正在处理…' : '重新处理'}</button>}</div></div>
      </article>; })}
      {!voices.length && <p className="dh-simple-empty">还没有声音素材。</p>}
    </aside>
  </div>;
}

export function AvatarClonePage({ store }: { store: DigitalHumanCenterStore; onDone: () => void }) {
  const [file, setFile] = useState<File>();
  const [provider, setProvider] = useState<'LOCAL_VIDEO' | 'ALIYUN_CLOUD' | 'BAIDU_CLOUD'>('LOCAL_VIDEO');
  const [preview, setPreview] = useState<{ title: string; assetId: string }>();
  const avatars = store.profiles?.avatars ?? [];
  const clone = async () => {
    if (!file) return;
    try {
      await store.act('avatar-clone', () => store.uploadAvatar(file, provider), `数字人“${fileNameWithoutExtension(file.name)}”已准备完成`);
      setFile(undefined);
    } catch { /* store shows the real backend failure */ }
  };
  return <div className="dh-simple-page">
    <section className="dh-simple-form">
      <header><h3>数字人克隆</h3><p>上传人物视频，处理完成后即可选择。正式播报时，系统会根据每次解话自动生成声音和口型。</p></header>
      {provider === 'LOCAL_VIDEO' ? <Foundation ok={store.serviceStatus?.musetalk.ok} label="MuseTalk 本地服务" detail={store.serviceStatus?.musetalk.detail} /> : <div className="dh-foundation"><b>{provider === 'ALIYUN_CLOUD' ? '阿里云' : '百度曦灵'}实时数字人</b><span>上传后由云端克隆并返回实时视频流；请先在上方接口配置中保存对应凭证。</span></div>}
      <label>人物克隆供应商<select value={provider} onChange={(event) => setProvider(event.target.value as typeof provider)}><option value="LOCAL_VIDEO">本地 MuseTalk（需 CUDA）</option><option value="ALIYUN_CLOUD">阿里云实时数字人</option><option value="BAIDU_CLOUD">百度曦灵直播 API</option></select><small>两家云端配置可以同时保留，上传这一份素材时选择实际使用的供应商。</small></label>
      <label className="dh-file-drop"><input key={file?.name ?? 'empty'} type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" onChange={(event) => setFile(event.target.files?.[0])} /><b>{file ? file.name : '选择人物视频'}</b><small>建议正面半身、单人物、光线稳定、10–30 秒</small></label>
      <p className="dh-consent">上传即表示你拥有人物视频与数字人制作授权。</p>
      <button className="primary dh-simple-primary" disabled={!file || Boolean(store.busy)} onClick={() => void clone()}>{store.busy === 'avatar-clone' ? '正在处理人物…' : '开始克隆'}</button>
      {preview && <div className="dh-result-preview"><header><b>{preview.title}</b><button onClick={() => setPreview(undefined)}>关闭</button></header><video controls autoPlay playsInline src={authenticatedMediaUrl(preview.assetId)} /></div>}
    </section>
    <aside className="dh-simple-library dh-avatar-library"><header><h3>我的数字人</h3><span>{avatars.filter((avatar) => avatar.status === 'READY').length} 个可用</span></header>
      {avatars.map((avatar) => <article key={avatar.id} className={avatar.id === store.profiles?.activeAvatarProfileId ? 'active' : ''}>
        <div className="dh-avatar-card-head">{avatar.sourceAssetId ? <img alt="" loading="lazy" src={authenticatedMediaThumbnailUrl(avatar.sourceAssetId)} /> : <span className="dh-avatar-placeholder">3D</span>}<span><b>{avatar.name}</b><small>{avatar.provider === 'LOCAL_VIDEO' ? '本地视频数字人' : avatar.provider === 'ALIYUN_CLOUD' ? '阿里云实时数字人' : avatar.provider === 'BAIDU_CLOUD' ? '百度曦灵实时数字人' : '3D 数字人'}</small></span><Status value={avatar.status} /></div>
        <p className="dh-real-error">{readableError(avatar.lastError)}</p>
        <div className="dh-preview-actions">{avatar.sourceAssetId && <button onClick={() => setPreview({ title: avatar.name, assetId: avatar.sourceAssetId! })}>预览人物</button>}{avatar.previewAssetId && avatar.previewAssetId !== avatar.sourceAssetId && <button className="primary" onClick={() => setPreview({ title: `${avatar.name} · 上次口型`, assetId: avatar.previewAssetId! })}>预览上次口型</button>}{(avatar.provider === 'LOCAL_VIDEO' || avatar.provider === 'ALIYUN_CLOUD' || avatar.provider === 'BAIDU_CLOUD') && avatar.status !== 'READY' && <button disabled={Boolean(store.busy)} onClick={() => void store.act(`avatar-test-${avatar.id}`, () => store.verifyAvatar(avatar.id), '人物已处理完成')}>{store.busy === `avatar-test-${avatar.id}` ? '正在处理…' : '重新处理'}</button>}</div>
      </article>)}
      {!avatars.length && <p className="dh-simple-empty">还没有数字人素材。</p>}
    </aside>
  </div>;
}

export function DigitalHumanSelectionPage({ store }: { store: DigitalHumanCenterStore }) {
  const avatars = useMemo(() => store.profiles?.avatars.filter((avatar) => avatar.status === 'READY') ?? [], [store.profiles?.avatars]);
  const voices = useMemo(() => store.profiles?.voices.filter((voice) => voice.status === 'READY' && voice.previewUrl) ?? [], [store.profiles?.voices]);
  const [avatarId, setAvatarId] = useState(store.profiles?.activeAvatarProfileId ?? avatars[0]?.id ?? '');
  const [voiceId, setVoiceId] = useState(store.profiles?.activeVoiceProfileId ?? (voices[0]?.id ?? voices[0]?.voiceId) ?? '');
  const [testText, setTestText] = useState('');
  useEffect(() => {
    if (!avatarId && avatars[0]) setAvatarId(avatars[0].id);
    if (!voiceId && voices[0]) setVoiceId(voices[0].id ?? voices[0].voiceId);
  }, [avatarId, avatars, voiceId, voices]);
  const selectedAvatar = avatars.find((avatar) => avatar.id === avatarId);
  const selectedVoice = voices.find((voice) => (voice.id ?? voice.voiceId) === voiceId);
  const apply = async () => {
    try { await store.act('selection-apply', () => store.applySelection(avatarId, voiceId), '人物和声音已应用到画面工作台'); }
    catch { /* store shows the real backend failure */ }
  };
  return <div className="dh-selection-page">
    <header><h3>选择使用</h3><p>选一个数字人和一个声音。下一次测算播报会自动使用这套组合。</p></header>
    <div className="dh-selection-grid"><label><span>数字人</span><select value={avatarId} onChange={(event) => setAvatarId(event.target.value)}><option value="">选择数字人</option>{avatars.map((avatar) => <option key={avatar.id} value={avatar.id}>{avatar.name}</option>)}</select><small>{selectedAvatar ? '已选择' : '请先克隆一个数字人'}</small></label><label><span>声音</span><select value={voiceId} onChange={(event) => setVoiceId(event.target.value)}><option value="">选择声音</option>{voices.map((voice) => <option key={voice.id ?? voice.voiceId} value={voice.id ?? voice.voiceId}>{voice.name} · {voice.targetLocale ?? voice.language}</option>)}</select><small>{selectedVoice ? '已选择' : '请先克隆一个声音'}</small></label></div>
    <div className="dh-selection-result"><span><small>人物</small><b>{selectedAvatar?.name ?? '未选择'}</b></span><i>＋</i><span><small>声音</small><b>{selectedVoice?.name ?? '未选择'}</b></span></div>
    {selectedVoice && <div className="dh-selection-voice-test"><b>当前音色试听</b>{selectedVoice.previewUrl && <audio controls preload="none" src={authenticatedAudioUrl(selectedVoice.previewUrl)} />}<textarea rows={3} value={testText} placeholder="输入一段文案，测试当前选中的音色" onChange={(event) => setTestText(event.target.value)} /><button disabled={Boolean(store.busy)} onClick={() => void store.act('selection-voice-test', () => store.testVoice(selectedVoice.id ?? selectedVoice.voiceId, testText), '当前音色文案试听已生成')}>{store.busy === 'selection-voice-test' ? '合成中…' : '合成这段文案试听'}</button></div>}
    <button className="primary dh-apply-button" disabled={!avatarId || !voiceId || Boolean(store.busy)} onClick={() => void apply()}>{store.busy === 'selection-apply' ? '正在应用…' : '保存并使用'}</button>
  </div>;
}
