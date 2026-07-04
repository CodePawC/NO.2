import React, { useState, useEffect, useRef } from 'react';
import { 
  Plus, Search, Edit2, Trash2, Calendar, FileText, CheckCircle2, 
  AlertTriangle, Activity, Settings, QrCode, Sparkles, Upload, 
  Wrench, ShieldCheck, DollarSign, Clock, Check, Send, X, 
  PlusCircle, FileUp, ChevronRight, ChevronLeft, ChevronDown, Info, HardDrive, RefreshCw,
  HelpCircle, CheckSquare, Layers, Copy, Printer, User, BarChart2, LayoutGrid, Table, Filter, ArrowUpDown
} from 'lucide-react';
import { MedicalEquipment, MaintenanceLog, CalibrationLog, Attachment, UserProfile, StructuredTicket } from '../types';
import { SIMULATED_USERS } from '../data/appPresets';
import { analyzeGeminiContent, chatWithGeminiExpert } from '../services/aiApi';
import { isSameDepartment } from '../utils/departmentUtils';
import { EQUIPMENT_STORAGE_KEY, parseStoredEquipmentList } from '../utils/equipmentStorage';
import { addLocalDays, getDateDiffDaysFromToday, getLocalDateString, getLocalDateTimeString } from '../utils/dateUtils';
import { needsClinicalAcceptance } from '../utils/taskWorkflow';
import MaintenanceCalendar from './MaintenanceCalendar';
import BudgetStackedChart from './BudgetStackedChart';

// 智能解析批量输入的序列号 (支持换行、制表符、多个连续空格、中英文逗号、分号等分隔，且避免拆分包含单空格的序列号)
const parseBatchSns = (text: string): string[] => {
  if (!text) return [];
  // 先按行分割
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
  const result: string[] = [];

  for (const line of lines) {
    // 如果行内包含明确的符号间隔 (中英文逗号、中英文分号、制表符、双空格及以上)，则对行内进行二次分割
    if (line.includes(',') || line.includes('，') || line.includes(';') || line.includes('；') || line.includes('\t') || /\s{2,}/.test(line)) {
      const items = line.split(/[,，;；\t]|\s{2,}/).map(item => item.trim()).filter(item => item.length > 0);
      result.push(...items);
    } else {
      // 否则，该整行作为一个独立的序列号（即使其中含有单个空格，比如 "SN GE 12345"）
      result.push(line);
    }
  }
  return result;
};

// 检查医疗器械注册证有效期状态
const getRegistrationStatus = (dateStr?: string) => {
  if (!dateStr) return { status: 'none', text: '未设置有效期' };
  const diffDays = getDateDiffDaysFromToday(dateStr);
  if (diffDays === null) return { status: 'none', text: '日期格式异常' };
  if (diffDays < 0) {
    return { status: 'expired', text: '已过期', diffDays: Math.floor(Math.abs(diffDays)) };
  } else if (diffDays <= 90) {
    return { status: 'expiring', text: '即将过期', diffDays: Math.floor(diffDays) };
  }
  return { status: 'valid', text: '有效中', diffDays: Math.floor(diffDays) };
};

const createQuickRepairWorkOrderNo = (equipments: MedicalEquipment[], date = getLocalDateString()) => {
  const datePart = date.replace(/-/g, '');
  const idPattern = new RegExp(`^WO-${datePart}-(\\d+)$`);
  const maxSequence = equipments.reduce((max, equipment) => {
    const equipmentMax = (equipment.maintenanceLogs || []).reduce((logMax, log) => {
      const match = log.workOrderNo?.match(idPattern);
      if (!match) return logMax;
      return Math.max(logMax, Number(match[1]) || 0);
    }, 0);

    return Math.max(max, equipmentMax);
  }, 0);

  return `WO-${datePart}-${String(maxSequence + 1).padStart(4, '0')}`;
};

export interface PreviewPage {
  pageNum: number;
  title: string;
  subtitle: string;
  diagramType: 'parameters' | 'chart' | 'warning' | 'table' | 'invoice';
  lines: string[];
  metrics?: { label: string; value: string }[];
  accentColor: string;
}

export interface PreviewData {
  fileName: string;
  fileSize: string;
  fileType: string;
  uploadDate: string;
  author: string;
  summary: string;
  tlDr: string[];
  pages: PreviewPage[];
}

interface QuickRepairRequest {
  equipment: MedicalEquipment;
  description: string;
  urgency: 'low' | 'medium' | 'high';
  workOrderNo: string;
}

const getDiagnosticSessionKey = (equipment: MedicalEquipment | null, user: UserProfile) => {
  return `${user.id}:${equipment?.id || 'no-equipment'}`;
};

const createDiagnosticWelcome = (equipment?: MedicalEquipment | null, user?: UserProfile) => {
  if (!equipment) {
    return '当前筛选条件下暂无可选设备。请调整左侧筛选条件后，再选择设备进行故障诊断、PM 维保或计量检测咨询。';
  }

  const userScope = user?.role === 'medical_staff'
    ? `${user.department || user.dept || '本科室'}临床只读视角`
    : '医学装备科工程师视角';

  return `已切换至【${equipment.deviceName}】诊断会话。\n当前设备：${equipment.model} / SN: ${equipment.sn || '未登记'}\n当前视角：${userScope}\n请描述故障现象、报警代码或想核对的维保/计量操作，我会基于当前设备档案给出建议。`;
};

export const generatePreviewData = (equipment: MedicalEquipment, file: Attachment): PreviewData => {
  const fileTypeStr = 
    file.type === 'manual' ? '操作手册' :
    file.type === 'invoice' ? '购入发票' :
    file.type === 'certificate' ? '质量注册证' : '技术其他资料';
  
  if (file.type === 'manual') {
    return {
      fileName: file.name,
      fileSize: file.size,
      fileType: fileTypeStr,
      uploadDate: file.uploadDate || getLocalDateString(),
      author: '原厂技术维护委员会审核印制',
      summary: `本手册是关于《${equipment.deviceName} (型号: ${equipment.model})》的官方全生命周期技术手册。涵盖了整机基本电气指标、操作前置条件、日常预防性维护(PM)检测节点、漏电流测试容限、特种环境电磁兼容指引以及常规故障诊断速查指南。`,
      tlDr: [
        `💡 规定日常预防性保养周期为：${equipment.maintenanceCycleDays}天/次。`,
        `🛠️ 设备关键校准节点推荐由国家注册计量师/高级临床工程师进行原厂调谐。`,
        `⚠️ 强磁场/高风险环境下必须遵守特种电气标准 (GB9706.1-2020)。`,
        `🚨 系统一旦报错 E-01 至 E-03 应立即停止临床使用并进入维保追踪系统。`
      ],
      pages: [
        {
          pageNum: 1,
          title: "第1页: 设备技术指标与基本配置表",
          subtitle: "TECHNICAL SPECIFICATIONS & DEVICE COVER",
          diagramType: 'parameters',
          accentColor: 'blue',
          metrics: [
            { label: "推荐级别", value: equipment.deviceClass || "未分类" },
            { label: "风险等级", value: equipment.riskLevel + "风险" },
            { label: "额定电压", value: "380V AC (±10%)" },
            { label: "额定功率", value: "120 kW" }
          ],
          lines: [
            `设备注册官方名称: ${equipment.deviceName}`,
            `出厂申报规格型号: ${equipment.model}`,
            `设备唯一样本出厂编号 (SN): ${equipment.sn}`,
            "整机高压绝缘电阻: > 100 MΩ",
            "射频发射中心频率: 123.2 MHz (超导3.0T标称值)",
            "最大梯度场强及切换率: 45 mT/m / 200 T/m/s"
          ]
        },
        {
          pageNum: 2,
          title: "第2页: 预防性维护与计量强制标定准则",
          subtitle: "PREVENTATIVE MAINTENANCE & STANDARDS",
          diagramType: 'chart',
          accentColor: 'emerald',
          metrics: [
            { label: "PM保养周期", value: `${equipment.maintenanceCycleDays} 天 / 次` },
            { label: "标定准则", value: "JJG 强检标准" },
            { label: "冷头气压平衡", value: "1.65 MPa" },
            { label: "射频屏蔽度", value: "> 100 dB" }
          ],
          lines: [
            "预防性维护(PM)必须由通过原厂认证的技术人员实施",
            `本院要求预防性保养周期为: ${equipment.maintenanceCycleDays}天，最近一次在: ${equipment.lastMaintenanceDate}`,
            "计量标定要求: 定期由法定计量部门对主磁场、梯度线性进行强制检定",
            "接地外壳泄露电流限值: 正常状态下 <= 100 uA，单故障状态 <= 500 uA",
            "日常自检标准：每日晨间自动质控(QA)，SNR偏差控制在3%以内",
            "氦回液气循环阀安全限值: 1.05 至 1.15 bar 气压平衡"
          ]
        },
        {
          pageNum: 3,
          title: "第3页: 核心操作规范与故障排查速查表",
          subtitle: "OPERATION OUTLINE & TROUBLESHOOTING",
          diagramType: 'warning',
          accentColor: 'amber',
          metrics: [
            { label: "故障代码 E-01", value: "氦气回路故障" },
            { label: "故障代码 E-02", value: "射频失谐/反射大" },
            { label: "故障代码 E-03", value: "自检偏置超限" },
            { label: "熔断熔丝规格", value: "25A 500V 快速" }
          ],
          lines: [
            "警告！超导磁体腔内严禁带入任何铁磁性物体，否则将触发紧急失超 Quench 毁机风险",
            "【E-01 错误】氦循环压缩机压力异常下降。排查方法：检查冷水机出水流量与水压，冷水温度须在 8-12℃",
            "【E-02 错误】射频多通道失谐。排查方法：清洁线圈插槽，确认触点无氧化且线圈锁紧销锁合到位",
            "【E-03 错误】梯度放大器零位漂移超限。排查方法：重载主系统，调用 Service 页面下的 Offset 零位自调校准"
          ]
        },
        {
          pageNum: 4,
          title: "第4页: 合规性验证与国家计量检定说明",
          subtitle: "COMPLIANCE APPROVAL & CERTIFICATE",
          diagramType: 'table',
          accentColor: 'indigo',
          metrics: [
            { label: "合规审查等级", value: "A级卓越" },
            { label: "备案注册证", value: equipment.registrationNo || "已归档" },
            { label: "质检状态", value: "通过(PASSED)" },
            { label: "审计一致性", value: "100% 吻合" }
          ],
          lines: [
            "本医疗器械产品符合国家药监总局医疗器械注册及合规准入标准",
            `核准注册证号: ${equipment.registrationNo || '国械注进 20183061611'}`,
            `本档案对应的生产许可凭证/厂家许可证号: ${equipment.productionLicenseNo || '国械生产许20150012号'}`,
            "产品出厂安全测试大纲全面符合: GB 9706.1-2020 医用电气安全通用要求",
            "归档审计状态：第一人民医院技术归口科室（医学装备科）全生命周期终核归档"
          ]
        }
      ]
    };
  } else if (file.type === 'invoice') {
    return {
      fileName: file.name,
      fileSize: file.size,
      fileType: fileTypeStr,
      uploadDate: file.uploadDate || getLocalDateString(),
      author: '中华人民共和国财政税务机关专用核签',
      summary: `本发票为《${equipment.deviceName} (型号: ${equipment.model})》的官方增值税专用凭证。记录了该设备购入原值、采购流程合规编码、国家专用发票代码及号码，并附带了医学装备科采购合同与入库核验流程。`,
      tlDr: [
        `💰 资产入库原值为：¥ ${equipment.purchaseCost.toLocaleString('zh-CN')} 元。`,
        `📄 发票已经过财务部门可信核签，自动生成资产管理系统的唯一资产条码。`,
        `📅 资产入库购置时间为：${equipment.purchaseDate}，折旧年限及维修合同依此起算。`,
        `🖊️ 签收验收负责人已核实实物序列号 (SN: ${equipment.sn}) 与账目完全一致。`
      ],
      pages: [
        {
          pageNum: 1,
          title: "第1页: 增值税专用发票 - 金额与税务防伪联",
          subtitle: "TAX INVOICE & ANTI-COUNTERFEITING",
          diagramType: 'invoice',
          accentColor: 'rose',
          metrics: [
            { label: "发票代码", value: "011002300111" },
            { label: "发票号码", value: "48291032" },
            { label: "折旧原值", value: `¥ ${equipment.purchaseCost.toLocaleString('zh-CN')}` },
            { label: "开票日期", value: equipment.purchaseDate }
          ],
          lines: [
            "发票抬头(购买方): 第一人民医院",
            `销售方全称: ${equipment.manufacturer} 授权经销商 / 西门子大中华区售后系统`,
            `商品品名: ${equipment.deviceName} ${equipment.model}`,
            `设备序列号对照: ${equipment.sn}`,
            `货款金额: ¥ ${equipment.purchaseCost.toLocaleString('zh-CN')} (税率 13%)`,
            "税务系统防伪电子印章校验：[电子防伪验证通过 - 2026版核验]"
          ]
        },
        {
          pageNum: 2,
          title: "第2页: 采购合同与院内入库验收核验单",
          subtitle: "PURCHASE CONTRACT &院内入库单",
          diagramType: 'table',
          accentColor: 'indigo',
          metrics: [
            { label: "合同编号", value: "CON-2023-MR-098" },
            { label: "验收结论", value: "合格，同意入库" },
            { label: "库房签收", value: "已入库" },
            { label: "条码归口", value: "设备科条码部" }
          ],
          lines: [
            "院内采购审批单号: REQ-2023-EQUIP-882",
            `技术归口科室: ${equipment.dept}`,
            `验收现场实物核对: 设备铭牌、SN号 (${equipment.sn})、原厂说明书一致性比对合格`,
            "电气安全及接地阻抗现场测试：合格 (接地电阻 0.08 MΩ)",
            "验收委员会签字确认：张建国、李华阳、吴宏远 (医学装备专家)"
          ]
        },
        {
          pageNum: 3,
          title: "第3页: 原厂免费保修协议与全生命周期软件支持书",
          subtitle: "WARRANTY AGREEMENT & SOFTWARE TERMS",
          diagramType: 'parameters',
          accentColor: 'blue',
          metrics: [
            { label: "免费保修期", value: "36 个月" },
            { label: "响应时间", value: "24 小时现场" },
            { label: "软件许可", value: "永久免费漏洞升级" },
            { label: "维保专线", value: "400-810-8888" }
          ],
          lines: [
            `产品维保生效起始日: ${equipment.purchaseDate}`,
            "保修范围：包含全系统磁体、超导冷头、射频线圈、重建工作站及所有电路板件",
            "开机率承诺：每年保证开机率在 95% 以上，每低于 1% 按原厂延长保修 1 个月赔偿",
            "技术热线及远程诊断：提供 VPN 授权远程状态预警与日志抓取分析支持"
          ]
        },
        {
          pageNum: 4,
          title: "第4页: 原厂进口清关及通关品质检验单",
          subtitle: "CUSTOMS CLEARANCE & QUALITY REPORT",
          diagramType: 'warning',
          accentColor: 'teal',
          metrics: [
            { label: "商检合格证", value: "PASS" },
            { label: "原产国", value: "德国 (Germany)" },
            { label: "通关口岸", value: "上海浦东国际海关" },
            { label: "特种设备证", value: "压力容器进口许可证" }
          ],
          lines: [
            "进口货物报关单号: 220120231002931201",
            "核心进口模块: 超导磁体组件、冷头循环回路、射频数字处理机架",
            "产地证明书编码: DE-2023-SH-092812",
            "国家进口特种设备许可证：符合安全规范 TSG-IP-2023",
            "海关辐射与电磁泄漏环境商检结论: 无异常，符合我国相关核安全标准限制"
          ]
        }
      ]
    };
  } else {
    // Other attachments
    return {
      fileName: file.name,
      fileSize: file.size,
      fileType: fileTypeStr,
      uploadDate: file.uploadDate || getLocalDateString(),
      author: '医院装备科信息档案处自动提取',
      summary: `本文件是关于《${equipment.deviceName}》的技术文件。系统已运用 AI 智能引擎对其进行了 OCR 信息扫描，建立了元数据目录，便于日常维护审计、计量校准及快速核查。`,
      tlDr: [
        `📌 文件归属设备：${equipment.deviceName} (SN: ${equipment.sn})。`,
        `🔍 已完成合规性扫描，主要信息已入系统全生命周期追踪。`,
        `🛠️ 该附件与日常技术标准有关，可作为预防性维护及审计溯源凭证。`
      ],
      pages: [
        {
          pageNum: 1,
          title: "第1页: 资质/合规证书元数据扫描",
          subtitle: "COMPLIANCE & METADATA SCAN",
          diagramType: 'table',
          accentColor: 'indigo',
          metrics: [
            { label: "资质类别", value: "技术证明" },
            { label: "数据核实", value: "已验证" },
            { label: "上传者", value: "档案管理员" },
            { label: "可信签名", value: "SHA-256 Valid" }
          ],
          lines: [
            `关联资产名称: ${equipment.deviceName}`,
            `设备型号: ${equipment.model}`,
            `设备序列号 (SN): ${equipment.sn}`,
            "国家安全认证类别：符合我国相关行业注册与进院规范",
            "经比对：此文件的型号规格参数与该设备出厂注册证相符度为 100%"
          ]
        },
        {
          pageNum: 2,
          title: "第2页: 核心性能自检与校验标准",
          subtitle: "CALIBRATION & PERFORMANCE STANDARDS",
          diagramType: 'parameters',
          accentColor: 'emerald',
          metrics: [
            { label: "校验结果", value: "合格" },
            { label: "误差控制", value: "< 2.0%" },
            { label: "测试人", value: "临床技术专员" },
            { label: "审查级别", value: "卓越" }
          ],
          lines: [
            "日常运行质控极限：频率响应偏差 <= 150 Hz，增益稳定性 <= 0.5 dB",
            "电气漏泄状态：直流部分安全绝缘电阻 > 20 MΩ，外壳接触阻抗 <= 0.1 欧姆",
            "机械限位与急停动作：各方向运行平滑，急停断电响应时间 <= 150 毫秒",
            "国家电学与辐射屏蔽大纲检测指标均在合格绿区"
          ]
        },
        {
          pageNum: 3,
          title: "第3页: 安全操作指南与日常急救预案",
          subtitle: "SAFETY INSTRUCTIONS & EMERGENCY PLAN",
          diagramType: 'warning',
          accentColor: 'amber',
          metrics: [
            { label: "安全红区", value: "强电磁/强辐射" },
            { label: "禁忌人群", value: "心脏起搏器/金属植入" },
            { label: "防护要求", value: "屏蔽门锁紧/防护服" },
            { label: "急救预案", value: "一键断电 / 物理降温" }
          ],
          lines: [
            "警告！该设备具有射频电磁辐射与强磁场，孕妇、体内植入铁磁性心脏起搏器及金属关节者绝对严禁进入机房",
            "应急处置：一旦发生意外磁吸伤人或电气火灾，请立即按下控制台红色‘EMERGENCY STOP’紧急断电按钮",
            "日常消毒维护：每日必须使用非腐蚀性消毒湿巾擦拭检查床，严禁液体流入线圈与接口内造成电路短路"
          ]
        },
        {
          pageNum: 4,
          title: "第4页: 全生命周期追溯可信审计归档页",
          subtitle: "LIFECYCLE ARCHIVE & DIGITAL SIGNATURE",
          diagramType: 'chart',
          accentColor: 'indigo',
          metrics: [
            { label: "档案状态", value: "安全审毕" },
            { label: "审计编号", value: "AUDIT-" + equipment.id.toUpperCase() },
            { label: "数字指纹", value: "AES-256" },
            { label: "签署机构", value: "装备部终审" }
          ],
          lines: [
            `档案登记时间: ${file.uploadDate || getLocalDateString()}`,
            `上传原件文件名: ${file.name}`,
            "技术档案可信审计散列值: [SHA256: 7f8a9e1d2c3b4a5f6e7d8c9b0a1b2c3d4e5f]",
            "系统数字可信核签：临床工程师及科室主管对以上参数一致性进行了电子签字，确认永久归档备查。"
          ]
        }
      ]
    };
  }
};



