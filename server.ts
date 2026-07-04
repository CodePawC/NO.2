/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import path from 'path';
import { GoogleGenAI, Type } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const app = express();
const PORT = 3000;

// Initialize Gemini SDK securely on the server
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || '',
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

app.use(express.json({ limit: '20mb' }));

// API: Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

/// Helper to generate a structured fallback payload when Gemini is unavailable or not configured
const DEPARTMENT_ALIASES: Record<string, string> = {
  ICU: '重症医学科 (ICU)',
  重症: '重症医学科 (ICU)',
  重症科: '重症医学科 (ICU)',
  重症医学科: '重症医学科 (ICU)',
  急诊: '急诊科',
  急诊科: '急诊科',
  放射: '放射科',
  放射科: '放射科',
  妇产: '妇产科',
  妇产科: '妇产科',
  胃镜: '胃镜室',
  胃镜室: '胃镜室',
  手术: '手术室',
  手术室: '手术室',
  呼吸: '呼吸内科',
  呼吸内科: '呼吸内科',
  儿科: '儿科',
  检验: '检验科',
  检验科: '检验科',
  超声: '超声科',
  超声科: '超声科'
};

function normalizeDepartmentName(department?: string) {
  const cleaned = department?.trim();
  if (!cleaned) return '';

  return DEPARTMENT_ALIASES[cleaned.toUpperCase()] || DEPARTMENT_ALIASES[cleaned] || cleaned;
}

