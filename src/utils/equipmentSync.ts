import { MaintenanceLog, MedicalEquipment, StructuredTicket, TaskStatus } from '../types';
import { isSameDepartment } from './departmentUtils';
import { canEngineerCloseTransferredTask } from './taskWorkflow';

const ACTIVE_TASK_STATUSES: TaskStatus[] = ['待确认', '待派工', '已派工', '处理中', '待科室验收'];
const COMPLETED_TASK_STATUSES: TaskStatus[] = ['已完成', '已归档', '已关闭'];

const getLocalDateString = (date = new Date()) => {
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = safeDate.getFullYear();
  const month = String(safeDate.getMonth() + 1).padStart(2, '0');
  const day = String(safeDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getTaskCompletionDate = (task: StructuredTicket, fallbackDate: Date) => {
  const completedAt = new Date(task.updatedAt);
  return Number.isNaN(completedAt.getTime()) ? fallbackDate : completedAt;
};

const isSameOrLaterDateString = (nextDate: string, currentDate?: string) => {
  if (!currentDate) return true;
  return nextDate >= currentDate;
};

const isTaskForEquipment = (task: StructuredTicket, equipment: MedicalEquipment) => {
  return equipment.id === task.deviceId || equipment.sn === task.deviceId;
};

const normalizeEquipmentText = (value = '') => value
  .toLowerCase()
  .replace(/[（）()【】\[\]\s,，.。-]/g, '');

const EQUIPMENT_KEYWORDS = [
  '呼吸机',
  '监护仪',
  '除颤仪',
  '麻醉机',
  '输液泵',
  '注射泵',
  '血气分析仪',
  '生化分析仪',
  '分析仪',
  '超声',
  'dr',
  'mri',
  '磁共振',
  '胃镜'
].map(normalizeEquipmentText);

const getEquipmentKeywords = (value = '') => {
  const normalizedValue = normalizeEquipmentText(value);
  return EQUIPMENT_KEYWORDS.filter(keyword => normalizedValue.includes(keyword));
};

export const findUniqueEquipmentMatchForDraft = (
  equipmentArchives: MedicalEquipment[],
  draft: Pick<StructuredTicket, 'department' | 'deviceName'> | Partial<StructuredTicket>
) => {
  const draftDeviceName = normalizeEquipmentText(draft.deviceName || '');
  const draftDepartment = draft.department || '';
  const draftKeywords = getEquipmentKeywords(draft.deviceName || '');

  if (!draftDeviceName || !draftDepartment) {
    return null;
  }

  const matches = equipmentArchives.filter(equipment => {
    if (!isSameDepartment(equipment.dept, draftDepartment)) {
      return false;
    }

    const equipmentName = normalizeEquipmentText(equipment.deviceName);
    const manufacturer = normalizeEquipmentText(equipment.manufacturer);
    const model = normalizeEquipmentText(equipment.model);
    const combined = `${manufacturer}${equipmentName}${model}`;
    const equipmentKeywords = getEquipmentKeywords(`${equipment.deviceName} ${equipment.manufacturer} ${equipment.model}`);
    const hasSharedKeyword = draftKeywords.some(keyword => equipmentKeywords.includes(keyword));

    return equipmentName.includes(draftDeviceName) ||
      draftDeviceName.includes(equipmentName) ||
      combined.includes(draftDeviceName) ||
      hasSharedKeyword;
  });

  return matches.length === 1 ? matches[0] : null;
};

const shouldSyncTaskToEquipmentArchive = (task: StructuredTicket, equipment: MedicalEquipment) => {
  return isTaskForEquipment(task, equipment) && !canEngineerCloseTransferredTask(task);
};

const isOpenRepairLog = (log: MaintenanceLog) => {
  return log.type === '维修' && log.status === '进行中';
};

export const getLinkedArchiveWorkOrderNo = (task: StructuredTicket) => {
  const searchableText = [
    task.notes,
    ...task.aiSuggestions,
    ...task.logs.map(log => log.action)
  ].filter(Boolean).join('\n');

  return searchableText.match(/WO-\d{8}-\d{4}/)?.[0] || '';
};

const buildCompletedMaintenanceLog = (
  ticket: StructuredTicket,
  completedDate: string,
  lastLog: string,
  verifyingPerson: string
): MaintenanceLog => ({
  id: `ML-${ticket.id}-${completedDate.replace(/-/g, '')}`,
  type: ticket.taskType.includes('保养') || ticket.taskType.includes('PM') ? '保养' : '维修',
  date: completedDate,
  technician: ticket.logs.find(log => log.operator.includes('工程师'))?.operator || '值班科室工程师',
  description: `【智能闭环系统】工单 [${ticket.id}] 完成后自动归档。原故障描述：${ticket.faultPhenomenon || '无'}。最后维保说明：${lastLog}`,
  cost: ticket.taskType === '生命支持设备应急' ? 150 : 0,
  status: '已完成',
  workOrderNo: ticket.id,
  faultPhenomenon: ticket.faultPhenomenon,
  verifyPerson: verifyingPerson
});

export const syncTasksToEquipmentArchives = (
  tasks: StructuredTicket[],
  equipmentArchives: MedicalEquipment[],
  now = new Date()
) => {
  let changed = false;

  const equipments = equipmentArchives.map(equipment => {
    const relatedTasks = tasks.filter(task => shouldSyncTaskToEquipmentArchive(task, equipment));
    if (relatedTasks.length === 0) return equipment;

    let equipmentChanged = false;
    const maintenanceLogs = Array.isArray(equipment.maintenanceLogs)
      ? [...equipment.maintenanceLogs]
      : [];
    const syncedEquipment: MedicalEquipment = {
      ...equipment,
      maintenanceLogs
    };

    if (!Array.isArray(equipment.maintenanceLogs)) {
      equipmentChanged = true;
    }

    const hasActiveTask = relatedTasks.some(task => ACTIVE_TASK_STATUSES.includes(task.status));
    const hasCompletedTask = relatedTasks.some(task => COMPLETED_TASK_STATUSES.includes(task.status));
    const completingArchiveWorkOrders = new Set(
      relatedTasks
        .filter(task => COMPLETED_TASK_STATUSES.includes(task.status))
        .map(getLinkedArchiveWorkOrderNo)
        .filter(Boolean)
    );
    const hasOpenArchiveRepair = syncedEquipment.maintenanceLogs.some(log => (
      isOpenRepairLog(log) && !completingArchiveWorkOrders.has(log.workOrderNo || '')
    ));
    let targetStatus = syncedEquipment.status;

    if (hasActiveTask || hasOpenArchiveRepair) {
      targetStatus = '故障维修';
    } else if (hasCompletedTask && syncedEquipment.status === '故障维修') {
      targetStatus = '正常运行';
    }

    if (syncedEquipment.status !== targetStatus) {
      syncedEquipment.status = targetStatus;
      equipmentChanged = true;
    }

    relatedTasks
      .filter(ticket => COMPLETED_TASK_STATUSES.includes(ticket.status))
      .forEach(ticket => {
        const lastLog = ticket.logs[ticket.logs.length - 1]?.action || '确认闭合验收';
        const completionDate = getTaskCompletionDate(ticket, now);
        const completedDate = getLocalDateString(completionDate);
        const verifyingPerson = ticket.clinicalAcceptance?.acceptedBy || ticket.contactPerson || '科室管理员';
        const archiveWorkOrderNo = getLinkedArchiveWorkOrderNo(ticket);
        const archiveLogIndex = archiveWorkOrderNo
          ? syncedEquipment.maintenanceLogs.findIndex(log => log.workOrderNo === archiveWorkOrderNo)
          : -1;
        let maintenanceChanged = false;

        if (archiveLogIndex !== -1) {
          const archiveLog = syncedEquipment.maintenanceLogs[archiveLogIndex];
          if (
            archiveLog.status !== '已完成' ||
            archiveLog.verifyPerson !== verifyingPerson ||
            !archiveLog.description.includes(`主工单 ${ticket.id}`)
          ) {
            syncedEquipment.maintenanceLogs[archiveLogIndex] = {
              ...archiveLog,
              status: '已完成',
              date: archiveLog.date || completedDate,
              description: archiveLog.description.includes(`主工单 ${ticket.id}`)
                ? archiveLog.description
                : `${archiveLog.description}；主工单 ${ticket.id} 已闭环：${lastLog}`,
              verifyPerson: verifyingPerson
            };
            maintenanceChanged = true;
          }
        } else if (!syncedEquipment.maintenanceLogs.some(log => log.workOrderNo === ticket.id)) {
          syncedEquipment.maintenanceLogs = [
            buildCompletedMaintenanceLog(ticket, completedDate, lastLog, verifyingPerson),
            ...syncedEquipment.maintenanceLogs
          ];
          maintenanceChanged = true;
        }

        if (maintenanceChanged && isSameOrLaterDateString(completedDate, syncedEquipment.lastMaintenanceDate)) {
          const nextMaintenanceDate = new Date(completionDate);
          nextMaintenanceDate.setDate(nextMaintenanceDate.getDate() + (syncedEquipment.maintenanceCycleDays || 180));
          syncedEquipment.lastMaintenanceDate = completedDate;
          syncedEquipment.nextMaintenanceDate = getLocalDateString(nextMaintenanceDate);
          equipmentChanged = true;
        } else if (maintenanceChanged) {
          equipmentChanged = true;
        }
      });

    if (equipmentChanged) {
      changed = true;
      return syncedEquipment;
    }

    return equipment;
  });

  return { equipments, changed };
};
