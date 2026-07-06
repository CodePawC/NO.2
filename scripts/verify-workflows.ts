import { addLocalDays, getDateDiffDaysFromToday, getLocalDateString, getLocalDateTimeString } from '../src/utils/dateUtils.ts';
import { isSameDepartment } from '../src/utils/departmentUtils.ts';
import { parseStoredEquipmentList } from '../src/utils/equipmentStorage.ts';
import { findUniqueEquipmentMatchForDraft, syncTasksToEquipmentArchives } from '../src/utils/equipmentSync.ts';
import { repairMisroutedEquipmentTasks } from '../src/utils/taskRepair.ts';
import { parseStoredTaskList } from '../src/utils/taskStorage.ts';
import { getDepartmentTasks } from '../src/utils/taskOrdering.ts';
import { normalizeEngineerName } from '../src/utils/engineerAssignments.ts';
import { getPresetPromptsForUser, PRESET_PROMPTS, SIMULATED_USERS } from '../src/data/appPresets.ts';
import { INITIAL_TASKS } from '../src/data/defaultTasks.ts';
import { DEFAULT_EQUIPMENT } from '../src/data/defaultEquipment.ts';
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
    name: 'equipment repair closes only after clinical acceptance record is captured',
    run: () => {
      const acceptingTask = createTask({
        id: 'TKT-VERIFY-ACCEPT',
        status: '待科室验收',
        department: '急诊科',
        taskType: '设备报修',
        deviceName: '监护仪',
        deviceId: 'eq-verify-001',
        logs: [
          { time: '2026-07-03 08:00', action: 'AI 自动受理并建单。', operator: 'AI 智能助手' },
          { time: '2026-07-03 08:20', action: '人工更改工单状态为【处理中】。', operator: '医学装备科人员' },
          { time: '2026-07-03 08:40', action: '人工更改工单状态为【待科室验收】。', operator: '医学装备科人员' }
        ]
      });
      const emergencyNurse = createUser({
        id: 'NU-VERIFY-ER',
        name: '王静',
        department: '急诊科',
        title: '主管护师'
      });
      const acceptedAt = '2026-07-03T09:00:00+08:00';
      const acceptedTask: StructuredTicket = {
        ...acceptingTask,
        status: '已完成',
        updatedAt: acceptedAt,
        logs: [
          ...acceptingTask.logs,
          {
            time: '2026-07-03 09:00',
            action: '临床科室进行验收。确认评价：【5星】。评价意见：设备运行正常。',
            operator: `${emergencyNurse.name} (${emergencyNurse.title})`
          }
        ],
        clinicalAcceptance: {
          rating: 5,
          comment: '设备运行正常',
          acceptedBy: emergencyNurse.name,
          acceptedByTitle: emergencyNurse.title,
          acceptedAt
        }
      };

      assertEqual(getClinicalAcceptanceBlockReason(acceptingTask, emergencyNurse, 'medical_staff'), '', '本科室临床应能签署待验收设备维修单');
      assertEqual(acceptedTask.status, '已完成', '临床验收后设备维修单应进入已完成');
      assertEqual(acceptedTask.clinicalAcceptance?.acceptedBy, '王静', '验收记录应保留签署人');
      assertEqual(acceptedTask.clinicalAcceptance?.rating, 5, '验收记录应保留满意度评分');
      assertEqual(getEngineerNextStatus(acceptedTask), '已归档', '临床验收后工程师下一步应归档');
      assertEqual(getEngineerStatusBlockReason(acceptedTask, '已归档'), '', '已完成设备维修单应允许归档');
      assertIncludes(getEngineerStatusBlockReason(acceptedTask, '处理中'), '只能进入归档或关闭', '已完成设备维修单不能回退到维修中');
    }
  },
  {
    name: 'clinical acceptance form resets rating state after submit',
    run: () => {
      const appSource = readFileSync('src/App.tsx', 'utf8');
      const acceptStart = appSource.indexOf('const handleClinicalAcceptTask = (taskId: string) => {');
      const acceptEnd = appSource.indexOf('// Manually update fields in active draft', acceptStart);
      assert(acceptStart !== -1 && acceptEnd > acceptStart, '应能定位临床验收提交逻辑');
      const acceptSource = appSource.slice(acceptStart, acceptEnd);

      assert(
        acceptSource.includes("setRatingComment('');") &&
          acceptSource.includes('setRatingValue(5);') &&
          acceptSource.indexOf("setRatingComment('');") < acceptSource.indexOf('setRatingValue(5);'),
        '临床验收提交后应同时清空评价文本并把评分恢复为默认 5 星，避免下一张工单继承上次评分'
      );
      assert(
        appSource.includes('const tasksRef = useRef(tasks);') &&
          appSource.includes('const pendingClinicalAcceptanceTaskIdsRef = useRef<Set<string>>(new Set());') &&
          appSource.includes('const [pendingClinicalAcceptanceTaskIds, setPendingClinicalAcceptanceTaskIds] = useState<Set<string>>(() => new Set());') &&
          acceptSource.includes('const targetTask = tasksRef.current.find(t => t.id === taskId);') &&
          acceptSource.includes('if (pendingClinicalAcceptanceTaskIdsRef.current.has(taskId))') &&
          acceptSource.includes('msg-accept-pending') &&
          acceptSource.includes('pendingClinicalAcceptanceTaskIdsRef.current.add(taskId);') &&
          acceptSource.includes('setPendingClinicalAcceptanceTaskIds(prev => new Set(prev).add(taskId));') &&
          acceptSource.includes('const nextTasks = tasksRef.current.map(t => t.id === taskId ? updatedTask : t);') &&
          acceptSource.includes('tasksRef.current = nextTasks;') &&
          acceptSource.includes('localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(nextStateTasks));') &&
          acceptSource.includes('pendingClinicalAcceptanceTaskIdsRef.current.delete(taskId);') &&
          acceptSource.includes('next.delete(taskId);'),
        '临床验收提交应基于最新任务列表写入、立即持久化并阻断同一工单连续点击，避免重复验收日志或刷新丢失'
      );
      assert(
        appSource.includes('id={`clinical-rating-star-${star}`}') &&
          appSource.includes('aria-label={`设置临床满意度为${star}星`}') &&
          appSource.includes('id={`clinical-rating-preset-${index + 1}`}') &&
          appSource.includes('aria-label={`填写验收评价：${preset}`}') &&
          appSource.includes('id="clinical-rating-comment"') &&
          appSource.includes('aria-label="临床验收补充意见"') &&
          appSource.includes('id="btn-clinical-accept-task"') &&
          appSource.includes("'签署临床验收并确认结单'"),
        '临床验收表单应提供稳定控件标识和可访问名称，便于人工识别、无障碍使用和自动化回归'
      );
      assert(
        appSource.includes('const isClinicalAcceptancePending = pendingClinicalAcceptanceTaskIds.has(selectedTask.id);') &&
          appSource.includes('disabled={isClinicalAcceptancePending}') &&
          appSource.includes("aria-label={isClinicalAcceptancePending ? '正在同步临床验收签署' : '签署临床验收并确认结单'}") &&
          appSource.includes("isClinicalAcceptancePending ? '正在同步验收签署...' : '签署签字并确认验收结单'") &&
          appSource.includes("placeholder={isClinicalAcceptancePending ? '正在同步验收签署，请稍候...' : '请填写您的补充意见（选填）...'}"),
        '临床验收表单应在签署同步中禁用输入与按钮并显示明确等待状态，避免用户连续点击产生混乱反馈'
      );
    }
  },
  {
    name: 'task detail draft inputs reset on task or role change',
    run: () => {
      const appSource = readFileSync('src/App.tsx', 'utf8');
      const formStateStart = appSource.indexOf('// Status modify form inside task detail');
      const formStateEnd = appSource.indexOf('const chatEndRef = useRef<HTMLDivElement>(null);', formStateStart);
      assert(formStateStart !== -1 && formStateEnd > formStateStart, '应能定位任务详情表单状态逻辑');
      const formStateSource = appSource.slice(formStateStart, formStateEnd);

      assert(
        formStateSource.includes("setRatingComment('');") &&
          formStateSource.includes('setRatingValue(5);') &&
          formStateSource.includes("setActiveLogAction('');") &&
          formStateSource.includes("setActiveLogOperator('');") &&
          formStateSource.includes('[selectedTask?.id, currentSimulatedUserId, currentUserRole]'),
        '切换工单或身份时应清空临床验收草稿与工程师日志草稿，避免上一单未提交内容被误用于下一单'
      );
    }
  },
  {
    name: 'engineer filtered task list keeps detail selection in sync',
    run: () => {
      const appSource = readFileSync('src/App.tsx', 'utf8');
      const filterStart = appSource.indexOf('// Filters calculation');
      const renderStart = appSource.indexOf('return (', filterStart);
      assert(filterStart !== -1 && renderStart > filterStart, '应能定位任务筛选与渲染前状态联动逻辑');
      const filterSource = appSource.slice(filterStart, renderStart);

      assert(
        filterSource.includes("const sortedAndFilteredTaskIds = sortedAndFilteredTasks.map(task => task.id).join('|');") &&
          filterSource.includes("if (currentUserRole !== 'engineer') return;") &&
          filterSource.includes('sortedAndFilteredTasks.some(task => task.id === selectedTask.id)') &&
          filterSource.includes('const fallbackTask = sortedAndFilteredTasks[0] || null;') &&
          filterSource.includes('setSelectedTask(fallbackTask);'),
        '工程师搜索/筛选任务后，右侧详情应自动同步到当前可见结果，避免左侧结果与右侧详情不一致'
      );
      assert(
        filterSource.includes("if (!fallbackTask && mobileTab === 'detail')") &&
          filterSource.includes("setMobileTab('list');"),
        '工程师移动端筛选无结果时应退出详情页，避免继续展示已被过滤掉的工单'
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
      assertIncludes(
        getEngineerStatusBlockReason({ ...transferTask, status: '处理中' }, '待科室验收'),
        '无需临床设备验收',
        '非设备转派任务不能进入待科室验收这种无验收入口的半状态'
      );
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
      const lifeSupportRouting = getRecommendedRoutingForTask('生命支持设备应急', 'ICU 呼吸机持续报警，病人正在使用，需要立即处理');
      assertEqual(lifeSupportRouting.recommendedDept, '医学装备科', '生命支持设备不能因“使用”等泛化词误判为信息科');
      assertEqual(lifeSupportRouting.needVendorCoop, '否', '普通呼吸机急修不应默认厂家协同');

      const equipmentSystemRouting = getRecommendedRoutingForTask('设备报修', '监护仪系统报警，病人正在使用中');
      assertEqual(equipmentSystemRouting.recommendedDept, '医学装备科', '医疗设备系统报警仍应归医学装备科');

      const mriSystemRouting = getRecommendedRoutingForTask('非设备类转派任务', '放射科 MRI 控制台启动后提示梯度系统错误，扫描序列无法开始');
      assertEqual(mriSystemRouting.recommendedDept, '医学装备科', 'MRI/影像设备控制台或梯度系统错误不能因“系统”误判为信息科');

      const infoRouting = getRecommendedRoutingForTask('非设备类转派任务', '诊室电脑 HIS 系统无法登录，网络红叉');
      assertEqual(infoRouting.recommendedDept, '信息科', '电脑网络类问题应建议信息科');
      assertEqual(infoRouting.needVendorCoop, '否', '信息科转派不应标记厂家协同');

      const logisticsRouting = getRecommendedRoutingForTask('非设备类转派任务', '治疗室插座跳闸，照明异常');
      assertEqual(logisticsRouting.recommendedDept, '后勤保障科', '强电/照明问题应建议后勤保障科');

      const logisticsLeakRouting = getRecommendedRoutingForTask('非设备类转派任务', '治疗室水管漏水，地面湿滑，需要后勤处理');
      assertEqual(logisticsLeakRouting.recommendedDept, '后勤保障科', '水管/场地漏水问题应建议后勤保障科');

      const vendorRouting = getRecommendedRoutingForTask('供应商协同', '奥林巴斯设备需要返厂寄修');
      assertEqual(vendorRouting.recommendedDept, '医学装备科', '供应商协同应由医学装备科牵头');
      assertEqual(vendorRouting.needVendorCoop, '是', '供应商协同应标记厂家协同');

      const noVendorRouting = getRecommendedRoutingForTask('设备报修', 'DR机房转运监护仪黑屏，暂不需要厂家，麻烦设备科看一下');
      assertEqual(noVendorRouting.recommendedDept, '医学装备科', '否定厂家协同时仍应归医学装备科');
      assertEqual(noVendorRouting.needVendorCoop, '否', '出现“暂不需要厂家”这类否定语义时不应误标厂家协同');

      const staleSupplierNoVendorRouting = getRecommendedRoutingForTask('供应商协同', 'DR机房转运监护仪黑屏，暂不需要厂家，麻烦设备科看一下');
      assertEqual(staleSupplierNoVendorRouting.recommendedDept, '医学装备科', '上游误分为供应商协同时仍应按设备问题归医学装备科');
      assertEqual(staleSupplierNoVendorRouting.needVendorCoop, '否', '即使草稿类型误为供应商协同，明确否定厂家时也不应标记厂家协同');

      const equipmentLeakRouting = getRecommendedRoutingForTask('供应商协同', '奥林巴斯胃镜插入管漏水，需要厂家协同检测');
      assertEqual(equipmentLeakRouting.recommendedDept, '医学装备科', '医学设备漏水不应被误判为后勤水电问题');
      assertEqual(equipmentLeakRouting.needVendorCoop, '是', '奥林巴斯/胃镜漏水应标记厂家协同');

      const implicitEndoscopeVendorRouting = getRecommendedRoutingForTask('设备报修', '胃镜插入管处漏水测试气密性不合格，画面模糊，疑似破损');
      assertEqual(implicitEndoscopeVendorRouting.recommendedDept, '医学装备科', '胃镜气密性漏水问题应归医学装备科牵头');
      assertEqual(implicitEndoscopeVendorRouting.needVendorCoop, '是', '胃镜气密性漏水即使未写厂家，也应识别为厂家协同');
    }
  },
  {
    name: 'recommended department alone cannot bypass clinical equipment acceptance',
    run: () => {
      const equipmentTaskWithExternalDept = createTask({
        taskType: '设备报修',
        recommendedDept: '信息科',
        deviceName: '呼吸机',
        faultPhenomenon: '呼吸机报警无法正常通气'
      });

      assertEqual(
        canEngineerCloseTransferredTask(equipmentTaskWithExternalDept),
        false,
        '设备维修单不能仅因建议责任部门被改成信息科就转为可关闭留痕'
      );
      assertEqual(
        needsClinicalAcceptance(equipmentTaskWithExternalDept),
        true,
        '设备维修单即便建议责任部门异常，也必须保留临床验收闭环'
      );
      assertIncludes(
        getEngineerStatusBlockReason(equipmentTaskWithExternalDept, '已关闭'),
        '临床验收',
        '设备维修单不能绕过临床验收直接关闭'
      );

      const trueTransferTask = createTask({
        taskType: '非设备类转派任务',
        recommendedDept: '信息科',
        deviceName: '诊室电脑',
        faultPhenomenon: 'HIS 系统无法登录，网络红叉'
      });
      assert(canEngineerCloseTransferredTask(trueTransferTask), '真实非设备转派任务仍应可关闭留痕');
      assertEqual(needsClinicalAcceptance(trueTransferTask), false, '真实非设备转派任务不要求临床设备验收');
    }
  },
  {
    name: 'stored task repair restores misrouted medical equipment closures',
    run: () => {
      const now = new Date('2026-07-03T10:00:00+08:00');
      const dirtyOpenTask = createTask({
        id: 'TKT-VERIFY-DIRTY-OPEN',
        taskType: '非设备类转派任务',
        recommendedDept: '信息科',
        deviceName: '呼吸机',
        deviceId: 'EQ-DRG-8812',
        urgency: '生命支持',
        status: '待确认',
        faultPhenomenon: 'ICU 呼吸机持续报警，病人正在使用'
      });
      const dirtyClosedTask = createTask({
        id: 'TKT-VERIFY-DIRTY-CLOSED',
        taskType: '非设备类转派任务',
        recommendedDept: '信息科',
        deviceName: '监护仪',
        urgency: '生命支持',
        status: '已关闭',
        faultPhenomenon: '监护仪系统报警，病人正在使用中',
        clinicalAcceptance: undefined
      });
      const trueTransferTask = createTask({
        id: 'TKT-VERIFY-TRUE-TRANSFER',
        taskType: '非设备类转派任务',
        recommendedDept: '信息科',
        deviceName: '诊室电脑',
        status: '已关闭',
        faultPhenomenon: '诊室电脑 HIS 系统无法登录，网络红叉'
      });

      const { tasks, repaired } = repairMisroutedEquipmentTasks([dirtyOpenTask, dirtyClosedTask, trueTransferTask], now);
      const repairedOpenTask = tasks.find(task => task.id === dirtyOpenTask.id);
      const repairedClosedTask = tasks.find(task => task.id === dirtyClosedTask.id);
      const untouchedTransferTask = tasks.find(task => task.id === trueTransferTask.id);

      assert(repaired, '历史误分类医学装备单应触发修正');
      assertEqual(repairedOpenTask?.taskType, '生命支持设备应急', '误标转派的呼吸机单应恢复为生命支持设备应急');
      assertEqual(repairedOpenTask?.recommendedDept, '医学装备科', '误标转派的呼吸机单应恢复医学装备科归口');
      assertIncludes(repairedOpenTask?.notes || '', '历史误分类', '修正后的开放工单应保留自愈说明');

      assertEqual(repairedClosedTask?.taskType, '生命支持设备应急', '误标转派的监护仪单应恢复为生命支持设备应急');
      assertEqual(repairedClosedTask?.status, '待确认', '误关闭且未临床验收的医学装备单应重新开放到待确认');
      assertEqual(repairedClosedTask?.updatedAt, now.toISOString(), '重新开放的医学装备单应更新时间戳');
      assert(
        repairedClosedTask?.logs.some(log => log.operator === '系统自愈' && log.action.includes('重新开放历史误关闭医学装备单')),
        '重新开放的医学装备单应写入系统自愈日志'
      );

      assertEqual(untouchedTransferTask?.taskType, '非设备类转派任务', '真实电脑网络转派单不能被历史修正误改');
      assertEqual(untouchedTransferTask?.status, '已关闭', '真实电脑网络转派单应保持原关闭状态');

      const storageSource = readFileSync('src/utils/taskStorage.ts', 'utf8');
      assert(
        storageSource.includes('repairMisroutedEquipmentTasks(mergedTasks)') &&
          storageSource.includes('storage.setItem(TASK_STORAGE_KEY, JSON.stringify(tasks));') &&
          storageSource.includes('repaired'),
        '修正后的历史任务应写回本地存储，避免每次加载重复修补'
      );

      const misroutedRouting = getRecommendedRoutingForTask('非设备类转派任务', 'ICU 呼吸机持续报警，病人正在使用');
      assertEqual(misroutedRouting.recommendedDept, '医学装备科', '误分类的呼吸机历史单应能被识别为医学装备科');

      const trueTransferRouting = getRecommendedRoutingForTask('非设备类转派任务', '诊室电脑 HIS 系统无法登录，网络红叉');
      assertEqual(trueTransferRouting.recommendedDept, '信息科', '真实电脑网络历史转派单不能被历史修正误改');
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
    name: 'mobile task tab badge follows role-visible task count',
    run: () => {
      const appSource = readFileSync('src/App.tsx', 'utf8');
      const tabStart = appSource.indexOf('id="btn-tab-list"');
      const tabEnd = appSource.indexOf('</button>', tabStart);
      assert(tabStart !== -1 && tabEnd > tabStart, '应能定位移动端任务看板标签按钮');
      const tabSource = appSource.slice(tabStart, tabEnd);

      assert(
        tabSource.includes('{visibleTasks.length > 0 &&') &&
          tabSource.includes('{visibleTasks.length}'),
        '移动端任务看板角标应按当前角色可见工单计数，临床端不能显示全院工单数量'
      );
      assert(
        !tabSource.includes('{tasks.length'),
        '移动端任务看板角标不能使用全量 tasks.length，否则临床端会泄露/误导全院任务数量'
      );
    }
  },
  {
    name: 'mobile task stats follows current role scope',
    run: () => {
      const appSource = readFileSync('src/App.tsx', 'utf8');
      const mobileStatsStart = appSource.indexOf('<div className="xl:hidden pb-1">');
      const mobileStatsEnd = appSource.indexOf('</div>', mobileStatsStart);
      assert(mobileStatsStart !== -1 && mobileStatsEnd > mobileStatsStart, '应能定位移动端任务统计看板');
      const mobileStatsSource = appSource.slice(mobileStatsStart, mobileStatsEnd);

      assert(
        mobileStatsSource.includes('userRole={currentUserRole}') &&
          mobileStatsSource.includes('simulatedUser={currentSimulatedUser}'),
        '移动端任务统计看板应按当前角色/科室统计，临床端不能显示全院任务统计'
      );
      assert(
        !mobileStatsSource.includes('<TaskStats tasks={tasks} />'),
        '移动端任务统计看板不能省略角色参数，否则会回退到工程师全院口径'
      );
    }
  },
  {
    name: 'task emergency stats exclude non-equipment transfers',
    run: () => {
      const appSource = readFileSync('src/App.tsx', 'utf8');
      assert(
        appSource.includes("const sidebarEmergencyCount = visibleTasks.filter(t => needsClinicalAcceptance(t) && (t.urgency === '生命支持' || t.urgency === '特急')).length;"),
        '侧边栏应急任务统计应只统计医学设备类应急，不能把电脑/后勤转派特急单算作设备抢救任务'
      );

      const statsSource = readFileSync('src/components/TaskStats.tsx', 'utf8');
      assert(
        statsSource.includes("import { needsClinicalAcceptance } from '../utils/taskWorkflow';") &&
          statsSource.includes("needsClinicalAcceptance(t) && (t.urgency === '特急' || t.urgency === '紧急' || t.urgency === '生命支持')") &&
          statsSource.includes("医学装备高危任务"),
        '任务统计看板的特急/紧急计数应排除非设备转派单，并用医学装备高危任务口径展示'
      );
      assert(
        statsSource.includes("const engineerInProgress = displayTasks.filter((t) => t.status === '处理中' || t.status === '已派工' || t.status === '待科室验收').length;") &&
          statsSource.includes("const clinicalAwaitingAcceptance = displayTasks.filter((t) => needsClinicalAcceptance(t) && t.status === '待科室验收').length;") &&
          statsSource.includes('const actionCount = isClinical ? clinicalAwaitingAcceptance : engineerInProgress;') &&
          statsSource.includes("{isClinical ? '待科室验收' : '全院处理/协作中'}") &&
          statsSource.includes("{isClinical ? '待您签署验收' : '驻场调配及厂家协同'}"),
        '临床端统计卡应突出待科室验收数量，不能把待验收单混称为工程师处置中'
      );

      const urgentEquipmentTask = createTask({
        id: 'TKT-URGENT-EQUIPMENT',
        taskType: '设备报修',
        urgency: '特急',
        status: '待确认'
      });
      const urgentTransferTask = createTask({
        id: 'TKT-URGENT-TRANSFER',
        taskType: '非设备类转派任务',
        deviceName: '诊室电脑',
        deviceId: 'NON-EQUIPMENT-TKT-URGENT-TRANSFER',
        urgency: '特急',
        status: '待确认',
        recommendedDept: '信息科'
      });
      const urgentStatCount = [urgentEquipmentTask, urgentTransferTask].filter(
        task => needsClinicalAcceptance(task) && ['特急', '紧急', '生命支持'].includes(task.urgency) && !['已关闭', '已完成', '已归档'].includes(task.status)
      ).length;

      assertEqual(urgentStatCount, 1, '统计口径应保留设备特急单，同时排除非设备转派特急单');
    }
  },
  {
    name: 'mobile sidebar navigation is accessible and testable',
    run: () => {
      const appSource = readFileSync('src/App.tsx', 'utf8');
      const headerStart = appSource.indexOf('{/* Mobile Top Header */}');
      const sidebarStart = appSource.indexOf('{/* Left Sidebar Navigation Menu */}', headerStart);
      const sidebarEnd = appSource.indexOf('{/* Mobile Sidebar Overlay Backdrop */}', sidebarStart);
      assert(headerStart !== -1 && sidebarStart > headerStart && sidebarEnd > sidebarStart, '应能定位移动端头部与侧边导航');
      const mobileHeaderSource = appSource.slice(headerStart, sidebarStart);
      const sidebarSource = appSource.slice(sidebarStart, sidebarEnd);

      assert(
        mobileHeaderSource.includes("aria-label={isSidebarOpen ? '关闭侧边导航' : '打开侧边导航'}") &&
          mobileHeaderSource.includes('aria-expanded={isSidebarOpen}') &&
          mobileHeaderSource.includes('aria-controls="sidebar-navigation"'),
        '移动端侧边栏图标按钮应有可读名称、展开状态和受控区域，方便真实用户与自动化测试定位'
      );
      assert(
        sidebarSource.includes('id="sidebar-navigation"') &&
          sidebarSource.includes("setCurrentWorkspace('archives')") &&
          sidebarSource.includes('setIsSidebarOpen(false);'),
        '移动端侧边栏应提供稳定受控区域，并在进入资产档案后自动收起'
      );
    }
  },
  {
    name: 'default data includes a clinical acceptance demo task',
    run: () => {
      const respiratoryDoctor = createUser({
        id: 'DR-3011',
        role: 'medical_staff',
        department: '呼吸内科',
        dept: '呼吸内科',
        name: '赵晓东',
        title: '呼吸内科主治医生'
      });
      const acceptanceDemoTask = INITIAL_TASKS.find(
        task => task.id === 'TKT-2026062805' && task.status === '待科室验收'
      );

      assert(!!acceptanceDemoTask, '默认任务应包含一张待科室验收的呼吸内科演示单');
      assertEqual(acceptanceDemoTask?.department, '呼吸内科', '演示验收单应归属呼吸内科，方便赵晓东角色测试');
      assertEqual(acceptanceDemoTask?.deviceId, 'eq-004', '演示验收单应关联呼吸内科无创呼吸机档案');
      assertEqual(
        getClinicalAcceptanceBlockReason(acceptanceDemoTask!, respiratoryDoctor, 'medical_staff'),
        '',
        '呼吸内科临床演示角色应可直接签署默认待验收单'
      );

      const respiratoryVisibleTasks = getDepartmentTasks(INITIAL_TASKS, '呼吸内科');
      assert(
        respiratoryVisibleTasks.some(task => task.id === 'TKT-2026062805'),
        '呼吸内科临床任务列表应能看到默认待验收演示单'
      );

      const linkedDefaultTaskIds = ['TKT-2026062801', 'TKT-2026062802', 'TKT-2026062803', 'TKT-2026062805'];
      linkedDefaultTaskIds.forEach(taskId => {
        const task = INITIAL_TASKS.find(item => item.id === taskId);
        const linkedEquipment = task && DEFAULT_EQUIPMENT.find(equipment => (
          equipment.id === task.deviceId ||
          equipment.sn === task.deviceId ||
          (equipment.deviceName === task.deviceName && isSameDepartment(equipment.dept, task.department))
        ));
        assert(!!linkedEquipment, `默认医疗设备工单 ${taskId} 应能关联默认设备档案`);
      });

      const storageSource = readFileSync('src/utils/taskStorage.ts', 'utf8');
      const mergeStart = storageSource.indexOf('const TASK_PRESET_MIGRATION_IDS');
      const mergeEnd = storageSource.indexOf('export const parseStoredTaskList', mergeStart);
      assert(mergeStart !== -1 && mergeEnd > mergeStart, '应能定位默认任务迁移逻辑');
      const mergeSource = storageSource.slice(mergeStart, mergeEnd);
      assert(
        mergeSource.includes("const TASK_PRESET_MIGRATION_IDS = ['TKT-2026062805'];") &&
          mergeSource.includes('TASK_PRESET_MIGRATION_KEY') &&
          mergeSource.includes('!seededPresetIds.has(task.id)') &&
          mergeSource.includes('markPresetTaskMigrationsSeeded();'),
        '新增演示单应通过一次性迁移补齐到已有本地数据，不能把所有默认任务反复补回'
      );

      const storedStart = storageSource.indexOf('export const parseStoredTaskList = (saved: string | null)');
      const storedEnd = storageSource.indexOf('export const loadStoredTasks', storedStart);
      assert(storedStart !== -1 && storedEnd > storedStart, '应能定位本地任务读取逻辑');
      const storedSource = storageSource.slice(storedStart, storedEnd);
      assert(
        storedSource.includes('if (!saved) {') &&
          storedSource.includes('markPresetTaskMigrationsSeeded();') &&
          storedSource.includes('getDefaultTaskList()'),
        '首次加载默认任务时也应记录迁移标记，避免用户删除演示单后刷新又被补回'
      );

      const appSource = readFileSync('src/App.tsx', 'utf8');
      assert(
        appSource.includes("import { loadStoredTasks, TASK_STORAGE_KEY } from './utils/taskStorage';") &&
          appSource.includes('useState<StructuredTicket[]>(loadStoredTasks)'),
        'App 应通过任务存储工具初始化本地任务，避免组件内重复维护迁移和修复逻辑'
      );
    }
  },
  {
    name: 'equipment archive sync updates real equipment work orders only',
    run: () => {
      const matchedRespiratoryEquipment = findUniqueEquipmentMatchForDraft(
        [
          createEquipment({ id: 'eq-resp', deviceName: '无创呼吸机', dept: '呼吸内科' }),
          createEquipment({ id: 'eq-rad', deviceName: 'DR机房转运监护仪', dept: '放射科' })
        ],
        { department: '呼吸内科', deviceName: '呼吸机' }
      );
      assertEqual(matchedRespiratoryEquipment?.id, 'eq-resp', '临床草稿应能唯一匹配本科室在册设备');

      const brandedRespiratoryEquipment = findUniqueEquipmentMatchForDraft(
        [
          createEquipment({ id: 'eq-resp', deviceName: '无创呼吸机', dept: '呼吸内科' }),
          createEquipment({ id: 'eq-rad', deviceName: 'DR机房转运监护仪', dept: '放射科' })
        ],
        { department: '呼吸内科', deviceName: '德尔格呼吸机' }
      );
      assertEqual(brandedRespiratoryEquipment?.id, 'eq-resp', '临床草稿包含品牌名时仍应匹配本科室同类在册设备');

      const noCrossDepartmentMatch = findUniqueEquipmentMatchForDraft(
        [createEquipment({ id: 'eq-icu', deviceName: '多参数监护仪', dept: '重症医学科 (ICU)' })],
        { department: '急诊科', deviceName: '监护仪' }
      );
      assertEqual(noCrossDepartmentMatch, null, '临床草稿不能自动匹配外科室设备');

      const ambiguousRespiratoryEquipment = findUniqueEquipmentMatchForDraft(
        [
          createEquipment({ id: 'eq-resp-1', deviceName: '无创呼吸机', dept: '呼吸内科' }),
          createEquipment({ id: 'eq-resp-2', deviceName: '转运呼吸机', dept: '呼吸内科' })
        ],
        { department: '呼吸内科', deviceName: '呼吸机' }
      );
      assertEqual(ambiguousRespiratoryEquipment, null, '同科室多台同类设备时不能自动关联，需人工选择');

      const activeTask = createTask({
        id: 'TKT-ACTIVE',
        status: '处理中',
        deviceId: 'eq-verify-001',
        recommendedDept: '医学装备科'
      });
      const activeSync = syncTasksToEquipmentArchives([activeTask], [createEquipment()], new Date('2026-07-03T00:00:00+08:00'));
      assertEqual(activeSync.equipments[0].status, '故障维修', '活跃设备维修单应把档案状态标为故障维修');

      const acceptanceDemoTask = INITIAL_TASKS.find(task => task.id === 'TKT-2026062805');
      const respiratoryVentilator = DEFAULT_EQUIPMENT.find(equipment => equipment.id === 'eq-004');
      assert(!!acceptanceDemoTask && !!respiratoryVentilator, '默认验收演示单与呼吸内科无创呼吸机档案应同时存在');
      const activeDemoSync = syncTasksToEquipmentArchives(
        [acceptanceDemoTask!],
        [{ ...respiratoryVentilator!, status: '正常运行', maintenanceLogs: [...respiratoryVentilator!.maintenanceLogs] }],
        new Date('2026-07-03T00:00:00+08:00')
      );
      assertEqual(activeDemoSync.equipments[0].status, '故障维修', '待验收演示单应把关联呼吸机档案标为故障维修');

      const acceptedDemoTask = createTask({
        ...acceptanceDemoTask!,
        status: '已完成',
        updatedAt: '2026-07-03T11:00:00+08:00',
        logs: [
          ...acceptanceDemoTask!.logs,
          { time: '2026-07-03 11:00', action: '临床科室进行验收。确认评价：【5星】。评价意见：设备使用一切正常。', operator: '赵晓东 (呼吸内科主治医生)' }
        ],
        clinicalAcceptance: {
          rating: 5,
          comment: '设备使用一切正常',
          acceptedBy: '赵晓东',
          acceptedByTitle: '呼吸内科主治医生',
          acceptedAt: '2026-07-03T11:00:00+08:00'
        }
      });
      const completedDemoSync = syncTasksToEquipmentArchives(
        [acceptedDemoTask],
        [{ ...respiratoryVentilator!, status: '故障维修', maintenanceLogs: [...respiratoryVentilator!.maintenanceLogs] }],
        new Date('2026-07-03T00:00:00+08:00')
      );
      const demoMaintenanceLog = completedDemoSync.equipments[0].maintenanceLogs.find(log => log.workOrderNo === 'TKT-2026062805');
      assertEqual(completedDemoSync.equipments[0].status, '正常运行', '验收完成后呼吸机档案应恢复正常运行');
      assertEqual(demoMaintenanceLog?.status, '已完成', '验收完成后应写入已完成维修档案日志');
      assertEqual(demoMaintenanceLog?.verifyPerson, '赵晓东', '维修档案日志应保留临床验收人');

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

      const quickRepairClosedTask = createTask({
        id: 'TKT-QUICK-DONE',
        status: '已完成',
        deviceId: 'eq-verify-001',
        updatedAt: '2026-07-04T15:30:00+08:00',
        aiSuggestions: ['关联档案维修单号：WO-20260704-0001，请闭环后回写设备档案。'],
        logs: [
          { time: '2026-07-04 14:00', action: '工程师完成现场处置。', operator: '张明华 (工程师)' },
          { time: '2026-07-04 15:30', action: '临床科室完成验收。', operator: '王健 (放射科主管医生)' }
        ],
        clinicalAcceptance: {
          rating: 5,
          comment: 'MRI 已恢复正常扫描',
          acceptedBy: '王健',
          acceptedByTitle: '放射科主管医生',
          acceptedAt: '2026-07-04T15:30:00+08:00'
        }
      });
      const quickRepairSync = syncTasksToEquipmentArchives(
        [quickRepairClosedTask],
        [
          createEquipment({
            status: '故障维修',
            maintenanceLogs: [
              {
                id: 'm-log-quick',
                type: '维修',
                date: '2026-07-04',
                technician: '未分派 (待响应)',
                cost: 0,
                description: '【一键快捷报修】紧急度: 中。描述: MRI 控制台报错，无法开始扫描',
                status: '进行中',
                workOrderNo: 'WO-20260704-0001',
                faultPhenomenon: 'MRI 控制台报错，无法开始扫描',
                verifyPerson: '王健'
              }
            ]
          })
        ],
        new Date('2026-07-04T00:00:00+08:00')
      );
      const quickRepairArchiveLog = quickRepairSync.equipments[0].maintenanceLogs.find(log => log.workOrderNo === 'WO-20260704-0001');
      assertEqual(quickRepairSync.equipments[0].status, '正常运行', '快捷报修工单验收完成后设备档案应恢复正常运行');
      assertEqual(quickRepairArchiveLog?.status, '已完成', '快捷报修关联档案维修单应随主工单闭环');
      assertEqual(quickRepairArchiveLog?.verifyPerson, '王健', '快捷报修关联档案维修单应保留临床验收人');
      assertIncludes(
        quickRepairArchiveLog?.description || '',
        '主工单 TKT-QUICK-DONE 已闭环',
        '快捷报修关联档案维修单应写入主工单闭环说明'
      );

      const orphanedQuickRepairSync = syncTasksToEquipmentArchives(
        [],
        [
          createEquipment({
            status: '故障维修',
            maintenanceLogs: [
              {
                id: 'm-log-orphaned-quick',
                type: '维修',
                date: '2026-07-04',
                technician: '未分派 (待响应)',
                cost: 0,
                description: '【一键快捷报修】紧急度: 中。描述: 呼吸机屏幕黑屏',
                status: '进行中',
                workOrderNo: 'WO-20260704-0002',
                faultPhenomenon: '呼吸机屏幕黑屏',
                verifyPerson: '赵晓东'
              }
            ]
          })
        ],
        new Date('2026-07-04T00:00:00+08:00')
      );
      const orphanedQuickRepairLog = orphanedQuickRepairSync.equipments[0].maintenanceLogs.find(log => log.workOrderNo === 'WO-20260704-0002');
      assertEqual(orphanedQuickRepairSync.changed, true, '主工单被删除或重置后应触发档案快捷报修锁清理');
      assertEqual(orphanedQuickRepairSync.equipments[0].status, '正常运行', '孤儿快捷报修在修锁清理后设备应恢复正常运行');
      assertEqual(orphanedQuickRepairLog?.status, '已完成', '孤儿快捷报修档案维修单应自动解除进行中状态');
      assertIncludes(
        orphanedQuickRepairLog?.description || '',
        '主工单已删除或重置',
        '孤儿快捷报修档案维修单应写入解除原因'
      );

      const manualOpenRepairSync = syncTasksToEquipmentArchives(
        [],
        [
          createEquipment({
            status: '故障维修',
            maintenanceLogs: [
              {
                id: 'm-log-manual-open',
                type: '维修',
                date: '2026-07-04',
                technician: '张明华',
                cost: 0,
                description: '工程师手工创建的现场维修工单，等待备件。',
                status: '进行中',
                workOrderNo: 'WO-20260704-0999',
                faultPhenomenon: '待备件',
                verifyPerson: '赵晓东'
              }
            ]
          })
        ],
        new Date('2026-07-04T00:00:00+08:00')
      );
      assertEqual(manualOpenRepairSync.changed, false, '无主工单引用的手工在修履历不能被快捷报修孤儿清理误闭合');
      assertEqual(manualOpenRepairSync.equipments[0].maintenanceLogs[0].status, '进行中', '手工在修履历应保持进行中');

      const quickRepairActiveTask = createTask({
        id: 'TKT-QUICK-ACTIVE',
        status: '处理中',
        deviceId: 'eq-verify-001',
        aiSuggestions: ['关联档案维修单号：WO-20260704-0003，请闭环后回写设备档案。'],
        logs: [
          { time: '2026-07-04 14:00', action: '资产档案快捷报修同步建单。关联档案维修单号：WO-20260704-0003。', operator: '赵晓东' }
        ]
      });
      const activeQuickRepairSync = syncTasksToEquipmentArchives(
        [quickRepairActiveTask],
        [
          createEquipment({
            status: '故障维修',
            maintenanceLogs: [
              {
                id: 'm-log-active-quick',
                type: '维修',
                date: '2026-07-04',
                technician: '未分派 (待响应)',
                cost: 0,
                description: '【一键快捷报修】紧急度: 中。描述: 呼吸机报警',
                status: '进行中',
                workOrderNo: 'WO-20260704-0003',
                faultPhenomenon: '呼吸机报警',
                verifyPerson: '赵晓东'
              }
            ]
          })
        ],
        new Date('2026-07-04T00:00:00+08:00')
      );
      const activeQuickRepairLog = activeQuickRepairSync.equipments[0].maintenanceLogs.find(log => log.workOrderNo === 'WO-20260704-0003');
      assertEqual(activeQuickRepairSync.equipments[0].status, '故障维修', '快捷报修主工单仍活跃时档案应保持故障维修');
      assertEqual(activeQuickRepairLog?.status, '进行中', '快捷报修主工单仍活跃时档案维修单不能被孤儿清理关闭');

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

      const appSource = readFileSync('src/App.tsx', 'utf8');
      const createStart = appSource.indexOf('const handleCreateTicketFromDraft = () => {');
      const createEnd = appSource.indexOf('// Handle Clinical Closed-loop Sign-off & Rating', createStart);
      assert(createStart !== -1 && createEnd > createStart, '应能定位草稿建单逻辑');
      const createSource = appSource.slice(createStart, createEnd);
      assert(
        createSource.includes("const isNonEquipmentTransferTask = normalizedTaskType === '非设备类转派任务'") &&
          createSource.includes('const effectiveDeviceId = isNonEquipmentTransferTask') &&
          createSource.includes('`NON-EQUIPMENT-${newTicketId}`') &&
          createSource.includes('非设备类转派任务不绑定医学设备电子档案。'),
        '非设备类转派任务即使草稿携带设备编号，也应使用非设备占位编号并写明不绑定设备档案'
      );

      const taskDetailMatches = appSource.match(/const requiresClinicalAcceptance = needsClinicalAcceptance\(selectedTask\);[\s\S]{0,240}const matchedEquip = requiresClinicalAcceptance/g) || [];
      assertEqual(taskDetailMatches.length, 2, '临床与工程师任务详情中的设备档案卡都应先判断是否需要设备验收');
      assert(
        appSource.includes('非设备转派单不绑定设备档案') &&
          appSource.includes('仅保留流转记录，不写入医学设备维修档案'),
        '非设备转派单详情应明确提示不绑定设备档案，避免误导为漏绑或设备维修单'
      );

      const archiveSource = readFileSync('src/components/EquipmentArchives.tsx', 'utf8');
      const relatedStart = archiveSource.indexOf('const getRelatedTasksForEquipment = (equipment: MedicalEquipment) => {');
      const relatedEnd = archiveSource.indexOf('const canManageEquipmentArchive', relatedStart);
      assert(relatedStart !== -1 && relatedEnd > relatedStart, '应能定位设备档案相关工单聚合逻辑');
      const relatedSource = archiveSource.slice(relatedStart, relatedEnd);
      assert(
        archiveSource.includes("import { needsClinicalAcceptance } from '../utils/taskWorkflow';") &&
          relatedSource.includes('.filter(needsClinicalAcceptance)'),
        '设备档案相关工单列表应排除非设备转派单，防止电脑/HIS/后勤问题挂到医疗设备链条'
      );
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

      const existingEquipmentStorage = parseStoredEquipmentList(JSON.stringify([
        createEquipment({ id: 'eq-legacy', deviceName: '既有设备档案', dept: '医学装备科' })
      ]));
      assertEqual(existingEquipmentStorage.shouldPersist, true, '已有设备存储缺少新增默认资产时应提示持久化');
      ['eq-006', 'eq-007', 'eq-008'].forEach(equipmentId => {
        assert(
          existingEquipmentStorage.equipments.some(equipment => equipment.id === equipmentId),
          `已有本地设备库应一次性补入新增默认资产 ${equipmentId}`
        );
      });

      const assignedEquipmentStorage = parseStoredEquipmentList(JSON.stringify([
        createEquipment({
          id: 'eq-assigned-calendar',
          deviceName: '责任人持久化设备',
          assignedMaintenanceEngineer: '王强',
          assignedCalibrationEngineer: '李明'
        })
      ]));
      const assignedEquipment = assignedEquipmentStorage.equipments.find(equipment => equipment.id === 'eq-assigned-calendar');
      assertEqual(assignedEquipment?.assignedMaintenanceEngineer, '张明华', '旧版日历维保责任人应迁移到当前模拟工程师并持久化');
      assertEqual(assignedEquipment?.assignedCalibrationEngineer, '赵安平', '旧版日历计量责任人应迁移到当前模拟工程师并持久化');
      assertEqual(assignedEquipmentStorage.shouldPersist, true, '迁移旧版日历责任工程师字段后应提示重新持久化');

      const equipmentStorageSource = readFileSync('src/utils/equipmentStorage.ts', 'utf8');
      assert(
        equipmentStorageSource.includes("const EQUIPMENT_PRESET_MIGRATION_IDS = ['eq-006', 'eq-007', 'eq-008'];") &&
          equipmentStorageSource.includes('EQUIPMENT_PRESET_MIGRATION_KEY') &&
          equipmentStorageSource.includes('!seededPresetIds.has(equipment.id)') &&
          equipmentStorageSource.includes("typeof localStorage === 'undefined' ? null : localStorage") &&
          equipmentStorageSource.includes("import { normalizeEngineerName } from './engineerAssignments';") &&
          equipmentStorageSource.includes('const getOptionalEngineerName = (value: unknown') &&
          equipmentStorageSource.includes('assignedMaintenanceEngineer: getOptionalEngineerName(value.assignedMaintenanceEngineer') &&
          equipmentStorageSource.includes('assignedCalibrationEngineer: getOptionalEngineerName(value.assignedCalibrationEngineer'),
        '新增默认设备迁移应有一次性标记，且设备存储应保留日历责任工程师改派字段'
      );

      const corruptStorage = withoutConsoleWarn(() => parseStoredEquipmentList('{not json'));
      assert(corruptStorage.equipments.length > 0, '损坏设备存储应回退默认设备列表');
      assertEqual(corruptStorage.shouldPersist, true, '损坏设备存储回退后应提示持久化');

      const emptyTaskStorage = parseStoredTaskList(null);
      assert(emptyTaskStorage.tasks.length > 0, '空任务存储应回退默认任务列表');
      assertEqual(emptyTaskStorage.shouldPersist, true, '空任务存储回退后应提示持久化');

      const dirtyTaskStorage = parseStoredTaskList(JSON.stringify([
        {
          id: 'TKT-DIRTY-STORAGE',
          taskType: '未知分类',
          department: '呼吸',
          location: 5,
          deviceName: '无创呼吸机',
          deviceId: 42,
          faultPhenomenon: '夜间低压报警',
          contactPerson: null,
          contactPhone: undefined,
          urgency: '高',
          affectClinical: '可能',
          status: '进行中',
          aiStatus: 'OK',
          source: '旧系统',
          createdAt: '',
          updatedAt: 'not-a-date',
          aiSuggestions: ['请现场排查', 123],
          logs: [{ time: '2026-07-03 08:00', action: '旧系统导入', operator: 'AI' }, false],
          clinicalAcceptance: {
            rating: 9,
            comment: 123,
            acceptedBy: null,
            acceptedByTitle: '护士长',
            acceptedAt: 'bad-date'
          },
          needBackupDevice: '需要',
          needVendorCoop: '不需要'
        },
        {
          id: 'TKT-DIRTY-STORAGE',
          taskType: '设备报修',
          department: '呼吸内科',
          deviceName: '重复旧记录'
        },
        'not-a-task'
      ]));
      const repairedTask = dirtyTaskStorage.tasks.find(task => task.id === 'TKT-DIRTY-STORAGE');
      assertEqual(dirtyTaskStorage.shouldPersist, true, '脏任务存储修复后应提示写回本地存储');
      assertEqual(
        dirtyTaskStorage.tasks.filter(task => task.id === 'TKT-DIRTY-STORAGE').length,
        1,
        '任务存储清洗应删除重复 ID，避免任务列表和详情选中异常'
      );
      assertEqual(repairedTask?.department, '呼吸内科', '任务存储清洗应规范化科室别名');
      assertEqual(repairedTask?.taskType, '设备报修', '未知任务分类应回退到可闭环的设备报修');
      assertEqual(repairedTask?.status, '处理中', '旧状态别名应映射为当前业务状态');
      assertEqual(repairedTask?.urgency, '紧急', '旧紧急度别名应映射为当前紧急程度');
      assertEqual(repairedTask?.deviceId, 'EQ-TEMP-UNKNOWN', '非字符串设备编号应回退安全临时编号');
      assertEqual(repairedTask?.aiSuggestions.length, 1, 'AI 建议数组应过滤非字符串项');
      assert(repairedTask!.logs.length > 0, '任务存储清洗后必须保留可展示的时间线日志');
      assert(!Number.isNaN(new Date(repairedTask!.createdAt).getTime()), '任务存储清洗应修复无效创建时间，避免列表显示 Invalid Date');
      assert(!Number.isNaN(new Date(repairedTask!.updatedAt).getTime()), '任务存储清洗应修复无效更新时间，避免详情显示 Invalid Date');
      assertEqual(repairedTask?.clinicalAcceptance?.rating, 5, '临床验收评分应夹紧到 1-5 星范围');
      assert(
        !Number.isNaN(new Date(repairedTask!.clinicalAcceptance!.acceptedAt).getTime()),
        '任务存储清洗应修复无效验收时间，避免验收卡片显示 Invalid Date'
      );

      const corruptTaskStorage = withoutConsoleWarn(() => parseStoredTaskList('{not json'));
      assert(corruptTaskStorage.tasks.length > 0, '损坏任务存储应回退默认任务列表');
      assertEqual(corruptTaskStorage.shouldPersist, true, '损坏任务存储回退后应提示持久化');
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
    name: 'terminal task logs are locked after archive or close',
    run: () => {
      const appSource = readFileSync('src/App.tsx', 'utf8');
      const addLogStart = appSource.indexOf('const handleAddLog = (e: React.FormEvent) => {');
      const addLogEnd = appSource.indexOf('// Update status of selected task', addLogStart);
      assert(addLogStart !== -1 && addLogEnd > addLogStart, '应能定位工程师日志追加逻辑');
      const addLogSource = appSource.slice(addLogStart, addLogEnd);

      assert(
        appSource.includes('const isTaskTerminal = (task: StructuredTicket | null) => {') &&
          appSource.includes("['已归档', '已关闭'].includes(task.status)"),
        '应用应有统一终态判断，已归档/已关闭工单必须锁定'
      );
      assert(
        addLogSource.includes('const latestTask = selectedTask ? tasksRef.current.find(task => task.id === selectedTask.id) || null : null;') &&
          addLogSource.includes('if (isTaskTerminal(latestTask))') &&
          addLogSource.includes('该工单已归档或关闭，不能再追加处置日志。'),
        '工程师追加日志应基于最新任务状态校验，不能在已归档或已关闭工单上继续追加处置日志'
      );
      assert(
        appSource.includes('const pendingEngineerLogKeysRef = useRef<Set<string>>(new Set());') &&
          addLogSource.includes('const pendingLogKey = `${latestTask.id}:${nextLogOperator}:${nextLogAction}`;') &&
          addLogSource.includes('if (pendingEngineerLogKeysRef.current.has(pendingLogKey))') &&
          addLogSource.includes('msg-log-pending-blocked') &&
          addLogSource.includes('pendingEngineerLogKeysRef.current.add(pendingLogKey);') &&
          addLogSource.includes('const nextTasks = tasksRef.current.map(t => t.id === latestTask.id ? updatedTask : t);') &&
          addLogSource.includes('tasksRef.current = nextTasks;') &&
          addLogSource.includes('setTasks(nextTasks);') &&
          addLogSource.includes('localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(nextTasks));'),
        '工程师追加日志应基于最新任务列表写入、立即持久化，并阻断同一条处置日志连续点击重复提交'
      );
      assert(
        appSource.includes("disabled={!activeLogAction.trim() || isTaskTerminal(selectedTask)}") &&
          appSource.includes('disabled={isTaskTerminal(selectedTask)}') &&
          appSource.includes("placeholder={isTaskTerminal(selectedTask) ? '已归档或已关闭，不能再追加日志' : '录入进度日志...'}") &&
          appSource.includes("title={isTaskTerminal(selectedTask) ? '已归档或已关闭工单不能再追加日志' : '记录工单处置日志'}") &&
          appSource.includes("{isTaskTerminal(selectedTask) ? '工单已归档锁定：' : '录入维修进度 / 跟踪事件：'}"),
        '工程师日志输入区应在终态工单上显示锁定提示，并禁用输入框与记录按钮'
      );
    }
  },
  {
    name: 'terminal task status changes do not mutate task logs',
    run: () => {
      const appSource = readFileSync('src/App.tsx', 'utf8');
      const statusStart = appSource.indexOf('const handleUpdateStatus = (newStatus: TaskStatus) => {');
      const statusEnd = appSource.indexOf('// Delete task with confirmation', statusStart);
      assert(statusStart !== -1 && statusEnd > statusStart, '应能定位工程师状态流转逻辑');
      const statusSource = appSource.slice(statusStart, statusEnd);
      const terminalGuardIndex = statusSource.indexOf('if (isTaskTerminal(latestTask))');
      const blockedLogIndex = statusSource.indexOf('状态变更被系统拦截');

      assert(
        terminalGuardIndex !== -1 &&
          statusSource.includes('const latestTask = selectedTask ? tasksRef.current.find(task => task.id === selectedTask.id) || null : null;') &&
          statusSource.includes('该工单已归档或关闭，状态已锁定，不能再变更流转状态。') &&
          statusSource.includes("appendWorkflowNotice('⚠️ **归档锁定提醒**"),
        '终态工单尝试改状态时应基于最新任务状态只显示锁定提醒'
      );
      assert(
        blockedLogIndex !== -1 && terminalGuardIndex < blockedLogIndex,
        '终态工单状态变更必须在写入拦截日志前直接返回，避免已归档/已关闭工单继续被更新时间线'
      );
      assert(
        statusSource.includes('const blockReason = getEngineerStatusBlockReason(latestTask, newStatus);') &&
          statusSource.includes('action: `状态变更被系统拦截：尝试从【${latestTask.status}】改为【${newStatus}】。原因：${blockReason}`') &&
          statusSource.includes('const nextTasks = tasksRef.current.map(t => t.id === latestTask.id ? updatedTask : t);') &&
          statusSource.includes('tasksRef.current = nextTasks;') &&
          statusSource.includes('setTasks(nextTasks);') &&
          statusSource.includes('localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(nextTasks));'),
        '工程师状态流转应基于最新任务对象写入并立即持久化，避免覆盖刚追加的日志或验收状态'
      );
    }
  },
  {
    name: 'clinical archive selection never falls back to hidden equipment',
    run: () => {
      const archiveSource = readFileSync('src/components/EquipmentArchives.tsx', 'utf8');

      assert(
        archiveSource.includes('const selectedEquipment = filteredEquipments.find(eq => eq.id === selectedId) || filteredEquipments[0] || null;'),
        '详情面板应与当前过滤结果同源，过滤为空时显示空态'
      );
      assert(
        !archiveSource.includes('|| visibleEquipments[0]') && !archiveSource.includes('|| equipments[0]'),
        '选中设备不能绕过 filteredEquipments 回退到隐藏或未过滤资产'
      );
      assert(
        archiveSource.includes('本科室在修设备') && archiveSource.includes('右侧详情已同步清空'),
        '临床档案筛选文案应准确说明在修设备筛选与详情空态'
      );
      assert(
        archiveSource.includes('当前筛选条件下暂无可选设备') &&
          archiveSource.includes('currentDiagnosticSessionKey'),
        '档案 AI 智脑应在当前过滤无设备时同步切换为空态提示'
      );
      assert(
        archiveSource.includes('if (filteredEquipments.length === 0)') &&
          archiveSource.includes("setSelectedId('');") &&
          archiveSource.includes("if (mobileView === 'detail')") &&
          archiveSource.includes("setMobileView('list');"),
        '档案筛选为空时应清空旧选中设备，并让移动端退出详情页'
      );
      assert(
        archiveSource.includes("['已完成', '已归档', '已关闭'].includes(ticket.status)") &&
          archiveSource.includes('全流程任务关联工单履历') &&
          archiveSource.includes('bg-emerald-100 text-emerald-800'),
        '资产档案相关工单履历应将已关闭留痕视为闭环终态，避免误显示为仍在处理中'
      );
      assert(
        archiveSource.includes("setSearchTerm('');") &&
          archiveSource.includes("setSelectedCategory('全部分类');") &&
          archiveSource.includes("setSelectedStatus('全部状态');") &&
          archiveSource.includes('setFilterMenuOpen(null);') &&
          archiveSource.includes("setMatrixSearchQuery('');") &&
          archiveSource.includes('setMatrixSelectedDept(userDepartment);'),
        '角色切换时应重置档案与台账筛选，避免工程师筛选条件残留到临床账号'
      );
      assert(
        archiveSource.includes('if (propCurrentUser) {\n      setCurrentUser(propCurrentUser);') &&
          archiveSource.includes('if (!propCurrentUser && onUserChange) {\n      onUserChange(currentUser);') &&
          archiveSource.includes('}, [currentUser, onUserChange, propCurrentUser]);') &&
          !archiveSource.includes('if (onUserChange && currentUser.id !== propCurrentUser?.id)'),
        '资产档案嵌入 App 时应以父组件当前用户为权威来源，避免子组件旧用户状态反向覆盖角色切换'
      );
      assert(
        archiveSource.includes('2xl:flex-row') &&
          archiveSource.includes('2xl:w-auto 2xl:flex-shrink-0') &&
          archiveSource.includes('overflow-x-auto max-w-full'),
        '资产档案页头部搜索区不能覆盖视图切换按钮，维保日历/看板入口必须可点击'
      );
      assert(
        archiveSource.includes('setIsFormModalOpen(false);') &&
          archiveSource.includes('setIsAiParserOpen(false);') &&
          archiveSource.includes('setIsLogModalOpen(false);') &&
          archiveSource.includes('setIsAttachmentModalOpen(false);') &&
          archiveSource.includes('setIsDossierModalOpen(false);') &&
          archiveSource.includes('setIsScannerModalOpen(false);') &&
          archiveSource.includes('setIsQuickRepairModalOpen(false);') &&
          archiveSource.includes('setIsPreviewOpen(false);') &&
          archiveSource.includes('setPreviewFile(null);') &&
          archiveSource.includes('setIsExtractingSnapshot(false);') &&
          archiveSource.includes('snapshotExtractRequestVersionRef.current += 1;') &&
          archiveSource.includes('resetQuickRepairDraft();') &&
          archiveSource.includes('archiveManageRequestVersionRef.current += 1;') &&
          archiveSource.includes('setIsAnalyzing(false);') &&
          archiveSource.includes('setAnalyzerError(null);') &&
          archiveSource.includes("setFormMode('create');") &&
          archiveSource.includes('setCurrentEditId(null);'),
        '切换到临床档案视图时应清理工程师档案管理弹窗、AI 解析请求、PDF 导出预览和编辑态'
      );
      const scannerStart = archiveSource.indexOf('const startScannerCamera = async () => {');
      const scannerStop = archiveSource.indexOf('const stopScannerCamera = () => {', scannerStart);
      const scannerEffectEnd = archiveSource.indexOf('// 处理匹配出的设备SN条码定位并触发报修工单自动填充', scannerStop);
      assert(scannerStart !== -1 && scannerStop > scannerStart && scannerEffectEnd > scannerStop, '应能定位扫码相机生命周期逻辑');
      const scannerSource = archiveSource.slice(scannerStart, scannerEffectEnd);
      assert(
        archiveSource.includes('const scannerCameraRequestVersionRef = useRef(0);') &&
          scannerSource.includes('const requestVersion = scannerCameraRequestVersionRef.current + 1;') &&
          scannerSource.includes('scannerCameraRequestVersionRef.current = requestVersion;') &&
          scannerSource.includes('if (requestVersion !== scannerCameraRequestVersionRef.current || !isScannerModalOpen)') &&
          scannerSource.includes('stream.getTracks().forEach(track => track.stop());') &&
          scannerSource.includes('scannerCameraRequestVersionRef.current += 1;') &&
          scannerSource.includes('stopScannerCamera();'),
        '扫码相机 getUserMedia 返回时应校验弹窗仍打开，关闭或切换角色后必须作废旧相机请求并停止媒体流'
      );
      assert(
        archiveSource.includes('const archiveManageRequestVersionRef = useRef(0);') &&
          archiveSource.includes('const canManageEquipmentArchiveRef = useRef(false);') &&
          archiveSource.includes('canManageEquipmentArchiveRef.current = canManageEquipmentArchive;') &&
          archiveSource.includes('const beginArchiveAiAnalyze = (actionName: string) => {') &&
          archiveSource.includes('archiveManageRequestVersionRef.current += 1;') &&
          archiveSource.includes('const isArchiveAiAnalyzeCurrent = (requestVersion: number) => (') &&
          archiveSource.includes('requestVersion === archiveManageRequestVersionRef.current && canManageEquipmentArchiveRef.current'),
        'AI 扫码入库等管理型异步解析应绑定工程师权限和请求版本'
      );
      const presetOcrStart = archiveSource.indexOf('const runPresetOcr = (presetNum: number) => {');
      const presetOcrEnd = archiveSource.indexOf('// Run Custom Text OCR or Image upload OCR via Gemini API', presetOcrStart);
      assert(presetOcrStart !== -1 && presetOcrEnd > presetOcrStart, '应能定位 AI 预设扫码入库逻辑');
      const presetOcrSource = archiveSource.slice(presetOcrStart, presetOcrEnd);
      const customOcrStart = archiveSource.indexOf('const handleCustomOcrAnalyze = () => {');
      const customOcrEnd = archiveSource.indexOf('// Chat with AI Diagnostician Expert', customOcrStart);
      assert(customOcrStart !== -1 && customOcrEnd > customOcrStart, '应能定位 AI 文本扫码入库逻辑');
      const customOcrSource = archiveSource.slice(customOcrStart, customOcrEnd);
      const fileOcrStart = archiveSource.indexOf('const processOcrFile = (file: File) => {');
      const fileOcrEnd = archiveSource.indexOf('// Simulates scanning label with file input', fileOcrStart);
      assert(fileOcrStart !== -1 && fileOcrEnd > fileOcrStart, '应能定位 AI 文件扫码入库逻辑');
      const fileOcrSource = archiveSource.slice(fileOcrStart, fileOcrEnd);
      assert(
        presetOcrSource.includes("const requestVersion = beginArchiveAiAnalyze('AI 扫码入库');") &&
          presetOcrSource.includes('if (requestVersion === null) return;') &&
          presetOcrSource.includes('if (!isArchiveAiAnalyzeCurrent(requestVersion)) return;') &&
          customOcrSource.includes("const requestVersion = beginArchiveAiAnalyze('AI 扫码入库');") &&
          customOcrSource.includes('if (!isArchiveAiAnalyzeCurrent(requestVersion)) return;') &&
          fileOcrSource.includes("const requestVersion = beginArchiveAiAnalyze('AI 扫码入库');") &&
          fileOcrSource.includes('reader.onload = function(event)') &&
          fileOcrSource.includes('if (!isArchiveAiAnalyzeCurrent(requestVersion)) return;'),
        'AI 扫码入库预设、文本和文件解析返回时都应丢弃切换角色后的旧结果'
      );
      assert(
        archiveSource.includes('previewFileBelongsToSelectedEquipment') &&
          archiveSource.includes('selectedEquipment.attachments.some(file => file.id === previewFile.id)') &&
          archiveSource.includes('setPreviewFile(null);') &&
          archiveSource.includes('setActivePreviewPage(1);') &&
          archiveSource.includes('setIsExtractingSnapshot(false);') &&
          archiveSource.includes('snapshotExtractRequestVersionRef.current += 1;'),
        '附件预览应在当前选中设备变化后关闭不属于该设备的旧预览并作废旧快照提取'
      );
      assert(
        archiveSource.includes('maintenanceLogBelongsToSelectedEquipment') &&
          archiveSource.includes('calibrationLogBelongsToSelectedEquipment') &&
          archiveSource.includes('selectedEquipment.maintenanceLogs.some(log => log.id === viewMaintenanceLog.id)') &&
          archiveSource.includes('selectedEquipment.calibrationLogs.some(log => log.id === viewCalibrationLog.id)'),
        '维修工单和计量证书阅览应校验仍属于当前选中设备'
      );
      assert(
        archiveSource.includes('const quickRepairEquipment = equipments.find(eq => eq.id === quickRepairEquipId);') &&
          archiveSource.includes('canStartQuickRepairForEquipment(quickRepairEquipment)') &&
          archiveSource.includes("resetQuickRepairDraft(fallbackEquipment?.id || '');"),
        '快捷报修弹窗中的设备选择应随角色和科室切换重新校验可报修范围'
      );
      assert(
        archiveSource.includes('const getDefaultQuickRepairUrgency = (equipment: MedicalEquipment | null):') &&
          archiveSource.includes("return equipment.category === '急救生命支持' || equipment.riskLevel === '高' ? 'high' : 'medium';") &&
          archiveSource.includes("const resetQuickRepairDraft = (nextEquipmentId = '') => {") &&
          archiveSource.includes('setQuickRepairEquipId(nextEquipmentId);') &&
          archiveSource.includes("setQuickRepairDesc('');") &&
          archiveSource.includes('setQuickRepairUrgency(getDefaultQuickRepairUrgency(nextEquipment));'),
        '快捷报修草稿应有统一重置入口，切换设备或角色时不能沿用旧设备故障描述'
      );
      assert(
        archiveSource.includes("resetQuickRepairDraft(fallbackEquipment?.id || '');") &&
          archiveSource.includes("onChange={(e) => resetQuickRepairDraft(e.target.value)}") &&
          archiveSource.includes('setIsQuickRepairModalOpen(false);') &&
          archiveSource.includes('resetQuickRepairDraft();'),
        '快捷报修弹窗的设备切换、关闭和取消都应清空旧描述与旧紧急度'
      );
      assert(
        archiveSource.includes('const hasActiveRepairWorkOrder = (equipment: MedicalEquipment) => {') &&
          archiveSource.includes("equipment.status === '故障维修'") &&
          archiveSource.includes("log.type === '维修' && log.status === '进行中'") &&
          archiveSource.includes('const canStartQuickRepairForEquipment = (equipment: MedicalEquipment | null) => {') &&
          archiveSource.includes('!hasActiveRepairWorkOrder(equipment)'),
        '档案快捷报修应识别已有进行中维修，避免重复生成维修记录'
      );
      const quickRepairToastStart = archiveSource.indexOf("const showQuickRepairToast = (toast: { type: 'success' | 'warning'; message: string }) => {");
      const quickRepairToastEnd = archiveSource.indexOf('useEffect(() => {\n    if (propCurrentUser)', quickRepairToastStart);
      assert(quickRepairToastStart !== -1 && quickRepairToastEnd > quickRepairToastStart, '应能定位档案快捷报修 toast 逻辑');
      const quickRepairToastSource = archiveSource.slice(quickRepairToastStart, quickRepairToastEnd);
      const quickRepairToastCallCount = (archiveSource.match(/showQuickRepairToast\(/g) || []).length;
      assert(
        archiveSource.includes('const quickRepairToastTimerRef = useRef<number | null>(null);') &&
          quickRepairToastSource.includes('if (quickRepairToastTimerRef.current !== null)') &&
          quickRepairToastSource.includes('window.clearTimeout(quickRepairToastTimerRef.current);') &&
          quickRepairToastSource.includes('quickRepairToastTimerRef.current = window.setTimeout(() => {') &&
          quickRepairToastSource.includes('setQuickRepairToast(null);') &&
          quickRepairToastSource.includes('quickRepairToastTimerRef.current = null;') &&
          quickRepairToastSource.includes('return () => {') &&
          quickRepairToastSource.includes('window.clearTimeout(quickRepairToastTimerRef.current);') &&
          quickRepairToastCallCount >= 8 &&
          !archiveSource.includes('setTimeout(() => setQuickRepairToast(null), 5000);'),
        '资产档案快捷报修和权限提醒 toast 应统一清理旧定时器，避免连续报修或连续权限提醒时旧定时器提前清掉新提示'
      );
      assert(
        archiveSource.includes("const formatDepartmentScopeLabel = (dept: string) => {") &&
          archiveSource.includes("return currentUser.role === 'medical_staff' ? '本科室' : '全部科室';") &&
          archiveSource.includes('{formatDepartmentScopeLabel(selectedDept)}') &&
          archiveSource.includes('{formatDepartmentScopeLabel(d)}') &&
          archiveSource.includes('<option value="全部科室">{assetScopeLabel} ({visibleDepartments.length - 1}个)</option>'),
        '临床档案筛选控件应显示本科室范围，避免用“全部科室”误导为全院可见'
      );
      assert(
        archiveSource.includes('>{assetScopeLabel}科室机构 (点击整行筛选)</th>') &&
          archiveSource.includes('title={`点击查看${assetScopeLabel}“${cat}”装备明细列表`}') &&
          archiveSource.includes('title={`点击查看${assetScopeLabel}所有设备台账明细列表`}') &&
          archiveSource.includes('>{assetScopeLabel}品类小计</td>') &&
          archiveSource.includes('title={`点击穿透查看${assetScopeLabel}“${cat}”装备明细`}'),
        '资产矩阵看板应按当前角色范围展示全院/本科室文案，不能在临床端硬编码全院'
      );
      const deleteEquipmentStart = archiveSource.indexOf('const handleDelete = (id: string) => {');
      const deleteEquipmentEnd = archiveSource.indexOf('// Open modal for Create', deleteEquipmentStart);
      assert(deleteEquipmentStart !== -1 && deleteEquipmentEnd > deleteEquipmentStart, '应能定位设备档案删除逻辑');
      const deleteEquipmentSource = archiveSource.slice(deleteEquipmentStart, deleteEquipmentEnd);
      assert(
        deleteEquipmentSource.includes("showArchiveManageBlockedToast('档案作废删除');") &&
          deleteEquipmentSource.includes('setEquipments(prevEquipments => {') &&
          deleteEquipmentSource.includes('const nextEquipments = prevEquipments.filter(eq => eq.id !== id);') &&
          deleteEquipmentSource.includes('localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(nextEquipments));'),
        '删除设备档案应基于最新设备列表写入，避免覆盖连续新增的附件或履历'
      );
      const saveFormStart = archiveSource.indexOf('const saveEquipmentForm = (e: React.FormEvent) => {');
      const saveFormEnd = archiveSource.indexOf('// 临床医护人员一键快捷报修提交', saveFormStart);
      assert(saveFormStart !== -1 && saveFormEnd > saveFormStart, '应能定位新增/编辑设备档案表单保存逻辑');
      const saveFormSource = archiveSource.slice(saveFormStart, saveFormEnd);
      assert(
        saveFormSource.includes("if (!canManageEquipmentArchive)") &&
          saveFormSource.includes('const nextEquipments = [...newEqs, ...prevEquipments];') &&
          saveFormSource.includes('if (!currentEditId) return;') &&
          saveFormSource.includes('const nextEquipments = prevEquipments.map(eq => {') &&
          saveFormSource.includes('if (eq.id !== currentEditId) return eq;') &&
          saveFormSource.includes('localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(nextEquipments));'),
        '新增和编辑设备档案应基于最新设备列表写入，避免表单保存覆盖刚追加的档案数据'
      );
      const addAttachmentStart = archiveSource.indexOf('const handleAddAttachment = (e: React.FormEvent) => {');
      const addAttachmentEnd = archiveSource.indexOf('// AI OCR Parser simulation with presets', addAttachmentStart);
      assert(addAttachmentStart !== -1 && addAttachmentEnd > addAttachmentStart, '应能定位资料附件上传逻辑');
      const addAttachmentSource = archiveSource.slice(addAttachmentStart, addAttachmentEnd);
      assert(
        addAttachmentSource.includes("if (!ensureCanManageEquipmentArchive('上传资料附件')) return;") &&
          addAttachmentSource.includes('setEquipments(prevEquipments => {') &&
          addAttachmentSource.includes('const nextEquipments = prevEquipments.map(eq => {') &&
          addAttachmentSource.includes('if (eq.id !== selectedId) return eq;') &&
          addAttachmentSource.includes('attachments: [...eq.attachments, attach]') &&
          addAttachmentSource.includes('localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(nextEquipments));'),
        '资料附件上传应基于最新设备列表追加附件并同步本地存储，避免连续上传覆盖旧附件'
      );
      const addMaintenanceStart = archiveSource.indexOf('const handleAddMaintenanceLog = (e: React.FormEvent) => {');
      const addMaintenanceEnd = archiveSource.indexOf('// Add Calibration Log', addMaintenanceStart);
      assert(addMaintenanceStart !== -1 && addMaintenanceEnd > addMaintenanceStart, '应能定位新增维保履历逻辑');
      const addMaintenanceSource = archiveSource.slice(addMaintenanceStart, addMaintenanceEnd);
      assert(
        addMaintenanceSource.includes("if (!ensureCanManageEquipmentArchive('新增维保工单')) return;") &&
          addMaintenanceSource.includes('setEquipments(prevEquipments => {') &&
          addMaintenanceSource.includes('const nextEquipments = prevEquipments.map(eq => {') &&
          addMaintenanceSource.includes('if (eq.id !== selectedId) return eq;') &&
          addMaintenanceSource.includes('const updatedLogs = [log, ...eq.maintenanceLogs];') &&
          addMaintenanceSource.includes('maintenanceLogs: updatedLogs') &&
          addMaintenanceSource.includes('localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(nextEquipments));'),
        '新增维保/维修履历应基于最新设备列表写入，避免连续登记覆盖其他档案更新'
      );
      const addCalibrationStart = archiveSource.indexOf('const handleAddCalibrationLog = (e: React.FormEvent) => {');
      const addCalibrationEnd = archiveSource.indexOf('// Delete Maintenance Log', addCalibrationStart);
      assert(addCalibrationStart !== -1 && addCalibrationEnd > addCalibrationStart, '应能定位新增计量证书逻辑');
      const addCalibrationSource = archiveSource.slice(addCalibrationStart, addCalibrationEnd);
      assert(
        addCalibrationSource.includes("if (!ensureCanManageEquipmentArchive('登记计量证书')) return;") &&
          addCalibrationSource.includes('setEquipments(prevEquipments => {') &&
          addCalibrationSource.includes('const nextEquipments = prevEquipments.map(eq => {') &&
          addCalibrationSource.includes('if (eq.id !== selectedId) return eq;') &&
          addCalibrationSource.includes('calibrationLogs: [log, ...eq.calibrationLogs]') &&
          addCalibrationSource.includes('localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(nextEquipments));'),
        '新增计量证书应基于最新设备列表写入，避免连续登记覆盖其他档案更新'
      );
      const deleteMaintenanceStart = archiveSource.indexOf('const handleDeleteMaintenanceLog = (logId: string) => {');
      const deleteMaintenanceEnd = archiveSource.indexOf('// Delete Calibration Log', deleteMaintenanceStart);
      assert(deleteMaintenanceStart !== -1 && deleteMaintenanceEnd > deleteMaintenanceStart, '应能定位删除维保履历逻辑');
      const deleteMaintenanceSource = archiveSource.slice(deleteMaintenanceStart, deleteMaintenanceEnd);
      assert(
        deleteMaintenanceSource.includes("if (!ensureCanManageEquipmentArchive('删除维保履历记录')) return;") &&
          deleteMaintenanceSource.includes('setEquipments(prevEquipments => {') &&
          deleteMaintenanceSource.includes('const nextEquipments = prevEquipments.map(eq => {') &&
          deleteMaintenanceSource.includes('if (eq.id !== selectedId) return eq;') &&
          deleteMaintenanceSource.includes('maintenanceLogs: eq.maintenanceLogs.filter(log => log.id !== logId)') &&
          deleteMaintenanceSource.includes('localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(nextEquipments));'),
        '删除维保/维修履历应基于最新设备列表写入，避免覆盖并发档案更新'
      );
      const deleteCalibrationStart = archiveSource.indexOf('const handleDeleteCalibrationLog = (calId: string) => {');
      const deleteCalibrationEnd = archiveSource.indexOf('const handleDeleteExtractedSnapshot = (snapshotId: string) => {', deleteCalibrationStart);
      assert(deleteCalibrationStart !== -1 && deleteCalibrationEnd > deleteCalibrationStart, '应能定位删除计量证书逻辑');
      const deleteCalibrationSource = archiveSource.slice(deleteCalibrationStart, deleteCalibrationEnd);
      assert(
        deleteCalibrationSource.includes("if (!ensureCanManageEquipmentArchive('注销计量证书')) return;") &&
          deleteCalibrationSource.includes('setEquipments(prevEquipments => {') &&
          deleteCalibrationSource.includes('const nextEquipments = prevEquipments.map(eq => {') &&
          deleteCalibrationSource.includes('if (eq.id !== selectedId) return eq;') &&
          deleteCalibrationSource.includes('calibrationLogs: eq.calibrationLogs.filter(cal => cal.id !== calId)') &&
          deleteCalibrationSource.includes('localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(nextEquipments));'),
        '删除计量证书应基于最新设备列表写入，避免覆盖并发档案更新'
      );
      const deleteSnapshotStart = archiveSource.indexOf('const handleDeleteExtractedSnapshot = (snapshotId: string) => {');
      const deleteSnapshotEnd = archiveSource.indexOf('// Add Attachment Item', deleteSnapshotStart);
      assert(deleteSnapshotStart !== -1 && deleteSnapshotEnd > deleteSnapshotStart, '应能定位解除技术手册快照关联逻辑');
      const deleteSnapshotSource = archiveSource.slice(deleteSnapshotStart, deleteSnapshotEnd);
      assert(
        deleteSnapshotSource.includes("if (!ensureCanManageEquipmentArchive('解除技术手册快照关联')) return;") &&
          deleteSnapshotSource.includes('if (!selectedEquipment) return;') &&
          deleteSnapshotSource.includes('const targetEquipmentId = selectedEquipment.id;') &&
          deleteSnapshotSource.includes('setEquipments(prevEquipments => {') &&
          deleteSnapshotSource.includes('const nextEquipments = prevEquipments.map(eq => {') &&
          deleteSnapshotSource.includes('if (eq.id !== targetEquipmentId) return eq;') &&
          deleteSnapshotSource.includes('extractedSnapshots: (eq.extractedSnapshots || []).filter(s => s.id !== snapshotId)') &&
          deleteSnapshotSource.includes('localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(nextEquipments));'),
        '解除技术手册快照关联应基于最新设备列表写入并校验当前选中设备'
      );
      const printStart = archiveSource.indexOf('const handlePrintQR = () => {');
      const printEnd = archiveSource.indexOf('const createQuickRepairRecord = (', printStart);
      assert(printStart !== -1 && printEnd > printStart, '应能定位物联二维码打印逻辑');
      const printSource = archiveSource.slice(printStart, printEnd);
      assert(
        printSource.includes("if (!ensureCanManageEquipmentArchive('打印物联二维码标签')) return;"),
        '二维码标签打印属于档案管理外设指令，应统一走工程师权限拦截'
      );
      const downloadStart = archiveSource.indexOf('const triggerDownloadFile = (file: Attachment) => {');
      const downloadEnd = archiveSource.indexOf('const handleExtractSnapshot = (page: PreviewPage) => {', downloadStart);
      assert(downloadStart !== -1 && downloadEnd > downloadStart, '应能定位技术资料原档下载逻辑');
      const downloadSource = archiveSource.slice(downloadStart, downloadEnd);
      assert(
        downloadSource.includes("if (!ensureCanManageEquipmentArchive('下载技术资料原档')) return;"),
        '技术资料原档下载属于档案管理导出动作，应统一走工程师权限拦截'
      );
      const snapshotExtractStart = archiveSource.indexOf('const handleExtractSnapshot = (page: PreviewPage) => {');
      const snapshotExtractEnd = archiveSource.indexOf('return (', snapshotExtractStart);
      assert(snapshotExtractStart !== -1 && snapshotExtractEnd > snapshotExtractStart, '应能定位技术手册快照提取逻辑');
      const snapshotExtractSource = archiveSource.slice(snapshotExtractStart, snapshotExtractEnd);
      assert(
        snapshotExtractSource.includes("if (!ensureCanManageEquipmentArchive('提取技术手册快照')) return;") &&
          archiveSource.includes('const snapshotExtractRequestVersionRef = useRef(0);') &&
          snapshotExtractSource.includes('const requestVersion = snapshotExtractRequestVersionRef.current + 1;') &&
          snapshotExtractSource.includes('snapshotExtractRequestVersionRef.current = requestVersion;') &&
          snapshotExtractSource.includes('const targetEquipmentId = selectedEquipment.id;') &&
          snapshotExtractSource.includes('const targetFileId = previewFile.id;') &&
          snapshotExtractSource.includes('const targetFileName = previewFile.name;') &&
          snapshotExtractSource.includes('let snapshotWasApplied = false;') &&
          snapshotExtractSource.includes('setEquipments(prevEquipments => {') &&
          snapshotExtractSource.includes('const latestTargetEquipment = prevEquipments.find(eq => eq.id === targetEquipmentId);') &&
          snapshotExtractSource.includes('const targetFileStillExists = latestTargetEquipment?.attachments.some(file => file.id === targetFileId);') &&
          snapshotExtractSource.includes('if (requestVersion !== snapshotExtractRequestVersionRef.current) return;') &&
          snapshotExtractSource.includes('if (!canManageEquipmentArchiveRef.current)') &&
          snapshotExtractSource.includes('if (!latestTargetEquipment || !targetFileStillExists)') &&
          snapshotExtractSource.includes('snapshotWasApplied = true;') &&
          snapshotExtractSource.includes('const nextEquipments = prevEquipments.map(eq => {') &&
          snapshotExtractSource.includes('if (eq.id !== targetEquipmentId) return eq;') &&
          snapshotExtractSource.includes('sourceFileName: targetFileName') &&
          snapshotExtractSource.includes('localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(nextEquipments));') &&
          snapshotExtractSource.includes('if (snapshotWasApplied)'),
        '技术手册快照提取会延迟修改设备档案，应统一走工程师权限拦截、丢弃旧请求，并基于最新设备列表写入'
      );
      const mobileActionsStart = archiveSource.indexOf('Quick action buttons on mobile next to title');
      const mobileActionsEnd = archiveSource.indexOf('{/* Dynamic Filters & Search Panel */}', mobileActionsStart);
      assert(mobileActionsStart !== -1 && mobileActionsEnd > mobileActionsStart, '应能定位移动端资产档案页头部导出入口');
      const mobileActionsSource = archiveSource.slice(mobileActionsStart, mobileActionsEnd);
      assert(
        mobileActionsSource.includes('{canManageEquipmentArchive ? (') &&
          mobileActionsSource.includes('setIsDossierModalOpen(true)') &&
          mobileActionsSource.includes('title="导出PDF档案"') &&
          mobileActionsSource.includes('只读'),
        '移动端资产档案 PDF 导出按钮应只在工程师权限下渲染，临床端保留只读说明'
      );
      const desktopPdfIndex = archiveSource.indexOf('title="导出当前选中设备技术档案为 PDF / 打印"');
      const desktopGuardIndex = archiveSource.lastIndexOf('{canManageEquipmentArchive ? (', desktopPdfIndex);
      const desktopReadonlyIndex = archiveSource.indexOf('临床只读档案', desktopPdfIndex);
      assert(
        desktopPdfIndex !== -1 &&
          desktopGuardIndex !== -1 &&
          desktopGuardIndex < desktopPdfIndex &&
          desktopReadonlyIndex !== -1 &&
          desktopReadonlyIndex > desktopPdfIndex,
        '桌面端资产档案 PDF 导出按钮应只在工程师权限下渲染，临床端保留只读说明'
      );
      assert(
        archiveSource.includes('{canManageEquipmentArchive && isDossierModalOpen && selectedEquipment && ('),
        'PDF 技术档案导出弹窗本体也应绑定工程师权限，避免工程师打开后切临床仍可打印导出'
      );
      assert(
        archiveSource.includes("title={canManageEquipmentArchive ? '点击打印二维码物联标签' : '临床只读：二维码打印由医学装备科工程师执行'}") &&
          archiveSource.includes("title={canManageEquipmentArchive ? '点击向打印机发送标签打印指令' : '临床只读：二维码打印由医学装备科工程师执行'}") &&
          archiveSource.includes("{canManageEquipmentArchive ? '打印标签' : '只读查看'}"),
        '临床档案详情中的二维码应可查看但明确标识为只读，不能暗示可发起打印'
      );
      const footerStart = archiveSource.indexOf('<div id="equipment_details_actions"');
      const footerEnd = archiveSource.indexOf('<span>扫码报修</span>', footerStart);
      assert(footerStart !== -1 && footerEnd > footerStart, '应能定位设备详情底部操作栏');
      const footerSource = archiveSource.slice(footerStart, footerEnd);
      assert(
        footerSource.includes('{canManageEquipmentArchive && (') &&
          footerSource.includes('title="打印物联二维码"') &&
          footerSource.indexOf('{canManageEquipmentArchive && (') < footerSource.indexOf('title="打印物联二维码"'),
        '设备详情底部的打印二维码按钮应只在工程师档案管理权限下渲染'
      );
      const maintenancePrintStart = archiveSource.indexOf('医院设备资产管理系统 - 电子派工单');
      const maintenancePrintEnd = archiveSource.indexOf('onClick={() => setViewMaintenanceLog(null)}', maintenancePrintStart);
      assert(maintenancePrintStart !== -1 && maintenancePrintEnd > maintenancePrintStart, '应能定位维保派工单阅览弹窗头部');
      const maintenancePrintSource = archiveSource.slice(maintenancePrintStart, maintenancePrintEnd);
      assert(
        maintenancePrintSource.includes('{canManageEquipmentArchive ? (') &&
          maintenancePrintSource.includes('onClick={() => window.print()}') &&
          maintenancePrintSource.includes('<span>打印单据</span>') &&
          maintenancePrintSource.includes('临床只读阅览'),
        '维保派工单可供临床只读查看，但打印单据按钮只能给工程师'
      );
      const calibrationPrintStart = archiveSource.indexOf('法定计量强制检定证书与科室绿标印证系统');
      const calibrationPrintEnd = archiveSource.indexOf('onClick={() => setViewCalibrationLog(null)}', calibrationPrintStart);
      assert(calibrationPrintStart !== -1 && calibrationPrintEnd > calibrationPrintStart, '应能定位计量证书阅览弹窗头部');
      const calibrationPrintSource = archiveSource.slice(calibrationPrintStart, calibrationPrintEnd);
      assert(
        calibrationPrintSource.includes('{canManageEquipmentArchive ? (') &&
          calibrationPrintSource.includes('onClick={() => window.print()}') &&
          calibrationPrintSource.includes('<span>打印合格证 & 证书</span>') &&
          calibrationPrintSource.includes('临床只读阅览'),
        '计量证书可供临床只读查看，但打印证书按钮只能给工程师'
      );
      const matrixExportStart = archiveSource.indexOf('医学装备资产台账明细表');
      const matrixExportEnd = archiveSource.indexOf('{/* Reset All Filters */}', matrixExportStart);
      assert(matrixExportStart !== -1 && matrixExportEnd > matrixExportStart, '应能定位资产台账明细表导出区');
      const matrixExportSource = archiveSource.slice(matrixExportStart, matrixExportEnd);
      assert(
        matrixExportSource.includes('{canManageEquipmentArchive ? (') &&
          matrixExportSource.includes('link.setAttribute("download", `医学装备资产台账明细_${assetScopeLabel}_${getLocalDateString()}.csv`);') &&
          matrixExportSource.includes('导出当前表 (CSV)') &&
          matrixExportSource.includes('临床只读台账'),
        '资产台账 CSV 导出应只允许工程师执行，临床端保留本科室台账只读查看'
      );
      const attachmentPreviewStart = archiveSource.indexOf('SMART ATTACHMENT PREVIEW & AI SNAPSHOT EXTRACTOR');
      const attachmentPreviewEnd = archiveSource.indexOf('{/* Document Split Grid Container */}', attachmentPreviewStart);
      assert(attachmentPreviewStart !== -1 && attachmentPreviewEnd > attachmentPreviewStart, '应能定位附件预览弹窗头部');
      const attachmentPreviewSource = archiveSource.slice(attachmentPreviewStart, attachmentPreviewEnd);
      assert(
        attachmentPreviewSource.includes('{canManageEquipmentArchive ? (') &&
          attachmentPreviewSource.includes('onClick={() => triggerDownloadFile(previewFile)}') &&
          attachmentPreviewSource.includes('下载原档') &&
          attachmentPreviewSource.includes('临床只读预览'),
        '附件预览可供临床查看，但原档下载按钮只能给工程师'
      );
      const previewToolsStart = archiveSource.indexOf('Extract snapshot & page navigation tools');
      const previewToolsEnd = archiveSource.indexOf('Small visual page bento thumbnail selector', previewToolsStart);
      assert(previewToolsStart !== -1 && previewToolsEnd > previewToolsStart, '应能定位附件预览快照提取工具栏');
      const previewToolsSource = archiveSource.slice(previewToolsStart, previewToolsEnd);
      assert(
        previewToolsSource.includes('{canManageEquipmentArchive ? (') &&
          previewToolsSource.includes('onClick={() => handleExtractSnapshot(activePageData)}') &&
          previewToolsSource.includes('提取当前页为设备关联快照') &&
          previewToolsSource.includes('临床只读预览'),
        '附件预览中的快照提取按钮应只允许工程师执行，临床端保留翻页预览能力'
      );
    }
  },
  {
    name: 'quick archive repair callback has app-level clinical department guard',
    run: () => {
      const appSource = readFileSync('src/App.tsx', 'utf8');
      const assetReportStart = appSource.indexOf('const handleReportRepairFromEquip = (equip: any) => {');
      const assetReportEnd = appSource.indexOf('const handleQuickRepairCreated = ({', assetReportStart);
      assert(assetReportStart !== -1 && assetReportEnd > assetReportStart, '应能定位档案智能报修入口');
      const assetReportSource = appSource.slice(assetReportStart, assetReportEnd);
      const callbackStart = appSource.indexOf('const handleQuickRepairCreated = ({');
      const callbackEnd = appSource.indexOf('// Role and Auth Simulation States');
      assert(callbackStart !== -1 && callbackEnd > callbackStart, '应能定位快捷报修回调实现');
      const callbackSource = appSource.slice(callbackStart, callbackEnd);

      assert(
        assetReportSource.includes('findActiveEquipmentRepairTask(tasksRef.current, equip)') &&
          assetReportSource.includes('setSelectedTask(duplicateRepairTask);') &&
          assetReportSource.includes('setMobileTab(\'detail\');') &&
          assetReportSource.includes('msg-asset-report-duplicate-blocked') &&
          assetReportSource.includes('避免重复生成报修草稿'),
        '档案智能报修草稿入口应先阻断同设备未闭环维修，避免临床生成注定重复的报修草稿'
      );
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
      assert(
        appSource.includes('const hasActiveEquipmentRepairTask = (tasks: StructuredTicket[], equipment: MedicalEquipment) => {') &&
          appSource.includes('const findActiveEquipmentRepairTask = (tasks: StructuredTicket[], equipment: MedicalEquipment) => {') &&
          appSource.includes("!['已完成', '已归档', '已关闭'].includes(task.status)") &&
          appSource.includes('const tasksRef = useRef(tasks);') &&
          appSource.includes('const pendingQuickRepairEquipmentIdsRef = useRef<Set<string>>(new Set());') &&
          appSource.includes('tasksRef.current = tasks;') &&
          callbackSource.includes('const latestTasks = tasksRef.current;') &&
          callbackSource.includes('if (hasActiveEquipmentRepairTask(latestTasks, equipment))') &&
          callbackSource.includes('if (pendingQuickRepairEquipmentIdsRef.current.has(equipment.id))') &&
          callbackSource.includes('pendingQuickRepairEquipmentIdsRef.current.add(equipment.id);') &&
          callbackSource.includes('const newTicketId = createNextTaskId(latestTasks);') &&
          callbackSource.includes('tasksRef.current = nextTasks;') &&
          callbackSource.includes('localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(nextTasks));') &&
          callbackSource.includes('localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(mergedTasks));') &&
          callbackSource.includes('pendingQuickRepairEquipmentIdsRef.current.delete(equipment.id);') &&
          callbackSource.includes('msg-quick-repair-duplicate-blocked') &&
          callbackSource.includes('msg-quick-repair-pending-blocked') &&
          callbackSource.includes('避免重复派单') &&
          callbackSource.includes('return false;'),
        '快捷报修同步主工单时应使用最新任务源、立即持久化并阻断同设备连续点击，避免重复派单或刷新丢失'
      );
    }
  },
  {
    name: 'archive quick repair keeps engineer proxy contact distinct from clinical reporter',
    run: () => {
      const appSource = readFileSync('src/App.tsx', 'utf8');
      const callbackStart = appSource.indexOf('const handleQuickRepairCreated = ({');
      const callbackEnd = appSource.indexOf('// Role and Auth Simulation States');
      assert(callbackStart !== -1 && callbackEnd > callbackStart, '应能定位快捷报修回调实现');
      const callbackSource = appSource.slice(callbackStart, callbackEnd);

      assert(
        callbackSource.includes('const isClinicalReporter =') &&
          callbackSource.includes('const reportContactPerson = isClinicalReporter') &&
          callbackSource.includes("`${normalizedDept || equipment.dept || '设备使用科室'}值班人员`") &&
          callbackSource.includes('const reportContactPhone = isClinicalReporter') &&
          callbackSource.includes("'待科室确认'"),
        '工程师从资产档案代建快捷报修时，主工单联系人应保留为设备所在科室待确认，而不是工程师本人'
      );
      assert(
        callbackSource.includes("const reportSource = isClinicalReporter ? '科室扫码报修' : '工程师手工录入'") &&
          callbackSource.includes('operatorLabel') &&
          callbackSource.includes('工程师代建，现场联系人需向'),
        '工程师代建快捷报修应在来源、日志和备注中明确区别于临床扫码自报'
      );
      assert(
        callbackSource.includes('contactPerson: reportContactPerson') &&
          callbackSource.includes('contactPhone: reportContactPhone') &&
          callbackSource.includes('source: reportSource'),
        '快捷报修生成主工单应使用按角色归一后的联系人、电话和来源字段'
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
        createSource.includes('const latestEquipments = parseStoredEquipmentList(localStorage.getItem(EQUIPMENT_STORAGE_KEY)).equipments;') &&
          createSource.includes('const workOrderNo = createQuickRepairWorkOrderNo(latestEquipments, today);'),
        '档案快捷报修单号应基于本地最新档案生成，避免连续报修时单号重复'
      );
      assert(
        createSource.indexOf('const parentAccepted = onQuickRepairCreated?.({') < createSource.indexOf('const nextEquipments = latestEquipments.map(eq => {') &&
          createSource.includes('const nextEquipments = latestEquipments.map(eq => {') &&
          createSource.includes('if (eq.id !== targetEq.id) return eq;') &&
          createSource.includes('maintenanceLogs: [repairLog, ...(eq.maintenanceLogs || [])]') &&
          createSource.includes('localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(nextEquipments));') &&
          createSource.includes('setEquipments(nextEquipments);') &&
          !createSource.includes('setEquipments(prevEquipments => {'),
        '档案快捷报修必须在父组件接受后基于最新持久化档案立即写入维修履历，避免切换工作区时丢失档案记录'
      );
      assert(
        archiveSource.includes('id="btn-clinical-open-quick-repair"') &&
          archiveSource.includes('aria-label="打开本科室故障一键快捷上报"') &&
          archiveSource.includes('const quickRepairableEquipments = visibleEquipments.filter(canStartQuickRepairForEquipment);') &&
          archiveSource.includes('const firstQuickRepairableEquipment = quickRepairableEquipments[0] || null;') &&
          archiveSource.includes('const clinicalQuickRepairBlockMessage = firstQuickRepairableEquipment') &&
          archiveSource.includes('disabled={!firstQuickRepairableEquipment}') &&
          archiveSource.includes("resetQuickRepairDraft(firstQuickRepairableEquipment.id)") &&
          archiveSource.includes('cursor-not-allowed') &&
          archiveSource.includes('id="btn-archive-instant-repair"') &&
          archiveSource.includes('aria-label="一键报修当前设备"') &&
          archiveSource.includes('id="quick-repair-equipment-select"') &&
          archiveSource.includes('aria-label="选择发生故障的装备"') &&
          archiveSource.includes('id={`quick-repair-urgency-${opt.value}`}') &&
          archiveSource.includes('aria-label={`设置报修紧急度：${opt.label}`}') &&
          archiveSource.includes('id="quick-repair-description"') &&
          archiveSource.includes('aria-label="故障现象具体描述"') &&
          archiveSource.includes('id="btn-submit-quick-repair"') &&
          archiveSource.includes('aria-label="提交快捷报修并分派"') &&
          archiveSource.includes('const canSubmitQuickRepair = Boolean(quickRepairEquipId && quickRepairDesc.trim());') &&
          archiveSource.includes('disabled={!canSubmitQuickRepair}') &&
          archiveSource.includes('disabled:cursor-not-allowed'),
        '资产档案快捷报修控件应提供稳定标识和可访问名称，便于临床人测与自动化回归'
      );
      assert(
        archiveSource.includes('quickRepairableEquipments') &&
          archiveSource.includes('firstQuickRepairableEquipment') &&
          archiveSource.includes('clinicalQuickRepairBlockMessage') &&
          archiveSource.includes('showQuickRepairToast({') &&
          archiveSource.includes('本科室设备已有进行中的维修工单，请在现有工单中补充故障信息，避免重复派单。'),
        '临床快捷面板入口应在本科室无可报修设备时直接禁用并提示原因，避免打开空报修弹窗'
      );
      assert(
        archiveSource.includes('id="btn-mobile-archive-scan-repair"') &&
          archiveSource.includes('aria-label="移动端扫码报修当前设备"') &&
          archiveSource.includes('disabled={!canStartQuickRepairForEquipment(selectedEquipment)}') &&
          archiveSource.includes("title={canStartQuickRepairForEquipment(selectedEquipment) ? '调用相机扫描SN码快速填充报修' : getQuickRepairBlockMessage(selectedEquipment)}") &&
          archiveSource.includes("canStartQuickRepairForEquipment(selectedEquipment)\n                        ? 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white'\n                        : 'bg-slate-200 text-slate-400 cursor-not-allowed'"),
        '移动端详情头部扫码报修入口应与桌面入口共享可报修状态，避免维修中设备仍能打开无效扫码流程'
      );
      assert(
        archiveSource.includes('id="main_container" className="flex-1 min-h-0 relative flex flex-col pb-20 md:pb-0"') &&
          archiveSource.includes('id="right_column_panel"') &&
          archiveSource.includes("mobileView === 'ai' ? 'fixed inset-x-3 top-48 bottom-20 z-20 flex' : 'hidden md:flex'") &&
          archiveSource.includes('md:static md:inset-auto md:z-auto'),
        '资产档案移动端应为固定底栏预留安全空间，避免 AI 智脑输入框被底部导航遮挡'
      );
      assert(
        archiveSource.includes('id={`equipment-card-${eq.id}`}') &&
          archiveSource.includes('role="button"') &&
          archiveSource.includes('aria-label={`打开设备档案：${eq.deviceName}，${eq.dept}，${eq.status}`}') &&
          archiveSource.includes("if (e.key === 'Enter' || e.key === ' ')") &&
          archiveSource.includes('id={`maintenance-log-${log.workOrderNo || log.id}`}') &&
          archiveSource.includes('aria-label={`打开维保履历：${log.workOrderNo || log.id}，${log.type}，${log.status}`}'),
        '资产设备卡片与维保履历卡应支持稳定定位和键盘打开，便于精确回看档案联动'
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
    name: 'clinical draft creation cannot manually reroute equipment repairs',
    run: () => {
      const appSource = readFileSync('src/App.tsx', 'utf8');
      const createStart = appSource.indexOf('const handleCreateTicketFromDraft = () => {');
      const createEnd = appSource.indexOf('// Handle Clinical Closed-loop Sign-off & Rating', createStart);
      assert(createStart !== -1 && createEnd > createStart, '应能定位草稿建单逻辑');
      const createSource = appSource.slice(createStart, createEnd);

      assert(
        createSource.includes("const effectiveRecommendedDept = currentUserRole === 'medical_staff'") &&
          createSource.includes('? routing.recommendedDept') &&
          createSource.includes(': (forwardDept || draftTicket.recommendedDept || routing.recommendedDept)'),
        '临床端建单时建议责任部门应按故障内容重算，不能采用手动改派值'
      );
      assert(
        createSource.includes("const normalizedTaskType = currentUserRole === 'medical_staff'") &&
          createSource.includes("routing.recommendedDept !== '医学装备科'") &&
          createSource.includes("? '非设备类转派任务'"),
        '临床端只有系统识别为非装备科问题时才应生成转派任务'
      );
      assert(
        createSource.includes("draftTicket.taskType === '非设备类转派任务' ||") &&
          createSource.includes("? '设备报修'"),
        '临床端不能通过手动把任务类型改为非设备转派来绕过设备维修闭环'
      );
      assert(
        createSource.includes("draftTicket.taskType === '供应商协同' && routing.needVendorCoop !== '是'") &&
          createSource.includes("? '设备报修'"),
        '临床端不能保留与故障内容矛盾的供应商协同类型'
      );
      assert(
        createSource.includes("const effectiveNeedVendorCoop = currentUserRole === 'medical_staff'") &&
          createSource.includes('? routing.needVendorCoop') &&
          createSource.includes(": (routing.needVendorCoop === '是' ? '是' : (draftTicket.needVendorCoop || '否'))"),
        '临床端建单时厂家协同应按故障内容重算，不能采用手动标记值'
      );
      assert(
        appSource.includes('const isCreatingDraftTicketRef = useRef(false);') &&
          createSource.includes('if (isCreatingDraftTicketRef.current) return;') &&
          createSource.includes('isCreatingDraftTicketRef.current = true;') &&
          createSource.includes('const newTicketId = createNextTaskId(tasksRef.current);') &&
          createSource.includes('const nextTasks = [newTicket, ...tasksRef.current];') &&
          createSource.includes('tasksRef.current = nextTasks;') &&
          createSource.includes('setTasks(nextTasks);') &&
          createSource.includes('localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(nextTasks));'),
        '草稿建单应基于最新任务列表生成单号、立即持久化并阻断连续点击，避免重复单号、重复工单或刷新丢失'
      );
      assert(
        createSource.includes('const duplicateRepairTask = shouldLinkEquipmentToTicket && linkedEquipment') &&
          createSource.includes('findActiveEquipmentRepairTask(tasksRef.current, linkedEquipment)') &&
          createSource.includes('if (duplicateRepairTask && linkedEquipment)') &&
          createSource.includes('isCreatingDraftTicketRef.current = false;') &&
          createSource.includes('setSelectedTask(duplicateRepairTask);') &&
          createSource.includes("appendWorkflowNotice(`⚠️ **重复报修提醒**") &&
          createSource.includes('msg-draft-repair-duplicate-blocked') &&
          createSource.includes('避免重复派单'),
        'AI 草稿建单应阻断同设备未闭环维修重复报修，并引导临床查看已有工单'
      );
      assert(
        createSource.includes('当前状态：【${newTicket.status}】') &&
          !createSource.includes('当前状态：【待响应派单】'),
        '建单成功提示应展示新工单真实状态，不能与右侧任务卡片状态不一致'
      );
      assert(
        appSource.includes('const explicitlyNoVendorCoop = /暂不需要厂家|不需要厂家|无需厂家') &&
          appSource.includes('const isEndoscopeVendorIssue = /胃镜|内镜|奥林巴斯|插入管/i.test(textLower)') &&
          appSource.includes('!explicitlyNoVendorCoop && (isEndoscopeVendorIssue || /厂家|外送|寄修|供应商|奥林巴斯/.test(textLower))'),
        '前端本地兜底解析应识别厂家协同否定语义，并将典型内镜漏水/气密性问题归为供应商协同'
      );
      assert(
        appSource.includes('const hasExplicitUrgency = /紧急|急需|急用|急修|赶紧|尽快|立即|马上|危急|严重|无法正常运行|影响患者|影响临床/i.test(textLower)') &&
          appSource.includes("isUrgent ? '生命支持' : (hasExplicitUrgency ? '特急' : '普通')") &&
          !appSource.includes("textLower.includes('急') ? '特急'"),
        '前端本地兜底紧急度不应因“急诊科”的“急”误判为特急，必须匹配明确急迫语义'
      );
      assert(
        appSource.includes('const isMedicalEquipmentContext = /呼吸机|除颤仪|麻醉机|监护仪') &&
          appSource.includes('mri') &&
          appSource.includes('扫描序列') &&
          appSource.includes('const isInformationOrLogisticsIssue = /电脑|网络|网线|系统|his|pacs|lis|后勤|打印机|卡纸|跳闸|照明|插座/i.test(textLower) && !isMedicalEquipmentContext;'),
        '前端本地兜底解析应先识别 MRI/DR/CT/超声等医学装备上下文，避免把设备系统错误误转信息科'
      );

      const serverSource = readFileSync('server.ts', 'utf8');
      assert(
        serverSource.includes('const isMedicalEquipmentContext = /呼吸机|除颤仪|麻醉机|监护仪') &&
          serverSource.includes('mri') &&
          serverSource.includes('扫描序列') &&
          serverSource.includes('const isInformationIssue = /电脑|网络|网线|系统|his|pacs|lis|打印机|卡纸|扫码枪|处方|开立|登录|信息系统|办公系统/i.test(textLower) && !isMedicalEquipmentContext;'),
        '服务端备用解析也应避免把医学装备系统错误误判为信息科问题'
      );

      const inlineTaskTypeStart = appSource.indexOf('<label className="text-[10px] font-bold text-slate-500 block mb-1">任务分类</label>');
      const inlineTaskTypeEnd = appSource.indexOf('<label className="text-[10px] font-bold text-slate-500 block mb-1">任务来源</label>', inlineTaskTypeStart);
      assert(inlineTaskTypeStart !== -1 && inlineTaskTypeEnd > inlineTaskTypeStart, '应能定位侧边草稿中的任务分类字段');
      const inlineTaskTypeSource = appSource.slice(inlineTaskTypeStart, inlineTaskTypeEnd);
      assert(
        inlineTaskTypeSource.includes("disabled={currentUserRole === 'medical_staff'}") &&
          inlineTaskTypeSource.includes('临床端由系统按故障描述自动判定任务类型'),
        '侧边草稿应禁止临床手动修改任务类型'
      );

      const modalTaskTypeStart = appSource.indexOf('<label className="text-slate-600 font-bold block mb-1 text-xs">1. 任务类型</label>');
      const modalTaskTypeEnd = appSource.indexOf('{/* 2. 任务来源 */}', modalTaskTypeStart);
      assert(modalTaskTypeStart !== -1 && modalTaskTypeEnd > modalTaskTypeStart, '应能定位完整草稿中的任务类型字段');
      const modalTaskTypeSource = appSource.slice(modalTaskTypeStart, modalTaskTypeEnd);
      assert(
        modalTaskTypeSource.includes("disabled={currentUserRole === 'medical_staff'}") &&
          modalTaskTypeSource.includes('防止误转派绕过验收闭环'),
        '完整草稿弹窗应禁止临床手动修改任务类型'
      );

      const recommendedDeptStart = appSource.indexOf('{/* 10. 建议责任部门 */}');
      const recommendedDeptEnd = appSource.indexOf('{/* 11. 联系人 */}', recommendedDeptStart);
      assert(recommendedDeptStart !== -1 && recommendedDeptEnd > recommendedDeptStart, '应能定位完整草稿中的建议责任部门字段');
      const recommendedDeptSource = appSource.slice(recommendedDeptStart, recommendedDeptEnd);
      assert(
        recommendedDeptSource.includes("disabled={currentUserRole === 'medical_staff'}") &&
          recommendedDeptSource.includes('临床端不可手动改派'),
        '完整草稿弹窗应禁止临床手动修改建议责任部门，并给出自动判定说明'
      );

      const updateDraftStart = appSource.indexOf('const handleUpdateDraftField = (');
      const updateDraftEnd = appSource.indexOf('// Add custom manual event/log to task', updateDraftStart);
      assert(updateDraftStart !== -1 && updateDraftEnd > updateDraftStart, '应能定位草稿字段更新逻辑');
      const updateDraftSource = appSource.slice(updateDraftStart, updateDraftEnd);
      assert(
        updateDraftSource.includes("field === 'deviceId' && !options.allowClinicalAssetId") &&
          updateDraftSource.includes('isClinicalLockedField ? {} : { [field]: value }') &&
          updateDraftSource.includes('allowClinicalAssetId?: boolean'),
        '临床端草稿字段更新逻辑应拦截手动改写设备编号，仅允许从本科室在册资产选择同步'
      );

      const inlineDeviceIdStart = appSource.indexOf('<label className="text-[10px] font-bold text-slate-500 block mb-1">设备资产编号</label>');
      const inlineDeviceIdEnd = appSource.indexOf('<label className="text-[10px] font-bold text-slate-500 block mb-1">科室联系人</label>', inlineDeviceIdStart);
      assert(inlineDeviceIdStart !== -1 && inlineDeviceIdEnd > inlineDeviceIdStart, '应能定位侧边草稿中的设备资产编号字段');
      const inlineDeviceIdSource = appSource.slice(inlineDeviceIdStart, inlineDeviceIdEnd);
      assert(
        inlineDeviceIdSource.includes("disabled={currentUserRole === 'medical_staff'}") &&
          inlineDeviceIdSource.includes('临床端不可手动改写资产编号') &&
          appSource.includes("handleUpdateDraftField('deviceId', selected.id, { allowClinicalAssetId: true });"),
        '侧边草稿应禁止临床手动修改设备资产编号，但允许从本科室在册资产下拉选择同步'
      );

      const modalDeviceIdStart = appSource.indexOf('{/* 6. 设备编号 */}');
      const modalDeviceIdEnd = appSource.indexOf('{/* 8. 是否影响临床 */}', modalDeviceIdStart);
      assert(modalDeviceIdStart !== -1 && modalDeviceIdEnd > modalDeviceIdStart, '应能定位完整草稿中的设备编号字段');
      const modalDeviceIdSource = appSource.slice(modalDeviceIdStart, modalDeviceIdEnd);
      assert(
        modalDeviceIdSource.includes("disabled={currentUserRole === 'medical_staff'}") &&
          modalDeviceIdSource.includes('临床端不可手动改写资产编号'),
        '完整草稿弹窗应禁止临床手动修改设备编号，避免外科室资产编号被手工带入'
      );

      const vendorCoopStart = appSource.indexOf('{/* 14. 是否需要厂家协同 */}');
      const vendorCoopEnd = appSource.indexOf('{/* 7. 问题描述 / 故障现象 */}', vendorCoopStart);
      assert(vendorCoopStart !== -1 && vendorCoopEnd > vendorCoopStart, '应能定位完整草稿中的厂家协同字段');
      const vendorCoopSource = appSource.slice(vendorCoopStart, vendorCoopEnd);
      assert(
        vendorCoopSource.includes("disabled={currentUserRole === 'medical_staff'}") &&
          vendorCoopSource.includes('厂家协同由系统按故障描述识别，并由医学装备科工程师复核联系'),
        '完整草稿弹窗应禁止临床手动标记厂家协同，避免绕过系统路由判定'
      );
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
      assert(
        clinicalDetailSource.includes('已完成闭环档案归档或关闭留痕') &&
          clinicalDetailSource.includes("const isCompleted = ['已完成', '已归档', '已关闭'].includes(selectedTask.status);") &&
          !clinicalDetailSource.includes("const isCompleted = ['已完成', '已归档'].includes(selectedTask.status);"),
        '已完成后被工程师关闭留痕的设备维修单，在临床闭环时间线中也应显示为已闭环'
      );
      assert(
        clinicalDetailSource.includes("needsClinicalAcceptance(selectedTask) && ['已完成', '已归档', '已关闭'].includes(selectedTask.status)") &&
          clinicalDetailSource.includes('const acceptance = getTaskAcceptanceDisplay(selectedTask);') &&
          clinicalDetailSource.includes('已闭环验收') &&
          clinicalDetailSource.includes('临床满意度评分:'),
        '设备维修单归档或关闭留痕后，临床端仍应展示已闭环验收评分与意见'
      );
      const engineerDetailSource = appSource.slice(engineerStart);
      assert(
        engineerDetailSource.includes("needsClinicalAcceptance(selectedTask) && ['已完成', '已归档', '已关闭'].includes(selectedTask.status)") &&
          engineerDetailSource.includes('const acceptance = getTaskAcceptanceDisplay(selectedTask);') &&
          engineerDetailSource.includes('临床已闭环验收') &&
          engineerDetailSource.includes('满意度:') &&
          engineerDetailSource.includes('acceptance.comment'),
        '设备维修单归档或关闭留痕后，工程师端也应展示临床验收摘要，便于归档审计'
      );
    }
  },
  {
    name: 'clinical task detail hides engineer management actions',
    run: () => {
      const appSource = readFileSync('src/App.tsx', 'utf8');
      const clinicalStart = appSource.indexOf("{currentUserRole === 'medical_staff' ? (");
      const engineerStart = appSource.indexOf(') : selectedTask ? (', clinicalStart);
      assert(clinicalStart !== -1 && engineerStart > clinicalStart, '应能定位临床任务详情视图');
      const clinicalDetailSource = appSource.slice(clinicalStart, engineerStart);

      assert(
        !clinicalDetailSource.includes('handleDeleteTask') &&
          !clinicalDetailSource.includes('btn-delete-') &&
          !clinicalDetailSource.includes('Trash2'),
        '临床任务详情不能暴露工程师删除工单入口'
      );
      assert(
        !clinicalDetailSource.includes('handleUpdateStatus') &&
          !clinicalDetailSource.includes('status-set-') &&
          !clinicalDetailSource.includes('流转状态快速调节器'),
        '临床任务详情不能暴露工程师状态快控入口'
      );
      const deleteStart = appSource.indexOf('const handleDeleteTask = (id: string) => {');
      const deleteEnd = appSource.indexOf('// Clear all and restore presets', deleteStart);
      assert(deleteStart !== -1 && deleteEnd > deleteStart, '应能定位工程师删除工单逻辑');
      const deleteSource = appSource.slice(deleteStart, deleteEnd);
      assert(
        deleteSource.includes('const filtered = tasksRef.current.filter(t => t.id !== id);') &&
          deleteSource.includes('tasksRef.current = filtered;') &&
          deleteSource.includes('setTasks(filtered);') &&
          deleteSource.includes('localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(filtered));') &&
          deleteSource.includes('setSelectedTask(getVisibleFallbackTask(filtered));'),
        '工程师删除工单应基于最新任务列表过滤、立即持久化，并把详情切到当前角色优先级最高的可见任务'
      );
    }
  },
  {
    name: 'role switch preserves the focused visible task',
    run: () => {
      const appSource = readFileSync('src/App.tsx', 'utf8');
      const switchStart = appSource.indexOf('const handleSwitchUser = (userId: string) => {');
      const switchEnd = appSource.indexOf('const [chatMessages, setChatMessages]', switchStart);
      assert(switchStart !== -1 && switchEnd > switchStart, '应能定位角色切换逻辑');
      const switchSource = appSource.slice(switchStart, switchEnd);

      assert(
        switchSource.includes('currentTaskBelongsToTargetDept') &&
          switchSource.includes('const latestTasks = tasksRef.current;') &&
          switchSource.includes('const latestSelectedTask = selectedTask ? latestTasks.find(task => task.id === selectedTask.id) || null : null;') &&
          switchSource.includes('canUserSeeTask(latestSelectedTask, targetUser, targetUser.role)') &&
          switchSource.includes('setSelectedTask(latestSelectedTask);'),
        '切回临床同科室时应基于最新任务列表保留当前聚焦工单，避免关闭转派单被列表排序切走'
      );
      assert(
        appSource.includes('const canUserSeeTask = (task: StructuredTicket, user: UserProfile, userRole = user.role) => {') &&
          appSource.includes('const getVisibleFallbackTask = (sourceTasks: StructuredTicket[]) => {') &&
          appSource.includes('return getDepartmentTasks(sourceTasks, currentUserDepartment)[0] || null;') &&
          switchSource.includes('const deptTasks = getDepartmentTasks(latestTasks, targetUser.department || targetUser.dept);') &&
          switchSource.includes('const engineerFocusedTask = latestSelectedTask || latestTasks[0] || null;') &&
          switchSource.includes('setSelectedTask(engineerFocusedTask);') &&
          !switchSource.includes('setSelectedTask(tasksRef.current[0] || null);'),
        '切换身份和回退选中工单时应复用当前角色优先级规则，工程师仍优先保留刚刚处理的聚焦工单'
      );
      assert(
        switchSource.includes('setMobileTab(\'detail\');') &&
          switchSource.includes('setMobileTab(\'list\');') &&
          switchSource.includes('setMobileTab(\'chat\');') &&
          switchSource.includes('const engineerFocusedTask = latestSelectedTask || latestTasks[0] || null;') &&
          switchSource.includes("setMobileTab(engineerFocusedTask ? 'detail' : 'list');"),
        '切换身份时移动端标签应随新角色上下文归位：有聚焦单看详情、有本科室任务看列表、无任务回到 AI 报修入口'
      );
    }
  },
  {
    name: 'task deeplinks and clinical fallback use latest task state',
    run: () => {
      const appSource = readFileSync('src/App.tsx', 'utf8');
      const deepLinkStart = appSource.indexOf('const handleDeepLinkTicket = (e: any) => {');
      const deepLinkEnd = appSource.indexOf("window.addEventListener('deep-link-ticket'", deepLinkStart);
      assert(deepLinkStart !== -1 && deepLinkEnd > deepLinkStart, '应能定位工单深链逻辑');
      const deepLinkSource = appSource.slice(deepLinkStart, deepLinkEnd);

      assert(
        deepLinkSource.includes('const latestTasks = tasksRef.current;') &&
          deepLinkSource.includes('const found = latestTasks.find(t => t.id === ticketId);') &&
          deepLinkSource.includes('const fallbackTask = getVisibleFallbackTask(latestTasks);'),
        '工单深链打开和跨科室拦截回退应使用最新任务列表与当前角色优先级，避免打开已被更新或删除的旧工单'
      );

      const selectedSyncStart = appSource.indexOf('useEffect(() => {\n    if (!selectedTask) return;');
      const selectedSyncEnd = appSource.indexOf('useEffect(() => {\n    if (!isClinicalUser', selectedSyncStart);
      assert(selectedSyncStart !== -1 && selectedSyncEnd > selectedSyncStart, '应能定位选中工单同步逻辑');
      const selectedSyncSource = appSource.slice(selectedSyncStart, selectedSyncEnd);
      assert(
        selectedSyncSource.includes('const latestSelectedTask = tasksRef.current.find(task => task.id === selectedTask.id);') &&
          selectedSyncSource.includes('setSelectedTask(latestSelectedTask);') &&
          selectedSyncSource.includes('if (!latestSelectedTask)') &&
          selectedSyncSource.includes('const fallbackTask = getVisibleFallbackTask(tasksRef.current);') &&
          selectedSyncSource.includes("setMobileTab(isClinicalUser ? 'chat' : 'list');"),
        '选中工单详情应从最新任务列表刷新；若工单已删除或重置消失，应回退到当前角色优先级最高的可见任务，避免右侧详情停留在旧对象'
      );

      const clinicalFallbackStart = selectedSyncEnd;
      const clinicalFallbackEnd = appSource.indexOf('// Advanced AI custom settings states', clinicalFallbackStart);
      assert(clinicalFallbackEnd > clinicalFallbackStart, '应能定位临床跨科室回退逻辑');
      const clinicalFallbackSource = appSource.slice(clinicalFallbackStart, clinicalFallbackEnd);
      assert(
        clinicalFallbackSource.includes('const fallbackTask = getVisibleFallbackTask(tasksRef.current);') &&
          clinicalFallbackSource.includes('setSelectedTask(fallbackTask);'),
        '临床身份发现当前详情跨科室时，应从最新任务列表选择临床优先级最高的可见回退任务'
      );
    }
  },
  {
    name: 'role switch clears stale draft intake state',
    run: () => {
      const appSource = readFileSync('src/App.tsx', 'utf8');
      const switchStart = appSource.indexOf('const handleSwitchUser = (userId: string) => {');
      const switchEnd = appSource.indexOf('// Set a toast to show role switch', switchStart);
      assert(switchStart !== -1 && switchEnd > switchStart, '应能定位角色切换开场清理逻辑');
      const switchSource = appSource.slice(switchStart, switchEnd);

      assert(
        switchSource.includes('roleSessionVersionRef.current += 1;') &&
          switchSource.includes('setDraftTicket(null);') &&
          switchSource.includes('setAiSuggestions([]);') &&
          switchSource.includes('setForwardDept(null);') &&
          switchSource.includes('setIsClarification(false);') &&
          switchSource.includes('setIsFullDraftOpen(false);') &&
          switchSource.includes('setIsLoading(false);') &&
          switchSource.includes("setSearchQuery('');") &&
          switchSource.includes("setTypeFilter('All');") &&
          switchSource.includes("setUrgencyFilter('All');") &&
          switchSource.includes("setStatusFilter('All');") &&
          switchSource.includes("setSourceFilter('All');"),
        '切换身份时应清空未提交草稿、展开确认窗口、AI 建议、加载状态与工单筛选，避免上一身份上下文串入新身份'
      );
      assert(
        appSource.includes('const stopVoiceSimulation = (resetState = true) => {') &&
          appSource.includes('clearInterval(simulationIntervalRef.current);') &&
          appSource.includes('simulationIntervalRef.current = null;') &&
          appSource.includes('if (resetState)') &&
          appSource.includes('setIsSimulating(false);'),
        '语音仿真应通过统一入口停止计时器并复位仿真状态'
      );
      assert(
        switchSource.includes('setShowVoiceMockModal(false);') &&
          switchSource.includes("setSimulationText('');") &&
          switchSource.includes('stopVoiceSimulation();') &&
          switchSource.includes('stopListening();'),
        '切换身份时应关闭语音仿真弹窗、清空仿真文本并停止上一身份的听写计时器和真实麦克风识别'
      );
      const roleToastStart = appSource.indexOf('const showRoleToast = (message: string) => {');
      const roleToastEnd = appSource.indexOf('const handleSwitchUser = (userId: string) => {', roleToastStart);
      assert(roleToastStart !== -1 && roleToastEnd > roleToastStart, '应能定位顶部角色/权限提示逻辑');
      const roleToastSource = appSource.slice(roleToastStart, roleToastEnd);
      assert(
        appSource.includes('const roleToastTimerRef = useRef<number | null>(null);') &&
          roleToastSource.includes('if (roleToastTimerRef.current !== null)') &&
          roleToastSource.includes('window.clearTimeout(roleToastTimerRef.current);') &&
          roleToastSource.includes('roleToastTimerRef.current = window.setTimeout(() => {') &&
          roleToastSource.includes('setShowRoleSwitchedToast(null);') &&
          roleToastSource.includes('roleToastTimerRef.current = null;') &&
          roleToastSource.includes('return () => {') &&
          roleToastSource.includes('window.clearTimeout(roleToastTimerRef.current);') &&
          !appSource.includes('setTimeout(() => setShowRoleSwitchedToast(null), 4500);'),
        '顶部角色/权限 toast 应统一清理旧定时器，避免快速切换身份或连续权限提醒时旧定时器提前清掉新提示'
      );
      const roleToastCallCount = (appSource.match(/showRoleToast\(/g) || []).length;
      assert(
        roleToastCallCount >= 5 &&
          appSource.includes('已切换身份为') &&
          appSource.includes('已阻止跨科室工单访问') &&
          appSource.includes("showRoleToast('AI配置由医学装备科维护，临床端仅可查看当前模型运行状态');") &&
          appSource.includes("showRoleToast('临床端无权重置全院演示数据');"),
        '角色切换、跨科室拦截、临床 AI 配置提醒和重置数据拦截都应走统一顶部 toast 入口'
      );
      const restoreStart = appSource.indexOf('const handleRestoreDefaults = () => {');
      const restoreEnd = appSource.indexOf('// Filters calculation', restoreStart);
      assert(restoreStart !== -1 && restoreEnd > restoreStart, '应能定位恢复演示数据逻辑');
      const restoreSource = appSource.slice(restoreStart, restoreEnd);
      assert(
        appSource.includes("import { EQUIPMENT_STORAGE_KEY, getDefaultEquipmentList, parseStoredEquipmentList } from './utils/equipmentStorage';") &&
          restoreSource.includes("getEngineerActionBlockReason('重置演示数据')") &&
          restoreSource.includes("confirm('确定要清除所有修改，恢复系统默认内置任务单和设备档案吗？')") &&
          restoreSource.includes('const defaultEquipments = getDefaultEquipmentList();') &&
          restoreSource.includes('pendingQuickRepairEquipmentIdsRef.current.clear();') &&
          restoreSource.includes('pendingClinicalAcceptanceTaskIdsRef.current.clear();') &&
          restoreSource.includes('tasksRef.current = INITIAL_TASKS;') &&
          restoreSource.includes('setTasks(INITIAL_TASKS);') &&
          restoreSource.includes('setAllEquipments(defaultEquipments);') &&
          restoreSource.includes('localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(INITIAL_TASKS));') &&
          restoreSource.includes('localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(defaultEquipments));') &&
          restoreSource.includes('初始化的演示任务与设备档案状态') &&
          restoreSource.includes("setCurrentWorkspace('tasks');"),
        '工程师重置演示数据应同时恢复任务、设备档案、内存统计和防重复 pending 状态，避免任务与资产档案不同步'
      );
      const speechSource = readFileSync('src/hooks/useSpeechRecognition.ts', 'utf8');
      assert(
        speechSource.includes('const speechSessionVersionRef = useRef(0);') &&
          speechSource.includes('const SpeechRecognitionRef = useRef<any>(null);') &&
          speechSource.includes('const createRecognitionSession = (sessionVersion: number) => {') &&
          speechSource.includes('if (sessionVersion !== speechSessionVersionRef.current) return;') &&
          speechSource.includes('const stopListening = (resetState = true) => {') &&
          speechSource.includes('speechSessionVersionRef.current += 1;') &&
          speechSource.includes('recognitionRef.current?.abort();') &&
          speechSource.includes('recognitionRef.current = null;') &&
          speechSource.includes('if (resetState)') &&
          speechSource.includes('stopListening(false);') &&
          speechSource.includes('stopListening,'),
        '真实麦克风语音识别应使用会话版本隔离旧回调，停止录音时作废旧识别结果'
      );
      assert(
        appSource.includes('const activeRoleSessionVersion = roleSessionVersionRef.current;') &&
          appSource.includes('if (activeRoleSessionVersion !== roleSessionVersionRef.current) return;') &&
          appSource.includes('if (activeRoleSessionVersion === roleSessionVersionRef.current)'),
        'AI 异步返回应校验角色会话版本，丢弃切换身份前的旧响应'
      );
      const openArchiveStart = appSource.indexOf('const openLinkedEquipmentArchive = (equipmentId: string) => {');
      const openArchiveEnd = appSource.indexOf('useEffect(() => {\n    const handleDeepLinkTicket', openArchiveStart);
      assert(openArchiveStart !== -1 && openArchiveEnd > openArchiveStart, '应能定位任务详情跳转资产档案逻辑');
      const openArchiveSource = appSource.slice(openArchiveStart, openArchiveEnd);
      assert(
        openArchiveSource.includes('const activeRoleSessionVersion = roleSessionVersionRef.current;') &&
          openArchiveSource.includes("setCurrentWorkspace('archives');") &&
          openArchiveSource.includes('setTimeout(() => {') &&
          openArchiveSource.includes('if (activeRoleSessionVersion !== roleSessionVersionRef.current) return;') &&
          openArchiveSource.includes("window.dispatchEvent(new CustomEvent('deep-link-equipment'") &&
          appSource.includes('onClick={() => openLinkedEquipmentArchive(matchedEquip.id)}') &&
          !appSource.includes("setTimeout(() => {\n                                  window.dispatchEvent(new CustomEvent('deep-link-equipment'"),
        '任务详情延迟跳转资产档案时应绑定当前角色会话，避免切换身份后旧深链打开旧设备档案'
      );
    }
  },
  {
    name: 'assistant fallback keeps clinical user context on the server',
    run: () => {
      const appSource = readFileSync('src/App.tsx', 'utf8');
      assert(
        appSource.includes('activeConfig: activeConfig') && appSource.includes('currentUser: currentSimulatedUser'),
        '前端应把当前模型配置与当前用户上下文发给服务端'
      );

      const serverSource = readFileSync('server.ts', 'utf8');
      assert(
        serverSource.includes("req.body?.config || req.body?.activeConfig") &&
          serverSource.includes("req.body?.user || req.body?.currentUser"),
        '服务端应兼容前端 activeConfig/currentUser 字段'
      );
      assert(
        serverSource.includes("currentUser?.role === 'medical_staff'") &&
          serverSource.includes('department = currentUserDepartment') &&
          serverSource.includes('AI原始识别科室为'),
        '服务端本地降级应按临床登录科室规范化草稿科室'
      );
      assert(
        serverSource.includes('getRuleBasedFallback(message, currentDraft, false, user)') &&
          serverSource.includes('getRuleBasedFallback(message, currentDraft, true, user)'),
        '无 API Key 或模型异常时，服务端 fallback 都应保留当前用户上下文'
      );
      assert(
        serverSource.includes('const explicitlyNoVendorCoop = /暂不需要厂家|不需要厂家|无需厂家') &&
          serverSource.includes('const isEndoscopeVendorIssue = /胃镜|内镜|奥林巴斯|插入管/i.test(textLower)') &&
          serverSource.includes('const isLogisticsIssue = /后勤|跳闸|照明|插座|强电|水管|空调|门锁|电源插座|漏电|配电/i.test(textLower)') &&
          serverSource.includes('!explicitlyNoVendorCoop && (isEndoscopeVendorIssue || /厂家|外送|寄修|供应商|奥林巴斯/.test(textLower))') &&
          serverSource.includes("? (isLogisticsIssue ? '后勤保障科' : '信息科')") &&
          serverSource.includes("forwardDepartment: taskType === '非设备类转派任务' ? recommendedDept : null") &&
          serverSource.includes('const hasExplicitUrgency = /紧急|急需|急用|急修|赶紧|尽快|立即|马上|危急|严重|无法正常运行|影响患者|影响临床/i.test(textLower)') &&
          serverSource.includes("isUrgent ? '生命支持' : (hasExplicitUrgency ? '特急' : (draft.urgency || '普通'))") &&
          !serverSource.includes("textLower.includes('急') ? '特急'") &&
          serverSource.includes("explicitlyNoVendorCoop") &&
          serverSource.includes("? '否'") &&
          serverSource.includes("taskType === '供应商协同' || taskType === '验收安装协同' ? '是'"),
        '服务端本地降级应识别厂家协同否定语义、典型内镜供应商协同，把后勤类转派归口后勤保障科，并避免急诊科误触发特急'
      );

      const indexSource = readFileSync('index.html', 'utf8');
      assert(
        indexSource.includes('<title>医学装备数字化平台</title>'),
        '浏览器标签标题应使用产品名称而不是模板默认名'
      );
    }
  },
  {
    name: 'local server port can be overridden for parallel role testing',
    run: () => {
      const serverSource = readFileSync('server.ts', 'utf8');
      const readmeSource = readFileSync('README.md', 'utf8');
      assert(
        serverSource.includes("import { createServer as createHttpServer } from 'node:http';") &&
          serverSource.includes('const parseServerPort = (value: string | undefined, fallback: number) => {') &&
          serverSource.includes('const PORT = parseServerPort(process.env.PORT || process.env.VITE_PORT, 3000);') &&
          serverSource.includes('const httpServer = createHttpServer(app);') &&
          serverSource.includes('server: { middlewareMode: true, hmr: { server: httpServer } }') &&
          serverSource.includes("httpServer.listen(PORT, '0.0.0.0'") &&
          !serverSource.includes('const PORT = 3000;') &&
          !serverSource.includes("app.listen(PORT, '0.0.0.0'"),
        '本地服务端口不应写死，需支持 PORT/VITE_PORT 以便同时运行展示实例和隔离测试实例'
      );
      assert(
        readmeSource.includes('To run a second local instance for isolated role testing') &&
          readmeSource.includes('$env:PORT="3001"; npm run dev'),
        'README 应说明如何启动第二个本地实例用于隔离角色测试'
      );
    }
  },
  {
    name: 'clinical model status cannot open engineer-only ai settings',
    run: () => {
      const appSource = readFileSync('src/App.tsx', 'utf8');
      const settingsSource = readFileSync('src/hooks/useAiSettings.ts', 'utf8');
      const serverSource = readFileSync('server.ts', 'utf8');
      const openSettingsStart = appSource.indexOf('const openAiSettings = () => {');
      const openSettingsEnd = appSource.indexOf('useEffect(() => {', openSettingsStart);
      assert(openSettingsStart !== -1 && openSettingsEnd > openSettingsStart, '应能定位 AI 配置统一入口');
      const openSettingsSource = appSource.slice(openSettingsStart, openSettingsEnd);

      assert(
        openSettingsSource.includes('if (isClinicalUser)') &&
          openSettingsSource.includes('notifyAiSettingsManagedByEngineer();') &&
          openSettingsSource.includes('return;'),
        '临床点击模型状态时应收到医学装备科维护提示，而不是打开工程师配置中心'
      );
      assert(
        appSource.includes('AI配置由医学装备科维护，临床端仅可查看当前模型运行状态'),
        '临床端应明确提示 AI 配置由医学装备科维护'
      );
      assert(
        appSource.includes('{!isClinicalUser && isSettingsOpen && ('),
        'AI 设置弹窗本身也应禁止临床角色渲染'
      );
      assert(
        appSource.includes('if (isClinicalUser && isSettingsOpen)') &&
          appSource.includes('setIsSettingsOpen(false);'),
        '工程师已打开 AI 设置后切换到临床角色时，应立即关闭配置弹窗，避免工程师配置界面残留给临床端'
      );
      assert(
        !appSource.includes('onClick={() => setIsSettingsOpen(true)}'),
        '大模型状态与侧边栏按钮应统一走 openAiSettings 权限入口'
      );
      assert(
        settingsSource.includes('const normalizeProviderConfigs = (rawValue: string) => {') &&
          settingsSource.includes('if (!Array.isArray(parsed)) return DEFAULT_LLM_PRESETS;') &&
          settingsSource.includes('DEFAULT_LLM_PRESETS.forEach((preset) => {') &&
          settingsSource.includes('normalizeProviderConfig({ ...cfg, [field]: value }, fallback)'),
        'AI 设置应清洗本地存储中的供应商配置，避免坏数据导致配置页或模型调用异常'
      );
      assert(
        settingsSource.includes('const getSafeActiveProviderId = (rawValue: string) => {') &&
          settingsSource.includes("return DEFAULT_LLM_PRESETS.some(config => config.id === candidateId) ? candidateId : 'gemini-default';"),
        'AI 设置应在活跃供应商 ID 不存在时回退默认 Gemini，避免选择器处于悬空状态'
      );
      assert(
        serverSource.includes("const normalizedEndpoint = typeof configToUse.endpoint === 'string' ? configToUse.endpoint.trim() : '';") &&
          serverSource.includes("const isGeminiNative = configToUse.id === 'gemini-default' || normalizedEndpoint.includes('googleapis.com') || normalizedEndpoint.includes('gemini');") &&
          serverSource.includes('Custom provider endpoint missing. Falling back to local heuristics.'),
        '自定义供应商 endpoint 为空时服务端不能误走 Gemini，应降级到本地启发式'
      );
      assert(
        serverSource.includes("const normalizedEndpoint = typeof endpoint === 'string' ? endpoint.trim() : '';") &&
          serverSource.includes("throw new Error(`自定义供应商 ${name || id || ''} 未配置 API 请求地址"),
        '自定义供应商联通测试应明确提示缺少 API 请求地址'
      );
      assert(
        serverSource.includes('const errorMessage = err.message || String(err);') &&
          serverSource.includes('error: errorMessage') &&
          serverSource.includes('message: `连接失败: ${errorMessage}`'),
        'AI 联通测试失败响应应保留具体错误原因，避免前端只显示泛化排查文案'
      );
    }
  },
  {
    name: 'equipment diagnostic chat resets on equipment or role change',
    run: () => {
      const archiveSource = readFileSync('src/components/EquipmentArchives.tsx', 'utf8');
      const chatResetStart = archiveSource.indexOf('// Refresh AI Chat context on device and user change');
      const chatResetEnd = archiveSource.indexOf('// Unique list for filtering dropdowns', chatResetStart);
      assert(chatResetStart !== -1 && chatResetEnd > chatResetStart, '应能定位资产档案 AI 诊断会话重置逻辑');
      const chatResetSource = archiveSource.slice(chatResetStart, chatResetEnd);

      const sendChatStart = archiveSource.indexOf('const sendChatMessage = () => {');
      const sendChatEnd = archiveSource.indexOf('// Process OCR files', sendChatStart);
      assert(sendChatStart !== -1 && sendChatEnd > sendChatStart, '应能定位资产档案 AI 诊断发送逻辑');
      const sendChatSource = archiveSource.slice(sendChatStart, sendChatEnd);
      const staleGuardMatches = sendChatSource.match(/requestVersion !== chatRequestVersionRef\.current \|\| requestSessionKey !== diagnosticChatSessionKeyRef\.current/g) || [];

      assert(
        archiveSource.includes('const getDiagnosticSessionKey = (equipment: MedicalEquipment | null, user: UserProfile)') &&
          archiveSource.includes("return `${user.id}:${equipment?.id || 'no-equipment'}`;") &&
          archiveSource.includes('const createDiagnosticWelcome = (equipment?: MedicalEquipment | null, user?: UserProfile)'),
        '资产档案 AI 诊断会话应绑定当前设备与当前登录身份'
      );
      assert(
        archiveSource.includes('const chatRequestVersionRef = useRef(0);') &&
          archiveSource.includes("const diagnosticChatSessionKeyRef = useRef('');") &&
          archiveSource.includes('const currentDiagnosticSessionKey = getDiagnosticSessionKey(selectedEquipment, currentUser);'),
        '资产档案 AI 诊断异步请求应有会话版本和设备/用户 key'
      );
      assert(
        chatResetSource.includes('diagnosticChatSessionKeyRef.current = currentDiagnosticSessionKey;') &&
          chatResetSource.includes('chatRequestVersionRef.current += 1;') &&
          chatResetSource.includes('setIsChatSending(false);') &&
          chatResetSource.includes("setChatInput('');") &&
          chatResetSource.includes('createDiagnosticWelcome(selectedEquipment, currentUser)') &&
          chatResetSource.includes('currentDiagnosticSessionKey') &&
          chatResetSource.includes('currentUser.role') &&
          chatResetSource.includes('currentUserDepartment'),
        '切换设备或角色时应重置资产档案 AI 诊断上下文并废弃旧请求'
      );
      assert(
        sendChatSource.includes('if (!chatInput.trim() || !selectedEquipment || isChatSending) return;') &&
          sendChatSource.includes('const requestVersion = chatRequestVersionRef.current;') &&
          sendChatSource.includes('const requestSessionKey = currentDiagnosticSessionKey;') &&
          staleGuardMatches.length >= 2,
        '资产档案 AI 诊断返回成功或失败时都应丢弃旧设备/旧角色的异步响应'
      );
    }
  },
  {
    name: 'maintenance calendar keeps clinical readonly and engineer deploy paths',
    run: () => {
      const calendarSource = readFileSync('src/components/MaintenanceCalendar.tsx', 'utf8');

      assert(
        calendarSource.includes("const canManageSchedule = currentUser.role === 'engineer'") &&
          calendarSource.includes("currentUser.role === 'medical_staff' && !isSameDepartment"),
        '维保日历应按角色隔离管理权限并限制临床只看本科室设备'
      );
      assert(
        calendarSource.includes("import { getDefaultEngineerName, getEngineerNameByIndex, normalizeEngineerName, SIMULATED_ENGINEER_NAMES } from '../utils/engineerAssignments';") &&
          calendarSource.includes("setDeployEngineer(currentUser.name);") &&
          calendarSource.includes('SIMULATED_ENGINEER_NAMES.forEach(name => set.add(name));') &&
          calendarSource.includes('const assignedMaintenanceEngineer = normalizeEngineerName(eq.assignedMaintenanceEngineer);') &&
          calendarSource.includes('const assignedCalibrationEngineer = normalizeEngineerName(eq.assignedCalibrationEngineer);') &&
          calendarSource.includes("const customAssigned = normalizeEngineerName(type === 'maintenance' ? eq.assignedMaintenanceEngineer : eq.assignedCalibrationEngineer);") &&
          calendarSource.includes('return getEngineerNameByIndex(1);') &&
          calendarSource.includes('return getEngineerNameByIndex(2);') &&
          !calendarSource.includes('(eq as any).assignedMaintenanceEngineer') &&
          !calendarSource.includes("set.add('王强');") &&
          !calendarSource.includes("return '王强';") &&
          !calendarSource.includes("return '张华';") &&
          !calendarSource.includes("return '李明';") &&
          !calendarSource.includes("return '赵四';"),
        '维保日历默认责任工程师应复用系统模拟工程师，避免切换到个人工程师视图后看板空白或身份不一致'
      );
      {
        const engineerAssignmentSource = readFileSync('src/utils/engineerAssignments.ts', 'utf8');
        assert(
          engineerAssignmentSource.includes("export const FALLBACK_ENGINEER_NAMES = ['张明华', '李建国', '赵安平'];") &&
            engineerAssignmentSource.includes('export const SIMULATED_ENGINEER_NAMES = SIMULATED_USERS') &&
            engineerAssignmentSource.includes('const LEGACY_ENGINEER_NAME_ALIASES') &&
            engineerAssignmentSource.includes("王强: '张明华'") &&
            engineerAssignmentSource.includes("张华: '李建国'") &&
            engineerAssignmentSource.includes("李明: '赵安平'") &&
            engineerAssignmentSource.includes("赵四: '赵安平'"),
          '工程师责任人工具应集中维护模拟工程师和旧版演示姓名迁移表'
        );
        assertEqual(normalizeEngineerName('王强'), '张明华', '旧版王强责任人应迁移到张明华');
        assertEqual(normalizeEngineerName('张华'), '李建国', '旧版张华责任人应迁移到李建国');
        assertEqual(normalizeEngineerName('李明'), '赵安平', '旧版李明责任人应迁移到赵安平');

        const simulatedEngineerNames = SIMULATED_USERS.filter(user => user.role === 'engineer').map(user => user.name);
        assert(
          simulatedEngineerNames.length >= 3 &&
            ['张明华', '李建国', '赵安平'].every(name => simulatedEngineerNames.includes(name)),
          '模拟用户应包含三位可测试的装备科工程师'
        );

        const getEngineerNameByIndex = (index: number) => simulatedEngineerNames[index % simulatedEngineerNames.length];
        const assignedEngineerNames = new Set<string>();

        DEFAULT_EQUIPMENT.forEach(eq => {
          if (eq.nextMaintenanceDate) {
            if (eq.category === '急救生命支持') assignedEngineerNames.add(getEngineerNameByIndex(0));
            else if (eq.category === '影像诊断') assignedEngineerNames.add(getEngineerNameByIndex(1));
            else if (eq.category === '检验分析') assignedEngineerNames.add(getEngineerNameByIndex(2));
            else assignedEngineerNames.add(getEngineerNameByIndex(2));
          }

          if (eq.calibrationRequired && eq.nextCalibrationDate) {
            if (eq.category === '影像诊断') assignedEngineerNames.add(getEngineerNameByIndex(2));
            else if (eq.category === '检验分析') assignedEngineerNames.add(getEngineerNameByIndex(1));
            else assignedEngineerNames.add(getEngineerNameByIndex(0));
          }
        });

        assert(
          simulatedEngineerNames.every(name => assignedEngineerNames.has(name)),
          '默认设备排程应覆盖每位模拟工程师，保证不同工程师个人日历视图都有可见任务'
        );
      }
      assert(
        calendarSource.includes('临床日程只读视图') &&
          calendarSource.includes('新工单部署、调期和改派由医学装备科工程师执行'),
        '临床日历视图应显示只读说明'
      );
      assert(
        calendarSource.includes("canManageSchedule\n                      ? '本月无计划安排。可以点击下方“工作部署”下达维保、强检任务，或在左侧列表设定计划周期。'\n                      : '本月本科室暂无待执行计划。临床端可查看历史记录和后续排期；如需新增维保、强检或维修安排，请联系医学装备科工程师统一部署。'"),
        '临床日历无计划时不应提示点击工程师工作部署入口'
      );
      assert(
        calendarSource.includes('canManageSchedule ? (') &&
          calendarSource.includes('部署{scheduleScopeLabel}新工作指令') &&
          calendarSource.includes('handleDeployWorkSubmit'),
        '工程师日历视图应保留部署新工作指令能力'
      );
      assert(
        calendarSource.includes("getScheduleManageBlockReason('新工单部署')") &&
          calendarSource.includes("getScheduleManageBlockReason('日程调期')") &&
          calendarSource.includes("getScheduleManageBlockReason('技术员改派')") &&
          calendarSource.includes("getScheduleManageBlockReason('现场执行登记')") &&
          calendarSource.includes("getScheduleManageBlockReason('通知推送')"),
        '日历所有管理型操作应统一走角色阻断逻辑'
      );
      const notificationStart = calendarSource.indexOf('const triggerNotification = (msg: string) => {');
      const notificationEnd = calendarSource.indexOf('// Weekday headers', notificationStart);
      assert(notificationStart !== -1 && notificationEnd > notificationStart, '应能定位日历通知提示逻辑');
      const notificationSource = calendarSource.slice(notificationStart, notificationEnd);
      assert(
        calendarSource.includes('const notificationTimerRef = useRef<number | null>(null);') &&
          notificationSource.includes('if (notificationTimerRef.current !== null)') &&
          notificationSource.includes('window.clearTimeout(notificationTimerRef.current);') &&
          notificationSource.includes('notificationTimerRef.current = window.setTimeout(() => {') &&
          notificationSource.includes('setNotification(null);') &&
          notificationSource.includes('notificationTimerRef.current = null;') &&
          notificationSource.includes('return () => {') &&
          notificationSource.includes('window.clearTimeout(notificationTimerRef.current);') &&
          !notificationSource.includes('setNotification(msg);\n    setTimeout(() => {'),
        '维保日历通知应统一清理旧定时器，避免连续部署/调期/权限提醒时旧定时器提前清掉新提示'
      );
      assert(
        calendarSource.includes('const todayDateString = getLocalDateString();') &&
          calendarSource.includes("const [todayYear, todayMonthText, todayDayText] = todayDateString.split('-');") &&
          calendarSource.includes('setCurrentYear(todayYearNumber);') &&
          calendarSource.includes('setCurrentMonth(todayMonthIndex);') &&
          calendarSource.includes('cell.year === todayYearNumber && cell.month === todayMonthIndex && cell.day === todayDayNumber') &&
          !calendarSource.includes('setCurrentYear(2026);') &&
          !calendarSource.includes('const isToday = cell.year === 2026'),
        '维保日历“本月”和“今天”标记应使用本地当前日期，不能停留在演示硬编码日期'
      );
      assert(
        calendarSource.includes('{canManageSchedule ? (') &&
          calendarSource.includes('在此日期部署新任务') &&
          calendarSource.includes('临床只读：仅查看当天本科室排程'),
        '日期弹窗应仅向工程师显示部署入口，临床端显示只读提示'
      );
      assert(
        calendarSource.includes('setIsDeployMode(false);') &&
          calendarSource.includes('setActiveDatePopup(null);') &&
          calendarSource.includes('isSameDepartment(prev.equipment.dept, currentUser.department || currentUser.dept)'),
        '角色切换到临床日历时应清理工程师部署态和跨科室选中事件'
      );
      assert(
        calendarSource.includes('currentUser.role, currentUser.department, currentUser.dept') &&
          calendarSource.includes('setCurrentEngineer') &&
          calendarSource.includes('setSelectedEvent(prev =>'),
        '日历事件列表与已选事件应随当前登录角色和科室变化重新计算，避免临床切换后残留旧科室日程'
      );
      assert(
        calendarSource.includes("const selectedEventId = selectedEvent?.id || '';") &&
          calendarSource.includes('const latestSelectedEvent = allEvents.find(evt => evt.id === selectedEventId);') &&
          calendarSource.includes('if (!prev || prev.id !== selectedEventId) return prev;') &&
          calendarSource.includes('if (!latestSelectedEvent) return null;') &&
          calendarSource.includes('return latestSelectedEvent;') &&
          calendarSource.includes('}, [allEvents, selectedEventId]);'),
        '维保日历详情面板应跟随当前筛选后的事件列表同步，事件被角色/科室/筛选/设备更新移除时应自动关闭'
      );
      assert(
        calendarSource.includes('const selectedEquipment = filteredEquipmentsForDeploy.find(eq => eq.id === deployEquipmentId);') &&
          calendarSource.includes('当前筛选条件下无法部署到该设备') &&
          calendarSource.includes("const submittedDate = String(new FormData(form).get('deployDate') || deployDate).trim();") &&
          calendarSource.includes('nextMaintenanceDate: submittedDate') &&
          calendarSource.includes('nextCalibrationDate: submittedDate') &&
          calendarSource.includes('date: submittedDate') &&
          calendarSource.includes('计划执行日期为 ${submittedDate}') &&
          calendarSource.includes('const filteredDeployEquipmentIds = filteredEquipmentsForDeploy.map(eq => eq.id).join') &&
          calendarSource.includes("if (!isDeployMode) return;") &&
          calendarSource.includes('!filteredEquipmentsForDeploy.some(eq => eq.id === deployEquipmentId)') &&
          calendarSource.includes("setDeployEquipmentId(filteredEquipmentsForDeploy[0]?.id || '');"),
        '工程师部署表单应读取表单当前日期值、随设备搜索筛选校正选中设备，并阻止向隐藏设备下发工单'
      );
      assert(
        calendarSource.includes('<option value="" disabled className="text-slate-400 italic">未找到相匹配的受试设备</option>') &&
          calendarSource.includes('disabled={!deployEquipmentId || filteredEquipmentsForDeploy.length === 0}') &&
          calendarSource.includes('id="maintenance-deploy-search"') &&
          calendarSource.includes('id="maintenance-deploy-equipment"') &&
          calendarSource.includes('id="maintenance-deploy-date"') &&
          calendarSource.includes('id="maintenance-deploy-notes"') &&
          calendarSource.includes('id="btn-maintenance-submit-deploy"'),
        '工程师部署表单无可见设备时应显示空值提示、禁用提交按钮，并暴露稳定控件 id 便于回归验证'
      );
      assert(
        calendarSource.includes('const targetEventId = selectedEvent.id;') &&
          calendarSource.includes("const submittedDate = String(new FormData(form).get('newScheduleDate') || newScheduleDate).trim();") &&
          calendarSource.includes('const targetDate = submittedDate;') &&
          calendarSource.includes('setNewScheduleDate(submittedDate);') &&
          calendarSource.includes('id="maintenance-reschedule-date"') &&
          calendarSource.includes('id="btn-maintenance-confirm-reschedule"') &&
          calendarSource.includes('if (prev.id !== targetEventId) return prev;') &&
          calendarSource.includes('date: targetDate'),
        '维保调期应读取表单当前日期值，并且异步完成回写只能更新原始选中的日程，避免用户切换日程后误改右侧详情面板'
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