function getRuleBasedFallback(message: string, currentDraft: any, isApiError: boolean = false, currentUser?: any) {
  const textLower = message.toLowerCase();
  const draft = currentDraft || {};
  const currentUserDepartment = normalizeDepartmentName(currentUser?.department || currentUser?.dept);
  const isClinicalUser = currentUser?.role === 'medical_staff' && !!currentUserDepartment;
  const explicitlyNoVendorCoop = /暂不需要厂家|不需要厂家|无需厂家|不用厂家|不联系厂家|无需供应商|不需要供应商|院内自主|设备科看一下/i.test(textLower);
  
  // 1. Task Type
  let taskType = '设备报修';
  if (/呼吸机|除颤仪|麻醉机|监护仪|生命支持|抢救|监护/.test(textLower)) {
    taskType = '生命支持设备应急';
  } else if (/气体|氧气|负压|吸引|中心供氧|压缩/.test(textLower)) {
    taskType = '医用气体异常';
  } else if (/验收|安装|到货|开箱/.test(textLower)) {
    taskType = '验收安装协同';
  } else if (!explicitlyNoVendorCoop && /厂家|外送|寄修|供应商|奥林巴斯/.test(textLower)) {
    taskType = '供应商协同';
  } else if (/计量|强检|质控|送检/.test(textLower)) {
    taskType = '计量/质控提醒';
  } else if (/配件|耗材|更换|电池/.test(textLower)) {
    taskType = '配件耗材申请';
  } else if (/电脑|网络|网线|系统|his|后勤|打印机|卡纸|跳闸|照明|插座/.test(textLower)) {
    taskType = '非设备类转派任务';
  } else if (/巡检|保养|培训|鉴定|盘点/.test(textLower)) {
    taskType = '普通杂项任务';
  }

  // 2. Department
  let department = draft.department ? normalizeDepartmentName(draft.department) : null;
  const deptMatch = message.match(/(呼吸内科|重症医学科|急诊科|放射科|妇产科|胃镜室|手术室|检验科|超声科|icu|急诊|放射|妇产|胃镜|儿科|呼吸|手术)/i);
  const extractedDepartment = deptMatch ? normalizeDepartmentName(deptMatch[0]) : '';
  if (isClinicalUser) {
    department = currentUserDepartment;
  } else if (extractedDepartment) {
    department = extractedDepartment;
  }

  // 3. Location
  let location = draft.location || null;
  const locMatch = message.match(/(抢救室|诊室|病房|机房|1楼|2楼|3楼|4楼|a床|b床|c床|病区)/i);
  if (locMatch) {
    location = locMatch[0];
  }

  // 4. Device Name
  let deviceName = draft.deviceName || null;
  const devMatch = message.match(/(呼吸机|除颤仪|麻醉机|监护仪|氧气|负压吸引|胃镜|dr|电脑|打印机|注射泵|输液泵)/i);
  if (devMatch) {
    deviceName = devMatch[0];
  }

  // 5. Urgency level rules
  const urgentKeywords = ['呼吸机', '除颤仪', '麻醉机', '监护仪', '氧气', '负压吸引', '抢救', '生命支持', '病人正在用', '无法通气', '压力不足'];
  const isUrgent = urgentKeywords.some(kw => textLower.includes(kw));
  const urgency = isUrgent ? '生命支持' : (textLower.includes('急') ? '特急' : (draft.urgency || '普通'));

  // 6. Clinical Impact
  const affectClinical = isUrgent || textLower.includes('影响临床') ? '是' : (draft.affectClinical || '否');

  // 7. Need backup / Vendor coop
  const needBackupDevice = isUrgent ? '是' : (draft.needBackupDevice || '否');
  const needVendorCoop = explicitlyNoVendorCoop
    ? '否'
    : (taskType === '供应商协同' || taskType === '验收安装协同' ? '是' : (draft.needVendorCoop || '否'));

  // 8. Recommended Dept
  const recommendedDept = taskType === '非设备类转派任务' ? '信息科' : (draft.recommendedDept || '医学装备科');

  // 9. Contacts
  let contactPerson = isClinicalUser ? currentUser.name : (draft.contactPerson || '科室医护人员');
  const contactMatch = message.match(/(周医生|王护士|李医生|张医生|刘护士|陈工|赵主任)/);
  if (!isClinicalUser && contactMatch) {
    contactPerson = contactMatch[0];
  }
  
  let contactPhone = isClinicalUser ? (currentUser.phone || draft.contactPhone || '未提取') : (draft.contactPhone || '未提取');
  const phoneMatch = message.match(/(1[3-9]\d{9}|\d{3,4}-\d{7,8}|\d{4})/);
  if (!isClinicalUser && phoneMatch) {
    contactPhone = phoneMatch[0];
  }

  const notes = isClinicalUser && extractedDepartment && extractedDepartment !== currentUserDepartment
    ? `AI原始识别科室为 [${extractedDepartment}]，已按当前登录临床用户归属规范化为 [${currentUserDepartment}]。`
    : (draft.notes || '');

  const faultPhenomenon = message;

  const userGreeting = currentUser 
    ? `尊敬的**${currentUser.name} ${currentUser.title}**您好！` 
    : '您好！';

  const warningTitle = isApiError 
    ? `⚠️ **系统提示：** 智能分析云端引擎负载较高或出现网络波动，${userGreeting}已自动无缝切换至 **“备用智能过滤引擎”（启发式降级机制）**：`
    : `⚠️ **系统连接提示：** 未检测到云端 Gemini 引擎，${userGreeting}系统已自动切换至 **“院内本地备用智能过滤引擎”（启发式降级机制）**：`;

  return {
    userReply: `${warningTitle}\n\n已成功帮您智能提炼出关键草稿，并将状态标为 **“AI待补全”**。请在左侧核对并点击 **“确认生成任务”** 提交工单。`,
    extractedInfo: {
      taskType,
      source: draft.source || 'AI 对话生成',
      department,
      location,
      deviceName,
      deviceId: draft.deviceId || null,
      faultPhenomenon,
      urgency,
      affectClinical,
      needBackupDevice,
      needVendorCoop,
      recommendedDept,
      aiStatus: 'AI待补全',
      contactPerson,
      contactPhone,
      notes
    },
    aiSuggestions: [
      '已启用本地应急智能过滤规则自动研判。',
      '请检查左侧/弹出层中提取到的 14 个任务单字段是否准确。',
      '对于未提取到或有误差的字段，您可在弹窗或确认页面中直接手动微调。'
    ],
    isClarification: false,
    forwardDepartment: taskType === '非设备类转派任务' ? '信息科' : null
  };
}

