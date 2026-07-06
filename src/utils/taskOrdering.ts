import { StructuredTicket, TaskStatus, UrgencyLevel } from '../types';
import { isSameDepartment } from './departmentUtils';

const URGENCY_WEIGHT: Record<UrgencyLevel, number> = {
  '生命支持': 50,
  '特急': 40,
  '紧急': 30,
  '较急': 20,
  '普通': 10
};

const CLINICAL_STATUS_WEIGHT: Record<TaskStatus, number> = {
  '待确认': 45,
  '待派工': 50,
  '已派工': 55,
  '处理中': 60,
  '待科室验收': 70,
  '已完成': 20,
  '已归档': 10,
  '已关闭': 0
};

const TERMINAL_STATUSES: TaskStatus[] = ['已完成', '已归档', '已关闭'];

export const getUrgencyWeight = (urgency: UrgencyLevel) => URGENCY_WEIGHT[urgency] || 10;

export const isTaskClosedForPriority = (task: StructuredTicket) => {
  return TERMINAL_STATUSES.includes(task.status);
};

export const isPinnedCriticalTask = (task: StructuredTicket) => {
  return !isTaskClosedForPriority(task) && (
    task.taskType === '生命支持设备应急' ||
    task.taskType === '医用气体异常' ||
    task.deviceName.includes('抢救') ||
    task.faultPhenomenon.includes('抢救')
  );
};

export const sortTasksByOperationalPriority = (tasks: StructuredTicket[]) => {
  return [...tasks].sort((a, b) => {
    const isOpenA = !isTaskClosedForPriority(a);
    const isOpenB = !isTaskClosedForPriority(b);

    if (isOpenA && !isOpenB) return -1;
    if (!isOpenA && isOpenB) return 1;

    const isPinnedA = isPinnedCriticalTask(a);
    const isPinnedB = isPinnedCriticalTask(b);

    if (isPinnedA && !isPinnedB) return -1;
    if (!isPinnedA && isPinnedB) return 1;

    const scoreA = getUrgencyWeight(a.urgency);
    const scoreB = getUrgencyWeight(b.urgency);

    if (scoreA !== scoreB) {
      return scoreB - scoreA;
    }

    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
};

export const sortTasksByClinicalPriority = (tasks: StructuredTicket[]) => {
  return [...tasks].sort((a, b) => {
    const statusScoreA = CLINICAL_STATUS_WEIGHT[a.status] || 0;
    const statusScoreB = CLINICAL_STATUS_WEIGHT[b.status] || 0;

    if (statusScoreA !== statusScoreB) {
      return statusScoreB - statusScoreA;
    }

    const isPinnedA = isPinnedCriticalTask(a);
    const isPinnedB = isPinnedCriticalTask(b);

    if (isPinnedA && !isPinnedB) return -1;
    if (!isPinnedA && isPinnedB) return 1;

    const urgencyScoreA = getUrgencyWeight(a.urgency);
    const urgencyScoreB = getUrgencyWeight(b.urgency);

    if (urgencyScoreA !== urgencyScoreB) {
      return urgencyScoreB - urgencyScoreA;
    }

    const timeA = new Date(a.updatedAt || a.createdAt).getTime();
    const timeB = new Date(b.updatedAt || b.createdAt).getTime();
    return timeB - timeA;
  });
};

export const getDepartmentTasks = (tasks: StructuredTicket[], department?: string) => {
  return sortTasksByClinicalPriority(tasks.filter(task => isSameDepartment(task.department, department)));
};