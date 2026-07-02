import { addLocalDays, getDateDiffDaysFromToday, getLocalDateString, getLocalDateTimeString } from '../src/utils/dateUtils.ts';
import { isSameDepartment } from '../src/utils/departmentUtils.ts';
import { parseStoredEquipmentList } from '../src/utils/equipmentStorage.ts';
import { syncTasksToEquipmentArchives } from '../src/utils/equipmentSync.ts';
import { getDepartmentTasks } from '../src/utils/taskOrdering.ts';
import { getPresetPromptsForUser, PRESET_PROMPTS } from '../src/data/appPresets.ts';
import {
  canEngineerCloseTransferredTask,
  getClinicalAcceptanceBlockReason,
  getEngineerNextStatus,
  getEngineerStatusBlockReason,
  getEngineerWorkflowHint,
  needsClinicalAcceptance,
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
      assertEqual(needsClinicalAcceptance(transferTask), false, '非设备转派任务不应要求临床设备验收');
      assertIncludes(
        getClinicalAcceptanceBlockReason({ ...transferTask, status: '待科室验收' }, createUser({ department: '呼吸内科' }), 'medical_staff'),
        '不需要临床进行设备维修验收',
        '临床端不能验收非设备转派任务'
      );
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
  },
  {
    name: 'clinical archive selection never falls back to hidden equipment',
    run: () => {
      const archiveSource = readFileSync('src/components/EquipmentArchives.tsx', 'utf8');

      assert(
        archiveSource.includes('const selectedEquipment = visibleEquipments.find(eq => eq.id === selectedId) || visibleEquipments[0] || null;'),
        '临床无可见资产时应显示空态，不能回退到全院第一台设备'
      );
      assert(
        !archiveSource.includes('|| visibleEquipments[0] || equipments[0]'),
        '选中设备不能绕过 visibleEquipments 回退到隐藏资产'
      );
    }
  },
  {
    name: 'quick archive repair callback has app-level clinical department guard',
    run: () => {
      const appSource = readFileSync('src/App.tsx', 'utf8');
      const callbackStart = appSource.indexOf('const handleQuickRepairCreated = ({');
      const callbackEnd = appSource.indexOf('// Role and Auth Simulation States');
      assert(callbackStart !== -1 && callbackEnd > callbackStart, '应能定位快捷报修回调实现');
      const callbackSource = appSource.slice(callbackStart, callbackEnd);

      assert(
        callbackSource.includes("currentUserRole === 'medical_staff'") &&
          callbackSource.includes("currentSimulatedUser.role === 'medical_staff'"),
        '快捷报修回调应识别临床账号'
      );
      assert(
        callbackSource.includes('!isSameDepartment(equipment.dept, currentSimulatedUser.department || currentSimulatedUser.dept)'),
        '快捷报修回调应校验设备归属科室'
      );
      assert(
        callbackSource.includes('msg-quick-repair-blocked') && callbackSource.includes('return false;'),
        '快捷报修回调应阻断跨科室设备同步主工单'
      );
      assert(
        callbackSource.includes('return true;'),
        '快捷报修回调成功同步主工单后应返回确认结果'
      );
    }
  },
  {
    name: 'quick archive repair mutates archive only after parent accepts',
    run: () => {
      const archiveSource = readFileSync('src/components/EquipmentArchives.tsx', 'utf8');
      const createStart = archiveSource.indexOf('const createQuickRepairRecord = (');
      const createEnd = archiveSource.indexOf('const handleQuickRepair = () =>');
      assert(createStart !== -1 && createEnd > createStart, '应能定位档案快捷报修写入逻辑');
      const createSource = archiveSource.slice(createStart, createEnd);

      assert(
        createSource.includes('const parentAccepted = onQuickRepairCreated?.({'),
        '档案快捷报修应先请求父组件同步主工单'
      );
      assert(
        createSource.includes('if (parentAccepted === false)'),
        '父组件拒绝同步主工单时，档案快捷报修应停止写入'
      );
      assert(
        createSource.indexOf('const parentAccepted = onQuickRepairCreated?.({') < createSource.indexOf('setEquipments(updatedEquipments)'),
        '档案快捷报修必须在父组件接受后再更新资产档案'
      );
    }
  },
  {
    name: 'clinical task detail does not expose archive creation action',
    run: () => {
      const appSource = readFileSync('src/App.tsx', 'utf8');
      const clinicalStart = appSource.indexOf("{currentUserRole === 'medical_staff' ? (");
      const engineerStart = appSource.indexOf(') : selectedTask ? (', clinicalStart);
      assert(clinicalStart !== -1 && engineerStart > clinicalStart, '应能定位临床任务详情视图');
      const clinicalDetailSource = appSource.slice(clinicalStart, engineerStart);

      assert(
        clinicalDetailSource.includes('请等待医学装备科完成检索建档'),
        '临床端未关联档案时应显示等待装备科处理的只读提示'
      );
      assert(
        !clinicalDetailSource.includes('<span>检索建档</span>'),
        '临床端任务详情不能暴露工程师检索建档按钮'
      );
    }
  },
  {
    name: 'clinical quick presets stay in the current department context',
    run: () => {
      const respiratoryDoctor = createUser({
        name: '赵晓东',
        department: '呼吸内科',
        dept: '呼吸内科',
        phone: '分机 5610'
      });
      const clinicalPresets = getPresetPromptsForUser(respiratoryDoctor);
      const clinicalText = clinicalPresets.map(preset => `${preset.label} ${preset.text}`).join('\n');

      assert(
        clinicalPresets.every(preset => preset.text.includes('呼吸内科')),
        '临床快捷预设应全部带入当前登录科室'
      );
      assert(
        clinicalPresets.every(preset => preset.text.includes('赵晓东') && preset.text.includes('分机 5610')),
        '临床快捷预设应带入当前登录医护姓名和联系电话'
      );
      assert(
        !/放射科|妇产科|胃镜室|急诊科/.test(clinicalText),
        '临床快捷预设不能夹带其他演示科室文字'
      );

      const engineerPresets = getPresetPromptsForUser(createUser({
        role: 'engineer',
        department: '医学装备科',
        dept: '医学装备科'
      }));
      assertEqual(engineerPresets, PRESET_PROMPTS, '工程师端应继续保留全院演示快捷预设');
    }
  },
  {
    name: 'clinical transfer timeline uses handoff wording instead of repair acceptance',
    run: () => {
      const appSource = readFileSync('src/App.tsx', 'utf8');
      const clinicalStart = appSource.indexOf("{currentUserRole === 'medical_staff' ? (");
      const engineerStart = appSource.indexOf(') : selectedTask ? (', clinicalStart);
      assert(clinicalStart !== -1 && engineerStart > clinicalStart, '应能定位临床任务详情视图');
      const clinicalDetailSource = appSource.slice(clinicalStart, engineerStart);

      assert(
        clinicalDetailSource.includes('needsClinicalAcceptance(selectedTask)'),
        '临床详情应根据任务类型判断是否需要设备维修验收'
      );
      assert(
        clinicalDetailSource.includes('跨部门转派关闭留痕') &&
          clinicalDetailSource.includes('无需临床设备验收') &&
          clinicalDetailSource.includes('非设备问题已转派并关闭留痕'),
        '转派任务在临床时间线中应显示转派闭环文案'
      );
      assert(
        clinicalDetailSource.includes("selectedTask.status === '待科室验收' && needsClinicalAcceptance(selectedTask)"),
        '临床验收表单只能展示给需要设备维修验收的工单'
      );
      assert(
        clinicalDetailSource.includes("needsClinicalAcceptance(selectedTask) ? '故障报修追踪' : '转派事项追踪'"),
        '临床端非设备转派单标题应区别于设备故障报修'
      );
      assert(
        clinicalDetailSource.includes("selectedTask.status === '已关闭' || selectedTask.status === '已归档'"),
        '临床详情应为已关闭/已归档终态提供明确状态样式'
      );
    }
  },
  {
    name: 'clinical role switch preserves the focused same-department task',
    run: () => {
      const appSource = readFileSync('src/App.tsx', 'utf8');
      const switchStart = appSource.indexOf('const handleSwitchUser = (userId: string) => {');
      const switchEnd = appSource.indexOf('const [chatMessages, setChatMessages]', switchStart);
      assert(switchStart !== -1 && switchEnd > switchStart, '应能定位角色切换逻辑');
      const switchSource = appSource.slice(switchStart, switchEnd);

      assert(
        switchSource.includes('currentTaskBelongsToTargetDept') &&
          switchSource.includes('isSameDepartment(selectedTask.department, targetUser.department || targetUser.dept)') &&
          switchSource.includes('setSelectedTask(selectedTask);'),
        '切回临床同科室时应保留当前聚焦工单，避免关闭转派单被列表排序切走'
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