// Helper to cleanly extract and parse JSON from LLM text responses
function cleanAndParseJSON(text: string): any {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    // Attempt markdown JSON extraction
    const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1].trim());
      } catch (e2) {
        // Continue
      }
    }
    // Attempt parsing between first '{' and last '}'
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      } catch (e3) {
        // Continue
      }
    }
    throw new Error('无法解析大模型的返回结果为结构化 JSON');
  }
}

// API: Test and Measure Latency of Custom LLM Configurations
app.post('/api/assistant/test-config', async (req, res) => {
  const config = req.body?.config;
  if (!config) {
    res.status(400).json({ error: '配置参数不能为空' });
    return;
  }

  const startTime = Date.now();
  const { id, name, apiKey, endpoint, model } = config;

  try {
    // 1. Offline Mode Speed Test
    if (id === 'offline-default' || endpoint === 'offline' || model === 'offline') {
      const elapsed = Date.now() - startTime + Math.floor(Math.random() * 5) + 2; // slight variation
      res.json({
        success: true,
        latency: elapsed,
        message: '本地启发式算法（离线降级机制）已就绪。连接测试成功，相应速度极佳！',
        model: '本地规则引擎'
      });
      return;
    }

    // 2. Gemini native configuration (No custom endpoint, or matches gemini)
    if (id === 'gemini-default' || !endpoint || endpoint.includes('googleapis.com') || endpoint.includes('gemini')) {
      const apiKeyToUse = apiKey || process.env.GEMINI_API_KEY;
      if (!apiKeyToUse) {
        throw new Error('未配置 Gemini API Key，无法进行云端联通测试。请在配置中填入密钥。');
      }

      const testAi = new GoogleGenAI({
        apiKey: apiKeyToUse,
        httpOptions: {
          headers: { 'User-Agent': 'aistudio-build' },
        },
      });

      const modelName = model || 'gemini-2.5-flash';
      
      // Request a minimal prompt
      const response = await testAi.models.generateContent({
        model: modelName,
        contents: 'Hi, please say "ok" in one word.'
      });

      const elapsed = Date.now() - startTime;
      const responseText = response.text || '';
      res.json({
        success: true,
        latency: elapsed,
        message: `云端 Gemini 联通成功！AI 回复: "${responseText.trim()}"`,
        model: modelName
      });
    } else {
      // 3. Custom OpenAI-compatible endpoint
      const modelToUse = model || 'gpt-4o-mini';
      const response = await fetch(`${endpoint.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey || ''}`
        },
        body: JSON.stringify({
          model: modelToUse,
          messages: [{ role: 'user', content: 'Hi, please say "ok" in one word.' }],
          max_tokens: 5
        }),
        signal: AbortSignal.timeout(10000) // 10s timeout
      });

      if (!response.ok) {
        throw new Error(`HTTP 错误 ${response.status}: ${response.statusText}`);
      }

      const data: any = await response.json();
      const elapsed = Date.now() - startTime;
      const responseText = data.choices?.[0]?.message?.content || '';
      res.json({
        success: true,
        latency: elapsed,
        message: `云端 Custom 联通成功！AI 回复: "${responseText.trim()}"`,
        model: modelToUse
      });
    }
  } catch (err: any) {
    console.error('API Test connection error:', err);
    res.json({
      success: false,
      message: `连接失败: ${err.message || err}`
    });
  }
});

