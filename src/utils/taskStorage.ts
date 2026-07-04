import type {
  AiStatus,
  ClinicalAcceptanceRecord,
  ClinicalImpact,
  StructuredTicket,
  TaskLog,
  TaskSource,
  TaskStatus,
  TaskType,
  UrgencyLevel
} from '../types';
import { INITIAL_TASKS } from '../data/defaultTasks';
import { normalizeDepartmentName } from './departmentUtils';
import { repairMisroutedEquipmentTasks } from './taskRepair';

export const TASK_STORAGE_KEY = 'hospital_tasks';
const TASK_PRESET_MIGRATION_KEY = 'hospital_tasks_seeded_preset_ids';
const TASK_PRESET_MIGRATION_IDS = ['TKT-2026062805'];

const TASK_TYPES: TaskType[] = [
  '设备报修',
  '生命支持设备应急',
  '医用气体异常',
  '验收安装协同',
  '供应商协同',
  '计量/质控提醒',
  '配件耗材申请',
  '普通杂项任务',
  '非设备类转派任务'
];
const TASK_SOURCES: TaskSource[] = ['AI 对话生成', '科室扫码报修', '电话登记', '微信小程序', '工程师手工录入', '供应商协同', '系统自动预警'];
const URGENCY_LEVELS: UrgencyLevel[] = ['普通', '较急', '紧急', '特急', '生命支持'];
const CLINICAL_IMPACTS: ClinicalImpact[] = ['是', '否'];
const TASK_STATUSES: TaskStatus[] = ['待确认', '待派工', '已派工', '处理中', '待科室验收', '已完成', '已归档', '已关闭'];
const AI_STATUSES: AiStatus[] = ['未分析', '分析中', '已分析', '分析失败', 'AI待补全', '人工修正'];
const YES_NO = ['是', '否'] as const;

const TASK_STATUS_ALIASES: Record<string, TaskStatus> = {
  待响应派单: '待确认',
  待响应: '待确认',
  待处理: '待确认',
  进行中: '处理中',
  维修中: '处理中',
  完成: '已完成',
  已结单: '已完成'
};

const URGENCY_ALIASES: Record<string, UrgencyLevel> = {
  低: '普通',
  中: '较急',
  高: '紧急',
  急: '紧急',
  危急: '生命支持'
};

const EMPTY_TASK: StructuredTicket = {
  id: '',
  taskType: '设备报修',
  department: '未录入科室',
  location: '未录入位置',
  deviceName: '未录入设备名称',
  deviceId: 'EQ-TEMP-UNKNOWN',
  faultPhenomenon: '暂未提供具体描述',
  contactPerson: '未录入联系人',
  contactPhone: '未录入电话',
  urgency: '普通',
  affectClinical: '否',
  status: '待确认',
  aiStatus: 'AI待补全',
  source: 'AI 对话生成',
  createdAt: '',
  updatedAt: '',
  aiSuggestions: ['请医学装备科按闭环流程复核处理。'],
  logs: [
    {
      time: '',
      action: '系统导入：本地任务数据缺少有效流转记录，已自动补齐。',
      operator: '系统自愈'
    }
  ],
  needBackupDevice: '否',
  needVendorCoop: '否',
  recommendedDept: '医学装备科'
};

