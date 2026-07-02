import { addLocalDays, getDateDiffDaysFromToday, getLocalDateString, getLocalDateTimeString } from '../src/utils/dateUtils.ts';
import { isSameDepartment } from '../src/utils/departmentUtils.ts';
import { parseStoredEquipmentList } from '../src/utils/equipmentStorage.ts';
import { syncTasksToEquipmentArchives } from '../src/utils/equipmentSync.ts';
import { getDepartmentTasks } from '../src/utils/taskOrdering.ts';
import {
  canEngineerCloseTransferredTask,
  getClinicalAcceptanceBlockReason,
  getEngineerNextStatus,
  getEngineerStatusBlockReason,
  getEngineerWorkflowHint,
  getRecommendedRoutingForTask
} from '../src/utils/taskWorkflow.ts';
import type { MedicalEquipment, StructuredTicket, UserProfile } from '../src/types.ts';
import { readFileSync } from 'node:fs';

type Check = {
  name: string;
  run: () => void;
};

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

const assertEqual = <T>(actual: T, expected: T, message: string) => {
  if (actual !== expected) {
    throw new Error(`${message}. Expected ${String(expected)}, got ${String(actual)}`);
  }
};

const assertIncludes = (actual: string, expected: string, message: string) => {
  if (!actual.includes(expected)) {
    throw new Error(`${message}. Expected "${actual}" to include "${expected}"`);
  }
};

const withoutConsoleWarn = <T>(callback: () => T) => {
  const originalWarn = console.warn;
  console.warn = () => undefined;

  try {
    return callback();
  } finally {
    console.warn = originalWarn;
  }
};

const createTask = (overrides: Partial<StructuredTicket> = {}): StructuredTicket => ({
  id: 'TKT-VERIFY-001',
  taskType: '设备报修',
  department: '呼吸内科',
  location: '呼吸内科病房',
  deviceName: '测试监护仪',
  deviceId: 'eq-verify-001',
  faultPhenomenon: '无法开机',
  contactPerson: '张护士',
  contactPhone: '1000',
  urgency: '普通',
  affectClinical: '是',
  status: '待确认',
  aiStatus: '已分析',
  source: 'AI 对话生成',
  createdAt: '2026-07-03T08:00:00+08:00',
  updatedAt: '2026-07-03T09:00:00+08:00',
  needBackupDevice: '否',
  needVendorCoop: '否',
  recommendedDept: '医学装备科',
  aiSuggestions: ['请装备科按闭环流程处理。'],
  logs: [
    {
      time: '2026-07-03 08:00',
      action: 'AI 自动受理并建单。',
      operator: 'AI 智能助手'
    }
  ],
  ...overrides
});

const createEquipment = (overrides: Partial<MedicalEquipment> = {}): MedicalEquipment => ({
  id: 'eq-verify-001',
  deviceName: '测试监护仪',
  model: 'Verify M1',
  sn: 'SN-VERIFY-001',
  manufacturer: '测试厂商',
  category: '急救生命支持',
  dept: '呼吸内科',
  status: '正常运行',
  riskLevel: '高',
  purchaseDate: '2026-01-01',
  purchaseCost: 1000,
  maintenanceCycleDays: 90,
  lastMaintenanceDate: '2026-04-01',
  nextMaintenanceDate: '2026-06-30',
  calibrationRequired: false,
  attachments: [],
  maintenanceLogs: [],
  calibrationLogs: [],
  ...overrides
});

const createUser = (overrides: Partial<UserProfile> = {}): UserProfile => ({
  id: 'DR-VERIFY',
  name: '测试医生',
  role: 'medical_staff',
  department: '呼吸内科',
  title: '主治医师',
  avatarText: '测',
  ...overrides
});