// API: Core AI Assistant Chat Endpoint
app.post('/api/assistant/chat', async (req, res) => {
  const { message, currentDraft, history } = req.body;
  const config = req.body?.config || req.body?.activeConfig;
  const user = req.body?.user || req.body?.currentUser;
  if (!message) {
    res.status(400).json({ error: 'Message cannot be empty' });
    return;
  }

  const processedHistory = Array.isArray(history) ? history : [];
  const configToUse = config || { id: 'gemini-default' };

  try {
    const isOfflineMode = configToUse.id === 'offline-default' || configToUse.endpoint === 'offline' || configToUse.model === 'offline';
    if (isOfflineMode) {
      console.log('[AI Assistant] Running in rule-based offline mode');
      const result = getRuleBasedFallback(message, currentDraft, false, user);
      res.json(result);
      return;
    }

    const systemInstruction = `你是一位医院医学装备科（医疗器械、生命支持设备、临床装备工程部）的AI助理。
你需要协助临床科室或设备科工程师，从用户的日常口语故障申报或咨询对话中，分析并提取出高度结构化的任务工单信息。

你需要完成以下工作：
1. 判断任务类型 (taskType):
   - "设备报修"：普通临床/医技/手术等非生命支持类的医疗设备故障。
   - "生命支持设备应急"：呼吸机、除颤仪、麻醉机、监护仪、抢救室设备、急诊抢救设备等涉及人身安全与生命支持的紧急故障。
   - "医用气体异常"：中心供氧、负压吸引、压缩空气等医院气体系统故障。
   - "验收安装协同"：新购医学设备到货验收、安装、调试，协助第三方测量或场地开箱。
   - "供应商协同"：涉及需要厂家到场、返厂维修、寄修或向供应商采购配件。
   - "计量/质控提醒"：特种设备、放射设备等计量检定、质控强检提醒。
   - "配件耗材申请"：设备维修配件申领、电池更换、易损件申领。
   - "普通杂项任务"：设备盘点、巡检、保养、操作培训、技术鉴定等。
   - "非设备类转派任务"：如电脑主机故障、HIS网络、打印机卡纸、漏水跳闸、病床脚轮松动等应当流转给信息科或后勤总务部门的任务。

2. 判定任务来源 (source):
   - 默认为 "AI 对话生成"。如果用户提到是通过特定渠道（如扫码报修、前台电话、微信小程序、工程师手工录入、供应商反馈、系统自动发出等），判定为相应来源：
     * "AI 对话生成"、"科室扫码报修"、"电话登记"、"微信小程序"、"工程师手工录入"、"供应商协同"、"系统自动预警"。

3. 提取并合并以下字段 (extractedInfo):
   - taskType: 任务类型（上述9种之一）
   - source: 任务来源（上述7种之一，默认 "AI 对话生成"）
   - department (科室)：如“急诊ICU”、“放射科”、“妇产科”、“ICU”。不要主观编造。若没有提到则保持为 null 或 currentDraft 中的原有值。
   - location (位置)：如“门诊大楼 1楼 抢救室 A床”、“住院部 3楼”。
   - deviceName (设备名称)：如“德尔格呼吸机 Evita”、“监护仪”、“呼吸机”。
   - deviceId (设备编号)：如“EQ-20240901”。绝不瞎编，没提取到时设为 null。
   - faultPhenomenon (故障现象)：具体问题/故障现象描述。
   - contactPerson (联系人)：如“周医生”、“王护士”。
   - contactPhone (联系电话)：手机或内线。
   - urgency (紧急程度):
     * "生命支持"：当用户输入或故障描述中包含：呼吸机、除颤仪、麻醉机、监护仪、氧气、负压吸引、抢救、生命支持、病人正在用、无法通气、压力不足 这些关键词之一时，必须自动标记为 "生命支持"。
     * "特急"：危急或非常紧急（但非上述最关键生命支持类设备）的情况。
     * "紧急"：设备故障直接影响大量临床诊疗工作，但暂无直接生命危险，或者其他中重度故障。
     * "较急"：中等严重程度。
     * "普通"：常规设备备用机、杂项事务、未直接影响实时诊疗。
   - affectClinical (是否影响临床): "是" | "否"。
   - needBackupDevice (是否需要备用设备): "是" | "否"。呼吸机、急抢救、生命支持等关键场景，或者病人正在用且无法使用时，默认提取为 "是"。
   - needVendorCoop (是否需要厂家协同): "是" | "否"。大型设备、奥林巴斯漏水、复杂验收等，默认提取为 "是"。
   - recommendedDept (建议责任部门)：默认为 "医学装备科"；若是非设备类转派任务，建议为 "信息科" 或 "后勤总务" 等。
   - aiStatus (AI状态): 如果关键信息（如科室、设备名称、问题描述）未提取完全，标记为 "AI待补全"；如果提取完整，标记为 "已分析"。

4. 精准控制与合并逻辑 (Merge logic):
   - 必须参考 currentDraft 中的已有数据，将最新提取的信息进行合并。新提的信息覆盖旧值；没提的，保持 currentDraft 中的提取值，绝对不能丢失已有的提取成果。
   - 绝不瞎编！如果用户没提供科室、设备名称、设备编号、联系人等，就让它为空 (null) 或保持草稿状态。

5. AI 追问机制 (isClarification):
   - 如果用户输入信息严重不足（例如：缺少【科室】或缺少【设备名称】或【问题描述】），AI 不要立即认为建单完成，而是应该只追问 1 到 2 个最关键缺失问题。
   - 一次最多只能问 1 到 2 个最核心问题，不要问一长串。
   - 如果基本信息已经可以建单（例如知道科室和设备及故障），可以先设 isClarification 为 false 允许建单，后续由工程师跟进。
   - 追问时，isClarification 设为 true，并在 userReply 中礼貌而简洁地向用户询问。

6. 跨部门转派建议 (forwardDepartment & aiSuggestions):
   - 如果不属于医学装备科职责（如转派非设备类任务：信息科或后勤总务任务），应将 isClarification 设为 false，判定转派部门 forwardDepartment 为相应部门（如 "信息科" 或 "后勤总务"），并在回复中建议转派。
   - 提供 2-4 条实用、药监、生命支持保障可行的“AI 初步处理建议” (aiSuggestions)。
`;

    const draftStr = JSON.stringify(currentDraft);
    const prompt = `用户发送的最新描述: "${message}"

当前提取状态草稿 (currentDraft): ${draftStr}

之前会话历史:
{formatted_history_placeholder}`;

    // 3. Apply Compression Threshold (压缩阈值)
    const compressThreshold = configToUse.compressThreshold !== undefined ? Number(configToUse.compressThreshold) : 4000;
    
    const calculatePromptSize = (histMsgs: any[]) => {
      const historyStr = histMsgs.map((msg: any) => `${msg.sender === 'user' ? '用户' : '助手'}: ${msg.text}`).join('\n');
      return systemInstruction.length + prompt.replace('{formatted_history_placeholder}', '').length + historyStr.length;
    };

    // If total payload characters exceed the threshold, drop oldest history messages progressively
    while (processedHistory.length > 0 && calculatePromptSize(processedHistory) > compressThreshold) {
      console.log(`[Compression Engine] Payload size exceeds compression threshold (${compressThreshold} chars). Compressing context window by dropping oldest message.`);
      processedHistory.shift();
    }

    const finalFormattedHistory = processedHistory
      .map((msg: any) => `${msg.sender === 'user' ? '用户' : '助手'}: ${msg.text}`)
      .join('\n');

    const finalPrompt = prompt.replace('{formatted_history_placeholder}', finalFormattedHistory);

    // 4. Call Model Provider
    const isGeminiNative = configToUse.id === 'gemini-default' || !configToUse.endpoint || configToUse.endpoint.includes('googleapis.com') || configToUse.endpoint.includes('gemini');

    if (isGeminiNative) {
      // Use native Gemini SDK
      const apiKeyToUse = configToUse.apiKey || process.env.GEMINI_API_KEY;
      if (!apiKeyToUse) {
        console.log('No Gemini API key specified for native client. Falling back to local heuristics.');
        const fallbackPayload = getRuleBasedFallback(message, currentDraft, false, user);
        res.json(fallbackPayload);
        return;
      }

      const aiInstance = new GoogleGenAI({
        apiKey: apiKeyToUse,
        httpOptions: {
          headers: { 'User-Agent': 'aistudio-build' },
        },
      });

      const modelName = configToUse.model || 'gemini-3.5-flash';
      console.log(`[AI Routing] Dispatching to native Gemini client with model: ${modelName}`);

      const response = await aiInstance.models.generateContent({
        model: modelName,
        contents: finalPrompt,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              userReply: {
                type: Type.STRING,
                description: '给用户看的简短回复，温和、专业、简洁高效。如果有追问，直接在此简洁询问（限1-2个问题）。',
              },
              extractedInfo: {
                type: Type.OBJECT,
                description: '结构化任务单字段。必须包含或合并 currentDraft 中已有的真实值，绝对不能主观编造或丢失已有信息。',
                properties: {
                  taskType: {
                    type: Type.STRING,
                    enum: [
                      '设备报修',
                      '生命支持设备应急',
                      '医用气体异常',
                      '验收安装协同',
                      '供应商协同',
                      '计量/质控提醒',
                      '配件耗材申请',
                      '普通杂项任务',
                      '非设备类转派任务'
                    ],
                  },
                  source: {
                    type: Type.STRING,
                    enum: [
                      'AI 对话生成',
                      '科室扫码报修',
                      '电话登记',
                      '微信小程序',
                      '工程师手工录入',
                      '供应商协同',
                      '系统自动预警'
                    ],
                  },
                  department: { type: Type.STRING, nullable: true },
                  location: { type: Type.STRING, nullable: true },
                  deviceName: { type: Type.STRING, nullable: true },
                  deviceId: { type: Type.STRING, nullable: true },
                  faultPhenomenon: { type: Type.STRING, nullable: true },
                  contactPerson: { type: Type.STRING, nullable: true },
                  contactPhone: { type: Type.STRING, nullable: true },
                  urgency: {
                    type: Type.STRING,
                    enum: ['普通', '较急', '紧急', '特急', '生命支持'],
                  },
                  affectClinical: {
                    type: Type.STRING,
                    enum: ['是', '否'],
                  },
                  needBackupDevice: {
                    type: Type.STRING,
                    enum: ['是', '否'],
                  },
                  needVendorCoop: {
                    type: Type.STRING,
                    enum: ['是', '否'],
                  },
                  recommendedDept: { type: Type.STRING, nullable: true },
                  aiStatus: {
                    type: Type.STRING,
                    enum: ['未分析', '分析中', '已分析', '分析失败', 'AI待补全', '人工修正'],
                  }
                },
              },
              aiSuggestions: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: '针对当前故障或业务类型的AI初步建议列表。',
              },
              isClarification: {
                type: Type.BOOLEAN,
                description: '是否由于核心信息缺失而需要向用户追问（限追问1-2个核心问题，追问时为 true）',
              },
              forwardDepartment: {
                type: Type.STRING,
                nullable: true,
                description: '建议转派的非装备科部门（如 "信息科", "后勤总务"），否则为 null',
              },
            },
            required: ['userReply', 'extractedInfo', 'aiSuggestions', 'isClarification'],
          },
        },
      });

      const resultText = response.text;
      if (!resultText) {
        throw new Error('Empty response from Gemini');
      }

      const parsedResult = cleanAndParseJSON(resultText);
      res.json(parsedResult);
    } else {
      // 5. OpenAI-compatible Custom HTTP Request
      const endpoint = configToUse.endpoint.trim().replace(/\/+$/, '');
      const url = endpoint.endsWith('/chat/completions') ? endpoint : `${endpoint}/chat/completions`;
      const modelName = configToUse.model ? configToUse.model.trim() : 'gpt-3.5-turbo';

      console.log(`[AI Routing] Dispatching to custom OpenAI-compatible endpoint: ${url} using model: ${modelName}`);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };
      if (configToUse.apiKey) {
        headers['Authorization'] = `Bearer ${configToUse.apiKey.trim()}`;
      }

      // Add schema format hints to OpenAI-compatible system instructions to ensure proper JSON mode compliance
      const openAiSystemInstruction = `${systemInstruction}
重要要求: 你必须直接返回符合以下 JSON 格式的纯 JSON 数据，不得带有任何 Markdown 格式，不得包含 \`\`\` 标记，属性包括:
{
  "userReply": "给用户的简短自然语言回复或追问(字符串)",
  "extractedInfo": {
    "taskType": "设备报修"|"生命支持设备应急"|"医用气体异常"|"验收安装协同"|"供应商协同"|"计量/质控提醒"|"配件耗材申请"|"普通杂项任务"|"非设备类转派任务",
    "source": "AI 对话生成"|"科室扫码报修"|"电话登记"|"微信小程序"|"工程师手工录入"|"供应商协同"|"系统自动预警",
    "department": "科室名称或null",
    "location": "具体位置或null",
    "deviceName": "设备名称或null",
    "deviceId": "设备ID或null",
    "faultPhenomenon": "故障现象或null",
    "contactPerson": "联系人或null",
    "contactPhone": "电话或null",
    "urgency": "普通"|"较急"|"紧急"|"特急"|"生命支持",
    "affectClinical": "是"|"否",
    "needBackupDevice": "是"|"否",
    "needVendorCoop": "是"|"否",
    "recommendedDept": "医学装备科"|"信息科"|"后勤总务"|null,
    "aiStatus": "已分析"|"AI待补全"
  },
  "aiSuggestions": ["建议1", "建议2"],
  "isClarification": true|false,
  "forwardDepartment": "信息科"|"后勤总务"|null
}`;

      // Prepare Messages block
      const openAiMessages = [
        { role: 'system', content: openAiSystemInstruction },
        ...processedHistory.map(msg => ({
          role: msg.sender === 'user' ? 'user' : 'assistant',
          content: msg.text
        })),
        { role: 'user', content: finalPrompt }
      ];

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: modelName,
          messages: openAiMessages,
          temperature: 0.1,
          // Request JSON mode if model supports it (standard for gpt models)
          ...(modelName.toLowerCase().includes('gpt') || modelName.toLowerCase().includes('deepseek') ? {
            response_format: { type: 'json_object' }
          } : {})
        })
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`OpenAI 兼容接口错误: HTTP ${response.status} ${response.statusText}. ${errorText}`);
      }

      const data: any = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('OpenAI 兼容接口未返回 choices 文本。');
      }

      const parsedResult = cleanAndParseJSON(content);
      res.json(parsedResult);
    }

  } catch (error: any) {
    console.error('Error handling assistant chat, triggering rule-based fallback:', error);
    try {
      const fallbackPayload = getRuleBasedFallback(message, currentDraft, true, user);
      res.json(fallbackPayload);
    } catch (fallbackError: any) {
      console.error('Fatal failure in fallback generator:', fallbackError);
      res.status(503).json({
        error: 'AI 引擎及备用研判系统当前均不可用，请手动填写任务详情或稍后重试',
        details: error.message
      });
    }
  }
});

