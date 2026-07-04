import React, { useState, useMemo, useEffect, useRef } from 'react';
import { 
  Calendar, ChevronLeft, ChevronRight, Wrench, ShieldCheck, 
  Check, Clock, AlertTriangle, FileText, Info, X, Sparkles, Send, Bell,
  User, Plus, Search, Briefcase, History, TrendingUp, DollarSign
} from 'lucide-react';
import { MedicalEquipment, MaintenanceLog, CalibrationLog, UserProfile } from '../types';
import { isSameDepartment } from '../utils/departmentUtils';
import { getDefaultEngineerName, getEngineerNameByIndex, normalizeEngineerName, SIMULATED_ENGINEER_NAMES } from '../utils/engineerAssignments';
import { getLocalDateString } from '../utils/dateUtils';

interface MaintenanceCalendarProps {
  equipments: MedicalEquipment[];
  setEquipments: React.Dispatch<React.SetStateAction<MedicalEquipment[]>>;
  selectedId: string;
  setSelectedId: (id: string) => void;
  setMobileView: (view: 'list' | 'detail' | 'ai') => void;
  setMiddleViewMode: (view: 'detail' | 'calendar') => void;
  setLogType: (type: '维保' | '计量') => void;
  setIsLogModalOpen: (open: boolean) => void;
  currentUser: UserProfile;
}

interface CalendarEvent {
  id: string; // unique event id
  equipment: MedicalEquipment;
  type: 'maintenance' | 'calibration' | 'hist_maintenance' | 'hist_repair' | 'hist_calibration';
  date: string; // YYYY-MM-DD
  title: string;
  technician: string;
  cost?: number;
  description?: string;
  status?: string;
  result?: string;
  logId?: string;
}

