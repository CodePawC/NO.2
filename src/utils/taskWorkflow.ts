import { StructuredTicket, TaskStatus, UserProfile } from '../types';
import { isSameDepartment } from './departmentUtils';

const TERMINAL_STATUSES: TaskStatus[] = ['已归档', '已关闭'];

export const getEngineerStatusBlockReason = (task: StructuredTicket, nextStatus: TaskStatus) => {
  if (task.status === nextStatus) {
    return '';
  }

  if (TERMINAL_STATUSES.includes(task.status)) {
    return '已归档或已关闭工单不能再变更状态。';
  }

  if (task.status === '已完成' && !TERMINAL_STATUSES.includes(nextStatus)) {
    return '已完成工单已完成临床验收签署，只能进入归档或关闭。';
  }

  if (nextStatus === '已完成') {
    return '工程师不能直接结单，请先转为【待科室验收】，由临床科室签署后自动完成。';
  }

  return '';
};

export const canEngineerSetStatus = (task: StructuredTicket, nextStatus: TaskStatus) => {
  return getEngineerStatusBlockReason(task, nextStatus) === '';
};

export const getClinicalAcceptanceBlockReason = (
  task: StructuredTicket,
  user: UserProfile,
  userRole: 'medical_staff' | 'engineer'
) => {
  if (userRole !== 'medical_staff' || user.role !== 'medical_staff') {
    return '只有临床科室账号可以执行验收签署。';
  }

  if (!isSameDepartment(task.department, user.department || user.dept)) {
    return '只能验收当前登录科室名下的工单。';
  }

  if (task.status !== '待科室验收') {
    return '只有处于【待科室验收】状态的工单才能签署结单。';
  }

  return '';
};