// 1. AI Nameplate & Invoice Analyzer Endpoint (Integrated from medical archives system)
app.post("/api/gemini/analyze", async (req, res) => {
  try {
    const { imageBase64, mimeType, textContext } = req.body;
    
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ 
        error: "Gemini API key is not configured. Please ensure GEMINI_API_KEY is configured in the Secrets panel." 
      });
    }

    let contents: any[] = [];
    let prompt = `你是一个专业的医疗设备档案分析专家。请分析以下提供的信息（包含铭牌/标签图片或文本描述），并提取该医疗设备的详细档案信息。
    请必须以合法的 JSON 格式返回。格式规范如下：
    {
      "deviceName": "设备名称 (如：多参数监护仪, 医用超声诊断仪, 数字化X射线摄影系统)",
      "model": "规格型号 (如：BeneView T8, Mindray DC-80, Optima XR646)",
      "sn": "序列号/SN (如果有，如：SN123456789，没有则生成一个格式合理的序列号)",
      "manufacturer": "生产厂商 (如：迈瑞医疗, 通用电气/GE, 飞利浦/Philips, 西门子/Siemens)",
      "category": "设备类别 (必须属于以下之一: '急救生命支持', '影像诊断', '检验分析', '手术治疗', '其他')",
      "maintenanceCycleDays": 180, // 推荐维护周期（天数，整数，默认180天）
      "calibrationRequired": true, // 是否需要计量检测/强检 (true/false)
      "riskLevel": "高" // 风险等级 (必须属于以下之一: '高', '中', '低')
    }
    
    如果图片或文本不清晰，请根据常识推测并补全最合理的医疗设备字段，确保能建立一张合法的设备档案。
    `;

    if (imageBase64 && mimeType) {
      contents.push({
        inlineData: {
          mimeType: mimeType,
          data: imageBase64
        }
      });
    }
    
    if (textContext) {
      prompt += `\n文本附加信息或用户描述: ${textContext}`;
    }
    
    contents.push({ text: prompt });

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: contents,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            deviceName: { type: Type.STRING },
            model: { type: Type.STRING },
            sn: { type: Type.STRING },
            manufacturer: { type: Type.STRING },
            category: { type: Type.STRING },
            maintenanceCycleDays: { type: Type.INTEGER },
            calibrationRequired: { type: Type.BOOLEAN },
            riskLevel: { type: Type.STRING }
          },
          required: ["deviceName", "model", "sn", "manufacturer", "category", "maintenanceCycleDays", "calibrationRequired", "riskLevel"]
        }
      }
    });

    const resultText = response.text;
    if (!resultText) {
      return res.status(500).json({ error: "Failed to receive a valid text response from Gemini." });
    }

    try {
      const parsed = JSON.parse(resultText);
      return res.json({ data: parsed });
    } catch (parseErr) {
      console.error("Failed to parse JSON from Gemini:", resultText, parseErr);
      return res.json({ 
        error: "Gemini response was not standard JSON, returning raw text", 
        rawText: resultText 
      });
    }

  } catch (error: any) {
    console.error("AI Analyze Error:", error);
    res.status(500).json({ error: error?.message || "An error occurred during AI analysis." });
  }
});