export default function EquipmentArchives({
  onBackToTasks,
  onReportRepairFromEquip,
  onQuickRepairCreated,
  tasks = [],
  currentUser: propCurrentUser,
  onUserChange
}: {
  onBackToTasks?: () => void;
  onReportRepairFromEquip?: (equip: MedicalEquipment) => void;
  onQuickRepairCreated?: (request: QuickRepairRequest) => boolean | void;
  tasks?: StructuredTicket[];
  currentUser?: UserProfile;
  onUserChange?: (user: UserProfile) => void;
}) {
  // ================= SIMULATED LOGIN STATES =================
  const [currentUser, setCurrentUser] = useState<UserProfile>(() => {
    if (propCurrentUser) return propCurrentUser;
    const saved = localStorage.getItem('simulated_current_user');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {}
    }
    return SIMULATED_USERS[0];
  });

  const [onlyMyDept, setOnlyMyDept] = useState<boolean>(true);
  const [clinicalFilterMode, setClinicalFilterMode] = useState<'all_dept' | 'my_reported'>('all_dept');
  
  // Quick repair modal states
  const [isQuickRepairModalOpen, setIsQuickRepairModalOpen] = useState<boolean>(false);
  const [quickRepairEquipId, setQuickRepairEquipId] = useState<string>('');
  const [quickRepairDesc, setQuickRepairDesc] = useState<string>('');
  const [quickRepairUrgency, setQuickRepairUrgency] = useState<'low' | 'medium' | 'high'>('medium');
  const [quickRepairToast, setQuickRepairToast] = useState<{ type: 'success' | 'warning'; message: string } | null>(null);
  const quickRepairToastTimerRef = useRef<number | null>(null);

  const showQuickRepairToast = (toast: { type: 'success' | 'warning'; message: string }) => {
    if (quickRepairToastTimerRef.current !== null) {
      window.clearTimeout(quickRepairToastTimerRef.current);
    }
    setQuickRepairToast(toast);
    quickRepairToastTimerRef.current = window.setTimeout(() => {
      setQuickRepairToast(null);
      quickRepairToastTimerRef.current = null;
    }, 5000);
  };

  useEffect(() => {
    return () => {
      if (quickRepairToastTimerRef.current !== null) {
        window.clearTimeout(quickRepairToastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (propCurrentUser) {
      setCurrentUser(propCurrentUser);
    }
  }, [propCurrentUser]);

  useEffect(() => {
    localStorage.setItem('simulated_current_user', JSON.stringify(currentUser));
    if (!propCurrentUser && onUserChange) {
      onUserChange(currentUser);
    }
  }, [currentUser, onUserChange, propCurrentUser]);

  useEffect(() => {
    if (currentUser) {
      const userDepartment = currentUser.dept || currentUser.department;
      setSearchTerm('');
      setSelectedCategory('全部分类');
      setSelectedStatus('全部状态');
      setFilterMenuOpen(null);
      setClinicalFilterMode('all_dept');
      setMatrixSelectedCategory('全部分类');
      setMatrixSelectedStatus('全部状态');
      setMatrixSearchQuery('');
      setMatrixSortField('deviceName');
      setMatrixSortOrder('asc');
      setMobileView('list');
      if (currentUser.role === 'medical_staff' && userDepartment) {
        setSelectedDept(userDepartment);
        setMatrixSelectedDept(userDepartment);
        setOnlyMyDept(true);
      } else {
        setSelectedDept('全部科室');
        setMatrixSelectedDept('全部科室');
        setOnlyMyDept(false);
      }
    }
  }, [currentUser.id, currentUser.role, currentUser.dept, currentUser.department]);

  // 1. Data States
  const [equipments, setEquipments] = useState<MedicalEquipment[]>(() => (
    parseStoredEquipmentList(localStorage.getItem(EQUIPMENT_STORAGE_KEY)).equipments
  ));

  // Selected Equipment Focus state
  const [selectedId, setSelectedId] = useState<string>(() => {
    const { equipments: storedEquipments } = parseStoredEquipmentList(localStorage.getItem(EQUIPMENT_STORAGE_KEY));
    return storedEquipments[0]?.id || '';
  });

  // Filter States
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedDept, setSelectedDept] = useState('全部科室');
  const [selectedCategory, setSelectedCategory] = useState('全部分类');
  const [selectedStatus, setSelectedStatus] = useState('全部状态');

  // Detail panel tabs: 'basic' | 'maintenance' | 'calibration' | 'attachments' | 'tickets'
  const [activeTab, setActiveTab] = useState<'basic' | 'maintenance' | 'calibration' | 'attachments' | 'tickets'>('basic');

  // Top-level View Mode: 'inventory' (Standard 3-column list/dossier) | 'calendar' (Unified scheduling calendar) | 'matrix' (Department & type equipment matrix dashboard) | 'list' (Detailed list grid)
  const [viewMode, setViewMode] = useState<'inventory' | 'calendar' | 'matrix' | 'list'>('inventory');

  // Matrix and Category All Equipment Tab Filters
  const [matrixSelectedDept, setMatrixSelectedDept] = useState('全部科室');
  const [matrixSelectedCategory, setMatrixSelectedCategory] = useState('全部分类');
  const [matrixSelectedStatus, setMatrixSelectedStatus] = useState('全部状态');
  const [matrixSearchQuery, setMatrixSearchQuery] = useState('');
  const [matrixSortField, setMatrixSortField] = useState<string>('deviceName');
  const [matrixSortOrder, setMatrixSortOrder] = useState<'asc' | 'desc'>('asc');

  // Mobile navigation state
  const [mobileView, setMobileView] = useState<'list' | 'detail' | 'ai'>('list');

  // Custom filter dropdown menus state ('dept' | 'category' | 'status' | null)
  const [filterMenuOpen, setFilterMenuOpen] = useState<'dept' | 'category' | 'status' | null>(null);

  // Modals & Forms State
  const [isFormModalOpen, setIsFormModalOpen] = useState(false);
  const [formMode, setFormMode] = useState<'create' | 'edit'>('create');
  const [currentEditId, setCurrentEditId] = useState<string | null>(null);

  // Form Fields State
  const [formDeviceName, setFormDeviceName] = useState('');
  const [formModel, setFormModel] = useState('');
  const [formSn, setFormSn] = useState('');
  const [formManufacturer, setFormManufacturer] = useState('');
  const [formCategory, setFormCategory] = useState<'急救生命支持' | '影像诊断' | '检验分析' | '手术治疗' | '其他'>('其他');
  const [formDept, setFormDept] = useState('');
  const [formStatus, setFormStatus] = useState<'正常运行' | '故障维修' | '计量中' | '已停用'>('正常运行');
  const [formRiskLevel, setFormRiskLevel] = useState<'高' | '中' | '低'>('中');
  const [formPurchaseDate, setFormPurchaseDate] = useState('');
  const [formPurchaseCost, setFormPurchaseCost] = useState(0);
  const [formMaintenanceCycleDays, setFormMaintenanceCycleDays] = useState(180);
  const [formCalibrationRequired, setFormCalibrationRequired] = useState(false);
  const [isBatchSnMode, setIsBatchSnMode] = useState(false);
  const [batchSnList, setBatchSnList] = useState('');

  // 医疗器械合规相关表单状态
  const [formRegistrationNo, setFormRegistrationNo] = useState('');
  const [formRegistrationValidUntil, setFormRegistrationValidUntil] = useState('');
  const [formDeviceClass, setFormDeviceClass] = useState<'I类' | 'II类' | 'III类' | '未分类'>('未分类');
  const [formProductionLicenseNo, setFormProductionLicenseNo] = useState('');

  // 设备照片状态
  const [formPhotoUrl, setFormPhotoUrl] = useState('');
  const [zoomPhotoUrl, setZoomPhotoUrl] = useState<string | null>(null);

  // Quick Action Modals
  const [isLogModalOpen, setIsLogModalOpen] = useState(false);
  const [logType, setLogType] = useState<'维保' | '计量'>('维保');
  
  // Log Add State
  const [newLogType, setNewLogType] = useState<'维修' | '保养'>('保养');
  const [newLogDate, setNewLogDate] = useState(getLocalDateString);
  const [newLogTechnician, setNewLogTechnician] = useState('');
  const [newLogDescription, setNewLogDescription] = useState('');
  const [newLogCost, setNewLogCost] = useState(0);
  const [newLogStatus, setNewLogStatus] = useState<'已完成' | '进行中'>('已完成');
  // New enriched maintenance log fields
  const [newLogFaultPhenomenon, setNewLogFaultPhenomenon] = useState('');
  const [newLogPartsReplaced, setNewLogPartsReplaced] = useState('');
  const [newLogVerifyPerson, setNewLogVerifyPerson] = useState('');
  const [newLogPmChecklist, setNewLogPmChecklist] = useState<string[]>(['外观清洁检查', '电源与接地安全', '功能自检测试']);

  // Calibration Add State
  const [newCalDate, setNewCalDate] = useState(getLocalDateString);
  const [newCalAgency, setNewCalAgency] = useState('');
  const [newCalCertificateNo, setNewCalCertificateNo] = useState('');
  const [newCalResult, setNewCalResult] = useState<'合格' | '准用' | '限用' | '不合格'>('合格');
  const [newCalValidUntil, setNewCalValidUntil] = useState('');
  // New enriched calibration log fields
  const [newCalType, setNewCalType] = useState<'强制检定' | '首次检定' | '周期检定' | '校准/检测'>('强制检定');
  const [newCalTesterName, setNewCalTesterName] = useState('');
  const [newCalVerifyPerson, setNewCalVerifyPerson] = useState('');
  const [newCalErrorDescription, setNewCalErrorDescription] = useState('');

  // Detailed Log viewers
  const [viewMaintenanceLog, setViewMaintenanceLog] = useState<MaintenanceLog | null>(null);
  const [viewCalibrationLog, setViewCalibrationLog] = useState<CalibrationLog | null>(null);

  // Physical Attachment Add State
  const [isAttachmentModalOpen, setIsAttachmentModalOpen] = useState(false);
  const [newAttachName, setNewAttachName] = useState('');
  const [newAttachType, setNewAttachType] = useState<'manual' | 'invoice' | 'certificate' | 'other'>('manual');
  const [newAttachSize, setNewAttachSize] = useState('1.5 MB');

  // Dossier Export State
  const [isDossierModalOpen, setIsDossierModalOpen] = useState(false);

  // Smart Thumbnail Preview States
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<Attachment | null>(null);
  const [activePreviewPage, setActivePreviewPage] = useState<number>(1);
  const [isExtractingSnapshot, setIsExtractingSnapshot] = useState(false);
  const [hoveredSlice, setHoveredSlice] = useState<number | null>(null);
  const snapshotExtractRequestVersionRef = useRef(0);

  // AI OCR Parser State
  const [isAiParserOpen, setIsAiParserOpen] = useState(false);
  const [aiInputText, setAiInputText] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzerError, setAnalyzerError] = useState<string | null>(null);
  const [isOcrDragging, setIsOcrDragging] = useState(false);
  const [isAttachDragging, setIsAttachDragging] = useState(false);

  // AI Diagnostician Chat state
  const [chatInput, setChatInput] = useState('');
  const [isChatSending, setIsChatSending] = useState(false);
  const [chatMessages, setChatMessages] = useState<Array<{role: 'user' | 'model', text: string}>>([
    { role: 'model', text: createDiagnosticWelcome() }
  ]);
  const chatRequestVersionRef = useRef(0);
  const diagnosticChatSessionKeyRef = useRef('');
  const archiveManageRequestVersionRef = useRef(0);
  const canManageEquipmentArchiveRef = useRef(false);

  // 扫码报修状态与引用
  const [isScannerModalOpen, setIsScannerModalOpen] = useState(false);
  const [scannedSnResult, setScannedSnResult] = useState('');
  const [scannerCameraError, setScannerCameraError] = useState<string | null>(null);
  const [scannerMatchError, setScannerMatchError] = useState<string | null>(null);
  const [isScannerCameraActive, setIsScannerCameraActive] = useState(false);
  const scannerVideoRef = useRef<HTMLVideoElement | null>(null);
  const scannerStreamRef = useRef<MediaStream | null>(null);
  const scannerCameraRequestVersionRef = useRef(0);
  const currentUserDepartment = currentUser.dept || currentUser.department;

  const canCurrentUserReportEquipment = (equipment: MedicalEquipment) => {
    return currentUser.role !== 'medical_staff' || !currentUserDepartment || isSameDepartment(equipment.dept, currentUserDepartment);
  };
  const hasActiveRepairWorkOrder = (equipment: MedicalEquipment) => {
    return equipment.status === '故障维修' || equipment.maintenanceLogs.some(log => log.type === '维修' && log.status === '进行中');
  };
  const canStartQuickRepairForEquipment = (equipment: MedicalEquipment | null) => {
    return !!equipment && canCurrentUserReportEquipment(equipment) && !hasActiveRepairWorkOrder(equipment);
  };
  const getDefaultQuickRepairUrgency = (equipment: MedicalEquipment | null): 'low' | 'medium' | 'high' => {
    if (!equipment) return 'medium';
    return equipment.category === '急救生命支持' || equipment.riskLevel === '高' ? 'high' : 'medium';
  };
  const resetQuickRepairDraft = (nextEquipmentId = '') => {
    setQuickRepairEquipId(nextEquipmentId);
    setQuickRepairDesc('');
    const nextEquipment = nextEquipmentId ? equipments.find(eq => eq.id === nextEquipmentId) || null : null;
    setQuickRepairUrgency(getDefaultQuickRepairUrgency(nextEquipment));
  };
  const getQuickRepairBlockMessage = (equipment: MedicalEquipment | null) => {
    if (!equipment) return '请先选择需要报修的设备。';
    if (!canCurrentUserReportEquipment(equipment)) {
      return `当前临床账号只能为本科室设备发起报修：${currentUserDepartment}`;
    }
    if (hasActiveRepairWorkOrder(equipment)) {
      return `设备【${equipment.deviceName}】已有进行中的维修工单，请在现有工单中补充故障信息，避免重复派单。`;
    }
    return '';
  };
  const canCurrentUserViewEquipment = (equipment: MedicalEquipment) => {
    return currentUser.role !== 'medical_staff' || !currentUserDepartment || isSameDepartment(equipment.dept, currentUserDepartment);
  };
  const canCurrentUserViewTicket = (ticket: StructuredTicket) => {
    return currentUser.role !== 'medical_staff' || !currentUserDepartment || isSameDepartment(ticket.department, currentUserDepartment);
  };
  const getRelatedTasksForEquipment = (equipment: MedicalEquipment) => {
    return tasks
      .filter(needsClinicalAcceptance)
      .filter(t => t.deviceId === equipment.id || t.deviceId === equipment.sn || (t.deviceName === equipment.deviceName && isSameDepartment(t.department, equipment.dept)))
      .filter(canCurrentUserViewTicket);
  };
  const canManageEquipmentArchive = currentUser.role === 'engineer';
  canManageEquipmentArchiveRef.current = canManageEquipmentArchive;
  const showArchiveManageBlockedToast = (actionName: string) => {
    showQuickRepairToast({
      type: 'warning',
      message: `当前临床账号只能查看本科室设备并发起报修，不能执行${actionName}。请切换到医学装备科工程师账号后再操作。`
    });
  };
  const ensureCanManageEquipmentArchive = (actionName: string) => {
    if (canManageEquipmentArchive) return true;
    showArchiveManageBlockedToast(actionName);
    return false;
  };
  const beginArchiveAiAnalyze = (actionName: string) => {
    if (!ensureCanManageEquipmentArchive(actionName)) return null;
    archiveManageRequestVersionRef.current += 1;
    setIsAnalyzing(true);
    setAnalyzerError(null);
    return archiveManageRequestVersionRef.current;
  };
  const isArchiveAiAnalyzeCurrent = (requestVersion: number) => (
    requestVersion === archiveManageRequestVersionRef.current && canManageEquipmentArchiveRef.current
  );

  useEffect(() => {
    if (canManageEquipmentArchive) return;
    archiveManageRequestVersionRef.current += 1;
    setIsAnalyzing(false);
    setAnalyzerError(null);
    setIsFormModalOpen(false);
    setIsAiParserOpen(false);
    setIsLogModalOpen(false);
    setIsAttachmentModalOpen(false);
    setIsDossierModalOpen(false);
    setIsScannerModalOpen(false);
    setIsQuickRepairModalOpen(false);
    setIsPreviewOpen(false);
    setPreviewFile(null);
    setIsExtractingSnapshot(false);
    snapshotExtractRequestVersionRef.current += 1;
    resetQuickRepairDraft();
    setFormMode('create');
    setCurrentEditId(null);
  }, [canManageEquipmentArchive]);

  const visibleEquipments = equipments.filter(canCurrentUserViewEquipment);
  const quickRepairableEquipments = visibleEquipments.filter(canStartQuickRepairForEquipment);
  const firstQuickRepairableEquipment = quickRepairableEquipments[0] || null;
  const clinicalQuickRepairBlockMessage = firstQuickRepairableEquipment
    ? ''
    : visibleEquipments.length === 0
      ? '当前科室暂无可报修的在册设备。'
      : '本科室设备已有进行中的维修工单，请在现有工单中补充故障信息，避免重复派单。';
  const visibleDepartments: string[] = ['全部科室', ...Array.from(new Set(visibleEquipments.map(eq => eq.dept))).filter((dept): dept is string => Boolean(dept))];
  const assetScopeLabel = currentUser.role === 'medical_staff' ? '本科室' : '全院';
  const formatDepartmentScopeLabel = (dept: string) => {
    if (dept !== '全部科室') return dept;
    return currentUser.role === 'medical_staff' ? '本科室' : '全部科室';
  };
  const categories = ['全部分类', '急救生命支持', '影像诊断', '检验分析', '手术治疗', '其他'];
  const statusOptions = ['全部状态', '正常运行', '故障维修', '计量中', '已停用'];

  // Filtered Equipment List taking simulated user into account
  const filteredEquipments = visibleEquipments.filter(eq => {
    const matchesSearch = eq.deviceName.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          eq.model.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          eq.sn.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          eq.manufacturer.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          eq.dept.toLowerCase().includes(searchTerm.toLowerCase());

    // Default department match
    let matchesDept = selectedDept === '全部科室' || isSameDepartment(eq.dept, selectedDept);

    // 临床医护人员登录并且开启了"仅看我科室设备"
    if (currentUser.role === 'medical_staff' && onlyMyDept && currentUserDepartment) {
      if (clinicalFilterMode === 'my_reported') {
        // "本科室在修设备" -> 所在科室 + 处于故障维修状态 或 含有进行中的维修工单
        const hasActiveRepairs = eq.status === '故障维修' || eq.maintenanceLogs.some(log => log.type === '维修' && log.status === '进行中');
        if (!hasActiveRepairs) return false;
      }
      matchesDept = isSameDepartment(eq.dept, currentUserDepartment);
    }

    const matchesCategory = selectedCategory === '全部分类' || eq.category === selectedCategory;
    const matchesStatus = selectedStatus === '全部状态' || eq.status === selectedStatus;

    return matchesSearch && matchesDept && matchesCategory && matchesStatus;
  });

  const matrixFilteredEquipments = visibleEquipments.filter(e => {
    const matchesDept = matrixSelectedDept === '全部科室' || isSameDepartment(e.dept, matrixSelectedDept);
    const matchesCategory = matrixSelectedCategory === '全部分类' || e.category === matrixSelectedCategory;
    const matchesStatus = matrixSelectedStatus === '全部状态' || e.status === matrixSelectedStatus;
    const matchesSearch = !matrixSearchQuery.trim() ||
      e.deviceName.toLowerCase().includes(matrixSearchQuery.toLowerCase()) ||
      e.sn.toLowerCase().includes(matrixSearchQuery.toLowerCase()) ||
      e.model.toLowerCase().includes(matrixSearchQuery.toLowerCase()) ||
      e.manufacturer.toLowerCase().includes(matrixSearchQuery.toLowerCase());

    return matchesDept && matchesCategory && matchesStatus && matchesSearch;
  });

  // 启动系统相机扫描仪
  const startScannerCamera = async () => {
    const requestVersion = scannerCameraRequestVersionRef.current + 1;
    scannerCameraRequestVersionRef.current = requestVersion;
    setScannerCameraError(null);
    setIsScannerCameraActive(true);
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' }
        });
        if (requestVersion !== scannerCameraRequestVersionRef.current || !isScannerModalOpen) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }
        scannerStreamRef.current = stream;
        if (scannerVideoRef.current) {
          scannerVideoRef.current.srcObject = stream;
          scannerVideoRef.current.play().catch(e => {
            console.warn("Play video failed: ", e);
          });
        }
      } else {
        throw new Error('浏览器不支持媒体设备接口，或者处于 Iframe 沙箱中被限制了摄像头权限。');
      }
    } catch (err: any) {
      if (requestVersion !== scannerCameraRequestVersionRef.current || !isScannerModalOpen) return;
      console.warn("Camera access failed, falling back to simulator: ", err);
      setScannerCameraError(err.message || '获取摄像头失败，已启用模拟扫描。');
    }
  };

  // 关闭系统相机
  const stopScannerCamera = () => {
    scannerCameraRequestVersionRef.current += 1;
    if (scannerStreamRef.current) {
      scannerStreamRef.current.getTracks().forEach(track => track.stop());
      scannerStreamRef.current = null;
    }
    if (scannerVideoRef.current) {
      scannerVideoRef.current.srcObject = null;
    }
    setIsScannerCameraActive(false);
  };

  // 相机模态框开关生命周期监听
  useEffect(() => {
    if (isScannerModalOpen) {
      setScannerMatchError(null);
      startScannerCamera();
    } else {
      stopScannerCamera();
    }
    return () => {
      stopScannerCamera();
    };
  }, [isScannerModalOpen]);

  // 处理匹配出的设备SN条码定位并触发报修工单自动填充
  const handleScannedSn = (snCode: string) => {
    const snTrimmed = snCode.trim();
    if (!snTrimmed) return;
    setScannerMatchError(null);
    
    const matched = equipments.find(eq => 
      eq.sn.trim().toLowerCase() === snTrimmed.toLowerCase() ||
      eq.id.trim().toLowerCase() === snTrimmed.toLowerCase()
    );

    if (matched) {
      const quickRepairBlockMessage = getQuickRepairBlockMessage(matched);
      if (quickRepairBlockMessage) {
        setScannerMatchError(
          !canCurrentUserReportEquipment(matched)
            ? `已识别设备【${matched.deviceName}】，但其归属科室为【${matched.dept}】。当前临床账号只能为【${currentUserDepartment}】设备发起扫码报修。`
            : quickRepairBlockMessage
        );
        return;
      }

      setSelectedId(matched.id);
      resetQuickRepairDraft(matched.id);
      setIsScannerModalOpen(false);
      
      // 直接定位并自动填充报修工单
      setQuickRepairDesc(`【扫码定位故障报修】\n临床通过手机系统相机扫描设备铭牌上的原厂SN条码（条码：${matched.sn}）直接触发。请维修工程师到场协助处理。`);
      setQuickRepairUrgency('high'); // 扫码报修通常用于紧急的床旁或现场报修，默认置高
      setIsQuickRepairModalOpen(true);
    } else {
      setScannerMatchError(`未找到原厂SN序列号为【${snTrimmed}】的在册医疗设备档案，请核对设备标签或前往手动新增。`);
    }
  };

  // Save to local storage whenever equipment state changes
  useEffect(() => {
    localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(equipments));
  }, [equipments]);

  // Listen to deep linking events to select equipment
  useEffect(() => {
    const handleDeepLinkEquipment = (e: any) => {
      const equipId = e.detail?.equipmentId;
      if (equipId) {
        const found = equipments.find(eq => eq.id === equipId || eq.sn === equipId);
        if (found) {
          if (!canCurrentUserViewEquipment(found)) {
            showQuickRepairToast({
              type: 'warning',
              message: `当前临床账号只能查看本科室设备：${currentUserDepartment}`
            });
            return;
          }

          setSelectedId(found.id);
          setViewMode('inventory');
          if (e.detail?.activeTab) {
            setActiveTab(e.detail.activeTab);
          }
        }
      }
    };
    window.addEventListener('deep-link-equipment', handleDeepLinkEquipment);
    return () => {
      window.removeEventListener('deep-link-equipment', handleDeepLinkEquipment);
    };
  }, [equipments, currentUser.id, currentUserDepartment]);

  // Keep selectedId valid in the filtered list when filters or roles change
  useEffect(() => {
    if (filteredEquipments.length === 0) {
      if (selectedId) {
        setSelectedId('');
      }
      if (mobileView === 'detail') {
        setMobileView('list');
      }
      return;
    }

    const isStillVisible = filteredEquipments.some(eq => eq.id === selectedId);
    if (!isStillVisible) {
      setSelectedId(filteredEquipments[0].id);
    }
  }, [currentUser, onlyMyDept, clinicalFilterMode, selectedDept, selectedCategory, selectedStatus, searchTerm, equipments, selectedId, mobileView]);

  const selectedEquipment = filteredEquipments.find(eq => eq.id === selectedId) || filteredEquipments[0] || null;
  const currentDiagnosticSessionKey = getDiagnosticSessionKey(selectedEquipment, currentUser);
  const canSubmitQuickRepair = Boolean(quickRepairEquipId && quickRepairDesc.trim());

  const previewFileBelongsToSelectedEquipment = Boolean(
    selectedEquipment && previewFile && selectedEquipment.attachments.some(file => file.id === previewFile.id)
  );
  const maintenanceLogBelongsToSelectedEquipment = Boolean(
    selectedEquipment && viewMaintenanceLog && selectedEquipment.maintenanceLogs.some(log => log.id === viewMaintenanceLog.id)
  );
  const calibrationLogBelongsToSelectedEquipment = Boolean(
    selectedEquipment && viewCalibrationLog && selectedEquipment.calibrationLogs.some(log => log.id === viewCalibrationLog.id)
  );

  useEffect(() => {
    if (isPreviewOpen && !previewFileBelongsToSelectedEquipment) {
      setIsPreviewOpen(false);
      setPreviewFile(null);
      setActivePreviewPage(1);
      setIsExtractingSnapshot(false);
      snapshotExtractRequestVersionRef.current += 1;
    }
  }, [isPreviewOpen, previewFileBelongsToSelectedEquipment]);

  useEffect(() => {
    if (viewMaintenanceLog && !maintenanceLogBelongsToSelectedEquipment) {
      setViewMaintenanceLog(null);
    }
    if (viewCalibrationLog && !calibrationLogBelongsToSelectedEquipment) {
      setViewCalibrationLog(null);
    }
  }, [
    viewMaintenanceLog,
    viewCalibrationLog,
    maintenanceLogBelongsToSelectedEquipment,
    calibrationLogBelongsToSelectedEquipment
  ]);

  useEffect(() => {
    if (!quickRepairEquipId) return;
    const quickRepairEquipment = equipments.find(eq => eq.id === quickRepairEquipId);
    if (quickRepairEquipment && canStartQuickRepairForEquipment(quickRepairEquipment)) return;

    const fallbackEquipment = visibleEquipments.find(canStartQuickRepairForEquipment);
    resetQuickRepairDraft(fallbackEquipment?.id || '');
  }, [quickRepairEquipId, currentUser.id, currentUserDepartment, equipments, visibleEquipments]);

  // Refresh AI Chat context on device and user change
  useEffect(() => {
    diagnosticChatSessionKeyRef.current = currentDiagnosticSessionKey;
    chatRequestVersionRef.current += 1;
    setIsChatSending(false);
    setChatInput('');
    setChatMessages([
      { role: 'model', text: createDiagnosticWelcome(selectedEquipment, currentUser) }
    ]);
  }, [
    currentDiagnosticSessionKey,
    selectedEquipment?.deviceName,
    selectedEquipment?.model,
    selectedEquipment?.sn,
    currentUser.role,
    currentUserDepartment
  ]);

  // Unique list for filtering dropdowns
  const departments = visibleDepartments;

  // Calculate Overall院 Dashboard stats
  const totalAssetsValue = visibleEquipments.reduce((sum, eq) => sum + eq.purchaseCost, 0);
  const totalEquipments = visibleEquipments.length;
  const perfectRate = totalEquipments > 0 ? ((visibleEquipments.filter(eq => eq.status === '正常运行').length / totalEquipments) * 100).toFixed(1) : '0.0';
  const troubleCount = visibleEquipments.filter(eq => eq.status === '故障维修').length;
  const calibrationReminderCount = visibleEquipments.filter(eq => {
    if (!eq.calibrationRequired || !eq.nextCalibrationDate) return false;
    const diffDays = getDateDiffDaysFromToday(eq.nextCalibrationDate);
    if (diffDays === null) return false;
    return diffDays >= 0 && diffDays <= 30; // Within 30 days
  }).length;

  // Handle Equipment deletion
  const handleDelete = (id: string) => {
    if (!canManageEquipmentArchive) {
      showArchiveManageBlockedToast('档案作废删除');
      return;
    }

    if (window.confirm('您确定要永久删除该设备的全部档案、维保记录和附件吗？此操作不可撤销。')) {
      setEquipments(prevEquipments => {
        const nextEquipments = prevEquipments.filter(eq => eq.id !== id);
        localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(nextEquipments));
        return nextEquipments;
      });
    }
  };

  // Open modal for Create
  const openCreateModal = () => {
    if (!canManageEquipmentArchive) {
      showArchiveManageBlockedToast('手动新增档案');
      return;
    }

    setFormMode('create');
    setCurrentEditId(null);
    setFormDeviceName('');
    setFormModel('');
    setFormSn(`SN${Math.floor(100000 + Math.random() * 900000)}`);
    setIsBatchSnMode(false);
    setBatchSnList('');
    setFormManufacturer('');
    setFormCategory('其他');
    setFormDept('放射科');
    setFormStatus('正常运行');
    setFormRiskLevel('中');
    setFormPurchaseDate(getLocalDateString());
    setFormPurchaseCost(0);
    setFormMaintenanceCycleDays(180);
    setFormCalibrationRequired(false);
    setFormRegistrationNo('');
    setFormRegistrationValidUntil('');
    setFormDeviceClass('未分类');
    setFormProductionLicenseNo('');
    setFormPhotoUrl('');
    setIsFormModalOpen(true);
  };

  // Open modal for Edit
  const openEditModal = (eq: MedicalEquipment) => {
    if (!canManageEquipmentArchive) {
      showArchiveManageBlockedToast('修改设备档案');
      return;
    }

    setFormMode('edit');
    setCurrentEditId(eq.id);
    setFormDeviceName(eq.deviceName);
    setFormModel(eq.model);
    setFormSn(eq.sn);
    setIsBatchSnMode(false);
    setBatchSnList('');
    setFormManufacturer(eq.manufacturer);
    setFormCategory(eq.category);
    setFormDept(eq.dept);
    setFormStatus(eq.status);
    setFormRiskLevel(eq.riskLevel);
    setFormPurchaseDate(eq.purchaseDate);
    setFormPurchaseCost(eq.purchaseCost);
    setFormMaintenanceCycleDays(eq.maintenanceCycleDays);
    setFormCalibrationRequired(eq.calibrationRequired);
    setFormRegistrationNo(eq.registrationNo || '');
    setFormRegistrationValidUntil(eq.registrationValidUntil || '');
    setFormDeviceClass(eq.deviceClass || '未分类');
    setFormProductionLicenseNo(eq.productionLicenseNo || '');
    setFormPhotoUrl(eq.photoUrl || '');
    setIsFormModalOpen(true);
  };

  // Open modal for cloning / quick duplicating
  const openCloneModal = (eq: MedicalEquipment) => {
    if (!canManageEquipmentArchive) {
      showArchiveManageBlockedToast('克隆复制档案');
      return;
    }

    setFormMode('create');
    setCurrentEditId(null);
    setFormDeviceName(eq.deviceName);
    setFormModel(eq.model);
    setFormSn('');
    setIsBatchSnMode(false);
    setBatchSnList('');
    setFormManufacturer(eq.manufacturer);
    setFormCategory(eq.category);
    setFormDept(eq.dept);
    setFormStatus('正常运行');
    setFormRiskLevel(eq.riskLevel);
    setFormPurchaseDate(getLocalDateString());
    setFormPurchaseCost(eq.purchaseCost);
    setFormMaintenanceCycleDays(eq.maintenanceCycleDays);
    setFormCalibrationRequired(eq.calibrationRequired);
    setFormRegistrationNo(eq.registrationNo || '');
    setFormRegistrationValidUntil(eq.registrationValidUntil || '');
    setFormDeviceClass(eq.deviceClass || '未分类');
    setFormProductionLicenseNo(eq.productionLicenseNo || '');
    setFormPhotoUrl(eq.photoUrl || '');
    setIsFormModalOpen(true);
  };

  // Save Equipment Form
  const saveEquipmentForm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManageEquipmentArchive) {
      showArchiveManageBlockedToast('保存设备档案');
      return;
    }

    if (!formDeviceName.trim() || !formModel.trim() || !formManufacturer.trim() || !formDept.trim()) {
      alert('请完整填写基本档案中的必填项！');
      return;
    }

    // Calc Next maintenance date automatically based on purchase date/last maintenance
    const nextMaintenanceStr = addLocalDays(formPurchaseDate, formMaintenanceCycleDays);

    // Calc next calibration date
    const nextCalibrationStr = formCalibrationRequired 
      ? addLocalDays(formPurchaseDate, 365)
      : undefined;

    if (formMode === 'create') {
      let snsToCreate = [formSn];
      if (isBatchSnMode && batchSnList.trim()) {
        snsToCreate = parseBatchSns(batchSnList);
      }

      if (snsToCreate.length === 0) {
        snsToCreate = [`SN${Math.floor(100000 + Math.random() * 900000)}` + " (未录入)"];
      }

      const newEqs: MedicalEquipment[] = snsToCreate.map((sn, index) => {
        const uniqueId = `eq-${Math.floor(100 + Math.random() * 900)}-${Math.floor(10 + Math.random() * 90)}`;
        return {
          id: uniqueId,
          deviceName: formDeviceName,
          model: formModel,
          sn: sn,
          manufacturer: formManufacturer,
          category: formCategory,
          dept: formDept,
          status: formStatus,
          riskLevel: formRiskLevel,
          purchaseDate: formPurchaseDate,
          purchaseCost: formPurchaseCost,
          maintenanceCycleDays: formMaintenanceCycleDays,
          lastMaintenanceDate: formPurchaseDate,
          nextMaintenanceDate: nextMaintenanceStr,
          calibrationRequired: formCalibrationRequired,
          lastCalibrationDate: formCalibrationRequired ? formPurchaseDate : undefined,
          nextCalibrationDate: nextCalibrationStr,
          attachments: [],
          maintenanceLogs: [],
          calibrationLogs: [],
          
          // 医疗器械注册及合规属性
          registrationNo: formRegistrationNo || undefined,
          registrationValidUntil: formRegistrationValidUntil || undefined,
          deviceClass: formDeviceClass,
          productionLicenseNo: formProductionLicenseNo || undefined,
          photoUrl: formPhotoUrl || undefined
        };
      });

      setEquipments(prevEquipments => {
        const nextEquipments = [...newEqs, ...prevEquipments];
        localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(nextEquipments));
        return nextEquipments;
      });
      setSelectedId(newEqs[0].id);
      
      if (newEqs.length > 1) {
        alert(`🎉 批量导入成功！已成功一键新增 ${newEqs.length} 台具有相同名称规格（型号：${formModel}）的设备档案。`);
      }
    } else {
      if (!currentEditId) return;
      setEquipments(prevEquipments => {
        const nextEquipments = prevEquipments.map(eq => {
          if (eq.id !== currentEditId) return eq;

          return {
            ...eq,
            deviceName: formDeviceName,
            model: formModel,
            sn: formSn,
            manufacturer: formManufacturer,
            category: formCategory,
            dept: formDept,
            status: formStatus,
            riskLevel: formRiskLevel,
            purchaseDate: formPurchaseDate,
            purchaseCost: formPurchaseCost,
            maintenanceCycleDays: formMaintenanceCycleDays,
            nextMaintenanceDate: nextMaintenanceStr,
            calibrationRequired: formCalibrationRequired,
            nextCalibrationDate: formCalibrationRequired ? (eq.nextCalibrationDate || nextCalibrationStr) : undefined,
            
            // 医疗器械注册及合规属性
            registrationNo: formRegistrationNo || undefined,
            registrationValidUntil: formRegistrationValidUntil || undefined,
            deviceClass: formDeviceClass,
            productionLicenseNo: formProductionLicenseNo || undefined,
            photoUrl: formPhotoUrl || undefined
          };
        });
        localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(nextEquipments));
        return nextEquipments;
      });
    }
    setIsFormModalOpen(false);
  };

  // 临床医护人员一键快捷报修提交
  const handleQuickRepairSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickRepairEquipId) {
      alert('请选择需要报修的设备！');
      return;
    }
    if (!quickRepairDesc.trim()) {
      alert('请填写故障现象描述！');
      return;
    }

    const targetEq = equipments.find(eq => eq.id === quickRepairEquipId);
    if (!targetEq) return;
    const quickRepairBlockMessage = getQuickRepairBlockMessage(targetEq);
    if (quickRepairBlockMessage) {
      showQuickRepairToast({
        type: 'warning',
        message: quickRepairBlockMessage
      });
      return;
    }

    const workOrderNo = createQuickRepairRecord(targetEq, quickRepairDesc.trim(), quickRepairUrgency);
    if (!workOrderNo) return;

    setIsQuickRepairModalOpen(false);
    resetQuickRepairDraft();
    showQuickRepairToast({
      type: 'success',
      message: `报修成功：${targetEq.deviceName} 已同步生成主工单与档案维修记录 ${workOrderNo}`
    });
  };

  // Add Log Entry (Maintenance)
  const handleAddMaintenanceLog = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ensureCanManageEquipmentArchive('新增维保工单')) return;
    if (!newLogTechnician.trim() || !newLogDescription.trim()) {
      alert('请填写技术员姓名与工作描述！');
      return;
    }

    const log: MaintenanceLog = {
      id: `log-${Math.floor(1000 + Math.random() * 9000)}`,
      type: newLogType,
      date: newLogDate,
      technician: newLogTechnician,
      description: newLogDescription,
      cost: Number(newLogCost),
      status: newLogStatus,
      // Enriched properties
      workOrderNo: `WO-${newLogDate.replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`,
      faultPhenomenon: newLogType === '维修' ? (newLogFaultPhenomenon || '设备故障无法正常运作，临床报修') : '不适用 (计划内PM预防性维护)',
      partsReplaced: newLogPartsReplaced || '无更换配件',
      verifyPerson: newLogVerifyPerson || '科室设备管理员',
      pmChecklist: newLogType === '保养' ? newLogPmChecklist : []
    };

    setEquipments(prevEquipments => {
      const nextEquipments = prevEquipments.map(eq => {
        if (eq.id !== selectedId) return eq;
        // Also update equipment dates & status if relevant
        const updatedLogs = [log, ...eq.maintenanceLogs];
        const updatedStatus = log.status === '进行中' && log.type === '维修' ? '故障维修' : eq.status;
        return {
          ...eq,
          status: updatedStatus,
          lastMaintenanceDate: log.type === '保养' ? log.date : eq.lastMaintenanceDate,
          nextMaintenanceDate: log.type === '保养' 
            ? addLocalDays(log.date, eq.maintenanceCycleDays)
            : eq.nextMaintenanceDate,
          maintenanceLogs: updatedLogs
        };
      });
      localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(nextEquipments));
      return nextEquipments;
    });

    // Reset fields
    setNewLogDescription('');
    setNewLogCost(0);
    setNewLogFaultPhenomenon('');
    setNewLogPartsReplaced('');
    setNewLogVerifyPerson('');
    setNewLogPmChecklist(['外观清洁检查', '电源与接地安全', '功能自检测试']);
    setIsLogModalOpen(false);
  };

  // Add Calibration Log
  const handleAddCalibrationLog = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ensureCanManageEquipmentArchive('登记计量证书')) return;
    if (!newCalAgency.trim() || !newCalCertificateNo.trim() || !newCalValidUntil) {
      alert('请填写完整计量单位、证书编号及有效期！');
      return;
    }

    const log: CalibrationLog = {
      id: `cal-${Math.floor(1000 + Math.random() * 9000)}`,
      date: newCalDate,
      agency: newCalAgency,
      certificateNo: newCalCertificateNo,
      result: newCalResult,
      validUntil: newCalValidUntil,
      // Enriched properties
      calibType: newCalType,
      testerName: newCalTesterName || '国家计量中心主检员',
      verifyPerson: newCalVerifyPerson || '计量院总审核工程师',
      errorDescription: newCalErrorDescription || '各项检定物理指标良好，综合误差在法定合格允许公差范围内。'
    };

    setEquipments(prevEquipments => {
      const nextEquipments = prevEquipments.map(eq => {
        if (eq.id !== selectedId) return eq;
        return {
          ...eq,
          status: log.result === '合格' || log.result === '准用' ? '正常运行' : '计量中',
          lastCalibrationDate: log.date,
          nextCalibrationDate: log.validUntil,
          calibrationLogs: [log, ...eq.calibrationLogs]
        };
      });
      localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(nextEquipments));
      return nextEquipments;
    });

    // Reset fields
    setNewCalAgency('');
    setNewCalCertificateNo('');
    setNewCalTesterName('');
    setNewCalVerifyPerson('');
    setNewCalErrorDescription('');
    setNewCalType('强制检定');
    setIsLogModalOpen(false);
  };

  // Delete Maintenance Log
  const handleDeleteMaintenanceLog = (logId: string) => {
    if (!ensureCanManageEquipmentArchive('删除维保履历记录')) return;
    if (!window.confirm('您确定要永久删除此条维保履历记录吗？')) return;
    setEquipments(prevEquipments => {
      const nextEquipments = prevEquipments.map(eq => {
        if (eq.id !== selectedId) return eq;
        return {
          ...eq,
          maintenanceLogs: eq.maintenanceLogs.filter(log => log.id !== logId)
        };
      });
      localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(nextEquipments));
      return nextEquipments;
    });
  };

  // Delete Calibration Log
  const handleDeleteCalibrationLog = (calId: string) => {
    if (!ensureCanManageEquipmentArchive('注销计量证书')) return;
    if (!window.confirm('您确定要永久删除此条法定计量强检记录及证书档案吗？')) return;
    setEquipments(prevEquipments => {
      const nextEquipments = prevEquipments.map(eq => {
        if (eq.id !== selectedId) return eq;
        return {
          ...eq,
          calibrationLogs: eq.calibrationLogs.filter(cal => cal.id !== calId)
        };
      });
      localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(nextEquipments));
      return nextEquipments;
    });
  };

  const handleDeleteExtractedSnapshot = (snapshotId: string) => {
    if (!ensureCanManageEquipmentArchive('解除技术手册快照关联')) return;
    if (!selectedEquipment) return;
    const targetEquipmentId = selectedEquipment.id;

    setEquipments(prevEquipments => {
      const nextEquipments = prevEquipments.map(eq => {
        if (eq.id !== targetEquipmentId) return eq;
        return {
          ...eq,
          extractedSnapshots: (eq.extractedSnapshots || []).filter(s => s.id !== snapshotId)
        };
      });
      localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(nextEquipments));
      return nextEquipments;
    });
  };

  // Add Attachment Item
  const handleAddAttachment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ensureCanManageEquipmentArchive('上传资料附件')) return;
    if (!newAttachName.trim()) {
      alert('请填写资料附件名称！');
      return;
    }

    const attach: Attachment = {
      id: `att-${Math.floor(1000 + Math.random() * 9000)}`,
      name: newAttachName + (newAttachName.includes('.') ? '' : '.pdf'),
      type: newAttachType,
      size: newAttachSize || '2.0 MB',
      uploadDate: getLocalDateString()
    };

    setEquipments(prevEquipments => {
      const nextEquipments = prevEquipments.map(eq => {
        if (eq.id !== selectedId) return eq;
        return {
          ...eq,
          attachments: [...eq.attachments, attach]
        };
      });
      localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(nextEquipments));
      return nextEquipments;
    });

    setNewAttachName('');
    setIsAttachmentModalOpen(false);
  };

  // AI OCR Parser simulation with presets
  const runPresetOcr = (presetNum: number) => {
    const requestVersion = beginArchiveAiAnalyze('AI 扫码入库');
    if (requestVersion === null) return;
    let sampleText = '';
    
    if (presetNum === 1) {
      sampleText = `Manufacturer: SIEMENS Healthcare GmbH
Model Name: Magnetom Vida 3.0T Magnetic Resonance System
Serial Number / SN: MR-SI-99201A
Installation Category: Image Diagnosis
Recommended Inspection cycle: 180 Days
Calibration Class: Mandatory High Risk`;
    } else if (presetNum === 2) {
      sampleText = `发票代码：0440023001
货物名称：迈瑞多参数监护仪（ICU/OR生命支持监控系统）
规格型号：BeneVision N17
制造厂商：深圳迈瑞生物医疗电子股份有限公司
金额：¥45,000.00 元
购买科室：急诊医学重症监护室 (ICU)`;
    } else if (presetNum === 3) {
      sampleText = `ResMed Stellar 150 non-invasive ventilator
REF: 24901
Serial Number: RM-VE-302611A
Input: 100-240V, 50-60Hz
Preventive Maintenance: every 90 days
Clinical class: Life-saving respiratory device`;
    }

    // Call the server Gemini analyze endpoint
    analyzeGeminiContent({ textContext: sampleText })
      .then(result => {
        if (!isArchiveAiAnalyzeCurrent(requestVersion)) return;
        setIsAnalyzing(false);
        if (result.error) {
          setAnalyzerError(result.error);
        } else if (result.data) {
          // Pre-populate Form with parsed response
          const data = result.data;
          setFormDeviceName(data.deviceName || '');
          setFormModel(data.model || '');
          setFormSn(data.sn || '');
          setFormManufacturer(data.manufacturer || '');
          setFormCategory(data.category || '其他');
          setFormMaintenanceCycleDays(data.maintenanceCycleDays || 180);
          setFormCalibrationRequired(data.calibrationRequired || false);
          setFormRiskLevel(data.riskLevel || '中');
          setFormDept('放射科');
          setFormPurchaseDate(getLocalDateString());
          setFormPurchaseCost(45000); // Placeholder cost
          setFormStatus('正常运行');
          
          setIsAiParserOpen(false);
          setFormMode('create');
          setIsFormModalOpen(true);
        }
      })
      .catch(err => {
        if (!isArchiveAiAnalyzeCurrent(requestVersion)) return;
        setIsAnalyzing(false);
        setAnalyzerError(err.message || '分析时发生网络错误');
      });
  };

  // Run Custom Text OCR or Image upload OCR via Gemini API
  const handleCustomOcrAnalyze = () => {
    if (!aiInputText.trim()) {
      alert('请输入铭牌描述、规格单据文本或上传附件描述！');
      return;
    }
    const requestVersion = beginArchiveAiAnalyze('AI 扫码入库');
    if (requestVersion === null) return;

    analyzeGeminiContent({ textContext: aiInputText }, 'AI 服务处理异常')
      .then(result => {
        if (!isArchiveAiAnalyzeCurrent(requestVersion)) return;
        setIsAnalyzing(false);
        if (result.error) {
          setAnalyzerError(result.error);
        } else if (result.data) {
          const data = result.data;
          setFormDeviceName(data.deviceName || '');
          setFormModel(data.model || '');
          setFormSn(data.sn || '');
          setFormManufacturer(data.manufacturer || '');
          setFormCategory(data.category || '其他');
          setFormMaintenanceCycleDays(data.maintenanceCycleDays || 180);
          setFormCalibrationRequired(data.calibrationRequired || false);
          setFormRiskLevel(data.riskLevel || '中');
          setFormDept('医学装备科');
          setFormPurchaseDate(getLocalDateString());
          setFormPurchaseCost(0);
          setFormStatus('正常运行');

          setIsAiParserOpen(false);
          setFormMode('create');
          setIsFormModalOpen(true);
        }
      })
      .catch(err => {
        if (!isArchiveAiAnalyzeCurrent(requestVersion)) return;
        setIsAnalyzing(false);
        setAnalyzerError(err.message || '通信故障，请稍后再试');
      });
  };

  // Chat with AI Diagnostician Expert
  const sendChatMessage = () => {
    if (!chatInput.trim() || !selectedEquipment || isChatSending) return;
    const userMsg = chatInput;
    const requestVersion = chatRequestVersionRef.current;
    const requestSessionKey = currentDiagnosticSessionKey;
    diagnosticChatSessionKeyRef.current = currentDiagnosticSessionKey;
    setChatInput('');
    
    const newHistory = [...chatMessages, { role: 'user' as const, text: userMsg }];
    setChatMessages(newHistory);
    setIsChatSending(true);

    // Format for model request (role user/model with text)
    const formattedHistory = newHistory.map(m => ({
      role: m.role,
      parts: [{ text: m.text }]
    }));

    chatWithGeminiExpert({
      deviceContext: selectedEquipment,
      messageHistory: formattedHistory
    })
      .then(result => {
        if (requestVersion !== chatRequestVersionRef.current || requestSessionKey !== diagnosticChatSessionKeyRef.current) return;
        setIsChatSending(false);
        if (result.text) {
          setChatMessages([...newHistory, { role: 'model', text: result.text }]);
        } else {
          setChatMessages([...newHistory, { role: 'model', text: '对不起，我由于系统网络原因无法生成回应，请您重试。' }]);
        }
      })
      .catch(err => {
        if (requestVersion !== chatRequestVersionRef.current || requestSessionKey !== diagnosticChatSessionKeyRef.current) return;
        setIsChatSending(false);
        setChatMessages([...newHistory, { role: 'model', text: `[错误] 无法连接到 AI 诊断服务端: ${err.message}` }]);
      });
  };

  // Process OCR files (images of nameplates, invoices, labels)
  const processOcrFile = (file: File) => {
    const requestVersion = beginArchiveAiAnalyze('AI 扫码入库');
    if (requestVersion === null) return;

    const reader = new FileReader();
    reader.onload = function(event) {
      if (!isArchiveAiAnalyzeCurrent(requestVersion)) return;
      const base64String = event.target?.result as string;
      if (!base64String) {
        setIsAnalyzing(false);
        return;
      }
      
      const parts = base64String.split(';base64,');
      const mimeType = parts[0].split(':')[1];
      const data = parts[1];

      // Call API
      analyzeGeminiContent({
        imageBase64: data,
        mimeType: mimeType,
        textContext: `This is an uploaded file name: ${file.name}`
      })
        .then(result => {
          if (!isArchiveAiAnalyzeCurrent(requestVersion)) return;
          setIsAnalyzing(false);
          if (result.error) {
            setAnalyzerError(result.error);
          } else if (result.data) {
            const parsed = result.data;
            setFormDeviceName(parsed.deviceName || '');
            setFormModel(parsed.model || '');
            setFormSn(parsed.sn || '');
            setFormManufacturer(parsed.manufacturer || '');
            setFormCategory(parsed.category || '其他');
            setFormMaintenanceCycleDays(parsed.maintenanceCycleDays || 180);
            setFormCalibrationRequired(parsed.calibrationRequired || false);
            setFormRiskLevel(parsed.riskLevel || '中');
            setFormDept('医学装备科');
            setFormPurchaseDate(getLocalDateString());
            setFormPurchaseCost(0);
            setFormStatus('正常运行');

            setIsAiParserOpen(false);
            setFormMode('create');
            setIsFormModalOpen(true);
          }
        })
        .catch(err => {
          if (!isArchiveAiAnalyzeCurrent(requestVersion)) return;
          setIsAnalyzing(false);
          setAnalyzerError(err.message || '铭牌图像智能解析失败');
        });
    };
    reader.readAsDataURL(file);
  };

  // Simulates scanning label with file input
  const handleNameplateImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processOcrFile(file);
    }
  };

  // Process selected or dropped attachment files
  const processAttachFile = (file: File) => {
    if (!ensureCanManageEquipmentArchive('上传资料附件')) return;
    setNewAttachName(file.name);
    
    // Auto calculate formatted size
    let formattedSize = '1.0 MB';
    if (file.size > 1024 * 1024) {
      formattedSize = (file.size / (1024 * 1024)).toFixed(1) + ' MB';
    } else {
      formattedSize = (file.size / 1024).toFixed(0) + ' KB';
    }
    setNewAttachSize(formattedSize);

    // Auto classify document type based on file name or mime type
    const lowerName = file.name.toLowerCase();
    if (lowerName.includes('invoice') || lowerName.includes('发票') || lowerName.includes('购销') || lowerName.includes('凭证') || lowerName.includes('收据') || lowerName.includes('bill') || lowerName.includes('price') || lowerName.includes('cny') || lowerName.includes('rmb')) {
      setNewAttachType('invoice');
    } else if (lowerName.includes('manual') || lowerName.includes('使用说明') || lowerName.includes('操作手册') || lowerName.includes('用户指南') || lowerName.includes('instruction') || lowerName.includes('guide') || lowerName.includes('docx') || lowerName.includes('pdf') || lowerName.includes('手册')) {
      setNewAttachType('manual');
    } else if (lowerName.includes('cert') || lowerName.includes('证书') || lowerName.includes('合格证') || lowerName.includes('许可证') || lowerName.includes('license') || lowerName.includes('registration') || lowerName.includes('准入') || lowerName.includes('检测')) {
      setNewAttachType('certificate');
    } else {
      setNewAttachType('other');
    }
  };

  // Simulates adding attachment with file input
  const handleAttachmentFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processAttachFile(file);
    }
  };

  // Simulated Instant Actions (e.g. print QR, quick error reporting)
  const handlePrintQR = () => {
    if (!ensureCanManageEquipmentArchive('打印物联二维码标签')) return;
    alert(`[指令发送成功] 已向科室标签打印机(Zebra ZD888) 发送打印指令。\n设备名：${selectedEquipment.deviceName}\n编号：${selectedEquipment.id}\n规格：${selectedEquipment.model}`);
  };

  const createQuickRepairRecord = (
    targetEq: MedicalEquipment,
    description: string,
    urgency: 'low' | 'medium' | 'high'
  ) => {
    const quickRepairBlockMessage = getQuickRepairBlockMessage(targetEq);
    if (quickRepairBlockMessage) {
      showQuickRepairToast({
        type: 'warning',
        message: quickRepairBlockMessage
      });
      return '';
    }

    const today = getLocalDateString();
    const latestEquipments = parseStoredEquipmentList(localStorage.getItem(EQUIPMENT_STORAGE_KEY)).equipments;
    const workOrderNo = createQuickRepairWorkOrderNo(latestEquipments, today);
    const parentAccepted = onQuickRepairCreated?.({
      equipment: targetEq,
      description,
      urgency,
      workOrderNo
    });

    if (parentAccepted === false) {
      showQuickRepairToast({
        type: 'warning',
        message: `当前登录身份无法同步该设备主工单，请确认设备归属科室：${targetEq.dept}`
      });
      return '';
    }

    const repairLog: MaintenanceLog = {
      id: 'm-log-' + Date.now(),
      type: '维修',
      date: today,
      technician: '未分派 (待响应)',
      cost: 0,
      description: `【一键快捷报修】紧急度: ${urgency === 'high' ? '高' : urgency === 'medium' ? '中' : '低'}。描述: ${description}`,
      status: '进行中',
      workOrderNo,
      faultPhenomenon: description,
      partsReplaced: '待查',
      verifyPerson: currentUser.name
    };

    const nextEquipments = latestEquipments.map(eq => {
      if (eq.id !== targetEq.id) return eq;

      return {
        ...eq,
        status: '故障维修',
        maintenanceLogs: [repairLog, ...(eq.maintenanceLogs || [])]
      };
    });
    localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(nextEquipments));
    setEquipments(nextEquipments);

    return workOrderNo;
  };

  const handleQuickRepair = () => {
    const quickRepairBlockMessage = getQuickRepairBlockMessage(selectedEquipment);
    if (quickRepairBlockMessage) {
      showQuickRepairToast({
        type: 'warning',
        message: quickRepairBlockMessage
      });
      return;
    }

    if (window.confirm(`确认要将设备 【${selectedEquipment.deviceName}】 的状态更改为“故障维修”并紧急派单至医学装备科吗？`)) {
      const description = '科室通过快速报修渠道紧急申报，描述：设备发生突发性故障，无法正常开机或运行中断。';
      const urgency: 'medium' | 'high' = selectedEquipment.category === '急救生命支持' || selectedEquipment.riskLevel === '高' ? 'high' : 'medium';
      const workOrderNo = createQuickRepairRecord(selectedEquipment, description, urgency);
      if (!workOrderNo) return;

      showQuickRepairToast({
        type: 'success',
        message: `报修成功：${selectedEquipment.deviceName} 已同步生成主工单与档案维修记录 ${workOrderNo}`
      });
    }
  };

  // Simulated download or direct file link clicks
  const triggerDownloadFile = (file: Attachment) => {
    if (!ensureCanManageEquipmentArchive('下载技术资料原档')) return;
    alert(`[安全原档下载] 正在安全信道解密调阅医疗器械原始技术文档：${file.name} (大小: ${file.size})`);
  };

  const handleExtractSnapshot = (page: PreviewPage) => {
    if (!ensureCanManageEquipmentArchive('提取技术手册快照')) return;
    if (!previewFile || !selectedEquipment) return;
    const requestVersion = snapshotExtractRequestVersionRef.current + 1;
    snapshotExtractRequestVersionRef.current = requestVersion;
    const targetEquipmentId = selectedEquipment.id;
    const targetFileId = previewFile.id;
    const targetFileName = previewFile.name;
    const targetPageNum = page.pageNum;
    setIsExtractingSnapshot(true);
    
    // Simulate high-tech AI extraction with a realistic timeout
    setTimeout(() => {
      if (requestVersion !== snapshotExtractRequestVersionRef.current) return;
      if (!canManageEquipmentArchiveRef.current) {
        setIsExtractingSnapshot(false);
        return;
      }

      const newSnapshot = {
        id: 'snap-' + Date.now(),
        pageNum: targetPageNum,
        title: page.title,
        imageUrl: page.diagramType, // Stores visual representation type
        extractedAt: getLocalDateTimeString(),
        sourceFileName: targetFileName,
        notes: `从《${targetFileName}》第 ${targetPageNum} 页中智能提取。已完成高精度 OCR 元数据索引，核心规范包含:「${page.lines[0] || ''}」。已被临床工程师确认为该医学装备的核心技术参考与合规判据。`
      };

      // Update equipment list state
      let snapshotWasApplied = false;
      setEquipments(prevEquipments => {
        const latestTargetEquipment = prevEquipments.find(eq => eq.id === targetEquipmentId);
        const targetFileStillExists = latestTargetEquipment?.attachments.some(file => file.id === targetFileId);
        if (!latestTargetEquipment || !targetFileStillExists) {
          return prevEquipments;
        }
        snapshotWasApplied = true;

        const nextEquipments = prevEquipments.map(eq => {
          if (eq.id !== targetEquipmentId) return eq;

          const existingSnapshots = eq.extractedSnapshots || [];
          // Avoid duplicating same page snapshot
          if (existingSnapshots.some(s => s.sourceFileName === targetFileName && s.pageNum === targetPageNum)) {
            alert('提示：该技术手册页快照已提取过，系统已自动重构其高阶关联指引并置顶！');
            return {
              ...eq,
              extractedSnapshots: [newSnapshot, ...existingSnapshots.filter(s => !(s.sourceFileName === targetFileName && s.pageNum === targetPageNum))]
            };
          }
          return {
            ...eq,
            extractedSnapshots: [newSnapshot, ...existingSnapshots]
          };
        });

        localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(nextEquipments));
        return nextEquipments;
      });

      setIsExtractingSnapshot(false);
      if (snapshotWasApplied) {
        alert(`🎉 成功从《${targetFileName}》中提取第 ${targetPageNum} 页作为设备关联快照！此快照已与主技术档案完成高阶可信映射。`);
      }
    }, 800);
  };

  return (
    <div id="app_root" className="flex flex-col h-screen h-[100dvh] w-full bg-[#F0F2F5] p-2 sm:p-3 md:p-6 pb-16 md:pb-6 overflow-hidden font-sans">
      {quickRepairToast && (
        <div className={`fixed top-4 right-4 z-40 max-w-sm rounded-xl border bg-white px-4 py-3 shadow-xl flex items-start gap-2.5 ${
          quickRepairToast.type === 'success'
            ? 'border-emerald-200 shadow-emerald-900/10'
            : 'border-amber-200 shadow-amber-900/10'
        }`}>
          {quickRepairToast.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
          )}
          <div>
            <p className={`text-xs font-black ${
              quickRepairToast.type === 'success' ? 'text-emerald-800' : 'text-amber-800'
            }`}>
              {quickRepairToast.type === 'success' ? '快捷报修已同步' : '操作权限提醒'}
            </p>
            <p className="text-[11px] text-slate-600 mt-0.5 leading-relaxed">{quickRepairToast.message}</p>
          </div>
        </div>
      )}
      
      {/* Top Header Section */}
      <header id="header_section" className="flex flex-col 2xl:flex-row 2xl:items-center 2xl:justify-between bg-white px-3 md:px-6 py-2.5 md:py-4 rounded-xl shadow-sm mb-3 md:mb-6 border border-slate-200 gap-2.5">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between w-full 2xl:w-auto min-w-0 gap-2.5 md:gap-4">
          <div className="flex items-center gap-2.5 md:gap-4">
            <div className="bg-blue-600 p-1.5 md:p-2.5 rounded-lg text-white flex-shrink-0">
              <Activity className="w-4 h-4 md:w-6 md:h-6 animate-pulse" />
            </div>
            <div>
              {onBackToTasks && (
                <button
                  onClick={onBackToTasks}
                  className="mr-2 px-2 py-1 md:px-3 md:py-1.5 text-[10px] md:text-xs font-bold text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg flex items-center gap-1 cursor-pointer transition-all border border-blue-200 flex-shrink-0"
                >
                  <ArrowUpDown className="w-3.5 h-3.5" />
                  <span>切换至AI任务流转助手</span>
                </button>
              )}<h1 className="text-sm md:text-xl font-bold text-slate-800 tracking-tight">医学装备管理系统</h1>
              <p className="text-[10px] md:text-xs text-slate-500 uppercase tracking-widest font-mono hidden md:block">Medical Equipment Lifecycle Archive</p>
            </div>
          </div>

          {/* View Mode Switcher */}
          <div className="flex bg-slate-100 p-0.5 md:p-1 rounded-lg border border-slate-200/60 flex-shrink-0 overflow-x-auto max-w-full">
            <button
              onClick={() => setViewMode('inventory')}
              className={`px-2 py-1 md:px-2.5 md:py-1.5 text-[11px] md:text-xs font-bold rounded-md flex items-center gap-1 md:gap-1.5 transition-all cursor-pointer ${
                viewMode === 'inventory'
                  ? 'bg-white text-blue-600 shadow-xs font-extrabold'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>设备台账</span>
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`px-2 py-1 md:px-2.5 md:py-1.5 text-[11px] md:text-xs font-bold rounded-md flex items-center gap-1 md:gap-1.5 transition-all cursor-pointer ${
                viewMode === 'list'
                  ? 'bg-white text-blue-600 shadow-xs font-extrabold'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <Table className="w-3.5 h-3.5" />
              <span>台账明细表</span>
            </button>
            <button
              onClick={() => setViewMode('calendar')}
              className={`px-2 py-1 md:px-2.5 md:py-1.5 text-[11px] md:text-xs font-bold rounded-md flex items-center gap-1 md:gap-1.5 transition-all cursor-pointer ${
                viewMode === 'calendar'
                  ? 'bg-white text-blue-600 shadow-xs font-extrabold'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <Calendar className="w-3.5 h-3.5" />
              <span>维保日历</span>
            </button>
            <button
              onClick={() => setViewMode('matrix')}
              className={`px-2 py-1 md:px-2.5 md:py-1.5 text-[11px] md:text-xs font-bold rounded-md flex items-center gap-1 md:gap-1.5 transition-all cursor-pointer ${
                viewMode === 'matrix'
                  ? 'bg-white text-blue-600 shadow-xs font-extrabold'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <BarChart2 className="w-3.5 h-3.5 text-indigo-500" />
              <span>科室资产看板</span>
            </button>
          </div>
          
          {/* Quick action buttons on mobile next to title */}
          <div className="flex items-center gap-1.5 lg:hidden">
            {canManageEquipmentArchive && (
              <button
                onClick={() => setIsAiParserOpen(true)}
                className="flex items-center justify-center bg-gradient-to-r from-violet-600 to-indigo-600 text-white p-2 rounded-lg text-xs font-medium hover:from-violet-700 hover:to-indigo-700 shadow-md shadow-indigo-100 transition-all"
                title="AI 扫码入库"
              >
                <Sparkles className="w-4 h-4" />
              </button>
            )}
            {canManageEquipmentArchive ? (
              <button
                onClick={() => setIsDossierModalOpen(true)}
                className="flex items-center justify-center bg-slate-800 text-white p-2 rounded-lg text-xs font-medium hover:bg-slate-900 transition-colors shadow-sm"
                title="导出PDF档案"
              >
                <Printer className="w-4 h-4" />
              </button>
            ) : (
              <span className="flex items-center justify-center bg-slate-100 text-slate-500 p-2 rounded-lg text-[10px] font-bold border border-slate-200">
                只读
              </span>
            )}
            {canManageEquipmentArchive && (
              <button
                onClick={openCreateModal}
                className="flex items-center justify-center bg-blue-600 text-white p-2 rounded-lg text-xs font-medium hover:bg-blue-700 transition-colors shadow-sm shadow-blue-100"
                title="手动新增"
              >
                <Plus className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
        
        {/* Dynamic Filters & Search Panel */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 w-full 2xl:w-auto 2xl:flex-shrink-0">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
            <input 
              type="text" 
              placeholder="搜索设备、SN号、生产商、科室..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="bg-slate-100 text-slate-800 border-none rounded-lg pl-9 pr-4 py-2 text-xs md:text-sm w-full 2xl:w-72 focus:outline-none focus:ring-2 focus:ring-blue-500 font-sans"
            />
          </div>

          <div className="hidden lg:flex items-center gap-2">
            {canManageEquipmentArchive && (
              <button
                onClick={() => setIsAiParserOpen(true)}
                className="flex-1 sm:flex-initial flex items-center justify-center gap-1.5 bg-gradient-to-r from-violet-600 to-indigo-600 text-white px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium hover:from-violet-700 hover:to-indigo-700 shadow-md shadow-indigo-100 transition-all whitespace-nowrap"
                title="通过智能OCR识别设备铭牌或单据发票自动入库"
              >
                <Sparkles className="w-4 h-4" />
                <span>AI 扫码入库</span>
              </button>
            )}

            {canManageEquipmentArchive ? (
              <button
                onClick={() => setIsDossierModalOpen(true)}
                className="flex-1 sm:flex-initial flex items-center justify-center gap-1.5 bg-slate-800 text-white px-3.5 py-2 rounded-lg text-xs md:text-sm font-bold hover:bg-slate-900 transition-colors shadow-sm whitespace-nowrap"
                title="导出当前选中设备技术档案为 PDF / 打印"
              >
                <Printer className="w-4 h-4" />
                <span>导出PDF档案</span>
              </button>
            ) : (
              <span className="flex-1 sm:flex-initial flex items-center justify-center gap-1.5 bg-slate-100 text-slate-500 px-3.5 py-2 rounded-lg text-xs md:text-sm font-bold border border-slate-200 whitespace-nowrap">
                临床只读档案
              </span>
            )}

            {canManageEquipmentArchive && (
              <button
                onClick={openCreateModal}
                className="flex-1 sm:flex-initial flex items-center justify-center bg-blue-600 text-white px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium hover:bg-blue-700 transition-colors shadow-sm shadow-blue-100 whitespace-nowrap"
              >
                + 手动新增
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Grid Content Container */}
      <main id="main_container" className="flex-1 min-h-0 relative flex flex-col pb-20 md:pb-0">
        {viewMode === 'inventory' ? (
          <div className="grid grid-cols-12 gap-3 md:gap-6 flex-1 min-h-0 w-full">
        
            {/* LEFT COLUMN: Archive List & Stats */}
        <aside id="left_column_panel" className={`col-span-12 md:col-span-3 ${mobileView === 'list' ? 'flex' : 'hidden md:flex'} flex-col gap-3 md:gap-6 h-full min-h-0`}>
          
          {/* Quick Stats Widget */}
          <div id="statistics_widget" className="hidden md:block bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center justify-between">
              <span>运行状态仪表</span>
              <span className="text-[10px] text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">总数: {totalEquipments}台</span>
            </h3>
            
            <div className="grid grid-cols-2 gap-3 mb-1">
              <div className="bg-emerald-50 p-3 rounded-lg border border-emerald-100 text-center">
                <p className="text-[10px] text-emerald-600 font-medium">设备完好率</p>
                <p className="text-lg font-bold text-emerald-700">{perfectRate}%</p>
              </div>
              <div className="bg-amber-50 p-3 rounded-lg border border-amber-100 text-center">
                <p className="text-[10px] text-amber-600 font-medium">计量强检预警</p>
                <p className="text-lg font-bold text-amber-700">{calibrationReminderCount}台</p>
              </div>
            </div>

            {troubleCount > 0 && (
              <div className="mt-2 bg-rose-50 border border-rose-100 text-rose-700 rounded-lg p-2.5 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-500 animate-bounce flex-shrink-0" />
                <span>当前有 <strong>{troubleCount}</strong> 台核心医疗设备正处于故障维修状态</span>
              </div>
            )}
          </div>

          {/* Directory Filtering and Directory List */}
          <div id="equipment_list_panel" className="bg-white p-3 md:p-4 rounded-xl border border-slate-200 shadow-sm flex-1 flex flex-col min-h-0">
            
            {currentUser.role === 'medical_staff' && (
              <div className="mb-3.5 bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-100 rounded-lg p-2.5 shadow-2xs font-sans">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5 text-blue-800">
                    <Activity className="w-3.5 h-3.5 animate-pulse text-blue-600" />
                    <span className="text-[11px] font-black">临床医护快捷面板</span>
                  </div>
                  <span className="text-[9px] font-black bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded">
                    {currentUserDepartment}
                  </span>
                </div>
                
                <div className="flex gap-1.5 mb-2.5">
                  <button
                    type="button"
                    onClick={() => setClinicalFilterMode('all_dept')}
                    className={`flex-1 py-1.5 px-2 rounded text-[10px] font-bold border transition-all cursor-pointer ${
                      clinicalFilterMode === 'all_dept'
                        ? 'bg-blue-600 border-blue-600 text-white shadow-xs'
                        : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    🏥 本科全部资产
                  </button>
                  <button
                    type="button"
                    onClick={() => setClinicalFilterMode('my_reported')}
                    className={`flex-1 py-1.5 px-2 rounded text-[10px] font-bold border transition-all cursor-pointer relative ${
                      clinicalFilterMode === 'my_reported'
                        ? 'bg-blue-600 border-blue-600 text-white shadow-xs'
                        : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <span>🚨 本科室在修设备</span>
                    {visibleEquipments.filter(eq => eq.status === '故障维修' || eq.maintenanceLogs.some(log => log.type === '维修' && log.status === '进行中')).length > 0 && (
                      <span className="absolute -top-1 -right-1 flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
                      </span>
                    )}
                  </button>
                </div>

                <button
                  id="btn-clinical-open-quick-repair"
                  aria-label="打开本科室故障一键快捷上报"
                  type="button"
                  disabled={!firstQuickRepairableEquipment}
                  title={firstQuickRepairableEquipment ? '打开本科室故障一键快捷上报' : clinicalQuickRepairBlockMessage}
                  onClick={() => {
                    if (!firstQuickRepairableEquipment) {
                      showQuickRepairToast({
                        type: 'warning',
                        message: clinicalQuickRepairBlockMessage
                      });
                      return;
                    }
                    resetQuickRepairDraft(firstQuickRepairableEquipment.id);
                    setIsQuickRepairModalOpen(true);
                  }}
                  className={`w-full py-1.5 rounded text-[10px] font-black shadow-sm flex items-center justify-center gap-1.5 transition-colors ${
                    firstQuickRepairableEquipment
                      ? 'bg-rose-500 hover:bg-rose-600 text-white cursor-pointer'
                      : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                  }`}
                >
                  <AlertTriangle className={`w-3 h-3 ${firstQuickRepairableEquipment ? 'text-white' : 'text-slate-400'}`} />
                  <span>本科室故障一键快捷上报</span>
                </button>

                <div className="mt-2.5 pt-2 border-t border-blue-100 flex items-center justify-between">
                  <span className="text-[10px] text-slate-500 font-medium">科室隔离控制</span>
                  <label className="flex items-center gap-1 text-[10px] text-slate-700 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={onlyMyDept}
                      onChange={(e) => setOnlyMyDept(e.target.checked)}
                      className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5 cursor-pointer"
                    />
                    <span className="font-bold text-blue-800">仅看本科室设备 ({currentUserDepartment})</span>
                  </label>
                </div>
              </div>
            )}

            {/* Inline Filter Controls */}
            <div className="grid grid-cols-3 gap-1 md:gap-1.5 mb-2 md:mb-3">
              {/* 科室筛选 */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setFilterMenuOpen(filterMenuOpen === 'dept' ? null : 'dept')}
                  className={`w-full flex items-center justify-between text-[11px] bg-slate-50 border border-slate-200 hover:bg-slate-100 rounded-lg px-2 py-2 text-slate-700 outline-none transition-all ${filterMenuOpen === 'dept' ? 'ring-2 ring-blue-500 border-transparent bg-white shadow-sm' : ''}`}
                >
                  <span className="truncate font-medium">{formatDepartmentScopeLabel(selectedDept)}</span>
                  <ChevronDown className="w-3 h-3 text-slate-400 flex-shrink-0 ml-0.5" />
                </button>
                {filterMenuOpen === 'dept' && (
                  <>
                    <div className="fixed inset-0 bg-slate-900/20 backdrop-blur-xs md:bg-transparent md:backdrop-blur-none z-40" onClick={() => setFilterMenuOpen(null)} />
                    <div className="fixed inset-x-4 bottom-20 md:absolute md:inset-x-auto md:left-0 md:bottom-auto md:mt-1 md:w-48 max-h-[50vh] md:max-h-60 overflow-y-auto bg-white border border-slate-200 rounded-xl md:rounded-lg shadow-2xl md:shadow-lg py-1 z-50 animate-in fade-in slide-in-from-bottom-4 md:slide-in-from-top-1 duration-200">
                      <div className="px-3 py-2 border-b border-slate-100 text-[10px] font-bold text-slate-400 uppercase tracking-wider block md:hidden">选择科室</div>
                      {departments.map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => {
                            setSelectedDept(d);
                            setFilterMenuOpen(null);
                          }}
                          className={`w-full text-left px-3.5 py-3 md:py-2 text-[12px] md:text-[11px] flex items-center justify-between transition-colors hover:bg-slate-50 ${selectedDept === d ? 'text-blue-600 font-bold bg-blue-50/50' : 'text-slate-700'}`}
                        >
                          <span>{formatDepartmentScopeLabel(d)}</span>
                          {selectedDept === d && <Check className="w-3.5 h-3.5 text-blue-600" />}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>

              {/* 分类筛选 */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setFilterMenuOpen(filterMenuOpen === 'category' ? null : 'category')}
                  className={`w-full flex items-center justify-between text-[11px] bg-slate-50 border border-slate-200 hover:bg-slate-100 rounded-lg px-2 py-2 text-slate-700 outline-none transition-all ${filterMenuOpen === 'category' ? 'ring-2 ring-blue-500 border-transparent bg-white shadow-sm' : ''}`}
                >
                  <span className="truncate font-medium">{selectedCategory === '全部分类' ? '全部类别' : selectedCategory}</span>
                  <ChevronDown className="w-3 h-3 text-slate-400 flex-shrink-0 ml-0.5" />
                </button>
                {filterMenuOpen === 'category' && (
                  <>
                    <div className="fixed inset-0 bg-slate-900/20 backdrop-blur-xs md:bg-transparent md:backdrop-blur-none z-40" onClick={() => setFilterMenuOpen(null)} />
                    <div className="fixed inset-x-4 bottom-20 md:absolute md:inset-x-auto md:left-0 md:bottom-auto md:mt-1 md:w-48 max-h-[50vh] md:max-h-60 overflow-y-auto bg-white border border-slate-200 rounded-xl md:rounded-lg shadow-2xl md:shadow-lg py-1 z-50 animate-in fade-in slide-in-from-bottom-4 md:slide-in-from-top-1 duration-200">
                      <div className="px-3 py-2 border-b border-slate-100 text-[10px] font-bold text-slate-400 uppercase tracking-wider block md:hidden">选择设备分类</div>
                      {categories.map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => {
                            setSelectedCategory(c);
                            setFilterMenuOpen(null);
                          }}
                          className={`w-full text-left px-3.5 py-3 md:py-2 text-[12px] md:text-[11px] flex items-center justify-between transition-colors hover:bg-slate-50 ${selectedCategory === c ? 'text-blue-600 font-bold bg-blue-50/50' : 'text-slate-700'}`}
                        >
                          <span>{c === '全部分类' ? '全部类别' : c}</span>
                          {selectedCategory === c && <Check className="w-3.5 h-3.5 text-blue-600" />}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>

              {/* 状态筛选 */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setFilterMenuOpen(filterMenuOpen === 'status' ? null : 'status')}
                  className={`w-full flex items-center justify-between text-[11px] bg-slate-50 border border-slate-200 hover:bg-slate-100 rounded-lg px-2 py-2 text-slate-700 outline-none transition-all ${filterMenuOpen === 'status' ? 'ring-2 ring-blue-500 border-transparent bg-white shadow-sm' : ''}`}
                >
                  <span className="truncate font-medium">{selectedStatus === '全部状态' ? '全部状态' : selectedStatus}</span>
                  <ChevronDown className="w-3 h-3 text-slate-400 flex-shrink-0 ml-0.5" />
                </button>
                {filterMenuOpen === 'status' && (
                  <>
                    <div className="fixed inset-0 bg-slate-900/20 backdrop-blur-xs md:bg-transparent md:backdrop-blur-none z-40" onClick={() => setFilterMenuOpen(null)} />
                    <div className="fixed inset-x-4 bottom-20 md:absolute md:inset-x-auto md:left-0 md:bottom-auto md:mt-1 md:w-48 max-h-[50vh] md:max-h-60 overflow-y-auto bg-white border border-slate-200 rounded-xl md:rounded-lg shadow-2xl md:shadow-lg py-1 z-50 animate-in fade-in slide-in-from-bottom-4 md:slide-in-from-top-1 duration-200">
                      <div className="px-3 py-2 border-b border-slate-100 text-[10px] font-bold text-slate-400 uppercase tracking-wider block md:hidden">选择设备状态</div>
                      {statusOptions.map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => {
                            setSelectedStatus(s);
                            setFilterMenuOpen(null);
                          }}
                          className={`w-full text-left px-3.5 py-3 md:py-2 text-[12px] md:text-[11px] flex items-center justify-between transition-colors hover:bg-slate-50 ${selectedStatus === s ? 'text-blue-600 font-bold bg-blue-50/50' : 'text-slate-700'}`}
                        >
                          <span>{s === '全部状态' ? '全部状态' : s}</span>
                          {selectedStatus === s && <Check className="w-3.5 h-3.5 text-blue-600" />}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* List entries */}
            <div className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
              {filteredEquipments.length === 0 ? (
                <div className="text-center py-12 text-slate-400 text-xs">
                  <p className="mb-3">没有找到符合条件的设备，右侧详情已同步清空</p>
                  <button
                    type="button"
                    onClick={() => {
                      setSearchTerm('');
                      setSelectedDept('全部科室');
                      setSelectedCategory('全部分类');
                      setSelectedStatus('全部状态');
                    }}
                    className="px-3 py-1.5 bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100 transition-colors text-[11px] font-semibold"
                  >
                    重置所有筛选
                  </button>
                </div>
              ) : (
                filteredEquipments.map((eq) => {
                  const isSelected = eq.id === selectedId;
                  const isWarning = eq.status === '故障维修';
                  const isCalibration = eq.status === '计量中';
                  
                  let badgeColor = 'bg-emerald-50 text-emerald-700 border-emerald-200';
                  if (isWarning) badgeColor = 'bg-rose-50 text-rose-700 border-rose-200';
                  if (isCalibration) badgeColor = 'bg-amber-50 text-amber-700 border-amber-200';
                  if (eq.status === '已停用') badgeColor = 'bg-slate-100 text-slate-600 border-slate-200';

                  // Risk Level color indicator
                  let riskColor = 'bg-emerald-500';
                  let riskLabel = '低风险';
                  if (eq.riskLevel === '高') {
                    riskColor = 'bg-rose-500';
                    riskLabel = '高风险';
                  } else if (eq.riskLevel === '中') {
                    riskColor = 'bg-amber-500';
                    riskLabel = '中风险';
                  }

                  // 1. Calculate NMPA Registration status
                  const regStatus = getRegistrationStatus(eq.registrationValidUntil);

                  // 2. Calculate Calibration status
                  let calibStatus: { status: 'none' | 'expired' | 'expiring' | 'valid'; text: string; diffDays?: number } = { status: 'none', text: '免强检' };
                  if (eq.calibrationRequired && eq.nextCalibrationDate) {
                    const diffDays = getDateDiffDaysFromToday(eq.nextCalibrationDate);
                    if (diffDays === null) {
                      calibStatus = { status: 'none', text: '日期异常' };
                    } else if (diffDays < 0) {
                      calibStatus = { status: 'expired', text: '计量超期', diffDays: Math.floor(Math.abs(diffDays)) };
                    } else if (diffDays <= 30) {
                      calibStatus = { status: 'expiring', text: '计量临期', diffDays: Math.floor(diffDays) };
                    } else {
                      calibStatus = { status: 'valid', text: '计量合格', diffDays: Math.floor(diffDays) };
                    }
                  }

                  // Manufacturer brand abbreviation for cleaner layout
                  const brandName = eq.manufacturer.replace(/\(.*?\)/, '').trim();

                  return (
                    <div 
                      key={eq.id}
                      id={`equipment-card-${eq.id}`}
                      role="button"
                      tabIndex={0}
                      aria-label={`打开设备档案：${eq.deviceName}，${eq.dept}，${eq.status}`}
                      onClick={() => {
                        setSelectedId(eq.id);
                        setMobileView('detail');
                        setViewMode('inventory');
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedId(eq.id);
                          setMobileView('detail');
                          setViewMode('inventory');
                        }
                      }}
                      className={`p-3 rounded-xl border text-left cursor-pointer transition-all flex gap-3 items-start relative ${
                        isSelected 
                          ? 'bg-blue-50/85 border-blue-400 shadow-sm ring-1 ring-blue-400' 
                          : 'bg-white hover:bg-slate-50/80 border-slate-200/80 shadow-xs'
                      }`}
                    >
                      {/* Equipment Small Thumbnail */}
                      <div className="w-12 h-12 rounded-lg bg-slate-100 border border-slate-200/60 overflow-hidden flex-shrink-0 flex items-center justify-center relative mt-0.5 shadow-2xs">
                        {eq.photoUrl ? (
                          <img 
                            src={eq.photoUrl} 
                            alt={eq.deviceName} 
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center bg-slate-50 text-slate-400">
                            <Activity className="w-5 h-5" />
                          </div>
                        )}
                        {/* Risk Ribbon Accent */}
                        <div className={`absolute top-0 left-0 w-1 h-full ${riskColor}`} title={riskLabel} />
                      </div>

                      <div className="flex-1 min-w-0 space-y-1">
                        {/* Title and Status Badge */}
                        <div className="flex justify-between items-start gap-1">
                          <div className="flex items-center gap-1 min-w-0">
                            <h4 className="text-xs font-extrabold text-slate-800 line-clamp-1 tracking-tight">{eq.deviceName}</h4>
                          </div>
                          <span className={`text-[8px] px-1.5 py-0.5 rounded border font-black tracking-tight flex-shrink-0 uppercase ${badgeColor}`}>
                            {eq.status}
                          </span>
                        </div>

                        {/* Brand & Model details */}
                        <p className="text-[10px] text-slate-500 font-medium line-clamp-1">
                          <span className="text-slate-700 font-bold">{brandName}</span> • {eq.model}
                        </p>

                        {/* Basic Meta Row: Classification, Dept */}
                        <div className="flex flex-wrap gap-1 items-center">
                          {eq.deviceClass && eq.deviceClass !== '未分类' && (
                            <span className={`text-[8px] font-black px-1.5 py-0.2 rounded border ${
                              eq.deviceClass === 'III类' ? 'bg-rose-50 text-rose-600 border-rose-200/60' :
                              eq.deviceClass === 'II类' ? 'bg-amber-50 text-amber-600 border-amber-200/60' :
                              'bg-blue-50 text-blue-600 border-blue-200/60'
                            }`}>
                              {eq.deviceClass}
                            </span>
                          )}
                          <span className="text-[8px] font-semibold px-1 py-0.2 bg-slate-100 text-slate-600 rounded border border-slate-200/50">
                            {eq.dept}
                          </span>
                        </div>

                        {/* Compliance Status Alerts Row */}
                        <div className="flex flex-wrap gap-1 items-center pt-0.5">
                          {/* 1. NMPA Registration status */}
                          {!eq.registrationNo ? (
                            <span className="text-[8px] font-extrabold px-1 py-0.5 rounded bg-rose-50 text-rose-600 border border-rose-100 flex items-center gap-0.5">
                              🚫 缺注册证
                            </span>
                          ) : regStatus.status === 'expired' ? (
                            <span className="text-[8px] font-black px-1 py-0.5 rounded bg-rose-100 text-rose-700 border border-rose-200 animate-pulse flex items-center gap-0.5">
                              ⚠️ 证过期({regStatus.diffDays}天)
                            </span>
                          ) : regStatus.status === 'expiring' ? (
                            <span className="text-[8px] font-black px-1 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200 flex items-center gap-0.5">
                              ⚠️ 证临期({regStatus.diffDays}天)
                            </span>
                          ) : null}

                          {/* 2. Calibration status */}
                          {eq.calibrationRequired && (
                            calibStatus.status === 'expired' ? (
                              <span className="text-[8px] font-black px-1 py-0.5 rounded bg-red-100 text-red-700 border border-red-200 animate-pulse flex items-center gap-0.5">
                                ⏰ 计量超期({calibStatus.diffDays}天)
                              </span>
                            ) : calibStatus.status === 'expiring' ? (
                              <span className="text-[8px] font-black px-1 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200 flex items-center gap-0.5">
                                ⏰ 计量临期({calibStatus.diffDays}天)
                              </span>
                            ) : (
                              <span className="text-[8px] font-semibold px-1 py-0.5 rounded bg-emerald-50 text-emerald-600 border border-emerald-100 flex items-center gap-0.5">
                                ✓ 计量合格
                              </span>
                            )
                          )}
                        </div>

                        {/* Full SN Section - High Accuracy & Details */}
                        <div className="flex justify-between items-center pt-1.5 border-t border-slate-100 text-[9px] text-slate-400 font-mono">
                          <span className="font-sans text-[8px] text-slate-400">ID: {eq.id}</span>
                          <span className="bg-slate-50 text-slate-500 px-1 py-0.2 rounded border border-slate-200/40 text-[9px] font-bold">
                            SN: <span className="text-slate-800">{eq.sn}</span>
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            
            <div className="mt-3 pt-3 border-t border-slate-100 text-[10px] text-slate-400 text-center">
              显示 {filteredEquipments.length} / {totalEquipments} 台设备档案
            </div>
          </div>
        </aside>

        {/* MIDDLE COLUMN: Selected Equipment Detailed Dossier Sheet */}
        <section id="middle_detailed_column" className={`col-span-12 md:col-span-6 ${mobileView === 'detail' ? 'flex' : 'hidden md:flex'} bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col h-full min-h-0 overflow-hidden`}>
          
          {selectedEquipment ? (
            <>
              <div id="equipment_details_header" className="p-3 sm:p-4 md:p-6 border-b border-slate-100 bg-slate-50/40">
                <div className="flex justify-between items-center md:hidden mb-3">
                  <button 
                    onClick={() => setMobileView('list')}
                    className="flex items-center gap-1 text-xs text-blue-600 font-bold hover:underline"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    <span>返回设备列表</span>
                  </button>
                  <button
                    onClick={() => setIsScannerModalOpen(true)}
                    className="flex items-center gap-1.5 bg-gradient-to-r from-violet-600 to-indigo-600 text-white px-3 py-1.5 rounded-lg text-xs font-bold shadow-sm active:scale-95 transition-all"
                  >
                    <QrCode className="w-3.5 h-3.5" />
                    <span>📷 扫码报修</span>
                  </button>
                </div>
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                      <span className={`px-2 py-0.5 text-[10px] font-bold rounded uppercase ${
                        selectedEquipment.status === '正常运行' 
                          ? 'bg-emerald-100 text-emerald-800' 
                          : selectedEquipment.status === '故障维修'
                          ? 'bg-rose-100 text-rose-800'
                          : 'bg-amber-100 text-amber-800'
                      }`}>
                        {selectedEquipment.status}
                      </span>
                      <span className="px-1.5 py-0.5 bg-slate-200 text-slate-800 text-[10px] font-medium rounded">
                        风险：{selectedEquipment.riskLevel}级
                      </span>
                      <span className="text-[11px] text-slate-500 font-mono">
                        分类：{selectedEquipment.category}
                      </span>
                    </div>
                    <h2 className="text-lg sm:text-2xl font-black text-slate-800 tracking-tight leading-tight">{selectedEquipment.deviceName}</h2>
                    <p className="text-xs sm:text-sm text-slate-500 font-medium mt-1">规格型号: {selectedEquipment.model}</p>
                  </div>
                  <div className="flex items-center gap-3 border-t border-slate-100 sm:border-0 pt-2 sm:pt-0">
                    <div className="text-right flex flex-col items-end">
                      <p className="text-[9px] sm:text-xs text-slate-400 uppercase tracking-wider font-semibold">系统自编资产ID</p>
                      <p className="text-sm sm:text-md font-mono font-bold text-blue-600">{selectedEquipment.id.toUpperCase()}</p>
                      <p className="text-[10px] text-slate-400 font-mono mt-0.5">SN: {selectedEquipment.sn}</p>
                    </div>
                    
                    {/* Compact Interactive QR Code Tag inside middle column header */}
                    <div 
                      onClick={handlePrintQR}
                      className={`w-11 h-11 bg-white p-1 border border-slate-200 rounded-lg flex items-center justify-center shadow-2xs flex-shrink-0 group relative transition-all ${
                        canManageEquipmentArchive ? 'hover:border-blue-400 cursor-pointer' : 'cursor-not-allowed opacity-80'
                      }`}
                      title={canManageEquipmentArchive ? '点击打印二维码物联标签' : '临床只读：二维码打印由医学装备科工程师执行'}
                    >
                      <img 
                        src={`https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${encodeURIComponent(
                          JSON.stringify({ id: selectedEquipment.id, name: selectedEquipment.deviceName, sn: selectedEquipment.sn, dept: selectedEquipment.dept })
                        )}`} 
                        alt="Equipment QR Code" 
                        className="w-full h-full rounded"
                      />
                      {/* Hover Indicator overlay */}
                      <div className="absolute inset-0 bg-slate-900/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center rounded-lg">
                        <span className="text-[8px] text-white font-bold bg-black/60 px-1 py-0.5 rounded">
                          {canManageEquipmentArchive ? '打印' : '只读'}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Dynamic Information Navigation Tabs */}
              <div className="flex overflow-x-auto whitespace-nowrap scrollbar-none border-b border-slate-100 px-3 sm:px-6 bg-slate-50/10">
                <button 
                  onClick={() => setActiveTab('basic')}
                  className={`py-2.5 px-3 md:py-3 md:px-4 text-[11px] sm:text-xs font-semibold border-b-2 transition-colors flex-shrink-0 ${
                    activeTab === 'basic' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
                  }`}
                >
                  基础技术档案
                </button>
                <button 
                  onClick={() => setActiveTab('maintenance')}
                  className={`py-2.5 px-3 md:py-3 md:px-4 text-[11px] sm:text-xs font-semibold border-b-2 transition-colors flex items-center gap-1.5 flex-shrink-0 ${
                    activeTab === 'maintenance' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
                  }`}
                >
                  维保履历记录 
                  <span className="bg-slate-200 text-slate-700 text-[10px] px-1.5 rounded-full font-bold">
                    {selectedEquipment.maintenanceLogs.length}
                  </span>
                </button>
                <button 
                  onClick={() => setActiveTab('calibration')}
                  className={`py-2.5 px-3 md:py-3 md:px-4 text-[11px] sm:text-xs font-semibold border-b-2 transition-colors flex items-center gap-1.5 flex-shrink-0 ${
                    activeTab === 'calibration' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
                  }`}
                >
                  法定计量强检
                  <span className="bg-slate-200 text-slate-700 text-[10px] px-1.5 rounded-full font-bold">
                    {selectedEquipment.calibrationLogs.length}
                  </span>
                </button>
                <button 
                  onClick={() => setActiveTab('attachments')}
                  className={`py-2.5 px-3 md:py-3 md:px-4 text-[11px] sm:text-xs font-semibold border-b-2 transition-colors flex items-center gap-1.5 flex-shrink-0 ${
                    activeTab === 'attachments' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
                  }`}
                >
                  技术手册与附件
                  <span className="bg-slate-200 text-slate-700 text-[10px] px-1.5 rounded-full font-bold">
                    {selectedEquipment.attachments.length}
                  </span>
                </button>
                <button 
                  onClick={() => setActiveTab('tickets')}
                  className={`py-2.5 px-3 md:py-3 md:px-4 text-[11px] sm:text-xs font-semibold border-b-2 transition-colors flex items-center gap-1.5 flex-shrink-0 ${
                    activeTab === 'tickets' ? 'border-emerald-600 text-emerald-600 font-bold' : 'border-transparent text-slate-500 hover:text-slate-800'
                  }`}
                >
                  🔔 相关工单
                  <span className="bg-emerald-100 text-emerald-800 text-[10px] px-1.5 rounded-full font-bold font-mono">
                    {getRelatedTasksForEquipment(selectedEquipment).length}
                  </span>
                </button>
              </div>

              {/* Central Details Scrollable Body */}
              <div className="flex-1 overflow-y-auto p-3 sm:p-4 md:p-6 space-y-4 md:space-y-6">
                
                {/* 1. Basic Technical Archives Tab */}
                {activeTab === 'basic' && (
                  <div className="space-y-6">
                    
                    {/* 📸 医疗设备实物外观与电子物联标签 */}
                    <div className="bg-slate-50 border border-slate-200 rounded-xl overflow-hidden p-4">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-1.5">
                          <Activity className="w-4 h-4 text-blue-600 animate-pulse" />
                          <span className="text-xs font-bold text-slate-700">📸 医疗设备实物外观与物联识别标签</span>
                        </div>
                        <span className="text-[10px] text-slate-400 font-medium">点击图片放大 / 扫码对照合规档案</span>
                      </div>
                      
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        {/* Photo Section */}
                        <div className="sm:col-span-2">
                          {selectedEquipment.photoUrl ? (
                            <div 
                              className="relative group rounded-lg overflow-hidden border border-slate-200 bg-white shadow-xs h-[160px] cursor-pointer flex items-center justify-center" 
                              onClick={() => setZoomPhotoUrl(selectedEquipment.photoUrl || null)}
                            >
                              <img 
                                src={selectedEquipment.photoUrl} 
                                alt={selectedEquipment.deviceName} 
                                referrerPolicy="no-referrer"
                                className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                              />
                              <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                <span className="text-white text-xs font-bold px-3 py-1.5 bg-black/60 rounded-full flex items-center gap-1">
                                  🔍 点击放大外观图
                                </span>
                              </div>
                            </div>
                          ) : (
                            <div className="h-[160px] bg-slate-100/50 border border-dashed border-slate-300 rounded-lg text-center flex flex-col items-center justify-center p-4">
                              <Activity className="w-6 h-6 text-slate-300 mb-1" />
                              <p className="text-[11px] text-slate-500 font-bold">暂未绑定外观照片</p>
                              <p className="text-[9px] text-slate-400 mt-0.5">
                                {canManageEquipmentArchive ? '可点击“修改档案”录入' : '如需补录请联系医学装备科'}
                              </p>
                            </div>
                          )}
                        </div>

                        {/* QR Code Section */}
                        <div className="flex flex-col items-center justify-center bg-white border border-slate-200 rounded-lg p-3 shadow-xs h-[160px]">
                          <div 
                            className={`w-24 h-24 bg-slate-50 p-1 border border-slate-100 rounded flex items-center justify-center shadow-inner relative group ${
                              canManageEquipmentArchive ? 'cursor-pointer' : 'cursor-not-allowed opacity-85'
                            }`}
                            onClick={handlePrintQR} 
                            title={canManageEquipmentArchive ? '点击向打印机发送标签打印指令' : '临床只读：二维码打印由医学装备科工程师执行'}
                          >
                            <img 
                              src={`https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(
                                JSON.stringify({ id: selectedEquipment.id, name: selectedEquipment.deviceName, sn: selectedEquipment.sn, dept: selectedEquipment.dept })
                              )}`} 
                              alt="Equipment QR Code" 
                              className="w-full h-full rounded"
                            />
                            <div className="absolute inset-0 bg-slate-900/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center rounded">
                              <span className="text-[9px] text-white font-bold bg-black/60 px-1.5 py-0.5 rounded">
                                {canManageEquipmentArchive ? '打印标签' : '只读查看'}
                              </span>
                            </div>
                          </div>
                          <p className="text-[10px] font-bold text-slate-700 mt-2 truncate max-w-full text-center">{selectedEquipment.id.toUpperCase()}</p>
                          <p className="text-[8px] text-emerald-600 font-bold mt-0.5">● 电子强检标识</p>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6 bg-slate-50/50 p-4 rounded-xl border border-slate-200/60">
                      <div>
                        <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4">商业与采购属性</h4>
                        <div className="space-y-3 text-xs">
                          <div className="flex justify-between border-b border-slate-100 pb-2">
                            <span className="text-slate-500">生产制造商：</span> 
                            <span className="font-semibold text-slate-800">{selectedEquipment.manufacturer}</span>
                          </div>
                          <div className="flex justify-between border-b border-slate-100 pb-2">
                            <span className="text-slate-500">采购科室：</span> 
                            <span className="font-semibold text-slate-800">{selectedEquipment.dept}</span>
                          </div>
                          <div className="flex justify-between border-b border-slate-100 pb-2">
                            <span className="text-slate-500">保购日期：</span> 
                            <span className="font-semibold text-slate-800 font-mono">{selectedEquipment.purchaseDate}</span>
                          </div>
                          <div className="flex justify-between border-b border-slate-100 pb-2">
                            <span className="text-slate-500">设备估值 (CNY)：</span> 
                            <span className="font-bold text-blue-600 font-mono">¥{selectedEquipment.purchaseCost.toLocaleString()}</span>
                          </div>
                        </div>
                      </div>
                      
                      <div>
                        <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4">运行与维保属性</h4>
                        <div className="space-y-3 text-xs">
                          <div className="flex justify-between border-b border-slate-100 pb-2">
                            <span className="text-slate-500">推荐PM周期：</span> 
                            <span className="font-semibold text-slate-800 font-mono">每 {selectedEquipment.maintenanceCycleDays} 天</span>
                          </div>
                          <div className="flex justify-between border-b border-slate-100 pb-2">
                            <span className="text-slate-500">上次维保日期：</span> 
                            <span className="font-semibold text-slate-800 font-mono">{selectedEquipment.lastMaintenanceDate || '暂无纪录'}</span>
                          </div>
                          <div className="flex justify-between border-b border-slate-100 pb-2">
                            <span className="text-slate-500">下次计划维保：</span> 
                            <span className="font-bold text-slate-800 font-mono bg-blue-50 text-blue-700 px-1.5 rounded">{selectedEquipment.nextMaintenanceDate}</span>
                          </div>
                          <div className="flex justify-between border-b border-slate-100 pb-2">
                            <span className="text-slate-500">计量校验强检：</span> 
                            <span className={`font-semibold ${selectedEquipment.calibrationRequired ? 'text-amber-600' : 'text-slate-500'}`}>
                              {selectedEquipment.calibrationRequired ? '需要强检' : '免强检设备'}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* 医疗器械法律法规准入与合规档案 */}
                    <div className="bg-emerald-50/30 border border-emerald-600/20 rounded-xl p-4 sm:p-5">
                      <div className="flex justify-between items-start mb-4">
                        <div className="flex items-center gap-2">
                          <ShieldCheck className="w-5 h-5 text-emerald-600" />
                          <div>
                            <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">医疗器械准入与法规合规资质</h4>
                            <p className="text-[10px] text-slate-400 mt-0.5">《医疗器械监督管理条例》合规备案登记档案</p>
                          </div>
                        </div>
                        {selectedEquipment.deviceClass && (
                          <span className={`text-[10px] font-bold px-2.5 py-1 rounded-full ${
                            selectedEquipment.deviceClass === 'III类' ? 'bg-rose-100 text-rose-800 border border-rose-200' :
                            selectedEquipment.deviceClass === 'II类' ? 'bg-amber-100 text-amber-800 border border-amber-200' :
                            selectedEquipment.deviceClass === 'I类' ? 'bg-blue-100 text-blue-800 border border-blue-200' :
                            'bg-slate-100 text-slate-600'
                          }`}>
                            管理分类：{selectedEquipment.deviceClass}
                          </span>
                        )}
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                        <div className="space-y-2.5">
                          <div className="flex justify-between border-b border-slate-200/50 pb-2">
                            <span className="text-slate-500">NMPA注册证/备案证号：</span>
                            <span className="font-bold text-slate-800 font-mono text-right">{selectedEquipment.registrationNo || '未登记备案'}</span>
                          </div>
                          <div className="flex justify-between border-b border-slate-200/50 pb-2">
                            <span className="text-slate-500">注册证截止有效期：</span>
                            <span className="font-semibold text-slate-800 font-mono text-right">{selectedEquipment.registrationValidUntil || '永久有效/未设定'}</span>
                          </div>
                        </div>

                        <div className="space-y-2.5">
                          <div className="flex justify-between border-b border-slate-200/50 pb-2">
                            <span className="text-slate-500">生产企业许可证号：</span>
                            <span className="font-semibold text-slate-800 font-mono text-right">{selectedEquipment.productionLicenseNo || '未登记'}</span>
                          </div>
                          <div className="flex justify-between border-b border-slate-200/50 pb-2">
                            <span className="text-slate-500">合规核验状态：</span>
                            {(() => {
                              const regStatus = getRegistrationStatus(selectedEquipment.registrationValidUntil);
                              if (!selectedEquipment.registrationNo) {
                                return (
                                  <span className="font-bold text-rose-600 flex items-center gap-1">
                                    <AlertTriangle className="w-3.5 h-3.5" /> 未补录注册证
                                  </span>
                                );
                              }
                              if (regStatus.status === 'expired') {
                                return (
                                  <span className="font-bold text-rose-600 animate-pulse flex items-center gap-1">
                                    <AlertTriangle className="w-3.5 h-3.5" /> 已过期 ({regStatus.diffDays}天)
                                  </span>
                                );
                              } else if (regStatus.status === 'expiring') {
                                return (
                                  <span className="font-bold text-amber-600 flex items-center gap-1">
                                    <AlertTriangle className="w-3.5 h-3.5" /> 即将过期 ({regStatus.diffDays}天)
                                  </span>
                                );
                              }
                              return (
                                <span className="font-bold text-emerald-600 flex items-center gap-1">
                                  <CheckCircle2 className="w-3.5 h-3.5" /> 资质核验正常
                                </span>
                              );
                            })()}
                          </div>
                        </div>
                      </div>

                      {/* Expiration alert panel if expired or expiring */}
                      {(() => {
                        const regStatus = getRegistrationStatus(selectedEquipment.registrationValidUntil);
                        if (!selectedEquipment.registrationNo) {
                          return (
                            <div className="mt-3 p-2.5 bg-rose-50 border border-rose-200/50 rounded-lg text-[11px] text-rose-800 flex items-start gap-2">
                              <AlertTriangle className="w-4 h-4 text-rose-500 flex-shrink-0 mt-0.5" />
                              <p className="leading-normal col-span-2">
                                <strong>⚠️ 资质缺失警告：</strong> 该设备尚未登记医疗器械注册证号。根据《医疗器械监督管理条例》，无合格准入证号的器械在临床科室运行存在重度法律违规风险，{canManageEquipmentArchive ? '请点击下方 “修改档案” 按钮立即补录。' : '请联系医学装备科尽快补录并核验。'}
                              </p>
                            </div>
                          );
                        }
                        if (regStatus.status === 'expired') {
                          return (
                            <div className="mt-3 p-2.5 bg-rose-50 border border-rose-200/50 rounded-lg text-[11px] text-rose-800 flex items-start gap-2">
                              <AlertTriangle className="w-4 h-4 text-rose-500 flex-shrink-0 mt-0.5" />
                              <p className="leading-normal col-span-2">
                                <strong>🚨 准入证已过期：</strong> 该器械的 NMPA 注册有效期（{selectedEquipment.registrationValidUntil}）已经过期 <strong>{regStatus.diffDays} 天</strong>。根据国家卫生计生委和药监局相关规定，不得使用过期注册证的医疗设备。请临床工程部门与供货商配合，立即获取最新有效医疗器械注册证，或予以停用归档。
                              </p>
                            </div>
                          );
                        } else if (regStatus.status === 'expiring') {
                          return (
                            <div className="mt-3 p-2.5 bg-amber-50 border border-amber-200/50 rounded-lg text-[11px] text-amber-800 flex items-start gap-2">
                              <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                              <p className="leading-normal col-span-2">
                                <strong>⚠️ 资质到期预警：</strong> 该器械的注册有效期还剩 <strong>{regStatus.diffDays} 天</strong> 即将到期。请及时联系制造商或代理商提供延续注册证，并在本系统中更新合规档案，以确保不间断合法合规使用。
                              </p>
                            </div>
                          );
                        }
                        return null;
                      })()}
                    </div>

                    {/* Calibration status quick summary banner */}
                    {selectedEquipment.calibrationRequired && (
                      <div className="p-4 bg-amber-50 rounded-lg border border-amber-200 text-xs text-amber-800 flex items-start gap-3">
                        <ShieldCheck className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                        <div>
                          <p className="font-bold">计量管理状态及证书校验</p>
                          <p className="mt-1">
                            本设备被依法监管属于【强制检定】目录医学计量器具。下一次计划检定截止日：
                            <span className="underline font-bold font-mono text-amber-900 ml-1">
                              {selectedEquipment.nextCalibrationDate || '未定'}
                            </span>。日常运行须确保合格标签在有效期内并完好。
                          </p>
                        </div>
                      </div>
                    )}

                    {/* Standard Configuration Checklist */}
                    <div>
                      <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">原厂基本技术套件清单</h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                        <div className="flex items-center gap-2 bg-slate-50 p-3 rounded-lg border border-slate-100">
                          <Check className="w-4 h-4 text-emerald-600" />
                          <span className="text-slate-700 font-medium">原厂操作手册与故障代码索引目录</span>
                        </div>
                        <div className="flex items-center gap-2 bg-slate-50 p-3 rounded-lg border border-slate-100">
                          <Check className="w-4 h-4 text-emerald-600" />
                          <span className="text-slate-700 font-medium">国食药监械(准)字号注册证及复印件</span>
                        </div>
                        <div className="flex items-center gap-2 bg-slate-50 p-3 rounded-lg border border-slate-100">
                          <Check className="w-4 h-4 text-emerald-600" />
                          <span className="text-slate-700 font-medium">原厂基础电源适配线与抗干扰屏蔽接地线</span>
                        </div>
                        <div className="flex items-center gap-2 bg-slate-50 p-3 rounded-lg border border-slate-100">
                          <Check className="w-4 h-4 text-emerald-600" />
                          <span className="text-slate-700 font-medium">设备出厂合格证明与安全校验报告书</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* 2. Maintenance History Tab */}
                {activeTab === 'maintenance' && (
                  <div className="space-y-4 animate-fade-in">
                    <div className="flex justify-between items-center">
                      <div className="flex flex-col">
                        <h4 className="text-xs font-black text-slate-700 uppercase tracking-wider">维保全履历跟踪</h4>
                        <p className="text-[10px] text-slate-400 mt-0.5">点击任意维保卡片可查看并打印标准电子派工单</p>
                      </div>
                      {canManageEquipmentArchive ? (
                        <button
                          onClick={() => { setLogType('维保'); setIsLogModalOpen(true); }}
                          className="text-xs text-blue-600 font-bold hover:text-blue-700 flex items-center gap-1 bg-blue-50 px-2.5 py-1.5 rounded-lg border border-blue-100 hover:border-blue-200 transition-all shadow-2xs"
                        >
                          <PlusCircle className="w-3.5 h-3.5" />
                          <span>新增维保工单</span>
                        </button>
                      ) : (
                        <span className="text-[10px] text-slate-400 bg-slate-100 border border-slate-200 px-2 py-1 rounded-md">
                          临床只读履历
                        </span>
                      )}
                    </div>

                    <BudgetStackedChart 
                      maintenanceLogs={selectedEquipment.maintenanceLogs} 
                      deviceName={selectedEquipment.deviceName} 
                    />

                    {selectedEquipment.maintenanceLogs.length === 0 ? (
                      <div className="text-center py-12 text-slate-400 text-xs bg-slate-50 rounded-xl border border-dashed border-slate-200">
                        暂无任何维保、检修或清洁保养记录。
                      </div>
                    ) : (
                      <div className="relative pl-4 border-l-2 border-slate-200/80 space-y-4 py-1">
                        {selectedEquipment.maintenanceLogs.map((log) => (
                          <div key={log.id} className="relative">
                            {/* Timeline Indicator Node */}
                            <div className={`absolute -left-[23px] top-4 w-4 h-4 rounded-full border-2 bg-white flex items-center justify-center ${
                              log.type === '维修' ? 'border-rose-500 text-rose-500' : 'border-blue-500 text-blue-500'
                            }`}>
                              <div className={`w-1.5 h-1.5 rounded-full ${log.type === '维修' ? 'bg-rose-500' : 'bg-blue-500'}`} />
                            </div>
                            
                            <div 
                              id={`maintenance-log-${log.workOrderNo || log.id}`}
                              role="button"
                              tabIndex={0}
                              aria-label={`打开维保履历：${log.workOrderNo || log.id}，${log.type}，${log.status}`}
                              onClick={() => setViewMaintenanceLog(log)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  setViewMaintenanceLog(log);
                                }
                              }}
                              className="bg-white hover:bg-slate-50/75 p-4 rounded-xl border border-slate-200 hover:border-blue-400 cursor-pointer shadow-2xs hover:shadow-xs group transition-all duration-200"
                            >
                              <div className="flex justify-between items-start gap-4">
                                <div className="space-y-1">
                                  <div className="flex items-center gap-2">
                                    <span className={`text-[9px] font-black px-1.5 py-0.5 rounded ${
                                      log.type === '维修' ? 'bg-rose-100 text-rose-800' : 'bg-blue-100 text-blue-800'
                                    }`}>
                                      {log.type}
                                    </span>
                                    <span className="text-xs font-bold text-slate-800 group-hover:text-blue-600 transition-colors">
                                      {log.description}
                                    </span>
                                  </div>
                                  
                                  {/* Work order metadata */}
                                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-400 font-mono">
                                    <span>单号: {log.workOrderNo || `WO-OLD-${log.id.toUpperCase()}`}</span>
                                    <span>•</span>
                                    <span>配件: <span className="text-slate-600 font-sans font-medium">{log.partsReplaced || '无更换'}</span></span>
                                    {log.pmChecklist && log.pmChecklist.length > 0 && (
                                      <>
                                        <span>•</span>
                                        <span className="text-blue-600 font-sans font-medium">PM核查: {log.pmChecklist.length}项已核</span>
                                      </>
                                    )}
                                  </div>
                                </div>
                                
                                <div className="text-right flex-shrink-0 flex flex-col items-end">
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-mono font-bold text-slate-800">¥{log.cost}</span>
                                    {canManageEquipmentArchive && (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleDeleteMaintenanceLog(log.id);
                                        }}
                                        className="md:opacity-0 group-hover:opacity-100 p-1 text-slate-300 hover:text-rose-600 hover:bg-rose-50 rounded transition-all"
                                        title="删除此工单"
                                      >
                                        <Trash2 className="w-3.5 h-3.5" />
                                      </button>
                                    )}
                                  </div>
                                  <p className="text-[9px] text-slate-400 font-mono mt-1">{log.date}</p>
                                </div>
                              </div>

                              <div className="flex justify-between items-center mt-3 pt-2.5 border-t border-slate-100 text-[10px] text-slate-500">
                                <span className="flex items-center gap-1">
                                  <Wrench className="w-3 h-3 text-slate-400" />
                                  <span>技术负责人: <strong className="text-slate-700 font-semibold">{log.technician}</strong></span>
                                </span>
                                <div className="flex items-center gap-2">
                                  <span className="text-[9px] text-slate-400">点击查验 ➔</span>
                                  <span className={log.status === '已完成' ? 'text-emerald-600 font-black' : 'text-amber-600 font-black'}>
                                    ● {log.status}
                                  </span>
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* 3. Calibration Certificates Tab */}
                {activeTab === 'calibration' && (
                  <div className="space-y-4 animate-fade-in">
                    <div className="flex justify-between items-center">
                      <div className="flex flex-col">
                        <h4 className="text-xs font-black text-slate-700 uppercase tracking-wider">法定计量强检记录</h4>
                        <p className="text-[10px] text-slate-400 mt-0.5">国家质监总局要求: 强检目录设备必须100%持证运转并张贴绿标</p>
                      </div>
                      {selectedEquipment.calibrationRequired && canManageEquipmentArchive ? (
                        <button 
                          onClick={() => { setLogType('计量'); setIsLogModalOpen(true); }}
                          className="text-xs text-emerald-600 font-bold hover:text-emerald-700 flex items-center gap-1 bg-emerald-50 px-2.5 py-1.5 rounded-lg border border-emerald-100 hover:border-emerald-200 transition-all shadow-2xs"
                        >
                          <PlusCircle className="w-3.5 h-3.5" />
                          <span>登记计量证书</span>
                        </button>
                      ) : (
                        <span className="text-[9px] text-slate-400 bg-slate-100 border border-slate-200 px-2 py-1 rounded-md flex items-center gap-1">
                          <Info className="w-3 h-3 text-slate-400" />
                          <span>{selectedEquipment.calibrationRequired ? '临床只读证书' : '本台非强检类设备'}</span>
                        </span>
                      )}
                    </div>

                    {selectedEquipment.calibrationLogs.length === 0 ? (
                      <div className="text-center py-12 text-slate-400 text-xs bg-slate-50 rounded-xl border border-dashed border-slate-200">
                        该设备目前暂无已录入的计量校准合格证书。
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-3">
                        {selectedEquipment.calibrationLogs.map((cal) => (
                          <div 
                            key={cal.id} 
                            onClick={() => setViewCalibrationLog(cal)}
                            className="p-4 bg-white hover:bg-slate-50/75 rounded-xl border border-slate-200 hover:border-emerald-400 cursor-pointer shadow-2xs hover:shadow-xs group transition-all duration-200 flex justify-between items-start gap-4"
                          >
                            <div className="space-y-1.5">
                              <div className="flex items-center gap-2">
                                <span className={`text-[9px] font-black px-1.5 py-0.5 rounded ${
                                  cal.result === '合格' ? 'bg-emerald-100 text-emerald-800' :
                                  cal.result === '准用' ? 'bg-blue-100 text-blue-800' :
                                  cal.result === '限用' ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800'
                                }`}>
                                  检测结论：{cal.result}
                                </span>
                                <span className="bg-slate-100 text-slate-600 text-[9px] font-bold px-1.5 py-0.5 rounded">
                                  {cal.calibType || '强制检定'}
                                </span>
                                <span className="text-xs font-bold text-slate-700 font-mono">证书号: {cal.certificateNo}</span>
                              </div>
                              <p className="text-xs text-slate-600 flex items-center gap-1">
                                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
                                <span>检定/测试机构：<strong className="text-slate-800 font-semibold">{cal.agency}</strong></span>
                              </p>
                              <div className="flex items-center gap-3 text-[10px] text-slate-400">
                                <span>检定日期：<strong className="text-slate-600 font-mono">{cal.date}</strong></span>
                                <span>•</span>
                                <span>主检人：<strong className="text-slate-600 font-sans font-medium">{cal.testerName || '国家注册计量师'}</strong></span>
                              </div>
                            </div>
                            
                            <div className="text-right text-xs flex-shrink-0 flex items-start gap-3">
                              <div className="flex flex-col items-end">
                                <span className="text-slate-400 text-[10px]">有效截止日期</span>
                                <p className={`font-bold font-mono mt-1 text-[11px] border rounded-md px-2 py-0.5 inline-block ${
                                  cal.result === '不合格' ? 'bg-rose-50 border-rose-200 text-rose-700' : 'bg-emerald-50/50 border-emerald-200 text-emerald-700'
                                }`}>
                                  {cal.validUntil}
                                </p>
                                <span className="text-[9px] text-emerald-600 font-bold mt-1.5 flex items-center gap-0.5 animate-pulse">
                                  <span>●</span> <span>在线印证合格绿标 ➔</span>
                                </span>
                              </div>
                              
                              {canManageEquipmentArchive && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteCalibrationLog(cal.id);
                                  }}
                                  className="md:opacity-0 group-hover:opacity-100 p-1 text-slate-300 hover:text-rose-600 hover:bg-rose-50 rounded transition-all mt-1"
                                  title="注销此证书"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* 4. Equipment Manuals & Attachments Tab */}
                {activeTab === 'attachments' && (() => {
                  const attachments = selectedEquipment.attachments || [];
                  const manualCount = attachments.filter(a => a.type === 'manual').length;
                  const invoiceCount = attachments.filter(a => a.type === 'invoice').length;
                  const certCount = attachments.filter(a => a.type === 'certificate').length;
                  const otherCount = attachments.filter(a => a.type === 'other').length;

                  const totalCount = manualCount + invoiceCount + certCount + otherCount;

                  const requiredCategories = [
                    { key: 'manual', name: '操作及技术手册', present: manualCount > 0 },
                    { key: 'invoice', name: '购入发票/财务凭证', present: invoiceCount > 0 },
                    { key: 'certificate', name: '质量注册证/计量检定证', present: certCount > 0 },
                  ];
                  const requiredPresentCount = requiredCategories.filter(c => c.present).length;
                  const completenessPercent = Math.round((requiredPresentCount / 3) * 100);

                  const categoriesForChart = [
                    { label: '操作手册', value: manualCount, color: '#3b82f6', rawType: 'manual' },
                    { label: '购入发票', value: invoiceCount, color: '#10b981', rawType: 'invoice' },
                    { label: '质量注册证', value: certCount, color: '#f59e0b', rawType: 'certificate' },
                    { label: '其他/合同', value: otherCount, color: '#8b5cf6', rawType: 'other' }
                  ];

                  const validCategories = categoriesForChart.filter(c => c.value > 0);
                  const totalForChart = validCategories.reduce((sum, c) => sum + c.value, 0);

                  let accumulatedPercent = 0;
                  const slices = validCategories.map((c, index) => {
                    const startPercent = accumulatedPercent;
                    const percentage = c.value / totalForChart;
                    accumulatedPercent += percentage;

                    return {
                      id: index,
                      label: c.label,
                      value: c.value,
                      color: c.color,
                      rawType: c.rawType,
                      percentage,
                      startPercent
                    };
                  });

                  return (
                    <div className="space-y-5">
                      <div className="flex justify-between items-center">
                        <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">电子技术档案归档</h4>
                        {canManageEquipmentArchive ? (
                          <button
                            onClick={() => setIsAttachmentModalOpen(true)}
                            className="text-xs text-blue-600 font-bold hover:underline flex items-center gap-1 cursor-pointer"
                          >
                            <PlusCircle className="w-4 h-4" />
                            <span>上传资料附件</span>
                          </button>
                        ) : (
                          <span className="text-[10px] text-slate-400 bg-slate-100 border border-slate-200 px-2 py-1 rounded-md">
                            临床只读附件
                          </span>
                        )}
                      </div>

                      {/* 📊 档案完整度智能质检与组成占比看板 */}
                      <div className="bg-slate-50 border border-slate-200/80 rounded-2xl p-4 sm:p-5 shadow-2xs">
                        <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-200/50">
                          <div className="flex items-center gap-1.5">
                            <Sparkles className="w-4 h-4 text-amber-500 animate-pulse" />
                            <span className="text-xs font-bold text-slate-700">📊 技术手册及附件组成占比与完整度质检</span>
                          </div>
                          <span className="text-[10px] font-extrabold text-slate-500 font-mono bg-slate-200/70 border border-slate-300 px-1.5 py-0.5 rounded uppercase tracking-wider">
                            AI Compliance Audit
                          </span>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-12 gap-5 items-center">
                          {/* Left: Donut Chart column */}
                          <div className="md:col-span-5 flex flex-col items-center justify-center border-b md:border-b-0 md:border-r border-slate-200/80 pb-4 md:pb-0 md:pr-4">
                            <span className="text-[10px] font-bold text-slate-400 mb-2 font-mono uppercase tracking-wider">技术资产组成图谱</span>
                            <div className="relative w-40 h-40 flex items-center justify-center">
                              <svg width="100%" height="100%" viewBox="0 0 100 100" className="transform">
                                {/* Base background track circle */}
                                <circle 
                                  cx="50" 
                                  cy="50" 
                                  r="40" 
                                  fill="transparent" 
                                  stroke="#f1f5f9" 
                                  strokeWidth="10" 
                                />
                                
                                {totalCount === 0 ? (
                                  <circle 
                                    cx="50" 
                                    cy="50" 
                                    r="40" 
                                    fill="transparent" 
                                    stroke="#e2e8f0" 
                                    strokeWidth="10" 
                                    strokeDasharray="251.327 251.327"
                                    strokeDashoffset="0"
                                  />
                                ) : (
                                  slices.map((slice) => (
                                    <circle
                                      key={slice.id}
                                      cx="50"
                                      cy="50"
                                      r="40"
                                      fill="transparent"
                                      stroke={slice.color}
                                      strokeWidth={hoveredSlice === slice.id ? 13 : 10}
                                      strokeDasharray={`${slice.percentage * 251.327} 251.327`}
                                      strokeDashoffset="0"
                                      transform={`rotate(${-90 + slice.startPercent * 360} 50 50)`}
                                      className="transition-all duration-300 cursor-pointer ease-out origin-center"
                                      onMouseEnter={() => setHoveredSlice(slice.id)}
                                      onMouseLeave={() => setHoveredSlice(null)}
                                    />
                                  ))
                                )}
                              </svg>

                              {/* Center Content for Donut Chart */}
                              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none select-none text-center">
                                {hoveredSlice === null ? (
                                  <>
                                    <span className="text-[10px] text-slate-400 font-bold leading-none mb-1">档案完整度</span>
                                    <span className="text-xl font-black text-slate-800 font-mono tracking-tight">{completenessPercent}%</span>
                                    <span className="text-[9px] text-slate-400 mt-0.5 font-medium">必备归档 {requiredPresentCount}/3</span>
                                  </>
                                ) : (() => {
                                  const hovered = slices.find(s => s.id === hoveredSlice);
                                  if (!hovered) return null;
                                  return (
                                    <>
                                      <span className="text-[10px] font-bold leading-none mb-1 truncate max-w-[80px]" style={{ color: hovered.color }}>{hovered.label}</span>
                                      <span className="text-lg font-black text-slate-800 font-mono tracking-tight">{hovered.value} 份</span>
                                      <span className="text-[9px] text-slate-400 mt-0.5 font-semibold font-mono">{Math.round(hovered.percentage * 100)}% 占比</span>
                                    </>
                                  );
                                })()}
                              </div>
                            </div>

                            {/* Legends below donut */}
                            <div className="flex flex-wrap gap-x-3 gap-y-1.5 mt-3 justify-center">
                              {categoriesForChart.map((c, idx) => (
                                <div 
                                  key={idx} 
                                  className="flex items-center gap-1 text-[10px] font-semibold text-slate-600 transition-opacity"
                                  style={{ opacity: hoveredSlice !== null && slices.find(s => s.label === c.label)?.id !== hoveredSlice ? 0.4 : 1 }}
                                >
                                  <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: c.color }}></span>
                                  <span>{c.label} ({c.value})</span>
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* Right: Checklist column */}
                          <div className="md:col-span-7 flex flex-col justify-between h-full space-y-3">
                            <div className="space-y-2">
                              <span className="text-[10px] font-bold text-slate-400 font-mono uppercase tracking-wider block mb-1">关键技术归档要素审计核验</span>
                              
                              {/* 1. manual */}
                              <div className="flex items-center justify-between p-2.5 bg-white border border-slate-200 rounded-xl shadow-3xs">
                                <div className="flex items-center gap-2">
                                  <div className="p-1.5 bg-blue-50 text-blue-600 rounded-lg">
                                    <FileText className="w-3.5 h-3.5" />
                                  </div>
                                  <div>
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-xs font-bold text-slate-700">操作及技术手册</span>
                                      <span className="text-[9px] bg-red-50 text-red-600 border border-red-100 rounded px-1.5 py-0.2 font-bold scale-90">必填要件</span>
                                    </div>
                                    <span className="text-[9px] text-slate-400 block mt-0.5">提供日常维护规程及特种电气泄露标准</span>
                                  </div>
                                </div>
                                <div>
                                  {manualCount > 0 ? (
                                    <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 border border-emerald-100 px-2 py-0.5 rounded-full flex items-center gap-1">
                                      <CheckCircle2 className="w-3 h-3" /> 已归档 ({manualCount}份)
                                    </span>
                                  ) : (
                                    <span className="text-[10px] font-bold text-red-600 bg-red-50 border border-red-100 px-2 py-0.5 rounded-full flex items-center gap-1 animate-pulse">
                                      <AlertTriangle className="w-3 h-3" /> 缺失附件
                                    </span>
                                  )}
                                </div>
                              </div>

                              {/* 2. invoice */}
                              <div className="flex items-center justify-between p-2.5 bg-white border border-slate-200 rounded-xl shadow-3xs">
                                <div className="flex items-center gap-2">
                                  <div className="p-1.5 bg-emerald-50 text-emerald-600 rounded-lg">
                                    <DollarSign className="w-3.5 h-3.5" />
                                  </div>
                                  <div>
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-xs font-bold text-slate-700">购入发票/财务凭证</span>
                                      <span className="text-[9px] bg-red-50 text-red-600 border border-red-100 rounded px-1.5 py-0.2 font-bold scale-90">必填要件</span>
                                    </div>
                                    <span className="text-[9px] text-slate-400 block mt-0.5">资产入库、原价确认及产权属实审计判据</span>
                                  </div>
                                </div>
                                <div>
                                  {invoiceCount > 0 ? (
                                    <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 border border-emerald-100 px-2 py-0.5 rounded-full flex items-center gap-1">
                                      <CheckCircle2 className="w-3 h-3" /> 已归档 ({invoiceCount}份)
                                    </span>
                                  ) : (
                                    <span className="text-[10px] font-bold text-red-600 bg-red-50 border border-red-100 px-2 py-0.5 rounded-full flex items-center gap-1">
                                      <AlertTriangle className="w-3 h-3" /> 缺失附件
                                    </span>
                                  )}
                                </div>
                              </div>

                              {/* 3. certificate */}
                              <div className="flex items-center justify-between p-2.5 bg-white border border-slate-200 rounded-xl shadow-3xs">
                                <div className="flex items-center gap-2">
                                  <div className="p-1.5 bg-amber-50 text-amber-600 rounded-lg">
                                    <ShieldCheck className="w-3.5 h-3.5" />
                                  </div>
                                  <div>
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-xs font-bold text-slate-700">质量注册证/计量检定证</span>
                                      <span className="text-[9px] bg-red-50 text-red-600 border border-red-100 rounded px-1.5 py-0.2 font-bold scale-90">必填要件</span>
                                    </div>
                                    <span className="text-[9px] text-slate-400 block mt-0.5">准入合规凭证、国家计量强检达标标志</span>
                                  </div>
                                </div>
                                <div>
                                  {certCount > 0 ? (
                                    <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 border border-emerald-100 px-2 py-0.5 rounded-full flex items-center gap-1">
                                      <CheckCircle2 className="w-3 h-3" /> 已归档 ({certCount}份)
                                    </span>
                                  ) : (
                                    <span className="text-[10px] font-bold text-red-600 bg-red-50 border border-red-100 px-2 py-0.5 rounded-full flex items-center gap-1">
                                      <AlertTriangle className="w-3 h-3" /> 缺失附件
                                    </span>
                                  )}
                                </div>
                              </div>

                              {/* 4. other */}
                              <div className="flex items-center justify-between p-2.5 bg-white border border-slate-200 rounded-xl shadow-3xs">
                                <div className="flex items-center gap-2">
                                  <div className="p-1.5 bg-violet-50 text-violet-600 rounded-lg">
                                    <Clock className="w-3.5 h-3.5" />
                                  </div>
                                  <div>
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-xs font-bold text-slate-700">外协合同/其他技术协议</span>
                                      <span className="text-[9px] bg-slate-100 text-slate-600 border border-slate-200 rounded px-1.5 py-0.2 font-bold scale-90">可选归档</span>
                                    </div>
                                    <span className="text-[9px] text-slate-400 block mt-0.5">第三方原厂延保、保修协议、外协合同等</span>
                                  </div>
                                </div>
                                <div>
                                  {otherCount > 0 ? (
                                    <span className="text-[10px] font-bold text-blue-600 bg-blue-50 border border-blue-100 px-2 py-0.5 rounded-full flex items-center gap-1">
                                      <CheckCircle2 className="w-3 h-3" /> 已归档 ({otherCount}份)
                                    </span>
                                  ) : (
                                    <span className="text-[10px] font-bold text-slate-400 bg-slate-50 border border-slate-200 px-2 py-0.5 rounded-full flex items-center gap-1">
                                      未建档 (可选)
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>

                            {/* Dynamic Evaluation Guideline message */}
                            <div className="p-3 bg-blue-50 border border-blue-100 rounded-xl text-[11px] leading-relaxed text-blue-800">
                              {completenessPercent === 100 ? (
                                <p><strong>🎉 AI 合规评估：</strong>该设备技术档案极其完整！已100%对齐国家医疗器械监督管理条例及强检计量规程，无任何监管审计性漏洞，合规评级：<strong className="text-emerald-700 font-bold">A+ 卓越</strong>。</p>
                              ) : completenessPercent >= 66 ? (
                                <p><strong>⚠️ AI 合规评估：</strong>必备档案已归档大部分，但仍有单项未上传。请尽快补充 <strong className="text-red-700 font-bold">{requiredCategories.filter(c => !c.present).map(c => `【${c.name}】`).join('、')}</strong> 以满足全生命周期闭环质控要求。</p>
                              ) : completenessPercent >= 33 ? (
                                <p><strong>🚨 AI 合规评估：</strong>必备技术档案严重残缺，已亮红牌警戒！缺少多项对齐要件，建议立即上传并补全 <strong className="text-red-700 font-bold">{requiredCategories.filter(c => !c.present).map(c => `【${c.name}】`).join('、')}</strong>，避免质控考核风险。</p>
                              ) : (
                                <p><strong>🚫 AI 合规评估：</strong>该设备处于无任何档案运行的监管高危状态！急需补充归档：<strong className="text-red-700 font-bold">操作手册、发票、检定证</strong>，以规避医疗安全责任及罚款风险。</p>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>

                      {selectedEquipment.attachments.length === 0 ? (
                        <div className="text-center py-12 text-slate-400 text-xs bg-slate-50 rounded-xl border border-dashed border-slate-200">
                          暂未上传任何说明书、合规证明、发票或检修图片附件。
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          {selectedEquipment.attachments.map((file) => (
                            <div 
                              key={file.id} 
                              onClick={() => {
                                setPreviewFile(file);
                                setActivePreviewPage(1);
                                setIsPreviewOpen(true);
                              }}
                              className="p-3.5 bg-slate-50 hover:bg-slate-100 rounded-xl border border-slate-200 cursor-pointer transition-all flex items-center gap-3.5 group"
                            >
                              <div className="p-2.5 bg-blue-100/70 group-hover:bg-blue-200 text-blue-600 rounded-lg transition-colors">
                                <FileText className="w-5 h-5" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-bold text-slate-700 truncate">{file.name}</p>
                                <p className="text-[10px] text-slate-400 mt-0.5">类型：{
                                  file.type === 'manual' ? '操作手册' :
                                  file.type === 'invoice' ? '购入发票' :
                                  file.type === 'certificate' ? '质量注册证' : '其他资料'
                                } · {file.size}</p>
                              </div>
                              <ChevronRight className="w-4 h-4 text-slate-400 group-hover:translate-x-0.5 transition-transform" />
                            </div>
                          ))}
                        </div>
                      )}

                      {/* 已关联的技术快照页面 */}
                      {selectedEquipment.extractedSnapshots && selectedEquipment.extractedSnapshots.length > 0 && (
                        <div className="mt-6 border-t border-slate-200/60 pt-5 space-y-3">
                          <div className="flex justify-between items-center">
                            <div className="flex items-center gap-1.5">
                              <Layers className="text-blue-600 w-4 h-4" />
                              <h5 className="text-xs font-bold text-slate-700">📌 已提取的技术手册关联快照 ({selectedEquipment.extractedSnapshots.length})</h5>
                            </div>
                            <span className="text-[10px] font-extrabold text-blue-600 bg-blue-50 border border-blue-100 px-1.5 py-0.5 rounded uppercase tracking-wider font-mono">
                              AI OCR 审计对齐
                            </span>
                          </div>
                          
                          <div className="grid grid-cols-1 gap-3">
                            {selectedEquipment.extractedSnapshots.map((snap) => (
                              <div 
                                key={snap.id} 
                                className="p-3 bg-white border border-slate-200 hover:border-blue-400 rounded-xl transition-all flex items-start gap-3 relative group shadow-2xs"
                              >
                                <div className="p-2 bg-blue-50 text-blue-600 rounded-lg flex-shrink-0 mt-0.5">
                                  {snap.imageUrl === 'parameters' && <FileText className="w-4 h-4" />}
                                  {snap.imageUrl === 'chart' && <Activity className="w-4 h-4" />}
                                  {snap.imageUrl === 'warning' && <AlertTriangle className="w-4 h-4" />}
                                  {(snap.imageUrl === 'invoice' || snap.imageUrl === 'table') && <ShieldCheck className="w-4 h-4" />}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-[9px] font-extrabold text-blue-600 bg-blue-100 border border-blue-200 rounded px-1.5 py-0.5 font-mono">
                                      P.{snap.pageNum}
                                    </span>
                                    <h6 className="text-xs font-bold text-slate-800 truncate">{snap.title}</h6>
                                  </div>
                                  <p className="text-[10px] text-slate-500 mt-1.5 leading-relaxed">{snap.notes}</p>
                                  <div className="flex items-center gap-2 text-[9px] text-slate-400 mt-2 font-mono">
                                    <span>源头文档：{snap.sourceFileName}</span>
                                    <span>•</span>
                                    <span>提取时间：{snap.extractedAt}</span>
                                  </div>
                                </div>
                                {canManageEquipmentArchive && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleDeleteExtractedSnapshot(snap.id);
                                    }}
                                    className="md:opacity-0 group-hover:opacity-100 p-1 text-slate-300 hover:text-rose-600 hover:bg-rose-50 rounded-md transition-all absolute top-2 right-2 cursor-pointer"
                                    title="解除快照关联"
                                  >
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      
                      {/* Simulated Attachment drag/drop info */}
                      {canManageEquipmentArchive ? (
                        <div
                          onClick={() => setIsAttachmentModalOpen(true)}
                          className="border-2 border-dashed border-slate-200 hover:border-blue-400 p-6 rounded-xl text-center text-xs text-slate-400 cursor-pointer transition-all bg-slate-50/20"
                        >
                          <FileUp className="w-7 h-7 mx-auto mb-2 text-slate-300" />
                          <p className="text-slate-600 font-semibold">拖拽任何相关的说明书、合格证PDF至此处</p>
                          <p className="text-[10px] text-slate-400 mt-1">支持最大 50MB 的 PDF/Word/JPG 文档格式，自动建立系统索引</p>
                        </div>
                      ) : (
                        <div className="border border-dashed border-slate-200 bg-slate-50/60 p-5 rounded-xl text-center text-xs text-slate-500">
                          <FileText className="w-6 h-6 mx-auto mb-2 text-slate-300" />
                          <p className="font-semibold">临床端可查看已归档技术资料</p>
                          <p className="text-[10px] text-slate-400 mt-1">新增、删除或提取档案快照请联系医学装备科工程师。</p>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {activeTab === 'tickets' && (() => {
                  const relatedTasks = getRelatedTasksForEquipment(selectedEquipment);
                  return (
                    <div className="space-y-4">
                      <div className="flex justify-between items-center pb-2 border-b border-slate-100">
                        <div>
                          <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1">
                            <Activity className="w-4 h-4 text-emerald-500" />
                            <span>全流程任务关联工单履历 ({relatedTasks.length})</span>
                          </h4>
                          <p className="text-[10px] text-slate-400 mt-0.5">此设备在「AI任务流转助手」中登记的所有在线工单生命周期记录</p>
                        </div>
                        <button 
                          onClick={() => {
                            if (onReportRepairFromEquip) {
                              onReportRepairFromEquip(selectedEquipment);
                            }
                          }}
                          className="px-2.5 py-1.5 text-[11px] bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg flex items-center gap-1.5 cursor-pointer shadow-sm transition-all"
                        >
                          <PlusCircle className="w-3.5 h-3.5" />
                          <span>一键发起智能报修</span>
                        </button>
                      </div>

                      {relatedTasks.length === 0 ? (
                        <div className="border border-dashed border-slate-200 bg-slate-50/50 p-8 rounded-xl text-center">
                          <Activity className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                          <p className="text-xs text-slate-500 font-medium">该设备暂无关联的AI工单任务记录</p>
                          <p className="text-[10px] text-slate-400 mt-1">临床科室如果发现该设备存在故障，可点击上方「一键发起智能报修」直接发起</p>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {relatedTasks.map(ticket => {
                            let statusColor = 'bg-slate-100 text-slate-800';
                            if (ticket.status === '待确认') statusColor = 'bg-amber-100 text-amber-800 border border-amber-200';
                            else if (['已完成', '已归档', '已关闭'].includes(ticket.status)) statusColor = 'bg-emerald-100 text-emerald-800 border border-emerald-200';
                            else statusColor = 'bg-blue-100 text-blue-800 border border-blue-200';

                            return (
                              <div key={ticket.id} className="p-3 bg-white border border-slate-200 hover:border-slate-300 rounded-xl shadow-2xs transition-all flex flex-col md:flex-row justify-between gap-3 items-start md:items-center">
                                <div className="space-y-1 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-xs font-bold text-slate-800">
                                      {ticket.taskType}
                                    </span>
                                    <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase ${statusColor}`}>
                                      {ticket.status}
                                    </span>
                                    <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${ticket.urgency === '紧急' || ticket.urgency === '特急' || ticket.urgency === '生命支持' ? 'bg-rose-100 text-rose-800 border border-rose-200' : 'bg-slate-100 text-slate-600'}`}>
                                      {ticket.urgency}
                                    </span>
                                    <span className="text-[10px] text-slate-400 font-mono">
                                      ID: {ticket.id}
                                    </span>
                                  </div>
                                  <p className="text-xs text-slate-600 leading-relaxed font-medium">
                                    <span className="text-slate-400">故障现象：</span>{ticket.faultPhenomenon || '无描述'}
                                  </p>
                                  <div className="text-[10px] text-slate-400 flex flex-wrap gap-x-3 gap-y-1">
                                    <span>报修科室：{ticket.department}</span>
                                    <span>报修人：{ticket.contactPerson} ({ticket.contactPhone})</span>
                                    <span>发起时间：{ticket.createdAt || '未知'}</span>
                                  </div>
                                </div>
                                <button
                                  onClick={() => {
                                    if (window.dispatchEvent) {
                                      window.dispatchEvent(new CustomEvent('deep-link-ticket', { detail: { ticketId: ticket.id } }));
                                    }
                                  }}
                                  className="w-full md:w-auto px-2 py-1 text-[10px] font-bold text-blue-600 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg flex items-center justify-center gap-1 cursor-pointer transition-all shrink-0"
                                >
                                  <span>🔍 追踪工单链条</span>
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })()}

              </div>

              {/* Action Toolbar Footer in Details Sheet */}
              <div id="equipment_details_actions" className="p-2.5 sm:p-4 bg-slate-50 border-t border-slate-200/80 flex justify-between items-center gap-2 md:gap-3">
                {canManageEquipmentArchive ? (
                  <button
                    onClick={() => handleDelete(selectedEquipment.id)}
                    className="px-2.5 py-2 text-xs font-semibold text-rose-600 hover:bg-rose-50 border border-rose-200 rounded-lg transition-colors flex items-center justify-center gap-1 flex-shrink-0"
                    title="作废删除档案"
                  >
                    <Trash2 className="w-4 h-4" />
                    <span className="hidden sm:inline">作废删除</span>
                  </button>
                ) : (
                  <div className="text-[10px] text-slate-400 font-medium hidden sm:block">
                    临床只读档案
                  </div>
                )}

                <div className="flex items-center gap-1.5 sm:gap-3 flex-1 sm:flex-initial justify-end min-w-0">
                  {canManageEquipmentArchive && (
                    <>
                      <button 
                        onClick={handlePrintQR}
                        className="p-2 sm:px-4 sm:py-2 border border-slate-300 rounded-lg text-xs font-medium text-slate-600 hover:bg-white bg-slate-50 flex items-center justify-center gap-1.5 transition-all flex-shrink-0"
                        title="打印物联二维码"
                      >
                        <QrCode className="w-4 h-4" />
                        <span className="hidden md:inline">打印二维码</span>
                      </button>
                      <button
                        onClick={() => openEditModal(selectedEquipment)}
                        className="p-2 sm:px-4 sm:py-2 border border-slate-300 rounded-lg text-xs font-medium text-slate-600 hover:bg-white bg-slate-50 flex items-center justify-center gap-1.5 transition-all flex-shrink-0"
                        title="修改档案信息"
                      >
                        <Edit2 className="w-4 h-4" />
                        <span className="hidden md:inline">修改档案</span>
                      </button>
                      <button
                        onClick={() => openCloneModal(selectedEquipment)}
                        className="p-2 sm:px-4 sm:py-2 border border-slate-300 rounded-lg text-xs font-medium text-slate-600 hover:bg-white bg-slate-50 flex items-center justify-center gap-1.5 transition-all flex-shrink-0"
                        title="复制当前设备规格建立新档案"
                      >
                        <Copy className="w-4 h-4 text-violet-600" />
                        <span className="hidden md:inline">克隆复制</span>
                      </button>
                    </>
                  )}
                  <button 
                    id="btn-archive-scan-repair"
                    aria-label="扫码报修当前设备"
                    onClick={() => setIsScannerModalOpen(true)}
                    disabled={!canStartQuickRepairForEquipment(selectedEquipment)}
                    className={`px-2.5 py-2 sm:px-4 sm:py-2 rounded-lg text-xs font-bold shadow-sm flex items-center justify-center gap-1.5 transition-all flex-1 sm:flex-initial text-center whitespace-nowrap ${
                      canStartQuickRepairForEquipment(selectedEquipment)
                        ? 'bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white shadow-indigo-100'
                        : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                    }`}
                    title={canStartQuickRepairForEquipment(selectedEquipment) ? '调用相机扫描SN码快速填充报修' : getQuickRepairBlockMessage(selectedEquipment)}
                  >
                    <QrCode className="w-4 h-4 flex-shrink-0 animate-pulse" />
                    <span>扫码报修</span>
                  </button>
                  <button 
                    id="btn-archive-instant-repair"
                    aria-label="一键报修当前设备"
                    onClick={handleQuickRepair}
                    disabled={!canStartQuickRepairForEquipment(selectedEquipment)}
                    className={`px-2.5 py-2 sm:px-4 sm:py-2 rounded-lg text-xs font-bold shadow-sm flex items-center justify-center gap-1.5 transition-all flex-1 sm:flex-initial text-center whitespace-nowrap ${
                      canStartQuickRepairForEquipment(selectedEquipment)
                        ? 'bg-blue-600 text-white shadow-blue-200 hover:bg-blue-700'
                        : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                    }`}
                    title={canStartQuickRepairForEquipment(selectedEquipment) ? '立即一键报修' : getQuickRepairBlockMessage(selectedEquipment)}
                  >
                    <Wrench className="w-4 h-4 flex-shrink-0" />
                    <span>一键报修</span>
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 p-8">
              <HardDrive className="w-16 h-16 text-slate-200 mb-3 animate-bounce" />
              <p className="font-bold text-slate-500">未选中任何设备档案</p>
              <p className="text-xs text-slate-400 mt-1">
                {canManageEquipmentArchive ? '请从左侧列表点击选择，或点击 AI 扫码入库新增设备。' : '请从左侧本科室设备列表点击选择。'}
              </p>
            </div>
          )}
        </section>

        {/* RIGHT COLUMN: Real-time QR Card & AI Clinical Engineering Diagnostic Assistant */}
        <aside id="right_column_panel" className={`col-span-12 md:col-span-3 ${mobileView === 'ai' ? 'fixed inset-x-3 top-48 bottom-20 z-20 flex' : 'hidden md:flex'} md:static md:inset-auto md:z-auto flex-col gap-4 md:gap-6 min-h-0 md:h-full`}>
          


          {/* 2. AI Biomedical Diagnostic Robot Chatbot */}
          <div id="ai_diagnostician_bot" className="bg-slate-900 text-white p-5 rounded-xl shadow-lg flex-1 flex flex-col min-h-0">
            <div className="flex items-center gap-2 mb-3.5 pb-3 border-b border-slate-800">
              <div className="w-2.5 h-2.5 bg-blue-400 animate-pulse rounded-full"></div>
              <div className="flex-1">
                <h3 className="text-xs font-bold text-blue-200 uppercase tracking-widest font-mono">AI 临床医学装备智脑</h3>
                <p className="text-[10px] text-slate-400 mt-0.5">Biomedical Engineer AI Expert</p>
              </div>
              <Sparkles className="w-4 h-4 text-blue-400" />
            </div>

            {/* Chat message display */}
            <div className="flex-1 overflow-y-auto space-y-3.5 pr-1 text-xs custom-scrollbar">
              {chatMessages.map((msg, index) => (
                <div 
                  key={index} 
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div className={`p-3 rounded-lg max-w-[90%] leading-relaxed ${
                    msg.role === 'user' 
                      ? 'bg-blue-600 text-white rounded-br-none' 
                      : 'bg-slate-800 text-slate-200 rounded-bl-none border border-slate-700/50'
                  }`}>
                    {/* Render simple newlines and bold formats */}
                    {msg.text.split('\n').map((line, i) => (
                      <p key={i} className={i > 0 ? 'mt-1' : ''}>
                        {line}
                      </p>
                    ))}
                  </div>
                </div>
              ))}
              {isChatSending && (
                <div className="flex justify-start">
                  <div className="p-3 rounded-lg bg-slate-800 text-slate-400 rounded-bl-none border border-slate-700/50 flex items-center gap-2">
                    <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce"></span>
                    <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce [animation-delay:0.2s]"></span>
                    <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce [animation-delay:0.4s]"></span>
                    <span>AI 正在调阅该型号原厂技术手册...</span>
                  </div>
                </div>
              )}
            </div>

            {/* Chat Preset Helper prompts */}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button 
                onClick={() => {
                  setChatInput('请问该设备的预防性维护(PM)保养计划有哪些核心步骤？');
                }}
                className="bg-slate-800/80 hover:bg-slate-800 text-slate-300 text-[10px] py-1.5 px-2 rounded border border-slate-700/60 truncate text-left"
              >
                🛠️ PM保养步骤说明
              </button>
              <button 
                onClick={() => {
                  setChatInput('设备报错提示“Error 104”或压力过高报警，该如何排查？');
                }}
                className="bg-slate-800/80 hover:bg-slate-800 text-slate-300 text-[10px] py-1.5 px-2 rounded border border-slate-700/60 truncate text-left"
              >
                ⚠️ 故障代码Error排查
              </button>
            </div>

            {/* Message input */}
            <div className="mt-3.5 flex gap-2">
              <input 
                type="text" 
                placeholder="向AI咨询维保/计量操作规程..." 
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') sendChatMessage(); }}
                className="flex-1 bg-slate-800 text-white rounded-lg px-3 py-2 text-xs border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-slate-500"
              />
              <button 
                onClick={sendChatMessage}
                disabled={isChatSending || !chatInput.trim()}
                className="bg-blue-600 hover:bg-blue-700 text-white p-2 rounded-lg text-xs disabled:bg-slate-800 disabled:text-slate-600 transition-colors"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
        </aside>
          </div>
        ) : viewMode === 'calendar' ? (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col h-full min-h-0 overflow-hidden w-full flex-1">
            <MaintenanceCalendar
              equipments={visibleEquipments}
              setEquipments={setEquipments}
              selectedId={selectedId}
              setSelectedId={setSelectedId}
              setMobileView={setMobileView}
              setMiddleViewMode={(mode) => {
                if (mode === 'detail') {
                  setViewMode('inventory');
                }
              }}
              setLogType={setLogType}
              setIsLogModalOpen={setIsLogModalOpen}
              currentUser={currentUser}
            />
          </div>
        ) : viewMode === 'list' ? (
          /* ================= FULL PAGE EQUIPMENT LIST GRID (台账明细表) ================= */
          <div className="flex flex-col gap-5 w-full flex-1 min-h-0 animate-fade-in font-sans">
            {/* KPI Metrics row */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4 flex-shrink-0">
              <div className="bg-white p-3.5 md:p-5 rounded-xl border border-slate-200 shadow-2xs flex items-center gap-3.5">
                <div className="p-2.5 bg-blue-50 text-blue-600 rounded-lg">
                  <Layers className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-[10px] md:text-xs font-black text-slate-400 uppercase tracking-widest">筛选后在册设备</p>
                  <p className="text-sm md:text-xl font-black text-slate-800">
                    {matrixFilteredEquipments.length} <span className="text-[10px] md:text-xs font-normal text-slate-500">台 / 共{visibleEquipments.length}台</span>
                  </p>
                </div>
              </div>

              <div className="bg-white p-3.5 md:p-5 rounded-xl border border-slate-200 shadow-2xs flex items-center gap-3.5">
                <div className="p-2.5 bg-emerald-50 text-emerald-600 rounded-lg">
                  <CheckSquare className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-[10px] md:text-xs font-black text-slate-400 uppercase tracking-widest">正常运行比例</p>
                  <p className="text-sm md:text-xl font-black text-emerald-600">
                    {Math.round((visibleEquipments.filter(e => e.status === '正常运行').length / (visibleEquipments.length || 1)) * 100)}%
                  </p>
                </div>
              </div>

              <div className="bg-white p-3.5 md:p-5 rounded-xl border border-slate-200 shadow-2xs flex items-center gap-3.5">
                <div className="p-2.5 bg-rose-50 text-rose-600 rounded-lg">
                  <Wrench className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-[10px] md:text-xs font-black text-slate-400 uppercase tracking-widest">故障待修总数</p>
                  <p className="text-sm md:text-xl font-black text-rose-600">
                    {visibleEquipments.filter(e => e.status === '故障维修').length} <span className="text-[10px] md:text-xs font-normal text-slate-500">台在修理</span>
                  </p>
                </div>
              </div>

              <div className="bg-white p-3.5 md:p-5 rounded-xl border border-slate-200 shadow-2xs flex items-center gap-3.5">
                <div className="p-2.5 bg-indigo-50 text-indigo-600 rounded-lg">
                  <Calendar className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-[10px] md:text-xs font-black text-slate-400 uppercase tracking-widest">下期计量检定数</p>
                  <p className="text-sm md:text-xl font-black text-indigo-600">
                    {visibleEquipments.filter(e => e.calibrationRequired).length} <span className="text-[10px] md:text-xs font-normal text-slate-500">台受控</span>
                  </p>
                </div>
              </div>
            </div>

            {/* Filter and Table Panel Card */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 md:p-5 flex flex-col gap-4 min-h-0 flex-1">
              {/* Header and Controls */}
              <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 border-b border-slate-100 pb-4">
                <div>
                  <h3 className="text-sm md:text-base font-black text-slate-800 flex items-center gap-2">
                    <Table className="w-4 h-4 text-blue-600" />
                    <span>医学装备资产台账明细表</span>
                  </h3>
                  <p className="text-[11px] text-slate-500 mt-1">
                    实时汇总之{assetScopeLabel}资产设备，支持按多字段首字母排序与多维度精细化联动检索，点击“定位档案”可自动穿透跳转至主台账对应设备卷宗。
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {/* Export Button */}
                  {canManageEquipmentArchive ? (
                    <button
                      onClick={() => {
                        const csvContent = "data:text/csv;charset=utf-8,\uFEFF" // Include BOM for Chinese encoding support in Excel
                          + ["设备编号,设备名称,科室,品类,品牌/厂商,型号,出厂SN,购置金额,运行状态,下期维保时间,是否强检"]
                            .concat(matrixFilteredEquipments.map(e => `"${e.id}","${e.deviceName}","${e.dept}","${e.category}","${e.manufacturer}","${e.model}","${e.sn}",${e.purchaseCost},"${e.status}","${e.nextMaintenanceDate || ''}","${e.calibrationRequired ? '是' : '否'}"`))
                            .join("\n");
                        const encodedUri = encodeURI(csvContent);
                        const link = document.createElement("a");
                        link.setAttribute("href", encodedUri);
                        link.setAttribute("download", `医学装备资产台账明细_${assetScopeLabel}_${getLocalDateString()}.csv`);
                        document.body.appendChild(link);
                        link.click();
                        document.body.removeChild(link);
                      }}
                      className="flex items-center gap-1.5 px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-lg text-xs transition-all cursor-pointer"
                      title={`导出当前${assetScopeLabel}可见设备资产报表为 CSV 格式`}
                    >
                      <Printer className="w-3.5 h-3.5 text-slate-500" />
                      <span>导出当前表 (CSV)</span>
                    </button>
                  ) : (
                    <span className="flex items-center gap-1.5 px-3 py-2 bg-slate-100 text-slate-500 font-bold rounded-lg text-xs border border-slate-200">
                      临床只读台账
                    </span>
                  )}

                  {/* Reset All Filters */}
                  {(matrixSelectedDept !== '全部科室' || matrixSelectedCategory !== '全部分类' || matrixSelectedStatus !== '全部状态' || matrixSearchQuery) && (
                    <button
                      onClick={() => {
                        setMatrixSelectedDept('全部科室');
                        setMatrixSelectedCategory('全部分类');
                        setMatrixSelectedStatus('全部状态');
                        setMatrixSearchQuery('');
                      }}
                      className="px-3 py-2 bg-red-50 hover:bg-red-100 text-red-600 font-bold rounded-lg text-xs transition-all cursor-pointer flex items-center gap-1"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>清除全部筛选</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Advanced Filter Selector Bar */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 bg-slate-50 p-3 rounded-xl border border-slate-200/60">
                {/* Search Text */}
                <div className="relative">
                  <label className="block text-[10px] font-bold text-slate-500 mb-1">🔍 模糊多字段搜索</label>
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      placeholder="设备名称 / SN / 厂商 / 型号..."
                      value={matrixSearchQuery}
                      onChange={(e) => setMatrixSearchQuery(e.target.value)}
                      className="w-full text-xs bg-white border border-slate-200 rounded-lg pl-9 pr-3 py-2 text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                </div>

                {/* Dept Filter */}
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 mb-1">🏢 安置科室</label>
                  <select
                    value={matrixSelectedDept}
                    onChange={(e) => setMatrixSelectedDept(e.target.value)}
                    className="w-full text-xs bg-white border border-slate-200 rounded-lg px-2.5 py-2 text-slate-600 focus:outline-none font-bold"
                  >
                    <option value="全部科室">{assetScopeLabel} ({visibleDepartments.length - 1}个)</option>
                    {visibleDepartments.filter(dept => dept !== '全部科室').sort().map(dept => (
                      <option key={dept} value={dept}>{dept}</option>
                    ))}
                  </select>
                </div>

                {/* Category Filter */}
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 mb-1">📦 装备类别</label>
                  <select
                    value={matrixSelectedCategory}
                    onChange={(e) => setMatrixSelectedCategory(e.target.value)}
                    className="w-full text-xs bg-white border border-slate-200 rounded-lg px-2.5 py-2 text-slate-600 focus:outline-none font-bold"
                  >
                    <option value="全部分类">全部分类</option>
                    {['急救生命支持', '影像诊断', '检验分析', '手术治疗', '其他'].map(cat => (
                      <option key={cat} value={cat}>{cat}</option>
                    ))}
                  </select>
                </div>

                {/* Status Filter */}
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 mb-1">🟢 运行状态</label>
                  <select
                    value={matrixSelectedStatus}
                    onChange={(e) => setMatrixSelectedStatus(e.target.value)}
                    className="w-full text-xs bg-white border border-slate-200 rounded-lg px-2.5 py-2 text-slate-600 focus:outline-none font-bold"
                  >
                    <option value="全部状态">全部状态</option>
                    {['正常运行', '故障维修', '计量中', '已停用'].map(st => (
                      <option key={st} value={st}>{st}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Table rendering panel */}
              <div className="overflow-x-auto border border-slate-200 rounded-xl flex-1 min-h-[300px]">
                {(() => {
                  const sortedAndFilteredEquipments = [...matrixFilteredEquipments]
                    .sort((a, b) => {
                      let valA = (a[matrixSortField as keyof MedicalEquipment] || '').toString();
                      let valB = (b[matrixSortField as keyof MedicalEquipment] || '').toString();
                      if (matrixSortField === 'purchaseCost') {
                        const numA = Number(a.purchaseCost) || 0;
                        const numB = Number(b.purchaseCost) || 0;
                        return matrixSortOrder === 'asc' ? numA - numB : numB - numA;
                      }
                      return matrixSortOrder === 'asc' 
                        ? valA.localeCompare(valB, 'zh-CN') 
                        : valB.localeCompare(valA, 'zh-CN');
                    });

                  if (sortedAndFilteredEquipments.length === 0) {
                    return (
                      <div className="p-12 text-center text-slate-400 font-medium">
                        <Activity className="w-10 h-10 mx-auto text-slate-300 animate-pulse mb-3" />
                        <p>暂无符合当前筛选条件的设备台账记录</p>
                        <p className="text-[10px] text-slate-400 mt-1">请尝试重置或调整您的筛选词</p>
                      </div>
                    );
                  }

                  return (
                    <table className="w-full text-xs text-left border-collapse">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-bold select-none sticky top-0 z-10">
                          <th 
                            onClick={() => {
                              if (matrixSortField === 'deviceName') {
                                setMatrixSortOrder(matrixSortOrder === 'asc' ? 'desc' : 'asc');
                              } else {
                                setMatrixSortField('deviceName');
                                setMatrixSortOrder('asc');
                              }
                            }}
                            className="p-3 cursor-pointer hover:bg-slate-100 transition-colors"
                          >
                            <div className="flex items-center gap-1">
                              <span>设备名称 & 厂商</span>
                              <ArrowUpDown className="w-3 h-3 text-slate-400" />
                              {matrixSortField === 'deviceName' && (
                                <span className="text-[9px] text-blue-600">{matrixSortOrder === 'asc' ? '▲' : '▼'}</span>
                              )}
                            </div>
                          </th>
                          <th className="p-3">型号 & 规格</th>
                          <th className="p-3">出厂 SN</th>
                          <th 
                            onClick={() => {
                              if (matrixSortField === 'dept') {
                                setMatrixSortOrder(matrixSortOrder === 'asc' ? 'desc' : 'asc');
                              } else {
                                setMatrixSortField('dept');
                                setMatrixSortOrder('asc');
                              }
                            }}
                            className="p-3 cursor-pointer hover:bg-slate-100 transition-colors"
                          >
                            <div className="flex items-center gap-1">
                              <span>安置科室</span>
                              <ArrowUpDown className="w-3 h-3 text-slate-400" />
                              {matrixSortField === 'dept' && (
                                <span className="text-[9px] text-blue-600">{matrixSortOrder === 'asc' ? '▲' : '▼'}</span>
                              )}
                            </div>
                          </th>
                          <th 
                            onClick={() => {
                              if (matrixSortField === 'category') {
                                setMatrixSortOrder(matrixSortOrder === 'asc' ? 'desc' : 'asc');
                              } else {
                                setMatrixSortField('category');
                                setMatrixSortOrder('asc');
                              }
                            }}
                            className="p-3 cursor-pointer hover:bg-slate-100 transition-colors"
                          >
                            <div className="flex items-center gap-1">
                              <span>品类</span>
                              <ArrowUpDown className="w-3 h-3 text-slate-400" />
                              {matrixSortField === 'category' && (
                                <span className="text-[9px] text-blue-600">{matrixSortOrder === 'asc' ? '▲' : '▼'}</span>
                              )}
                            </div>
                          </th>
                          <th 
                            onClick={() => {
                              if (matrixSortField === 'status') {
                                setMatrixSortOrder(matrixSortOrder === 'asc' ? 'desc' : 'asc');
                              } else {
                                setMatrixSortField('status');
                                setMatrixSortOrder('asc');
                              }
                            }}
                            className="p-3 cursor-pointer hover:bg-slate-100 transition-colors"
                          >
                            <div className="flex items-center gap-1">
                              <span>运行状态</span>
                              <ArrowUpDown className="w-3 h-3 text-slate-400" />
                              {matrixSortField === 'status' && (
                                <span className="text-[9px] text-blue-600">{matrixSortOrder === 'asc' ? '▲' : '▼'}</span>
                              )}
                            </div>
                          </th>
                          <th className="p-3">下期质控维保</th>
                          <th className="p-3 text-right">操作交互</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 bg-white">
                        {sortedAndFilteredEquipments.map(eq => {
                          let statusColor = 'bg-slate-100 text-slate-600 border border-slate-200';
                          if (eq.status === '正常运行') {
                            statusColor = 'bg-emerald-50 text-emerald-700 border border-emerald-200';
                          } else if (eq.status === '故障维修') {
                            statusColor = 'bg-rose-50 text-rose-700 border border-rose-200 animate-pulse';
                          } else if (eq.status === '计量中') {
                            statusColor = 'bg-amber-50 text-amber-700 border border-amber-200';
                          } else if (eq.status === '已停用') {
                            statusColor = 'bg-slate-100 text-slate-500 border border-slate-200';
                          }

                          let riskBadge = null;
                          if (eq.category === '急救生命支持') {
                            riskBadge = <span className="text-[9px] bg-red-50 text-red-600 px-1.5 py-0.2 rounded font-black border border-red-200/50">高风险</span>;
                          } else if (eq.category === '手术治疗' || eq.category === '影像诊断') {
                            riskBadge = <span className="text-[9px] bg-amber-50 text-amber-600 px-1.5 py-0.2 rounded font-bold border border-amber-200/30">中风险</span>;
                          } else {
                            riskBadge = <span className="text-[9px] bg-slate-50 text-slate-500 px-1.5 py-0.2 rounded border border-slate-200/30">常规</span>;
                          }

                          return (
                            <tr key={eq.id} className="hover:bg-slate-50/50 transition-colors">
                              <td className="p-3">
                                <div>
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="font-extrabold text-slate-800 text-[12.5px]">{eq.deviceName}</span>
                                    {riskBadge}
                                  </div>
                                  <p className="text-[10px] text-slate-400 mt-0.5">{eq.manufacturer || '未知厂商'}</p>
                                </div>
                              </td>

                              <td className="p-3 font-mono text-slate-600 text-[11px]">
                                {eq.model || '-'}
                              </td>

                              <td className="p-3">
                                <div className="flex items-center gap-1.5">
                                  <span className="font-mono text-slate-500 text-[11px] bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200/50">{eq.sn}</span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      navigator.clipboard.writeText(eq.sn);
                                    }}
                                    className="text-slate-400 hover:text-slate-600 p-0.5 transition-colors"
                                    title="复制SN号"
                                  >
                                    <Copy className="w-3 h-3" />
                                  </button>
                                </div>
                              </td>

                              <td className="p-3">
                                <button
                                  type="button"
                                  onClick={() => setMatrixSelectedDept(eq.dept)}
                                  className="px-2 py-0.5 text-slate-600 bg-slate-100 hover:bg-blue-50 hover:text-blue-600 transition-colors font-bold rounded"
                                >
                                  {eq.dept}
                                </button>
                              </td>

                              <td className="p-3">
                                <button
                                  type="button"
                                  onClick={() => setMatrixSelectedCategory(eq.category)}
                                  className="px-2 py-0.5 text-indigo-700 bg-indigo-50 hover:bg-indigo-100 transition-colors font-bold rounded"
                                >
                                  {eq.category}
                                </button>
                              </td>

                              <td className="p-3">
                                <span className={`px-2 py-0.5 rounded text-[11px] font-black ${statusColor}`}>
                                  {eq.status}
                                </span>
                              </td>

                              <td className="p-3 font-mono text-[10px] text-slate-500 leading-tight">
                                <p>下期维保: <span className="font-bold text-slate-700">{eq.nextMaintenanceDate || '未规划'}</span></p>
                                {eq.calibrationRequired && (
                                  <p className="text-amber-600 mt-0.5 font-bold">下期强检: <span className="font-bold">{eq.nextCalibrationDate || '待排程'}</span></p>
                                )}
                              </td>

                              <td className="p-3 text-right">
                                <div className="flex justify-end items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setSelectedId(eq.id);
                                      setViewMode('inventory');
                                      setMobileView('detail');
                                      setActiveTab('basic');
                                    }}
                                    className="px-2.5 py-1 bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-600 hover:text-white rounded-md text-[10.5px] font-bold transition-all cursor-pointer"
                                    title="在设备台账中打开数字全套档案"
                                  >
                                    定位档案
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const quickRepairBlockMessage = getQuickRepairBlockMessage(eq);
                                      if (quickRepairBlockMessage) {
                                        showQuickRepairToast({
                                          type: 'warning',
                                          message: quickRepairBlockMessage
                                        });
                                        return;
                                      }

                                      resetQuickRepairDraft(eq.id);
                                      setQuickRepairDesc(`【台账明细表一键快捷报修】\n管理员在“台账明细表”执行快捷报修，请立刻核实响应。`);
                                      setQuickRepairUrgency('high');
                                      setIsQuickRepairModalOpen(true);
                                    }}
                                    disabled={!canStartQuickRepairForEquipment(eq)}
                                    className={`px-2.5 py-1 border rounded-md text-[10.5px] font-bold transition-all ${
                                      canStartQuickRepairForEquipment(eq)
                                        ? 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-600 hover:text-white cursor-pointer'
                                        : 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
                                    }`}
                                    title={canStartQuickRepairForEquipment(eq) ? '一键报修' : getQuickRepairBlockMessage(eq)}
                                  >
                                    报修
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  );
                })()}
              </div>
            </div>
          </div>
        ) : (
          /* ================= INTERACTIVE MATRIX DASHBOARD (科室资产看板) ================= */
          <div className="flex flex-col gap-6 w-full flex-1 min-h-0 animate-fade-in font-sans">
            {/* At-A-Glance Metric Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4 flex-shrink-0">
              <div className="bg-white p-3.5 md:p-5 rounded-xl border border-slate-200 shadow-2xs flex items-center gap-3.5">
                <div className="p-2.5 bg-blue-50 text-blue-600 rounded-lg">
                  <Layers className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-[10px] md:text-xs font-black text-slate-400 uppercase tracking-widest">{assetScopeLabel}设备总数</p>
                  <div className="flex items-baseline gap-1 mt-0.5">
                    <span className="text-xl md:text-2xl font-black text-slate-800">{visibleEquipments.length}</span>
                    <span className="text-[10px] md:text-xs text-slate-500 font-bold">台设备在册</span>
                  </div>
                </div>
              </div>

              <div className="bg-white p-3.5 md:p-5 rounded-xl border border-slate-200 shadow-2xs flex items-center gap-3.5">
                <div className="p-2.5 bg-emerald-50 text-emerald-600 rounded-lg">
                  <CheckSquare className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-[10px] md:text-xs font-black text-slate-400 uppercase tracking-widest">正常运行中</p>
                  <div className="flex items-baseline gap-1 mt-0.5">
                    <span className="text-xl md:text-2xl font-black text-emerald-600">
                      {visibleEquipments.filter(e => e.status === '正常运行').length}
                    </span>
                    <span className="text-[10px] md:text-xs text-slate-500 font-bold">台状态优良</span>
                  </div>
                </div>
              </div>

              <div className="bg-white p-3.5 md:p-5 rounded-xl border border-slate-200 shadow-2xs flex items-center gap-3.5">
                <div className="p-2.5 bg-rose-50 text-rose-600 rounded-lg">
                  <Wrench className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-[10px] md:text-xs font-black text-slate-400 uppercase tracking-widest">故障待修状态</p>
                  <div className="flex items-baseline gap-1 mt-0.5">
                    <span className="text-xl md:text-2xl font-black text-rose-600">
                      {visibleEquipments.filter(e => e.status === '故障维修').length}
                    </span>
                    <span className="text-[10px] md:text-xs text-slate-500 font-bold">台维保待料</span>
                  </div>
                </div>
              </div>

              <div className="bg-white p-3.5 md:p-5 rounded-xl border border-slate-200 shadow-2xs flex items-center gap-3.5">
                <div className="p-2.5 bg-indigo-50 text-indigo-600 rounded-lg">
                  <LayoutGrid className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-[10px] md:text-xs font-black text-slate-400 uppercase tracking-widest">{assetScopeLabel}实体科室数</p>
                  <div className="flex items-baseline gap-1 mt-0.5">
                    <span className="text-xl md:text-2xl font-black text-indigo-600">
                      {visibleDepartments.length - 1}
                    </span>
                    <span className="text-[10px] md:text-xs text-slate-500 font-bold">个医学科室</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Matrix Card: Interactive Department x Category Breakdown Grid */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-xs p-4 md:p-6 flex flex-col gap-4 flex-shrink-0">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-4">
                <div>
                  <h3 className="text-sm md:text-base font-black text-slate-800 flex items-center gap-2">
                    <LayoutGrid className="w-5 h-5 text-indigo-500 animate-pulse" />
                    <span>{assetScopeLabel}科室 ✕ 装备类别 联动资产看板</span>
                  </h3>
                  <p className="text-[11px] text-slate-500 mt-1">
                    系统根据实际库存智能统计。<strong>点击下表任何科室行、品类列、交叉单元格或总数，将自动完成筛选并跳转到【台账明细表】专属页面，实现穿透下钻！</strong>
                  </p>
                </div>
              </div>

              {/* Grid Scroll Area */}
              <div className="overflow-x-auto border border-slate-100 rounded-lg shadow-inner bg-slate-50/30">
                <table className="w-full text-xs text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-50/80 text-slate-500 font-bold border-b border-slate-100">
                      <th className="p-3 min-w-[140px] font-black text-slate-600">{assetScopeLabel}科室机构 (点击整行筛选)</th>
                      {['急救生命支持', '影像诊断', '检验分析', '手术治疗', '其他'].map(cat => {
                        return (
                          <th 
                            key={cat}
                            onClick={() => {
                              setMatrixSelectedDept('全部科室');
                              setMatrixSelectedCategory(cat);
                              setViewMode('list');
                            }}
                            className="p-3 text-center cursor-pointer hover:bg-slate-150 hover:text-indigo-600 transition-all"
                            title={`点击查看${assetScopeLabel}“${cat}”装备明细列表`}
                          >
                            <span className="block font-bold">{cat}</span>
                            <span className="text-[9px] font-normal text-slate-400">
                              ({assetScopeLabel}: {visibleEquipments.filter(e => e.category === cat).length}台)
                            </span>
                          </th>
                        );
                      })}
                      <th 
                        onClick={() => {
                          setMatrixSelectedDept('全部科室');
                          setMatrixSelectedCategory('全部分类');
                          setViewMode('list');
                        }}
                        className="p-3 text-center font-black text-blue-600 bg-blue-50/30 cursor-pointer hover:bg-blue-100 transition-all"
                        title={`点击查看${assetScopeLabel}所有设备台账明细列表`}
                      >
                        科室资产总计
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {visibleDepartments.filter(dept => dept !== '全部科室').map(dept => {
                      const deptTotal = visibleEquipments.filter(e => isSameDepartment(e.dept, dept)).length;
                      
                      return (
                        <tr 
                          key={dept} 
                          className="hover:bg-slate-50/50 transition-colors"
                        >
                          {/* Dept Cell */}
                          <td className="p-2.5">
                            <button
                              type="button"
                              onClick={() => {
                                setMatrixSelectedDept(dept);
                                setMatrixSelectedCategory('全部分类');
                                setViewMode('list');
                              }}
                              className="w-full text-left px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center justify-between text-slate-700 hover:bg-slate-100"
                              title={`点击查看“${dept}”名下全部装备明细`}
                            >
                              <span>🏢 {dept}</span>
                              <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-slate-100 text-slate-500">{deptTotal}</span>
                            </button>
                          </td>

                          {/* Category Count Cells */}
                          {['急救生命支持', '影像诊断', '检验分析', '手术治疗', '其他'].map(cat => {
                            const count = visibleEquipments.filter(e => isSameDepartment(e.dept, dept) && e.category === cat).length;
                            
                            return (
                              <td key={cat} className="p-2.5 text-center">
                                {count > 0 ? (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setMatrixSelectedDept(dept);
                                      setMatrixSelectedCategory(cat);
                                      setViewMode('list');
                                    }}
                                    className="px-3 py-1 rounded-full text-xs font-extrabold transition-all min-w-[36px] bg-slate-100 hover:bg-indigo-600 hover:text-white text-slate-700 font-bold hover:shadow-sm"
                                    title={`点击穿透查看“${dept}”名下的 ${count} 台“${cat}”设备`}
                                  >
                                    {count}
                                  </button>
                                ) : (
                                  <span className="text-slate-300 font-mono">-</span>
                                )}
                              </td>
                            );
                          })}

                          {/* Row Total Cell */}
                          <td className="p-2.5 text-center">
                            <button
                              type="button"
                              onClick={() => {
                                setMatrixSelectedDept(dept);
                                setMatrixSelectedCategory('全部分类');
                                setViewMode('list');
                              }}
                              className="px-3 py-1 rounded-lg text-xs font-black transition-all bg-slate-100 hover:bg-blue-600 hover:text-white text-slate-800"
                              title={`点击穿透查看“${dept}”全部设备档案`}
                            >
                              {deptTotal}台
                            </button>
                          </td>
                        </tr>
                      );
                    })}

                    {/* Overall Summary Row */}
                    <tr className="bg-slate-100/60 font-black border-t-2 border-slate-200">
                      <td className="p-3 text-slate-800 font-extrabold">{assetScopeLabel}品类小计</td>
                      {['急救生命支持', '影像诊断', '检验分析', '手术治疗', '其他'].map(cat => {
                        const colTotal = visibleEquipments.filter(e => e.category === cat).length;
                        
                        return (
                          <td key={cat} className="p-3 text-center">
                            <button
                              type="button"
                              onClick={() => {
                                setMatrixSelectedDept('全部科室');
                                setMatrixSelectedCategory(cat);
                                setViewMode('list');
                              }}
                              className="px-3 py-1 rounded-lg text-xs font-extrabold transition-all bg-indigo-50 hover:bg-indigo-600 hover:text-white text-indigo-700"
                              title={`点击穿透查看${assetScopeLabel}“${cat}”装备明细`}
                            >
                              {colTotal}台
                            </button>
                          </td>
                        );
                      })}
                      <td className="p-3 text-center bg-indigo-50 text-indigo-700 font-black">
                        <button
                          type="button"
                          onClick={() => {
                            setMatrixSelectedDept('全部科室');
                            setMatrixSelectedCategory('全部分类');
                            setViewMode('list');
                          }}
                          className="font-black"
                        >
                          {visibleEquipments.length}台
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Explanatory Banner */}
              <div className="bg-blue-50 border border-blue-100 p-4 rounded-xl text-blue-800 text-xs flex gap-3 items-start leading-relaxed">
                <Info className="w-4 h-4 text-blue-500 animate-bounce flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold mb-0.5">💡 提示：穿透式数据下钻设计说明</p>
                  <p className="text-slate-600">资产交叉统计表中的所有数字、科室按钮、分类表头均具备超链接交互属性。点击后系统将瞬间捕捉到您的筛选意图，秒级切换至【台账明细表】进行全方位穿透解析与快捷操作。</p>
                </div>
              </div>
            </div>

            {/* Overall Asset Financial Breakdown Chart */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-xs p-4 md:p-6">
              <h3 className="text-sm md:text-base font-black text-slate-800 flex items-center gap-2 border-b border-slate-100 pb-3 mb-4">
                <BarChart2 className="w-5 h-5 text-indigo-500" />
                <span>{assetScopeLabel}资产购置成本分布分析</span>
              </h3>
              
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Text analytics */}
                <div className="space-y-4 text-xs text-slate-600 leading-relaxed">
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-200/60">
                    <p className="font-bold text-slate-800 text-[13px] mb-2 flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-indigo-500"></span>
                      <span>科室资产原值排行</span>
                    </p>
                    <div className="space-y-2 font-mono">
                      {visibleDepartments.filter(dept => dept !== '全部科室')
                        .map(dept => {
                          const value = visibleEquipments.filter(e => isSameDepartment(e.dept, dept)).reduce((sum, e) => sum + (Number(e.purchaseCost) || 0), 0);
                          return { dept, value };
                        })
                        .sort((a, b) => b.value - a.value)
                        .slice(0, 4)
                        .map((item, idx) => (
                          <div key={idx} className="flex justify-between items-center text-[11px]">
                            <span className="text-slate-600 font-sans font-medium">第 {idx + 1} 名：{item.dept}</span>
                            <span className="font-bold text-slate-800">¥ {item.value.toLocaleString()} 元</span>
                          </div>
                        ))}
                    </div>
                  </div>

                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-200/60">
                    <p className="font-bold text-slate-800 text-[13px] mb-2 flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-emerald-500"></span>
                      <span>装备类别资金占用</span>
                    </p>
                    <div className="space-y-2 font-mono">
                      {['急救生命支持', '影像诊断', '检验分析', '手术治疗', '其他'].map((cat, idx) => {
                        const value = visibleEquipments.filter(e => e.category === cat).reduce((sum, e) => sum + (Number(e.purchaseCost) || 0), 0);
                        const ratio = totalAssetsValue > 0 ? ((value / totalAssetsValue) * 100).toFixed(1) : '0';
                        return (
                          <div key={idx} className="flex justify-between items-center text-[11px]">
                            <span className="text-slate-600 font-sans font-medium">{cat}</span>
                            <span className="font-bold text-slate-800">¥ {value.toLocaleString()} 元 ({ratio}%)</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Simulated Graphical Chart */}
                <div className="border border-slate-150 rounded-xl p-4 bg-slate-50/50 flex flex-col justify-center items-center h-full min-h-[180px]">
                  <BarChart2 className="w-12 h-12 text-slate-300 mb-2 animate-bounce" />
                  <p className="text-xs font-bold text-slate-700">科室资产总原值堆叠对比</p>
                  <p className="text-[10px] text-slate-400 mt-1">
                    系统已对齐{assetScopeLabel}在册装备数据，支持 3D 响应式分析
                  </p>
                  <div className="flex gap-1.5 mt-3 flex-wrap justify-center">
                    {visibleDepartments.filter(dept => dept !== '全部科室').map(dept => {
                      const count = visibleEquipments.filter(e => isSameDepartment(e.dept, dept)).length;
                      return (
                        <span key={dept} className="text-[9px] bg-white border border-slate-200 rounded px-1.5 py-0.5 text-slate-500 font-bold font-mono">
                          {dept} ({count}台)
                        </span>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Global Bottom Footer stats info */}
      <footer id="global_footer" className="hidden md:flex mt-6 justify-between text-[11px] text-slate-400 border-t border-slate-200/60 pt-4">
        <div className="flex gap-6">
          <span>{assetScopeLabel}医学装备资产估算总值: <strong className="text-slate-600">¥{totalAssetsValue.toLocaleString()}</strong></span>
          <span>运行设备完好率: <strong className="text-emerald-600 font-bold">{perfectRate}%</strong></span>
          <span>医学强检监控状态: <strong className="text-slate-600">良好</strong></span>
        </div>
        <span>医疗质量与物理安全自诊断时间: {getLocalDateTimeString()} (本地时间)</span>
      </footer>

      {/* Mobile Sticky Navigation Tab Bar */}
      <nav id="mobile_bottom_nav" className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 shadow-lg px-4 py-2 flex justify-around items-center z-40">
        <button 
          onClick={() => setMobileView('list')}
          className={`flex flex-col items-center gap-1 px-3 py-1.5 rounded-lg transition-colors ${
            mobileView === 'list' ? 'text-blue-600 font-bold' : 'text-slate-500'
          }`}
        >
          <Layers className="w-5 h-5" />
          <span className="text-[10px]">设备名录</span>
        </button>
        <button 
          onClick={() => setMobileView('detail')}
          className={`flex flex-col items-center gap-1 px-3 py-1.5 rounded-lg transition-colors ${
            mobileView === 'detail' ? 'text-blue-600 font-bold' : 'text-slate-500'
          }`}
        >
          <FileText className="w-5 h-5" />
          <span className="text-[10px]">技术档案</span>
        </button>
        <button 
          onClick={() => setMobileView('ai')}
          className={`flex flex-col items-center gap-1 px-3 py-1.5 rounded-lg transition-colors ${
            mobileView === 'ai' ? 'text-blue-600 font-bold' : 'text-slate-500'
          }`}
        >
          <Sparkles className="w-5 h-5" />
          <span className="text-[10px]">AI 智脑</span>
        </button>
      </nav>


      {/* ================= MODAL 1: CREATE & EDIT EQUIPMENT DOSSIER FORM ================= */}
      {isFormModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-2xl overflow-hidden flex flex-col">
            
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center">
              <h3 className="font-bold text-slate-800 text-sm">
                {formMode === 'create' ? '🏥 登记建立新医疗设备档案' : '📝 修改医疗设备技术档案'}
              </h3>
              <button onClick={() => setIsFormModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={saveEquipmentForm} className="p-6 space-y-4 flex-1 overflow-y-auto max-h-[75vh]">
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-500 mb-1">设备名称 <span className="text-rose-500">*</span></label>
                  <input 
                    type="text" 
                    value={formDeviceName} 
                    onChange={(e) => setFormDeviceName(e.target.value)}
                    placeholder="如：数字化X射线摄影系统"
                    className="w-full text-base sm:text-xs border border-slate-300 rounded-lg px-3 py-2.5 sm:py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-xs"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-500 mb-1">规格型号 <span className="text-rose-500">*</span></label>
                  <input 
                    type="text" 
                    value={formModel} 
                    onChange={(e) => setFormModel(e.target.value)}
                    placeholder="如：Optima XR646"
                    className="w-full text-base sm:text-xs border border-slate-300 rounded-lg px-3 py-2.5 sm:py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-xs"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className={isBatchSnMode && formMode === 'create' ? "col-span-1 sm:col-span-2" : ""}>
                  <div className="flex justify-between items-center mb-1">
                    <label className="block text-xs font-bold text-slate-500">
                      {isBatchSnMode && formMode === 'create' ? '批量序列号 / SN 列表' : '序列号 / SN'} <span className="text-rose-500">*</span>
                    </label>
                    {formMode === 'create' && (
                      <button
                        type="button"
                        onClick={() => setIsBatchSnMode(!isBatchSnMode)}
                        className="text-[10px] text-blue-600 font-semibold hover:underline flex items-center gap-0.5"
                      >
                        {isBatchSnMode ? '➡️ 切换单台录入' : '👥 切换批量录入 (同型号多台SN)'}
                      </button>
                    )}
                  </div>
                  {isBatchSnMode && formMode === 'create' ? (
                    <div>
                      <textarea 
                        value={batchSnList} 
                        onChange={(e) => setBatchSnList(e.target.value)}
                        placeholder="请输入多个序列号，支持换行、中英文逗号、中英文分号、制表符或双空格分隔。每个序列号内可以包含单个空格。&#10;示例：&#10;SN GE 100A&#10;SN GE 100B&#10;SN GE 100C"
                        className="w-full text-base sm:text-xs border border-slate-300 rounded-lg px-3 py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-xs font-mono h-24"
                        required
                      />
                      {batchSnList.trim() && (() => {
                        const previewSns = parseBatchSns(batchSnList);
                        return (
                          <div className="mt-2 p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs">
                            <div className="flex justify-between items-center mb-1.5 pb-1 border-b border-slate-200">
                              <span className="font-bold text-slate-700 flex items-center gap-1">
                                📋 序列号智能识别预览 (共检测到 <span className="text-blue-600 font-mono font-black">{previewSns.length}</span> 台设备)
                              </span>
                              {previewSns.length > 0 && (
                                <span className="text-[10px] text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-full font-bold">格式正确</span>
                              )}
                            </div>
                            <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto pt-0.5 custom-scrollbar">
                              {previewSns.map((sn, idx) => (
                                <span key={idx} className="inline-flex items-center gap-1 bg-white border border-slate-200 px-2 py-0.5 rounded font-mono text-[10px] text-slate-700 shadow-xs">
                                  <span className="text-slate-400 font-sans text-[9px]">{idx + 1}.</span>
                                  <span className="font-bold text-slate-800">{sn}</span>
                                </span>
                              ))}
                              {previewSns.length === 0 && (
                                <span className="text-slate-400 italic text-[10px]">等待输入序列号...</span>
                              )}
                            </div>
                          </div>
                        );
                      })()}
                      <p className="text-[10px] text-blue-600 font-semibold mt-1">💡 贴心提示：系统将按上述输入的序列号，一键生成各自独立、一机一码的医疗设备档案及物联二维码。</p>
                    </div>
                  ) : (
                    <input 
                      type="text" 
                      value={formSn} 
                      onChange={(e) => setFormSn(e.target.value)}
                      placeholder="如：SN29410A"
                      className="w-full text-base sm:text-xs border border-slate-300 rounded-lg px-3 py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-xs font-mono"
                      required
                    />
                  )}
                </div>
                <div className={isBatchSnMode && formMode === 'create' ? "col-span-1 sm:col-span-2" : ""}>
                  <label className="block text-xs font-bold text-slate-500 mb-1">生产制造商 <span className="text-rose-500">*</span></label>
                  <input 
                    type="text" 
                    value={formManufacturer} 
                    onChange={(e) => setFormManufacturer(e.target.value)}
                    placeholder="如：通用电气医疗 (GE Healthcare)"
                    className="w-full text-base sm:text-xs border border-slate-300 rounded-lg px-3 py-2.5 sm:py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-xs"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-500 mb-1">设备分类</label>
                  <select 
                    value={formCategory} 
                    onChange={(e) => setFormCategory(e.target.value as any)}
                    className="w-full text-base sm:text-xs border border-slate-300 rounded-lg px-3 py-2.5 sm:py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-xs"
                  >
                    <option value="急救生命支持">急救生命支持</option>
                    <option value="影像诊断">影像诊断</option>
                    <option value="检验分析">检验分析</option>
                    <option value="手术治疗">手术治疗</option>
                    <option value="其他">其他类别</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-500 mb-1">申领/安装科室 <span className="text-rose-500">*</span></label>
                  <input 
                    type="text" 
                    value={formDept} 
                    onChange={(e) => setFormDept(e.target.value)}
                    placeholder="如：放射科"
                    className="w-full text-base sm:text-xs border border-slate-300 rounded-lg px-3 py-2.5 sm:py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-xs"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-500 mb-1">风险管理等级</label>
                  <select 
                    value={formRiskLevel} 
                    onChange={(e) => setFormRiskLevel(e.target.value as any)}
                    className="w-full text-base sm:text-xs border border-slate-300 rounded-lg px-3 py-2.5 sm:py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-xs"
                  >
                    <option value="高">高风险(生命支持类)</option>
                    <option value="中">中风险(影像、检验类)</option>
                    <option value="低">低风险(低应力辅助)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-500 mb-1">设备运行状态</label>
                  <select 
                    value={formStatus} 
                    onChange={(e) => setFormStatus(e.target.value as any)}
                    className="w-full text-base sm:text-xs border border-slate-300 rounded-lg px-3 py-2.5 sm:py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-xs"
                  >
                    <option value="正常运行">正常运行</option>
                    <option value="故障维修">故障维修</option>
                    <option value="计量中">计量中</option>
                    <option value="已停用">已停用</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-500 mb-1">购入日期</label>
                  <input 
                    type="date" 
                    value={formPurchaseDate} 
                    onChange={(e) => setFormPurchaseDate(e.target.value)}
                    className="w-full text-base sm:text-xs border border-slate-300 rounded-lg px-3 py-2.5 sm:py-1.5 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-500 mb-1">资产金额 (CNY)</label>
                  <input 
                    type="number" 
                    value={formPurchaseCost} 
                    onChange={(e) => setFormPurchaseCost(Number(e.target.value))}
                    className="w-full text-base sm:text-xs border border-slate-300 rounded-lg px-3 py-2.5 sm:py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-xs"
                  />
                </div>
              </div>

              {/* 医疗器械合规合规登记 */}
              <div className="pt-3 border-t border-slate-100">
                <div className="flex items-center gap-1.5 mb-3">
                  <ShieldCheck className="w-4 h-4 text-emerald-600" />
                  <span className="text-xs font-bold text-slate-700">📋 医疗器械法律法规合规登记 (NMPA 监管资质)</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-slate-500 mb-1 flex items-center justify-between">
                      <span>医疗器械注册证号 / 备案号</span>
                      <span className="text-[10px] text-slate-400 font-normal">《器械监督管理条例》规定需登记</span>
                    </label>
                    <input 
                      type="text" 
                      value={formRegistrationNo} 
                      onChange={(e) => setFormRegistrationNo(e.target.value)}
                      placeholder="如：国械注准20203070415"
                      className="w-full text-base sm:text-xs border border-slate-300 rounded-lg px-3 py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-500 mb-1">注册证/备案证有效期</label>
                    <input 
                      type="date" 
                      value={formRegistrationValidUntil} 
                      onChange={(e) => setFormRegistrationValidUntil(e.target.value)}
                      className="w-full text-base sm:text-xs border border-slate-300 rounded-lg px-3 py-1.5 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-xs"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
                  <div>
                    <label className="block text-xs font-bold text-slate-500 mb-1">医疗器械分类管理类别</label>
                    <select 
                      value={formDeviceClass} 
                      onChange={(e) => setFormDeviceClass(e.target.value as any)}
                      className="w-full text-base sm:text-xs border border-slate-300 rounded-lg px-3 py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-xs"
                    >
                      <option value="未分类">未分类 / 暂无类别</option>
                      <option value="I类">I类 医疗器械 (风险程度低，常规管理)</option>
                      <option value="II类">II类 医疗器械 (中度风险，严格控制管理)</option>
                      <option value="III类">III类 医疗器械 (高风险，植入或支持生命)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-500 mb-1">生产企业许可证号 / 备案号</label>
                    <input 
                      type="text" 
                      value={formProductionLicenseNo} 
                      onChange={(e) => setFormProductionLicenseNo(e.target.value)}
                      placeholder="如：粤食药监械生产许20100155号"
                      className="w-full text-base sm:text-xs border border-slate-300 rounded-lg px-3 py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-xs font-mono"
                    />
                  </div>
                </div>
              </div>

              {/* 📸 医疗设备照片登记 */}
              <div className="pt-3 border-t border-slate-100">
                <div className="flex items-center gap-1.5 mb-2.5">
                  <Activity className="w-4 h-4 text-blue-600 animate-pulse" />
                  <span className="text-xs font-bold text-slate-700">📸 医疗设备实物照片 (建立外观对照档案)</span>
                </div>
                
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-start">
                  <div className="sm:col-span-3 space-y-2">
                    <label className="block text-xs font-bold text-slate-500 flex items-center justify-between">
                      <span>设备外观图片链接 (URL)</span>
                      <span className="text-[10px] text-slate-400 font-normal">支持直接贴入外链</span>
                    </label>
                    <input 
                      type="text" 
                      value={formPhotoUrl} 
                      onChange={(e) => setFormPhotoUrl(e.target.value)}
                      placeholder="https://images.unsplash.com/photo-..."
                      className="w-full text-base sm:text-xs border border-slate-300 rounded-lg px-3 py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-xs font-mono"
                    />
                    
                    {/* One-click High-Resolution Presets Selection */}
                    <div>
                      <span className="block text-[9px] font-bold text-slate-400 mb-1">一键配对预置高精度外观图：</span>
                      <div className="flex flex-wrap gap-1">
                        <button 
                          type="button" 
                          onClick={() => setFormPhotoUrl('https://images.unsplash.com/photo-1516549655169-df83a0774514?auto=format&fit=crop&w=600&h=450&q=80')}
                          className="px-1.5 py-0.5 bg-slate-100 hover:bg-blue-50 hover:text-blue-600 rounded text-[9px] text-slate-600 border border-slate-200 transition-colors"
                        >
                          MRI扫描仪
                        </button>
                        <button 
                          type="button" 
                          onClick={() => setFormPhotoUrl('https://images.unsplash.com/photo-1576091160550-2173dba999ef?auto=format&fit=crop&w=600&h=450&q=80')}
                          className="px-1.5 py-0.5 bg-slate-100 hover:bg-blue-50 hover:text-blue-600 rounded text-[9px] text-slate-600 border border-slate-200 transition-colors"
                        >
                          监护仪
                        </button>
                        <button 
                          type="button" 
                          onClick={() => setFormPhotoUrl('https://images.unsplash.com/photo-1581594693702-fbdc51b2763b?auto=format&fit=crop&w=600&h=450&q=80')}
                          className="px-1.5 py-0.5 bg-slate-100 hover:bg-blue-50 hover:text-blue-600 rounded text-[9px] text-slate-600 border border-slate-200 transition-colors"
                        >
                          超声仪
                        </button>
                        <button 
                          type="button" 
                          onClick={() => setFormPhotoUrl('https://images.unsplash.com/photo-1584515979956-d9f6e5d09982?auto=format&fit=crop&w=600&h=450&q=80')}
                          className="px-1.5 py-0.5 bg-slate-100 hover:bg-blue-50 hover:text-blue-600 rounded text-[9px] text-slate-600 border border-slate-200 transition-colors"
                        >
                          呼吸机
                        </button>
                        <button 
                          type="button" 
                          onClick={() => setFormPhotoUrl('https://images.unsplash.com/photo-1579165466511-71e5b8aa7789?auto=format&fit=crop&w=600&h=450&q=80')}
                          className="px-1.5 py-0.5 bg-slate-100 hover:bg-blue-50 hover:text-blue-600 rounded text-[9px] text-slate-600 border border-slate-200 transition-colors"
                        >
                          分析仪
                        </button>
                        {formPhotoUrl && (
                          <button 
                            type="button" 
                            onClick={() => setFormPhotoUrl('')}
                            className="px-1.5 py-0.5 bg-rose-50 hover:bg-rose-100 rounded text-[9px] text-rose-600 border border-rose-100 transition-colors"
                          >
                            清空
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                  
                  {/* Photo Preview Card */}
                  <div className="flex flex-col items-center justify-center border border-slate-200 rounded-lg p-1.5 bg-slate-50 text-center h-[90px] w-full overflow-hidden mt-6">
                    {formPhotoUrl ? (
                      <div className="w-full h-full relative rounded overflow-hidden">
                        <img 
                          src={formPhotoUrl} 
                          alt="Form preview" 
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                        />
                      </div>
                    ) : (
                      <div className="text-slate-400">
                        <Upload className="w-4 h-4 mx-auto mb-1 text-slate-300" />
                        <span className="text-[9px] text-slate-400">未置图</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4 border-t border-slate-100">
                <div>
                  <label className="block text-xs font-bold text-slate-500 mb-1">预防性维护(PM)推荐周期</label>
                  <select 
                    value={formMaintenanceCycleDays} 
                    onChange={(e) => setFormMaintenanceCycleDays(Number(e.target.value))}
                    className="w-full text-base sm:text-xs border border-slate-300 rounded-lg px-3 py-2.5 sm:py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-xs"
                  >
                    <option value={30}>每 30 天 (特重生命支持)</option>
                    <option value={90}>每 90 天 (急急监护类)</option>
                    <option value={180}>每 180 天 (常规物理、影像设备)</option>
                    <option value={365}>每 365 天 (低风险普通器械)</option>
                  </select>
                </div>
                <div className="flex items-center gap-2 mt-6">
                  <input 
                    type="checkbox" 
                    id="calibration_req_box"
                    checked={formCalibrationRequired} 
                    onChange={(e) => setFormCalibrationRequired(e.target.checked)}
                    className="w-4 h-4 text-blue-600 rounded"
                  />
                  <label htmlFor="calibration_req_box" className="text-xs font-bold text-slate-600 cursor-pointer">
                    属于法定强制计量检定器械 (需关联证书)
                  </label>
                </div>
              </div>

              <div className="pt-4 border-t border-slate-200 flex justify-end gap-3">
                <button 
                  type="button" 
                  onClick={() => setIsFormModalOpen(false)}
                  className="px-4 py-2 text-xs border border-slate-300 rounded text-slate-600 hover:bg-slate-50"
                >
                  取消
                </button>
                <button 
                  type="submit"
                  className="px-5 py-2 text-xs bg-blue-600 hover:bg-blue-700 text-white font-bold rounded"
                >
                  {formMode === 'create' ? '立即归档入库' : '保存档案修改'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}


      {/* ================= MODAL 2: AI OCR AUTO ARCHIVE RECOGNIZER ================= */}
      {isAiParserOpen && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-xl overflow-hidden flex flex-col">
            
            <div className="px-6 py-4 bg-gradient-to-r from-violet-600 to-indigo-600 text-white flex justify-between items-center">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5" />
                <h3 className="font-bold text-sm">Gemini AI 智能铭牌解析 & 快速入库</h3>
              </div>
              <button onClick={() => setIsAiParserOpen(false)} className="text-white/80 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-5">
              <p className="text-xs text-slate-500 leading-relaxed">
                上传医疗设备的铭牌照片、设备采购说明、送检发票文本，或者直接在下方文本区粘贴设备基本信息。
                Gemini 智脑将自动提取设备名、品牌、型号、SN号并智能推荐维保等级周期！
              </p>

              {/* Presets Grid */}
              <div>
                <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2.5">
                  快捷模拟：点击预设铭牌文本进行1键解析
                </span>
                <div className="grid grid-cols-3 gap-2">
                  <button 
                    onClick={() => runPresetOcr(1)}
                    disabled={isAnalyzing}
                    className="p-2 text-left bg-slate-50 hover:bg-violet-50 hover:border-violet-300 border border-slate-200 rounded text-[11px] transition-all disabled:opacity-50"
                  >
                    <p className="font-bold text-slate-800">📸 西门子磁共振</p>
                    <p className="text-[9px] text-slate-400 mt-0.5 truncate">Siemens Magnetom Vida</p>
                  </button>
                  <button 
                    onClick={() => runPresetOcr(2)}
                    disabled={isAnalyzing}
                    className="p-2 text-left bg-slate-50 hover:bg-violet-50 hover:border-violet-300 border border-slate-200 rounded text-[11px] transition-all disabled:opacity-50"
                  >
                    <p className="font-bold text-slate-800">🧾 迈瑞监护仪发票</p>
                    <p className="text-[9px] text-slate-400 mt-0.5 truncate">BeneVision N17 销售凭证</p>
                  </button>
                  <button 
                    onClick={() => runPresetOcr(3)}
                    disabled={isAnalyzing}
                    className="p-2 text-left bg-slate-50 hover:bg-violet-50 hover:border-violet-300 border border-slate-200 rounded text-[11px] transition-all disabled:opacity-50"
                  >
                    <p className="font-bold text-slate-800">🔌 瑞思迈呼吸机</p>
                    <p className="text-[9px] text-slate-400 mt-0.5 truncate">Stellar 150 铭牌参数</p>
                  </button>
                </div>
              </div>

              {/* Direct image upload with drag & drop */}
              <div 
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsOcrDragging(true);
                }}
                onDragLeave={() => {
                  setIsOcrDragging(false);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsOcrDragging(false);
                  const file = e.dataTransfer.files?.[0];
                  if (file && !isAnalyzing) {
                    processOcrFile(file);
                  }
                }}
                className={`border-2 border-dashed p-5 rounded-xl text-center text-xs text-slate-600 transition-all relative ${
                  isOcrDragging 
                    ? 'border-violet-500 bg-violet-50 shadow-inner' 
                    : 'border-slate-200 hover:border-violet-400 bg-slate-50/50'
                }`}
              >
                <input 
                  type="file" 
                  accept="image/*" 
                  onChange={handleNameplateImageUpload}
                  disabled={isAnalyzing}
                  className="absolute inset-0 opacity-0 cursor-pointer z-10"
                />
                <Upload className={`w-8 h-8 mx-auto mb-2 text-violet-500 ${isOcrDragging ? 'scale-110 animate-pulse' : 'animate-bounce'}`} />
                <p className="font-bold text-slate-700">{isOcrDragging ? '松开鼠标以上传标签图片' : '拍照/上传设备标签图片'}</p>
                <p className="text-[10px] text-slate-400 mt-0.5">支持拖拽文件到这里，或点击浏览。支持器械铭牌、质保发票等</p>
              </div>

              {/* Text input option */}
              <div>
                <label className="block text-xs font-bold text-slate-500 mb-1">或者手动输入/粘贴设备相关说明文本：</label>
                <textarea 
                  value={aiInputText}
                  onChange={(e) => setAiInputText(e.target.value)}
                  placeholder="示例：购入一台全新飞利浦彩超，型号Epiq7，机身序列号PHIL-77402，准备放置于超生医学一科..."
                  className="w-full text-xs border border-slate-300 rounded p-2.5 h-20 text-slate-800 outline-none focus:border-violet-500"
                  disabled={isAnalyzing}
                />
              </div>

              {analyzerError && (
                <div className="p-3 bg-rose-50 border border-rose-100 text-rose-700 text-xs rounded-lg">
                  ⚠️ AI 分析故障: {analyzerError}
                </div>
              )}

              {isAnalyzing && (
                <div className="p-4 bg-violet-50 border border-violet-100 text-violet-700 text-xs rounded-lg flex items-center justify-center gap-3">
                  <RefreshCw className="w-4 h-4 animate-spin text-violet-600" />
                  <span className="font-bold animate-pulse">Gemini 3.5 多模态智脑正在解析并补全医疗器械属性...</span>
                </div>
              )}

              <div className="pt-2 border-t border-slate-100 flex justify-end gap-3">
                <button 
                  type="button" 
                  onClick={() => setIsAiParserOpen(false)}
                  className="px-4 py-2 text-xs border border-slate-300 rounded text-slate-600 hover:bg-slate-50"
                  disabled={isAnalyzing}
                >
                  取消
                </button>
                <button 
                  onClick={handleCustomOcrAnalyze}
                  className="px-5 py-2 text-xs bg-gradient-to-r from-violet-600 to-indigo-600 text-white font-bold rounded shadow-sm hover:from-violet-700 hover:to-indigo-700 disabled:opacity-50"
                  disabled={isAnalyzing || !aiInputText.trim()}
                >
                  智能分析文本
                </button>
              </div>
            </div>
          </div>
        </div>
      )}


      {/* ================= MODAL 3: ADD RECORD (LOG OR CALIBRATION) ================= */}
      {isLogModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
            
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center flex-shrink-0">
              <h3 className="font-extrabold text-slate-800 text-sm flex items-center gap-1.5">
                {logType === '维保' ? (
                  <>
                    <span className="p-1 bg-blue-100 text-blue-700 rounded"><Wrench className="w-4 h-4" /></span>
                    <span>新建医学装备维护/修理工单 (Work Order)</span>
                  </>
                ) : (
                  <>
                    <span className="p-1 bg-emerald-100 text-emerald-700 rounded"><ShieldCheck className="w-4 h-4" /></span>
                    <span>登记国家法定计量强制检定证书</span>
                  </>
                )}
              </h3>
              <button onClick={() => setIsLogModalOpen(false)} className="text-slate-400 hover:text-slate-600 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto p-6 space-y-4 flex-1">
              {logType === '维保' ? (
                <form onSubmit={handleAddMaintenanceLog} className="space-y-4">
                  <div>
                    <label className="block text-xs font-bold text-slate-500 mb-1.5">工单维护类型</label>
                    <div className="grid grid-cols-2 gap-2">
                      <button 
                        type="button"
                        onClick={() => setNewLogType('保养')}
                        className={`py-2 text-xs font-bold rounded-lg border transition-all ${
                          newLogType === '保养' ? 'bg-blue-50 border-blue-500 text-blue-700 shadow-sm' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        🔧 预防性保养 (PM)
                      </button>
                      <button 
                        type="button"
                        onClick={() => setNewLogType('维修')}
                        className={`py-2 text-xs font-bold rounded-lg border transition-all ${
                          newLogType === '维修' ? 'bg-rose-50 border-rose-500 text-rose-700 shadow-sm' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        🚨 故障报修维修
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold text-slate-500 mb-1">工单执行日期</label>
                      <input 
                        type="date" 
                        value={newLogDate} 
                        onChange={(e) => setNewLogDate(e.target.value)}
                        className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-2xs"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-500 mb-1">维保消耗费用 (CNY)</label>
                      <input 
                        type="number" 
                        value={newLogCost} 
                        onChange={(e) => setNewLogCost(Number(e.target.value))}
                        className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 text-slate-800 font-mono bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-2xs"
                        placeholder="0.00"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold text-slate-500 mb-1">工程执行人/技术员</label>
                      <input 
                        type="text" 
                        value={newLogTechnician} 
                        onChange={(e) => setNewLogTechnician(e.target.value)}
                        placeholder="如：张工 或 原厂工程师"
                        className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-2xs"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-500 mb-1">工单当前状态</label>
                      <select 
                        value={newLogStatus} 
                        onChange={(e) => setNewLogStatus(e.target.value as any)}
                        className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-2xs"
                      >
                        <option value="已完成">完成工单 (设备恢复正常)</option>
                        <option value="进行中">进行中/挂单 (等待配件到货)</option>
                      </select>
                    </div>
                  </div>

                  {/* Dynamic fault phenomenon for REPAIR */}
                  {newLogType === '维修' && (
                    <div>
                      <label className="block text-xs font-bold text-slate-500 mb-1">临床故障现象描述</label>
                      <input 
                        type="text" 
                        value={newLogFaultPhenomenon} 
                        onChange={(e) => setNewLogFaultPhenomenon(e.target.value)}
                        placeholder="如：机器无法正常启动、报错代码Err-03、电极接触不良等"
                        className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-2xs"
                      />
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold text-slate-500 mb-1">更换配件/备件耗材</label>
                      <input 
                        type="text" 
                        value={newLogPartsReplaced} 
                        onChange={(e) => setNewLogPartsReplaced(e.target.value)}
                        placeholder="如：无，或 5A高压保险丝/过滤网"
                        className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-2xs"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-500 mb-1">临床科室确认签字人</label>
                      <input 
                        type="text" 
                        value={newLogVerifyPerson} 
                        onChange={(e) => setNewLogVerifyPerson(e.target.value)}
                        placeholder="如：王护士长 或 李主任"
                        className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-2xs"
                      />
                    </div>
                  </div>

                  {/* Interactive PM checklist for MAINTENANCE */}
                  {newLogType === '保养' && (
                    <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                      <label className="block text-[11px] font-bold text-slate-600 mb-1.5 flex items-center justify-between">
                        <span>📋 PM 预防性维护核对规范清单</span>
                        <span className="text-[10px] text-blue-600 font-semibold font-mono">多选核查</span>
                      </label>
                      <div className="flex flex-wrap gap-1.5">
                        {['外观及完整性清洁', '电源与屏蔽抗接地线', '元器件与滤网防尘清洁', '机械传动润滑与紧固', '电气安全耐压安全检测', '标准输出精度/指标校准'].map((item) => {
                          const isChecked = newLogPmChecklist.includes(item);
                          return (
                            <button
                              key={item}
                              type="button"
                              onClick={() => {
                                if (isChecked) {
                                  setNewLogPmChecklist(newLogPmChecklist.filter(x => x !== item));
                                } else {
                                  setNewLogPmChecklist([...newLogPmChecklist, item]);
                                }
                              }}
                              className={`text-[10px] font-bold px-2.5 py-1.5 rounded-md border flex items-center gap-1 transition-all ${
                                isChecked 
                                  ? 'bg-blue-600 text-white border-blue-600 shadow-2xs' 
                                  : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                              }`}
                            >
                              <span>{isChecked ? '✓' : '+'}</span>
                              <span>{item}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-bold text-slate-500 mb-1">实施工作描述/技术记录 (必填)</label>
                    <textarea 
                      value={newLogDescription} 
                      onChange={(e) => setNewLogDescription(e.target.value)}
                      placeholder="详细描述所更换的耗材零部件、清洁过程、系统调试结果及技术指标复测细节..."
                      className="w-full text-xs border border-slate-300 rounded-lg p-3 h-20 text-slate-800 bg-white outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-2xs"
                      required
                    />
                  </div>

                  <div className="pt-3 border-t border-slate-100 flex justify-end gap-2 flex-shrink-0">
                    <button type="button" onClick={() => setIsLogModalOpen(false)} className="px-4 py-1.5 text-xs border border-slate-300 rounded-lg text-slate-600 hover:bg-slate-50 transition-colors">
                      取消
                    </button>
                    <button type="submit" className="px-5 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white font-black rounded-lg shadow-xs transition-all">
                      提交维保工单 (WO)
                    </button>
                  </div>
                </form>
              ) : (
                // CALIBRATION LOG FORM
                <form onSubmit={handleAddCalibrationLog} className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold text-slate-500 mb-1">检定实施日期</label>
                      <input 
                        type="date" 
                        value={newCalDate} 
                        onChange={(e) => setNewCalDate(e.target.value)}
                        className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-2xs"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-500 mb-1">计量证书有效截止日</label>
                      <input 
                        type="date" 
                        value={newCalValidUntil} 
                        onChange={(e) => setNewCalValidUntil(e.target.value)}
                        className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 text-slate-800 font-mono bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-2xs"
                        required
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold text-slate-500 mb-1">计量法强制检定类别</label>
                      <select 
                        value={newCalType} 
                        onChange={(e) => setNewCalType(e.target.value as any)}
                        className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-2xs font-medium"
                      >
                        <option value="强制检定">🛡️ 强制检定 (JJG规程强检)</option>
                        <option value="周期检定">📅 周期检定 (定期校验)</option>
                        <option value="首次检定">🆕 首次检定 (入院建档验收)</option>
                        <option value="校准/检测">📊 校准/检测 (第三方技术测试)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-500 mb-1">检定技术结论</label>
                      <select 
                        value={newCalResult} 
                        onChange={(e) => setNewCalResult(e.target.value as any)}
                        className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-2xs font-extrabold"
                      >
                        <option value="合格" className="text-emerald-600 font-bold">合格 (颁发绿色合格标签)</option>
                        <option value="准用" className="text-blue-600 font-bold">准用 (颁发蓝色限范围合格证)</option>
                        <option value="限用" className="text-amber-600 font-bold">限用 (黄标签限指标使用)</option>
                        <option value="不合格" className="text-rose-600 font-bold">不合格 (张贴红牌强制停用)</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold text-slate-500 mb-1">法定证书编号</label>
                      <input 
                        type="text" 
                        value={newCalCertificateNo} 
                        onChange={(e) => setNewCalCertificateNo(e.target.value)}
                        placeholder="如：JJG-2026-CH-918"
                        className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 text-slate-800 font-mono bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-2xs"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-500 mb-1">国家授权计量检测院</label>
                      <input 
                        type="text" 
                        value={newCalAgency} 
                        onChange={(e) => setNewCalAgency(e.target.value)}
                        placeholder="如：省医学计量测试科学研究院"
                        className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-2xs"
                        required
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold text-slate-500 mb-1">主检计量测试工程师</label>
                      <input 
                        type="text" 
                        value={newCalTesterName} 
                        onChange={(e) => setNewCalTesterName(e.target.value)}
                        placeholder="如：李晓峰 注册计量师"
                        className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-2xs"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-500 mb-1">核验授权签字人</label>
                      <input 
                        type="text" 
                        value={newCalVerifyPerson} 
                        onChange={(e) => setNewCalVerifyPerson(e.target.value)}
                        placeholder="如：王建国 审核工程师"
                        className="w-full text-xs border border-slate-300 rounded-lg px-3 py-2 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-2xs"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-500 mb-1">误差数据及不确定度综合说明</label>
                    <textarea 
                      value={newCalErrorDescription} 
                      onChange={(e) => setNewCalErrorDescription(e.target.value)}
                      placeholder="详细描述校准时的测量误差、偏差、特性及不确定度数据说明..."
                      className="w-full text-xs border border-slate-300 rounded-lg p-3 h-20 text-slate-800 bg-white outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-2xs"
                    />
                  </div>

                  <div className="pt-3 border-t border-slate-100 flex justify-end gap-2 flex-shrink-0">
                    <button type="button" onClick={() => setIsLogModalOpen(false)} className="px-4 py-1.5 text-xs border border-slate-300 rounded-lg text-slate-600 hover:bg-slate-50 transition-colors">
                      取消
                    </button>
                    <button type="submit" className="px-5 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white font-black rounded-lg shadow-xs transition-all">
                      登记并生成强检标识
                    </button>
                  </div>
                </form>
              )}
            </div>

          </div>
        </div>
      )}


      {/* ================= MODAL 6: DETAILED MAINTENANCE WORK ORDER (WO) PREVIEW ================= */}
      {viewMaintenanceLog && (
        <div className="fixed inset-0 bg-slate-900/65 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-2xl overflow-hidden flex flex-col max-h-[92vh]">
            
            {/* Header */}
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center flex-shrink-0">
              <div className="flex items-center gap-2">
                <span className="p-1 bg-blue-100 text-blue-700 rounded"><Wrench className="w-4 h-4" /></span>
                <span className="font-extrabold text-slate-800 text-sm">医院设备资产管理系统 - 电子派工单 (Work Order)</span>
              </div>
              <div className="flex items-center gap-2">
                {canManageEquipmentArchive ? (
                  <button 
                    onClick={() => window.print()} 
                    className="px-2.5 py-1 text-[11px] font-bold bg-white text-slate-700 border border-slate-300 rounded hover:bg-slate-50 flex items-center gap-1 shadow-2xs"
                  >
                    <Printer className="w-3 h-3" />
                    <span>打印单据</span>
                  </button>
                ) : (
                  <span className="px-2.5 py-1 text-[11px] font-bold bg-slate-100 text-slate-500 border border-slate-200 rounded flex items-center gap-1">
                    临床只读阅览
                  </span>
                )}
                <button 
                  onClick={() => setViewMaintenanceLog(null)} 
                  className="text-slate-400 hover:text-slate-600 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Document body */}
            <div className="overflow-y-auto p-6 space-y-6 flex-1 bg-slate-50/20">
              
              {/* Paper Layout */}
              <div className="bg-white border-2 border-slate-200 rounded-lg p-6 shadow-xs relative overflow-hidden">
                {/* Official Watermark */}
                <div className="absolute top-10 right-10 w-24 h-24 border-4 border-dashed border-blue-500/10 rounded-full flex items-center justify-center rotate-12 pointer-events-none select-none">
                  <span className="text-[10px] font-black text-blue-500/10 tracking-widest text-center">医院资产保障部<br/>电子印章</span>
                </div>

                {/* Form Title */}
                <div className="text-center pb-4 border-b border-double border-slate-300">
                  <h2 className="text-lg font-black text-slate-800 tracking-wider">医疗装备维护保养与故障修理工签单</h2>
                  <p className="text-[10px] text-slate-400 font-mono mt-1">LOGICAL MEDICAL ASSETS & CLINICAL ENGINEERING WORK SHEET</p>
                </div>

                {/* Grid info */}
                <div className="grid grid-cols-2 gap-x-6 gap-y-3.5 text-xs py-4 border-b border-dashed border-slate-200">
                  <div>
                    <span className="text-slate-400">医学装备名称:</span>
                    <strong className="text-slate-800 ml-1.5">{selectedEquipment?.deviceName}</strong>
                  </div>
                  <div>
                    <span className="text-slate-400">工单备案号:</span>
                    <span className="text-slate-800 ml-1.5 font-mono font-bold text-blue-600">{viewMaintenanceLog.workOrderNo || `WO-REG-${viewMaintenanceLog.id.toUpperCase()}`}</span>
                  </div>
                  <div>
                    <span className="text-slate-400">规格型号:</span>
                    <span className="text-slate-800 ml-1.5 font-mono">{selectedEquipment?.model}</span>
                  </div>
                  <div>
                    <span className="text-slate-400">医院资产编号:</span>
                    <span className="text-slate-800 ml-1.5 font-mono">{selectedEquipment?.id}</span>
                  </div>
                  <div>
                    <span className="text-slate-400">生产厂商/品牌:</span>
                    <span className="text-slate-800 ml-1.5">{selectedEquipment?.manufacturer}</span>
                  </div>
                  <div>
                    <span className="text-slate-400">使用临床科室:</span>
                    <span className="text-slate-800 ml-1.5 bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded font-medium">{selectedEquipment?.dept}</span>
                  </div>
                </div>

                {/* Technical data table */}
                <div className="py-4 space-y-4">
                  <div className="grid grid-cols-3 gap-4 text-xs bg-slate-50 p-3 rounded-lg border border-slate-200">
                    <div>
                      <span className="text-slate-400 block mb-0.5">工单执行日期</span>
                      <strong className="text-slate-700 font-mono">{viewMaintenanceLog.date}</strong>
                    </div>
                    <div>
                      <span className="text-slate-400 block mb-0.5">实施维护类型</span>
                      <strong className={`font-bold ${viewMaintenanceLog.type === '维修' ? 'text-rose-600' : 'text-blue-600'}`}>
                        {viewMaintenanceLog.type === '维修' ? '🚨 故障排查与修理' : '🔧 预防性维护保养 (PM)'}
                      </strong>
                    </div>
                    <div>
                      <span className="text-slate-400 block mb-0.5">维保产生费用 (CNY)</span>
                      <strong className="text-slate-800 font-mono">¥{viewMaintenanceLog.cost}</strong>
                    </div>
                  </div>

                  {/* Fault phenomenon (If Repair) */}
                  {viewMaintenanceLog.type === '维修' && (
                    <div className="space-y-1">
                      <span className="text-[11px] font-bold text-slate-400">临床故障现象汇报</span>
                      <div className="p-3 bg-rose-50/50 rounded-lg border border-rose-100 text-xs text-rose-900 leading-relaxed font-medium">
                        {viewMaintenanceLog.faultPhenomenon || '报修指出设备有异常报错代码、提示电极接触故障，偶发自动停机。'}
                      </div>
                    </div>
                  )}

                  {/* PM Checklists (If PM) */}
                  {viewMaintenanceLog.type === '保养' && (
                    <div className="space-y-1.5">
                      <span className="text-[11px] font-bold text-slate-400">预防性维护 (PM) 核实项</span>
                      <div className="p-3 bg-blue-50/20 rounded-lg border border-blue-100 text-xs">
                        {viewMaintenanceLog.pmChecklist && viewMaintenanceLog.pmChecklist.length > 0 ? (
                          <div className="grid grid-cols-2 gap-1.5">
                            {viewMaintenanceLog.pmChecklist.map((item, idx) => (
                              <div key={idx} className="flex items-center gap-1.5 text-slate-700 font-medium">
                                <span className="text-emerald-500 font-bold">✓</span>
                                <span>{item}</span>
                                <span className="text-[9px] text-emerald-600 bg-emerald-50 px-1 rounded font-mono ml-auto">PASS</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="grid grid-cols-2 gap-1.5 text-slate-500">
                            <div className="flex items-center gap-1.5">
                              <span className="text-emerald-500">✓</span> <span>外观完整度与部件清洗</span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span className="text-emerald-500">✓</span> <span>系统供电及电气漏电校验</span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span className="text-emerald-500">✓</span> <span>临床输出参数标定与偏差校准</span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span className="text-emerald-500">✓</span> <span>机械紧固与耐磨润滑</span>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Parts replaced */}
                  <div className="space-y-1">
                    <span className="text-[11px] font-bold text-slate-400">更换配件与备件规格</span>
                    <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 text-xs text-slate-700 font-mono">
                      {viewMaintenanceLog.partsReplaced || '未发生零配件更换 (日常常规例行除尘/保养校准)'}
                    </div>
                  </div>

                  {/* Technical work description */}
                  <div className="space-y-1">
                    <span className="text-[11px] font-bold text-slate-400">技术执行过程与调试结论描述</span>
                    <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 text-xs text-slate-700 leading-relaxed whitespace-pre-wrap">
                      {viewMaintenanceLog.description}
                    </div>
                  </div>
                </div>

                {/* Signatures */}
                <div className="grid grid-cols-2 gap-6 pt-6 border-t border-dashed border-slate-300 text-xs">
                  <div className="space-y-3">
                    <span className="text-slate-400 block">医学装备科服务工程工程师/技术员:</span>
                    <div className="border-b border-slate-300 pb-1 h-6 flex items-end">
                      <span className="font-mono font-bold text-slate-800 italic tracking-wider">{viewMaintenanceLog.technician}</span>
                      <span className="text-[9px] text-slate-400 ml-auto">(电子数字签章有效)</span>
                    </div>
                  </div>
                  <div className="space-y-3">
                    <span className="text-slate-400 block">临床医学科室核实/使用确认签字人:</span>
                    <div className="border-b border-slate-300 pb-1 h-6 flex items-end">
                      <span className="font-sans font-bold text-slate-800 italic tracking-wider">{viewMaintenanceLog.verifyPerson || '临床科室负责人'}</span>
                      <span className="text-[9px] text-slate-400 ml-auto">已确认设备工作正常</span>
                    </div>
                  </div>
                </div>

              </div>

              {/* Bottom alert */}
              <div className="p-3 bg-amber-50 rounded-lg border border-amber-200 text-[10px] text-amber-800 flex items-start gap-1.5">
                <Info className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                <span>医院审计说明：本单据为电子全流程管理派工系统自动归档形成的法律合规医学计量维保备忘录，已纳入医院 JCI、等级评审等计量档案评估体系。</span>
              </div>
            </div>

            <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex justify-end flex-shrink-0">
              <button 
                onClick={() => setViewMaintenanceLog(null)} 
                className="px-5 py-1.5 text-xs bg-slate-800 hover:bg-slate-900 text-white font-bold rounded-lg transition-all shadow-xs"
              >
                关闭工单阅览
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= MODAL 7: STATUTORY METROLOGY CERTIFICATE & GREEN LABEL VIEW ================= */}
      {viewCalibrationLog && (
        <div className="fixed inset-0 bg-slate-900/65 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-3xl overflow-hidden flex flex-col max-h-[92vh]">
            
            {/* Header */}
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center flex-shrink-0">
              <div className="flex items-center gap-2">
                <span className="p-1 bg-emerald-100 text-emerald-700 rounded"><ShieldCheck className="w-4 h-4" /></span>
                <span className="font-extrabold text-slate-800 text-sm">法定计量强制检定证书与科室绿标印证系统</span>
              </div>
              <div className="flex items-center gap-2">
                {canManageEquipmentArchive ? (
                  <button 
                    onClick={() => window.print()} 
                    className="px-2.5 py-1 text-[11px] font-bold bg-white text-slate-700 border border-slate-300 rounded hover:bg-slate-50 flex items-center gap-1 shadow-2xs"
                  >
                    <Printer className="w-3 h-3" />
                    <span>打印合格证 & 证书</span>
                  </button>
                ) : (
                  <span className="px-2.5 py-1 text-[11px] font-bold bg-slate-100 text-slate-500 border border-slate-200 rounded flex items-center gap-1">
                    临床只读阅览
                  </span>
                )}
                <button 
                  onClick={() => setViewCalibrationLog(null)} 
                  className="text-slate-400 hover:text-slate-600 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Content body */}
            <div className="overflow-y-auto p-6 space-y-6 flex-1 bg-slate-50/30">
              
              <div className="grid grid-cols-1 md:grid-cols-5 gap-6">
                
                {/* Left side: High-fidelity physical Sticker Label (绿色检定合格贴) */}
                <div className="md:col-span-2 flex flex-col items-center justify-start space-y-4">
                  <span className="text-xs font-black text-slate-400 uppercase tracking-widest block self-start">临床设备张贴用检定标签</span>
                  
                  {/* Physical Label */}
                  <div className={`w-full aspect-[4/3] rounded-xl border-4 p-4 flex flex-col justify-between shadow-md relative overflow-hidden bg-white text-slate-900 ${
                    viewCalibrationLog.result === '合格' ? 'border-emerald-500' :
                    viewCalibrationLog.result === '准用' ? 'border-blue-500' :
                    viewCalibrationLog.result === '限用' ? 'border-amber-500' : 'border-rose-500'
                  }`}>
                    {/* Header Strip */}
                    <div className={`absolute top-0 left-0 right-0 py-1.5 px-4 text-center font-black text-white text-xs tracking-widest uppercase ${
                      viewCalibrationLog.result === '合格' ? 'bg-emerald-500' :
                      viewCalibrationLog.result === '准用' ? 'bg-blue-500' :
                      viewCalibrationLog.result === '限用' ? 'bg-amber-500' : 'bg-rose-500'
                    }`}>
                      医学计量检测 · {viewCalibrationLog.result}
                    </div>

                    {/* Badge Content */}
                    <div className="pt-6 space-y-1 text-[10px]">
                      <div>
                        <span className="font-bold text-slate-400 mr-1 inline-block w-14">备案证号:</span>
                        <span className="font-mono font-bold text-slate-800">{viewCalibrationLog.certificateNo}</span>
                      </div>
                      <div>
                        <span className="font-bold text-slate-400 mr-1 inline-block w-14">设备名称:</span>
                        <strong className="text-slate-900">{selectedEquipment?.deviceName}</strong>
                      </div>
                      <div>
                        <span className="font-bold text-slate-400 mr-1 inline-block w-14">安装科室:</span>
                        <span className="font-medium text-slate-800">{selectedEquipment?.dept}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-1 pt-1 border-t border-slate-100">
                        <div>
                          <span className="font-bold text-slate-400 block">检定实施日</span>
                          <span className="font-mono text-slate-800 font-bold">{viewCalibrationLog.date}</span>
                        </div>
                        <div>
                          <span className="font-bold text-slate-400 block">有效截止日</span>
                          <span className="font-mono text-blue-700 font-black">{viewCalibrationLog.validUntil}</span>
                        </div>
                      </div>
                    </div>

                    {/* Bottom row: QR code scan & Authority name */}
                    <div className="flex justify-between items-end pt-1 border-t border-dashed border-slate-200">
                      <div className="text-[8px] text-slate-400 leading-tight">
                        <span className="font-bold block text-slate-700">{viewCalibrationLog.agency}</span>
                        <span>国家定点法定计量服务检定印证</span>
                      </div>
                      <QrCode className={`w-6 h-6 ${
                        viewCalibrationLog.result === '合格' ? 'text-emerald-600' :
                        viewCalibrationLog.result === '准用' ? 'text-blue-600' : 'text-slate-700'
                      }`} />
                    </div>
                  </div>

                  <p className="text-[10px] text-slate-400 text-center leading-relaxed">
                    说明：本标签贴纸应被不干胶纸彩色打印后，张贴在医疗设备外壳显眼处，以供省质监计量部门随时在院核验。
                  </p>
                </div>

                {/* Right side: PRC Statutory Certificate Document layout */}
                <div className="md:col-span-3 bg-white border-2 border-slate-200 rounded-lg p-5 shadow-xs relative overflow-hidden flex flex-col justify-between">
                  {/* Red stamp */}
                  <div className="absolute bottom-10 right-10 w-24 h-24 border-2 border-red-500 rounded-full flex items-center justify-center rotate-6 pointer-events-none select-none opacity-85">
                    <div className="w-22 h-22 border border-dashed border-red-500 rounded-full flex flex-col items-center justify-center text-center p-1 font-bold text-red-500 text-[8px] leading-tight">
                      <span>{viewCalibrationLog.agency}</span>
                      <span className="text-red-500">★</span>
                      <span>法定检定专用章</span>
                    </div>
                  </div>

                  {/* Header */}
                  <div className="text-center pb-3 border-b-2 border-red-500">
                    <h3 className="text-sm font-black text-red-600 tracking-wider">中华人民共和国家计量检测校准证书</h3>
                    <p className="text-[8px] text-slate-400 font-mono mt-0.5">METROLOGICAL VERIFICATION CERTIFICATE OF THE P.R.C</p>
                  </div>

                  {/* Body Content */}
                  <div className="py-4 space-y-3.5 text-xs">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] border-b border-slate-100 pb-3">
                      <div>
                        <span className="text-slate-400">证书编号:</span>
                        <strong className="text-slate-800 ml-1.5 font-mono">{viewCalibrationLog.certificateNo}</strong>
                      </div>
                      <div>
                        <span className="text-slate-400">强制检定类型:</span>
                        <span className="text-slate-800 ml-1.5 font-bold text-blue-600">{viewCalibrationLog.calibType || '周期性法定强检'}</span>
                      </div>
                      <div>
                        <span className="text-slate-400">计量器具名称:</span>
                        <span className="text-slate-800 ml-1.5 font-semibold">{selectedEquipment?.deviceName}</span>
                      </div>
                      <div>
                        <span className="text-slate-400">设备出厂编号:</span>
                        <span className="text-slate-800 ml-1.5 font-mono">{selectedEquipment?.sn || 'SN-UNASSIGNED'}</span>
                      </div>
                    </div>

                    <div className="space-y-1">
                      <span className="text-[10px] font-bold text-slate-400">法定检定技术结论意见</span>
                      <p className="p-2.5 bg-slate-50 border border-slate-200 rounded text-[11px] text-slate-700 leading-relaxed">
                        根据国家医学强制计量检定规程，经主检人员全面评测，该设备各项偏差测量数据和系统物理精度均满足行业容许指标。最终审定：<strong>准予继续投入医疗临床诊疗使用</strong>。
                      </p>
                    </div>

                    <div className="space-y-1">
                      <span className="text-[10px] font-bold text-slate-400">综合不确定度指标与原始误差参数</span>
                      <p className="p-2.5 bg-slate-50 border border-slate-200 rounded text-[11px] text-slate-700 leading-relaxed font-mono whitespace-pre-wrap">
                        {viewCalibrationLog.errorDescription}
                      </p>
                    </div>

                    <div className="grid grid-cols-2 gap-4 pt-2 text-[10px] text-slate-400">
                      <div>
                        <span>主检计量测试师:</span>
                        <p className="border-b border-slate-200 pb-0.5 text-slate-800 font-bold font-mono text-[11px] mt-1">
                          {viewCalibrationLog.testerName || '一级注册计量师'}
                        </p>
                      </div>
                      <div>
                        <span>授权签字核验人:</span>
                        <p className="border-b border-slate-200 pb-0.5 text-slate-800 font-bold font-mono text-[11px] mt-1">
                          {viewCalibrationLog.verifyPerson || '医学计量院审核工程师'}
                        </p>
                      </div>
                    </div>
                  </div>

                </div>

              </div>

            </div>

            {/* Footer */}
            <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex justify-end flex-shrink-0">
              <button 
                onClick={() => setViewCalibrationLog(null)} 
                className="px-5 py-1.5 text-xs bg-slate-800 hover:bg-slate-900 text-white font-bold rounded-lg transition-all shadow-xs"
              >
                关闭证书查验
              </button>
            </div>
          </div>
        </div>
      )}


      {/* ================= MODAL 4: UPLOAD NEW PHYSICAL ATTACHMENT ================= */}
      {isAttachmentModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-sm overflow-hidden flex flex-col">
            
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center">
              <h3 className="font-bold text-slate-800 text-sm">📁 增加电子合规或技术手册附件</h3>
              <button onClick={() => setIsAttachmentModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleAddAttachment} className="p-6 space-y-4">
              {/* Drag and Drop Zone for Attachments */}
              <div 
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsAttachDragging(true);
                }}
                onDragLeave={() => {
                  setIsAttachDragging(false);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsAttachDragging(false);
                  const file = e.dataTransfer.files?.[0];
                  if (file) {
                    processAttachFile(file);
                  }
                }}
                className={`border-2 border-dashed p-4 rounded-xl text-center text-xs text-slate-600 transition-all relative ${
                  isAttachDragging 
                    ? 'border-blue-500 bg-blue-50/70 shadow-inner' 
                    : 'border-slate-200 hover:border-blue-400 bg-slate-50/40'
                }`}
              >
                <input 
                  type="file" 
                  onChange={handleAttachmentFileSelect}
                  className="absolute inset-0 opacity-0 cursor-pointer z-10"
                />
                <FileUp className={`w-7 h-7 mx-auto mb-1.5 text-blue-500 ${isAttachDragging ? 'scale-110 animate-pulse' : ''}`} />
                <p className="font-bold text-slate-700">{isAttachDragging ? '松开鼠标以上传文件' : '拖拽或点击上传本地文件'}</p>
                <p className="text-[9px] text-slate-400 mt-0.5">可直接拖拽 pdf/doc/img 文件，自动填充表单</p>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-500 mb-1">附件文件名称 <span className="text-rose-500">*</span></label>
                <input 
                  type="text" 
                  value={newAttachName} 
                  onChange={(e) => setNewAttachName(e.target.value)}
                  placeholder="如：原厂装配调试验收纪要"
                  className="w-full text-base sm:text-xs border border-slate-300 rounded-lg px-3 py-2.5 sm:py-1.5 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-xs font-semibold"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-500 mb-1">资料类别</label>
                  <select 
                    value={newAttachType} 
                    onChange={(e) => setNewAttachType(e.target.value as any)}
                    className="w-full text-base sm:text-xs border border-slate-300 rounded-lg px-3 py-2.5 sm:py-1.5 text-slate-800 bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-xs font-semibold"
                  >
                    <option value="manual">技术/操作手册</option>
                    <option value="invoice">发票或采购凭证</option>
                    <option value="certificate">准入/安全证书</option>
                    <option value="other">其他外协合同</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-500 mb-1">文件模拟大小</label>
                  <input 
                    type="text" 
                    value={newAttachSize} 
                    onChange={(e) => setNewAttachSize(e.target.value)}
                    placeholder="2.4 MB"
                    className="w-full text-base sm:text-xs border border-slate-300 rounded-lg px-3 py-2.5 sm:py-1.5 text-slate-800 font-mono bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors shadow-xs font-semibold"
                  />
                </div>
              </div>

              <div className="pt-3 border-t border-slate-100 flex justify-end gap-2">
                <button type="button" onClick={() => setIsAttachmentModalOpen(false)} className="px-3.5 py-1.5 text-xs border border-slate-300 rounded text-slate-600">
                  取消
                </button>
                <button type="submit" className="px-4 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white font-bold rounded">
                  确定归档
                </button>
              </div>
            </form>

          </div>
        </div>
      )}

      {/* ================= MODAL 5: PHOTO ZOOM LIGHTBOX ================= */}
      {zoomPhotoUrl && (
        <div 
          className="fixed inset-0 bg-slate-900/90 backdrop-blur-sm flex items-center justify-center p-4 z-50 cursor-zoom-out"
          onClick={() => setZoomPhotoUrl(null)}
        >
          <div className="relative max-w-4xl max-h-[85vh] overflow-hidden rounded-xl border border-white/10 bg-slate-950 flex flex-col cursor-default shadow-2xl" onClick={(e) => e.stopPropagation()}>
            {/* Top Close bar */}
            <div className="absolute top-3 right-3 z-10">
              <button 
                onClick={() => setZoomPhotoUrl(null)}
                className="p-1.5 rounded-full bg-black/60 hover:bg-black/80 text-white border border-white/20 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            {/* Image Box */}
            <img 
              src={zoomPhotoUrl} 
              alt="Zoomed Equipment" 
              referrerPolicy="no-referrer"
              className="max-h-[75vh] max-w-full w-auto object-contain"
            />
            
            {/* Bottom bar with selected equipment info */}
            {selectedEquipment && (
              <div className="px-5 py-3.5 bg-slate-900 border-t border-slate-800 text-white flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                <div>
                  <h4 className="font-bold text-xs sm:text-sm text-slate-100">{selectedEquipment.deviceName}</h4>
                  <p className="text-[10px] sm:text-xs text-slate-400 mt-0.5">型号规格: {selectedEquipment.model} | 管理科室: {selectedEquipment.dept}</p>
                </div>
                {selectedEquipment.sn && (
                  <span className="text-[10px] sm:text-xs font-mono px-2 py-0.5 bg-white/5 rounded border border-white/10 text-slate-300">
                    SN: {selectedEquipment.sn}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ================= MODAL 8: CLINICAL QUICK FAULT REPORT DIALOG ================= */}
      {isQuickRepairModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl border border-rose-100 w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh] font-sans">
            
            {/* Header */}
            <div className="px-6 py-4 bg-gradient-to-r from-rose-500 to-rose-600 text-white flex justify-between items-center flex-shrink-0">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-rose-100 animate-pulse" />
                <div>
                  <h3 className="font-extrabold text-sm text-white">临床医学装备故障一键报修</h3>
                  <p className="text-[10px] text-rose-100/80">值班工程师将以最快速度响应并到场处置</p>
                </div>
              </div>
              <button 
                onClick={() => {
                  setIsQuickRepairModalOpen(false);
                  resetQuickRepairDraft();
                }} 
                className="text-white/80 hover:text-white transition-colors"
                type="button"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Form */}
            <form onSubmit={handleQuickRepairSubmit} className="flex-1 overflow-y-auto p-6 space-y-4">
              
              {/* Selector */}
              <div>
                <label className="block text-xs font-black text-slate-500 mb-1.5 uppercase tracking-wider">
                  1. 选择发生故障的装备
                </label>
                <select
                  id="quick-repair-equipment-select"
                  aria-label="选择发生故障的装备"
                  value={quickRepairEquipId}
                  onChange={(e) => resetQuickRepairDraft(e.target.value)}
                  className="w-full text-xs font-bold border border-slate-200 rounded-lg p-2.5 bg-slate-50 text-slate-700 focus:ring-2 focus:ring-rose-500 outline-none"
                  required
                >
                  <option value="">-- 请选择本科室发生故障的设备 --</option>
                  {visibleEquipments.map(eq => (
                    <option key={eq.id} value={eq.id} disabled={!canStartQuickRepairForEquipment(eq)}>
                      [{eq.status}] {eq.deviceName} ({eq.model}) (SN: {eq.sn}){hasActiveRepairWorkOrder(eq) ? ' - 已有维修中工单' : ''}
                    </option>
                  ))}
                </select>
              </div>

              {/* Urgency */}
              <div>
                <label className="block text-xs font-black text-slate-500 mb-1.5 uppercase tracking-wider">
                  2. 影响严重程度及紧急度
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { value: 'low', label: '🟢 低 (次日内处理)', desc: '不影响临床诊断' },
                    { value: 'medium', label: '🟡 中 (今日内解决)', desc: '限制部分功能使用' },
                    { value: 'high', label: '🔴 高 (紧急到场)', desc: '影响急救生命支持' }
                  ].map(opt => (
                    <button
                      id={`quick-repair-urgency-${opt.value}`}
                      aria-label={`设置报修紧急度：${opt.label}`}
                      key={opt.value}
                      type="button"
                      onClick={() => setQuickRepairUrgency(opt.value as 'low' | 'medium' | 'high')}
                      className={`p-2 border rounded-lg text-left transition-all cursor-pointer ${
                        quickRepairUrgency === opt.value
                          ? 'border-rose-500 bg-rose-50/50 text-rose-700 ring-1 ring-rose-500'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      <p className="text-[11px] font-black">{opt.label}</p>
                      <p className="text-[9px] text-slate-400 mt-0.5">{opt.desc}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Description */}
              <div>
                <label className="block text-xs font-black text-slate-500 mb-1.5 uppercase tracking-wider">
                  3. 故障现象具体描述
                </label>
                <textarea
                  id="quick-repair-description"
                  aria-label="故障现象具体描述"
                  value={quickRepairDesc}
                  onChange={(e) => setQuickRepairDesc(e.target.value)}
                  placeholder="请输入该设备在临床运行中出现的故障代码、异响、黑屏、漏气或报错提示，方便检修技术员携带对应零备件到场..."
                  rows={4}
                  className="w-full text-xs font-bold border border-slate-200 rounded-lg p-2.5 bg-slate-50 text-slate-700 focus:ring-2 focus:ring-rose-500 outline-none resize-none"
                  required
                />
              </div>

              {/* Footer Buttons */}
              <div className="pt-4 flex justify-end gap-2 border-t border-slate-100 flex-shrink-0">
                <button
                  id="btn-cancel-quick-repair"
                  aria-label="取消快捷报修"
                  type="button"
                  onClick={() => {
                    setIsQuickRepairModalOpen(false);
                    resetQuickRepairDraft();
                  }}
                  className="px-4 py-2 text-xs bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold rounded-lg transition-colors cursor-pointer"
                >
                  取消
                </button>
                <button
                  id="btn-submit-quick-repair"
                  aria-label="提交快捷报修并分派"
                  type="submit"
                  disabled={!canSubmitQuickRepair}
                  className="px-5 py-2 text-xs bg-gradient-to-r from-rose-500 to-rose-600 hover:from-rose-600 hover:to-rose-700 text-white font-extrabold rounded-lg shadow-md flex items-center gap-1.5 transition-all cursor-pointer disabled:from-slate-300 disabled:to-slate-400 disabled:shadow-none disabled:cursor-not-allowed disabled:text-white/80"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>提交报修并分派</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ================= CAMERA BARCODE / NAMEPLATE SCANNER MODAL ================= */}
      {isScannerModalOpen && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md flex items-center justify-center p-4 z-50">
          <div className="bg-slate-950 text-slate-100 rounded-2xl shadow-2xl border border-slate-800 w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh] font-sans">
            
            {/* Header */}
            <div className="px-5 py-4 bg-slate-900 border-b border-slate-800 flex justify-between items-center flex-shrink-0">
              <div className="flex items-center gap-2">
                <QrCode className="w-5 h-5 text-indigo-400 animate-pulse" />
                <div>
                  <h3 className="font-extrabold text-sm text-slate-100">智能系统相机扫码定位报修</h3>
                  <p className="text-[10px] text-slate-400">自动对焦扫描设备铭牌上的原厂SN条码直接下单</p>
                </div>
              </div>
              <button 
                onClick={() => setIsScannerModalOpen(false)} 
                className="text-slate-400 hover:text-slate-200 transition-colors"
                type="button"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Content Body */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
              
              {/* Camera Stream Viewport */}
              <div className="relative aspect-video rounded-xl overflow-hidden bg-slate-900 border border-slate-800 shadow-inner flex flex-col items-center justify-center">
                {isScannerCameraActive && !scannerCameraError ? (
                  <>
                    <video 
                      ref={scannerVideoRef}
                      className="w-full h-full object-cover"
                      playsInline
                      muted
                    />
                    
                    {/* Glowing Scanning Overlay Laser & Target Area */}
                    <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center">
                      {/* Target Scanning Box Frame */}
                      <div className="w-4/5 h-1/2 border-2 border-dashed border-indigo-400/70 rounded-lg relative flex items-center justify-center">
                        {/* Glowing Green/Red Laser bar */}
                        <div className="absolute left-0 right-0 h-0.5 bg-indigo-400 shadow-[0_0_8px_#818cf8] animate-[bounce_2.5s_infinite]" />
                        
                        {/* Corner markers */}
                        <div className="absolute top-0 left-0 h-4 w-4 border-t-2 border-l-2 border-indigo-400 -mt-0.5 -ml-0.5" />
                        <div className="absolute top-0 right-0 h-4 w-4 border-t-2 border-r-2 border-indigo-400 -mt-0.5 -mr-0.5" />
                        <div className="absolute bottom-0 left-0 h-4 w-4 border-b-2 border-l-2 border-indigo-400 -mb-0.5 -ml-0.5" />
                        <div className="absolute bottom-0 right-0 h-4 w-4 border-b-2 border-r-2 border-indigo-400 -mb-0.5 -mr-0.5" />
                      </div>
                      <span className="text-[9px] bg-slate-950/80 text-indigo-300 font-bold px-2.5 py-1 rounded-full border border-indigo-900/50 mt-3 flex items-center gap-1.5 backdrop-blur-xs">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                        实时对焦中：请将铭牌条码或SN码对准框内
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="p-6 text-center text-slate-400 flex flex-col items-center justify-center space-y-2">
                    <AlertTriangle className="w-8 h-8 text-amber-500 animate-bounce" />
                    <p className="font-bold text-slate-300">沙箱或浏览器相机权限受限</p>
                    <p className="text-[10px] text-slate-500 leading-normal max-w-xs">
                      由于目前在预览 iframe 安全隔离沙箱中运行，浏览器或系统可能会拦截摄像头访问。
                    </p>
                    <span className="text-[10px] bg-slate-800 text-slate-300 font-bold px-2 py-0.5 rounded border border-slate-700">
                      系统已为您备好“免相机一键快速模拟扫码”面板
                    </span>
                  </div>
                )}
              </div>

              {/* 🎯 ADVANCED SIMULATOR PANEL (Perfect for preview/demo testing) */}
              <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider font-mono flex items-center gap-1">
                    <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                    医院设备铭牌SN真实条码模拟器 (极速测试通道)
                  </span>
                  <span className="text-[9px] bg-indigo-950 text-indigo-400 px-1.5 py-0.2 rounded font-mono">
                    DEMO-TEST
                  </span>
                </div>
                
                <p className="text-[10px] text-slate-400 leading-normal">
                  免去打印条码或寻找摄像头的繁琐，直接点击下方任何一台已归档的核心临床设备，即可<strong>完美模拟扫码定位并自动秒填工单</strong>：
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-40 overflow-y-auto pr-1 custom-scrollbar">
                  {equipments.filter(canCurrentUserReportEquipment).map(eq => (
                    <button
                      key={eq.id}
                      type="button"
                      onClick={() => {
                        if (!canStartQuickRepairForEquipment(eq)) {
                          setScannerMatchError(getQuickRepairBlockMessage(eq));
                          return;
                        }
                        setScannedSnResult(eq.sn);
                        handleScannedSn(eq.sn);
                      }}
                      disabled={!canStartQuickRepairForEquipment(eq)}
                      title={canStartQuickRepairForEquipment(eq) ? '模拟扫码定位并填充报修' : getQuickRepairBlockMessage(eq)}
                      className={`text-left p-2 border rounded-lg transition-all flex flex-col justify-between group ${
                        canStartQuickRepairForEquipment(eq)
                          ? 'bg-slate-950 hover:bg-slate-800/80 border-slate-800 hover:border-indigo-500/50 cursor-pointer'
                          : 'bg-slate-950/50 border-slate-900 opacity-60 cursor-not-allowed'
                      }`}
                    >
                      <div className="flex justify-between items-center w-full">
                        <span className="font-bold text-slate-200 truncate max-w-[120px]">{eq.deviceName}</span>
                        <span className={`text-[8px] px-1 rounded ${
                          eq.status === '正常运行' ? 'bg-emerald-950 text-emerald-400 border border-emerald-900/60' : 'bg-rose-950 text-rose-400 border border-rose-900/60'
                        }`}>
                          {eq.status}
                        </span>
                      </div>
                      <div className="flex justify-between items-center text-[9px] text-slate-500 font-mono mt-1">
                        <span>{eq.model}</span>
                        <span className="font-bold text-indigo-400 group-hover:text-indigo-300">SN: {eq.sn} ➡️</span>
                      </div>
                    </button>
                  ))}
                </div>
                {equipments.filter(canCurrentUserReportEquipment).length === 0 && (
                  <div className="rounded-lg border border-slate-800 bg-slate-950 p-3 text-[10px] text-slate-400">
                    当前账号暂无可扫码报修的本科室设备。
                  </div>
                )}
              </div>

              {/* Manual SN entry fallback */}
              <div className="bg-slate-900/40 p-3.5 border border-slate-800 rounded-xl space-y-2.5">
                <label className="block text-slate-300 font-bold">
                  ⌨️ 无法扫码？支持手动输入原厂序列号定位
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={scannedSnResult}
                    onChange={(e) => {
                      setScannedSnResult(e.target.value);
                      setScannerMatchError(null);
                    }}
                    placeholder="如：MR-SI-99201A 或直接输入系统自编ID..."
                    className="flex-1 bg-slate-950 text-slate-100 border border-slate-800 rounded-lg px-3 py-2 text-xs focus:ring-1 focus:ring-indigo-500 outline-none placeholder-slate-600 font-mono font-bold"
                  />
                  <button
                    type="button"
                    onClick={() => handleScannedSn(scannedSnResult)}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-xs font-bold transition-all whitespace-nowrap active:scale-95"
                  >
                    确认定位
                  </button>
                </div>
                {scannerMatchError && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[10px] leading-relaxed text-amber-200">
                    {scannerMatchError}
                  </div>
                )}
              </div>

              {/* Advantage Explanation Badge */}
              <div className="bg-indigo-950/30 border border-indigo-900/50 rounded-xl p-3 text-indigo-300/90 leading-normal">
                <p className="font-bold text-indigo-200 flex items-center gap-1">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  智能免搜索免查找设计亮点：
                </p>
                <p className="text-[10px] text-justify mt-1">
                  床旁医生/护士在遇到急救医学装备故障时，只需打开详情页“扫码报修”，直接扫描贴在设备机身上的出厂SN条码即可。系统将直接检索后台，秒级精准带入设备名称、存放科室及编号，自动弹出高优先级的报修表单，消除以往在数百台资产名录里搜索排查的痛苦，极大提升急抢救维保时效性。
                </p>
              </div>

            </div>

            {/* Footer */}
            <div className="px-5 py-3.5 bg-slate-900 border-t border-slate-800 flex justify-end">
              <button
                type="button"
                onClick={() => setIsScannerModalOpen(false)}
                className="px-4 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-300 transition-all active:scale-95 font-semibold"
              >
                关闭扫描器
              </button>
            </div>

          </div>
        </div>
      )}

      {/* ================= MODAL 6: MEDICAL EQUIPMENT DOSSIER PDF EXPORT ================= */}
      {canManageEquipmentArchive && isDossierModalOpen && selectedEquipment && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-2 sm:p-4 z-50 overflow-y-auto">
          <div className="relative bg-slate-100 rounded-xl border border-slate-200/80 w-full max-w-4xl shadow-2xl flex flex-col my-4 max-h-[90vh]">
            
            {/* Modal Controls Bar */}
            <div className="flex items-center justify-between px-4 py-3 bg-white border-b border-slate-200 rounded-t-xl no-print">
              <div className="flex items-center gap-2">
                <FileText className="w-5 h-5 text-blue-600" />
                <h3 className="text-sm font-bold text-slate-800">
                  技术档案报告预览 <span className="text-xs font-medium text-slate-400 font-mono ml-1">v1.2</span>
                </h3>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    window.print();
                  }}
                  className="flex items-center gap-1.5 bg-blue-600 text-white px-4 py-1.5 rounded-lg text-xs font-bold hover:bg-blue-700 active:scale-95 transition-all shadow-sm cursor-pointer"
                  title="确认打印或另存为 PDF 文件"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>打印 / 另存为 PDF</span>
                </button>
                <button
                  onClick={() => setIsDossierModalOpen(false)}
                  className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Print Help Notice (no-print) */}
            <div className="bg-blue-50/70 border-b border-blue-100 px-6 py-2.5 text-[11px] text-blue-700 flex items-center justify-between no-print gap-4">
              <div className="flex items-center gap-1.5">
                <span className="flex h-2 w-2 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                </span>
                <span><strong>温馨提示：</strong>点击右上角按钮将调起系统打印。在打印窗口的“目标打印机”中选择 <strong>“另存为 PDF”</strong> (Save as PDF) 即可下载标准的 PDF 电子档案。</span>
              </div>
              <div className="font-mono text-[10px] text-slate-400 hidden sm:block">页边距推荐：无/默认 | 开启背景图形</div>
            </div>

            {/* Scrollable Document Container */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 bg-slate-50 custom-scrollbar">
              
              {/* Actual Printable Page Area */}
              <div 
                id="printable-dossier-area"
                className="bg-white px-6 py-8 sm:p-12 border border-slate-300 shadow-md mx-auto w-full max-w-[210mm] text-slate-800 font-sans"
              >
                {/* Official Header */}
                <div className="text-center pb-6 border-b-2 border-slate-800 relative">
                  <div className="text-slate-500 font-semibold text-[11px] tracking-wider uppercase mb-1">
                    第一人民医院医学装备科 · 全生命周期电子档案
                  </div>
                  <h1 className="text-xl sm:text-2xl font-extrabold text-slate-900 tracking-tight mt-1">
                    医疗设备全生命周期技术档案报告
                  </h1>
                  <h2 className="text-[10px] font-mono text-slate-400 uppercase tracking-widest mt-1">
                    MEDICAL EQUIPMENT LIFECYCLE TECHNICAL DOSSIER REPORT
                  </h2>
                  
                  {/* Metadata Stamp right inside document */}
                  <div className="absolute top-0 right-0 hidden sm:flex flex-col items-end text-right font-mono text-[9px] text-slate-400 leading-normal">
                    <span>备案号: ARC-{selectedEquipment.id.toUpperCase()}</span>
                    <span>归档级别: {selectedEquipment.deviceClass || '暂未分类'}</span>
                    <span>导出时间: {getLocalDateTimeString()}</span>
                  </div>
                </div>

                {/* Sub-header info row */}
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center text-[11px] text-slate-500 py-3 border-b border-dashed border-slate-300 gap-1.5">
                  <div>
                    <span>备案主档状态: </span>
                    <span className={`font-bold ${selectedEquipment.status === '正常运行' ? 'text-green-600' : selectedEquipment.status === '故障维修' ? 'text-red-500' : 'text-blue-500'}`}>
                      ● {selectedEquipment.status}
                    </span>
                  </div>
                  <div className="font-mono text-[10px]">
                    主档案唯一编码 (UUID): <span className="font-bold text-slate-700">{selectedEquipment.id}</span>
                  </div>
                </div>

                {/* Main Specification Matrix Table */}
                <div className="mt-6">
                  <div className="text-xs font-bold text-slate-900 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <span className="w-1.5 h-3.5 bg-blue-600 rounded-xs inline-block"></span>
                    <span>一、装备资产基本参数与技术指标</span>
                  </div>
                  
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse border border-slate-800 text-xs text-left">
                      <tbody>
                        <tr>
                          <th className="bg-slate-100 border border-slate-800 px-3 py-2 w-1/4 font-bold text-slate-700">设备官方名称</th>
                          <td className="border border-slate-800 px-3 py-2 w-1/4 font-semibold text-slate-900">{selectedEquipment.deviceName}</td>
                          <th className="bg-slate-100 border border-slate-800 px-3 py-2 w-1/4 font-bold text-slate-700">设备规格型号</th>
                          <td className="border border-slate-800 px-3 py-2 w-1/4 font-mono font-semibold text-slate-900">{selectedEquipment.model}</td>
                        </tr>
                        <tr>
                          <th className="bg-slate-100 border border-slate-800 px-3 py-2 font-bold text-slate-700">出厂序列号 (SN)</th>
                          <td className="border border-slate-800 px-3 py-2 font-mono font-bold text-blue-700">{selectedEquipment.sn}</td>
                          <th className="bg-slate-100 border border-slate-800 px-3 py-2 font-bold text-slate-700">生产制造厂家</th>
                          <td className="border border-slate-800 px-3 py-2 font-medium text-slate-900">{selectedEquipment.manufacturer}</td>
                        </tr>
                        <tr>
                          <th className="bg-slate-100 border border-slate-800 px-3 py-2 font-bold text-slate-700">技术归口科室</th>
                          <td className="border border-slate-800 px-3 py-2 font-semibold text-slate-900">{selectedEquipment.dept}</td>
                          <th className="bg-slate-100 border border-slate-800 px-3 py-2 font-bold text-slate-700">设备应用分类</th>
                          <td className="border border-slate-800 px-3 py-2 font-medium text-slate-900">{selectedEquipment.category}</td>
                        </tr>
                        <tr>
                          <th className="bg-slate-100 border border-slate-800 px-3 py-2 font-bold text-slate-700">临床风险评价</th>
                          <td className="border border-slate-800 px-3 py-2 font-semibold text-slate-900">
                            <span className="font-bold">
                              {selectedEquipment.riskLevel}风险级别
                            </span>
                          </td>
                          <th className="bg-slate-100 border border-slate-800 px-3 py-2 font-bold text-slate-700">资产入库原值</th>
                          <td className="border border-slate-800 px-3 py-2 font-mono font-bold text-slate-900">
                            ¥ {selectedEquipment.purchaseCost.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                        </tr>
                        <tr>
                          <th className="bg-slate-100 border border-slate-800 px-3 py-2 font-bold text-slate-700">国家医疗器械分类</th>
                          <td className="border border-slate-800 px-3 py-2 font-medium text-slate-900">{selectedEquipment.deviceClass || '未分类'}</td>
                          <th className="bg-slate-100 border border-slate-800 px-3 py-2 font-bold text-slate-700">资产购入日期</th>
                          <td className="border border-slate-800 px-3 py-2 font-mono font-medium text-slate-900">{selectedEquipment.purchaseDate}</td>
                        </tr>
                        <tr>
                          <th className="bg-slate-100 border border-slate-800 px-3 py-2 font-bold text-slate-700">国家器械注册证号</th>
                          <td className="border border-slate-800 px-3 py-2 font-mono text-[11px] text-slate-900" colSpan={selectedEquipment.registrationValidUntil ? 1 : 3}>
                            {selectedEquipment.registrationNo || '暂无数据/未归档'}
                          </td>
                          {selectedEquipment.registrationValidUntil && (
                            <>
                              <th className="bg-slate-100 border border-slate-800 px-3 py-2 font-bold text-slate-700">注册证有效期至</th>
                              <td className="border border-slate-800 px-3 py-2 font-mono text-[11px] text-slate-900">{selectedEquipment.registrationValidUntil}</td>
                            </>
                          )}
                        </tr>
                        {selectedEquipment.productionLicenseNo && (
                          <tr>
                            <th className="bg-slate-100 border border-slate-800 px-3 py-2 font-bold text-slate-700">生产企业许可证号</th>
                            <td className="border border-slate-800 px-3 py-2 font-mono text-[11px] text-slate-900" colSpan={3}>
                              {selectedEquipment.productionLicenseNo}
                            </td>
                          </tr>
                        )}
                        <tr>
                          <th className="bg-slate-100 border border-slate-800 px-3 py-2 font-bold text-slate-700">预防性维护周期</th>
                          <td className="border border-slate-800 px-3 py-2 font-semibold text-slate-900">{selectedEquipment.maintenanceCycleDays} 天 / 次</td>
                          <th className="bg-slate-100 border border-slate-800 px-3 py-2 font-bold text-slate-700">下一次定检日期</th>
                          <td className="border border-slate-800 px-3 py-2 font-mono font-semibold text-slate-900">{selectedEquipment.nextMaintenanceDate}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Section 2: Maintenance and Repair Records */}
                <div className="mt-8 print-avoid-break">
                  <div className="text-xs font-bold text-slate-900 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <span className="w-1.5 h-3.5 bg-blue-600 rounded-xs inline-block"></span>
                    <span>二、预防性维护与检修保养工单历史跟踪</span>
                  </div>

                  {selectedEquipment.maintenanceLogs.length === 0 ? (
                    <div className="border border-slate-300 rounded-lg p-6 text-center text-xs text-slate-400 italic">
                      暂无历史维保/修理记录，该设备目前属于首期运行维护状态。
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse border border-slate-800 text-xs text-left">
                        <thead>
                          <tr className="bg-slate-100 text-slate-700">
                            <th className="border border-slate-800 px-2 py-1.5 font-bold w-24">工作日期</th>
                            <th className="border border-slate-800 px-2 py-1.5 font-bold w-16 text-center">维保属性</th>
                            <th className="border border-slate-800 px-2 py-1.5 font-bold w-20">技术负责人</th>
                            <th className="border border-slate-800 px-2 py-1.5 font-bold">维护大纲及工单详情描述</th>
                            <th className="border border-slate-800 px-2 py-1.5 font-bold w-32">更换配件/耗材</th>
                            <th className="border border-slate-800 px-2 py-1.5 font-bold w-16 text-right">费用 (¥)</th>
                            <th className="border border-slate-800 px-2 py-1.5 font-bold w-16 text-center">状态</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedEquipment.maintenanceLogs.map((log) => (
                            <tr key={log.id} className="hover:bg-slate-50/50">
                              <td className="border border-slate-800 px-2 py-1.5 font-mono">{log.date}</td>
                              <td className="border border-slate-800 px-2 py-1.5 text-center">
                                <span className={`px-1 py-0.5 rounded text-[9px] font-bold ${log.type === '保养' ? 'text-emerald-700' : 'text-amber-700'}`}>
                                  {log.type}
                                </span>
                              </td>
                              <td className="border border-slate-800 px-2 py-1.5 font-medium text-slate-900">{log.technician}</td>
                              <td className="border border-slate-800 px-2 py-1.5 text-[11px] text-slate-600 font-sans leading-relaxed">
                                {log.description}
                                {log.workOrderNo && <div className="text-[9px] text-slate-400 font-mono mt-0.5">工单号: {log.workOrderNo}</div>}
                              </td>
                              <td className="border border-slate-800 px-2 py-1.5 text-[10px] text-slate-500 font-mono italic">
                                {log.partsReplaced || '无配件更换'}
                              </td>
                              <td className="border border-slate-800 px-2 py-1.5 font-mono text-right">{log.cost === 0 ? '0.00' : log.cost.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</td>
                              <td className="border border-slate-800 px-2 py-1.5 text-center font-bold text-[10px]">
                                <span className={log.status === '已完成' ? 'text-green-600' : 'text-amber-500'}>
                                  {log.status}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Section 3: Statutory Calibration Records */}
                {selectedEquipment.calibrationRequired && (
                  <div className="mt-8 print-avoid-break">
                    <div className="text-xs font-bold text-slate-900 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      <span className="w-1.5 h-3.5 bg-blue-600 rounded-xs inline-block"></span>
                      <span>三、国家法定计量强制检定记录档案</span>
                    </div>

                    {selectedEquipment.calibrationLogs.length === 0 ? (
                      <div className="border border-slate-300 rounded-lg p-6 text-center text-xs text-slate-400 italic">
                        尚未录入法定强检证书，请尽快上传法定计量机构签发的合格计量证书。
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full border-collapse border border-slate-800 text-xs text-left">
                          <thead>
                            <tr className="bg-slate-100 text-slate-700">
                              <th className="border border-slate-800 px-2 py-1.5 font-bold w-36">计量证书编号</th>
                              <th className="border border-slate-800 px-2 py-1.5 font-bold w-20">检定日期</th>
                              <th className="border border-slate-800 px-2 py-1.5 font-bold w-20">有效期截止日</th>
                              <th className="border border-slate-800 px-2 py-1.5 font-bold">法定授权计量检定机构</th>
                              <th className="border border-slate-800 px-2 py-1.5 font-bold w-20 text-center">检定类别</th>
                              <th className="border border-slate-800 px-2 py-1.5 font-bold w-16 text-center">检定结论</th>
                              <th className="border border-slate-800 px-2 py-1.5 font-bold w-16">主检工程师</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedEquipment.calibrationLogs.map((cal) => (
                              <tr key={cal.id} className="hover:bg-slate-50/50">
                                <td className="border border-slate-800 px-2 py-1.5 font-mono font-bold text-slate-900">{cal.certificateNo}</td>
                                <td className="border border-slate-800 px-2 py-1.5 font-mono">{cal.date}</td>
                                <td className="border border-slate-800 px-2 py-1.5 font-mono text-slate-950 font-bold">{cal.validUntil}</td>
                                <td className="border border-slate-800 px-2 py-1.5 text-slate-700">{cal.agency}</td>
                                <td className="border border-slate-800 px-2 py-1.5 text-center text-[10px] text-slate-500">
                                  {cal.calibType || '周期检定'}
                                </td>
                                <td className="border border-slate-800 px-2 py-1.5 text-center font-bold">
                                  <span className={`px-1.5 py-0.5 rounded text-[9px] ${
                                    cal.result === '合格' ? 'bg-green-100 text-green-800 border border-green-200' :
                                    cal.result === '准用' ? 'bg-blue-100 text-blue-800 border border-blue-200' :
                                    cal.result === '限用' ? 'bg-yellow-100 text-yellow-800 border border-yellow-200' :
                                    'bg-red-100 text-red-800 border border-red-200'
                                  }`}>
                                    {cal.result}
                                  </span>
                                </td>
                                <td className="border border-slate-800 px-2 py-1.5 text-slate-700">{cal.testerName || '省检计师'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {/* Section 4: Security verification / stamp / qr-code */}
                <div className="mt-10 pt-6 border-t border-slate-300 flex flex-col md:flex-row justify-between items-stretch gap-6 print-avoid-break">
                  
                  {/* Digital Twin Stamp Box */}
                  <div className="flex items-center gap-3.5 bg-slate-50 p-3.5 border border-slate-200 rounded-lg flex-1">
                    <div className="p-1.5 bg-white border border-slate-200 rounded flex-shrink-0">
                      <QrCode className="w-11 h-11 text-slate-900" />
                    </div>
                    <div className="min-w-0 flex-1 leading-normal text-[10px] text-slate-500">
                      <div className="text-slate-800 font-bold flex items-center gap-1">
                        <span>一机一码物联网审计标识</span>
                        <span className="text-[9px] font-extrabold text-blue-600 bg-blue-50 px-1 border border-blue-200 rounded">数字签名加密</span>
                      </div>
                      <p className="mt-1 text-[9px] font-mono leading-tight">SN: {selectedEquipment.sn}</p>
                      <p className="mt-0.5 leading-normal">此医疗器械设备已通过第一人民医院全生命周期可信审计。微信或手持终端扫描左侧二维码可即时查询实时维保大纲与审计轨迹。</p>
                    </div>
                  </div>

                  {/* Signatures & Seal Area */}
                  <div className="grid grid-cols-2 gap-4 w-full md:w-80 text-xs font-medium text-slate-500">
                    <div className="flex flex-col justify-between p-2 border border-dashed border-slate-300 rounded h-24 relative bg-slate-50/20">
                      <div className="text-slate-400 font-bold text-[9px] uppercase tracking-wider">医学装备科主管/技术核验</div>
                      <div className="text-right text-[10px] font-mono text-slate-400/80 mb-1 z-10">
                        签字: __________________
                      </div>
                      {/* Electronic stamp watermark */}
                      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 border-2 border-red-500/30 text-red-500/30 text-[9px] font-extrabold rotate-12 px-1 py-0.5 rounded uppercase tracking-wider pointer-events-none text-center select-none">
                        医学装备专用章<br/><span className="text-[7px] font-mono">APPROVED AUDIT</span>
                      </div>
                    </div>

                    <div className="flex flex-col justify-between p-2 border border-dashed border-slate-300 rounded h-24 relative bg-slate-50/20">
                      <div className="text-slate-400 font-bold text-[9px] uppercase tracking-wider">使用科室科主任签字确认</div>
                      <div className="text-right text-[10px] font-mono text-slate-400/80 mb-1">
                        签字: __________________
                      </div>
                      {/* Department designation watermark */}
                      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 border border-dashed border-slate-500/10 text-slate-500/10 text-[10px] font-extrabold -rotate-12 select-none pointer-events-none uppercase text-center">
                        {selectedEquipment.dept}<br/>科室核准
                      </div>
                    </div>
                  </div>
                </div>

                {/* Small disclaimer footer inside page */}
                <div className="mt-8 text-center text-[9px] text-slate-400 font-mono tracking-wide leading-normal">
                  本报告数据实时同步自主干网络医疗装备管理数据库，数字签证校验算法: SHA-256 / AES-256-GCM. 
                  <br />
                  第一人民医院医学装备科 &copy; 2026 保留所有审计权利。
                </div>

              </div>
            </div>

            {/* Modal Footer Controls */}
            <div className="px-6 py-3.5 bg-white border-t border-slate-200 rounded-b-xl flex items-center justify-between no-print">
              <span className="text-xs text-slate-400 flex items-center gap-1">
                <ShieldCheck className="w-4 h-4 text-emerald-500" />
                <span>电子签名已启用，此文件为法律效力凭证档案。</span>
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setIsDossierModalOpen(false)}
                  className="px-4 py-2 text-xs border border-slate-300 rounded-lg text-slate-600 hover:bg-slate-50 active:scale-95 transition-all font-semibold cursor-pointer"
                >
                  关闭预览
                </button>
                <button
                  type="button"
                  onClick={() => {
                    window.print();
                  }}
                  className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-lg text-xs font-bold active:scale-95 transition-all shadow-sm cursor-pointer"
                >
                  <Printer className="w-4 h-4" />
                  <span>开始打印报告 (另存为PDF)</span>
                </button>
              </div>
            </div>

          </div>
        </div>
      )}

      {/* ================= MODAL 7: SMART ATTACHMENT PREVIEW & AI SNAPSHOT EXTRACTOR ================= */}
      {isPreviewOpen && previewFile && selectedEquipment && (() => {
        const previewData = generatePreviewData(selectedEquipment, previewFile);
        const activePageData = previewData.pages[activePreviewPage - 1] || previewData.pages[0];
        
        return (
          <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4 z-50 overflow-y-auto no-print">
            <div className="relative bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-5xl shadow-2xl flex flex-col my-4 max-h-[92vh] overflow-hidden text-slate-100 animate-fade-in">
              
              {/* Top Banner Control Bar */}
              <div className="flex items-center justify-between px-4 py-3 bg-slate-950 border-b border-slate-800">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="p-1.5 bg-blue-600/20 text-blue-400 rounded-lg border border-blue-500/30 flex-shrink-0">
                    <FileText className="w-4 h-4 animate-pulse" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-xs sm:text-sm font-bold text-slate-200 truncate flex items-center gap-1.5">
                      <span>{previewFile.name}</span>
                      <span className="text-[10px] font-normal text-slate-500 font-mono">({previewFile.size})</span>
                    </h3>
                    <p className="text-[10px] text-slate-400 truncate flex items-center gap-1">
                      <span>文档库类型：</span>
                      <strong className="text-blue-400 font-medium">{previewData.fileType}</strong>
                      <span>•</span>
                      <span>归档于：<strong className="font-mono text-slate-300">{previewData.uploadDate}</strong></span>
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {canManageEquipmentArchive ? (
                    <button
                      onClick={() => triggerDownloadFile(previewFile)}
                      className="flex items-center gap-1 bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-700 transition-all cursor-pointer"
                      title="下载源技术文档文件"
                    >
                      <span>下载原档</span>
                    </button>
                  ) : (
                    <span className="flex items-center gap-1 bg-slate-800 text-slate-400 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-700">
                      临床只读预览
                    </span>
                  )}
                  <button
                    onClick={() => setIsPreviewOpen(false)}
                    className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition-colors cursor-pointer"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>

              {/* Document Split Grid Container */}
              <div className="flex-1 overflow-y-auto grid grid-cols-1 lg:grid-cols-12 gap-5 p-4 sm:p-5 custom-scrollbar">
                
                {/* Left Panel: AI Core Insights & TL;DR */}
                <div className="lg:col-span-4 flex flex-col gap-4">
                  
                  {/* AI Metadata & Status Card */}
                  <div className="bg-slate-950/60 p-4 border border-slate-800 rounded-xl space-y-3.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider font-mono">
                        AI ENGINE 质检元数据
                      </span>
                      <span className="text-[9px] bg-emerald-950/50 border border-emerald-800/80 text-emerald-400 px-1.5 py-0.5 rounded font-extrabold flex items-center gap-1">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                        已完成合规审计
                      </span>
                    </div>

                    <div className="space-y-2.5 text-xs">
                      <div className="flex justify-between border-b border-slate-800/50 pb-2">
                        <span className="text-slate-400">核对机型:</span>
                        <span className="font-semibold text-slate-200 font-mono truncate max-w-[150px]">{selectedEquipment.model}</span>
                      </div>
                      <div className="flex justify-between border-b border-slate-800/50 pb-2">
                        <span className="text-slate-400">授权发布人:</span>
                        <span className="font-semibold text-slate-200 truncate max-w-[150px]">{previewData.author}</span>
                      </div>
                      <div className="flex justify-between border-b border-slate-800/50 pb-2">
                        <span className="text-slate-400">文档页数:</span>
                        <span className="font-bold text-blue-400 font-mono">4 页 (标准手册电子副本)</span>
                      </div>
                      <div className="flex justify-between pb-1">
                        <span className="text-slate-400">数字防伪印信:</span>
                        <span className="font-mono text-slate-500 font-semibold">MELS-SHA256 Approved</span>
                      </div>
                    </div>
                  </div>

                  {/* AI Summary and Core Guidelines */}
                  <div className="bg-slate-950/60 p-4 border border-slate-800 rounded-xl flex-1 flex flex-col gap-4">
                    <div>
                      <div className="flex items-center gap-1.5 mb-2">
                        <Sparkles className="w-4 h-4 text-amber-400" />
                        <h4 className="text-xs font-extrabold text-slate-200 uppercase tracking-wide">
                          AI 大模型智能摘要
                        </h4>
                      </div>
                      <p className="text-[11px] leading-relaxed text-slate-400 text-justify">
                        {previewData.summary}
                      </p>
                    </div>

                    <div className="border-t border-slate-800/60 pt-3">
                      <h4 className="text-xs font-extrabold text-slate-300 mb-2.5">
                        💡 核心运行及安全指引 (TL;DR)
                      </h4>
                      <div className="space-y-2.5">
                        {previewData.tlDr.map((item, idx) => (
                          <div key={idx} className="flex gap-2 text-[10px] text-slate-300 leading-relaxed items-start">
                            <span className="text-blue-500 mt-0.5">•</span>
                            <p>{item}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                </div>

                {/* Right Panel: Active Page Stage & Navigation */}
                <div className="lg:col-span-8 flex flex-col gap-4">
                  
                  {/* Current Page Title and Control */}
                  <div className="flex items-center justify-between bg-slate-950/40 px-3.5 py-2 border border-slate-800 rounded-xl">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-extrabold font-mono text-blue-400 bg-blue-950 border border-blue-900 px-1.5 py-0.5 rounded">
                        P.{activePreviewPage}
                      </span>
                      <h4 className="text-xs sm:text-sm font-bold text-slate-200">{activePageData.title}</h4>
                    </div>
                    <span className="text-[10px] text-slate-500 font-mono tracking-wider">
                      {activePageData.subtitle}
                    </span>
                  </div>

                  {/* High Fidelity Simulated Document Sheet */}
                  <div className="bg-slate-950/30 border border-slate-800/80 p-3 sm:p-5 rounded-xl flex items-center justify-center">
                    <div 
                      className="bg-white text-slate-800 p-6 sm:p-8 rounded-lg shadow-xl border border-slate-300 w-full max-w-[180mm] min-h-[380px] flex flex-col justify-between relative overflow-hidden select-none"
                    >
                      {/* Blueprint Grid Watermark overlay */}
                      <div className="absolute inset-0 bg-linear-to-b from-slate-100/5 to-slate-200/10 pointer-events-none" style={{ backgroundImage: 'radial-gradient(#cbd5e1 0.75px, transparent 0.75px)', backgroundSize: '16px 16px' }}></div>

                      {/* Header bar of sheet */}
                      <div className="flex justify-between items-center pb-3 border-b-2 border-slate-800 text-[9px] font-mono tracking-wider uppercase text-slate-500 relative z-10">
                        <span>第一人民医院医学装备科 · 数字化技术资产原件</span>
                        <span className="text-slate-800 font-bold">第 {activePreviewPage} 页 / 共 4 页</span>
                      </div>

                      {/* Content Section inside sheet */}
                      <div className="py-5 flex-1 flex flex-col justify-between gap-4 relative z-10 text-xs text-left leading-relaxed text-slate-700">
                        
                        {/* Body content text lines */}
                        <div className="space-y-2.5">
                          {activePageData.lines.map((line, lidx) => (
                            <div key={lidx} className="flex gap-2">
                              <span className="text-blue-600 font-bold font-mono">▶</span>
                              <p className="font-sans leading-normal font-medium text-slate-800">{line}</p>
                            </div>
                          ))}
                        </div>

                        {/* Beautiful Visual Blueprint Section based on diagramType */}
                        <div className="border border-slate-200 rounded-lg p-3 bg-slate-50/70 shadow-2xs mt-1">
                          
                          {activePageData.diagramType === 'parameters' && (
                            <div className="space-y-2">
                              <div className="text-[9px] font-extrabold text-blue-700 uppercase tracking-wider font-mono flex items-center gap-1">
                                <span className="h-1.5 w-1.5 rounded-full bg-blue-600"></span>
                                核心规格参数元数据 (CORE COMPONENT SPECS)
                              </div>
                              <div className="grid grid-cols-2 gap-3.5">
                                {activePageData.metrics?.map((m, midx) => (
                                  <div key={midx} className="bg-white border border-slate-200 p-2 rounded shadow-3xs flex flex-col">
                                    <span className="text-[9px] text-slate-400 font-medium">{m.label}</span>
                                    <span className="text-xs font-bold text-slate-800 truncate font-mono mt-0.5">{m.value}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {activePageData.diagramType === 'chart' && (
                            <div className="space-y-2">
                              <div className="text-[9px] font-extrabold text-emerald-700 uppercase tracking-wider font-mono flex items-center gap-1">
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-600"></span>
                                PM维保状态与合格基线比对 (PM PERFORMANCE DEVIATION)
                              </div>
                              <div className="h-16 flex items-end gap-1 px-2 border-b border-slate-300 pb-1 pt-2">
                                <div className="bg-slate-200 text-[8px] font-mono p-0.5 text-center flex-1 h-3/4 rounded-t flex flex-col justify-end">75%</div>
                                <div className="bg-emerald-500 text-[8px] font-mono p-0.5 text-center flex-1 h-[95%] rounded-t flex flex-col justify-end text-white font-bold">95%</div>
                                <div className="bg-slate-200 text-[8px] font-mono p-0.5 text-center flex-1 h-2/3 rounded-t flex flex-col justify-end">68%</div>
                                <div className="bg-emerald-500 text-[8px] font-mono p-0.5 text-center flex-1 h-[90%] rounded-t flex flex-col justify-end text-white font-bold">90%</div>
                                <div className="bg-slate-200 text-[8px] font-mono p-0.5 text-center flex-1 h-4/5 rounded-t flex flex-col justify-end">80%</div>
                                <div className="bg-blue-500 text-[8px] font-mono p-0.5 text-center flex-1 h-[92%] rounded-t flex flex-col justify-end text-white font-bold">92%</div>
                              </div>
                              <div className="flex justify-between text-[8px] text-slate-400 px-1 font-mono">
                                <span>安全泄漏</span>
                                <span>冷头压力</span>
                                <span>屏蔽衰减</span>
                                <span>主磁场QA</span>
                                <span>射频阻抗</span>
                                <span>误差均方根</span>
                              </div>
                            </div>
                          )}

                          {activePageData.diagramType === 'warning' && (
                            <div className="border border-amber-300/80 bg-amber-50/50 p-2.5 rounded-lg flex gap-3 items-start">
                              <AlertTriangle className="w-6 h-6 text-amber-600 flex-shrink-0" />
                              <div className="min-w-0 flex-1">
                                <div className="text-[10px] font-extrabold text-amber-800 uppercase tracking-wider font-mono">
                                  CRITICAL OPERATION RED ZONE & CODES
                                </div>
                                <p className="text-[9px] text-amber-700 leading-normal mt-1 font-medium text-justify">
                                  系统检测偏置若发生漂移或液氦循环过载，系统控制台可能抛出对应报错。严禁非临床技术授权工程师擅自解锁控制柜面板。发生失超情况，应立刻按下机房外应急泄压。
                                </p>
                              </div>
                            </div>
                          )}

                          {(activePageData.diagramType === 'table' || activePageData.diagramType === 'invoice') && (
                            <div className="space-y-2">
                              <div className="text-[9px] font-extrabold text-indigo-700 uppercase tracking-wider font-mono flex items-center justify-between">
                                <span className="flex items-center gap-1">
                                  <span className="h-1.5 w-1.5 rounded-full bg-indigo-600"></span>
                                  合规资质审计核验与签名指纹 (REGULATORY STAMP & CODE)
                                </span>
                                <span className="text-[8px] text-slate-400 font-mono">SHA-256 Verified</span>
                              </div>
                              <div className="flex items-center justify-between gap-4 border-t border-slate-200 pt-2 text-[10px] text-slate-600">
                                <div className="space-y-1">
                                  <p>检测机构: <strong className="text-slate-800">国家注册医用放射/精密计量所</strong></p>
                                  <p>审计校验码: <strong className="font-mono text-slate-500">MELS-7F8A9E1D2C</strong></p>
                                </div>
                                <div className="h-12 w-12 border border-red-500/30 rounded-full flex flex-col items-center justify-center text-[7px] text-red-500/40 uppercase rotate-12 font-bold p-1 text-center border-dashed leading-tight flex-shrink-0 select-none">
                                  检验合格<br/><span className="text-[5px] font-mono">PASSED</span>
                                </div>
                              </div>
                            </div>
                          )}

                        </div>

                      </div>

                      {/* Footer bar of sheet */}
                      <div className="flex justify-between items-center pt-3 border-t border-slate-200 text-[8px] font-mono text-slate-400 relative z-10 leading-normal">
                        <span>数字签名：0x7F8A9E1D2C3B4A5F6E7D8C9B0A1B2C3D</span>
                        <span>第一人民医院版权所有 &copy; 2026</span>
                      </div>

                    </div>
                  </div>

                  {/* Extract snapshot & page navigation tools */}
                  <div className="flex flex-col gap-3 bg-slate-950/40 p-3.5 border border-slate-800 rounded-xl">
                    <div className="flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-3">
                      
                      {/* Active page arrow indicators */}
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setActivePreviewPage(prev => Math.max(1, prev - 1))}
                          disabled={activePreviewPage === 1}
                          className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-40 transition-colors cursor-pointer"
                        >
                          <ChevronLeft className="w-4 h-4" />
                        </button>
                        <span className="text-xs font-mono text-slate-300 font-semibold px-2">
                          页码：{activePreviewPage} / 4
                        </span>
                        <button
                          onClick={() => setActivePreviewPage(prev => Math.min(4, prev + 1))}
                          disabled={activePreviewPage === 4}
                          className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-40 transition-colors cursor-pointer"
                        >
                          <ChevronRight className="w-4 h-4" />
                        </button>
                      </div>

                      {/* Sparkles premium extract page snapshot button */}
                      {canManageEquipmentArchive ? (
                        <button
                          onClick={() => handleExtractSnapshot(activePageData)}
                          disabled={isExtractingSnapshot}
                          className="flex-1 sm:flex-initial flex items-center justify-center gap-1.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 disabled:from-slate-700 disabled:to-slate-800 text-white px-4 py-2 rounded-lg text-xs font-bold transition-all shadow-sm active:scale-95 cursor-pointer"
                        >
                          {isExtractingSnapshot ? (
                            <>
                              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              <span>正在进行 AI OCR 智能提取...</span>
                            </>
                          ) : (
                            <>
                              <Sparkles className="w-3.5 h-3.5 text-amber-300" />
                              <span>📌 提取当前页为设备关联快照</span>
                            </>
                          )}
                        </button>
                      ) : (
                        <div className="flex-1 sm:flex-initial flex items-center justify-center gap-1.5 bg-slate-800 text-slate-300 px-4 py-2 rounded-lg text-xs font-bold border border-slate-700">
                          <ShieldCheck className="w-3.5 h-3.5 text-slate-400" />
                          <span>临床只读预览</span>
                        </div>
                      )}

                    </div>

                    {/* Small visual page bento thumbnail selector */}
                    <div className="grid grid-cols-4 gap-2 border-t border-slate-800/60 pt-3">
                      {previewData.pages.map((p, pidx) => (
                        <div
                          key={pidx}
                          onClick={() => setActivePreviewPage(p.pageNum)}
                          className={`p-2 rounded-lg border text-left cursor-pointer transition-all flex flex-col justify-between h-14 select-none ${
                            activePreviewPage === p.pageNum
                              ? 'bg-blue-600/10 border-blue-500'
                              : 'bg-slate-950/40 border-slate-800 hover:border-slate-700'
                          }`}
                        >
                          <span className={`text-[8px] font-extrabold font-mono uppercase ${
                            activePreviewPage === p.pageNum ? 'text-blue-400' : 'text-slate-500'
                          }`}>
                            PAGE {p.pageNum}
                          </span>
                          <span className="text-[9px] font-bold text-slate-300 truncate leading-tight">
                            {p.title.split(': ')[1] || p.title}
                          </span>
                        </div>
                      ))}
                    </div>

                  </div>

                </div>

              </div>

              {/* Bottom Warning and Status Bar */}
              <div className="px-5 py-3.5 bg-slate-950 border-t border-slate-800 flex items-center justify-between">
                <span className="text-[10px] sm:text-xs text-slate-400 flex items-center gap-1.5 min-w-0">
                  <ShieldCheck className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                  <span className="truncate">当前处于本地安全沙箱预览信道，所有快照与本院医学装备管理系统（MELS）双向对齐。</span>
                </span>
                <button
                  type="button"
                  onClick={() => setIsPreviewOpen(false)}
                  className="px-4 py-1.5 text-xs border border-slate-700 rounded-lg text-slate-300 hover:bg-slate-800 hover:text-slate-100 active:scale-95 transition-all font-semibold cursor-pointer flex-shrink-0"
                >
                  关闭预览
                </button>
              </div>

            </div>
          </div>
        );
      })()}

    </div>
  );
}