const checks: Check[] = [
  {
    name: 'engineer equipment task status flow stays sequential',
    run: () => {
      const task = createTask();
      assertEqual(getEngineerNextStatus(task), '待派工', '设备维修单下一步应进入待派工');
      assertEqual(getEngineerStatusBlockReason(task, '待派工'), '', '设备维修单应允许进入下一顺序状态');
      assertIncludes(getEngineerStatusBlockReason(task, '已完成'), '不能直接结单', '工程师不能直接把维修单改成已完成');
      assertIncludes(getEngineerStatusBlockReason(task, '已关闭'), '临床验收', '普通设备维修单不能绕过临床验收关闭');

      const acceptingTask = createTask({ status: '待科室验收' });
      assertIncludes(
        getEngineerStatusBlockReason(acceptingTask, '处理中'),
        '等待临床签署',
        '待科室验收状态不能由工程师回退'
      );

      const completedTask = createTask({ status: '已完成' });
      assertEqual(getEngineerNextStatus(completedTask), '已归档', '已完成工单下一步应建议归档');
      assertEqual(getEngineerStatusBlockReason(completedTask, '已归档'), '', '已完成工单应可归档');
      assertEqual(getEngineerStatusBlockReason(completedTask, '已关闭'), '', '已完成工单应可关闭留痕');

      const archivedTask = createTask({ status: '已归档' });
      assertIncludes(getEngineerStatusBlockReason(archivedTask, '已关闭'), '不能再变更', '终态工单应锁定');
    }
  },
  {
    name: 'clinical acceptance is restricted to the owning department',
    run: () => {
      const task = createTask({ status: '待科室验收', department: '呼吸内科' });
      const respiratoryDoctor = createUser({ department: '呼吸内科' });
      const otherDoctor = createUser({ id: 'DR-OTHER', department: '急诊科' });
      const engineer = createUser({ id: 'ENG-VERIFY', role: 'engineer', department: '医学装备科', title: '工程师' });

      assertEqual(
        getClinicalAcceptanceBlockReason(task, respiratoryDoctor, 'medical_staff'),
        '',
        '本科室临床账号应能验收待科室验收工单'
      );
      assertIncludes(
        getClinicalAcceptanceBlockReason(task, otherDoctor, 'medical_staff'),
        '当前登录科室',
        '外科室临床账号不能验收'
      );
      assertIncludes(
        getClinicalAcceptanceBlockReason(task, engineer, 'engineer'),
        '只有临床科室账号',
        '工程师账号不能执行临床验收'
      );
      assertIncludes(
        getClinicalAcceptanceBlockReason(createTask({ status: '处理中' }), respiratoryDoctor, 'medical_staff'),
        '待科室验收',
        '临床只能验收待科室验收状态'
      );
    }
  },
  {
    name: 'transferred non-equipment tasks can be closed without polluting medical repair flow',
    run: () => {
      const transferTask = createTask({
        id: 'TKT-VERIFY-TRANSFER',
        taskType: '非设备类转派任务',
        deviceName: '办公电脑',
        deviceId: 'PC-VERIFY-01',
        faultPhenomenon: 'HIS 系统无法登录，网络中断',
        recommendedDept: '信息科'
      });

      assert(canEngineerCloseTransferredTask(transferTask), '非设备转派任务应识别为可关闭留痕');
      assertEqual(getEngineerNextStatus(transferTask), '已关闭', '非设备转派任务应优先提示关闭留痕');
      assertEqual(getEngineerStatusBlockReason(transferTask, '已关闭'), '', '非设备转派任务应允许关闭');
      assertEqual(getEngineerStatusBlockReason(transferTask, '待派工'), '', '非设备转派任务仍可继续常规流转');
      assertIncludes(getEngineerWorkflowHint(transferTask), '信息科', '转派提示应显示目标归口科室');
    }
  },
  {
    name: 'routing recognizes information, logistics, and vendor cases',
    run: () => {
      const infoRouting = getRecommendedRoutingForTask('非设备类转派任务', '诊室电脑 HIS 系统无法登录，网络红叉');
      assertEqual(infoRouting.recommendedDept, '信息科', '电脑网络类问题应建议信息科');
      assertEqual(infoRouting.needVendorCoop, '否', '信息科转派不应标记厂家协同');

      const logisticsRouting = getRecommendedRoutingForTask('非设备类转派任务', '治疗室插座跳闸，照明异常');
      assertEqual(logisticsRouting.recommendedDept, '后勤保障科', '强电/照明问题应建议后勤保障科');

      const vendorRouting = getRecommendedRoutingForTask('供应商协同', '奥林巴斯设备需要返厂寄修');
      assertEqual(vendorRouting.recommendedDept, '医学装备科', '供应商协同应由医学装备科牵头');
      assertEqual(vendorRouting.needVendorCoop, '是', '供应商协同应标记厂家协同');
    }
  },
  {
    name: 'clinical department task visibility follows department aliases',
    run: () => {
      assert(isSameDepartment('呼吸', '呼吸内科'), '呼吸科室别名应归一');
      assert(isSameDepartment('ICU', '重症医学科 (ICU)'), 'ICU 别名应归一');

      const tasks = [
        createTask({ id: 'TKT-RESP', department: '呼吸内科', status: '处理中' }),
        createTask({ id: 'TKT-ER', department: '急诊科', status: '待科室验收' })
      ];
      const visibleTasks = getDepartmentTasks(tasks, '呼吸');
      assertEqual(visibleTasks.length, 1, '呼吸内科临床用户只能看到本科室任务');
      assertEqual(visibleTasks[0].id, 'TKT-RESP', '呼吸内科可见任务应为本科室任务');
    }
  },
  {
    name: 'equipment archive sync updates real equipment work orders only',
    run: () => {
      const activeTask = createTask({
        id: 'TKT-ACTIVE',
        status: '处理中',
        deviceId: 'eq-verify-001',
        recommendedDept: '医学装备科'
      });
      const activeSync = syncTasksToEquipmentArchives([activeTask], [createEquipment()], new Date('2026-07-03T00:00:00+08:00'));
      assertEqual(activeSync.equipments[0].status, '故障维修', '活跃设备维修单应把档案状态标为故障维修');

      const completedTask = createTask({
        id: 'TKT-COMPLETE',
        status: '已完成',
        deviceId: 'eq-verify-001',
        updatedAt: '2026-07-03T10:00:00+08:00',
        logs: [
          { time: '2026-07-03 09:00', action: '到场维修完成。', operator: '李工 (工程师)' },
          { time: '2026-07-03 10:00', action: '临床确认验收。', operator: '张护士' }
        ],
        clinicalAcceptance: {
          rating: 5,
          comment: '设备运行正常',
          acceptedBy: '张护士',
          acceptedByTitle: '护士',
          acceptedAt: '2026-07-03T10:00:00+08:00'
        }
      });
      const completedSync = syncTasksToEquipmentArchives(
        [completedTask],
        [createEquipment({ status: '故障维修' })],
        new Date('2026-07-03T00:00:00+08:00')
      );
      assertEqual(completedSync.equipments[0].status, '正常运行', '完成的设备维修单应恢复设备状态');
      assertEqual(completedSync.equipments[0].lastMaintenanceDate, '2026-07-03', '完成日期应写入最近维保日期');
      assertEqual(completedSync.equipments[0].nextMaintenanceDate, '2026-10-01', '下次维保日期应按本地日期加周期');
      assert(
        completedSync.equipments[0].maintenanceLogs.some(log => log.workOrderNo === 'TKT-COMPLETE'),
        '完成的设备维修单应写入档案维保履历'
      );

      const transferTask = createTask({
        id: 'TKT-TRANSFER-SAME-ID',
        taskType: '非设备类转派任务',
        status: '已关闭',
        deviceName: '办公电脑',
        deviceId: 'eq-verify-001',
        faultPhenomenon: 'HIS 登录失败',
        recommendedDept: '信息科'
      });
      const transferSync = syncTasksToEquipmentArchives([transferTask], [createEquipment()], new Date('2026-07-03T00:00:00+08:00'));
      assertEqual(transferSync.changed, false, '转派关闭单不应触发设备档案变更');
      assertEqual(transferSync.equipments[0].maintenanceLogs.length, 0, '转派关闭单不应写入医疗设备维保履历');
      assertEqual(transferSync.equipments[0].status, '正常运行', '转派关闭单不应改变设备运行状态');
    }
  },
  {
    name: 'date and storage helpers are stable for local workflows',
    run: () => {
      assertEqual(addLocalDays('2026-07-03', 90), '2026-10-01', '本地日期加 90 天应稳定');
      assertEqual(addLocalDays('2028-02-28', 1), '2028-02-29', '闰年本地日期应正确进位');
      assertEqual(getLocalDateString(new Date(2026, 6, 3, 0, 5)), '2026-07-03', '本地日期不应受 UTC 截断影响');
      assertEqual(getLocalDateTimeString(new Date(2026, 6, 3, 0, 5)), '2026-07-03 00:05', '本地日期时间应保留本地时分');
      assertEqual(getDateDiffDaysFromToday(getLocalDateString()), 0, '今天与今天的日期差应为 0');
      assertEqual(getDateDiffDaysFromToday(addLocalDays(getLocalDateString(), -1)), -1, '昨天与今天的日期差应为 -1');

      const emptyStorage = parseStoredEquipmentList(null);
      assert(emptyStorage.equipments.length > 0, '空设备存储应回退默认设备列表');
      assertEqual(emptyStorage.shouldPersist, true, '空设备存储回退后应提示持久化');

      const corruptStorage = withoutConsoleWarn(() => parseStoredEquipmentList('{not json'));
      assert(corruptStorage.equipments.length > 0, '损坏设备存储应回退默认设备列表');
      assertEqual(corruptStorage.shouldPersist, true, '损坏设备存储回退后应提示持久化');
    }
  },
  {
    name: 'engineer status control keeps current state read-only',
    run: () => {
      const appSource = readFileSync('src/App.tsx', 'utf8');

      assert(
        appSource.includes('const isCurrentStatus = selectedTask.status === st;'),
        '状态快控应明确识别当前状态'
      );
      assert(
        appSource.includes('disabled={isCurrentStatus || isBlocked}'),
        '当前状态按钮应禁用，避免工程师误以为可重复点击'
      );
      assert(
        appSource.includes("title={isCurrentStatus ? '当前状态' : (blockReason || `切换至${st}`)}"),
        '当前状态按钮应给出明确提示'
      );
    }
  }
];

let passed = 0;

for (const check of checks) {
  check.run();
  passed += 1;
  console.log(`ok ${passed} - ${check.name}`);
}

console.log(`workflow verification passed (${passed} checks)`);
