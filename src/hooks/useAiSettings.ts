import { useState } from 'react';
import { DEFAULT_LLM_PRESETS } from '../data/appPresets';
import { testAssistantConfig } from '../services/aiApi';
import { LLMConfig } from '../types';
import { useLocalStorageState } from './useLocalStorageState';

export interface AiTestResult {
  success?: boolean;
  latency?: number;
  message?: string;
  error?: string;
}

const clampNumber = (value: unknown, fallback: number, min: number, max: number) => {
  const numericValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numericValue)) return fallback;
  return Math.min(max, Math.max(min, numericValue));
};

const normalizeProviderConfig = (rawConfig: unknown, fallback: LLMConfig): LLMConfig => {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig as Partial<LLMConfig> : {};

  return {
    ...fallback,
    ...config,
    id: typeof config.id === 'string' && config.id.trim() ? config.id : fallback.id,
    name: typeof config.name === 'string' && config.name.trim() ? config.name : fallback.name,
    website: typeof config.website === 'string' ? config.website : fallback.website,
    apiKey: typeof config.apiKey === 'string' ? config.apiKey : fallback.apiKey,
    endpoint: typeof config.endpoint === 'string' ? config.endpoint : fallback.endpoint,
    model: typeof config.model === 'string' ? config.model : fallback.model,
    contextLimit: clampNumber(config.contextLimit, fallback.contextLimit, 0, 50),
    compressThreshold: clampNumber(config.compressThreshold, fallback.compressThreshold, 0, 30000),
    isDefault: config.isDefault === undefined ? fallback.isDefault : Boolean(config.isDefault)
  };
};

const normalizeProviderConfigs = (rawValue: string) => {
  const parsed = JSON.parse(rawValue);
  if (!Array.isArray(parsed)) return DEFAULT_LLM_PRESETS;

  const normalizedById = new Map<string, LLMConfig>();
  parsed.forEach((item) => {
    const id = item && typeof item === 'object' && typeof item.id === 'string' ? item.id : '';
    if (!id || normalizedById.has(id)) return;
    const fallback = DEFAULT_LLM_PRESETS.find(preset => preset.id === id) || DEFAULT_LLM_PRESETS[0];
    normalizedById.set(id, normalizeProviderConfig(item, fallback));
  });

  DEFAULT_LLM_PRESETS.forEach((preset) => {
    if (!normalizedById.has(preset.id)) {
      normalizedById.set(preset.id, preset);
    }
  });

  return [...normalizedById.values()];
};

const getSafeActiveProviderId = (rawValue: string) => {
  const candidateId = rawValue.trim();
  return DEFAULT_LLM_PRESETS.some(config => config.id === candidateId) ? candidateId : 'gemini-default';
};

export function useAiSettings() {
  const [providerConfigs, setProviderConfigs] = useLocalStorageState<LLMConfig[]>(
    'ai_provider_configs',
    DEFAULT_LLM_PRESETS,
    normalizeProviderConfigs
  );
  const [activeProviderId, setActiveProviderId] = useLocalStorageState<string>(
    'ai_active_provider_id',
    'gemini-default',
    getSafeActiveProviderId,
    value => value
  );
  const [showRawPayload, setShowRawPayload] = useLocalStorageState<boolean>(
    'ai_show_raw_payload',
    false,
    rawValue => rawValue === 'true',
    value => String(value)
  );
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiTestResult | null>(null);

  const handleFieldChange = (providerId: string, field: keyof LLMConfig, value: unknown) => {
    setProviderConfigs(prev => prev.map(cfg => {
      if (cfg.id === providerId) {
        const fallback = DEFAULT_LLM_PRESETS.find(preset => preset.id === cfg.id) || cfg;
        return normalizeProviderConfig({ ...cfg, [field]: value }, fallback);
      }
      return cfg;
    }));
  };

  const handleTestConfig = async (config: LLMConfig) => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const data = await testAssistantConfig(config);
      setTestResult(data);
    } catch (err: any) {
      setTestResult({
        success: false,
        error: err.message || '网络连接测试异常'
      });
    } finally {
      setIsTesting(false);
    }
  };

  const resetProviderConfigs = () => {
    setProviderConfigs(DEFAULT_LLM_PRESETS);
    setActiveProviderId('gemini-default');
    setTestResult(null);
  };

  const clearTestResult = () => {
    setTestResult(null);
  };

  return {
    providerConfigs,
    activeProviderId,
    setActiveProviderId,
    showRawPayload,
    setShowRawPayload,
    isTesting,
    testResult,
    clearTestResult,
    handleFieldChange,
    handleTestConfig,
    resetProviderConfigs
  };
}