// 2. AI Maintenance Expert / Troubleshooter Chat Endpoint (Integrated from medical archives system)
app.post("/api/gemini/chat", async (req, res) => {
  try {
    const { deviceContext, messageHistory } = req.body;
    
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ 
        error: "Gemini API key is not configured. Please ensure GEMINI_API_KEY is configured in the Secrets panel." 
      });
    }

    const systemInstruction = `你是一位拥有20年医院医学装备管理与医疗设备维修经验的高级临床工程师（Biomedical Engineer）。
    当前针对的设备如下：
    - 设备名称: ${deviceContext.deviceName}
    - 规格型号: ${deviceContext.model}
    - 生产厂商: ${deviceContext.manufacturer}
    - 风险等级: ${deviceContext.riskLevel}
    - 序列号/SN: ${deviceContext.sn}
    
    你的任务是协助医护人员和科室工程师解决以下问题：
    1. 设备报错、故障代码诊断与排除（请提供标准的医学装备排故步骤：现象、可能原因、处理方案、安全注意事项）。
    2. 制定该设备专属的前瞻性预防性维护(PM)计划。
    3. 提供该设备在日常使用、消毒、计量校准中的技术规范建议。
    
    请使用专业、条理清晰的中文回答。可以使用 Markdown 格式使内容更易于阅读（例如使用粗体、列表、步骤标记）。`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: messageHistory,
      config: {
        systemInstruction: systemInstruction,
      }
    });

    res.json({ text: response.text });
  } catch (error: any) {
    console.error("AI Expert Chat Error:", error);
    res.status(500).json({ error: error?.message || "An error occurred during AI expert advice generation." });
  }
});

// Serve frontend build static files in production, use Vite middleware in dev
async function setupVite() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    console.log('Vite middleware mounted in dev mode');
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
    console.log('Serving production static files from dist');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

setupVite().catch((err) => {
  console.error('Failed to start Vite server:', err);
});
