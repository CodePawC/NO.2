import { MedicalEquipment } from '../types';

// Preset default equipment data to seed localStorage
export const DEFAULT_EQUIPMENT: MedicalEquipment[] = [
  {
    id: 'eq-006',
    deviceName: '德尔格呼吸机 Evita',
    model: 'Drager Evita V500',
    sn: 'EQ-DRG-8812',
    manufacturer: '德尔格医疗 (Drager)',
    category: '急救生命支持',
    dept: '急诊ICU',
    status: '正常运行',
    riskLevel: '高',
    purchaseDate: '2022-03-18',
    purchaseCost: 268000,
    maintenanceCycleDays: 90,
    lastMaintenanceDate: '2026-06-28',
    nextMaintenanceDate: '2026-09-26',
    calibrationRequired: true,
    lastCalibrationDate: '2026-03-12',
    nextCalibrationDate: '2027-03-11',
    attachments: [
      { id: 'a6', name: 'Evita-V500操作维护手册.pdf', type: 'manual', size: '9.6 MB', uploadDate: '2022-03-19' }
    ],
    maintenanceLogs: [
      { id: 'm7', type: '维修', date: '2026-06-28', technician: '张工 (高级工程师)', description: '更换氧电池并完成服务模式自检校准，通气测试平稳。', cost: 150, status: '已完成', workOrderNo: 'TKT-2026062801', faultPhenomenon: '氧浓度传感器失效', verifyPerson: '周护士' }
    ],
    calibrationLogs: [
      { id: 'c5', date: '2026-03-12', agency: '市计量测试院', certificateNo: 'VENT-2026-0312', result: '合格', validUntil: '2027-03-11' }
    ],
    registrationNo: '国械注进20173542108',
    registrationValidUntil: '2027-09-30',
    deviceClass: 'III类',
    productionLicenseNo: '国械生产许20170031号',
    photoUrl: 'https://images.unsplash.com/photo-1587351021759-3e566b3db6f1?auto=format&fit=crop&w=600&h=450&q=80'
  },
  {
    id: 'eq-001',
    deviceName: '磁共振成像系统 (MRI)',
    model: 'Siemens Magnetom Vida 3.0T',
    sn: 'MR-SI-90812',
    manufacturer: '西门子医疗 (Siemens Healthineers)',
    category: '影像诊断',
    dept: '放射科',
    status: '正常运行',
    riskLevel: '高',
    purchaseDate: '2023-05-12',
    purchaseCost: 12800000,
    maintenanceCycleDays: 180,
    lastMaintenanceDate: '2026-01-15',
    nextMaintenanceDate: '2026-07-14',
    calibrationRequired: true,
    lastCalibrationDate: '2025-11-20',
    nextCalibrationDate: '2026-11-19',
    attachments: [
      { id: 'a1', name: '磁共振操作手册.pdf', type: 'manual', size: '12.4 MB', uploadDate: '2023-05-13' },
      { id: 'a2', name: '入库发票-F48291.pdf', type: 'invoice', size: '1.2 MB', uploadDate: '2023-05-12' }
    ],
    maintenanceLogs: [
      { id: 'm1', type: '保养', date: '2026-01-15', technician: '张建国', description: '高低温超导液冷检查，射频线圈调谐校准。', cost: 12000, status: '已完成' },
      { id: 'm2', type: '维修', date: '2025-08-10', technician: '西门子原厂工程师', description: '更换床面板传动皮带，消除传动异响。', cost: 8500, status: '已完成' }
    ],
    calibrationLogs: [
      { id: 'c1', date: '2025-11-20', agency: '省计量科学研究院', certificateNo: 'JJG-2025-MR-0482', result: '合格', validUntil: '2026-11-19' }
    ],
    registrationNo: '国械注进20183061611',
    registrationValidUntil: '2028-04-15',
    deviceClass: 'III类',
    productionLicenseNo: '国械生产许20150012号',
    photoUrl: 'https://images.unsplash.com/photo-1516549655169-df83a0774514?auto=format&fit=crop&w=600&h=450&q=80'
  },
  {
    id: 'eq-007',
    deviceName: '联影双板 DR (数字化X射线摄影系统)',
    model: 'uDR 780i Pro',
    sn: 'EQ-UIH-2026',
    manufacturer: '联影医疗 (United Imaging Healthcare)',
    category: '影像诊断',
    dept: '放射科',
    status: '正常运行',
    riskLevel: '高',
    purchaseDate: '2026-06-20',
    purchaseCost: 2680000,
    maintenanceCycleDays: 180,
    lastMaintenanceDate: '2026-06-28',
    nextMaintenanceDate: '2026-12-25',
    calibrationRequired: true,
    lastCalibrationDate: '2026-06-28',
    nextCalibrationDate: '2027-06-27',
    attachments: [
      { id: 'a7', name: '联影双板DR开箱验收清单.pdf', type: 'certificate', size: '2.6 MB', uploadDate: '2026-06-28' }
    ],
    maintenanceLogs: [
      { id: 'm8', type: '保养', date: '2026-06-28', technician: '李管理员 (资产组)', description: '开箱核对配置、球管和平板探测器序列号，等待联合安装验收。', cost: 0, status: '进行中', workOrderNo: 'TKT-2026062802', faultPhenomenon: '新设备到货开箱验收' }
    ],
    calibrationLogs: [
      { id: 'c6', date: '2026-06-28', agency: '厂家现场验收', certificateNo: 'UIH-DR-ACCEPT-20260628', result: '合格', validUntil: '2027-06-27' }
    ],
    registrationNo: '国械注准20223060988',
    registrationValidUntil: '2029-12-31',
    deviceClass: 'III类',
    productionLicenseNo: '沪食药监械生产许20150005号',
    photoUrl: 'https://images.unsplash.com/photo-1519494026892-80bbd2d6fd0d?auto=format&fit=crop&w=600&h=450&q=80'
  },
  {
    id: 'eq-002',
    deviceName: '多参数监护仪',
    model: 'Mindray BeneVision N17',
    sn: 'MN-MI-883012',
    manufacturer: '迈瑞医疗 (Mindray)',
    category: '急救生命支持',
    dept: '重症医学科 (ICU)',
    status: '正常运行',
    riskLevel: '中',
    purchaseDate: '2024-02-18',
    purchaseCost: 45000,
    maintenanceCycleDays: 90,
    lastMaintenanceDate: '2026-05-10',
    nextMaintenanceDate: '2026-08-08',
    calibrationRequired: true,
    lastCalibrationDate: '2026-02-15',
    nextCalibrationDate: '2027-02-14',
    attachments: [
      { id: 'a3', name: 'N17使用手册_V1.1.pdf', type: 'manual', size: '4.8 MB', uploadDate: '2024-02-18' }
    ],
    maintenanceLogs: [
      { id: 'm3', type: '保养', date: '2026-05-10', technician: '李工', description: '清洁机壳、测量传感器电缆、电池充放电效能测试。', cost: 200, status: '已完成' }
    ],
    calibrationLogs: [
      { id: 'c2', date: '2026-02-15', agency: '市医疗器械检测所', certificateNo: 'CAL-2026-PM-904', result: '合格', validUntil: '2027-02-14' }
    ],
    registrationNo: '国械注准20203070415',
    registrationValidUntil: '2029-10-12',
    deviceClass: 'II类',
    productionLicenseNo: '粤食药监械生产许20100155号',
    photoUrl: 'https://images.unsplash.com/photo-1576091160550-2173dba999ef?auto=format&fit=crop&w=600&h=450&q=80'
  },
  {
    id: 'eq-003',
    deviceName: '医用超声诊断仪',
    model: 'Philips Epiq Elite',
    sn: 'PH-UL-730129',
    manufacturer: '飞利浦医疗 (Philips Healthcare)',
    category: '影像诊断',
    dept: '超声科',
    status: '故障维修',
    riskLevel: '中',
    purchaseDate: '2022-10-15',
    purchaseCost: 1550000,
    maintenanceCycleDays: 180,
    lastMaintenanceDate: '2025-12-05',
    nextMaintenanceDate: '2026-06-03',
    calibrationRequired: false,
    attachments: [],
    maintenanceLogs: [
      { id: 'm4', type: '维修', date: '2026-06-25', technician: '飞利浦售后工程师', description: '探头晶片老化导致图像噪点大，目前已向原厂申领替换探头，等待到货中。', cost: 0, status: '进行中' }
    ],
    calibrationLogs: [],
    registrationNo: '国械注进20193060124',
    registrationValidUntil: '2027-02-28',
    deviceClass: 'III类',
    productionLicenseNo: '国械生产许20150018号',
    photoUrl: 'https://images.unsplash.com/photo-1581594693702-fbdc51b2763b?auto=format&fit=crop&w=600&h=450&q=80'
  },
  {
    id: 'eq-004',
    deviceName: '无创呼吸机',
    model: 'ResMed Stellar 150',
    sn: 'RM-VE-229104',
    manufacturer: '瑞思迈 (ResMed)',
    category: '急救生命支持',
    dept: '呼吸内科',
    status: '正常运行',
    riskLevel: '高',
    purchaseDate: '2023-11-01',
    purchaseCost: 88000,
    maintenanceCycleDays: 90,
    lastMaintenanceDate: '2026-04-20',
    nextMaintenanceDate: '2026-07-19',
    calibrationRequired: true,
    lastCalibrationDate: '2025-10-12',
    nextCalibrationDate: '2026-10-11',
    attachments: [],
    maintenanceLogs: [
      { id: 'm5', type: '保养', date: '2026-04-20', technician: '刘工程师', description: '更换吸气过滤网，进行压力校准 and 氧浓度传感器校准。', cost: 450, status: '已完成' }
    ],
    calibrationLogs: [
      { id: 'c3', date: '2025-10-12', agency: '市计量测试院', certificateNo: 'VAL-2025-VT-129', result: '合格', validUntil: '2026-10-11' }
    ],
    registrationNo: '国械注进20163082512',
    registrationValidUntil: '2026-06-30', // 已过期，便于展示预警
    deviceClass: 'II类',
    productionLicenseNo: '国械生产许20160029号',
    photoUrl: 'https://images.unsplash.com/photo-1584515979956-d9f6e5d09982?auto=format&fit=crop&w=600&h=450&q=80'
  },
  {
    id: 'eq-008',
    deviceName: '奥林巴斯电子胃镜 CV-290',
    model: 'Olympus CV-290',
    sn: 'EQ-OLY-0092',
    manufacturer: '奥林巴斯 (Olympus)',
    category: '其他',
    dept: '胃镜室',
    status: '故障维修',
    riskLevel: '高',
    purchaseDate: '2021-09-10',
    purchaseCost: 860000,
    maintenanceCycleDays: 120,
    lastMaintenanceDate: '2026-02-18',
    nextMaintenanceDate: '2026-06-18',
    calibrationRequired: false,
    attachments: [
      { id: 'a8', name: 'CV-290电子胃镜维护说明.pdf', type: 'manual', size: '6.1 MB', uploadDate: '2021-09-11' }
    ],
    maintenanceLogs: [
      { id: 'm9', type: '维修', date: '2026-06-28', technician: '赵工 (工程师)', description: '镜体蛇管咬口处漏水，已打包外送奥林巴斯授权售后检测报价。', cost: 0, status: '进行中', workOrderNo: 'TKT-2026062803', faultPhenomenon: '胃镜插入部蛇管漏水' }
    ],
    calibrationLogs: [],
    registrationNo: '国械注进20163062244',
    registrationValidUntil: '2027-08-31',
    deviceClass: 'II类',
    productionLicenseNo: '国械生产许20140018号',
    photoUrl: 'https://images.unsplash.com/photo-1581595219315-a187dd40c322?auto=format&fit=crop&w=600&h=450&q=80'
  },
  {
    id: 'eq-005',
    deviceName: '全自动生化分析仪',
    model: 'Roche Cobas c501',
    sn: 'RO-CH-110291',
    manufacturer: '罗氏诊断 (Roche Diagnostics)',
    category: '检验分析',
    dept: '检验科',
    status: '正常运行',
    riskLevel: '高',
    purchaseDate: '2021-08-10',
    purchaseCost: 2100000,
    maintenanceCycleDays: 90,
    lastMaintenanceDate: '2026-05-18',
    nextMaintenanceDate: '2026-08-16',
    calibrationRequired: true,
    lastCalibrationDate: '2025-08-15',
    nextCalibrationDate: '2026-08-14',
    attachments: [],
    maintenanceLogs: [
      { id: 'm6', type: '保养', date: '2026-05-18', technician: '罗氏原厂李工', description: '反应盘比色杯清洗及透光度校准，加样针疏通及清洗。', cost: 3500, status: '已完成' }
    ],
    calibrationLogs: [
      { id: 'c4', date: '2025-08-15', agency: '省计量测试所', certificateNo: 'CHE-2025-RC-101', result: '合格', validUntil: '2026-08-14' }
    ],
    registrationNo: '国械注进20173220190',
    registrationValidUntil: '2028-11-18',
    deviceClass: 'III类',
    productionLicenseNo: '国械生产许20150022号',
    photoUrl: 'https://images.unsplash.com/photo-1579165466511-71e5b8aa7789?auto=format&fit=crop&w=600&h=450&q=80'
  }
];
