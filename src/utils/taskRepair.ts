import { StructuredTicket } from '../types';
import { getRecommendedRoutingForTask } from './taskWorkflow';

const REPAIRED_MISROUTED_EQUIPMENT_NOTE = '系统已自动修正历史误分类：该工单包含医学装备故障特征，恢复医学装备科闭环处理。';
const REOPENED_MISROUTED_EQUIPMENT_NOTE = '系统已自动重新开放历史误关闭医学装备单，请按装备科闭环流程重新确认、派工、维修并提交临床验收。';

const LIFE_SUPPORT_PATTERN = /呼吸机|除颤仪|麻醉机|监护仪|氧气|负压吸引|抢救|生命支持/i;
const REOPENABLE_TERMINAL_STATUSES = ['已关闭', '已归档'] as const;

const getRepairLogTime = (date: Date) => (
  date.toLocaleString('zh-CN', { hour12: false }).slice(0, 16)
);

export const repairMisroutedEquipmentTasks = (storedTasks: StructuredTicket[], now = new Date()) => {
  let repaired = false;
  const tasks = storedTasks.map(task => {
    if (task.taskType !== '非设备类转派任务') {
      return task;
    }

    const routingBasisText = `${task.faultPhenomenon || ''} ${task.deviceName || ''} ${task.notes || ''}`;
    const routing = getRecommendedRoutingForTask(task.taskType, routingBasisText);
    if (routing.recommendedDept !== '医学装备科') {
      return task;
    }

    repaired = true;
    const isLifeSupport = task.urgency === '生命支持' || LIFE_SUPPORT_PATTERN.test(routingBasisText);
    const shouldReopen = REOPENABLE_TERMINAL_STATUSES.includes(task.status as typeof REOPENABLE_TERMINAL_STATUSES[number]) && !task.clinicalAcceptance;
    const notes = [
      task.notes,
      task.notes?.includes(REPAIRED_MISROUTED_EQUIPMENT_NOTE) ? '' : REPAIRED_MISROUTED_EQUIPMENT_NOTE,
      shouldReopen && !task.notes?.includes(REOPENED_MISROUTED_EQUIPMENT_NOTE) ? REOPENED_MISROUTED_EQUIPMENT_NOTE : ''
    ].filter(Boolean).join('\n');

    return {
      ...task,
      taskType: isLifeSupport ? '生命支持设备应急' : '设备报修',
      status: shouldReopen ? '待确认' : task.status,
      updatedAt: shouldReopen ? now.toISOString() : task.updatedAt,
      recommendedDept: '医学装备科',
      needVendorCoop: routing.needVendorCoop,
      logs: shouldReopen
        ? [
          ...(Array.isArray(task.logs) ? task.logs : []),
          {
            time: getRepairLogTime(now),
            action: REOPENED_MISROUTED_EQUIPMENT_NOTE,
            operator: '系统自愈'
          }
        ]
        : task.logs,
      notes
    } satisfies StructuredTicket;
  });

  return { tasks, repaired };
};