const getBrowserStorage = () => {
  return typeof localStorage === 'undefined' ? null : localStorage;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const cloneArray = <T>(value: T[] | undefined): T[] => {
  return Array.isArray(value) ? [...value] : [];
};

export const cloneTaskList = (tasks: StructuredTicket[]): StructuredTicket[] => {
  return tasks.map(task => ({
    ...task,
    aiSuggestions: cloneArray(task.aiSuggestions),
    logs: cloneArray(task.logs),
    clinicalAcceptance: task.clinicalAcceptance ? { ...task.clinicalAcceptance } : undefined
  }));
};

export const getDefaultTaskList = (): StructuredTicket[] => {
  return cloneTaskList(INITIAL_TASKS);
};

const getSeededPresetTaskIds = () => {
  const storage = getBrowserStorage();
  if (!storage) return new Set<string>();

  try {
    const parsed = JSON.parse(storage.getItem(TASK_PRESET_MIGRATION_KEY) || '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch (error) {
    console.warn('Failed to load seeded preset task ids:', error);
    return new Set<string>();
  }
};

const markPresetTaskMigrationsSeeded = () => {
  const storage = getBrowserStorage();
  if (!storage) return;

  const seededPresetIds = getSeededPresetTaskIds();
  const nextSeededPresetIds = new Set([...seededPresetIds, ...TASK_PRESET_MIGRATION_IDS]);
  storage.setItem(TASK_PRESET_MIGRATION_KEY, JSON.stringify([...nextSeededPresetIds]));
};

const mergeMissingPresetTasks = (storedTasks: StructuredTicket[]) => {
  const storedIds = new Set(storedTasks.map(task => task.id));
  const seededPresetIds = getSeededPresetTaskIds();
  const missingPresetTasks = INITIAL_TASKS.filter(
    task => TASK_PRESET_MIGRATION_IDS.includes(task.id) && !storedIds.has(task.id) && !seededPresetIds.has(task.id)
  );
  markPresetTaskMigrationsSeeded();

  return missingPresetTasks.length > 0 ? [...cloneTaskList(missingPresetTasks), ...storedTasks] : storedTasks;
};

const getDefaultForRecord = (record: Record<string, unknown>) => {
  const id = typeof record.id === 'string' ? record.id : '';
  return INITIAL_TASKS.find(task => task.id === id) || EMPTY_TASK;
};

const markAndReturn = <T>(value: T, markRepaired: () => void) => {
  markRepaired();
  return value;
};

const getString = (value: unknown, fallback: string, markRepaired: () => void) => {
  if (typeof value === 'string') return value;
  return markAndReturn(fallback, markRepaired);
};

const getOptionalString = (value: unknown, fallback: string | undefined, markRepaired: () => void) => {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return undefined;
  return markAndReturn(fallback, markRepaired);
};

const getNumber = (value: unknown, fallback: number, markRepaired: () => void) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return markAndReturn(fallback, markRepaired);
};

const getOption = <T extends string>(
  value: unknown,
  options: readonly T[],
  fallback: T,
  markRepaired: () => void,
  aliases: Record<string, T> = {}
) => {
  if (typeof value === 'string') {
    if (options.includes(value as T)) return value as T;
    if (aliases[value]) return markAndReturn(aliases[value], markRepaired);
  }
  return markAndReturn(fallback, markRepaired);
};

const getOptionalYesNo = (value: unknown, fallback: '是' | '否' | undefined, markRepaired: () => void) => {
  if (value === undefined || value === null) return fallback;
  return getOption(value, YES_NO, fallback || '否', markRepaired);
};

const getStringArray = (value: unknown, fallback: string[] | undefined, markRepaired: () => void) => {
  if (Array.isArray(value)) {
    const strings = value.filter((item): item is string => typeof item === 'string');
    if (strings.length === value.length) return strings;
    markRepaired();
    return strings.length > 0 ? strings : cloneArray(fallback);
  }

  return markAndReturn(cloneArray(fallback), markRepaired);
};

const normalizeTaskLog = (value: unknown, fallback: TaskLog | undefined, markRepaired: () => void) => {
  if (!isRecord(value)) {
    markRepaired();
    return fallback ? { ...fallback } : null;
  }

  return {
    time: getString(value.time, fallback?.time || '', markRepaired),
    action: getString(value.action, fallback?.action || '系统导入：本地任务数据缺少有效流转记录，已自动补齐。', markRepaired),
    operator: getString(value.operator, fallback?.operator || '系统自愈', markRepaired)
  };
};

const getTaskLogs = (value: unknown, fallback: TaskLog[] | undefined, markRepaired: () => void) => {
  if (!Array.isArray(value)) {
    return markAndReturn(cloneArray(fallback || EMPTY_TASK.logs), markRepaired);
  }

  const fallbackLogs = fallback || EMPTY_TASK.logs;
  const logs = value
    .map((item, index) => normalizeTaskLog(item, fallbackLogs[index], markRepaired))
    .filter((log): log is TaskLog => Boolean(log));

  if (logs.length === value.length && logs.length > 0) return logs;

  markRepaired();
  return logs.length > 0 ? logs : cloneArray(fallbackLogs);
};

const normalizeClinicalAcceptance = (
  value: unknown,
  fallback: ClinicalAcceptanceRecord | undefined,
  markRepaired: () => void
) => {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return markAndReturn(fallback, markRepaired);

  const rating = getNumber(value.rating, fallback?.rating || 5, markRepaired);
  return {
    rating: Math.min(5, Math.max(1, Math.round(rating))),
    comment: getString(value.comment, fallback?.comment || '设备使用一切正常', markRepaired),
    acceptedBy: getString(value.acceptedBy, fallback?.acceptedBy || '临床科室', markRepaired),
    acceptedByTitle: getString(value.acceptedByTitle, fallback?.acceptedByTitle || '科室验收人', markRepaired),
    acceptedAt: getString(value.acceptedAt, fallback?.acceptedAt || '', markRepaired)
  };
};

const normalizeTaskRecord = (value: unknown): { task: StructuredTicket | null; repaired: boolean } => {
  if (!isRecord(value)) {
    return { task: null, repaired: true };
  }

  let repaired = false;
  const markRepaired = () => {
    repaired = true;
  };
  const fallback = getDefaultForRecord(value);
  const id = getString(value.id, fallback.id, markRepaired);

  if (!id) {
    return { task: null, repaired: true };
  }

  const department = normalizeDepartmentName(getString(value.department, fallback.department, markRepaired)) || fallback.department;
  const task: StructuredTicket = {
    id,
    taskType: getOption(value.taskType, TASK_TYPES, fallback.taskType, markRepaired),
    department,
    location: getString(value.location, fallback.location, markRepaired),
    deviceName: getString(value.deviceName, fallback.deviceName, markRepaired),
    deviceId: getString(value.deviceId, fallback.deviceId, markRepaired),
    faultPhenomenon: getString(value.faultPhenomenon, fallback.faultPhenomenon, markRepaired),
    contactPerson: getString(value.contactPerson, fallback.contactPerson, markRepaired),
    contactPhone: getString(value.contactPhone, fallback.contactPhone, markRepaired),
    urgency: getOption(value.urgency, URGENCY_LEVELS, fallback.urgency, markRepaired, URGENCY_ALIASES),
    affectClinical: getOption(value.affectClinical, CLINICAL_IMPACTS, fallback.affectClinical, markRepaired),
    status: getOption(value.status, TASK_STATUSES, fallback.status, markRepaired, TASK_STATUS_ALIASES),
    aiStatus: getOption(value.aiStatus, AI_STATUSES, fallback.aiStatus, markRepaired),
    source: getOption(value.source, TASK_SOURCES, fallback.source, markRepaired),
    createdAt: getString(value.createdAt, fallback.createdAt, markRepaired),
    updatedAt: getString(value.updatedAt, fallback.updatedAt, markRepaired),
    aiSuggestions: getStringArray(value.aiSuggestions, fallback.aiSuggestions, markRepaired),
    logs: getTaskLogs(value.logs, fallback.logs, markRepaired),
    rawText: getOptionalString(value.rawText, fallback.rawText, markRepaired),
    notes: getOptionalString(value.notes, fallback.notes, markRepaired),
    clinicalAcceptance: normalizeClinicalAcceptance(value.clinicalAcceptance, fallback.clinicalAcceptance, markRepaired),
    needBackupDevice: getOptionalYesNo(value.needBackupDevice, fallback.needBackupDevice, markRepaired),
    needVendorCoop: getOptionalYesNo(value.needVendorCoop, fallback.needVendorCoop, markRepaired),
    recommendedDept: getOptionalString(value.recommendedDept, fallback.recommendedDept, markRepaired)
  };

  return { task, repaired };
};

export const parseStoredTaskList = (saved: string | null): { tasks: StructuredTicket[]; shouldPersist: boolean } => {
  if (!saved) {
    markPresetTaskMigrationsSeeded();
    return { tasks: getDefaultTaskList(), shouldPersist: true };
  }

  try {
    const parsed = JSON.parse(saved);

    if (!Array.isArray(parsed)) {
      return { tasks: getDefaultTaskList(), shouldPersist: true };
    }

    const normalized = parsed.map(normalizeTaskRecord);
    const uniqueTaskIds = new Set<string>();
    let removedDuplicate = false;
    const normalizedTasks = normalized
      .map(item => item.task)
      .filter((task): task is StructuredTicket => Boolean(task))
      .filter(task => {
        if (uniqueTaskIds.has(task.id)) {
          removedDuplicate = true;
          return false;
        }
        uniqueTaskIds.add(task.id);
        return true;
      });

    if (normalizedTasks.length === 0) {
      return { tasks: getDefaultTaskList(), shouldPersist: true };
    }

    const mergedTasks = mergeMissingPresetTasks(normalizedTasks);
    const { tasks, repaired } = repairMisroutedEquipmentTasks(mergedTasks);

    return {
      tasks,
      shouldPersist:
        normalized.some(item => item.repaired) ||
        normalizedTasks.length !== parsed.length ||
        mergedTasks.length !== normalizedTasks.length ||
        removedDuplicate ||
        repaired
    };
  } catch (error) {
    console.warn('Failed to load persisted tasks, falling back to defaults:', error);
    return { tasks: getDefaultTaskList(), shouldPersist: true };
  }
};

export const loadStoredTasks = () => {
  const storage = getBrowserStorage();
  if (!storage) return getDefaultTaskList();

  const { tasks, shouldPersist } = parseStoredTaskList(storage.getItem(TASK_STORAGE_KEY));
  if (shouldPersist) {
    storage.setItem(TASK_STORAGE_KEY, JSON.stringify(tasks));
  }

  return tasks;
};
