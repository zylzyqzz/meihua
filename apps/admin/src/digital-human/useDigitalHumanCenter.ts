import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AudioBusSettings, AvatarProfile, DigitalHumanJob, DigitalHumanPreset, VoiceProfile } from '@meihua/core-types';
import { adminRequest as api } from '../adminApi.js';

export type DigitalHumanProfiles = {
  voices: VoiceProfile[];
  avatars: AvatarProfile[];
  activeVoiceProfileId?: string;
  activeAvatarProfileId?: string;
  audioBus: AudioBusSettings;
  accentProfiles?: Array<{ id: string; country: string; label: string; locale: string; engine: string; enabled: boolean }>;
  voiceCloneProvider?: 'aliyun' | 'baidu' | 'local-openvoice';
  voiceCloneConfigured?: boolean;
};

export type DigitalHumanServiceStatus = {
  gptsovits: { ok: boolean; detail: string };
  accent: { ok: boolean; detail: string };
  musetalk: { ok: boolean; detail: string; avatars: string[] };
};

export function useDigitalHumanCenter() {
  const [profiles, setProfiles] = useState<DigitalHumanProfiles>();
  const [serviceStatus, setServiceStatus] = useState<DigitalHumanServiceStatus>();
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    const [nextProfiles, nextStatus] = await Promise.all([
      api<DigitalHumanProfiles>('/api/digital-human/profiles'),
      api<DigitalHumanServiceStatus>('/api/digital-human/status'),
    ]);
    setProfiles(nextProfiles);
    setServiceStatus(nextStatus);
  }, []);

  useEffect(() => {
    void refresh().catch((error) => setMessage(error instanceof Error ? error.message : '人物与声音读取失败'));
  }, [refresh]);

  const act = useCallback(async <T,>(id: string, operation: () => Promise<T>, success: string) => {
    setBusy(id);
    setMessage('');
    try {
      const result = await operation();
      await refresh();
      setMessage(success);
      return result;
    } catch (error) {
      await refresh().catch(() => undefined);
      setMessage(error instanceof Error ? error.message : '操作失败，请重试');
      throw error;
    } finally {
      setBusy('');
    }
  }, [refresh]);

  const activeVoice = useMemo(() => profiles?.voices.find((voice) => (voice.id ?? voice.voiceId) === profiles.activeVoiceProfileId), [profiles]);
  const activeAvatar = useMemo(() => profiles?.avatars.find((avatar) => avatar.id === profiles.activeAvatarProfileId), [profiles]);

  const uploadVoice = async (input: { file: File; language: string; targetCountry?: string; targetLocale?: string; accentProfileId?: string }) => {
    const form = new FormData();
    form.set('sourceLanguage', input.language);
    if (input.targetCountry) form.set('targetCountry', input.targetCountry);
    if (input.targetLocale) form.set('targetLocale', input.targetLocale);
    if (input.accentProfileId) form.set('accentProfileId', input.accentProfileId);
    form.set('cloneMode', 'COUNTRY_ACCENT');
    form.set('authorizationConfirmed', 'true');
    form.set('file', input.file);
    const createdPayload = await api<VoiceProfile | { profile: VoiceProfile; job: DigitalHumanJob }>('/api/voice-profiles', { method: 'POST', body: form, signal: AbortSignal.timeout(600_000) });
    if ('profile' in createdPayload) {
      await waitForJob(createdPayload.job.id, 2 * 60 * 60_000);
      return api<DigitalHumanProfiles>('/api/digital-human/profiles').then((value) => value.voices.find((voice) => (voice.id ?? voice.voiceId) === (createdPayload.profile.id ?? createdPayload.profile.voiceId)) ?? createdPayload.profile);
    }
    const id = createdPayload.id ?? createdPayload.voiceId;
    await api<{ audioUrl: string }>(`/api/voice-profiles/${encodeURIComponent(id)}/test`, {
      method: 'POST', body: JSON.stringify({}), signal: AbortSignal.timeout(600_000),
    });
    return createdPayload;
  };

  const waitForJob = async (jobId: string, timeoutMs = 2 * 60 * 60_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await api<DigitalHumanJob>(`/api/digital-human/jobs/${encodeURIComponent(jobId)}`);
      if (job.status === 'READY') return job;
      if (job.status === 'FAILED' || job.status === 'CANCELED') throw new Error(job.errorMessage || job.errorCode || 'DIGITAL_HUMAN_JOB_FAILED');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error('DIGITAL_HUMAN_JOB_TIMEOUT');
  };

  const uploadAvatar = async (file: File, provider: 'LOCAL_VIDEO' | 'ALIYUN_CLOUD' | 'BAIDU_CLOUD' = 'LOCAL_VIDEO') => {
    const form = new FormData();
    form.set('authorizationConfirmed', 'true');
    form.set('provider', provider);
    form.set('file', file);
    const result = await api<{ profile: AvatarProfile; job: DigitalHumanJob }>('/api/digital-human/avatars', { method: 'POST', body: form, signal: AbortSignal.timeout(15_000) });
    await waitForJob(result.job.id);
    return api<AvatarProfile>(`/api/digital-human/avatars/${encodeURIComponent(result.profile.id)}/status`);
  };

  const testVoice = (id: string, text?: string) => api<{ audioUrl: string }>(`/api/voice-profiles/${encodeURIComponent(id)}/test`, {
    method: 'POST', body: JSON.stringify(text?.trim() ? { text: text.trim().slice(0, 500) } : {}), signal: AbortSignal.timeout(600_000),
  });

  const verifyAvatar = async (id: string) => {
    const result = await api<{ profile: AvatarProfile; job: DigitalHumanJob }>(`/api/digital-human/avatars/${encodeURIComponent(id)}/prepare`, { method: 'POST', signal: AbortSignal.timeout(15_000) });
    await waitForJob(result.job.id);
    const prepared = await api<AvatarProfile>(`/api/digital-human/avatars/${encodeURIComponent(id)}/status`);
    if (prepared.status !== 'READY') throw new Error(prepared.lastError || 'MUSETALK_NOT_READY');
    return { profile: prepared };
  };

  const applySelection = (avatarProfileId: string, voiceProfileId: string) => api<DigitalHumanPreset>('/api/digital-human/selection', {
    method: 'POST', body: JSON.stringify({ avatarProfileId, voiceProfileId }),
  });

  return {
    profiles, serviceStatus, busy, message, refresh, act, activeVoice, activeAvatar,
    uploadVoice, uploadAvatar, testVoice, verifyAvatar, applySelection,
  };
}

export type DigitalHumanCenterStore = ReturnType<typeof useDigitalHumanCenter>;
