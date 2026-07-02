/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type TaskType =
  | '设备报修'
  | '生命支持设备应急'
  | '医用气体异常'
  | '验收安装协同'
  | '供应商协同'
  | '计量/质控提醒'
  | '配件耗材申请'
  | '普通杂项任务'
  | '非设备类转派任务';

export type TaskSource =
  | 'AI 对话生成'
  | '科室扫码报修'
  | '电话登记'
  | '微信小程序'
  | '工程师手工录入'
  | '供应商协同'
  | '系统自动预警';

export type UrgencyLevel = '普通' | '较急' | '紧急' | '特急' | '生命支持';

export type ClinicalImpact = '是' | '否';

export type TaskStatus =
  | '待确认'
  | '待派工'
  | '已派工'
  | '处理中'
  | '待科室验收'
  | '已完成'
  | '已归档'
  | '已关闭';

export type AiStatus =
  | '未分析'
  | '分析中'
  | '已分析'
  | '分析失败'
  | 'AI待补全'
  | '人工修正';

export interface TaskLog {
  time: string;
  action: string;
  operator: string;
}

export interface StructuredTicket {
  id: string;
  taskType: TaskType;
  department: string; // 科室
  location: string; // 位置
  deviceName: string; // 设备名称
  deviceId: string; // 设备编号
  faultPhenomenon: string; // 故障现象
  contactPerson: string; // 联系人
  contactPhone: string; // 联系电话
  urgency: UrgencyLevel; // 紧急程度
  affectClinical: ClinicalImpact; // 是否影响临床
  status: TaskStatus; // 业务状态
  aiStatus: AiStatus; // AI状态
  source: TaskSource; // 任务来源
  createdAt: string;
  updatedAt: string;
  aiSuggestions: string[]; // AI初步处理建议
  logs: TaskLog[];
  rawText?: string;
  notes?: string; // 补充备注
  needBackupDevice?: '是' | '否'; // 是否需要备用设备
  needVendorCoop?: '是' | '否'; // 是否需要厂家协同
  recommendedDept?: string; // 建议责任部门
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'assistant';
  senderName?: string;
  text: string;
  timestamp: string;
  extractedInfo?: Partial<StructuredTicket>;
  isClarification?: boolean;
  rawJson?: string; // 包含AI返回的原始JSON
}

export interface LLMConfig {
  id: string;
  name: string;              // 供应商名称
  website: string;           // 官网链接
  apiKey: string;            // API Key
  endpoint: string;          // API 请求地址
  model: string;             // 模型名称 (例如 gpt-5-codex)
  contextLimit: number;      // 上下文容量
  compressThreshold: number; // 压缩阈值 (字符)
  isDefault?: boolean;       // 是否系统预置
}

export interface Attachment {
  id: string;
  name: string;
  type: 'manual' | 'invoice' | 'certificate' | 'other';
  size: string;
  uploadDate: string;
  fileUrl?: string;
}

export interface MaintenanceLog {
  id: string;
  type: '维修' | '保养';
  date: string;
  technician: string;
  description: string;
  cost: number;
  status: '已完成' | '进行中';
  workOrderNo?: string;        // 维保工单编号 (e.g. WO-2026-XXXX)
  faultPhenomenon?: string;    // 故障现象/报修描述 (e.g. 无法开机, 测量漂移)
  partsReplaced?: string;      // 更换配件及耗材规格
  pmChecklist?: string[];      // PM预防性维护检测清单
  verifyPerson?: string;       // 科室确认签字人
  photoUrl?: string;           // 检修现场或发票收据照片
}

export interface CalibrationLog {
  id: string;
  date: string;
  agency: string;
  certificateNo: string;
  result: '合格' | '准用' | '限用' | '不合格';
  validUntil: string;
  calibType?: '强制检定' | '首次检定' | '周期检定' | '校准/检测'; // 计量类别
  testerName?: string;         // 主检人/测试技术员
  verifyPerson?: string;       // 核验员/授权签字人
  errorDescription?: string;   // 测量误差与偏差、不确定度说明
  labelPhotoUrl?: string;      // 强检合格标签绿牌照片
}

export interface MedicalEquipment {
  id: string;
  deviceName: string;
  model: string;
  sn: string;
  manufacturer: string;
  category: '急救生命支持' | '影像诊断' | '检验分析' | '手术治疗' | '其他';
  dept: string;
  status: '正常运行' | '故障维修' | '计量中' | '已停用';
  riskLevel: '高' | '中' | '低';
  purchaseDate: string;
  purchaseCost: number;
  maintenanceCycleDays: number;
  lastMaintenanceDate: string;
  nextMaintenanceDate: string;
  calibrationRequired: boolean;
  lastCalibrationDate?: string;
  nextCalibrationDate?: string;
  attachments: Attachment[];
  maintenanceLogs: MaintenanceLog[];
  calibrationLogs: CalibrationLog[];
  
  registrationNo?: string;             // 医疗器械注册证号/备案凭证号
  registrationValidUntil?: string;     // 注册证有效期截止日 (YYYY-MM-DD)
  deviceClass?: 'I类' | 'II类' | 'III类' | '未分类'; // 医疗器械分类类别
  productionLicenseNo?: string;        // 生产企业许可证/备案凭证号
  
  photoUrl?: string;                   // 设备实物/规格照片
  extractedSnapshots?: ExtractedSnapshot[]; // 技术手册提取的关联快照
}

export interface ExtractedSnapshot {
  id: string;
  pageNum: number;
  title: string;
  imageUrl: string;
  extractedAt: string;
  sourceFileName: string;
  notes?: string;
}

export interface UserProfile {
  id: string;
  name: string;
  role: 'engineer' | 'medical_staff';
  dept?: string;
  department?: string;
  title: string;
  avatarText: string;
  avatarColor?: string;
  phone?: string;
}