export default function MaintenanceCalendar({
  equipments,
  setEquipments,
  selectedId,
  setSelectedId,
  setMobileView,
  setMiddleViewMode,
  setLogType,
  setIsLogModalOpen,
  currentUser
}: MaintenanceCalendarProps) {
  const todayDateString = getLocalDateString();
  const [todayYear, todayMonthText, todayDayText] = todayDateString.split('-');
  const todayYearNumber = Number(todayYear);
  const todayMonthIndex = Number(todayMonthText) - 1;
  const todayDayNumber = Number(todayDayText);
  const [currentYear, setCurrentYear] = useState(() => todayYearNumber);
  const [currentMonth, setCurrentMonth] = useState(() => todayMonthIndex);

  // Simulated logged-in engineer workspace state
  const [currentEngineer, setCurrentEngineer] = useState<string>('all'); // 'all' or specific engineer name
  const canManageSchedule = currentUser.role === 'engineer';
  const scheduleScopeLabel = currentUser.role === 'medical_staff' ? '本科室' : '全院';

  const getScheduleManageBlockReason = (actionName: string) => {
    if (canManageSchedule) return '';
    return `当前登录身份为【${currentUser.name} ${currentUser.title}】，只能查看${currentUser.department || currentUser.dept || '本科室'}设备日程，不能执行${actionName}。`;
  };

  // 同步全局模拟登录账户到日历技术员筛选
  useEffect(() => {
    if (currentUser.role === 'engineer') {
      if (currentUser.id === 'u-admin' || currentUser.title.includes('主任')) {
        setCurrentEngineer('all');
      } else {
        setCurrentEngineer(currentUser.name);
      }
      setDeployEngineer(currentUser.name);
    } else {
      setCurrentEngineer('all'); // 临床医护人员强制显示全部（因为已在 equipment.forEach 过滤了整科室的设备日程）
      setDeployEngineer(getDefaultEngineerName());
    }
  }, [currentUser]);

  // Extended filters inside calendar (Future scheduled vs. past logs)
  const [showMaintenance, setShowMaintenance] = useState(true); // 计划PM
  const [showCalibration, setShowCalibration] = useState(true); // 计划计量
  const [showHistMaintenance, setShowHistMaintenance] = useState(true); // 历史保养
  const [showHistRepair, setShowHistRepair] = useState(true); // 历史维修
  const [showHistCalibration, setShowHistCalibration] = useState(true); // 历史计量

  // Selected date for the daily overview popup
  const [activeDatePopup, setActiveDatePopup] = useState<string | null>(null);

  // Selected event for detail/reschedule in dispatch workshop
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);

  // Date selection state for scheduling adjustment
  const [newScheduleDate, setNewScheduleDate] = useState('');
  const [isRescheduling, setIsRescheduling] = useState(false);

  // Deployment form state
  const [isDeployMode, setIsDeployMode] = useState(false);
  const [deployEquipmentId, setDeployEquipmentId] = useState('');
  const [deployTaskType, setDeployTaskType] = useState<'maintenance' | 'calibration' | 'repair'>('maintenance');
  const [deployDate, setDeployDate] = useState(getLocalDateString);
  const [deployEngineer, setDeployEngineer] = useState(() => currentUser.role === 'engineer' ? currentUser.name : getDefaultEngineerName());
  const [deployNotes, setDeployNotes] = useState('');
  const [deploySearchQuery, setDeploySearchQuery] = useState('');

  // Custom temporary success notifications
  const [notification, setNotification] = useState<string | null>(null);
  const notificationTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (canManageSchedule) return;

    setIsDeployMode(false);
    setActiveDatePopup(null);
    setSelectedEvent(prev => {
      if (!prev) return prev;
      return isSameDepartment(prev.equipment.dept, currentUser.department || currentUser.dept) ? prev : null;
    });
  }, [canManageSchedule, currentUser.department, currentUser.dept]);

  // Predefined engineers list & dynamic extraction
  const availableEngineers = useMemo(() => {
    const set = new Set<string>();
    SIMULATED_ENGINEER_NAMES.forEach(name => set.add(name));
    if (currentUser.role === 'engineer') {
      set.add(currentUser.name);
    }
    equipments.forEach(eq => {
      const assignedMaintenanceEngineer = normalizeEngineerName(eq.assignedMaintenanceEngineer);
      const assignedCalibrationEngineer = normalizeEngineerName(eq.assignedCalibrationEngineer);
      if (assignedMaintenanceEngineer) set.add(assignedMaintenanceEngineer);
      if (assignedCalibrationEngineer) set.add(assignedCalibrationEngineer);
      eq.maintenanceLogs.forEach(log => {
        if (log.technician) set.add(log.technician);
      });
    });
    return Array.from(set);
  }, [equipments, currentUser]);

  // Map deterministic fallback engineers for existing future events
  const getAssignedEngineer = (eq: MedicalEquipment, type: 'maintenance' | 'calibration') => {
    // Check if customized on equipment state
    const customAssigned = normalizeEngineerName(type === 'maintenance' ? eq.assignedMaintenanceEngineer : eq.assignedCalibrationEngineer);
    if (customAssigned) return customAssigned;

    // Fallback based on category & dept
    if (type === 'maintenance') {
      if (eq.category === '急救生命支持') return getEngineerNameByIndex(0);
      if (eq.category === '影像诊断') return getEngineerNameByIndex(1);
      if (eq.category === '检验分析') return getEngineerNameByIndex(2);
      return getEngineerNameByIndex(2);
    } else {
      if (eq.category === '影像诊断') return getEngineerNameByIndex(2);
      if (eq.category === '检验分析') return getEngineerNameByIndex(1);
      return getEngineerNameByIndex(0);
    }
  };

  // Show a notification briefly
  const triggerNotification = (msg: string) => {
    if (notificationTimerRef.current !== null) {
      window.clearTimeout(notificationTimerRef.current);
    }
    setNotification(msg);
    notificationTimerRef.current = window.setTimeout(() => {
      setNotification(null);
      notificationTimerRef.current = null;
    }, 5000);
  };

  useEffect(() => {
    return () => {
      if (notificationTimerRef.current !== null) {
        window.clearTimeout(notificationTimerRef.current);
      }
    };
  }, []);

  // Weekday headers
  const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  // All events matching filters & engineer login filter
  const allEvents = useMemo(() => {
    const events: CalendarEvent[] = [];
    equipments.forEach(eq => {
      // 临床医护人员登录时，仅显示其所在科室的设备维保与计量日程
      if (currentUser.role === 'medical_staff' && !isSameDepartment(eq.dept, currentUser.department || currentUser.dept)) {
        return;
      }

      // 1. Future Maintenance event
      if (eq.nextMaintenanceDate && showMaintenance) {
        const engineer = getAssignedEngineer(eq, 'maintenance');
        if (currentEngineer === 'all' || engineer === currentEngineer) {
          events.push({
            id: `${eq.id}-maintenance`,
            equipment: eq,
            type: 'maintenance',
            date: eq.nextMaintenanceDate,
            technician: engineer,
            title: '计划PM维护',
            status: '未开始'
          });
        }
      }

      // 2. Future Calibration event
      if (eq.calibrationRequired && eq.nextCalibrationDate && showCalibration) {
        const engineer = getAssignedEngineer(eq, 'calibration');
        if (currentEngineer === 'all' || engineer === currentEngineer) {
          events.push({
            id: `${eq.id}-calibration`,
            equipment: eq,
            type: 'calibration',
            date: eq.nextCalibrationDate,
            technician: engineer,
            title: '法定计量周期检定',
            status: '未开始'
          });
        }
      }

      // 3. Historical logs from maintenance logs (both Maintenance '保养' & Repair '维修')
      eq.maintenanceLogs.forEach(log => {
        if (!log.date) return;
        const normalizedDate = log.date.substring(0, 10);
        const isRepair = log.type === '维修';
        const matchesEng = currentEngineer === 'all' || log.technician === currentEngineer;

        if (isRepair && showHistRepair && matchesEng) {
          events.push({
            id: `hist-repair-${log.id}`,
            equipment: eq,
            type: 'hist_repair',
            date: normalizedDate,
            technician: log.technician || '临床工程师',
            title: '故障维修记录',
            cost: log.cost,
            description: log.description,
            status: log.status || '已完成',
            logId: log.id
          });
        } else if (!isRepair && showHistMaintenance && matchesEng) {
          events.push({
            id: `hist-maint-${log.id}`,
            equipment: eq,
            type: 'hist_maintenance',
            date: normalizedDate,
            technician: log.technician || '临床工程师',
            title: '日常保养记录',
            cost: log.cost,
            description: log.description,
            status: log.status || '已完成',
            logId: log.id
          });
        }
      });

      // 4. Historical logs from calibration logs
      eq.calibrationLogs.forEach(log => {
        if (!log.date) return;
        const normalizedDate = log.date.substring(0, 10);
        const matchesEng = currentEngineer === 'all' || log.testerName === currentEngineer || log.agency?.includes(currentEngineer);

        if (showHistCalibration && matchesEng) {
          events.push({
            id: `hist-calib-${log.id}`,
            equipment: eq,
            type: 'hist_calibration',
            date: normalizedDate,
            technician: log.testerName || log.agency || '第三方测试员',
            title: '法定计量检定',
            description: `证书编号: ${log.certificateNo || '未登记'} | 机构: ${log.agency || '第三方检定所'}`,
            result: log.result || '合格',
            status: '已核验',
            logId: log.id
          });
        }
      });
    });
    return events;
  }, [equipments, showMaintenance, showCalibration, showHistMaintenance, showHistRepair, showHistCalibration, currentEngineer, currentUser.role, currentUser.department, currentUser.dept]);

  // Group events by day string (YYYY-MM-DD)
  const eventsByDay = useMemo(() => {
    const map: Record<string, CalendarEvent[]> = {};
    allEvents.forEach(evt => {
      if (!map[evt.date]) {
        map[evt.date] = [];
      }
      map[evt.date].push(evt);
    });
    return map;
  }, [allEvents]);

  // Find events on the clicked date
  const popupEvents = useMemo(() => {
    if (!activeDatePopup) return [];
    return eventsByDay[activeDatePopup] || [];
  }, [activeDatePopup, eventsByDay]);

  // Current month's event statistics (for active visible month)
  const monthStats = useMemo(() => {
    const formattedPrefix = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`;
    let pmCount = 0;
    let calibCount = 0;
    let histPmCount = 0;
    let histRepairCount = 0;
    let histCalibCount = 0;

    allEvents.forEach(evt => {
      if (evt.date.startsWith(formattedPrefix)) {
        if (evt.type === 'maintenance') pmCount++;
        else if (evt.type === 'calibration') calibCount++;
        else if (evt.type === 'hist_maintenance') histPmCount++;
        else if (evt.type === 'hist_repair') histRepairCount++;
        else if (evt.type === 'hist_calibration') histCalibCount++;
      }
    });

    return { 
      pmCount, 
      calibCount, 
      histPmCount, 
      histRepairCount, 
      histCalibCount, 
      totalScheduled: pmCount + calibCount,
      totalCompleted: histPmCount + histRepairCount + histCalibCount,
      total: pmCount + calibCount + histPmCount + histRepairCount + histCalibCount
    };
  }, [allEvents, currentYear, currentMonth]);

  // Handle month navigation
  const prevMonth = () => {
    if (currentMonth === 0) {
      setCurrentMonth(11);
      setCurrentYear(prev => prev - 1);
    } else {
      setCurrentMonth(prev => prev - 1);
    }
    setSelectedEvent(null);
  };

  const nextMonth = () => {
    if (currentMonth === 11) {
      setCurrentMonth(0);
      setCurrentYear(prev => prev + 1);
    } else {
      setCurrentMonth(prev => prev + 1);
    }
    setSelectedEvent(null);
  };

  const setTodayMonth = () => {
    setCurrentYear(todayYearNumber);
    setCurrentMonth(todayMonthIndex);
    setSelectedEvent(null);
  };

  // Generate days in the 42-cell grid (6 rows x 7 cols)
  const gridDays = useMemo(() => {
    const firstDayOfWeek = (new Date(currentYear, currentMonth, 1).getDay() + 6) % 7;
    const daysInCurrentMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    const daysInPrevMonth = new Date(currentYear, currentMonth, 0).getDate();

    const days: Array<{
      day: number;
      month: number;
      year: number;
      isCurrentMonth: boolean;
      dateString: string;
    }> = [];

    // Faded days from previous month
    for (let i = firstDayOfWeek - 1; i >= 0; i--) {
      const prevM = currentMonth === 0 ? 11 : currentMonth - 1;
      const prevY = currentMonth === 0 ? currentYear - 1 : currentYear;
      const dayNum = daysInPrevMonth - i;
      const dateString = `${prevY}-${String(prevM + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
      days.push({
        day: dayNum,
        month: prevM,
        year: prevY,
        isCurrentMonth: false,
        dateString
      });
    }

    // Days in current month
    for (let i = 1; i <= daysInCurrentMonth; i++) {
      const dateString = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
      days.push({
        day: i,
        month: currentMonth,
        year: currentYear,
        isCurrentMonth: true,
        dateString
      });
    }

    // Faded days from next month to pad to 42 cells
    const remainingCells = 42 - days.length;
    for (let i = 1; i <= remainingCells; i++) {
      const nextM = currentMonth === 11 ? 0 : currentMonth + 1;
      const nextY = currentMonth === 11 ? currentYear + 1 : currentYear;
      const dateString = `${nextY}-${String(nextM + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
      days.push({
        day: i,
        month: nextM,
        year: nextY,
        isCurrentMonth: false,
        dateString
      });
    }

    return days;
  }, [currentYear, currentMonth]);

  // Reschedule submit handler (future tasks only)
  const handleReschedule = (e: React.FormEvent) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const submittedDate = String(new FormData(form).get('newScheduleDate') || newScheduleDate).trim();
    if (!selectedEvent || !submittedDate) return;
    const blockReason = getScheduleManageBlockReason('日程调期');
    if (blockReason) {
      triggerNotification(`⚠️ ${blockReason}`);
      return;
    }

    setIsRescheduling(true);
    const targetEventId = selectedEvent.id;
    const targetEqId = selectedEvent.equipment.id;
    const taskType = selectedEvent.type;
    const assignedTechnician = selectedEvent.technician;
    const deviceName = selectedEvent.equipment.deviceName;
    const targetDate = submittedDate;
    setNewScheduleDate(submittedDate);

    setTimeout(() => {
      setEquipments(prev => prev.map(eq => {
        if (eq.id === targetEqId) {
          if (taskType === 'maintenance') {
            return { 
              ...eq, 
              nextMaintenanceDate: targetDate,
              assignedMaintenanceEngineer: assignedTechnician
            };
          } else if (taskType === 'calibration') {
            return { 
              ...eq, 
              nextCalibrationDate: targetDate,
              assignedCalibrationEngineer: assignedTechnician
            };
          }
        }
        return eq;
      }));

      setSelectedEvent(prev => {
        if (!prev) return null;
        if (prev.id !== targetEventId) return prev;
        return {
          ...prev,
          date: targetDate
        };
      });

      setIsRescheduling(false);
      triggerNotification(`🎉 成功将《${deviceName}》的计划工作调整至 ${targetDate}。工程师调度指令已下发。`);
    }, 400);
  };

  // Re-assign engineer for a future scheduled task
  const handleReassignEngineer = (engineer: string) => {
    if (!selectedEvent) return;
    const blockReason = getScheduleManageBlockReason('技术员改派');
    if (blockReason) {
      triggerNotification(`⚠️ ${blockReason}`);
      return;
    }

    const targetEqId = selectedEvent.equipment.id;
    const taskType = selectedEvent.type;

    setEquipments(prev => prev.map(eq => {
      if (eq.id === targetEqId) {
        if (taskType === 'maintenance') {
          return { ...eq, assignedMaintenanceEngineer: engineer };
        } else if (taskType === 'calibration') {
          return { ...eq, assignedCalibrationEngineer: engineer };
        }
      }
      return eq;
    }));

    setSelectedEvent(prev => {
      if (!prev) return null;
      return {
        ...prev,
        technician: engineer
      };
    });

    triggerNotification(`👤 工单责任技术员已成功重新指派给：【${engineer}】。状态已实时同步。`);
  };

  // Work Deployment Form Submission
  const handleDeployWorkSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const submittedDate = String(new FormData(form).get('deployDate') || deployDate).trim();
    const blockReason = getScheduleManageBlockReason('新工单部署');
    if (blockReason) {
      triggerNotification(`⚠️ ${blockReason}`);
      return;
    }

    if (!deployEquipmentId || !submittedDate) {
      triggerNotification('❌ 请完整选择受托医疗设备及计划日期。');
      return;
    }

    const selectedEquipment = filteredEquipmentsForDeploy.find(eq => eq.id === deployEquipmentId);
    if (!selectedEquipment) {
      triggerNotification('❌ 当前筛选条件下无法部署到该设备，请重新选择可见设备。');
      return;
    }

    setDeployDate(submittedDate);

    setEquipments(prev => prev.map(eq => {
      if (eq.id === deployEquipmentId) {
        if (deployTaskType === 'maintenance') {
          return {
            ...eq,
            nextMaintenanceDate: submittedDate,
            assignedMaintenanceEngineer: deployEngineer
          };
        } else if (deployTaskType === 'calibration') {
          return {
            ...eq,
            nextCalibrationDate: submittedDate,
            assignedCalibrationEngineer: deployEngineer,
            calibrationRequired: true
          };
        } else if (deployTaskType === 'repair') {
          // Direct repair dispatch: Create a new pending maintenance log of type '维修' with status '进行中'
          const newWorkOrder: MaintenanceLog = {
            id: `WO-REPAIR-${Date.now().toString().substring(6)}`,
            type: '维修',
            date: submittedDate,
            technician: deployEngineer,
            description: deployNotes || '应急维修指令，请迅速排除故障',
            cost: 0,
            status: '进行中',
            workOrderNo: `WO-${submittedDate.replace(/-/g, '')}-${Math.floor(100 + Math.random() * 900)}`,
            faultPhenomenon: deployNotes || '设备出现非预期异常，需要现场紧急维修'
          };
          return {
            ...eq,
            status: '故障维修',
            maintenanceLogs: [newWorkOrder, ...eq.maintenanceLogs]
          };
        }
      }
      return eq;
    }));

    triggerNotification(`🚀 工单部署成功！已将《${selectedEquipment.deviceName}》的 ${
      deployTaskType === 'maintenance' ? '计划PM保养' : deployTaskType === 'calibration' ? '计量周期强检' : '紧急维修任务'
    } 下发给技术员【${deployEngineer}】，计划执行日期为 ${submittedDate}。`);

    // Reset Form
    setIsDeployMode(false);
    setDeployNotes('');
  };

  // Pre-fill deploy form from calendar cell click
  const openDeployForDate = (dateStr: string) => {
    const blockReason = getScheduleManageBlockReason('新工单部署');
    if (blockReason) {
      triggerNotification(`⚠️ ${blockReason}`);
      return;
    }

    setDeployDate(dateStr);
    setIsDeployMode(true);
    setSelectedEvent(null);
    setActiveDatePopup(null);
    setDeployEquipmentId(filteredEquipmentsForDeploy[0]?.id || '');
  };

  // Direct dispatch handler (links to existing recording flow)
  const handleDirectDispatch = () => {
    if (!selectedEvent) return;
    const blockReason = getScheduleManageBlockReason('现场执行登记');
    if (blockReason) {
      triggerNotification(`⚠️ ${blockReason}`);
      return;
    }
    
    // 1. Select the equipment
    setSelectedId(selectedEvent.equipment.id);
    
    // 2. Set appropriate log type for modal
    if (selectedEvent.type === 'maintenance') {
      setLogType('维保');
    } else {
      setLogType('计量');
    }
    
    // 3. Open registration modal in parent App
    setIsLogModalOpen(true);
    
    triggerNotification(`⚙️ 已选定该设备。已为您唤起【录入${selectedEvent.type === 'maintenance' ? '维保' : '计量'}档案】的工作面板。`);
  };

  // Push instant alert notification to technicians
  const handlePushAlert = () => {
    if (!selectedEvent) return;
    const blockReason = getScheduleManageBlockReason('通知推送');
    if (blockReason) {
      triggerNotification(`⚠️ ${blockReason}`);
      return;
    }

    triggerNotification(`🔔 催办通知已通过【企业微信/医院内部OA】推送至归口科室：${selectedEvent.equipment.dept}，并提醒值班工程师。`);
  };

  // Navigate to standard equipment dossier
  const handleInspectDossier = () => {
    if (!selectedEvent) return;
    setSelectedId(selectedEvent.equipment.id);
    setMobileView('detail');
    setMiddleViewMode('detail');
  };

  // Calculate day health load level (for "方便装备科统一调度")
  const getDayLoadStatus = (evtCount: number) => {
    if (evtCount === 0) return { dotClass: 'bg-transparent', text: '无负荷', labelClass: 'text-slate-400' };
    if (evtCount <= 2) return { dotClass: 'bg-emerald-500', text: '常态负荷', labelClass: 'text-emerald-600 bg-emerald-50' };
    if (evtCount <= 4) return { dotClass: 'bg-blue-500', text: '密集负荷', labelClass: 'text-blue-600 bg-blue-50' };
    return { dotClass: 'bg-rose-500 animate-pulse', text: '高度饱和', labelClass: 'text-rose-700 bg-rose-50 border border-rose-100 font-bold' };
  };

  // Filter equipment list in deploy form
  const filteredEquipmentsForDeploy = useMemo(() => {
    return equipments.filter(eq => {
      const q = deploySearchQuery.toLowerCase();
      return eq.deviceName.toLowerCase().includes(q) || 
             eq.id.toLowerCase().includes(q) || 
             eq.dept.toLowerCase().includes(q) ||
             eq.sn.toLowerCase().includes(q);
    });
  }, [equipments, deploySearchQuery]);
  const filteredDeployEquipmentIds = filteredEquipmentsForDeploy.map(eq => eq.id).join('|');

  useEffect(() => {
    if (!isDeployMode) return;
    if (!deployEquipmentId) {
      setDeployEquipmentId(filteredEquipmentsForDeploy[0]?.id || '');
      return;
    }

    if (!filteredEquipmentsForDeploy.some(eq => eq.id === deployEquipmentId)) {
      setDeployEquipmentId(filteredEquipmentsForDeploy[0]?.id || '');
    }
  }, [isDeployMode, deployEquipmentId, filteredDeployEquipmentIds]);

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-slate-50/50">
      
      {/* Calendar Control Topbar */}
      <div className="px-4 py-3.5 bg-white border-b border-slate-100 flex flex-col md:flex-row md:items-center md:justify-between gap-3 flex-shrink-0">
        
        {/* Left identity block */}
        <div className="flex items-center gap-2.5">
          <div className="bg-blue-600 p-2 rounded-lg text-white shadow-2xs">
            <Calendar className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-black text-slate-800 font-sans tracking-tight">装备科资产调度及维保履历回溯日历</h3>
            <p className="text-[10px] text-slate-400">统筹{scheduleScopeLabel}医疗设备预防性维护(PM)、计量强检并全景回溯设备历史维修、保养履历</p>
          </div>
        </div>

        {/* Dynamic Engineer login switcher & month control */}
        <div className="flex items-center flex-wrap gap-2.5">
          {/* Simulate login workspace */}
          {currentUser.role === 'medical_staff' ? (
            <div className="flex items-center gap-1.5 bg-blue-50 border border-blue-200 px-2.5 py-1 rounded-lg text-blue-700 font-sans shadow-2xs">
              <span className="p-0.5 bg-blue-600 rounded text-white"><Briefcase className="w-3 h-3" /></span>
              <span className="text-[10px] font-black uppercase tracking-wide">已按科室自动建档: {currentUser.department || currentUser.dept}</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 bg-slate-50 border border-slate-200/80 px-2.5 py-1 rounded-lg">
              <User className="w-3.5 h-3.5 text-slate-500" />
              <span className="text-[10px] font-bold text-slate-500">模拟登录科室技术员:</span>
              <select
                value={currentEngineer}
                onChange={(e) => {
                  setCurrentEngineer(e.target.value);
                  setSelectedEvent(null);
                }}
                className="text-[11px] font-black text-slate-700 bg-transparent border-0 p-0 focus:ring-0 cursor-pointer"
              >
                <option value="all">🏥 全院工程师任务 (显示全部)</option>
                {availableEngineers.map(eng => (
                  <option key={eng} value={eng}>👤 {eng} (临床工程部)</option>
                ))}
              </select>
            </div>
          )}

          {/* Month Navigator */}
          <div className="flex items-center bg-slate-100 rounded-lg p-0.5">
            <button 
              onClick={prevMonth}
              className="p-1 hover:bg-white rounded transition-colors text-slate-600 cursor-pointer"
              title="上个月"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="px-3.5 text-xs font-black text-slate-800 font-mono tracking-wider">
              {currentYear}年 {String(currentMonth + 1).padStart(2, '0')}月
            </span>
            <button 
              onClick={nextMonth}
              className="p-1 hover:bg-white rounded transition-colors text-slate-600 cursor-pointer"
              title="下个月"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <button
            onClick={setTodayMonth}
            className="px-2.5 py-1 text-[11px] font-bold bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100/80 transition-colors cursor-pointer"
          >
            本月
          </button>
        </div>
      </div>

      {/* Engineer specialized workspace alert bar */}
      {currentEngineer !== 'all' && (
        <div className="bg-blue-600 text-white px-4 py-2 text-[10px] font-medium flex items-center justify-between shadow-inner flex-shrink-0">
          <div className="flex items-center gap-1.5 truncate">
            <Briefcase className="w-4 h-4 text-blue-200 animate-pulse flex-shrink-0" />
            <span className="truncate">
              💡 正在展示 <strong>【{currentEngineer}】</strong> 专属技术员看板：已智能过滤仅呈现您已完成的历史维修/日常保养和后续由您指派的待办排程。
            </span>
          </div>
          <button 
            onClick={() => setCurrentEngineer('all')}
            className="bg-blue-700 hover:bg-blue-800 px-2 py-0.5 rounded text-[9px] font-bold transition-colors ml-2"
          >
            退出个人视图
          </button>
        </div>
      )}

      {/* Expanded Inline Filters */}
      <div className="px-4 py-2 bg-slate-100/60 border-b border-slate-200/60 flex flex-col lg:flex-row lg:items-center justify-between gap-3 flex-shrink-0">
        
        {/* Toggle checkboxes for 5 distinct categories */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider mr-1 border-r border-slate-200 pr-2">分类过滤:</span>
          
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input 
              type="checkbox" 
              checked={showMaintenance}
              onChange={(e) => {
                setShowMaintenance(e.target.checked);
                setSelectedEvent(null);
              }}
              className="rounded text-blue-600 focus:ring-blue-500 w-3.5 h-3.5 border-slate-300 cursor-pointer"
            />
            <span className="text-[11px] font-bold text-slate-600 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded bg-blue-500 inline-block"></span>
              计划PM维护 ({monthStats.pmCount})
            </span>
          </label>

          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input 
              type="checkbox" 
              checked={showCalibration}
              onChange={(e) => {
                setShowCalibration(e.target.checked);
                setSelectedEvent(null);
              }}
              className="rounded text-amber-500 focus:ring-amber-500 w-3.5 h-3.5 border-slate-300 cursor-pointer"
            />
            <span className="text-[11px] font-bold text-slate-600 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded bg-amber-500 inline-block"></span>
              计划强检计量 ({monthStats.calibCount})
            </span>
          </label>

          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input 
              type="checkbox" 
              checked={showHistMaintenance}
              onChange={(e) => {
                setShowHistMaintenance(e.target.checked);
                setSelectedEvent(null);
              }}
              className="rounded text-emerald-500 focus:ring-emerald-500 w-3.5 h-3.5 border-slate-300 cursor-pointer"
            />
            <span className="text-[11px] font-bold text-slate-600 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded bg-emerald-500 inline-block"></span>
              历史保养记录 ({monthStats.histPmCount})
            </span>
          </label>

          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input 
              type="checkbox" 
              checked={showHistRepair}
              onChange={(e) => {
                setShowHistRepair(e.target.checked);
                setSelectedEvent(null);
              }}
              className="rounded text-rose-500 focus:ring-rose-500 w-3.5 h-3.5 border-slate-300 cursor-pointer"
            />
            <span className="text-[11px] font-bold text-slate-600 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded bg-rose-500 inline-block"></span>
              历史维修记录 ({monthStats.histRepairCount})
            </span>
          </label>

          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input 
              type="checkbox" 
              checked={showHistCalibration}
              onChange={(e) => {
                setShowHistCalibration(e.target.checked);
                setSelectedEvent(null);
              }}
              className="rounded text-violet-500 focus:ring-violet-500 w-3.5 h-3.5 border-slate-300 cursor-pointer"
            />
            <span className="text-[11px] font-bold text-slate-600 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded bg-violet-500 inline-block"></span>
              历史计量记录 ({monthStats.histCalibCount})
            </span>
          </label>
        </div>

        {/* Summary analysis pill */}
        <div className="flex items-center gap-1 bg-slate-50 border border-slate-200/60 rounded-lg px-2.5 py-1 text-[10px] text-slate-500 font-sans truncate">
          <History className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
          <span className="truncate">
            本月共检索到 <strong>{monthStats.totalScheduled}</strong> 笔计划任务与 <strong>{monthStats.totalCompleted}</strong> 笔已完结历史记录。
          </span>
        </div>
      </div>

      {/* Success alert banner */}
      {notification && (
        <div className="mx-4 mt-2.5 bg-emerald-50 border border-emerald-200 text-emerald-800 px-3.5 py-2.5 rounded-xl text-[11px] flex items-center gap-2 shadow-xs animate-fade-in z-30">
          <Check className="w-4 h-4 text-emerald-600 flex-shrink-0" />
          <span className="font-semibold leading-relaxed">{notification}</span>
        </div>
      )}

      {/* Split Grid Area */}
      <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-12">
        
        {/* LEFT COMPONENT: 7x6 Calendar Grid (8 columns) */}
        <div id="calendar_grid_wrapper" className="col-span-12 md:col-span-8 flex flex-col h-full min-h-0 border-r border-slate-200 p-2.5 sm:p-4 bg-white">
          
          {/* Weekday headers */}
          <div className="grid grid-cols-7 gap-1 md:gap-1.5 text-center mb-1 text-[11px] font-black text-slate-400 uppercase tracking-widest font-sans">
            {weekdays.map(day => (
              <div key={day} className="py-1">{day}</div>
            ))}
          </div>

          {/* Month grid days cells */}
          <div className="grid grid-cols-7 gap-1 md:gap-1.5 flex-1 min-h-0">
            {gridDays.map((cell) => {
              const dayEvents = eventsByDay[cell.dateString] || [];
              const hasEvents = dayEvents.length > 0;
              const loadStatus = getDayLoadStatus(dayEvents.filter(e => e.type === 'maintenance' || e.type === 'calibration').length);
              
              const isToday = cell.year === todayYearNumber && cell.month === todayMonthIndex && cell.day === todayDayNumber;

              return (
                <div 
                  key={cell.dateString}
                  onClick={() => setActiveDatePopup(cell.dateString)}
                  className={`min-h-[70px] md:min-h-0 rounded-xl border flex flex-col justify-between p-1.5 transition-all relative group/cell overflow-hidden cursor-pointer ${
                    cell.isCurrentMonth 
                      ? 'bg-white border-slate-200' 
                      : 'bg-slate-50/50 border-slate-100 text-slate-300'
                  } ${
                    isToday ? 'ring-2 ring-blue-500 bg-blue-50/10' : ''
                  } hover:border-blue-400 hover:shadow-2xs`}
                >
                  {/* Cell Top Header */}
                  <div className="flex items-center justify-between">
                    <span className={`text-xs font-black font-mono tracking-tight px-1.5 py-0.5 rounded-full ${
                      isToday 
                        ? 'bg-blue-600 text-white font-extrabold shadow-sm' 
                        : cell.isCurrentMonth ? 'text-slate-700 font-extrabold' : 'text-slate-300 font-normal'
                    }`}>
                      {cell.day}
                    </span>

                    {/* Workload load status dot (only future scheduled counts as load) */}
                    {dayEvents.some(e => e.type === 'maintenance' || e.type === 'calibration') && cell.isCurrentMonth && (
                      <span className={`w-1.5 h-1.5 rounded-full ${loadStatus.dotClass}`} title={loadStatus.text} />
                    )}
                  </div>

                  {/* Cell middle body: render event badges */}
                  <div className="mt-1 flex flex-col gap-1 overflow-y-auto max-h-[85px] scrollbar-none">
                    {dayEvents.slice(0, 4).map(evt => {
                      const isSelected = selectedEvent?.id === evt.id;
                      
                      // Map unique visual aesthetics for each distinct category
                      let classStyles = '';
                      let iconElement = null;

                      if (evt.type === 'maintenance') {
                        classStyles = isSelected
                          ? 'bg-blue-600 text-white border-blue-700 shadow-xs'
                          : 'bg-blue-50 hover:bg-blue-100 text-blue-700 border-blue-100/60';
                        iconElement = <Wrench className="w-2.5 h-2.5 flex-shrink-0" />;
                      } else if (evt.type === 'calibration') {
                        classStyles = isSelected
                          ? 'bg-amber-600 text-white border-amber-700 shadow-xs'
                          : 'bg-amber-50 hover:bg-amber-100 text-amber-700 border-amber-100/60';
                        iconElement = <ShieldCheck className="w-2.5 h-2.5 flex-shrink-0" />;
                      } else if (evt.type === 'hist_maintenance') {
                        classStyles = isSelected
                          ? 'bg-emerald-600 text-white border-emerald-700 shadow-xs'
                          : 'bg-emerald-50 hover:bg-emerald-100/80 text-emerald-700 border-emerald-100/80';
                        iconElement = <Check className="w-2.5 h-2.5 text-emerald-600 flex-shrink-0" />;
                      } else if (evt.type === 'hist_repair') {
                        classStyles = isSelected
                          ? 'bg-rose-600 text-white border-rose-700 shadow-xs'
                          : 'bg-rose-50 hover:bg-rose-100/80 text-rose-700 border-rose-100/80';
                        iconElement = <AlertTriangle className="w-2.5 h-2.5 text-rose-500 flex-shrink-0" />;
                      } else if (evt.type === 'hist_calibration') {
                        classStyles = isSelected
                          ? 'bg-violet-600 text-white border-violet-700 shadow-xs'
                          : 'bg-violet-50 hover:bg-violet-100/80 text-violet-700 border-violet-100/80';
                        iconElement = <ShieldCheck className="w-2.5 h-2.5 text-violet-600 flex-shrink-0" />;
                      }

                      return (
                        <button
                          key={evt.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedEvent(evt);
                            setNewScheduleDate(evt.date);
                            setIsDeployMode(false);
                          }}
                          className={`w-full text-left truncate text-[9px] px-1.5 py-0.5 rounded-sm border transition-all flex items-center gap-1 font-sans font-extrabold cursor-pointer ${classStyles}`}
                          title={`${evt.title}: ${evt.equipment.deviceName}`}
                        >
                          {iconElement}
                          <span className="truncate">{evt.equipment.deviceName}</span>
                        </button>
                      );
                    })}

                    {dayEvents.length > 4 && (
                      <div className="text-[8px] text-slate-400 font-extrabold text-right pr-1">
                        + {dayEvents.length - 4} 笔记录
                      </div>
                    )}
                  </div>

                  {/* Today ribbon */}
                  {isToday && (
                    <span className="absolute top-0 right-0 bg-blue-600 text-white text-[7px] font-black px-1 rounded-bl-lg tracking-wider transform scale-90 origin-top-right uppercase">今天</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* RIGHT COMPONENT: Intelligent Dispatch or Deployment (4 columns) */}
        <div id="dispatch_workshop" className="col-span-12 md:col-span-4 bg-slate-50 p-4 flex flex-col min-h-0 overflow-y-auto border-t md:border-t-0 border-slate-200">
          
          {selectedEvent ? (
            <div className="space-y-4 animate-fade-in flex flex-col h-full justify-between">
              
              {/* Event Detailed Card */}
              <div className="space-y-3.5">
                <div className="flex items-center justify-between pb-2 border-b border-slate-200/80">
                  <span className="text-xs font-black text-slate-700 tracking-wider uppercase flex items-center gap-1">
                    <Sparkles className="w-3.5 h-3.5 text-blue-600 animate-pulse" />
                    装备科技术记录详情面板
                  </span>
                  <button 
                    onClick={() => setSelectedEvent(null)}
                    className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-slate-600 cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Main equipment block */}
                <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-3xs space-y-2.5">
                  <div className="flex items-start gap-2.5">
                    {selectedEvent.equipment.photoUrl ? (
                      <img 
                        src={selectedEvent.equipment.photoUrl} 
                        alt={selectedEvent.equipment.deviceName} 
                        className="w-12 h-12 rounded-lg bg-slate-100 object-cover border border-slate-200/60"
                      />
                    ) : (
                      <div className="w-12 h-12 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600 flex-shrink-0">
                        <Calendar className="w-6 h-6" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`px-1.5 py-0.2 text-[8px] font-black rounded ${
                          selectedEvent.type === 'maintenance' ? 'bg-blue-100 text-blue-800' :
                          selectedEvent.type === 'calibration' ? 'bg-amber-100 text-amber-800' :
                          selectedEvent.type === 'hist_maintenance' ? 'bg-emerald-100 text-emerald-800' :
                          selectedEvent.type === 'hist_repair' ? 'bg-rose-100 text-rose-800' : 'bg-violet-100 text-violet-800'
                        }`}>
                          {selectedEvent.type === 'maintenance' ? '计划PM保养' :
                           selectedEvent.type === 'calibration' ? '计划计量强检' :
                           selectedEvent.type === 'hist_maintenance' ? '已完结PM保养' :
                           selectedEvent.type === 'hist_repair' ? '已完结故障维修' : '已完结法定检定'}
                        </span>
                        <span className="px-1 py-0.2 bg-slate-100 border border-slate-200/50 rounded text-slate-500 text-[8px] font-mono">
                          {selectedEvent.equipment.id.toUpperCase()}
                        </span>
                      </div>
                      <h4 className="text-xs font-black text-slate-800 truncate mt-1">{selectedEvent.equipment.deviceName}</h4>
                      <p className="text-[10px] text-slate-400 mt-0.5 truncate">SN: {selectedEvent.equipment.sn} | 规格: {selectedEvent.equipment.model}</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-100 text-[10px] text-slate-500 font-sans">
                    <div>
                      <span className="text-slate-400 block font-semibold text-[8px] uppercase">所属归口科室</span>
                      <span className="font-extrabold text-slate-700">{selectedEvent.equipment.dept}</span>
                    </div>
                    <div>
                      <span className="text-slate-400 block font-semibold text-[8px] uppercase">当前设备状态</span>
                      <span className={`font-extrabold ${
                        selectedEvent.equipment.status === '正常运行' ? 'text-emerald-600' : 'text-rose-500'
                      }`}>{selectedEvent.equipment.status}</span>
                    </div>
                  </div>
                </div>

                {/* ─── SCENARIO A: FUTURE SCHEDULED TASK (Editable) ─── */}
                {(selectedEvent.type === 'maintenance' || selectedEvent.type === 'calibration') && (
                  <>
                    {!canManageSchedule && (
                      <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-[11px] text-blue-800 leading-relaxed font-medium">
                        当前为临床科室只读追踪视图，可查看计划与责任人；调期、改派和现场执行登记由医学装备科工程师处理。
                      </div>
                    )}

                    {/* Assigned Technician selector */}
                    {canManageSchedule && (
                    <div className="bg-white border border-slate-200 rounded-xl p-3.5 shadow-3xs space-y-2">
                      <div className="flex items-center gap-1 text-[11px] font-bold text-slate-700 uppercase tracking-wider">
                        <User className="w-3.5 h-3.5 text-blue-500" />
                        <span>指派责任技术员 (派发工单)</span>
                      </div>
                      <select
                        value={selectedEvent.technician}
                        onChange={(e) => handleReassignEngineer(e.target.value)}
                        className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-800 bg-slate-50/50 focus:outline-none focus:ring-1 focus:ring-blue-500 font-bold"
                      >
                        {availableEngineers.map(eng => (
                          <option key={eng} value={eng}>{eng} (临床工程师)</option>
                        ))}
                      </select>
                    </div>
                    )}

                    {/* Reschedule Date Selector Panel */}
                    {canManageSchedule && (
                    <form onSubmit={handleReschedule} className="bg-white border border-slate-200 rounded-xl p-3.5 shadow-3xs space-y-3">
                      <div className="flex items-center gap-1 text-[11px] font-extrabold text-slate-700 uppercase tracking-wider">
                        <Clock className="w-3.5 h-3.5 text-blue-500" />
                        <span>调整计划日期 (合理平抑负荷)</span>
                      </div>

                      <div className="space-y-1">
                        <input 
                          id="maintenance-reschedule-date"
                          name="newScheduleDate"
                          type="date" 
                          value={newScheduleDate}
                          onChange={(e) => setNewScheduleDate(e.target.value)}
                          onInput={(e) => setNewScheduleDate(e.currentTarget.value)}
                          className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-800 bg-slate-50/50 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors font-mono font-bold"
                          required
                        />
                      </div>

                      <button
                        id="btn-maintenance-confirm-reschedule"
                        type="submit"
                        disabled={isRescheduling || newScheduleDate === selectedEvent.date}
                        className="w-full py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-lg text-[11px] font-bold shadow-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        {isRescheduling ? '更新调度指令中...' : '确认修改计划日期'}
                      </button>
                    </form>
                    )}

                    {/* Quick deployment actions */}
                    {canManageSchedule && (
                    <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-3xs space-y-2">
                      <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">工单与现场派发</div>
                      
                      <button
                        onClick={handleDirectDispatch}
                        className="w-full py-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 rounded-lg text-xs font-black border border-emerald-100/60 flex items-center justify-center gap-2 transition-colors cursor-pointer"
                      >
                        <Send className="w-3.5 h-3.5 text-emerald-600" />
                        <span>召集就地派工 / 执行登记</span>
                      </button>

                      <button
                        onClick={handlePushAlert}
                        className="w-full py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-bold flex items-center justify-center gap-2 transition-colors cursor-pointer"
                      >
                        <Bell className="w-3.5 h-3.5 text-slate-500" />
                        <span>一键推送企业微信通知</span>
                      </button>
                    </div>
                    )}
                  </>
                )}

                {/* ─── SCENARIO B: HISTORICAL RECORD PLAYBACK (View Only) ─── */}
                {(selectedEvent.type === 'hist_maintenance' || selectedEvent.type === 'hist_repair' || selectedEvent.type === 'hist_calibration') && (
                  <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-3xs space-y-3.5">
                    <div className="flex items-center gap-2 text-slate-800 border-b border-slate-100 pb-2">
                      <History className="w-4 h-4 text-emerald-600" />
                      <span className="text-xs font-black text-slate-700 tracking-wider">历史技术卷宗回溯</span>
                    </div>

                    <div className="space-y-3 text-[11px] text-slate-600 font-sans leading-relaxed">
                      <div className="flex justify-between items-start">
                        <span className="text-slate-400 font-bold">完结日期:</span>
                        <span className="font-mono font-extrabold text-slate-800">{selectedEvent.date}</span>
                      </div>
                      <div className="flex justify-between items-start">
                        <span className="text-slate-400 font-bold">执行技术员/机构:</span>
                        <span className="font-extrabold text-blue-600 flex items-center gap-1">
                          <User className="w-3 h-3" />
                          {selectedEvent.technician}
                        </span>
                      </div>
                      
                      {selectedEvent.cost !== undefined && (
                        <div className="flex justify-between items-start">
                          <span className="text-slate-400 font-bold">维保/维修耗用经费:</span>
                          <span className="font-mono font-black text-rose-600 flex items-center text-xs">
                            <DollarSign className="w-3 h-3 text-rose-500" />
                            {selectedEvent.cost.toLocaleString()} 元
                          </span>
                        </div>
                      )}

                      {selectedEvent.result && (
                        <div className="flex justify-between items-start">
                          <span className="text-slate-400 font-bold">强检计量结果:</span>
                          <span className={`px-2 py-0.5 text-[10px] font-black rounded ${
                            selectedEvent.result === '合格' ? 'bg-emerald-100 text-emerald-800' :
                            selectedEvent.result === '准用' ? 'bg-blue-100 text-blue-800' : 'bg-rose-100 text-rose-800'
                          }`}>{selectedEvent.result}</span>
                        </div>
                      )}

                      <div className="pt-2 border-t border-slate-100 space-y-1">
                        <span className="text-slate-400 block font-bold">维保作业内容 / 技术诊断摘要:</span>
                        <div className="bg-slate-50 border border-slate-100 p-2.5 rounded-lg text-slate-700 text-[10px] leading-relaxed font-medium">
                          {selectedEvent.description || '日常保养合格，技术性常态自检项目通过。各项电气安全、零漂、气体压力处于阈值范围内。'}
                        </div>
                      </div>

                      <div className="bg-blue-50/40 p-2.5 rounded-lg border border-blue-100/50 flex items-start gap-2 text-blue-800 text-[10px] font-medium leading-relaxed">
                        <Info className="w-3.5 h-3.5 text-blue-500 mt-0.5 flex-shrink-0" />
                        <span>此记录已永久归档至全院医学装备技术数据库中，作为后续科室设备精细化预算核算及全生命周期效能考评的重要凭证。</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Inspect Button */}
              <button
                onClick={handleInspectDossier}
                className="w-full py-2.5 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-xs font-black flex items-center justify-center gap-1.5 transition-colors shadow-sm cursor-pointer mt-auto"
              >
                <FileText className="w-3.5 h-3.5" />
                <span>进入该设备技术卷宗档案</span>
              </button>

            </div>
          ) : isDeployMode ? (
            
            // ─── WORK DEPLOYMENT FORM (直接在日历上部署工作) ───
            <form onSubmit={handleDeployWorkSubmit} className="space-y-4 animate-fade-in flex flex-col h-full justify-between">
              
              <div className="space-y-4">
                <div className="flex items-center justify-between pb-2 border-b border-slate-200/80">
                  <span className="text-xs font-black text-slate-700 tracking-wider uppercase flex items-center gap-1">
                    <Plus className="w-4 h-4 text-blue-600" />
                    部署{scheduleScopeLabel}新维保工单
                  </span>
                  <button 
                    type="button"
                    onClick={() => setIsDeployMode(false)}
                    className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-slate-600 cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* 1. Task Type */}
                <div className="space-y-1.5">
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">工单任务类型</label>
                  <div className="grid grid-cols-3 gap-1.5">
                    <button
                      type="button"
                      onClick={() => setDeployTaskType('maintenance')}
                      className={`py-1.5 px-1 rounded-lg text-[10px] font-black border transition-all text-center cursor-pointer ${
                        deployTaskType === 'maintenance'
                          ? 'bg-blue-600 text-white border-blue-700 shadow-2xs'
                          : 'bg-white hover:bg-slate-100 text-slate-600 border-slate-200'
                      }`}
                    >
                      计划PM维护
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeployTaskType('calibration')}
                      className={`py-1.5 px-1 rounded-lg text-[10px] font-black border transition-all text-center cursor-pointer ${
                        deployTaskType === 'calibration'
                          ? 'bg-amber-600 text-white border-amber-700 shadow-2xs'
                          : 'bg-white hover:bg-slate-100 text-slate-600 border-slate-200'
                      }`}
                    >
                      法定计量强检
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeployTaskType('repair')}
                      className={`py-1.5 px-1 rounded-lg text-[10px] font-black border transition-all text-center cursor-pointer ${
                        deployTaskType === 'repair'
                          ? 'bg-rose-600 text-white border-rose-700 shadow-2xs'
                          : 'bg-white hover:bg-slate-100 text-slate-600 border-slate-200'
                      }`}
                    >
                      应急抢修部署
                    </button>
                  </div>
                </div>

                {/* 2. Select Equipment with searchable box */}
                <div className="space-y-1.5">
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">受托医疗设备 (检索)</label>
                  
                  <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-slate-400" />
                    <input 
                      id="maintenance-deploy-search"
                      type="text"
                      placeholder="检索：设备名 / 编号 / SN码 / 科室"
                      value={deploySearchQuery}
                      onChange={(e) => setDeploySearchQuery(e.target.value)}
                      className="w-full text-xs border border-slate-200 rounded-lg pl-8 pr-2.5 py-1.5 bg-white text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-500 font-semibold"
                    />
                  </div>

                  <select
                    id="maintenance-deploy-equipment"
                    value={deployEquipmentId}
                    onChange={(e) => setDeployEquipmentId(e.target.value)}
                    className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-2 text-slate-800 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 font-bold"
                    size={4}
                    required
                  >
                    {filteredEquipmentsForDeploy.map(eq => (
                      <option key={eq.id} value={eq.id} className="py-1">
                        [{eq.id.toUpperCase()}] {eq.deviceName} ({eq.dept})
                      </option>
                    ))}
                    {filteredEquipmentsForDeploy.length === 0 && (
                      <option value="" disabled className="text-slate-400 italic">未找到相匹配的受试设备</option>
                    )}
                  </select>
                </div>

                {/* 3. Assign Engineer */}
                <div className="space-y-1.5">
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">指派责任临床工程师</label>
                  <select
                    id="maintenance-deploy-engineer"
                    value={deployEngineer}
                    onChange={(e) => setDeployEngineer(e.target.value)}
                    className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-800 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 font-bold"
                  >
                    {availableEngineers.map(eng => (
                      <option key={eng} value={eng}>{eng} (临床工程师部)</option>
                    ))}
                  </select>
                </div>

                {/* 4. Plan Date */}
                <div className="space-y-1.5">
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">排期计划开展日期</label>
                  <input 
                    id="maintenance-deploy-date"
                    name="deployDate"
                    type="date"
                    value={deployDate}
                    onChange={(e) => setDeployDate(e.target.value)}
                    onInput={(e) => setDeployDate(e.currentTarget.value)}
                    className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-800 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono font-bold"
                    required
                  />
                </div>

                {/* 5. Deploy Notes */}
                <div className="space-y-1.5">
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">特殊指令/派发备注</label>
                  <textarea
                    id="maintenance-deploy-notes"
                    rows={2}
                    value={deployNotes}
                    onChange={(e) => setDeployNotes(e.target.value)}
                    placeholder="例如：故障现象描述、维保要求、重点复检项目等。"
                    className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-800 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 font-medium"
                  />
                </div>
              </div>

              {/* Action buttons */}
              <div className="space-y-2 pt-3 border-t border-slate-200">
                <button
                  id="btn-maintenance-submit-deploy"
                  type="submit"
                  disabled={!deployEquipmentId || filteredEquipmentsForDeploy.length === 0}
                  className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-lg text-xs font-black shadow-sm transition-colors flex items-center justify-center gap-1.5 cursor-pointer disabled:cursor-not-allowed"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>立即向{scheduleScopeLabel}下发工单</span>
                </button>
                <button
                  type="button"
                  onClick={() => setIsDeployMode(false)}
                  className="w-full py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-bold transition-colors cursor-pointer"
                >
                  取消
                </button>
              </div>

            </form>

          ) : (
            
            // ─── DEFAULT VIEW: Monthly stats & Deployment trigger ───
            <div className="space-y-4 animate-fade-in flex flex-col h-full">
              
              <div className="border-b border-slate-200/80 pb-2.5">
                <span className="text-xs font-black text-slate-700 tracking-wider uppercase">科室统一调度自诊报告</span>
                <p className="text-[10px] text-slate-400 mt-0.5 font-mono">核算账期: {currentYear}-{String(currentMonth+1).padStart(2, '0')}</p>
              </div>

              {/* Statistics grid */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-white p-3 border border-slate-200 rounded-xl text-center shadow-2xs">
                  <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest block">本月待执行计划</span>
                  <p className="text-xl font-black text-blue-600 font-mono mt-1">{monthStats.totalScheduled} 笔</p>
                  <span className="text-[8px] text-slate-400 mt-1 block">PM:{monthStats.pmCount} | 计量:{monthStats.calibCount}</span>
                </div>
                <div className="bg-white p-3 border border-slate-200 rounded-xl text-center shadow-2xs">
                  <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest block">本月已完成记录</span>
                  <p className="text-xl font-black text-emerald-600 font-mono mt-1">{monthStats.totalCompleted} 笔</p>
                  <span className="text-[8px] text-slate-400 mt-1 block">维保:{monthStats.histPmCount} | 维修:{monthStats.histRepairCount}</span>
                </div>
              </div>

              {/* Workload Diagnostic Advice card */}
              <div className="bg-white border border-slate-200 rounded-xl p-3.5 space-y-2 shadow-2xs">
                <div className="flex items-center gap-1.5 text-xs font-black text-slate-800">
                  <Sparkles className="w-4 h-4 text-violet-500 animate-pulse" />
                  <span>AI 统筹合规调度建议</span>
                </div>
                <p className="text-[11px] text-slate-500 leading-relaxed font-sans font-medium">
                  {monthStats.totalScheduled === 0 ? (
                    '本月无计划安排。可以点击下方“工作部署”下达维保、强检任务，或在左侧列表设定计划周期。'
                  ) : monthStats.totalScheduled > 4 ? (
                    `诊断结果：本月排期密度偏高（共计${monthStats.totalScheduled}台精密设备待执行）。目前现场待岗工程师负荷较满，建议点击日历天数标签对高风险设备执行错峰调度。`
                  ) : (
                    '诊断结果：本月设备维保和法定强制检定分布非常均匀。装备科临床工程部人员安排充足，可在规定周期内稳步完成各项技术检查。'
                  )}
                </p>
              </div>

              {/* Direct Work deployment launcher */}
              {canManageSchedule ? (
              <div className="bg-blue-50/50 p-4 border border-blue-100/60 rounded-xl space-y-2.5">
                <div className="space-y-1">
                  <span className="text-xs font-black text-blue-900 flex items-center gap-1.5">
                    <Send className="w-4 h-4 text-blue-600" />
                    日历级工作快速部署
                  </span>
                  <p className="text-[10px] text-blue-700 leading-relaxed font-medium">
                    您可以在日历上直接向特定的值班临床工程师指派计划任务或紧急故障维修任务，工单会与日历日程及设备卷宗自动关联。
                  </p>
                </div>
                <button
                  onClick={() => {
                    setIsDeployMode(true);
                    setDeployEquipmentId(filteredEquipmentsForDeploy[0]?.id || '');
                    setDeployDate(getLocalDateString());
                  }}
                  className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-black shadow-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>部署{scheduleScopeLabel}新工作指令</span>
                </button>
              </div>
              ) : (
                <div className="bg-slate-50 p-4 border border-slate-200 rounded-xl space-y-1.5">
                  <span className="text-xs font-black text-slate-700 flex items-center gap-1.5">
                    <Info className="w-4 h-4 text-blue-500" />
                    临床日程只读视图
                  </span>
                  <p className="text-[10px] text-slate-500 leading-relaxed font-medium">
                    当前账号可查看本科室设备维保、维修和计量记录；新工单部署、调期和改派由医学装备科工程师执行。
                  </p>
                </div>
              )}

              {/* Upcoming chronological events list */}
              <div className="flex-1 flex flex-col min-h-0 space-y-2">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider block">本月排期及记录一览</span>
                
                <div className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
                  {allEvents.filter(evt => evt.date.startsWith(`${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`)).length === 0 ? (
                    <div className="text-center py-8 text-slate-400 text-[10px] italic bg-white border border-slate-100 rounded-lg">
                      本月无任何记录或排期任务
                    </div>
                  ) : (
                    allEvents
                      .filter(evt => evt.date.startsWith(`${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`))
                      .sort((a, b) => a.date.localeCompare(b.date))
                      .map(evt => (
                        <div 
                          key={evt.id}
                          onClick={() => {
                            setSelectedEvent(evt);
                            setNewScheduleDate(evt.date);
                            setIsDeployMode(false);
                          }}
                          className="bg-white border border-slate-200 rounded-lg p-2.5 hover:border-blue-400 hover:shadow-3xs transition-all flex items-center justify-between gap-2.5 cursor-pointer shadow-2xs"
                        >
                          <div className="min-w-0 flex-1 leading-tight">
                            <span className={`text-[8px] font-black px-1.5 py-0.2 rounded inline-block mb-1 ${
                              evt.type === 'maintenance' ? 'bg-blue-100 text-blue-700' :
                              evt.type === 'calibration' ? 'bg-amber-100 text-amber-700' :
                              evt.type === 'hist_maintenance' ? 'bg-emerald-100 text-emerald-700' :
                              evt.type === 'hist_repair' ? 'bg-rose-100 text-rose-700' : 'bg-violet-100 text-violet-700'
                            }`}>
                              {evt.type === 'maintenance' ? 'PM计划' :
                               evt.type === 'calibration' ? '法定计量' :
                               evt.type === 'hist_maintenance' ? '历史保养' :
                               evt.type === 'hist_repair' ? '历史维修' : '历史计量'}
                            </span>
                            <h5 className="text-[11px] font-black text-slate-700 truncate">{evt.equipment.deviceName}</h5>
                            <p className="text-[9px] text-slate-400 mt-0.5 truncate font-mono">负责/执行: {evt.technician}</p>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <span className="text-[10px] font-bold text-slate-600 font-mono block">{evt.date.substring(5)}</span>
                            <span className="text-[9px] text-blue-600 hover:underline">查看 ➔</span>
                          </div>
                        </div>
                      ))
                  )}
                </div>
              </div>

            </div>
          )}

        </div>

      </div>

      {/* Daily Overview Popover / Modal */}
      {activeDatePopup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in animate-duration-200" onClick={() => setActiveDatePopup(null)}>
          <div 
            className="bg-white rounded-2xl shadow-xl border border-slate-100 max-w-md w-full overflow-hidden flex flex-col max-h-[85vh] animate-scale-up animate-duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="px-5 py-4 bg-slate-50 border-b border-slate-100 flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-2">
                <div className="bg-blue-50 p-2 rounded-lg text-blue-600">
                  <Calendar className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-sm font-black text-slate-800 font-sans tracking-tight">每日维保及计量排期概览</h4>
                  <p className="text-[10px] text-slate-400 font-mono font-semibold">{activeDatePopup}</p>
                </div>
              </div>
              <button 
                onClick={() => setActiveDatePopup(null)}
                className="p-1.5 hover:bg-slate-200 rounded-lg text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 overflow-y-auto space-y-4 flex-1 min-h-0">
              {popupEvents.length === 0 ? (
                <div className="text-center py-10 space-y-2.5">
                  <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mx-auto text-slate-400">
                    <Check className="w-6 h-6 text-slate-500" />
                  </div>
                  <div>
                    <p className="text-xs font-bold text-slate-500 font-sans">该日期暂无任何任务或记录</p>
                    <p className="text-[10px] text-slate-400 mt-1 max-w-[280px] mx-auto leading-relaxed">
                      本天暂无安排的PM自检或周期强检记录。点击下方按钮，可立刻在此日期为工程师部署受试任务。
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">
                    当天共有 {popupEvents.length} 项维保、抢修或计量检定信息
                  </p>
                  <div className="space-y-2.5">
                    {popupEvents.map((evt) => (
                      <div 
                        key={evt.id}
                        className="p-3 bg-slate-50 hover:bg-slate-100/80 border border-slate-200/60 rounded-xl transition-all flex items-start justify-between gap-3 shadow-2xs"
                      >
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={`px-1.5 py-0.2 text-[8px] font-black rounded ${
                              evt.type === 'maintenance' ? 'bg-blue-100 text-blue-800' :
                              evt.type === 'calibration' ? 'bg-amber-100 text-amber-800' :
                              evt.type === 'hist_maintenance' ? 'bg-emerald-100 text-emerald-800' :
                              evt.type === 'hist_repair' ? 'bg-rose-100 text-rose-800' : 'bg-violet-100 text-violet-800'
                            }`}>
                              {evt.type === 'maintenance' ? '计划PM维护' :
                               evt.type === 'calibration' ? '计划计量检定' :
                               evt.type === 'hist_maintenance' ? '历史保养合格' :
                               evt.type === 'hist_repair' ? '历史维修完结' : '历史计量合格'}
                            </span>
                            <span className="px-1 py-0.2 bg-white border border-slate-200/50 rounded text-slate-400 text-[8px] font-mono">
                              {evt.equipment.id.toUpperCase()}
                            </span>
                          </div>
                          <h5 className="text-xs font-black text-slate-800 truncate">{evt.equipment.deviceName}</h5>
                          <div className="flex flex-col gap-0.5 text-[9px] text-slate-400 font-semibold leading-tight">
                            <span>科室: {evt.equipment.dept} | 负责/执行: {evt.technician}</span>
                            {evt.cost !== undefined && <span className="text-rose-600 font-mono">经费: ¥{evt.cost.toLocaleString()} 元</span>}
                          </div>
                        </div>

                        <button
                          onClick={() => {
                            setSelectedEvent(evt);
                            setNewScheduleDate(evt.date);
                            setIsDeployMode(false);
                            setActiveDatePopup(null);
                          }}
                          className="flex-shrink-0 px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-[10px] font-bold transition-all flex items-center gap-1 shadow-2xs hover:shadow-xs cursor-pointer"
                        >
                          <span>详细技术分析</span>
                          <span>➔</span>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-5 py-3 bg-slate-50 border-t border-slate-100 flex items-center justify-between text-[10px] text-slate-400 font-medium flex-shrink-0">
              {canManageSchedule ? (
                <button
                  onClick={() => openDeployForDate(activeDatePopup)}
                  className="px-2.5 py-1 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg text-[10px] font-black transition-all flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5 text-blue-600" />
                  <span>在此日期部署新任务</span>
                </button>
              ) : (
                <span className="px-2.5 py-1 bg-white border border-slate-200 rounded-lg text-slate-500 font-bold">
                  临床只读：仅查看当天本科室排程
                </span>
              )}
              <button 
                onClick={() => setActiveDatePopup(null)}
                className="text-slate-500 hover:text-slate-800 font-black cursor-pointer"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}