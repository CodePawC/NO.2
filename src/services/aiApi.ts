import { ChatMessage, LLMConfig, MedicalEquipment, StructuredTicket } from '../types';

interface AssistantChatPayload {
  message: string;
  history: ChatMessage[];
  currentDraft: Partial<StructuredTicket>;
  activeConfig: LLMConfig;
  currentUser: unknown;
}

interface GeminiAnalyzePayload {
  textContext?: string;
  imageBase64?: string;
  mimeType?: string;
}

interface GeminiChatPayload {
  deviceContext: MedicalEquipment;
  messageHistory: Array<{
    role: 'user' | 'model';
    parts: Array<{ text: string }>;
  }>;
}

export async function sendAssistantChat(payload: AssistantChatPayload) {
  const response = await fetch('/api/assistant/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error('AI 服务响应失败，请稍后重试');
  }

  return response.json();
}

export async function testAssistantConfig(config: LLMConfig) {
  const response = await fetch('/api/assistant/test-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config })
  });

  if (!response.ok) {
    throw new Error(`测试接口 HTTP 报错: ${response.status}`);
  }

  return response.json();
}

export async function analyzeGeminiContent(payload: GeminiAnalyzePayload, errorMessage = 'AI 服务请求失败') {
  const response = await fetch('/api/gemini/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(errorMessage);
  }

  return response.json();
}

export async function chatWithGeminiExpert(payload: GeminiChatPayload) {
  const response = await fetch('/api/gemini/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error('AI 智脑服务连接中断');
  }

  return response.json();
}
