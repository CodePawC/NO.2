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

export function useAiSettings() {
  const [providerConfigs, setProviderConfigs] = useLocalStorageState<LLMConfig[]>(
    'ai_provider_configs',
    DEFAULT_LLM_PRESETS
  );
  const [activeProviderId, setActiveProviderId] = useLocalStorageState<string>(
    'ai_active_provider_id',
    'gemini-default',
    rawValue => rawValue,
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
        return { ...cfg, [field]: value };
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
