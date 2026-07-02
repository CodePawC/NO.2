import { StructuredTicket, TaskStatus, TaskType, UserProfile } from '../types';
import { isSameDepartment } from './departmentUtils';

const TERMINAL_STATUSES: TaskStatus[] = ['已归档', '已关闭'];
const STATUS_SEQUENCE: TaskStatus[] = ['待确认', '待派工', '已派工', '处理中', '待科室验收'];
const EQUIPMENT_DEPARTMENT = '医学装备科';

export const canEngineerCloseTransferredTask = (task: StructuredTicket) => {
  return task.taskType === '非设备类转派任务';
};

const canCloseWithoutClinicalAcceptance = (task: StructuredTicket) => {
  return task.status !== '已完成' && !TERMINAL_STATUSES.includes(task.status) && canEngineerCloseTransferredTask(task);
};

export const needsClinicalAcceptance = (task: StructuredTicket) => {
  return !canEngineerCloseTransferredTask(task);
};

export const getEngineerNextStatus = (task: StructuredTicket): TaskStatus | null => {
  if (task.status === '已完成') {
    return '已归档';
  }

  if (canCloseWithoutClinicalAcceptance(task)) {
    return '已关闭';
  }

  const currentIndex = STATUS_SEQUENCE.indexOf(task.status);
  if (currentIndex === -1) return null;

  return STATUS_SEQUENCE[currentIndex + 1] || null;
};

export const getEngineerWorkflowHint = (task: StructuredTicket) => {
  const nextStatus = getEngineerNextStatus(task);

  if (nextStatus) {
    if (task.status === '已完成') {
      return `临床已完成验收签署，建议下一步归档；如需终止留痕，可选择关闭。`;
    }

    if (canCloseWithoutClinicalAcceptance(task)) {
      const targetDept = task.recommendedDept?.trim() || '跨部门责任科室';
      return `系统判断此单归口【${targetDept}】，装备科完成转派记录后可直接关闭留痕；如仍需装备科继续跟进，也可按常规状态流转。`;
    }

    return `当前只能按闭环顺序进入【${nextStatus}】。完成现场维修后，请先转为【待科室验收】，由临床科室签署后自动结单。`;
  }

  if (task.status === '待科室验收') {
    return '已发起科室验收，请等待临床科室在临床端签署满意度并完成结单。';
  }

  if (TERMINAL_STATUSES.includes(task.status)) {
    return '该工单已归档或关闭，状态已锁定。';
  }

  return '请按工单闭环状态顺序进行流转。';
};

export const getEngineerStatusBlockReason = (task: StructuredTicket, nextStatus: TaskStatus) => {
  if (task.status === nextStatus) {
    return '';
  }

  if (TERMINAL_STATUSES.includes(task.status)) {
    return '已归档或已关闭工单不能再变更状态。';
  }

  if (nextStatus === '已关闭' && canCloseWithoutClinicalAcceptance(task)) {
    return '';
  }

  if (TERMINAL_STATUSES.includes(nextStatus) && task.status !== '已完成') {
    return '工单必须先完成临床验收签署，才能归档或关闭。';
  }

  if (task.status === '已完成' && !TERMINAL_STATUSES.includes(nextStatus)) {
    return '已完成工单已完成临床验收签署，只能进入归档或关闭。';
  }

  if (nextStatus === '已完成') {
    return '工程师不能直接结单，请先转为【待科室验收】，由临床科室签署后自动完成。';
  }

  if (task.status === '待科室验收') {
    return '已发起科室验收的工单需等待临床签署，不能由工程师回退状态。';
  }

  const currentIndex = STATUS_SEQUENCE.indexOf(task.status);
  const nextIndex = STATUS_SEQUENCE.indexOf(nextStatus);

  if (currentIndex !== -1 && nextIndex !== -1 && nextIndex !== currentIndex + 1) {
    return `请按工单闭环顺序流转：当前【${task.status}】下一步只能进入【${STATUS_SEQUENCE[currentIndex + 1]}】。`;
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

  if (!needsClinicalAcceptance(task)) {
    const targetDept = task.recommendedDept?.trim() || '责任科室';
    return `此单已转派【${targetDept}】处理，不需要临床进行设备维修验收。`;
  }

  if (task.status !== '待科室验收') {
    return '只有处于【待科室验收】状态的工单才能签署结单。';
  }

  return '';
};

export const getRecommendedRoutingForTask = (taskType?: TaskType, text = '') => {
  const normalizedText = text.toLowerCase();
  const isInformationIssue = /电脑|网络|网线|系统|his|pacs|lis|打印机|扫码枪|处方|开立|登录|his系统/i.test(normalizedText);
  const isMedicalEquipmentIssue = /呼吸机|除颤仪|麻醉机|监护仪|氧气|负压吸引|胃镜|内镜|dr机|dr房|注射泵|输液泵|超声|胎心|血气|生化|医学装备|医疗设备/i.test(normalizedText);
  const isEquipmentLeakIssue = /漏水/i.test(normalizedText) && /胃镜|内镜|奥林巴斯|插入管|探头|管路|设备|泵|机/i.test(normalizedText);
  const isLogisticsIssue = /后勤|跳闸|照明|插座|强电|水管|空调|门锁|电源插座|漏电|配电/i.test(normalizedText) || (/漏水/i.test(normalizedText) && !isEquipmentLeakIssue);
  const isVendorIssue = taskType === '供应商协同' || /厂家|供应商|外送|寄修|返厂|奥林巴斯|维保公司|售后/i.test(normalizedText);

  if (isVendorIssue) {
    return {
      recommendedDept: '医学装备科',
      needVendorCoop: '是' as const,
      routingNote: '系统识别需厂家或售后协同，建议由医学装备科牵头联系供应商。'
    };
  }

  if (isInformationIssue) {
    return {
      recommendedDept: '信息科',
      needVendorCoop: '否' as const,
      routingNote: '系统识别为信息化/电脑网络类问题，建议转派信息科。'
    };
  }

  if (isLogisticsIssue) {
    return {
      recommendedDept: '后勤保障科',
      needVendorCoop: '否' as const,
      routingNote: '系统识别为非医学装备故障，建议转派后勤保障科。'
    };
  }

  if (taskType === '非设备类转派任务' && !isMedicalEquipmentIssue) {
    return {
      recommendedDept: '信息科',
      needVendorCoop: '否' as const,
      routingNote: '系统识别为信息化/电脑网络类问题，建议转派信息科。'
    };
  }

  return {
    recommendedDept: '医学装备科',
    needVendorCoop: taskType === '验收安装协同' ? '是' as const : '否' as const,
    routingNote: ''
  };
};
