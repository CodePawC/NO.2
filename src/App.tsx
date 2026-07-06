/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  Wrench, 
  Plus, 
  Send, 
  FileText, 
  User, 
  AlertTriangle, 
  Activity, 
  ExternalLink, 
  CheckCircle2, 
  Clock, 
  ArrowRight, 
  Building2, 
  Phone, 
  MapPin, 
  Tag, 
  RotateCcw,
  Sparkles,
  Check,
  ShieldCheck,
  Trash2,
  ChevronRight,
  ChevronDown,
  Star,
  HelpCircle,
  TrendingUp,
  FileSpreadsheet,
  Eye,
  Settings,
  Key,
  Cpu,
  Globe,
  Play,
  Link2,
  Trash,
  Mic,
  MicOff,
  Menu,
  X,
  Info
} from 'lucide-react';
import { StructuredTicket, ChatMessage, TaskType, UrgencyLevel, ClinicalImpact, TaskStatus, LLMConfig, MedicalEquipment, UserProfile } from './types';
import { INITIAL_TASKS } from './data/defaultTasks';
import { getPresetPromptsForUser, MOCK_VOICE_TEMPLATES, SIMULATED_USERS } from './data/appPresets';
import { useAiSettings } from './hooks/useAiSettings';
import { useSpeechRecognition } from './hooks/useSpeechRecognition';
import { sendAssistantChat } from './services/aiApi';
import { getDateDiffDaysFromToday } from './utils/dateUtils';
import { isSameDepartment, normalizeDepartmentName } from './utils/departmentUtils';
import { findUniqueEquipmentMatchForDraft, syncTasksToEquipmentArchives } from './utils/equipmentSync';
import { EQUIPMENT_STORAGE_KEY, getDefaultEquipmentList, parseStoredEquipmentList } from './utils/equipmentStorage';
import { getDepartmentTasks, sortTasksByOperationalPriority } from './utils/taskOrdering';
import { loadStoredTasks, TASK_STORAGE_KEY } from './utils/taskStorage';
import { getClinicalAcceptanceBlockReason, getEngineerNextStatus, getEngineerStatusBlockReason, getEngineerWorkflowHint, getRecommendedRoutingForTask, needsClinicalAcceptance } from './utils/taskWorkflow';
import TaskStats from './components/TaskStats';
import EquipmentArchives from './components/EquipmentArchives';

const getLocalDateIdPart = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
};

const createNextTaskId = (existingTasks: StructuredTicket[]) => {
  const datePart = getLocalDateIdPart();
  const idPattern = new RegExp(`^TKT-${datePart}(\\d+)$`);
  const maxSequence = existingTasks.reduce((max, task) => {
    const match = task.id.match(idPattern);
    if (!match) return max;
    return Math.max(max, Number(match[1]) || 0);
  }, 0);

  return `TKT-${datePart}${String(maxSequence + 1).padStart(2, '0')}`;
};

const findActiveEquipmentRepairTask = (tasks: StructuredTicket[], equipment: MedicalEquipment) => {
  return tasks
    .filter(needsClinicalAcceptance)
    .find(task => (
      !['已完成', '已归档', '已关闭'].includes(task.status) &&
      (
        task.deviceId === equipment.id ||
        task.deviceId === equipment.sn ||
        (task.deviceName === equipment.deviceName && isSameDepartment(task.department, equipment.dept))
      )
    ));
};

const hasActiveEquipmentRepairTask = (tasks: StructuredTicket[], equipment: MedicalEquipment) => {
  return Boolean(findActiveEquipmentRepairTask(tasks, equipment));
};

const getTaskAcceptanceDisplay = (task: StructuredTicket) => {
  if (task.clinicalAcceptance) {
    return task.clinicalAcceptance;
  }

  const legacyNote = task.notes?.includes('[科室验收意见]')
    ? task.notes.split('[科室验收意见]')[1].trim()
    : '';
  const legacyRating = Number(legacyNote.match(/^(\d+)星：/)?.[1]);

  return {
    rating: Number.isFinite(legacyRating) && legacyRating >= 1 && legacyRating <= 5 ? legacyRating : 5,
    comment: legacyNote ? legacyNote.replace(/^\d+星：/, '') : '设备试运行良好，已正常投用',
    acceptedBy: task.contactPerson || '临床科室',
    acceptedByTitle: '科室验收人',
    acceptedAt: task.updatedAt
  };
};

export default function App() {
  const [tasks, setTasks] = useState<StructuredTicket[]>(loadStoredTasks);
  const tasksRef = useRef(tasks);
  const pendingQuickRepairEquipmentIdsRef = useRef<Set<string>>(new Set());
  const pendingClinicalAcceptanceTaskIdsRef = useRef<Set<string>>(new Set());

  const [currentWorkspace, setCurrentWorkspace] = useState<'tasks' | 'archives'>('tasks');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const [allEquipments, setAllEquipments] = useState<MedicalEquipment[]>(() => (
    parseStoredEquipmentList(localStorage.getItem(EQUIPMENT_STORAGE_KEY)).equipments
  ));

  useEffect(() => {
    const { equipments, shouldPersist } = parseStoredEquipmentList(localStorage.getItem(EQUIPMENT_STORAGE_KEY));
    setAllEquipments(equipments);
    if (shouldPersist) {
      localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(equipments));
    }
  }, [currentWorkspace]);

  const handleReportRepairFromEquip = (equip: any) => {
    if (currentUserRole === 'medical_staff' && currentSimulatedUser.role === 'medical_staff' && !isSameDepartment(equip.dept, currentSimulatedUser.department || currentSimulatedUser.dept)) {
      appendWorkflowNotice(`⚠️ **报修权限提醒**\n当前临床账号只能为本科室设备发起报修。设备【${equip.deviceName}】归属【${equip.dept}】，当前账号归属【${currentSimulatedUser.department || currentSimulatedUser.dept}】。`, 'msg-asset-report-blocked');
      return;
    }

    const duplicateRepairTask = findActiveEquipmentRepairTask(tasksRef.current, equip);
    if (duplicateRepairTask) {
      setCurrentWorkspace('tasks');
      setSelectedTask(duplicateRepairTask);
      setMobileTab('detail');
      appendWorkflowNotice(`⚠️ **重复报修提醒**\n设备【${equip.deviceName}】已有未闭环维修工单 **${duplicateRepairTask.id}**（当前状态：【${duplicateRepairTask.status}】）。请在现有工单中补充故障信息，避免重复生成报修草稿。`, 'msg-asset-report-duplicate-blocked');
      return;
    }

    setCurrentWorkspace('tasks');
    const presetText = `【系统一键扫码报修】
设备名称: ${equip.deviceName}
规格型号: ${equip.model}
原厂SN码: ${equip.sn}
资产编号: ${equip.id}
所在科室: ${equip.dept}
故障现象: 设备异常，需装备科紧急派人进行维修或PM检查。`;
    
    setInputMessage(presetText);
    
    // Construct pre-filled draft ticket
    setDraftTicket({
      taskType: '设备报修',
      department: normalizeDepartmentName(equip.dept),
      deviceName: equip.deviceName,
      deviceId: equip.id,
      faultPhenomenon: '设备发生故障异常，需紧急现场排故与检修。',
      urgency: equip.riskLevel === '高' ? '紧急' : '普通',
      affectClinical: equip.category === '急救生命支持' ? '是' : '否',
      status: '待确认',
      source: '科室扫码报修'
    });
    
    // Auto shift view on mobile
    setMobileTab('chat');
  };

  const handleQuickRepairCreated = ({
    equipment,
    description,
    urgency,
    workOrderNo
  }: {
    equipment: MedicalEquipment;
    description: string;
    urgency: 'low' | 'medium' | 'high';
    workOrderNo: string;
  }): boolean => {
    const isClinicalReporter = currentUserRole === 'medical_staff' && currentSimulatedUser.role === 'medical_staff';
    if (
      isClinicalReporter &&
      !isSameDepartment(equipment.dept, currentSimulatedUser.department || currentSimulatedUser.dept)
    ) {
      appendWorkflowNotice(`⚠️ **快捷报修权限提醒**\n当前临床账号只能为本科室设备同步主工单。设备【${equipment.deviceName}】归属【${equipment.dept}】，当前账号归属【${currentSimulatedUser.department || currentSimulatedUser.dept}】。`, 'msg-quick-repair-blocked');
      return false;
    }
    const latestTasks = tasksRef.current;
    if (hasActiveEquipmentRepairTask(latestTasks, equipment)) {
      appendWorkflowNotice(`⚠️ **重复报修提醒**\n设备【${equipment.deviceName}】已有未闭环维修工单，请在现有工单中补充故障信息，避免重复派单。`, 'msg-quick-repair-duplicate-blocked');
      return false;
    }
    if (pendingQuickRepairEquipmentIdsRef.current.has(equipment.id)) {
      appendWorkflowNotice(`⚠️ **重复报修提醒**\n设备【${equipment.deviceName}】正在同步快捷报修主工单，请勿重复点击。`, 'msg-quick-repair-pending-blocked');
      return false;
    }

    pendingQuickRepairEquipmentIdsRef.current.add(equipment.id);

    const urgencyLevel: UrgencyLevel = urgency === 'high'
      ? (equipment.category === '急救生命支持' || equipment.riskLevel === '高' ? '生命支持' : '紧急')
      : urgency === 'medium'
        ? '较急'
        : '普通';
    const normalizedDept = normalizeDepartmentName(equipment.dept);
    const newTicketId = createNextTaskId(latestTasks);
    const now = new Date();
    const reportContactPerson = isClinicalReporter
      ? currentSimulatedUser.name
      : `${normalizedDept || equipment.dept || '设备使用科室'}值班人员`;
    const reportContactPhone = isClinicalReporter
      ? (currentSimulatedUser.phone || '未录入电话')
      : '待科室确认';
    const reportSource = isClinicalReporter ? '科室扫码报修' : '工程师手工录入';
    const operatorLabel = isClinicalReporter
      ? `${currentSimulatedUser.name} (${currentSimulatedUser.title})`
      : `${currentSimulatedUser.name} (${currentSimulatedUser.title}) 代建`;
    const newTicket: StructuredTicket = {
      id: newTicketId,
      taskType: urgencyLevel === '生命支持' ? '生命支持设备应急' : '设备报修',
      source: reportSource,
      department: normalizedDept || equipment.dept || '未录入科室',
      location: `${normalizedDept || equipment.dept || '未录入科室'}设备点位`,
      deviceName: equipment.deviceName,
      deviceId: equipment.id,
      faultPhenomenon: description,
      contactPerson: reportContactPerson,
      contactPhone: reportContactPhone,
      urgency: urgencyLevel,
      affectClinical: urgency === 'high' || equipment.category === '急救生命支持' ? '是' : '否',
      status: '待确认',
      aiStatus: '已分析',
      needBackupDevice: urgencyLevel === '生命支持' ? '是' : '否',
      needVendorCoop: '否',
      recommendedDept: '医学装备科',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      aiSuggestions: [
        '已由资产档案快捷报修同步生成主任务工单。',
        urgencyLevel === '生命支持' ? '请优先协调备用设备并通知值班工程师立即响应。' : '请装备科尽快完成分派并记录现场维修轨迹。',
        `关联档案维修单号：${workOrderNo}`
      ],
      logs: [
        {
          time: now.toLocaleString('zh-CN', { hour12: false }).slice(0, 16),
          action: `资产档案快捷报修同步建单。关联档案维修单号：${workOrderNo}，紧急度：${urgencyLevel}。`,
          operator: operatorLabel
        }
      ],
      rawText: description,
      notes: isClinicalReporter
        ? `由资产档案快捷报修生成；档案维修单号：${workOrderNo}。`
        : `由资产档案快捷报修生成；档案维修单号：${workOrderNo}。工程师代建，现场联系人需向${normalizedDept || equipment.dept || '使用科室'}确认。`
    };

    const nextTasks = [newTicket, ...tasksRef.current];
    tasksRef.current = nextTasks;
    localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(nextTasks));
    setTasks(prev => {
      if (prev.some(task => task.id === newTicket.id)) return prev;
      const mergedTasks = [newTicket, ...prev];
      tasksRef.current = mergedTasks;
      localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(mergedTasks));
      return mergedTasks;
    });
    pendingQuickRepairEquipmentIdsRef.current.delete(equipment.id);
    setSelectedTask(newTicket);
    setCurrentWorkspace('tasks');
    setMobileTab('detail');
    setChatMessages(prev => [...prev, {
      id: `msg-quick-repair-${Date.now()}`,
      sender: 'assistant',
      text: `🚑 **资产档案快捷报修已同步主工单**\n设备：**${equipment.deviceName}**\n主工单：**${newTicketId}**\n档案维修单：**${workOrderNo}**\n\n工程师现在可以在任务流转助手中接单处理，后续仍需临床科室验收闭环。`,
      timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    }]);
    return true;
  };

  // Role and Auth Simulation States
  const [currentSimulatedUserId, setCurrentSimulatedUserId] = useState<string>('ENG-5021');
  const [currentUserRole, setCurrentUserRole] = useState<'medical_staff' | 'engineer'>('engineer');
  const [showSimulatedAuthModal, setShowSimulatedAuthModal] = useState(false);
  const [ratingValue, setRatingValue] = useState<number>(5);
  const [ratingComment, setRatingComment] = useState<string>('');
  const [pendingClinicalAcceptanceTaskIds, setPendingClinicalAcceptanceTaskIds] = useState<Set<string>>(() => new Set());
  const [showRoleSwitchedToast, setShowRoleSwitchedToast] = useState<string | null>(null);
  const roleToastTimerRef = useRef<number | null>(null);

  const currentSimulatedUser = SIMULATED_USERS.find(u => u.id === currentSimulatedUserId) || SIMULATED_USERS[0];
  const isClinicalUser = currentUserRole === 'medical_staff';
  const currentUserDepartment = currentSimulatedUser.department || currentSimulatedUser.dept;
  const visiblePresetPrompts = getPresetPromptsForUser(currentSimulatedUser);
  const canCurrentUserSeeTask = (task: StructuredTicket) => {
    return !isClinicalUser || isSameDepartment(task.department, currentUserDepartment);
  };
  const canUserSeeTask = (task: StructuredTicket, user: UserProfile, userRole = user.role) => {
    return userRole !== 'medical_staff' || isSameDepartment(task.department, user.department || user.dept);
  };
  const getVisibleFallbackTask = (sourceTasks: StructuredTicket[]) => {
    if (isClinicalUser) {
      return getDepartmentTasks(sourceTasks, currentUserDepartment)[0] || null;
    }

    return sourceTasks.find(canCurrentUserSeeTask) || null;
  };
  const canCurrentUserUseEquipment = (equipment: MedicalEquipment) => {
    return !isClinicalUser || isSameDepartment(equipment.dept, currentUserDepartment);
  };
  const visibleTasks = tasks.filter(canCurrentUserSeeTask);
  const visibleActiveTaskCount = visibleTasks.filter(t => !['已归档', '已完成', '已关闭'].includes(t.status)).length;
  const visibleEquipments = allEquipments.filter(canCurrentUserUseEquipment);
  const sidebarEquipmentUptimeRate = visibleEquipments.length > 0
    ? ((visibleEquipments.filter(eq => eq.status === '正常运行').length / visibleEquipments.length) * 100).toFixed(1)
    : '0.0';
  const sidebarCalibrationDueCount = visibleEquipments.filter(eq => {
    if (!eq.calibrationRequired) return false;
    const diffDays = getDateDiffDaysFromToday(eq.nextCalibrationDate);
    if (diffDays === null) return false;
    return diffDays >= 0 && diffDays <= 30;
  }).length;
  const sidebarEmergencyCount = visibleTasks.filter(t => needsClinicalAcceptance(t) && (t.urgency === '生命支持' || t.urgency === '特急')).length;
  const clinicalDepartmentTasks = getDepartmentTasks(tasks, currentUserDepartment);
  const normalizeClinicalDraftSource = (source?: StructuredTicket['source']) => {
    return source === '科室扫码报修' || source === '微信小程序' ? source : 'AI 对话生成';
  };

  const getEngineerActionBlockReason = (actionName: string) => {
    if (currentUserRole === 'engineer' && currentSimulatedUser.role === 'engineer') {
      return '';
    }

    return `当前登录身份为【${currentSimulatedUser.name} ${currentSimulatedUser.title}】，不能执行${actionName}。请切换到医学装备科工程师账号后再操作。`;
  };
  const isTaskTerminal = (task: StructuredTicket | null) => {
    return task ? ['已归档', '已关闭'].includes(task.status) : false;
  };

  const appendWorkflowNotice = (message: string, idPrefix = 'msg-workflow-notice') => {
    setChatMessages(prev => [...prev, {
      id: `${idPrefix}-${Date.now()}`,
      sender: 'assistant',
      text: message,
      timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    }]);
  };

  const showRoleToast = (message: string) => {
    if (roleToastTimerRef.current !== null) {
      window.clearTimeout(roleToastTimerRef.current);
    }
    setShowRoleSwitchedToast(message);
    roleToastTimerRef.current = window.setTimeout(() => {
      setShowRoleSwitchedToast(null);
      roleToastTimerRef.current = null;
    }, 4500);
  };

  useEffect(() => {
    return () => {
      if (roleToastTimerRef.current !== null) {
        window.clearTimeout(roleToastTimerRef.current);
      }
    };
  }, []);

  const handleSwitchUser = (userId: string) => {
    const targetUser = SIMULATED_USERS.find(u => u.id === userId);
    if (!targetUser) return;
    roleSessionVersionRef.current += 1;
    setDraftTicket(null);
    setAiSuggestions([]);
    setForwardDept(null);
    setIsClarification(false);
    setIsFullDraftOpen(false);
    setShowVoiceMockModal(false);
    setSimulationText('');
    stopVoiceSimulation();
    stopListening();
    setIsLoading(false);
    setSearchQuery('');
    setTypeFilter('All');
    setUrgencyFilter('All');
    setStatusFilter('All');
    setSourceFilter('All');
    setCurrentSimulatedUserId(userId);
    setCurrentUserRole(targetUser.role);
    setShowSimulatedAuthModal(false);
    
    // Set a toast to show role switch
    showRoleToast(`已切换身份为 【${targetUser.name}】(${targetUser.title})`);

    // If clinical user, add an automatic greeting from the AI assistant
    const latestTasks = tasksRef.current;
    const latestSelectedTask = selectedTask ? latestTasks.find(task => task.id === selectedTask.id) || null : null;

    if (targetUser.role === 'medical_staff') {
      const greetingMsg: ChatMessage = {
        id: `msg-welcome-${Date.now()}`,
        sender: 'assistant',
        text: `🏥 **您好，${targetUser.name} ${targetUser.title}！**欢迎使用大模型语音报修台。\n\n当前您处于 **【临床科室报修端】** 视图，在这里您可以：\n1. **一键口述/文字报修**：点击下方的【🎙️ 语音报修】直接说话，或输入文字。\n2. **科室单据追踪**：在右侧将自动只展示 **${targetUser.department}** 的设备维修进度。\n3. **服务满意度验收**：设备修复后，您可在此一键签署验收并评价打分，闭环全流程！\n\n请问您有什么需要报修的设备吗？`,
        timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      };
      setChatMessages([greetingMsg]);
      
      // Keep the current task in focus when switching back to its owning clinical department.
      const deptTasks = getDepartmentTasks(latestTasks, targetUser.department || targetUser.dept);
      const currentTaskBelongsToTargetDept = latestSelectedTask && canUserSeeTask(latestSelectedTask, targetUser, targetUser.role);
      if (currentTaskBelongsToTargetDept) {
        setSelectedTask(latestSelectedTask);
        setMobileTab('detail');
      } else if (deptTasks.length > 0) {
        setSelectedTask(deptTasks[0]);
        setMobileTab('list');
      } else {
        setSelectedTask(null);
        setMobileTab('chat');
      }
    } else {
      // Engineer greeting
      const greetingMsg: ChatMessage = {
        id: `msg-welcome-eng-${Date.now()}`,
        sender: 'assistant',
        text: `👨‍💻 **欢迎回来，${targetUser.name} 工程师！**\n您当前处于 **【装备科管理工作台】** 视图，在这里您可以：\n- 查看全院医学装备统计看板。\n- 使用多维过滤器对全院工单进行分拣、委派、更新状态、添加耗材协作日志。\n- 测试切换不同的 AI 大模型配置。\n\n请随时在左侧输入或通过右侧处理相关任务。`,
        timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      };
      setChatMessages([greetingMsg]);
      const engineerFocusedTask = latestSelectedTask || latestTasks[0] || null;
      setSelectedTask(engineerFocusedTask);
      setMobileTab(engineerFocusedTask ? 'detail' : 'list');
    }
  };

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [selectedTask, setSelectedTask] = useState<StructuredTicket | null>(() => tasks[0] || null);
  
  // Local states for filtering and searching
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('All');
  const [urgencyFilter, setUrgencyFilter] = useState<string>('All');
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [sourceFilter, setSourceFilter] = useState<string>('All');

  // Interactive current drafted parsed ticket (editable prior to creation)
  const [draftTicket, setDraftTicket] = useState<Partial<StructuredTicket> | null>(null);
  const [mobileTab, setMobileTab] = useState<'chat' | 'list' | 'detail'>('chat');
  const [aiSuggestions, setAiSuggestions] = useState<string[]>([]);
  const [isClarification, setIsClarification] = useState(false);
  const [forwardDept, setForwardDept] = useState<string | null>(null);
  const [isFullDraftOpen, setIsFullDraftOpen] = useState(false);
  const roleSessionVersionRef = useRef(0);
  const isCreatingDraftTicketRef = useRef(false);

  useEffect(() => {
    if (draftTicket) {
      isCreatingDraftTicketRef.current = false;
    }
  }, [draftTicket]);

  const openLinkedEquipmentArchive = (equipmentId: string) => {
    const activeRoleSessionVersion = roleSessionVersionRef.current;
    setCurrentWorkspace('archives');
    setTimeout(() => {
      if (activeRoleSessionVersion !== roleSessionVersionRef.current) return;
      window.dispatchEvent(new CustomEvent('deep-link-equipment', {
        detail: { equipmentId, activeTab: 'basic' }
      }));
    }, 100);
  };

  useEffect(() => {
    const handleDeepLinkTicket = (e: any) => {
      const ticketId = e.detail?.ticketId;
      if (!ticketId) return;

      const latestTasks = tasksRef.current;
      const found = latestTasks.find(t => t.id === ticketId);
      if (!found) return;

      if (!canCurrentUserSeeTask(found)) {
        const fallbackTask = getVisibleFallbackTask(latestTasks);
        const scopeLabel = currentUserDepartment || '本科室';
        setSelectedTask(fallbackTask);
        setCurrentWorkspace('tasks');
        setMobileTab(fallbackTask ? 'list' : 'chat');
        showRoleToast(`已阻止跨科室工单访问，仅显示【${scopeLabel}】任务`);
        setChatMessages(prev => [...prev, {
          id: `msg-ticket-deeplink-blocked-${Date.now()}`,
          sender: 'assistant',
          text: `⚠️ **工单访问权限提醒**\n当前临床账号只能查看【${scopeLabel}】工单。任务【${found.id}】归属【${found.department}】，系统已阻止打开。`,
          timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        }]);
        return;
      }

      setSelectedTask(found);
      setCurrentWorkspace('tasks');
      setMobileTab('detail');
    };

    window.addEventListener('deep-link-ticket', handleDeepLinkTicket);
    return () => {
      window.removeEventListener('deep-link-ticket', handleDeepLinkTicket);
    };
  }, [tasks, isClinicalUser, currentUserDepartment]);

  useEffect(() => {
    if (!selectedTask) return;

    const latestSelectedTask = tasksRef.current.find(task => task.id === selectedTask.id);
    if (latestSelectedTask && latestSelectedTask !== selectedTask) {
      setSelectedTask(latestSelectedTask);
      return;
    }

    if (!latestSelectedTask) {
      const fallbackTask = getVisibleFallbackTask(tasksRef.current);
      setSelectedTask(fallbackTask);
      if (!fallbackTask && mobileTab === 'detail') {
        setMobileTab(isClinicalUser ? 'chat' : 'list');
      }
    }
  }, [tasks, selectedTask?.id, currentUserRole, currentUserDepartment, mobileTab]);

  useEffect(() => {
    if (!isClinicalUser || !selectedTask || canCurrentUserSeeTask(selectedTask)) {
      return;
    }

    const fallbackTask = getVisibleFallbackTask(tasksRef.current);
    setSelectedTask(fallbackTask);
    setMobileTab(fallbackTask ? 'list' : 'chat');
    showRoleToast(`已阻止跨科室工单访问，仅显示【${currentUserDepartment || '本科室'}】任务`);
  }, [isClinicalUser, currentUserDepartment, selectedTask?.id, tasks]);

  // Advanced AI custom settings states
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const {
    providerConfigs,
    activeProviderId,
    setActiveProviderId,
    showRawPayload,
    setShowRawPayload,
    isTesting,
    testResult,
    clearTestResult,
    handleFieldChange,
    handleTestConfig,
    resetProviderConfigs
  } = useAiSettings();

  const notifyAiSettingsManagedByEngineer = () => {
    showRoleToast('AI配置由医学装备科维护，临床端仅可查看当前模型运行状态');
  };

  const openAiSettings = () => {
    if (isClinicalUser) {
      notifyAiSettingsManagedByEngineer();
      return;
    }

    setIsSettingsOpen(true);
  };

  useEffect(() => {
    if (isClinicalUser && isSettingsOpen) {
      setIsSettingsOpen(false);
    }
  }, [isClinicalUser, isSettingsOpen]);

  const {
    isListening,
    recognitionError,
    speechSupported,
    showVoiceMockModal,
    setShowVoiceMockModal,
    stopListening,
    toggleListening
  } = useSpeechRecognition({ setInputMessage });

  // Voice Simulation States
  const [selectedMockScript, setSelectedMockScript] = useState(0);
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationText, setSimulationText] = useState('');
  const simulationIntervalRef = useRef<any>(null);

  const stopVoiceSimulation = (resetState = true) => {
    if (simulationIntervalRef.current) {
      clearInterval(simulationIntervalRef.current);
      simulationIntervalRef.current = null;
    }
    if (resetState) {
      setIsSimulating(false);
    }
  };

  const startSimulation = (textToSimulate: string) => {
    if (simulationIntervalRef.current) {
      clearInterval(simulationIntervalRef.current);
    }
    setIsSimulating(true);
    setSimulationText('');
    let index = 0;
    
    simulationIntervalRef.current = setInterval(() => {
      if (index < textToSimulate.length) {
        setSimulationText(prev => prev + textToSimulate.charAt(index));
        index++;
      } else {
        clearInterval(simulationIntervalRef.current);
        simulationIntervalRef.current = null;
        setIsSimulating(false);
      }
    }, 35); // elegant, high-fidelity typing speed
  };

  useEffect(() => {
    return () => {
      stopVoiceSimulation(false);
    };
  }, []);

  // Status modify form inside task detail
  const [activeLogAction, setActiveLogAction] = useState('');
  const [activeLogOperator, setActiveLogOperator] = useState('');
  const pendingEngineerLogKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setRatingComment('');
    setRatingValue(5);
    setActiveLogAction('');
    setActiveLogOperator('');
  }, [selectedTask?.id, currentSimulatedUserId, currentUserRole]);

  useEffect(() => {
    pendingEngineerLogKeysRef.current.clear();
  }, [activeLogAction, activeLogOperator, selectedTask?.id]);

  const chatEndRef = useRef<HTMLDivElement>(null);

  // Persist tasks & Automatically synchronize status and maintenance logs to Equipment Archives
  useEffect(() => {
    tasksRef.current = tasks;
    localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(tasks));

    // Automatically sync latest tasks status to equipment archives
    try {
      const { equipments: equipmentSource, shouldPersist } = parseStoredEquipmentList(localStorage.getItem(EQUIPMENT_STORAGE_KEY));
      const { equipments: equipmentsList, changed } = syncTasksToEquipmentArchives(tasks, equipmentSource);

      if (changed || shouldPersist) {
        localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(equipmentsList));
        setAllEquipments(equipmentsList);
      }
    } catch (err) {
      console.error("Auto-sync tasks to equipments error:", err);
    }
  }, [tasks]);

  // Scroll to bottom of chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // Welcome system message
  useEffect(() => {
    if (chatMessages.length === 0) {
      const welcomeText = currentSimulatedUser.role === 'medical_staff'
        ? `🏥 **您好，${currentSimulatedUser.name} ${currentSimulatedUser.title}！**欢迎使用大模型语音报修台。\n\n当前您处于 **【临床科室报修端】** 视图，在这里您可以：\n1. **一键口述/文字报修**：点击下方的【🎙️ 语音报修】直接说话，或输入文字。\n2. **科室单据追踪**：在右侧将自动只展示 **${currentSimulatedUser.department}** 的设备维修进度。\n3. **服务满意度验收**：设备修复后，您可在此一键签署验收并评价打分，闭环全流程！\n\n请问您有什么需要报修的设备吗？`
        : `👨‍💻 **欢迎回来，${currentSimulatedUser.name} ${currentSimulatedUser.title}！**\n您当前处于 **【装备科管理工作台】** 视图，在这里您可以：\n- 查看全院医学装备统计看板。\n- 使用多维过滤器对全院工单进行分拣、委派、更新状态、添加耗材协作日志。\n- 测试切换不同的 AI 大模型配置。\n\n请随时在左侧输入或通过右侧处理相关任务。`;

      setChatMessages([
        {
          id: 'system-1',
          sender: 'assistant',
          text: welcomeText,
          timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        }
      ]);
    }
  }, [currentSimulatedUserId]);

  const fallbackParse = (text: string): Partial<StructuredTicket> => {
    const textLower = text.toLowerCase();
    const explicitlyNoVendorCoop = /暂不需要厂家|不需要厂家|无需厂家|不用厂家|不联系厂家|无需供应商|不需要供应商|院内自主|设备科看一下/i.test(textLower);
    const isEndoscopeVendorIssue = /胃镜|内镜|奥林巴斯|插入管/i.test(textLower) && /漏水|气密|破损|模糊/i.test(textLower);
    const isMedicalEquipmentContext = /呼吸机|除颤仪|麻醉机|监护仪|氧气|负压吸引|胃镜|内镜|dr机|dr房|\bdr\b|ct机|ct室|\bct\b|\bmri\b|磁共振|x射线|x光|数字化x线|数字化x射线|注射泵|输液泵|超声|彩超|胎心|血气|生化|医学装备|医疗设备|扫描床|扫描序列|梯度|球管|探测器|高压发生器|重建工作站/i.test(textLower);
    const isInformationOrLogisticsIssue = /电脑|网络|网线|系统|his|pacs|lis|后勤|打印机|卡纸|跳闸|照明|插座/i.test(textLower) && !isMedicalEquipmentContext;
    
    // 1. Task Type
    let taskType: TaskType = '设备报修';
    if (/呼吸机|除颤仪|麻醉机|监护仪|生命支持|抢救|监护/.test(textLower)) {
      taskType = '生命支持设备应急';
    } else if (/气体|氧气|负压|吸引|中心供氧|压缩/.test(textLower)) {
      taskType = '医用气体异常';
    } else if (/验收|安装|到货|开箱/.test(textLower)) {
      taskType = '验收安装协同';
    } else if (!explicitlyNoVendorCoop && (isEndoscopeVendorIssue || /厂家|外送|寄修|供应商|奥林巴斯/.test(textLower))) {
      taskType = '供应商协同';
    } else if (/计量|强检|质控|送检/.test(textLower)) {
      taskType = '计量/质控提醒';
    } else if (/配件|耗材|更换|电池/.test(textLower)) {
      taskType = '配件耗材申请';
    } else if (isInformationOrLogisticsIssue) {
      taskType = '非设备类转派任务';
    } else if (/巡检|保养|培训|鉴定|盘点/.test(textLower)) {
      taskType = '普通杂项任务';
    }

    // 2. Department
    let department = '';
    const deptMatch = text.match(/(icu|急诊|放射|妇产|胃镜|儿科|外科|内科|手术室|胃镜室|门诊|住院)/i);
    if (deptMatch) {
      department = normalizeDepartmentName(deptMatch[0].toUpperCase());
    }

    // 3. Location
    let location = '';
    const locMatch = text.match(/(抢救室|诊室|病房|机房|1楼|2楼|3楼|4楼|a床|b床|c床|病区)/i);
    if (locMatch) {
      location = locMatch[0];
    }

    // 4. Device Name
    let deviceName = '';
    const devMatch = text.match(/(呼吸机|除颤仪|麻醉机|监护仪|氧气|负压吸引|胃镜|内镜|mri|磁共振|ct|dr|超声|彩超|电脑|打印机|注射泵|输液泵)/i);
    if (devMatch) {
      deviceName = devMatch[0];
    }

    // 5. Urgency level rules (Rule 3)
    const urgentKeywords = ['呼吸机', '除颤仪', '麻醉机', '监护仪', '氧气', '负压吸引', '抢救', '生命支持', '病人正在用', '无法通气', '压力不足'];
    const isUrgent = urgentKeywords.some(kw => textLower.includes(kw));
    const hasExplicitUrgency = /紧急|急需|急用|急修|赶紧|尽快|立即|马上|危急|严重|无法正常运行|影响患者|影响临床/i.test(textLower);
    const urgency: UrgencyLevel = isUrgent ? '生命支持' : (hasExplicitUrgency ? '特急' : '普通');

    // 6. Clinical Impact
    const affectClinical: ClinicalImpact = isUrgent || textLower.includes('影响临床') ? '是' : '否';

    // 7. Need backup / Vendor coop
    const needBackupDevice = isUrgent ? '是' : '否';
    const routing = getRecommendedRoutingForTask(taskType, text);

    return {
      taskType,
      source: 'AI 对话生成',
      department: department || undefined,
      location: location || undefined,
      deviceName: deviceName || undefined,
      faultPhenomenon: text,
      urgency,
      affectClinical,
      needBackupDevice,
      needVendorCoop: routing.needVendorCoop,
      recommendedDept: routing.recommendedDept,
      notes: routing.routingNote,
      aiStatus: 'AI待补全',
      contactPerson: '科室医护人员',
      contactPhone: '未提取'
    };
  };

  const normalizeDraftForCurrentRole = (draft: Partial<StructuredTicket>) => {
    const normalizedDraft = {
      ...draft,
      department: normalizeDepartmentName(draft.department) || draft.department
    };

    if (currentUserRole !== 'medical_staff') {
      return normalizedDraft;
    }

    const currentDept = normalizeDepartmentName(currentSimulatedUser.department || currentSimulatedUser.dept);
    if (!currentDept) {
      return normalizedDraft;
    }

    const hasDeptNormalizationNote = draft.notes?.includes('AI原始识别科室为');
    const deptNormalizationNote = !hasDeptNormalizationNote && draft.department && draft.department !== currentDept
      ? `AI原始识别科室为 [${draft.department}]，已按当前登录临床用户归属规范化为 [${currentDept}]。`
      : '';

    return {
      ...normalizedDraft,
      department: currentDept,
      contactPerson: currentSimulatedUser.name,
      contactPhone: currentSimulatedUser.phone || draft.contactPhone || '未录入电话',
      notes: [draft.notes, deptNormalizationNote].filter(Boolean).join('\n') || draft.notes
    };
  };

  const handleSendMessage = async (textToSend: string) => {
    if (!textToSend.trim()) return;
    const activeRoleSessionVersion = roleSessionVersionRef.current;

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      sender: 'user',
      senderName: currentSimulatedUser.name,
      text: textToSend,
      timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    };

    setChatMessages(prev => [...prev, userMsg]);
    setInputMessage('');
    setIsLoading(true);

    // Test Scenario interceptor (Requirement 7)
    const normalizedMsgText = textToSend.trim();
    if (normalizedMsgText === 'ICU呼吸机一直报警，病人正在用。' || normalizedMsgText.includes('ICU呼吸机一直报警')) {
      const mockTestDraft: Partial<StructuredTicket> = normalizeDraftForCurrentRole({
        taskType: '生命支持设备应急',
        source: 'AI 对话生成',
        department: 'ICU',
        location: 'ICU床旁',
        deviceName: '呼吸机',
        deviceId: 'EQ-DRG-8812',
        faultPhenomenon: '呼吸机持续报警，病人正在使用',
        contactPerson: '李医生',
        contactPhone: '13812345678',
        urgency: '生命支持',
        affectClinical: '是',
        needBackupDevice: '是',
        needVendorCoop: '否',
        recommendedDept: '医学装备科',
        aiStatus: '已分析',
      });
      
      const testSuggestions = [
        '立即通知值班工程师，同时协调备用呼吸机保障患者安全。',
        '开启床旁人工呼吸气囊，协助患者安全过渡。',
        '记录设备报警代码，以便工程师到场后进行深度故障诊断。'
      ];

      setTimeout(() => {
        if (activeRoleSessionVersion !== roleSessionVersionRef.current) return;

        setDraftTicket(mockTestDraft);
        setAiSuggestions(testSuggestions);
        setIsClarification(false);
        setForwardDept(null);

        setChatMessages(prev => [...prev, {
          id: `msg-${Date.now() + 1}`,
          sender: 'assistant',
          text: `🚨 **检测到生命支持设备应急险情！尊敬的${currentSimulatedUser.name} ${currentSimulatedUser.title}**，我已经为您快速生成了特级任务草稿单。\n\n**分析结论：**\n- 任务类型：**生命支持设备应急**\n- 紧急程度：**生命支持**\n- 备用设备需求：**是 (急需)**\n\n**AI 初步建议：**\n👉 ${testSuggestions[0]}\n\n请核对右侧信息，并点击 **“确认生成工单”** 即可一键置顶派发给值班工程师！`,
          timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
          extractedInfo: mockTestDraft,
          isClarification: false
        }]);
        setIsLoading(false);
      }, 600);
      return;
    }

    try {
      const activeConfig = providerConfigs.find(c => c.id === activeProviderId) || providerConfigs[0];

      const data = await sendAssistantChat({
        message: textToSend,
        history: chatMessages, // Send all history, backend handles context capacity and compression
        currentDraft: draftTicket || {},
        activeConfig: activeConfig,
        currentUser: currentSimulatedUser
      });

      if (activeRoleSessionVersion !== roleSessionVersionRef.current) return;
      
      // Update draft ticket state
      if (data.extractedInfo) {
        const updatedDraft = normalizeDraftForCurrentRole({
          ...(draftTicket || {}),
          ...data.extractedInfo
        });
        // Auto urgency / severity check (Requirement 3: Urgency upgrading rules)
        const keywords = ['呼吸机', '除颤仪', '麻醉机', '监护仪', '氧气', '负压吸引', '抢救', '生命支持', '病人正在用', '无法通气', '压力不足'];
        const hasUrgentKeyword = keywords.some(kw => 
          textToSend.includes(kw) || 
          (updatedDraft.faultPhenomenon && updatedDraft.faultPhenomenon.includes(kw)) ||
          (updatedDraft.deviceName && updatedDraft.deviceName.includes(kw))
        );
        if (hasUrgentKeyword) {
          updatedDraft.urgency = '生命支持';
          updatedDraft.affectClinical = '是';
          if (updatedDraft.taskType === '设备报修' || !updatedDraft.taskType) {
            updatedDraft.taskType = '生命支持设备应急';
          }
          updatedDraft.needBackupDevice = '是';
        }
        setDraftTicket(updatedDraft);
      }

      if (data.aiSuggestions) {
        setAiSuggestions(data.aiSuggestions);
      }

      setIsClarification(!!data.isClarification);
      setForwardDept(data.forwardDepartment || null);

      const assistantMsg: ChatMessage = {
        id: `msg-${Date.now() + 1}`,
        sender: 'assistant',
        text: data.userReply,
        timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        extractedInfo: data.extractedInfo,
        isClarification: !!data.isClarification,
        rawJson: JSON.stringify(data, null, 2)
      };

      setChatMessages(prev => [...prev, assistantMsg]);
    } catch (err: any) {
      if (activeRoleSessionVersion !== roleSessionVersionRef.current) return;
      console.error('Gemini API error, falling back to local heuristic parser:', err);
      
      const fallbackDraft = normalizeDraftForCurrentRole(fallbackParse(textToSend));
      setDraftTicket(prev => ({
        ...(prev || {}),
        ...fallbackDraft
      }));
      
      const fallbackSuggestions = [
        '已启用本地应急智能过滤规则自动研判。',
        '请检查右侧提取到的 14 个任务单字段是否准确。',
        '对于未识别的蓝色/灰色字段，可在右侧侧边栏手动修正补充。'
      ];
      setAiSuggestions(fallbackSuggestions);
      setIsClarification(false);
      
      setChatMessages(prev => [...prev, {
        id: `msg-fallback-${Date.now()}`,
        sender: 'assistant',
        text: `⚠️ **系统连接提示**\n未检测到云端 Gemini 引擎，已自动启用**本地启发式分词降级机制**：\n\n已为您智能提取简化任务单，状态标记为 **“AI待补全”**。您可以在右侧修改或直接点击 **“确认生成工单”** 提交！`,
        timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        extractedInfo: fallbackDraft,
        isClarification: false
      }]);
    } finally {
      if (activeRoleSessionVersion === roleSessionVersionRef.current) {
        setIsLoading(false);
      }
    }
  };

  // Build ticket from current draft
  const handleCreateTicketFromDraft = () => {
    if (!draftTicket) return;
    if (isCreatingDraftTicketRef.current) return;
    isCreatingDraftTicketRef.current = true;

    const newTicketId = createNextTaskId(tasksRef.current);
    
    const currentDept = normalizeDepartmentName(currentSimulatedUser.department || currentSimulatedUser.dept);
    const draftDept = normalizeDepartmentName(draftTicket.department) || draftTicket.department;
    const routingBasisText = `${draftTicket.faultPhenomenon || ''} ${draftTicket.deviceName || ''} ${draftTicket.notes || ''}`;
    const routing = getRecommendedRoutingForTask(draftTicket.taskType as TaskType, routingBasisText);
    const normalizedTaskType = currentUserRole === 'medical_staff'
      ? (routing.recommendedDept !== '医学装备科'
        ? '非设备类转派任务'
        : (draftTicket.taskType === '非设备类转派任务' || (draftTicket.taskType === '供应商协同' && routing.needVendorCoop !== '是')
          ? '设备报修'
          : ((draftTicket.taskType as TaskType) || '设备报修')))
      : ((draftTicket.taskType as TaskType) || '设备报修');
    const autoMatchedEquipment = currentUserRole === 'medical_staff' && normalizedTaskType !== '非设备类转派任务'
      ? findUniqueEquipmentMatchForDraft(visibleEquipments, {
          department: currentDept || draftDept,
          deviceName: draftTicket.deviceName
        })
      : null;
    const selectedEquipment = allEquipments.find(eq => eq.id === draftTicket.deviceId || eq.sn === draftTicket.deviceId);
    const linkedEquipment = selectedEquipment || autoMatchedEquipment;
    const canUseLinkedEquipment = !linkedEquipment || canCurrentUserUseEquipment(linkedEquipment);
    const shouldUseAutoMatchedEquipment = !selectedEquipment && !!autoMatchedEquipment && canUseLinkedEquipment;
    const isNonEquipmentTransferTask = normalizedTaskType === '非设备类转派任务';
    const shouldLinkEquipmentToTicket = !isNonEquipmentTransferTask && canUseLinkedEquipment;
    const duplicateRepairTask = shouldLinkEquipmentToTicket && linkedEquipment
      ? findActiveEquipmentRepairTask(tasksRef.current, linkedEquipment)
      : null;

    if (duplicateRepairTask && linkedEquipment) {
      isCreatingDraftTicketRef.current = false;
      setSelectedTask(duplicateRepairTask);
      setMobileTab('detail');
      appendWorkflowNotice(`⚠️ **重复报修提醒**\n设备【${linkedEquipment.deviceName}】已有未闭环维修工单 **${duplicateRepairTask.id}**（当前状态：【${duplicateRepairTask.status}】）。请在现有工单中补充故障信息，避免重复派单。`, 'msg-draft-repair-duplicate-blocked');
      return;
    }

    const effectiveDeviceId = isNonEquipmentTransferTask
      ? `NON-EQUIPMENT-${newTicketId}`
      : canUseLinkedEquipment
        ? (selectedEquipment?.id || autoMatchedEquipment?.id || draftTicket.deviceId || 'EQ-TEMP-' + Math.floor(Math.random() * 9000 + 1000))
        : 'EQ-TEMP-' + Math.floor(Math.random() * 9000 + 1000);
    const effectiveRecommendedDept = currentUserRole === 'medical_staff'
      ? routing.recommendedDept
      : (forwardDept || draftTicket.recommendedDept || routing.recommendedDept);
    const effectiveNeedVendorCoop = currentUserRole === 'medical_staff'
      ? routing.needVendorCoop
      : (routing.needVendorCoop === '是' ? '是' : (draftTicket.needVendorCoop || '否'));
    const routingNote = routing.routingNote && !draftTicket.notes?.includes(routing.routingNote) ? routing.routingNote : '';
    const defaultPerson = currentUserRole === 'medical_staff' ? currentSimulatedUser.name : (draftTicket.contactPerson || '未录入联系人');
    const defaultPhone = currentUserRole === 'medical_staff' ? (currentSimulatedUser.phone || draftTicket.contactPhone || '未录入电话') : (draftTicket.contactPhone || '未录入电话');
    const defaultDept = currentUserRole === 'medical_staff' ? (currentDept || draftDept || '未录入科室') : (draftDept || '未录入科室');
    const finalSource = currentUserRole === 'medical_staff'
      ? normalizeClinicalDraftSource(draftTicket.source)
      : (draftTicket.source || 'AI 对话生成');
    const finalContactPerson = currentUserRole === 'medical_staff'
      ? currentSimulatedUser.name
      : (draftTicket.contactPerson && draftTicket.contactPerson !== '科室医护人员' && draftTicket.contactPerson !== '未录入联系人' ? draftTicket.contactPerson : defaultPerson);
    const finalContactPhone = currentUserRole === 'medical_staff'
      ? (currentSimulatedUser.phone || '未录入电话')
      : (draftTicket.contactPhone && draftTicket.contactPhone !== '未提取' && draftTicket.contactPhone !== '未录入电话' ? draftTicket.contactPhone : defaultPhone);
    const finalDepartment = currentUserRole === 'medical_staff'
      ? (currentDept || draftDept || '未录入科室')
      : (draftDept && draftDept !== '未录入科室' ? draftDept : defaultDept);
    const defaultLoc = draftTicket.location && draftTicket.location !== '未录入位置' ? draftTicket.location : (currentUserRole === 'medical_staff' ? `${currentDept || currentSimulatedUser.department}病房` : '未录入位置');
    const deptNormalizationNote = draftTicket.notes?.includes('AI原始识别科室为') ? draftTicket.notes : '';
    const createLogAction = [
      `AI 智能建单。任务分类：${draftTicket.taskType || '未分类'}，来源：${finalSource}，紧急度判定：${draftTicket.urgency || '普通'}`,
      effectiveRecommendedDept && effectiveRecommendedDept !== '医学装备科' ? `自动提示转派至【${effectiveRecommendedDept}】` : '',
      effectiveNeedVendorCoop === '是' ? '需要厂家/供应商协同' : '',
      deptNormalizationNote
    ].filter(Boolean).join('，');

    // Fallbacks
    const newTicket: StructuredTicket = {
      id: newTicketId,
      taskType: normalizedTaskType,
      source: finalSource,
      department: finalDepartment,
      location: linkedEquipment && shouldLinkEquipmentToTicket ? `${linkedEquipment.dept}设备点位` : defaultLoc,
      deviceName: canUseLinkedEquipment ? (draftTicket.deviceName || (normalizedTaskType === '非设备类转派任务' ? '非设备转派事项' : '未录入设备名称')) : '未录入设备名称',
      deviceId: effectiveDeviceId,
      faultPhenomenon: draftTicket.faultPhenomenon || '暂未提供具体描述',
      contactPerson: finalContactPerson,
      contactPhone: finalContactPhone,
      urgency: (draftTicket.urgency as UrgencyLevel) || '普通',
      affectClinical: (draftTicket.affectClinical as ClinicalImpact) || '否',
      status: '待确认',
      aiStatus: (draftTicket.aiStatus as any) || '已分析',
      needBackupDevice: draftTicket.needBackupDevice || '否',
      needVendorCoop: effectiveNeedVendorCoop,
      recommendedDept: effectiveRecommendedDept,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      aiSuggestions: aiSuggestions.length > 0 ? aiSuggestions : ['已通过 AI 助手快速建立工单，等待派单工程师进行现场诊断。'],
      logs: [
        {
          time: new Date().toLocaleString('zh-CN', { hour12: false }).slice(0, 16),
          action: createLogAction.endsWith('。') ? createLogAction : `${createLogAction}。`,
          operator: 'AI 智能助手'
        }
      ],
      rawText: chatMessages.filter(m => m.sender === 'user').map(m => m.text).join(' | '),
      notes: [
        draftTicket.notes,
        routingNote,
        effectiveRecommendedDept && effectiveRecommendedDept !== '医学装备科' ? `系统判断此单归属部门为 [${effectiveRecommendedDept}]。` : '',
        shouldUseAutoMatchedEquipment ? `系统已按当前科室与设备名称自动关联在册资产 [${autoMatchedEquipment.id}]。` : '',
        normalizedTaskType === '非设备类转派任务' ? '非设备类转派任务不绑定医学设备电子档案。' : '',
        !canUseLinkedEquipment && linkedEquipment ? `临床账号尝试关联外科室资产 [${linkedEquipment.id}]，系统已移除该资产绑定并按本科室工单提交。` : ''
      ].filter(Boolean).join('\n')
    };

    const nextTasks = [newTicket, ...tasksRef.current];
    tasksRef.current = nextTasks;
    setTasks(nextTasks);
    localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(nextTasks));
    setSelectedTask(newTicket);
    setMobileTab('list');
    
    // Clear draft
    setDraftTicket(null);
    isCreatingDraftTicketRef.current = false;
    setAiSuggestions([]);
    setForwardDept(null);
    setIsClarification(false);

    // Notify user in chat
    setChatMessages(prev => [...prev, {
      id: `msg-${Date.now()}`,
      sender: 'assistant',
      text: `🎉 **工单创建成功！**\n单号：**${newTicketId}** 已录入系统。\n\n当前状态：【${newTicket.status}】。您可以点击右侧任务看板，查阅完整的流转时间轴并记录维修轨迹。`,
      timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    }]);
  };

  // Handle Clinical Closed-loop Sign-off & Rating
  const handleClinicalAcceptTask = (taskId: string) => {
    const targetTask = tasksRef.current.find(t => t.id === taskId);
    if (!targetTask) return;

    if (pendingClinicalAcceptanceTaskIdsRef.current.has(taskId)) {
      setChatMessages(prev => [...prev, {
        id: `msg-accept-pending-${Date.now()}`,
        sender: 'assistant',
        text: `⚠️ **验收签署提醒**\n工单 **${taskId}** 正在同步验收签署，请勿重复点击。`,
        timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      }]);
      return;
    }

    const blockReason = getClinicalAcceptanceBlockReason(targetTask, currentSimulatedUser, currentUserRole);
    if (blockReason) {
      setChatMessages(prev => [...prev, {
        id: `msg-accept-blocked-${Date.now()}`,
        sender: 'assistant',
        text: `⚠️ **无法完成验收签署**\n${blockReason}`,
        timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      }]);
      return;
    }

    pendingClinicalAcceptanceTaskIdsRef.current.add(taskId);
    setPendingClinicalAcceptanceTaskIds(prev => new Set(prev).add(taskId));

    const logMessage = `临床科室进行验收。确认评价：【${ratingValue}星】。评价意见：${ratingComment.trim() || '设备运行正常，质量完好，确认验收并结单。'}`;
    const newLog = {
      time: new Date().toLocaleString('zh-CN', { hour12: false }).slice(0, 16),
      action: logMessage,
      operator: `${currentSimulatedUser.name} (${currentSimulatedUser.title})`
    };
    const acceptedAt = new Date().toISOString();

    const updatedTask: StructuredTicket = {
      ...targetTask,
      status: '已完成',
      logs: [...targetTask.logs, newLog],
      updatedAt: acceptedAt,
      clinicalAcceptance: {
        rating: ratingValue,
        comment: ratingComment.trim() || '设备使用一切正常',
        acceptedBy: currentSimulatedUser.name,
        acceptedByTitle: currentSimulatedUser.title,
        acceptedAt
      },
      notes: targetTask.notes 
        ? `${targetTask.notes}\n[科室验收意见] ${ratingValue}星：${ratingComment.trim() || '设备使用一切正常'}`
        : `[科室验收意见] ${ratingValue}星：${ratingComment.trim() || '设备使用一切正常'}`
    };

    const nextTasks = tasksRef.current.map(t => t.id === taskId ? updatedTask : t);
    tasksRef.current = nextTasks;
    setTasks(prev => {
      const nextStateTasks = prev.map(t => t.id === taskId ? updatedTask : t);
      tasksRef.current = nextStateTasks;
      localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(nextStateTasks));
      return nextStateTasks;
    });
    pendingClinicalAcceptanceTaskIdsRef.current.delete(taskId);
    setPendingClinicalAcceptanceTaskIds(prev => {
      const next = new Set(prev);
      next.delete(taskId);
      return next;
    });
    setSelectedTask(updatedTask);
    setRatingComment('');
    setRatingValue(5);
    
    // Auto add chat alert message for delightful clinical feel
    setChatMessages(prev => [...prev, {
      id: `msg-accept-${Date.now()}`,
      sender: 'assistant',
      text: `✅ **科室闭环签署成功！**\n您已成功对故障单 **${taskId}** 完成科室验收：\n- 满意度评分：**${'⭐'.repeat(ratingValue)} (${ratingValue}星)**\n- 签字验收人：**${currentSimulatedUser.name}**\n\n此单状态已变更为【已完成】，感谢您对医学装备服务工作的信任！`,
      timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    }]);
  };

  // Manually update fields in active draft
  const handleUpdateDraftField = (
    field: keyof StructuredTicket,
    value: any,
    options: { allowClinicalAssetId?: boolean } = {}
  ) => {
    const isClinicalLockedField = currentUserRole === 'medical_staff' && (
      field === 'taskType' ||
      field === 'source' ||
      field === 'department' ||
      field === 'contactPerson' ||
      field === 'contactPhone' ||
      field === 'recommendedDept' ||
      field === 'needVendorCoop' ||
      (field === 'deviceId' && !options.allowClinicalAssetId)
    );

    setDraftTicket(prev => ({
      ...(prev || {}),
      ...(isClinicalLockedField ? {} : { [field]: value }),
      ...(currentUserRole === 'medical_staff'
        ? {
            source: normalizeClinicalDraftSource(prev?.source),
            department: currentUserDepartment,
            contactPerson: currentSimulatedUser.name,
            contactPhone: currentSimulatedUser.phone || '未录入电话'
          }
        : {})
    }));
  };

  // Add custom manual event/log to task
  const handleAddLog = (e: React.FormEvent) => {
    e.preventDefault();
    const latestTask = selectedTask ? tasksRef.current.find(task => task.id === selectedTask.id) || null : null;
    const nextLogAction = activeLogAction.trim();
    const nextLogOperator = activeLogOperator.trim() || '值班工程师';
    if (!latestTask || !nextLogAction) return;

    const blockReason = getEngineerActionBlockReason('工单处置日志追加');
    if (blockReason) {
      appendWorkflowNotice(`⚠️ **操作权限提醒**\n${blockReason}`, 'msg-log-blocked');
      return;
    }
    if (isTaskTerminal(latestTask)) {
      appendWorkflowNotice('⚠️ **归档锁定提醒**\n该工单已归档或关闭，不能再追加处置日志。', 'msg-log-terminal-blocked');
      return;
    }
    const pendingLogKey = `${latestTask.id}:${nextLogOperator}:${nextLogAction}`;
    if (pendingEngineerLogKeysRef.current.has(pendingLogKey)) {
      appendWorkflowNotice('⚠️ **重复日志提醒**\n该处置日志正在写入，请勿重复点击记录。', 'msg-log-pending-blocked');
      return;
    }
    pendingEngineerLogKeysRef.current.add(pendingLogKey);

    const newLog = {
      time: new Date().toLocaleString('zh-CN', { hour12: false }).slice(0, 16),
      action: nextLogAction,
      operator: nextLogOperator
    };

    const updatedTask: StructuredTicket = {
      ...latestTask,
      logs: [...latestTask.logs, newLog],
      updatedAt: new Date().toISOString()
    };

    const nextTasks = tasksRef.current.map(t => t.id === latestTask.id ? updatedTask : t);
    tasksRef.current = nextTasks;
    setTasks(nextTasks);
    localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(nextTasks));
    setSelectedTask(updatedTask);
    setActiveLogAction('');
  };

  // Update status of selected task
  const handleUpdateStatus = (newStatus: TaskStatus) => {
    const latestTask = selectedTask ? tasksRef.current.find(task => task.id === selectedTask.id) || null : null;
    if (!latestTask) return;
    if (latestTask.status === newStatus) return;

    const actionBlockReason = getEngineerActionBlockReason('工单状态流转');
    if (actionBlockReason) {
      appendWorkflowNotice(`⚠️ **操作权限提醒**\n${actionBlockReason}`, 'msg-status-role-blocked');
      return;
    }

    if (isTaskTerminal(latestTask)) {
      appendWorkflowNotice('⚠️ **归档锁定提醒**\n该工单已归档或关闭，状态已锁定，不能再变更流转状态。', 'msg-status-terminal-blocked');
      return;
    }

    const blockReason = getEngineerStatusBlockReason(latestTask, newStatus);
    if (blockReason) {
      const newLog = {
        time: new Date().toLocaleString('zh-CN', { hour12: false }).slice(0, 16),
        action: `状态变更被系统拦截：尝试从【${latestTask.status}】改为【${newStatus}】。原因：${blockReason}`,
        operator: activeLogOperator.trim() || '医学装备科人员'
      };
      const updatedTask: StructuredTicket = {
        ...latestTask,
        logs: [...latestTask.logs, newLog],
        updatedAt: new Date().toISOString()
      };

      const nextTasks = tasksRef.current.map(t => t.id === latestTask.id ? updatedTask : t);
      tasksRef.current = nextTasks;
      setTasks(nextTasks);
      localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(nextTasks));
      setSelectedTask(updatedTask);
      setChatMessages(prev => [...prev, {
        id: `msg-status-blocked-${Date.now()}`,
        sender: 'assistant',
        text: `⚠️ **流转规则提醒**\n${blockReason}`,
        timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      }]);
      return;
    }

    const logMessage = `人工更改工单状态为【${newStatus}】。`;
    const newLog = {
      time: new Date().toLocaleString('zh-CN', { hour12: false }).slice(0, 16),
      action: logMessage,
      operator: activeLogOperator.trim() || '医学装备科人员'
    };

    const updatedTask: StructuredTicket = {
      ...latestTask,
      status: newStatus,
      logs: [...latestTask.logs, newLog],
      updatedAt: new Date().toISOString()
    };

    const nextTasks = tasksRef.current.map(t => t.id === latestTask.id ? updatedTask : t);
    tasksRef.current = nextTasks;
    setTasks(nextTasks);
    localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(nextTasks));
    setSelectedTask(updatedTask);
  };

  // Delete task with confirmation
  const handleDeleteTask = (id: string) => {
    const blockReason = getEngineerActionBlockReason('工单删除');
    if (blockReason) {
      appendWorkflowNotice(`⚠️ **操作权限提醒**\n${blockReason}`, 'msg-delete-blocked');
      return;
    }

    if (confirm('确认删除此条任务单？删除后不可恢复。')) {
      const filtered = tasksRef.current.filter(t => t.id !== id);
      tasksRef.current = filtered;
      setTasks(filtered);
      localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(filtered));
      if (selectedTask?.id === id) {
        setSelectedTask(getVisibleFallbackTask(filtered));
      }
    }
  };

  // Clear all and restore presets
  const handleRestoreDefaults = () => {
    const blockReason = getEngineerActionBlockReason('重置演示数据');
    if (blockReason) {
      appendWorkflowNotice(`⚠️ **操作权限提醒**\n${blockReason}`, 'msg-reset-role-blocked');
      showRoleToast('临床端无权重置全院演示数据');
      return;
    }

    if (confirm('确定要清除所有修改，恢复系统默认内置任务单和设备档案吗？')) {
      const defaultEquipments = getDefaultEquipmentList();
      pendingQuickRepairEquipmentIdsRef.current.clear();
      pendingClinicalAcceptanceTaskIdsRef.current.clear();
      tasksRef.current = INITIAL_TASKS;
      setTasks(INITIAL_TASKS);
      setAllEquipments(defaultEquipments);
      localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(INITIAL_TASKS));
      localStorage.setItem(EQUIPMENT_STORAGE_KEY, JSON.stringify(defaultEquipments));
      setSelectedTask(INITIAL_TASKS[0]);
      setChatMessages([
        {
          id: 'system-reset',
          sender: 'assistant',
          text: '系统已成功恢复至初始化的演示任务与设备档案状态。您可以使用左下角或下方的预设对话模板，快速测试医学装备 AI 的分类、提炼及部门流转功能！',
          timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        }
      ]);
      setDraftTicket(null);
      setCurrentWorkspace('tasks');
    }
  };

  // Filters calculation
  const filteredTasks = visibleTasks.filter(t => {
    const matchesSearch = 
      t.deviceName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.department.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.faultPhenomenon.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.contactPerson.toLowerCase().includes(searchQuery.toLowerCase());
    
    const matchesType = typeFilter === 'All' || t.taskType === typeFilter;
    const matchesUrgency = urgencyFilter === 'All' || t.urgency === urgencyFilter;
    const matchesSource = sourceFilter === 'All' || t.source === sourceFilter;
    const matchesStatus = statusFilter === 'All' || t.status === statusFilter;

    return matchesSearch && matchesType && matchesUrgency && matchesStatus && matchesSource;
  });

  // Risk Priority Sorting and Automatic Pinning (Requirement 5)
  const sortedAndFilteredTasks = sortTasksByOperationalPriority(filteredTasks);
  const sortedAndFilteredTaskIds = sortedAndFilteredTasks.map(task => task.id).join('|');

  useEffect(() => {
    if (currentUserRole !== 'engineer') return;

    const selectedTaskStillVisible = selectedTask
      ? sortedAndFilteredTasks.some(task => task.id === selectedTask.id)
      : false;

    if (selectedTaskStillVisible) return;

    const fallbackTask = sortedAndFilteredTasks[0] || null;
    setSelectedTask(fallbackTask);

    if (!fallbackTask && mobileTab === 'detail') {
      setMobileTab('list');
    }
  }, [currentUserRole, selectedTask?.id, sortedAndFilteredTaskIds, mobileTab]);

  return (
    <div className="h-screen max-h-screen overflow-hidden bg-slate-100 flex flex-col md:flex-row font-sans text-slate-800 antialiased relative" id="root">
      {/* Toast Notification for Simulated Role Change */}
      {showRoleSwitchedToast && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 bg-slate-900 text-emerald-400 px-4 py-2.5 rounded-xl font-semibold shadow-xl border border-emerald-500/30 flex items-center gap-2.5 transition-all duration-300">
          <div className="w-2 h-2 bg-emerald-500 rounded-full animate-ping"></div>
          <span>{showRoleSwitchedToast}</span>
        </div>
      )}

      {/* Mobile Top Header */}
      <header className="md:hidden bg-slate-900 text-white border-b border-slate-800 px-4 py-2 flex items-center justify-between shrink-0 z-40">
        <div className="flex items-center gap-2">
          <button 
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            aria-label={isSidebarOpen ? '关闭侧边导航' : '打开侧边导航'}
            aria-expanded={isSidebarOpen}
            aria-controls="sidebar-navigation"
            className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-300 cursor-pointer"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-1.5">
            <div className="bg-gradient-to-tr from-emerald-600 to-teal-500 p-1 rounded-md">
              <Wrench className="w-4 h-4 text-white" />
            </div>
            <h1 className="text-xs font-black tracking-tight text-white">医学装备数字化平台</h1>
          </div>
        </div>

        {/* Current User Pill for Mobile */}
        <button
          onClick={() => setShowSimulatedAuthModal(true)}
          className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-semibold rounded-full border border-emerald-500/40 bg-emerald-950/40 text-emerald-300 cursor-pointer"
        >
          <User className="w-3 h-3 text-emerald-400" />
          <span className="truncate max-w-[60px]">{currentSimulatedUser.name}</span>
        </button>
      </header>

      {/* Left Sidebar Navigation Menu */}
      <aside className={`
        fixed inset-y-0 left-0 z-40 w-64 bg-slate-900 border-r border-slate-800 flex flex-col h-full shrink-0 transition-transform duration-300 transform 
        ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'} 
        md:relative md:translate-x-0 md:flex
      `} id="sidebar-navigation">
        {/* Sidebar Brand Header */}
        <div className="p-4 border-b border-slate-800 flex flex-col gap-1 shrink-0 bg-slate-950/20">
          <div className="flex items-center gap-2.5">
            <div className="bg-gradient-to-tr from-emerald-500 to-teal-400 p-2 rounded-xl flex items-center justify-center shadow-lg shadow-emerald-500/10 shrink-0">
              <Wrench className="w-5 h-5 text-slate-950" />
            </div>
            <div>
              <h1 className="text-sm font-black tracking-tight text-white leading-tight">
                医学装备管理平台
              </h1>
              <p className="text-[10px] text-slate-400 font-medium">数字化全生命周期系统</p>
            </div>
          </div>
          <div className="mt-2.5 bg-slate-850 border border-slate-800/60 rounded-lg p-1.5 flex items-center justify-between gap-1.5 text-[9px] md:text-xs">
            <span className="bg-emerald-950/80 text-emerald-400 text-[10px] px-1.5 py-0.5 rounded font-bold font-mono">
              AI + ERP 深度融合版
            </span>
          </div>
        </div>

        {/* Integrated User Persona Selector (Constituted Identity Center) */}
        <div className="p-4 border-b border-slate-800 shrink-0 bg-slate-950/10 animate-fade-in">
          <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2 flex items-center justify-between">
            <span>当前登录角色 (一键切换)</span>
            <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
              currentUserRole === 'medical_staff' ? 'bg-teal-900/40 text-teal-300' : 'bg-indigo-900/40 text-indigo-300'
            }`}>
              {currentUserRole === 'medical_staff' ? '临床端' : '管理端'}
            </span>
          </div>
          
          <div className="bg-slate-850 border border-slate-800/80 p-2.5 rounded-xl space-y-2.5 shadow-inner">
            <div className="flex items-center gap-2.5">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-xs ${currentSimulatedUser.avatarColor} shrink-0 shadow-xs`}>
                {currentSimulatedUser.name[0]}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-white truncate">{currentSimulatedUser.name}</p>
                <p className="text-[9px] text-slate-400 truncate mt-0.5">{currentSimulatedUser.department} · {currentSimulatedUser.title}</p>
              </div>
            </div>

            <div className="pt-2 border-t border-slate-800/50 space-y-2">
              <div className="relative">
                <select
                  value={currentSimulatedUserId}
                  onChange={(e) => handleSwitchUser(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700/80 rounded-lg text-xs font-black text-emerald-400 py-1.5 px-2.5 focus:outline-none focus:ring-1 focus:ring-emerald-500 cursor-pointer appearance-none"
                  style={{ backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%2334d399' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' class='lucide lucide-chevron-down'><polyline points='4 6 8 10 12 6'/></svg>")`, backgroundPosition: 'right 8px center', backgroundRepeat: 'no-repeat', backgroundSize: '12px' }}
                >
                  {SIMULATED_USERS.map(user => (
                    <option key={user.id} value={user.id} className="bg-slate-900 text-slate-200">
                      {user.role === 'engineer' ? '🛠️' : '🏥'} [{user.title}] {user.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center justify-between text-[9px] text-slate-500">
                <span>ID: {currentSimulatedUser.id}</span>
                <span className="text-slate-400 font-medium">内线: {currentSimulatedUser.phone || '8001'}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Navigation Sidebar Menu List */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1 bg-slate-900/20">
          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider px-3 mb-2">核心工作台</div>
          
          <button
            onClick={() => {
              setCurrentWorkspace('tasks');
              setIsSidebarOpen(false);
            }}
            className={`w-full flex items-center gap-3 px-3 py-2.5 text-xs font-bold rounded-xl transition-all cursor-pointer ${
              currentWorkspace === 'tasks'
                ? 'bg-blue-600 text-white shadow-md shadow-blue-600/10 font-bold'
                : 'text-slate-300 hover:bg-slate-800 hover:text-white'
            }`}
          >
            <Sparkles className={`w-4 h-4 shrink-0 ${currentWorkspace === 'tasks' ? 'text-white' : 'text-emerald-400'}`} />
            <span className="flex-1 text-left truncate">AI 智能任务调度与流转</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-black ${
              currentWorkspace === 'tasks' ? 'bg-blue-500 text-white' : 'bg-rose-500 text-white animate-pulse'
            }`}>
              {visibleActiveTaskCount}
            </span>
          </button>

          <button
            onClick={() => {
              setCurrentWorkspace('archives');
              setIsSidebarOpen(false);
            }}
            className={`w-full flex items-center gap-3 px-3 py-2.5 text-xs font-bold rounded-xl transition-all cursor-pointer ${
              currentWorkspace === 'archives'
                ? 'bg-blue-600 text-white shadow-md shadow-blue-600/10 font-bold'
                : 'text-slate-300 hover:bg-slate-800 hover:text-white'
            }`}
          >
            <FileSpreadsheet className={`w-4 h-4 shrink-0 ${currentWorkspace === 'archives' ? 'text-white' : 'text-amber-400'}`} />
            <span className="flex-1 text-left truncate">资产在册数字档案库</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${
              currentWorkspace === 'archives' ? 'bg-blue-500 text-white' : 'bg-slate-800 text-slate-400'
            }`}>
              {visibleEquipments.length}
            </span>
          </button>

          {/* Quick Stats Panel */}
          <div className="pt-6 px-3 space-y-3 border-t border-slate-800/50 mt-4 hidden md:block">
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">系统运行状态</div>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span className="flex items-center gap-1.5 text-slate-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                  设备完好率
                </span>
                <span className="font-bold text-slate-200 font-mono">{sidebarEquipmentUptimeRate}%</span>
              </div>
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span className="flex items-center gap-1.5 text-slate-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400"></span>
                  待检验计量
                </span>
                <span className="font-bold text-slate-200 font-mono">{sidebarCalibrationDueCount} 台</span>
              </div>
              <div className="flex items-center justify-between text-xs text-slate-400">
                  <span className="flex items-center gap-1.5 text-slate-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
                    应急任务
                  </span>
                <span className="font-bold text-slate-200 font-mono">{sidebarEmergencyCount} 次</span>
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar Footer Operations */}
        <div className="p-4 border-t border-slate-800 bg-slate-950/20 shrink-0 space-y-3">
          {currentUserRole === 'engineer' ? (
            <div className="flex gap-2">
              <button
                onClick={() => {
                  openAiSettings();
                  setIsSidebarOpen(false);
                }}
                className="flex-1 flex items-center justify-center gap-1 px-2.5 py-2 text-[11px] font-semibold text-slate-300 bg-slate-800 hover:bg-slate-700 active:bg-slate-900 rounded-lg border border-slate-700/80 transition cursor-pointer"
                title="AI 智能配置与模型切换"
              >
                <Settings className="w-3.5 h-3.5 text-slate-400" />
                <span>AI配置</span>
              </button>

              <button
                onClick={() => {
                  handleRestoreDefaults();
                  setIsSidebarOpen(false);
                }}
                className="flex-1 flex items-center justify-center gap-1 px-2.5 py-2 text-[11px] font-semibold text-slate-300 bg-slate-800 hover:bg-slate-700 active:bg-slate-900 rounded-lg border border-slate-700/80 transition cursor-pointer"
                title="恢复预置演示数据"
              >
                <RotateCcw className="w-3.5 h-3.5 text-slate-400" />
                <span>重置数据</span>
              </button>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-xl border border-teal-900/60 bg-teal-950/30 px-3 py-2.5 text-[10px] leading-normal text-teal-100">
              <ShieldCheck className="w-3.5 h-3.5 text-teal-300 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold text-teal-100">临床只读运行模式</p>
                <p className="mt-0.5 text-teal-200/75">AI配置与演示数据重置由医学装备科维护，临床端仅保留报修、验收和本科室档案查看。</p>
              </div>
            </div>
          )}

          <div className="bg-slate-950/30 p-2.5 rounded-xl text-slate-400 text-[10px] leading-normal border border-slate-800">
            <p className="font-bold text-slate-300 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
              <span>值班热线: <span className="text-emerald-400 font-mono">8001 / 8002</span></span>
            </p>
            <p className="mt-0.5 text-[9px] text-slate-500">值班工程: 张明华 / 赵安平</p>
          </div>
        </div>
      </aside>

      {/* Mobile Sidebar Overlay Backdrop */}
      {isSidebarOpen && (
        <div 
          onClick={() => setIsSidebarOpen(false)}
          className="fixed inset-0 bg-slate-950/50 backdrop-blur-xs z-30 md:hidden animate-fade-in"
        />
      )}

      {/* Right Column: Main Content Panels */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden bg-slate-50" id="main-content-panel">
        
        {/* Main Content Dashboard Top Header (Re-planned Page Titles) */}
        <header className="bg-white border-b border-slate-200/80 px-4 py-3 md:px-6 md:py-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <span className="bg-blue-50 text-blue-700 text-[10px] font-bold px-2 py-0.5 rounded-md border border-blue-200/50 uppercase tracking-wider">
                {currentWorkspace === 'tasks' ? '流转中心' : '资产中心'}
              </span>
              <h2 className="text-sm md:text-base font-black text-slate-900 flex items-center gap-1.5">
                {currentWorkspace === 'tasks' ? '🚀 AI 智能任务调度与流转大厅' : '📂 医院在册资产数字档案库'}
              </h2>
            </div>
            <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
              {currentWorkspace === 'tasks' 
                ? `基于医学大模型的临床故障一键口述受理、AI自动化定级分流与极速维修协作流转大厅（当前视图: ${currentUserRole === 'medical_staff' ? '临床科室报修端' : '装备科工程师工作台'}）`
                : '全院在册医学装备一机一码全生命周期电子档案中心，支持二维码追溯与资产原籍建档'
              }
            </p>
          </div>

          <div className="flex items-center gap-2.5 self-stretch sm:self-auto justify-end">
            {/* Running Model Badge */}
            {(() => {
              const activeConfig = providerConfigs.find(c => c.id === activeProviderId) || providerConfigs[0];
              const isOffline = activeConfig.id === 'offline-default';
              return (
                <div 
                  onClick={openAiSettings}
                  className={`flex items-center gap-2 px-2.5 py-1.5 bg-slate-50 hover:bg-slate-100 border border-slate-200/80 rounded-lg text-xs text-slate-600 transition shadow-xs ${isClinicalUser ? 'cursor-help' : 'cursor-pointer'}`}
                  title={`当前运行模型：${activeConfig.name} (${activeConfig.model})，${isClinicalUser ? 'AI配置由医学装备科维护' : '点击进行切换或配置'}`}
                >
                  <span className="flex h-1.5 w-1.5 relative">
                    <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${isOffline ? 'bg-amber-400' : 'bg-emerald-400'}`}></span>
                    <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${isOffline ? 'bg-amber-500' : 'bg-emerald-500'}`}></span>
                  </span>
                  <span className="font-semibold text-slate-700 text-[11px]">
                    大模型: <span className="text-emerald-600 font-bold font-mono">{activeConfig.model === 'offline' ? '自适应离线启发式' : activeConfig.model}</span>
                  </span>
                </div>
              );
            })()}
          </div>
        </header>

      {currentWorkspace === 'archives' ? (
        <div className="flex-1 overflow-hidden p-2 md:p-4 bg-slate-100">
          <EquipmentArchives 
            onBackToTasks={() => setCurrentWorkspace('tasks')}
            onReportRepairFromEquip={handleReportRepairFromEquip}
            onQuickRepairCreated={handleQuickRepairCreated}
            tasks={tasks}
            currentUser={currentSimulatedUser}
            onUserChange={(user) => handleSwitchUser(user.id)}
          />
        </div>
      ) : (
        <>
          {/* Main Stats Banner (Desktop only, mobile will show inline) */}
          <section className="px-6 pt-3 pb-1 shrink-0 hidden xl:block">
            <TaskStats tasks={tasks} userRole={currentUserRole} simulatedUser={currentSimulatedUser} />
          </section>

          {/* Main Core Desktop Workspace Layout */}
          <main className="flex-1 p-3 xl:px-6 xl:pt-1 xl:pb-5 flex flex-col xl:grid xl:grid-cols-12 gap-3 xl:gap-4 overflow-hidden">
        
        {/* Left Side: Intelligent Conversational Intake Panel */}
        <div className={`${mobileTab === 'chat' ? 'flex' : 'hidden'} xl:flex ${currentUserRole === 'medical_staff' ? 'xl:col-span-5' : 'xl:col-span-3'} bg-white rounded-2xl border border-slate-200/80 shadow-xs flex-col overflow-hidden flex-1 h-full min-h-0`} id="panel-ai-intake">
          
          {/* Panel Header */}
          {currentUserRole === 'medical_staff' ? (
            <div className="p-4 bg-emerald-50/50 border-b border-emerald-100/60 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <span className="flex h-2 w-2 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
                <h2 className="text-sm font-semibold text-emerald-950 flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-emerald-600 animate-pulse" />
                  {currentSimulatedUser.department} 智能报修通道
                </h2>
              </div>
              <span className="text-[10px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full font-medium">
                临床医护专席
              </span>
            </div>
          ) : (
            <div className="p-4 bg-slate-50 border-b border-slate-100 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 bg-emerald-500 rounded-full animate-ping"></div>
                <h2 className="text-sm font-semibold text-slate-800 flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-emerald-500" />
                  AI 临床诉求快速受理
                </h2>
              </div>
              <span className="text-xs text-slate-400">支持口语、抢救等复杂描述</span>
            </div>
          )}

          {/* AI Model Status Bar */}
          {(() => {
            const activeConfig = providerConfigs.find(c => c.id === activeProviderId) || providerConfigs[0];
            const isOffline = activeConfig.id === 'offline-default';
            const hasApiKey = isOffline || activeConfig.apiKey || activeConfig.isDefault;
            
            let statusText = '运行正常';
            let statusColor = 'bg-emerald-500';
            let textColor = 'text-emerald-700';
            let bgColor = 'bg-emerald-50/60';
            let borderStyle = 'border-emerald-100/80';

            if (isOffline) {
              statusText = '自适应离线机制就绪';
              statusColor = 'bg-amber-500';
              textColor = 'text-amber-700';
              bgColor = 'bg-amber-50/60';
              borderStyle = 'border-amber-100/80';
            } else if (!activeConfig.apiKey && !activeConfig.isDefault) {
              statusText = '等待配置密钥';
              statusColor = 'bg-rose-500 animate-pulse';
              textColor = 'text-rose-700';
              bgColor = 'bg-rose-50/60';
              borderStyle = 'border-red-100/80';
            } else {
              statusText = '云端在线';
            }

            return (
              <div className={`px-4 py-2 border-b ${bgColor} ${borderStyle} flex items-center justify-between text-[11px] shrink-0 animate-fade-in`}>
                <div className="flex items-center gap-1.5 truncate">
                  <span className="text-slate-500">当前大模型:</span>
                  <span className="font-bold text-slate-800 truncate" title={`${activeConfig.name} - ${activeConfig.model}`}>
                    {activeConfig.model === 'offline' ? '自适应离线启发式' : activeConfig.model}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={openAiSettings}
                  title={isClinicalUser ? 'AI配置由医学装备科维护，当前仅显示运行状态' : '点击切换或配置大模型'}
                  className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-semibold transition hover:shadow-xs active:scale-95 shrink-0 ${isClinicalUser ? 'cursor-help' : 'cursor-pointer'} ${textColor} ${borderStyle} bg-white`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${statusColor}`} />
                  {statusText}
                </button>
              </div>
            );
          })()}

          {/* Quick Prompts Panel */}
          <div className="bg-emerald-50/50 px-3 py-1.5 border-b border-slate-100 shrink-0 flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] font-bold text-emerald-800 flex items-center gap-1">
              <HelpCircle className="w-3.5 h-3.5 text-emerald-600" />
              快捷预设:
            </span>
            <div className="flex flex-wrap gap-1 flex-1">
              {visiblePresetPrompts.map((preset, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSendMessage(preset.text)}
                  className="bg-white hover:bg-emerald-100 active:bg-emerald-200 border border-emerald-200 text-[10px] text-emerald-800 px-2 py-0.5 rounded-md transition font-medium shadow-3xs cursor-pointer"
                  id={`preset-${idx}`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* AI Extraction State Card - Mini Card (Requirement 1, 2, 3, 4, 10) */}
          {draftTicket && (
            <div className="bg-slate-900 text-white p-3 border-b border-slate-800 shrink-0 space-y-2 shadow-xs" id="extraction-realtime-card">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="flex h-1.5 w-1.5 relative">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"></span>
                  </span>
                  <span className="text-[11px] font-bold tracking-wider text-slate-200 uppercase">AI 工单草稿摘要</span>
                </div>
                <span className="text-[9px] bg-slate-800 text-emerald-400 px-1.5 py-0.5 rounded border border-slate-700 font-medium">智能提炼中</span>
              </div>

              {/* 5 Key Fields */}
              <div className="grid grid-cols-2 gap-x-2.5 gap-y-1.5 text-[10px] text-slate-300 bg-slate-950/40 p-2 rounded-lg border border-slate-800/60">
                <div className="border-b border-slate-800/40 pb-1">
                  <span className="text-slate-500 block text-[9px]">任务类型:</span>
                  <span className="font-bold text-emerald-400 truncate block">{draftTicket.taskType || '未提取'}</span>
                </div>
                <div className="border-b border-slate-800/40 pb-1">
                  <span className="text-slate-500 block text-[9px]">紧急程度:</span>
                  <span className={`font-bold block ${
                    draftTicket.urgency === '生命支持' ? 'text-red-500 animate-pulse font-extrabold' : 
                    draftTicket.urgency === '特急' ? 'text-red-400 font-bold' : 
                    draftTicket.urgency === '紧急' ? 'text-orange-400 font-bold' : 
                    draftTicket.urgency === '较急' ? 'text-amber-400' : 'text-slate-400'
                  }`}>{draftTicket.urgency || '普通'}</span>
                </div>
                <div className="col-span-2 border-b border-slate-800/40 pb-1">
                  <span className="text-slate-500 block text-[9px]">科室位置:</span>
                  <span className="font-semibold text-slate-200 block truncate">
                    {draftTicket.department || '未录入科室'}{draftTicket.location ? ` (${draftTicket.location})` : ''}
                  </span>
                </div>
                <div className="col-span-2 border-b border-slate-800/40 pb-1">
                  <span className="text-slate-500 block text-[9px]">设备/问题摘要:</span>
                  <span className="font-semibold text-slate-200 block truncate">
                    {draftTicket.deviceName || '正在提取设备...'}
                  </span>
                  {draftTicket.faultPhenomenon && (
                    <span className="text-[9px] text-slate-400 line-clamp-1 mt-0.5">{draftTicket.faultPhenomenon}</span>
                  )}
                </div>
                <div className="col-span-2">
                  <span className="text-slate-500 block text-[9px]">建议责任部门:</span>
                  <span className="font-bold text-amber-400 block truncate">
                    {forwardDept || draftTicket.recommendedDept || '医学装备科'}
                  </span>
                </div>
              </div>

              {/* Mini Card Footer Buttons */}
              <div className="grid grid-cols-2 gap-1.5 pt-0.5">
                <button
                  type="button"
                  onClick={() => setIsFullDraftOpen(true)}
                  className="bg-slate-800 hover:bg-slate-700 active:bg-slate-950 text-slate-200 border border-slate-700 hover:text-white px-2 py-1 rounded text-[10px] font-semibold transition cursor-pointer text-center flex items-center justify-center gap-1"
                  id="btn-expand-full-draft"
                >
                  <Eye className="w-3 h-3 text-slate-400" />
                  展开完整工单
                </button>
                <button
                  type="button"
                  onClick={handleCreateTicketFromDraft}
                  className="bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-bold px-2 py-1 rounded text-[10px] transition cursor-pointer shadow-sm text-center flex items-center justify-center gap-1"
                  id="btn-confirm-draft"
                >
                  <Check className="w-3 h-3" />
                  确认生成任务
                </button>
              </div>
            </div>
          )}

          {/* Message Stream */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50/30">
            {chatMessages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div className={`max-w-[85%] rounded-2xl px-4 py-3 shadow-2xs ${
                  msg.sender === 'user'
                    ? 'bg-emerald-600 text-white rounded-br-none'
                    : 'bg-white text-slate-800 border border-slate-100 rounded-bl-none'
                }`}>
                  <p className="text-xs text-slate-400 mb-1 flex items-center gap-1">
                    {msg.sender === 'user' ? (
                      <>
                        <span>{msg.senderName || '临床科室人员'}</span>
                        <User className="w-3 h-3" />
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3 h-3 text-emerald-600" />
                        <span>医学装备 AI</span>
                      </>
                    )}
                    <span className="mx-1">•</span>
                    <span>{msg.timestamp}</span>
                  </p>
                  
                  <div className="text-sm leading-relaxed whitespace-pre-wrap font-sans">
                    {msg.text}
                  </div>

                  {/* Render inline extracted badges if assistant message extracted info */}
                  {msg.sender === 'assistant' && msg.extractedInfo && Object.keys(msg.extractedInfo).length > 0 && (
                    <div className="mt-3 pt-3 border-t border-slate-100/80 bg-slate-50 rounded-lg p-2.5 text-xs text-slate-700 space-y-1.5">
                      <p className="font-semibold text-slate-800 flex items-center gap-1 text-[11px]">
                        <Tag className="w-3 h-3 text-emerald-600" />
                        AI 最新提取到的关键信息：
                      </p>
                      <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
                        {msg.extractedInfo.taskType && (
                          <div>分类: <span className="font-semibold text-slate-900">{msg.extractedInfo.taskType}</span></div>
                        )}
                        {msg.extractedInfo.department && (
                          <div>科室: <span className="font-semibold text-slate-900">{msg.extractedInfo.department}</span></div>
                        )}
                        {msg.extractedInfo.deviceName && (
                          <div className="col-span-2">设备: <span className="font-semibold text-slate-900">{msg.extractedInfo.deviceName}</span></div>
                        )}
                        {msg.extractedInfo.contactPerson && (
                          <div>联系人: <span className="font-semibold text-slate-900">{msg.extractedInfo.contactPerson}</span></div>
                        )}
                        {msg.extractedInfo.urgency && (
                          <div>紧急度: <span className={`font-bold ${
                            msg.extractedInfo.urgency === '特急' ? 'text-red-600 animate-pulse' : 
                            msg.extractedInfo.urgency === '紧急' ? 'text-orange-600' : 'text-slate-700'
                          }`}>{msg.extractedInfo.urgency}</span></div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Render raw json block if showRawPayload is enabled */}
                  {msg.sender === 'assistant' && showRawPayload && msg.rawJson && (
                    <div className="mt-2.5 pt-2 border-t border-dashed border-slate-200">
                      <details className="cursor-pointer group">
                        <summary className="text-[10px] text-slate-500 hover:text-emerald-600 transition font-mono flex items-center justify-between">
                          <span>🔧 查看 AI 原始 JSON 解析数据</span>
                          <span className="text-[9px] text-slate-400 group-open:rotate-180 transition-transform">▼</span>
                        </summary>
                        <pre className="mt-1.5 p-2 bg-slate-900 text-emerald-400 font-mono text-[9px] rounded-lg overflow-x-auto max-h-40 leading-normal select-text">
                          {msg.rawJson}
                        </pre>
                      </details>
                    </div>
                  )}
                </div>
              </div>
            ))}
            
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-white border border-slate-100 rounded-2xl rounded-bl-none px-4 py-3 shadow-2xs text-sm text-slate-400 flex items-center gap-2">
                  <div className="flex space-x-1">
                    <span className="w-2 h-2 bg-emerald-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></span>
                    <span className="w-2 h-2 bg-emerald-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></span>
                    <span className="w-2 h-2 bg-emerald-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></span>
                  </div>
                  <span>AI 正在研判并提炼中...</span>
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Draft Sidebar Indicator (Requirement 6) */}
          {draftTicket && (
            <div className="p-3 bg-slate-900 border-t border-slate-800 text-white flex items-center justify-between text-xs shrink-0" id="draft-sidebar-indicator">
              <div 
                className="flex items-center gap-2 cursor-pointer flex-1"
                onClick={() => {
                  setMobileTab('detail');
                }}
                title="点击切换到详情预览并生成工单"
              >
                <span className="bg-emerald-500 text-slate-900 font-extrabold text-[9px] px-1.5 py-0.5 rounded-sm animate-pulse shrink-0">草稿就绪</span>
                <span className="text-slate-300 hover:text-white transition decoration-dotted underline md:no-underline text-[11px] md:text-xs">
                  <span className="hidden xl:inline">已在右侧生成任务单预览</span>
                  <span className="xl:hidden">已生成工单草稿，👉 点击此处立即预览并建单</span>
                </span>
              </div>
              <button 
                onClick={(e) => {
                  e.stopPropagation();
                  setDraftTicket(null);
                  setForwardDept(null);
                  setIsClarification(false);
                }}
                className="text-rose-400 hover:text-rose-300 font-medium cursor-pointer ml-2 text-xs shrink-0"
              >
                放弃
              </button>
            </div>
          )}

          {/* Input Box Footer */}
          <div className="p-4 bg-white border-t border-slate-100 shrink-0">
            {isListening && (
              <div className="mb-2 px-3 py-1.5 bg-red-50 border border-red-100 rounded-xl flex items-center justify-between text-xs text-red-700 animate-fade-in">
                <div className="flex items-center gap-2">
                  <span className="flex h-2 w-2 relative">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
                  </span>
                  <span className="font-bold">实时语音报修录音中... 请口述您的故障</span>
                </div>
                {/* Visual Audio Wave */}
                <div className="flex items-end gap-0.5 h-3 px-2">
                  <span className="w-0.5 h-2 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-0.5 h-3 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-0.5 h-4 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  <span className="w-0.5 h-2 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '450ms' }} />
                </div>
              </div>
            )}

            {recognitionError && (
              <div className="mb-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-xl flex flex-col sm:flex-row sm:items-center sm:justify-between text-[11px] text-amber-800 gap-1.5 animate-fade-in">
                <span className="font-medium">⚠️ {recognitionError}</span>
                <button
                  type="button"
                  onClick={() => setShowVoiceMockModal(true)}
                  className="bg-amber-100 hover:bg-amber-200 text-amber-900 px-2 py-0.5 rounded text-[10px] font-bold self-start sm:self-auto cursor-pointer"
                >
                  使用智能仿真语音输入
                </button>
              </div>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSendMessage(inputMessage);
              }}
              className="flex items-center gap-2"
            >
              <button
                type="button"
                onClick={toggleListening}
                className={`p-2.5 rounded-xl border transition cursor-pointer flex items-center justify-center relative shrink-0 ${
                  isListening 
                    ? 'bg-red-500 border-red-500 text-white animate-pulse' 
                    : 'bg-slate-50 hover:bg-slate-100 border-slate-200 text-slate-600 active:bg-slate-200'
                }`}
                title={isListening ? "停止语音输入并识别" : "语音报修：点击直接口述故障"}
                id="voice-repair-btn"
              >
                {isListening ? <Mic className="w-5 h-5 animate-bounce" /> : <Mic className="w-5 h-5" />}
                {isListening && (
                  <span className="absolute -top-0.5 -right-0.5 flex h-1.5 w-1.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-red-600"></span>
                  </span>
                )}
              </button>

              <input
                type="text"
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                placeholder={isListening ? "正在聆听并识别中..." : (isClarification ? "请回答AI追问的关键信息..." : "说出您面临的设备故障/业务描述...")}
                disabled={isLoading}
                className="flex-1 bg-slate-50 border border-slate-200 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none rounded-xl px-4 py-2.5 text-sm transition"
                id="chat-input"
              />
              <button
                type="submit"
                disabled={isLoading || !inputMessage.trim()}
                className="bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-100 text-white disabled:text-slate-400 p-2.5 rounded-xl transition cursor-pointer shrink-0"
                id="chat-send-btn"
              >
                <Send className="w-5 h-5" />
              </button>
            </form>
          </div>
        </div>

        {/* Middle: Active Task List & Filters (5 Columns) */}
        {currentUserRole !== 'medical_staff' && (
          <div className={`${mobileTab === 'list' ? 'flex' : 'hidden'} xl:flex xl:col-span-4 bg-white rounded-2xl border border-slate-200/80 shadow-xs flex-col overflow-hidden flex-1 h-full min-h-0`} id="panel-task-list">
          
          {/* Header & Search */}
          <div className="p-4 bg-slate-50 border-b border-slate-100 shrink-0 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                <FileText className="w-4.5 h-4.5 text-slate-500" />
                医学装备科任务库 ({filteredTasks.length}单)
              </h2>
              
              <button
                onClick={() => {
                  const newTemp: Partial<StructuredTicket> = {
                    taskType: '设备报修',
                    department: '急诊科',
                    location: '急诊楼 1楼',
                    deviceName: '手动录入设备',
                    deviceId: 'EQ-' + Math.floor(Math.random() * 90000 + 10000),
                    faultPhenomenon: '请在此处填入具体故障描述。',
                    contactPerson: '李护士',
                    contactPhone: '分机 8081',
                    urgency: '普通',
                    affectClinical: '否'
                  };
                  setDraftTicket(newTemp);
                  setMobileTab('chat');
                }}
                className="text-xs bg-slate-200 hover:bg-slate-300 text-slate-700 font-semibold px-2.5 py-1 rounded-lg flex items-center gap-1 transition"
                id="btn-manual-add"
              >
                <Plus className="w-3.5 h-3.5" />
                手动建单
              </button>
            </div>

            {/* General Search Input */}
            <input 
              type="text"
              placeholder="搜索单号/设备/科室/联系人..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-white border border-slate-200 focus:border-slate-400 focus:outline-none rounded-lg px-3 py-1.5 text-xs transition shadow-2xs"
              id="task-search-input"
            />

            {/* Compact Quick Select Filters */}
            <div className="grid grid-cols-4 gap-1.5 text-[10px]">
              <div>
                <label className="text-slate-500 block mb-1 font-medium">任务分类</label>
                <select 
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-md px-1 py-1 text-[11px] text-slate-700 font-medium focus:border-slate-400 focus:outline-none transition shadow-3xs"
                >
                  <option value="All">全部</option>
                  <option value="设备报修">设备报修</option>
                  <option value="生命支持设备应急">生命应急</option>
                  <option value="医用气体异常">气体异常</option>
                  <option value="验收安装协同">验收安装</option>
                  <option value="供应商协同">供应商</option>
                  <option value="计量/质控提醒">计量质控</option>
                  <option value="配件耗材申请">配件耗材</option>
                  <option value="普通杂项任务">普通杂项</option>
                  <option value="非设备类转派任务">转派任务</option>
                </select>
              </div>

              <div>
                <label className="text-slate-500 block mb-1 font-medium">紧急程度</label>
                <select 
                  value={urgencyFilter}
                  onChange={(e) => setUrgencyFilter(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-md px-1 py-1 text-[11px] text-slate-700 font-medium focus:border-slate-400 focus:outline-none transition shadow-3xs"
                >
                  <option value="All">全部</option>
                  <option value="普通">普通</option>
                  <option value="紧急">紧急</option>
                  <option value="特急">特急</option>
                </select>
              </div>

              <div>
                <label className="text-slate-500 block mb-1 font-medium">任务状态</label>
                <select 
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-md px-1 py-1 text-[11px] text-slate-700 font-medium focus:border-slate-400 focus:outline-none transition shadow-3xs"
                >
                  <option value="All">全部</option>
                  <option value="待确认">待确认</option>
                  <option value="待派工">待派工</option>
                  <option value="已派工">已派工</option>
                  <option value="处理中">处理中</option>
                  <option value="待科室验收">科室验收</option>
                  <option value="已完成">已完成</option>
                  <option value="已归档">已归档</option>
                  <option value="已关闭">已关闭</option>
                </select>
              </div>

              <div>
                <label className="text-slate-500 block mb-1 font-medium">任务来源</label>
                <select 
                  value={sourceFilter}
                  onChange={(e) => setSourceFilter(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-md px-1 py-1 text-[11px] text-slate-700 font-medium focus:border-slate-400 focus:outline-none transition shadow-3xs"
                >
                  <option value="All">全部</option>
                  <option value="AI 对话生成">AI对话</option>
                  <option value="科室扫码报修">扫码报修</option>
                  <option value="电话登记">电话登记</option>
                  <option value="微信小程序">微信小程序</option>
                  <option value="工程师手工录入">手工录入</option>
                  <option value="供应商协同">供应商</option>
                  <option value="系统自动预警">系统预警</option>
                </select>
              </div>
            </div>
          </div>

          {/* Scrollable Task List Cards */}
          <div className="flex-1 overflow-y-auto bg-slate-50/50 p-3 space-y-3">
            <div className="xl:hidden pb-1">
              <TaskStats
                tasks={tasks}
                userRole={currentUserRole}
                simulatedUser={currentSimulatedUser}
              />
            </div>

            {sortedAndFilteredTasks.length === 0 ? (
              <div className="text-center py-12 text-slate-400">
                <p className="text-sm">没有找到符合条件的任务单</p>
                <p className="text-xs mt-1">请重新调整您的过滤器或进行搜索</p>
              </div>
            ) : (
              sortedAndFilteredTasks.map((t) => {
                const isSelected = selectedTask?.id === t.id;

                // Color mapping for Business Status
                let statusBadgeColor = "bg-slate-50 text-slate-600 border-slate-200";
                if (t.status === '待确认') statusBadgeColor = "bg-pink-50 text-pink-700 border-pink-200 font-bold";
                else if (t.status === '待派工') statusBadgeColor = "bg-amber-50 text-amber-700 border-amber-200 font-semibold";
                else if (t.status === '已派工') statusBadgeColor = "bg-sky-50 text-sky-700 border-sky-200";
                else if (t.status === '处理中') statusBadgeColor = "bg-blue-50 text-blue-700 border-blue-200";
                else if (t.status === '待科室验收') statusBadgeColor = "bg-violet-50 text-violet-700 border-violet-200";
                else if (t.status === '已完成') statusBadgeColor = "bg-emerald-50 text-emerald-700 border-emerald-200";
                else if (t.status === '已归档') statusBadgeColor = "bg-slate-100 text-slate-700 border-slate-200";
                else if (t.status === '已关闭') statusBadgeColor = "bg-slate-50 text-slate-400 border-slate-150";

                // Color mapping for AI Status
                let aiStatusBadgeColor = "bg-slate-50 text-slate-600 border-slate-200";
                if (t.aiStatus === '已分析') aiStatusBadgeColor = "bg-emerald-100/80 text-emerald-800 border-emerald-200 font-medium";
                else if (t.aiStatus === 'AI待补全') aiStatusBadgeColor = "bg-amber-100/80 text-amber-800 border-amber-200 font-semibold animate-pulse";
                else if (t.aiStatus === '人工修正') aiStatusBadgeColor = "bg-blue-100/80 text-blue-800 border-blue-200 font-medium";
                else if (t.aiStatus === '分析中') aiStatusBadgeColor = "bg-sky-100/80 text-sky-800 border-sky-200 animate-pulse";
                else if (t.aiStatus === '分析失败') aiStatusBadgeColor = "bg-rose-100/80 text-rose-800 border-rose-200";
                else if (t.aiStatus === '未分析') aiStatusBadgeColor = "bg-slate-100 text-slate-500 border-slate-200";

                // Color mapping for types
                let typeBadgeColor = "bg-slate-50 text-slate-700 border-slate-200";
                if (t.taskType === '设备报修') typeBadgeColor = "bg-rose-50 text-rose-700 border-rose-150";
                else if (t.taskType === '生命支持设备应急') typeBadgeColor = "bg-red-50 text-red-700 border-red-200 font-bold";
                else if (t.taskType === '医用气体异常') typeBadgeColor = "bg-sky-50 text-sky-700 border-sky-150";
                else if (t.taskType === '验收安装协同') typeBadgeColor = "bg-purple-50 text-purple-700 border-purple-150";
                else if (t.taskType === '供应商协同') typeBadgeColor = "bg-indigo-50 text-indigo-700 border-indigo-150";
                else if (t.taskType === '计量/质控提醒') typeBadgeColor = "bg-teal-50 text-teal-700 border-teal-150";
                else if (t.taskType === '配件耗材申请') typeBadgeColor = "bg-amber-50 text-amber-700 border-amber-150";
                else if (t.taskType === '普通杂项任务') typeBadgeColor = "bg-slate-50 text-slate-700 border-slate-150";
                else if (t.taskType === '非设备类转派任务') typeBadgeColor = "bg-orange-50 text-orange-700 border-orange-150";

                // Color mapping for Urgency level
                let urgencyBadgeStyle = "text-[10px] px-2 py-0.5 rounded border font-medium ";
                if (t.urgency === '生命支持') urgencyBadgeStyle += "bg-red-600 text-white border-red-700 animate-pulse font-bold";
                else if (t.urgency === '特急') urgencyBadgeStyle += "bg-red-100 text-red-700 border-red-200 font-bold";
                else if (t.urgency === '紧急') urgencyBadgeStyle += "bg-orange-100 text-orange-700 border-orange-200 font-semibold";
                else if (t.urgency === '较急') urgencyBadgeStyle += "bg-amber-100 text-amber-700 border-amber-200";
                else if (t.urgency === '普通') urgencyBadgeStyle += "bg-slate-100 text-slate-600 border-slate-200";

                // Pinned automatic top trigger check (Requirement 5)
                const isPinned = t.taskType === '生命支持设备应急' || t.taskType === '医用气体异常' || t.deviceName.includes('抢救') || t.faultPhenomenon.includes('抢救');

                // Format Time: MM-DD HH:mm
                const formatTaskTime = (dateStr: string) => {
                  try {
                    const d = new Date(dateStr);
                    const m = String(d.getMonth() + 1).padStart(2, '0');
                    const day = String(d.getDate()).padStart(2, '0');
                    const h = String(d.getHours()).padStart(2, '0');
                    const min = String(d.getMinutes()).padStart(2, '0');
                    return `${m}-${day} ${h}:${min}`;
                  } catch (e) {
                    return dateStr;
                  }
                };

                return (
                  <div
                    key={t.id}
                    onClick={() => {
                      setSelectedTask(t);
                      setMobileTab('detail');
                    }}
                    className={`p-3.5 rounded-xl border transition cursor-pointer text-left relative flex flex-col gap-2.5 ${
                      isSelected 
                        ? 'bg-white border-slate-900 shadow-md ring-1 ring-slate-900/10' 
                        : 'bg-white hover:bg-slate-100/50 border-slate-200 shadow-2xs'
                    }`}
                    id={`task-card-${t.id}`}
                  >
                    {/* Urgency Highlight top border indicator */}
                    {isPinned && <div className="absolute top-0 left-0 right-0 h-1 bg-red-600 rounded-t-xl" />}
                    {!isPinned && t.urgency === '特急' && <div className="absolute top-0 left-0 right-0 h-1 bg-red-400 rounded-t-xl" />}
                    {!isPinned && t.urgency === '紧急' && <div className="absolute top-0 left-0 right-0 h-1 bg-orange-400 rounded-t-xl" />}

                    {/* Metadata Header */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] font-mono font-bold text-slate-500">{t.id}</span>
                        {isPinned && (
                          <span className="bg-red-600 text-white text-[9px] px-1.5 py-0.5 rounded font-extrabold animate-pulse flex items-center gap-0.5">
                            📌 应急置顶
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap justify-end">
                        <span className={`text-[9px] px-1.5 py-0.5 rounded border font-medium ${typeBadgeColor}`}>
                          {t.taskType}
                        </span>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded border font-bold ${statusBadgeColor}`}>
                          业务: {t.status}
                        </span>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded border font-bold ${aiStatusBadgeColor}`}>
                          AI: {t.aiStatus || '已分析'}
                        </span>
                      </div>
                    </div>

                    {/* Department and Patient Status Info */}
                    <div className="space-y-1">
                      <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1">
                        <Building2 className="w-3 h-3 text-slate-400" />
                        {t.department}
                        {t.location && <span className="text-slate-400 font-normal ml-1">({t.location})</span>}
                      </h4>
                      <h3 className="text-sm font-bold text-slate-900 line-clamp-1 flex items-center gap-1">
                        {t.deviceName}
                        <span className="text-[10px] text-slate-400 font-normal font-mono ml-1">#{t.deviceId}</span>
                      </h3>
                      <p className="text-xs text-slate-600 line-clamp-2 mt-0.5 bg-slate-50/50 p-2 rounded border border-slate-100 leading-relaxed">
                        {t.faultPhenomenon}
                      </p>
                    </div>

                    {/* Footer Contact and Urgency badges */}
                    <div className="flex items-center justify-between pt-2 border-t border-slate-100 text-[10px] text-slate-500 mt-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <div className="flex items-center gap-1">
                          <User className="w-3 h-3 text-slate-400" />
                          <span className="font-medium text-slate-700">{t.contactPerson || '未录入'}</span>
                        </div>
                        <span className="text-slate-300">|</span>
                        <span className="bg-slate-100/80 text-slate-500 text-[9px] px-1.5 py-0.5 rounded border border-slate-200">{t.source || 'AI 对话生成'}</span>
                        <span className="text-slate-300">|</span>
                        <span className="text-[9px] text-slate-400 font-mono">
                          {formatTaskTime(t.createdAt)}
                        </span>
                      </div>

                      <div className="flex items-center gap-1">
                        <span className={urgencyBadgeStyle}>
                          {t.urgency}
                        </span>
                        {t.affectClinical === '是' && (
                          <span className="bg-rose-50 text-rose-800 border border-rose-200 px-1.5 py-0.5 rounded font-medium text-[9px]">
                            影响临床
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
        )}
        {/* Right Side: Detailed Structured Task Profile & Logs Tracking (5 Columns) */}
        <div className={`${
          currentUserRole === 'medical_staff'
            ? (mobileTab === 'list' || mobileTab === 'detail' ? 'flex' : 'hidden')
            : (mobileTab === 'detail' ? 'flex' : 'hidden')
        } xl:flex ${currentUserRole === 'medical_staff' ? 'xl:col-span-7' : 'xl:col-span-5'} bg-white rounded-2xl border border-slate-200/80 shadow-xs flex-col overflow-hidden flex-1 h-full min-h-0`} id="panel-task-details">
          {currentUserRole === 'medical_staff' ? (
            /* Clinical Workspace: Split layout with Left mini-sidebar and Right detail timeline */
            <div className="flex-1 flex overflow-hidden h-full" id="clinical-workspace-container">
              {/* Left Column of Clinical workspace (Mini-sidebar: Department Tasks List) */}
              <div className={`${mobileTab === 'list' ? 'flex w-full' : 'hidden'} xl:flex xl:w-64 xl:md:w-72 border-r border-slate-200/65 flex-col shrink-0 bg-slate-50/20`}>
                <div className="p-3.5 bg-slate-50/50 border-b border-slate-200/50 flex flex-col gap-1 shrink-0">
                  <h3 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5 text-slate-400" />
                    {currentSimulatedUser.department}报修记录
                  </h3>
                  <p className="text-[10px] text-slate-400">仅展示当前登录科室任务，待验收与处理中优先</p>
                </div>
                
                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                  {clinicalDepartmentTasks.length === 0 ? (
                    <div className="py-12 px-4 text-center text-slate-400 text-xs">
                      <AlertTriangle className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                      您科室尚未提报过任何设备故障，请在左侧 AI 报修通道提报。
                    </div>
                  ) : (
                    clinicalDepartmentTasks.map(t => {
                      const isSelected = selectedTask?.id === t.id;
                      
                      let statusStyle = 'bg-slate-100 text-slate-700 border-slate-200';
                      if (t.status === '处理中') statusStyle = 'bg-sky-50 text-sky-700 border-sky-100';
                      if (t.status === '待科室验收') statusStyle = 'bg-amber-50 text-amber-800 border-amber-200 animate-pulse font-semibold';
                      if (t.status === '已完成') statusStyle = 'bg-emerald-50 text-emerald-800 border-emerald-100';
                      if (t.status === '已关闭' || t.status === '已归档') statusStyle = 'bg-slate-100 text-slate-500 border-slate-200';

                      return (
                        <div
                          key={t.id}
                          onClick={() => {
                            setSelectedTask(t);
                            setMobileTab('detail');
                          }}
                          className={`p-3 rounded-xl border text-left transition cursor-pointer relative ${
                            isSelected 
                              ? 'bg-slate-900 border-slate-900 text-white shadow-md' 
                              : 'bg-white hover:bg-slate-50 border-slate-200/80 text-slate-800'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-mono text-[9px] text-slate-400 font-bold">{t.id}</span>
                            <span className={`text-[9px] border px-1.5 py-0.2 rounded ${statusStyle}`}>{t.status}</span>
                          </div>
                          <h4 className="text-xs font-bold truncate">{t.deviceName}</h4>
                          <p className={`text-[10px] truncate mt-1 ${isSelected ? 'text-slate-300' : 'text-slate-500'}`}>{t.faultPhenomenon}</p>
                          <div className="flex items-center justify-between mt-2 pt-1.5 border-t border-dashed border-slate-100/30 text-[9px]">
                            <span className="text-slate-400">{new Date(t.createdAt).toLocaleDateString('zh-CN', {month: 'numeric', day: 'numeric'})}</span>
                            <span className={t.urgency === '生命支持' ? 'text-rose-500 font-extrabold animate-pulse' : 'text-slate-400'}>{t.urgency}</span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Right Column of Clinical workspace (Timeline Track & Closed-Loop Feedback Panel) */}
              <div className={`${mobileTab === 'detail' ? 'flex flex-1' : 'hidden'} xl:flex xl:flex-1 flex-col min-h-0 bg-slate-50/30 overflow-y-auto`}>
                {selectedTask && isSameDepartment(selectedTask.department, currentSimulatedUser.department || currentSimulatedUser.dept) ? (
                  <div className="p-4 md:p-5 space-y-5 flex-1 flex flex-col">             <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-xs flex items-start justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-xs font-mono font-bold text-slate-400 bg-slate-100 px-2 py-0.5 rounded-sm">{selectedTask.id}</span>
                          <span className="text-xs font-semibold text-slate-500">{selectedTask.deviceName}</span>
                        </div>
                        <h3 className="text-sm font-bold text-slate-900">
                          {selectedTask.deviceName} {needsClinicalAcceptance(selectedTask) ? '故障报修追踪' : '转派事项追踪'}
                        </h3>
                        <p className="text-[11px] text-slate-500 mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span>位置: 📍{selectedTask.location}</span>
                          <span>报修人: 👤{selectedTask.contactPerson}</span>
                          <span>电话: 📞{selectedTask.contactPhone}</span>
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <span className={`inline-block border px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                          selectedTask.status === '待科室验收' ? 'bg-amber-100 text-amber-800 border-amber-200 animate-pulse' :
                          selectedTask.status === '已完成' ? 'bg-emerald-100 text-emerald-800 border-emerald-200' :
                          selectedTask.status === '处理中' ? 'bg-sky-100 text-sky-800 border-sky-200' :
                          selectedTask.status === '已关闭' || selectedTask.status === '已归档' ? 'bg-slate-100 text-slate-500 border-slate-200' :
                          'bg-slate-100 text-slate-800 border-slate-200'
                        }`}>
                          {selectedTask.status}
                        </span>
                        <div className="text-[10px] text-slate-400 mt-1.5">更新时间: {new Date(selectedTask.updatedAt).toLocaleTimeString('zh-CN', {hour: '2-digit', minute:'2-digit'})}</div>
                      </div>
                    </div>

                    {/* 双向数据穿透：关联医学装备数字档案卡 */}
                    {(() => {
                      const requiresClinicalAcceptance = needsClinicalAcceptance(selectedTask);
                      const matchedEquip = requiresClinicalAcceptance
                        ? allEquipments.find(eq => eq.id === selectedTask.deviceId || eq.sn === selectedTask.deviceId || (eq.deviceName === selectedTask.deviceName && isSameDepartment(eq.dept, selectedTask.department)))
                        : null;
                      if (matchedEquip) {
                        return (
                          <div className="bg-gradient-to-tr from-emerald-50 to-teal-50/40 border border-emerald-200/60 p-3 rounded-xl flex items-center justify-between gap-3 shadow-xs">
                            <div className="space-y-0.5">
                              <div className="text-[10px] font-bold text-emerald-800 flex items-center gap-1">
                                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 animate-pulse" />
                                <span>已自动关联全生命周期电子档案</span>
                              </div>
                              <p className="text-[11px] text-slate-700 font-semibold truncate max-w-[200px]">
                                {matchedEquip.manufacturer} {matchedEquip.deviceName} ({matchedEquip.model})
                              </p>
                              <p className="text-[9px] text-slate-400 font-mono">资产ID: {matchedEquip.id.toUpperCase()} • 风险评级: {matchedEquip.riskLevel}级</p>
                            </div>
                            <button
                              onClick={() => openLinkedEquipmentArchive(matchedEquip.id)}
                              className="flex items-center gap-1 text-[11px] font-extrabold bg-emerald-600 hover:bg-emerald-700 text-white px-2.5 py-1.5 rounded-lg transition cursor-pointer shrink-0 shadow-sm"
                            >
                              <FileText className="w-3.5 h-3.5" />
                              <span>查看档案</span>
                            </button>
                          </div>
                        );
                      } else {
                        return (
                          <div className="bg-slate-50 border border-slate-200 p-3 rounded-xl">
                            <div className="space-y-0.5">
                              <div className="text-[10px] font-bold text-slate-500">
                                {requiresClinicalAcceptance ? '设备电子档案未关联' : '非设备转派单不绑定设备档案'}
                              </div>
                              <p className="text-[11px] text-slate-600 font-medium">
                                {requiresClinicalAcceptance
                                  ? '当前工单尚未绑定医院在册设备，请等待医学装备科完成检索建档。'
                                  : `此单已转派${selectedTask.recommendedDept || '责任科室'}处理，仅保留流转记录，不写入医学设备维修档案。`}
                              </p>
                            </div>
                          </div>
                        );
                      }
                    })()}

                    {/* Timeline Tracker */}
                    <div className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-xs space-y-4">
                      <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                        <Activity className="w-3.5 h-3.5 text-emerald-500" />
                        工单闭环流转轨迹 Timeline
                      </h4>

                      <div className="relative border-l border-slate-200 ml-3.5 pl-5 py-2 space-y-5">
                        {/* Step 1: Submited */}
                        <div className="relative">
                          <div className="absolute -left-[27px] top-0.5 bg-emerald-500 text-white rounded-full p-1 border-2 border-white shadow-xs">
                            <Check className="w-3 h-3" />
                          </div>
                          <div>
                            <h5 className="text-xs font-bold text-slate-800">1. 临床一键提报（AI 智能受理）</h5>
                            <p className="text-[11px] text-slate-500 mt-0.5">提报渠道：{selectedTask.source} | 任务分类：{selectedTask.taskType}</p>
                            <p className="text-[10px] text-slate-400 font-mono mt-0.5">{new Date(selectedTask.createdAt).toLocaleString('zh-CN')}</p>
                          </div>
                        </div>

                        {/* Step 2: Dispatched */}
                        {(() => {
                          const requiresClinicalAcceptance = needsClinicalAcceptance(selectedTask);
                          const isCompleted = ['已派工', '处理中', '待科室验收', '已完成', '已归档', '已关闭'].includes(selectedTask.status);
                          const isInProgress = ['待确认', '待派工'].includes(selectedTask.status);
                          return (
                            <div className="relative">
                              <div className={`absolute -left-[27px] top-0.5 rounded-full p-1 border-2 border-white shadow-xs ${
                                isCompleted ? 'bg-emerald-500 text-white' :
                                isInProgress ? 'bg-sky-500 text-white animate-pulse' :
                                'bg-slate-200 text-slate-400'
                              }`}>
                                {isCompleted ? (
                                  <Check className="w-3 h-3" />
                                ) : isInProgress ? (
                                  <Activity className="w-3 h-3 animate-spin" />
                                ) : (
                                  <Clock className="w-3 h-3" />
                                )}
                              </div>
                              <div>
                                <h5 className={`text-xs font-bold ${isCompleted || isInProgress ? 'text-slate-800' : 'text-slate-400'}`}>
                                  2. {requiresClinicalAcceptance ? '装备科审核并指派派工' : `装备科审核并转派${selectedTask.recommendedDept || '责任科室'}`}
                                </h5>
                                <p className="text-[11px] text-slate-500 mt-0.5">
                                  {requiresClinicalAcceptance
                                    ? (isCompleted ? '✅ 已审核并指派专业工程师进行响应' : (isInProgress ? '⚡ 装备科已受理，正在匹配指派合适工程师...' : '自动匹配流转：' + (selectedTask.recommendedDept || '医学装备科')))
                                    : (isCompleted ? `✅ 已完成转派并记录归口部门：${selectedTask.recommendedDept || '责任科室'}` : (isInProgress ? `⚡ 装备科已受理，正在转派${selectedTask.recommendedDept || '责任科室'}处理...` : '自动匹配流转：' + (selectedTask.recommendedDept || '责任科室')))}
                                </p>
                              </div>
                            </div>
                          );
                        })()}

                        {/* Step 3: Repairing */}
                        {(() => {
                          const requiresClinicalAcceptance = needsClinicalAcceptance(selectedTask);
                          const isCompleted = ['待科室验收', '已完成', '已归档', '已关闭'].includes(selectedTask.status);
                          const isInProgress = ['已派工', '处理中'].includes(selectedTask.status);
                          return (
                            <div className="relative">
                              <div className={`absolute -left-[27px] top-0.5 rounded-full p-1 border-2 border-white shadow-xs ${
                                isCompleted ? 'bg-emerald-500 text-white' :
                                isInProgress ? 'bg-sky-500 text-white animate-pulse' :
                                'bg-slate-200 text-slate-400'
                              }`}>
                                {isCompleted ? (
                                  <Check className="w-3 h-3" />
                                ) : isInProgress ? (
                                  <Activity className="w-3 h-3 animate-spin" />
                                ) : (
                                  <Clock className="w-3 h-3" />
                                )}
                              </div>
                              <div>
                                <h5 className={`text-xs font-bold ${isCompleted || isInProgress ? 'text-slate-800' : 'text-slate-400'}`}>
                                  3. {requiresClinicalAcceptance ? '现场排障与维修' : `${selectedTask.recommendedDept || '责任科室'}跟进处理`}
                                </h5>
                                <p className="text-[11px] text-slate-500 mt-0.5">
                                  {requiresClinicalAcceptance
                                    ? (selectedTask.status === '已派工' ? '⚙️ 工程师已接单，正携带工具前往现场...' :
                                      selectedTask.status === '处理中' ? '⚡ 工程师已到场，正紧急排障中...' :
                                      isCompleted ? '🛠️ 诊断维修完毕，测试运行通过，发起验收。' : '等待工程师前往现场')
                                    : (selectedTask.status === '已派工' ? `⚙️ 已转交${selectedTask.recommendedDept || '责任科室'}，等待对方接收...` :
                                      selectedTask.status === '处理中' ? `⚡ ${selectedTask.recommendedDept || '责任科室'}正在处理，装备科保留协调记录。` :
                                      isCompleted ? '已完成跨部门协调并关闭留痕。' : '等待责任科室接收处理')}
                                </p>
                              </div>
                            </div>
                          );
                        })()}

                        {/* Step 4: Accepting */}
                        {(() => {
                          const requiresClinicalAcceptance = needsClinicalAcceptance(selectedTask);
                          const isCompleted = ['已完成', '已归档', '已关闭'].includes(selectedTask.status);
                          const isInProgress = selectedTask.status === '待科室验收';
                          return (
                            <div className="relative">
                              <div className={`absolute -left-[27px] top-0.5 rounded-full p-1 border-2 border-white shadow-xs ${
                                isCompleted ? 'bg-emerald-500 text-white' : (isInProgress ? 'bg-amber-500 text-white animate-pulse' : 'bg-slate-200 text-slate-400')
                              }`}>
                                {isCompleted ? <Check className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
                              </div>
                              <div>
                                <h5 className={`text-xs font-bold ${isCompleted || isInProgress ? 'text-slate-800' : 'text-slate-400'}`}>
                                  4. {requiresClinicalAcceptance ? '临床科室现场功能验收确认' : '跨部门转派关闭留痕'}
                                </h5>
                                <p className="text-[11px] text-slate-500 mt-0.5">
                                  {requiresClinicalAcceptance
                                    ? (isInProgress ? '👉 等待您进行功能质量核对并打分签字验收' : (isCompleted ? '已现场试用正常，确认验收' : '待维修完工发起'))
                                    : (isCompleted ? '装备科已完成转派记录并关闭此单。' : `无需临床设备验收，待${selectedTask.recommendedDept || '责任科室'}处理后关闭留痕。`)}
                                </p>
                              </div>
                            </div>
                          );
                        })()}

                        {/* Step 5: Finished */}
                        {(() => {
                          const requiresClinicalAcceptance = needsClinicalAcceptance(selectedTask);
                          const isCompleted = ['已完成', '已归档', '已关闭'].includes(selectedTask.status);
                          const isTransferredClosed = !needsClinicalAcceptance(selectedTask) && selectedTask.status === '已关闭';
                          return (
                            <div className="relative">
                              <div className={`absolute -left-[27px] top-0.5 rounded-full p-1 border-2 border-white shadow-xs ${
                                isCompleted || isTransferredClosed ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-400'
                              }`}>
                                <ShieldCheck className="w-3 h-3" />
                              </div>
                              <div>
                                <h5 className={`text-xs font-bold ${isCompleted || isTransferredClosed ? 'text-emerald-700 font-semibold' : 'text-slate-400'}`}>
                                  5. {needsClinicalAcceptance(selectedTask) ? '工单安全闭环（满意度归档）' : '转派工单闭环'}
                                </h5>
                                <p className="text-[11px] text-slate-500 mt-0.5">
                                  {requiresClinicalAcceptance
                                    ? (isCompleted ? '全流程完整跟踪，已完成闭环档案归档或关闭留痕。' : '等待临床验收完成后自动形成闭环归档。')
                                    : (isTransferredClosed ? '非设备问题已转派并关闭留痕，不写入医学设备维修档案。' : '等待装备科完成转派协调并关闭留痕。')}
                                </p>
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    </div>

                    {/* Operational Rating Form or Rated Badge */}
                    {selectedTask.status === '待科室验收' && needsClinicalAcceptance(selectedTask) && (() => {
                      const isClinicalAcceptancePending = pendingClinicalAcceptanceTaskIds.has(selectedTask.id);

                      return (
                        <div className="bg-gradient-to-br from-emerald-50/60 to-teal-50/40 p-5 rounded-xl border border-emerald-200/70 shadow-sm space-y-4 animate-fade-in">
                          <div>
                            <h4 className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
                              ✍️ 签署验收 & 满意度打分
                            </h4>
                            <p className="text-[11px] text-slate-500 mt-0.5">设备已试运行确认通过，请客观打分以提升医学装备科服务质量</p>
                          </div>

                          {/* Star widget */}
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-slate-600">服务满意度:</span>
                            <div className="flex items-center gap-1">
                              {[1, 2, 3, 4, 5].map((star) => (
                                <button
                                  key={star}
                                  id={`clinical-rating-star-${star}`}
                                  aria-label={`设置临床满意度为${star}星`}
                                  type="button"
                                  disabled={isClinicalAcceptancePending}
                                  onClick={() => setRatingValue(star)}
                                  className={`p-1 transition ${isClinicalAcceptancePending ? 'cursor-not-allowed opacity-60' : 'hover:scale-110 cursor-pointer'}`}
                                >
                                  <Star className={`w-6 h-6 ${star <= ratingValue ? 'text-amber-400 fill-amber-400' : 'text-slate-300'}`} />
                                </button>
                              ))}
                            </div>
                            <span className="text-xs font-bold text-amber-600 ml-1">
                              {ratingValue === 5 ? '非常满意' : ratingValue === 4 ? '满意' : ratingValue === 3 ? '一般' : ratingValue === 2 ? '不满意' : '极不满意'}
                            </span>
                          </div>

                          {/* Preset templates */}
                          <div className="space-y-1.5">
                            <span className="text-[10px] text-slate-400 block font-semibold">快速评价词（点击直接填入）:</span>
                            <div className="flex flex-wrap gap-1.5">
                              {['设备试运行良好，已正常投用', '工程师上门神速，态度极好', '修的很专业，点赞！', '提供了备用机，非常周到'].map((preset, index) => (
                                <button
                                  key={preset}
                                  id={`clinical-rating-preset-${index + 1}`}
                                  type="button"
                                  aria-label={`填写验收评价：${preset}`}
                                  disabled={isClinicalAcceptancePending}
                                  onClick={() => setRatingComment(preset)}
                                  className={`text-[10px] border border-slate-200 rounded px-2 py-0.5 ${isClinicalAcceptancePending ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-white hover:bg-slate-50 text-slate-600 cursor-pointer'}`}
                                >
                                  {preset}
                                </button>
                              ))}
                            </div>
                          </div>

                          {/* Comment Input */}
                          <div className="space-y-1">
                            <textarea
                              id="clinical-rating-comment"
                              aria-label="临床验收补充意见"
                              placeholder={isClinicalAcceptancePending ? '正在同步验收签署，请稍候...' : '请填写您的补充意见（选填）...'}
                              value={ratingComment}
                              disabled={isClinicalAcceptancePending}
                              onChange={(e) => setRatingComment(e.target.value)}
                              className="w-full bg-white border border-slate-200 focus:border-emerald-500 rounded-lg p-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500 min-h-[60px] disabled:bg-slate-100 disabled:text-slate-400"
                            />
                          </div>

                          {/* Submit closure button */}
                          <button
                            id="btn-clinical-accept-task"
                            aria-label={isClinicalAcceptancePending ? '正在同步临床验收签署' : '签署临床验收并确认结单'}
                            onClick={() => handleClinicalAcceptTask(selectedTask.id)}
                            disabled={isClinicalAcceptancePending}
                            className={`w-full text-white font-bold text-xs py-2 px-4 rounded-lg shadow-sm transition flex items-center justify-center gap-1.5 ${
                              isClinicalAcceptancePending ? 'bg-emerald-400 cursor-not-allowed' : 'bg-emerald-600 hover:bg-emerald-700 cursor-pointer'
                            }`}
                          >
                            {isClinicalAcceptancePending ? (
                              <Activity className="w-4 h-4 animate-spin" />
                            ) : (
                              <Check className="w-4 h-4" />
                            )}
                            {isClinicalAcceptancePending ? '正在同步验收签署...' : '签署签字并确认验收结单'}
                          </button>
                        </div>
                      );
                    })()}

                    {needsClinicalAcceptance(selectedTask) && ['已完成', '已归档', '已关闭'].includes(selectedTask.status) && (() => {
                      const acceptance = getTaskAcceptanceDisplay(selectedTask);

                      return (
                        <div className="bg-emerald-50/40 p-4 rounded-xl border border-emerald-100 flex items-start gap-3">
                          <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                          <div>
                            <h4 className="text-xs font-bold text-slate-800">已闭环验收</h4>
                            <div className="flex items-center gap-1.5 mt-1">
                              <span className="text-[11px] text-slate-500">临床满意度评分:</span>
                              <div className="flex items-center">
                                {[1, 2, 3, 4, 5].map((star) => (
                                  <Star key={star} className={`w-3.5 h-3.5 ${star <= acceptance.rating ? 'text-amber-400 fill-amber-400' : 'text-slate-200'}`} />
                                ))}
                              </div>
                              <span className="text-[10px] text-slate-400">
                                {acceptance.acceptedBy} · {new Date(acceptance.acceptedAt).toLocaleDateString('zh-CN')}
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-600 mt-1.5">
                              “ {acceptance.comment} ”
                            </p>
                          </div>
                        </div>
                      );
                    })()}

                    {/* Operational Logs History for transparency */}
                    <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-xs flex-1 flex flex-col min-h-0">
                      <h4 className="text-xs font-bold text-slate-800 mb-3 uppercase tracking-wider">
                        📋 工单处置日志
                      </h4>
                      <div className="flex-1 overflow-y-auto space-y-2.5 pr-1">
                        {selectedTask.logs.map((log, i) => (
                          <div key={i} className="text-[11px] bg-slate-50/50 p-2.5 rounded-lg border border-slate-100 flex justify-between gap-4">
                            <div className="space-y-0.5">
                              <p className="text-slate-800 font-medium">{log.action}</p>
                              <p className="text-slate-400 text-[10px]">处置人：{log.operator}</p>
                            </div>
                            <span className="text-slate-400 font-mono text-[9px] shrink-0 self-start mt-0.5">{log.time}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center text-slate-400 p-6 text-center">
                    <FileText className="w-12 h-12 text-slate-300 mb-2 animate-pulse" />
                    <p className="text-sm font-semibold">请在左侧选择属于您科室的故障工单</p>
                    <p className="text-xs text-slate-400 mt-1">选择后将在此查阅实时流转时间轴并进行满意度签署验收。</p>
                  </div>
                )}
              </div>
            </div>
          ) : draftTicket ? (
            /* Requirement 6: AI Task Generation Preview View on Right Side */
            <div className="flex flex-col h-full overflow-hidden" id="draft-preview-panel">
              {/* Draft Header */}
              <div className="p-4 bg-slate-900 text-white shrink-0">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5">
                    <span className="bg-emerald-500 text-slate-900 font-extrabold text-[10px] px-1.5 py-0.5 rounded-sm">PREVIEW</span>
                    <span className="text-xs text-slate-300">AI 正在提炼的任务单预览</span>
                  </div>
                  <button 
                    onClick={() => {
                      setDraftTicket(null);
                      setForwardDept(null);
                      setIsClarification(false);
                    }}
                    className="text-xs text-rose-400 hover:text-rose-300 font-medium cursor-pointer"
                  >
                    放弃草稿
                  </button>
                </div>
                <h3 className="text-base font-extrabold text-white flex items-center gap-1.5">
                  <Sparkles className="w-5 h-5 text-emerald-400 animate-pulse" />
                  {draftTicket.deviceName || '正在提取设备名称...'}
                </h3>
                <p className="text-xs text-slate-300 mt-1 flex items-center gap-1">
                  <Building2 className="w-3.5 h-3.5 text-slate-400" />
                  <span>{draftTicket.department || '正在提取申报科室...'}</span>
                  {draftTicket.location && <span className="text-slate-400">• {draftTicket.location}</span>}
                </p>
              </div>

              {/* Status information alert */}
              {isClarification && (
                <div className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 text-xs text-amber-700 flex items-start gap-1.5">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 mt-0.5 animate-bounce" />
                  <div>
                    <span className="font-bold">AI 追问中：</span>
                    因核心要素未补齐，AI 已在左侧向您发出追问。您可以直接在左侧聊天回复，或者在此手动输入补全以下字段。
                  </div>
                </div>
              )}

              {/* Editable Fields in the Draft Sheet */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                <div className="bg-slate-50 border border-slate-100 rounded-xl p-3.5 space-y-3.5 text-xs text-slate-700">
                  <h4 className="text-xs font-bold text-slate-900 border-b border-slate-200/60 pb-1.5 flex items-center justify-between">
                    <span className="flex items-center gap-1">
                      <FileText className="w-3.5 h-3.5 text-slate-500" />
                      AI 自动提取的任务信息 (可手动调整)
                    </span>
                    <span className="text-[10px] text-slate-400 font-normal">提取结果仅供参考</span>
                  </h4>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] font-bold text-slate-500 block mb-1">任务分类</label>
                      <select 
                        value={draftTicket.taskType || '设备报修'}
                        onChange={(e) => handleUpdateDraftField('taskType', e.target.value)}
                        disabled={currentUserRole === 'medical_staff'}
                        className="w-full bg-white disabled:bg-slate-100 disabled:text-slate-400 border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                      >
                        <option value="设备报修">设备报修</option>
                        <option value="生命支持设备应急">生命支持设备应急</option>
                        <option value="医用气体异常">医用气体异常</option>
                        <option value="验收安装协同">验收安装协同</option>
                        <option value="供应商协同">供应商协同</option>
                        <option value="计量/质控提醒">计量/质控提醒</option>
                        <option value="配件耗材申请">配件耗材申请</option>
                        <option value="普通杂项任务">普通杂项任务</option>
                        <option value="非设备类转派任务">非设备类转派任务</option>
                      </select>
                      {currentUserRole === 'medical_staff' && (
                        <p className="text-[9px] text-slate-400 mt-1">临床端由系统按故障描述自动判定任务类型。</p>
                      )}
                    </div>

                    <div>
                      <label className="text-[10px] font-bold text-slate-500 block mb-1">任务来源</label>
                      <select 
                        value={draftTicket.source || 'AI 对话生成'}
                        onChange={(e) => handleUpdateDraftField('source', e.target.value)}
                        disabled={currentUserRole === 'medical_staff'}
                        className="w-full bg-white disabled:bg-slate-100 disabled:text-slate-400 border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                      >
                        <option value="AI 对话生成">AI 对话生成</option>
                        <option value="科室扫码报修">科室扫码报修</option>
                        <option value="电话登记">电话登记</option>
                        <option value="微信小程序">微信小程序</option>
                        <option value="工程师手工录入">工程师手工录入</option>
                        <option value="供应商协同">供应商协同</option>
                        <option value="系统自动预警">系统自动预警</option>
                      </select>
                    </div>

                    <div>
                      <label className="text-[10px] font-bold text-slate-500 block mb-1">紧急程度</label>
                      <select 
                        value={draftTicket.urgency || '普通'}
                        onChange={(e) => handleUpdateDraftField('urgency', e.target.value)}
                        className={`w-full bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none ${
                          draftTicket.urgency === '特急' ? 'text-red-600 font-bold' :
                          draftTicket.urgency === '紧急' ? 'text-orange-500 font-semibold' : 'text-slate-700'
                        }`}
                      >
                        <option value="普通">普通</option>
                        <option value="紧急">紧急</option>
                        <option value="特急">特急</option>
                      </select>
                    </div>

                    <div>
                      <label className="text-[10px] font-bold text-slate-500 block mb-1">影响临床</label>
                      <select 
                        value={draftTicket.affectClinical || '否'}
                        onChange={(e) => handleUpdateDraftField('affectClinical', e.target.value)}
                        className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                      >
                        <option value="是">是 (影响临床)</option>
                        <option value="否">否 (暂无大碍)</option>
                      </select>
                    </div>

                    <div className="col-span-2 bg-slate-50 border border-slate-200/80 p-2.5 rounded-xl space-y-1">
                      <label className="text-[10px] font-extrabold text-blue-600 block mb-1 uppercase tracking-wider flex items-center gap-1">
                        <Activity className="w-3.5 h-3.5 text-blue-500 animate-pulse" />
                        <span>🔗 关联并同步在册资产电子档案</span>
                      </label>
                      <select
                        className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-blue-500 font-medium"
                        value={visibleEquipments.find(eq => eq.id === draftTicket.deviceId || eq.sn === draftTicket.deviceId)?.id || ''}
                        onChange={(e) => {
                          const selected = visibleEquipments.find(eq => eq.id === e.target.value);
                          if (selected) {
                            handleUpdateDraftField('deviceName', `${selected.manufacturer} ${selected.deviceName} (${selected.model})`);
                            handleUpdateDraftField('deviceId', selected.id, { allowClinicalAssetId: true });
                            handleUpdateDraftField('department', selected.dept);
                            if (selected.riskLevel === '高') {
                              handleUpdateDraftField('urgency', '紧急');
                            }
                            if (selected.category === '急救生命支持') {
                              handleUpdateDraftField('affectClinical', '是');
                            }
                          }
                        }}
                      >
                        <option value="">-- 手动录入，或选择档案库中的在册设备 --</option>
                        {visibleEquipments.map((eq: any) => (
                          <option key={eq.id} value={eq.id}>
                            [{eq.dept}] {eq.manufacturer} {eq.deviceName} ({eq.model}) - {eq.sn}
                          </option>
                        ))}
                      </select>
                      {visibleEquipments.length === 0 && (
                        <p className="text-[9px] text-amber-600 mt-1 font-medium">当前账号暂无可关联的本科室在册资产，可继续手动录入设备名称并提交。</p>
                      )}
                      <p className="text-[9px] text-slate-400 mt-1">💡 绑定在册设备能自动带入科室、SN、安全评级等，完成一站式闭环归档。</p>
                    </div>

                    <div>
                      <label className="text-[10px] font-bold text-slate-500 block mb-1">申报科室</label>
                      <input 
                        type="text" 
                        value={draftTicket.department || ''} 
                        placeholder="请输入申报科室"
                        onChange={(e) => handleUpdateDraftField('department', e.target.value)}
                        disabled={currentUserRole === 'medical_staff'}
                        className="w-full bg-white disabled:bg-slate-100 disabled:text-slate-400 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800"
                      />
                    </div>

                    <div>
                      <label className="text-[10px] font-bold text-slate-500 block mb-1">物理位置</label>
                      <input 
                        type="text" 
                        value={draftTicket.location || ''} 
                        placeholder="如：住院部3楼"
                        onChange={(e) => handleUpdateDraftField('location', e.target.value)}
                        className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800"
                      />
                    </div>

                    <div className="col-span-2">
                      <label className="text-[10px] font-bold text-slate-500 block mb-1">设备名称 (品牌型号)</label>
                      <input 
                        type="text" 
                        value={draftTicket.deviceName || ''} 
                        placeholder="如：德尔格呼吸机"
                        onChange={(e) => handleUpdateDraftField('deviceName', e.target.value)}
                        className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 font-medium"
                      />
                    </div>

                    <div>
                      <label className="text-[10px] font-bold text-slate-500 block mb-1">设备资产编号</label>
                      <input 
                        type="text" 
                        value={draftTicket.deviceId || ''} 
                        placeholder="如：EQ-1022"
                        onChange={(e) => handleUpdateDraftField('deviceId', e.target.value)}
                        disabled={currentUserRole === 'medical_staff'}
                        className="w-full bg-white disabled:bg-slate-100 disabled:text-slate-400 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 font-mono"
                      />
                      {currentUserRole === 'medical_staff' && (
                        <p className="text-[9px] text-slate-400 mt-1">临床端不可手动改写资产编号；请通过上方本科室在册资产选择同步。</p>
                      )}
                    </div>

                    <div>
                      <label className="text-[10px] font-bold text-slate-500 block mb-1">科室联系人</label>
                      <input 
                        type="text" 
                        value={draftTicket.contactPerson || ''} 
                        placeholder="张医生"
                        onChange={(e) => handleUpdateDraftField('contactPerson', e.target.value)}
                        disabled={currentUserRole === 'medical_staff'}
                        className="w-full bg-white disabled:bg-slate-100 disabled:text-slate-400 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800"
                      />
                    </div>

                    <div className="col-span-2">
                      <label className="text-[10px] font-bold text-slate-500 block mb-1">联系人电话 / 医院内线</label>
                      <input 
                        type="text" 
                        value={draftTicket.contactPhone || ''} 
                        placeholder="如：13800138000"
                        onChange={(e) => handleUpdateDraftField('contactPhone', e.target.value)}
                        disabled={currentUserRole === 'medical_staff'}
                        className="w-full bg-white disabled:bg-slate-100 disabled:text-slate-400 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 font-mono"
                      />
                    </div>

                    <div className="col-span-2">
                      <label className="text-[10px] font-bold text-slate-500 block mb-1">故障现象详细描述</label>
                      <textarea 
                        value={draftTicket.faultPhenomenon || ''} 
                        rows={3}
                        placeholder="请描述具体故障表现..."
                        onChange={(e) => handleUpdateDraftField('faultPhenomenon', e.target.value)}
                        className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 resize-none focus:outline-none"
                      />
                    </div>
                  </div>
                </div>

                {/* Department recommendation alert */}
                {forwardDept && (
                  <div className="px-3.5 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-800">
                    <span className="font-bold block mb-0.5">⚠️ 跨部门流转建议:</span>
                    AI 判断此故障属于【{forwardDept}】的受理范围，不属于医学装备科核心职责。确认生成后将自动处理。
                  </div>
                )}

                {/* AI Suggestions Preview */}
                {aiSuggestions.length > 0 && (
                  <div className="bg-emerald-50/40 border border-emerald-100 rounded-xl p-3.5 text-xs text-slate-700 space-y-1.5">
                    <h4 className="text-xs font-bold text-emerald-950 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-emerald-600 animate-pulse" />
                      AI 智能处置预案 (预览)：
                    </h4>
                    <ul className="space-y-1">
                      {aiSuggestions.map((sug, idx) => (
                        <li key={idx} className="flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-600">
                          <span className="text-emerald-500 font-bold shrink-0">•</span>
                          <span>{sug}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* Action trigger button */}
              <div className="p-3.5 bg-slate-50 border-t border-slate-100 shrink-0">
                <button
                  onClick={handleCreateTicketFromDraft}
                  className="w-full bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-semibold py-2.5 px-4 text-xs md:text-sm rounded-lg transition shadow-md shadow-emerald-600/5 flex items-center justify-center gap-2 cursor-pointer"
                  id="btn-confirm-ticket"
                >
                  <Check className="w-4 h-4" />
                  确认生成任务 (进入中间任务池)
                </button>
              </div>
            </div>
          ) : selectedTask ? (
            /* Selected Task Detail View */
            <div className="flex flex-col h-full overflow-hidden">
              
              {/* Profile Header */}
              <div className="p-4 bg-slate-900 text-white shrink-0">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] bg-slate-800 border border-slate-700 text-slate-300 font-mono px-2 py-0.5 rounded font-semibold">
                      {selectedTask.id}
                    </span>
                    <span className="text-xs text-slate-400">已于 {new Date(selectedTask.createdAt).toLocaleString('zh-CN', { hour12: false }).slice(5, 16)} 录入</span>
                  </div>
                  
                  <button
                    onClick={() => handleDeleteTask(selectedTask.id)}
                    className="p-1.5 text-slate-400 hover:text-red-400 rounded-lg hover:bg-slate-800 transition"
                    title="删除工单"
                    id={`btn-delete-${selectedTask.id}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                <h3 className="text-base font-extrabold text-white flex items-center gap-1.5">
                  <Activity className="w-5 h-5 text-emerald-400" />
                  {selectedTask.deviceName}
                </h3>
                <p className="text-xs text-slate-300 mt-1 flex items-center gap-1">
                  <Building2 className="w-3.5 h-3.5 text-slate-400" />
                  <span>{selectedTask.department}</span>
                  {selectedTask.location && <span className="text-slate-400">• {selectedTask.location}</span>}
                </p>
              </div>

              {/* Status and Action Quick Controllers */}
              <div className="bg-slate-50 p-3 border-b border-slate-100 shrink-0">
                <div className="flex flex-col gap-1.5 mb-2">
                  <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">流转状态快速调节器：</p>
                  <div className="text-[11px] text-slate-600 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 flex items-center gap-1.5">
                    <Info className="w-3.5 h-3.5 text-sky-500 shrink-0" />
                    <span>{getEngineerWorkflowHint(selectedTask)}</span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {([
                    '待确认', '待派工', '已派工', '处理中', '待科室验收', '已完成', '已归档', '已关闭'
                  ] as TaskStatus[]).map((st) => {
                    const blockReason = getEngineerStatusBlockReason(selectedTask, st);
                    const isCurrentStatus = selectedTask.status === st;
                    const isBlocked = !!blockReason;
                    const isNextStatus = st === getEngineerNextStatus(selectedTask);
                    return (
                      <button
                        key={st}
                        onClick={() => handleUpdateStatus(st)}
                        disabled={isCurrentStatus || isBlocked}
                        title={isCurrentStatus ? '当前状态' : (blockReason || `切换至${st}`)}
                        className={`text-[11px] px-2.5 py-1 rounded-lg font-semibold border transition ${
                          isCurrentStatus
                            ? 'bg-slate-900 border-slate-900 text-white shadow-xs cursor-default'
                            : isNextStatus
                              ? 'bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100 cursor-pointer shadow-xs'
                            : isBlocked
                              ? 'bg-slate-100 border-slate-200 text-slate-300 cursor-not-allowed'
                              : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 cursor-pointer'
                        }`}
                        id={`status-set-${st}`}
                      >
                        {st}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Scrollable Details & Timeline Log Area */}
              <div className="flex-1 overflow-y-auto p-4 space-y-5">

                {/* 双向数据穿透：关联医学装备数字档案卡 */}
                {(() => {
                  const requiresClinicalAcceptance = needsClinicalAcceptance(selectedTask);
                  const matchedEquip = requiresClinicalAcceptance
                    ? allEquipments.find(eq => eq.id === selectedTask.deviceId || eq.sn === selectedTask.deviceId || (eq.deviceName === selectedTask.deviceName && isSameDepartment(eq.dept, selectedTask.department)))
                    : null;
                  if (matchedEquip) {
                    return (
                      <div className="bg-gradient-to-tr from-emerald-50 to-teal-50/40 border border-emerald-200/60 p-3 rounded-xl flex items-center justify-between gap-3 shadow-xs">
                        <div className="space-y-0.5">
                          <div className="text-[10px] font-bold text-emerald-800 flex items-center gap-1">
                            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 animate-pulse" />
                            <span>已自动关联全生命周期电子档案</span>
                          </div>
                          <p className="text-[11px] text-slate-700 font-semibold truncate max-w-[200px]">
                            {matchedEquip.manufacturer} {matchedEquip.deviceName} ({matchedEquip.model})
                          </p>
                          <p className="text-[9px] text-slate-400 font-mono">资产ID: {matchedEquip.id.toUpperCase()} • 风险评级: {matchedEquip.riskLevel}级</p>
                        </div>
                        <button
                          onClick={() => openLinkedEquipmentArchive(matchedEquip.id)}
                          className="flex items-center gap-1 text-[11px] font-extrabold bg-emerald-600 hover:bg-emerald-700 text-white px-2.5 py-1.5 rounded-lg transition cursor-pointer shrink-0 shadow-sm"
                        >
                          <FileText className="w-3.5 h-3.5" />
                          <span>查看档案</span>
                        </button>
                      </div>
                    );
                  } else {
                    return (
                      <div className="bg-slate-50 border border-slate-200 p-3 rounded-xl flex items-center justify-between gap-3">
                        <div className="space-y-0.5">
                          <div className="text-[10px] font-bold text-slate-500">
                            {requiresClinicalAcceptance ? '设备电子档案未关联' : '非设备转派单不绑定设备档案'}
                          </div>
                          <p className="text-[11px] text-slate-600 font-medium">
                            {requiresClinicalAcceptance
                              ? '当前工单尚未绑定医院在册设备。'
                              : `此单已转派${selectedTask.recommendedDept || '责任科室'}处理，仅保留流转记录，不写入医学设备维修档案。`}
                          </p>
                        </div>
                        {requiresClinicalAcceptance && (
                          <button
                            onClick={() => {
                              setCurrentWorkspace('archives');
                            }}
                            className="flex items-center gap-1 text-[11px] font-semibold bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 px-2.5 py-1.5 rounded-lg transition cursor-pointer shrink-0"
                          >
                            <Plus className="w-3.5 h-3.5 text-slate-400" />
                            <span>检索建档</span>
                          </button>
                        )}
                      </div>
                    );
                  }
                })()}
                
                {/* 1. Core Profile Details Card */}
                <div className="bg-slate-50 border border-slate-100 rounded-xl p-3.5 space-y-2.5 text-xs text-slate-700">
                  <h4 className="text-xs font-bold text-slate-900 border-b border-slate-200/60 pb-1.5 flex items-center gap-1">
                    <FileText className="w-3.5 h-3.5 text-slate-500" />
                    任务工单详细流转明细
                  </h4>

                  <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                    <div>
                      <span className="text-slate-400 block text-[10px]">任务分类</span>
                      <span className="font-semibold text-slate-800">{selectedTask.taskType}</span>
                    </div>

                    <div>
                      <span className="text-slate-400 block text-[10px]">设备资产编号</span>
                      <span className="font-mono font-semibold text-slate-800">{selectedTask.deviceId}</span>
                    </div>

                    <div>
                      <span className="text-slate-400 block text-[10px]">紧急程度</span>
                      <span className={`font-bold ${
                        selectedTask.urgency === '特急' ? 'text-red-600' :
                        selectedTask.urgency === '紧急' ? 'text-orange-500' : 'text-slate-700'
                      }`}>
                        {selectedTask.urgency}
                      </span>
                    </div>

                    <div>
                      <span className="text-slate-400 block text-[10px]">是否直接影响临床</span>
                      <span className="font-semibold text-slate-800">{selectedTask.affectClinical}</span>
                    </div>

                    <div>
                      <span className="text-slate-400 block text-[10px]">科室联系人</span>
                      <span className="font-semibold text-slate-800">{selectedTask.contactPerson}</span>
                    </div>

                    <div>
                      <span className="text-slate-400 block text-[10px]">联系电话 / 内线</span>
                      <span className="font-mono font-semibold text-slate-800">{selectedTask.contactPhone || '未填写'}</span>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-200/60">
                    <span className="text-slate-400 block text-[10px] mb-0.5">申报故障现象描述</span>
                    <p className="bg-white p-2 rounded border border-slate-100 font-sans leading-relaxed text-slate-800 text-xs font-medium">
                      {selectedTask.faultPhenomenon}
                    </p>
                  </div>
                </div>

                {/* 2. AI Suggestions List (Part 3) */}
                {selectedTask.aiSuggestions && selectedTask.aiSuggestions.length > 0 && (
                  <div className="bg-emerald-50/40 border border-emerald-100 rounded-xl p-3.5 text-xs text-slate-700 space-y-2">
                    <h4 className="text-xs font-bold text-emerald-950 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-emerald-600 animate-pulse" />
                      AI 智能处理建议 (AI Suggestions)
                    </h4>
                    <ul className="space-y-1.5">
                      {selectedTask.aiSuggestions.map((sug, idx) => (
                        <li key={idx} className="flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-700">
                          <span className="text-emerald-500 font-bold shrink-0 mt-0.5">•</span>
                          <span>{sug}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {needsClinicalAcceptance(selectedTask) && ['已完成', '已归档', '已关闭'].includes(selectedTask.status) && (() => {
                  const acceptance = getTaskAcceptanceDisplay(selectedTask);

                  return (
                    <div className="bg-emerald-50/40 border border-emerald-100 rounded-xl p-3.5 text-xs text-slate-700 flex items-start gap-3">
                      <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                      <div>
                        <h4 className="text-xs font-bold text-slate-800">临床已闭环验收</h4>
                        <div className="flex items-center gap-1.5 mt-1">
                          <span className="text-[11px] text-slate-500">满意度:</span>
                          <div className="flex items-center">
                            {[1, 2, 3, 4, 5].map((star) => (
                              <Star key={star} className={`w-3.5 h-3.5 ${star <= acceptance.rating ? 'text-amber-400 fill-amber-400' : 'text-slate-200'}`} />
                            ))}
                          </div>
                          <span className="text-[10px] text-slate-400">
                            {acceptance.acceptedBy} · {new Date(acceptance.acceptedAt).toLocaleDateString('zh-CN')}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-600 mt-1.5">
                          “ {acceptance.comment} ”
                        </p>
                      </div>
                    </div>
                  );
                })()}

                {/* 3. Task Activity Logs & Timeline */}
                <div className="space-y-3">
                  <h4 className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-slate-500" />
                    任务闭环流转日志 ({selectedTask.logs.length} 条记录)
                  </h4>

                  {/* Vertical Timeline */}
                  <div className="relative pl-3 border-l-2 border-slate-200/80 space-y-4 text-xs">
                    {selectedTask.logs.map((log, idx) => (
                      <div key={idx} className="relative">
                        {/* Bullet circle dot */}
                        <div className="absolute -left-[17px] top-1 w-2.5 h-2.5 bg-slate-300 rounded-full border-2 border-white" />
                        
                        <div className="space-y-0.5">
                          <div className="flex items-center justify-between text-[11px] text-slate-400">
                            <span className="font-mono">{log.time}</span>
                            <span className="bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded text-[10px] font-medium">{log.operator}</span>
                          </div>
                          <p className="text-slate-800 leading-relaxed text-[11px] font-medium bg-slate-50 p-2 rounded border border-slate-100">
                            {log.action}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* AI Extracted Structural Info block (Requirement 4) */}
                  <div className="mt-4 pt-4 border-t border-slate-200/60" id="ai-extracted-info-block">
                    <details className="text-xs text-slate-500 bg-slate-50 p-3 rounded-xl border border-slate-100 cursor-pointer">
                      <summary className="text-[11px] font-bold select-none text-slate-600 flex items-center justify-between">
                        <span className="flex items-center gap-1.5">
                          <Sparkles className="w-3.5 h-3.5 text-emerald-600" />
                          AI 自动提取的任务信息
                        </span>
                        <span className="text-[9px] text-slate-400 font-normal">展开查看</span>
                      </summary>
                      <div className="mt-2.5 space-y-2.5 bg-white p-3 rounded-lg border border-slate-100 text-[11px] text-slate-700">
                        <div className="grid grid-cols-2 gap-2">
                          <div><span className="text-slate-400 font-medium">任务分类:</span> <span className="font-bold text-slate-900">{selectedTask.taskType}</span></div>
                          <div><span className="text-slate-400 font-medium">工单来源:</span> <span className="font-bold text-slate-900">{selectedTask.source || 'AI 对话生成'}</span></div>
                          <div><span className="text-slate-400 font-medium">申报科室:</span> <span className="font-bold text-slate-900">{selectedTask.department}</span></div>
                          <div><span className="text-slate-400 font-medium">设备名称:</span> <span className="font-bold text-slate-900">{selectedTask.deviceName}</span></div>
                          <div><span className="text-slate-400 font-medium">设备编号:</span> <span className="font-mono font-bold text-slate-900">{selectedTask.deviceId}</span></div>
                          <div><span className="text-slate-400 font-medium">紧急程度:</span> <span className="font-bold text-slate-900">{selectedTask.urgency}</span></div>
                          <div><span className="text-slate-400 font-medium">临床影响:</span> <span className="font-bold text-slate-900">{selectedTask.affectClinical}</span></div>
                          <div><span className="text-slate-400 font-medium">联系人员:</span> <span className="font-bold text-slate-900">{selectedTask.contactPerson}</span></div>
                        </div>
                        <div className="border-t border-slate-100 pt-2 text-[10px]">
                          <span className="text-slate-400 font-medium block mb-1">系统提炼原始文本摘要:</span>
                          <p className="bg-slate-50 p-2 rounded text-slate-600 leading-relaxed font-mono">{selectedTask.rawText || '系统口语化输入转义'}</p>
                        </div>
                      </div>
                    </details>
                  </div>
                </div>

              </div>

              {/* Manual Update form footer */}
              <div className="p-4 bg-slate-50 border-t border-slate-100 shrink-0">
                <form onSubmit={handleAddLog} className="space-y-2">
                  <p className="text-[11px] font-bold text-slate-500 flex items-center gap-1">
                    <Plus className="w-3 h-3" />
                    {isTaskTerminal(selectedTask) ? '工单已归档锁定：' : '录入维修进度 / 跟踪事件：'}
                  </p>
                  
                  <div className="flex gap-2">
                    <input 
                      type="text" 
                      placeholder="操作人" 
                      value={activeLogOperator}
                      onChange={(e) => setActiveLogOperator(e.target.value)}
                      disabled={isTaskTerminal(selectedTask)}
                      className="w-1/3 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-slate-400"
                      id="log-operator-input"
                    />
                    <input 
                      type="text" 
                      placeholder={isTaskTerminal(selectedTask) ? '已归档或已关闭，不能再追加日志' : '录入进度日志...'} 
                      value={activeLogAction}
                      onChange={(e) => setActiveLogAction(e.target.value)}
                      disabled={isTaskTerminal(selectedTask)}
                      className="flex-1 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-slate-400"
                      id="log-action-input"
                    />
                    <button 
                      type="submit"
                      disabled={!activeLogAction.trim() || isTaskTerminal(selectedTask)}
                      title={isTaskTerminal(selectedTask) ? '已归档或已关闭工单不能再追加日志' : '记录工单处置日志'}
                      className="bg-slate-900 hover:bg-slate-800 text-white disabled:bg-slate-200 disabled:text-slate-400 text-xs font-semibold px-3 py-1.5 rounded-lg transition shrink-0 cursor-pointer"
                      id="btn-add-log-submit"
                    >
                      记录
                    </button>
                  </div>
                </form>
              </div>

            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 p-6 text-center">
              <FileText className="w-12 h-12 text-slate-300 mb-2 animate-pulse" />
              <p className="text-sm">尚未选定任何任务单</p>
              <p className="text-xs text-slate-400 mt-1">请从左侧列表选定，或者在AI聊天区创建新的任务单。</p>
            </div>
          )}
        </div>

      </main>

      {/* Mobile Sticky Bottom Tab Bar */}
      <nav className="xl:hidden bg-slate-900 border-t border-slate-800 grid grid-cols-3 py-2 shrink-0" id="mobile-tabs-nav">
        <button
          onClick={() => setMobileTab('chat')}
          className={`flex flex-col items-center justify-center py-1 transition cursor-pointer ${
            mobileTab === 'chat' ? 'text-emerald-400' : 'text-slate-400 hover:text-slate-300'
          }`}
          id="btn-tab-chat"
        >
          <Sparkles className="w-5 h-5" />
          <span className="text-[10px] mt-1 font-medium">AI 快速受理</span>
        </button>

        <button
          onClick={() => setMobileTab('list')}
          className={`flex flex-col items-center justify-center py-1 transition relative cursor-pointer ${
            mobileTab === 'list' ? 'text-emerald-400' : 'text-slate-400 hover:text-slate-300'
          }`}
          id="btn-tab-list"
        >
          <FileText className="w-5 h-5" />
          <span className="text-[10px] mt-1 font-medium">任务看板</span>
          {visibleTasks.length > 0 && (
            <span className="absolute top-0 right-[20%] bg-rose-500 text-white font-extrabold text-[9px] min-w-[16px] h-[16px] rounded-full flex items-center justify-center px-1 border border-slate-900 scale-90">
              {visibleTasks.length}
            </span>
          )}
        </button>

        <button
          onClick={() => setMobileTab('detail')}
          className={`flex flex-col items-center justify-center py-1 transition relative cursor-pointer ${
            mobileTab === 'detail' ? 'text-emerald-400' : 'text-slate-400 hover:text-slate-300'
          }`}
          id="btn-tab-detail"
        >
          <Activity className="w-5 h-5" />
          <span className="text-[10px] mt-1 font-medium">详情及日志</span>
          {selectedTask && (
            <span className="absolute top-1 right-[25%] w-2 h-2 bg-amber-500 rounded-full" />
          )}
        </button>
      </nav>

      {/* Structured JSON Payload Schema documentation in footer */}
      <footer className="bg-slate-900 text-slate-400 text-xs px-6 py-4 border-t border-slate-800 flex-col md:flex-row items-center justify-between gap-4 shrink-0 hidden xl:flex">
        <div>
          <p>© 2026 县级医院医学装备科智能工作台 - 闭环工单分析引擎 | <span className="text-emerald-400 font-bold font-mono">v0.3.1 COMPACT_AI_TASK_DRAFT</span></p>
          <p className="text-[11px] text-slate-500 mt-0.5">本助手严格依据设备安全管理条例、生命支持设备响应规范，由医学装备 AI 强力驱动。</p>
        </div>
        <div className="flex items-center gap-4 text-[11px]">
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 bg-emerald-500 rounded-full"></span>
            AI 分析内核已就绪
          </span>
          <span>系统响应时效：10分钟内 (特急)</span>
        </div>
      </footer>
    </>
  )}
      </div>

      {/* 14-Field Full Draft Modal (Requirement 5, 6) */}
      {isFullDraftOpen && draftTicket && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4 animate-fade-in" id="full-draft-modal">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-2xl w-full flex flex-col overflow-hidden max-h-[90vh]">
            
            {/* Modal Header */}
            <div className="bg-slate-900 text-white p-4 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-emerald-400" />
                <h3 className="font-bold text-sm md:text-base">AI 生成工单完整信息确认 (14个核心字段)</h3>
              </div>
              <button 
                type="button"
                onClick={() => setIsFullDraftOpen(false)}
                className="text-slate-400 hover:text-white transition text-lg"
              >
                ✕
              </button>
            </div>

            {/* Modal Body: Editable form with 14 fields */}
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <div className="text-xs text-slate-500 mb-2 flex items-center justify-between">
                <span>请核对并确认以下 14 个核心字段，可手动微调：</span>
                <span className="text-emerald-600 font-semibold bg-emerald-50 px-2 py-0.5 rounded">AI 自动提取</span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                
                {/* 1. 任务类型 */}
                <div>
                  <label className="text-slate-600 font-bold block mb-1 text-xs">1. 任务类型</label>
                  <select 
                    value={draftTicket.taskType || '设备报修'}
                    onChange={(e) => handleUpdateDraftField('taskType', e.target.value)}
                    disabled={currentUserRole === 'medical_staff'}
                    className="w-full bg-slate-50 disabled:bg-slate-100 disabled:text-slate-400 border border-slate-200 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none font-medium"
                  >
                    <option value="设备报修">设备报修</option>
                    <option value="生命支持设备应急">生命支持设备应急</option>
                    <option value="医用气体异常">医用气体异常</option>
                    <option value="验收安装协同">验收安装协同</option>
                    <option value="供应商协同">供应商协同</option>
                    <option value="计量/质控提醒">计量/质控提醒</option>
                    <option value="配件耗材申请">配件耗材申请</option>
                    <option value="普通杂项任务">普通杂项任务</option>
                    <option value="非设备类转派任务">非设备类转派任务</option>
                  </select>
                  {currentUserRole === 'medical_staff' && (
                    <p className="text-[9px] text-slate-400 mt-1">临床端由系统按故障描述自动判定任务类型，防止误转派绕过验收闭环。</p>
                  )}
                  {visibleEquipments.length === 0 && (
                    <p className="text-[9px] text-amber-700 mt-1 font-medium">当前账号暂无可关联的本科室在册资产，可继续手动录入设备信息。</p>
                  )}
                </div>

                {/* 2. 任务来源 */}
                <div>
                  <label className="text-slate-600 font-bold block mb-1 text-xs">2. 任务来源</label>
                  <select 
                    value={draftTicket.source || 'AI 对话生成'}
                    onChange={(e) => handleUpdateDraftField('source', e.target.value)}
                    disabled={currentUserRole === 'medical_staff'}
                    className="w-full bg-slate-50 disabled:bg-slate-100 disabled:text-slate-400 border border-slate-200 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none"
                  >
                    <option value="AI 对话生成">AI 对话生成</option>
                    <option value="科室扫码报修">科室扫码报修</option>
                    <option value="电话登记">电话登记</option>
                    <option value="微信小程序">微信小程序</option>
                    <option value="工程师手工录入">工程师手工录入</option>
                    <option value="供应商协同">供应商协同</option>
                  </select>
                </div>

                {/* 3. 科室 */}
                <div>
                  <label className="text-slate-600 font-bold block mb-1 text-xs">3. 申报科室</label>
                  <input 
                    type="text" 
                    value={draftTicket.department || ''} 
                    onChange={(e) => handleUpdateDraftField('department', e.target.value)}
                    placeholder="请输入科室，如：急诊科"
                    disabled={currentUserRole === 'medical_staff'}
                    className="w-full bg-slate-50 disabled:bg-slate-100 disabled:text-slate-400 border border-slate-200 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none"
                  />
                </div>

                {/* 4. 具体位置 */}
                <div>
                  <label className="text-slate-600 font-bold block mb-1 text-xs">4. 具体位置</label>
                  <input 
                    type="text" 
                    value={draftTicket.location || ''} 
                    onChange={(e) => handleUpdateDraftField('location', e.target.value)}
                    placeholder="请输入具体位置，如：急诊楼 1楼 抢救室"
                    className="w-full bg-slate-50 border border-slate-200 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none"
                  />
                </div>

                {/* 关联并同步在册资产电子档案 */}
                <div className="bg-emerald-50 border border-emerald-200 p-2.5 rounded-xl space-y-1">
                  <label className="text-[10px] font-extrabold text-emerald-800 block mb-1 uppercase tracking-wider flex items-center gap-1">
                    <Activity className="w-3.5 h-3.5 text-emerald-600 animate-pulse" />
                    <span>🔗 关联并同步在册资产电子档案</span>
                  </label>
                  <select
                    className="w-full bg-white border border-emerald-300 rounded-lg px-2 py-1.5 text-xs text-slate-800 focus:outline-none font-medium"
                    value={visibleEquipments.find(eq => eq.id === draftTicket.deviceId || eq.sn === draftTicket.deviceId)?.id || ''}
                    onChange={(e) => {
                      const selected = visibleEquipments.find(eq => eq.id === e.target.value);
                      if (selected) {
                        handleUpdateDraftField('deviceName', `${selected.manufacturer} ${selected.deviceName} (${selected.model})`);
                        handleUpdateDraftField('deviceId', selected.id, { allowClinicalAssetId: true });
                        handleUpdateDraftField('department', selected.dept);
                        if (selected.riskLevel === '高') {
                          handleUpdateDraftField('urgency', '紧急');
                        }
                        if (selected.category === '急救生命支持') {
                          handleUpdateDraftField('affectClinical', '是');
                        }
                      }
                    }}
                  >
                    <option value="">-- 搜索选择医院档案库中的在册设备 --</option>
                    {visibleEquipments.map((eq: any) => (
                      <option key={eq.id} value={eq.id}>
                        [{eq.dept}] {eq.manufacturer} {eq.deviceName} ({eq.model})
                      </option>
                    ))}
                  </select>
                </div>

                {/* 5. 设备名称 */}
                <div>
                  <label className="text-slate-600 font-bold block mb-1 text-xs">5. 设备名称</label>
                  <input 
                    type="text" 
                    value={draftTicket.deviceName || ''} 
                    onChange={(e) => handleUpdateDraftField('deviceName', e.target.value)}
                    placeholder="请输入设备名称，如：迈瑞监护仪"
                    className="w-full bg-slate-50 border border-slate-200 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none"
                  />
                </div>

                {/* 6. 设备编号 */}
                <div>
                  <label className="text-slate-600 font-bold block mb-1 text-xs">6. 设备编号</label>
                  <input 
                    type="text" 
                    value={draftTicket.deviceId || ''} 
                    onChange={(e) => handleUpdateDraftField('deviceId', e.target.value)}
                    placeholder="如：EQ-10023"
                    disabled={currentUserRole === 'medical_staff'}
                    className="w-full bg-slate-50 disabled:bg-slate-100 disabled:text-slate-400 border border-slate-200 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none font-mono"
                  />
                  {currentUserRole === 'medical_staff' && (
                    <p className="text-[9px] text-slate-400 mt-1">设备编号由在册资产选择或系统识别同步，临床端不可手动改写资产编号。</p>
                  )}
                </div>

                {/* 8. 是否影响临床 */}
                <div>
                  <label className="text-slate-600 font-bold block mb-1 text-xs">8. 是否影响临床</label>
                  <select 
                    value={draftTicket.affectClinical || '否'}
                    onChange={(e) => handleUpdateDraftField('affectClinical', e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none"
                  >
                    <option value="否">否 (不影响临床诊疗)</option>
                    <option value="是">是 (暂停服务/影响临床业务)</option>
                  </select>
                </div>

                {/* 9. 紧急程度 */}
                <div>
                  <label className="text-slate-600 font-bold block mb-1 text-xs">9. 紧急程度</label>
                  <select 
                    value={draftTicket.urgency || '普通'}
                    onChange={(e) => handleUpdateDraftField('urgency', e.target.value)}
                    className={`w-full bg-slate-50 border border-slate-200 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none font-semibold ${
                      draftTicket.urgency === '生命支持' ? 'text-red-600 font-bold' :
                      draftTicket.urgency === '特急' ? 'text-red-500' :
                      draftTicket.urgency === '紧急' ? 'text-orange-500 animate-pulse' : 'text-slate-700'
                    }`}
                  >
                    <option value="普通">普通 (24小时内解决)</option>
                    <option value="较急">较急 (4小时内解决)</option>
                    <option value="紧急">紧急 (2小时内解决)</option>
                    <option value="特急">特急 (立即响应解决)</option>
                    <option value="生命支持">生命支持 (10分钟内到达现场)</option>
                  </select>
                </div>

                {/* 10. 建议责任部门 */}
                <div>
                  <label className="text-slate-600 font-bold block mb-1 text-xs">10. 建议责任部门</label>
                  <input 
                    type="text" 
                    value={draftTicket.recommendedDept || forwardDept || '医学装备科'} 
                    onChange={(e) => {
                      handleUpdateDraftField('recommendedDept', e.target.value);
                      setForwardDept(e.target.value);
                    }}
                    disabled={currentUserRole === 'medical_staff'}
                    placeholder="如：医学装备科 / 后勤保障科 / 信息科"
                    className="w-full bg-slate-50 disabled:bg-slate-100 disabled:text-slate-400 border border-slate-200 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none font-semibold"
                  />
                  {currentUserRole === 'medical_staff' && (
                    <p className="text-[9px] text-slate-400 mt-1">临床端不可手动改派，系统会按故障描述自动判断是否转信息科或后勤。</p>
                  )}
                </div>

                {/* 11. 联系人 */}
                <div>
                  <label className="text-slate-600 font-bold block mb-1 text-xs">11. 联系人</label>
                  <input 
                    type="text" 
                    value={draftTicket.contactPerson || ''} 
                    onChange={(e) => handleUpdateDraftField('contactPerson', e.target.value)}
                    placeholder="请输入联系人姓名"
                    disabled={currentUserRole === 'medical_staff'}
                    className="w-full bg-slate-50 disabled:bg-slate-100 disabled:text-slate-400 border border-slate-200 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none"
                  />
                </div>

                {/* 12. 联系电话 */}
                <div>
                  <label className="text-slate-600 font-bold block mb-1 text-xs">12. 联系电话</label>
                  <input 
                    type="text" 
                    value={draftTicket.contactPhone || ''} 
                    onChange={(e) => handleUpdateDraftField('contactPhone', e.target.value)}
                    placeholder="请输入内线分机或手机号"
                    disabled={currentUserRole === 'medical_staff'}
                    className="w-full bg-slate-50 disabled:bg-slate-100 disabled:text-slate-400 border border-slate-200 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none font-mono"
                  />
                </div>

                {/* 13. 是否需要备用设备 */}
                <div>
                  <label className="text-slate-600 font-bold block mb-1 text-xs">13. 是否需要备用设备</label>
                  <select 
                    value={draftTicket.needBackupDevice || '否'}
                    onChange={(e) => handleUpdateDraftField('needBackupDevice', e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none"
                  >
                    <option value="否">否 (不需要借用备机)</option>
                    <option value="是">是 (需要设备科调配备用机)</option>
                  </select>
                </div>

                {/* 14. 是否需要厂家协同 */}
                <div>
                  <label className="text-slate-600 font-bold block mb-1 text-xs">14. 是否需要厂家协同</label>
                  <select 
                    value={draftTicket.needVendorCoop || '否'}
                    onChange={(e) => handleUpdateDraftField('needVendorCoop', e.target.value)}
                    disabled={currentUserRole === 'medical_staff'}
                    className="w-full bg-slate-50 disabled:bg-slate-100 disabled:text-slate-400 border border-slate-200 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none"
                  >
                    <option value="否">否 (院内自主维修保养)</option>
                    <option value="是">是 (需要通知厂家工程师协助)</option>
                  </select>
                  {currentUserRole === 'medical_staff' && (
                    <p className="text-[9px] text-slate-400 mt-1">厂家协同由系统按故障描述识别，并由医学装备科工程师复核联系。</p>
                  )}
                </div>

                {/* 7. 问题描述 / 故障现象 */}
                <div className="md:col-span-2">
                  <label className="text-slate-600 font-bold block mb-1 text-xs">7. 问题描述 / 故障现象</label>
                  <textarea 
                    value={draftTicket.faultPhenomenon || ''} 
                    onChange={(e) => handleUpdateDraftField('faultPhenomenon', e.target.value)}
                    rows={2}
                    placeholder="请输入设备具体故障现象，如：画面模糊、漏水、报错码等"
                    className="w-full bg-slate-50 border border-slate-200 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none resize-none leading-relaxed"
                  />
                </div>

              </div>
            </div>

            {/* Modal Footer */}
            <div className="bg-slate-50 px-6 py-4 border-t border-slate-100 flex items-center justify-end gap-2.5 shrink-0">
              <button
                type="button"
                onClick={() => setIsFullDraftOpen(false)}
                className="bg-white hover:bg-slate-100 active:bg-slate-200 text-slate-700 border border-slate-200 px-4 py-2 rounded-xl text-xs transition font-semibold cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsFullDraftOpen(false);
                  handleCreateTicketFromDraft();
                }}
                className="bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-bold px-5 py-2 rounded-xl text-xs transition cursor-pointer shadow-md shadow-emerald-700/15 flex items-center gap-1"
              >
                <Check className="w-4 h-4" />
                确认并创建工单
              </button>
            </div>

          </div>
        </div>
      )}

      {/* Simulated Identity Selector Modal */}
      {showSimulatedAuthModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4 transition-all animate-fade-in" id="modal-simulated-auth">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-100 max-w-md w-full overflow-hidden flex flex-col max-h-[90vh]">
            {/* Header */}
            <div className="bg-slate-900 text-white px-6 py-4 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <User className="w-5 h-5 text-emerald-400 animate-pulse" />
                <div className="text-left">
                  <h3 className="font-bold text-sm md:text-base">医院统一身份与角色模拟中心</h3>
                  <p className="text-[10px] text-slate-400">切换不同的真实岗位角色，闭环测试临床与装备科的业务交互</p>
                </div>
              </div>
              <button 
                onClick={() => setShowSimulatedAuthModal(false)}
                className="text-slate-400 hover:text-white transition p-1.5 rounded-lg hover:bg-slate-800 cursor-pointer text-sm"
              >
                ✕
              </button>
            </div>

            {/* Content */}
            <div className="p-6 overflow-y-auto space-y-4 text-xs text-slate-700 text-left">
              <p className="text-slate-500 text-[11px] leading-relaxed">
                医学装备智能化管理系统（闭环版）支持两端联动。您可以自由切换下方临床岗位与装备科主任角色：
              </p>

              <div className="space-y-2.5">
                {SIMULATED_USERS.map((user) => {
                  const isCurrent = user.id === currentSimulatedUserId;
                  return (
                    <button
                      key={user.id}
                      onClick={() => handleSwitchUser(user.id)}
                      className={`w-full text-left p-3.5 rounded-xl border transition flex items-center justify-between gap-3 cursor-pointer ${
                        isCurrent 
                          ? 'bg-emerald-50/60 border-emerald-500 text-slate-900 shadow-xs' 
                          : 'bg-white hover:bg-slate-50 border-slate-200 text-slate-600'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`w-9 h-9 rounded-full flex items-center justify-center text-white font-bold text-xs ${user.avatarColor} shrink-0 shadow-sm`}>
                          {user.name[0]}
                        </div>
                        <div>
                          <div className="font-bold text-slate-900 text-xs flex items-center gap-1.5">
                            <span>{user.name}</span>
                            <span className="text-[9px] bg-slate-100 text-slate-600 px-1.5 py-0.2 rounded font-normal font-mono">{user.id}</span>
                          </div>
                          <p className="text-[10px] text-slate-500 mt-0.5">{user.department} · {user.title}</p>
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                          user.role === 'medical_staff' 
                            ? 'bg-teal-100 text-teal-800' 
                            : 'bg-indigo-100 text-indigo-800'
                        }`}>
                          {user.role === 'medical_staff' ? '临床科室' : '装备科工程'}
                        </span>
                        {isCurrent && (
                          <div className="text-[9px] text-emerald-600 font-bold mt-1.5 flex items-center gap-0.5 justify-end">
                            <Check className="w-3.5 h-3.5" />
                            当前登录
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Footer */}
            <div className="bg-slate-50 px-6 py-4 border-t border-slate-100 flex items-center justify-end shrink-0">
              <button
                type="button"
                onClick={() => setShowSimulatedAuthModal(false)}
                className="bg-slate-900 hover:bg-slate-800 text-white font-semibold px-4 py-2 rounded-lg text-xs transition cursor-pointer shadow-sm"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AI Settings Modal */}
      {!isClinicalUser && isSettingsOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4 transition-all animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-100 max-w-lg w-full overflow-hidden flex flex-col max-h-[90vh]">
            {/* Header */}
            <div className="bg-slate-900 text-white px-6 py-4 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <Settings className="w-5 h-5 text-emerald-400 animate-spin" style={{ animationDuration: '6s' }} />
                <div className="text-left">
                  <h3 className="font-bold text-sm md:text-base">AI 智能配置中心</h3>
                  <p className="text-[10px] text-slate-400">自选云端大模型引擎、切换备用本地算法，配置 API 凭证</p>
                </div>
              </div>
              <button 
                onClick={() => setIsSettingsOpen(false)}
                className="text-slate-400 hover:text-white transition p-1.5 rounded-lg hover:bg-slate-800 cursor-pointer text-sm"
              >
                ✕
              </button>
            </div>

            {/* Content */}
            <div className="p-6 overflow-y-auto space-y-5 text-xs text-slate-700 text-left">
              {/* Feature info */}
              <div className="p-3.5 bg-emerald-50/50 border border-emerald-100 rounded-xl text-emerald-800 space-y-1">
                <p className="font-bold flex items-center gap-1.5 text-emerald-950">
                  <Sparkles className="w-3.5 h-3.5 text-emerald-600 animate-pulse" />
                  智能自适应决策与多模型路由系统
                </p>
                <p className="text-[11px] text-emerald-900/90 leading-relaxed">
                  本系统支持集成多种云端大模型并自主定义参数。面临限流或断网时，切换到<strong>“自适应离线机制”</strong>实现本地启发式毫秒级安全响应。
                </p>
              </div>

              {/* Provider Selection */}
              <div className="space-y-2">
                <label className="font-bold text-slate-800 block">1. 选择活跃的 AI 供应商 / 运行引擎</label>
                <select
                  value={activeProviderId}
                  onChange={(e) => {
                    setActiveProviderId(e.target.value);
                    clearTestResult();
                  }}
                  className="w-full bg-slate-50 border border-slate-200 focus:border-emerald-500 rounded-lg px-3 py-2 text-xs focus:outline-none font-medium text-slate-800 cursor-pointer"
                >
                  {providerConfigs.map((cfg) => (
                    <option key={cfg.id} value={cfg.id}>
                      {cfg.name} {activeProviderId === cfg.id ? ' (活跃中)' : ''}
                    </option>
                  ))}
                </select>
              </div>

              {/* Edit Active Config Form */}
              {(() => {
                const activeConfig = providerConfigs.find(c => c.id === activeProviderId) || providerConfigs[0];
                return (
                  <div className="p-4 bg-slate-50/60 border border-slate-150 rounded-2xl space-y-3">
                    <h4 className="font-bold text-slate-900 text-[11px] flex items-center gap-1.5 border-b border-slate-200/60 pb-1.5">
                      <Cpu className="w-3.5 h-3.5 text-emerald-600" />
                      当前大模型参数配置与管理
                    </h4>
                    
                    {/* Provider Name */}
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[10px] font-semibold text-slate-500 block mb-1">供应商名称</label>
                        <input
                          type="text"
                          value={activeConfig.name}
                          onChange={(e) => handleFieldChange(activeConfig.id, 'name', e.target.value)}
                          className="w-full bg-white border border-slate-200 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-[11px] focus:outline-none font-medium"
                          placeholder="请输入供应商名称"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-semibold text-slate-500 block mb-1 flex items-center gap-0.5">
                          官网链接 
                          {activeConfig.website && activeConfig.website !== 'offline' && (
                            <a href={activeConfig.website} target="_blank" rel="noopener noreferrer" className="text-emerald-600 inline-block">
                              <ExternalLink className="w-2.5 h-2.5 inline align-middle" />
                            </a>
                          )}
                        </label>
                        <input
                          type="text"
                          value={activeConfig.website}
                          onChange={(e) => handleFieldChange(activeConfig.id, 'website', e.target.value)}
                          className="w-full bg-white border border-slate-200 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-[11px] focus:outline-none font-mono"
                          placeholder="例如 https://platform.openai.com"
                        />
                      </div>
                    </div>

                    {/* API Key */}
                    <div>
                      <label className="text-[10px] font-semibold text-slate-500 block mb-1 flex items-center gap-1">
                        <Key className="w-3 h-3 text-slate-400" /> API Key 密钥
                      </label>
                      <input
                        type="password"
                        value={activeConfig.apiKey}
                        onChange={(e) => handleFieldChange(activeConfig.id, 'apiKey', e.target.value)}
                        className="w-full bg-white border border-slate-200 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-[11px] focus:outline-none font-mono"
                        placeholder={activeConfig.id === 'offline-default' ? "本地启发式算法模式无需密钥" : "请输入您的 API 密钥 (留空将使用系统预设)"}
                        disabled={activeConfig.id === 'offline-default'}
                      />
                    </div>

                    {/* API请求地址 */}
                    <div>
                      <label className="text-[10px] font-semibold text-slate-500 block mb-1">
                        API 请求地址 (支持自定义请求终结点，例如兼容 OpenAI Response 格式的地址)
                      </label>
                      <input
                        type="text"
                        value={activeConfig.endpoint}
                        onChange={(e) => handleFieldChange(activeConfig.id, 'endpoint', e.target.value)}
                        className="w-full bg-white border border-slate-200 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-[11px] focus:outline-none font-mono"
                        placeholder={activeConfig.id === 'offline-default' ? "离线降级方案，无需网络请求" : "例如 https://api.openai.com/v1"}
                        disabled={activeConfig.id === 'offline-default'}
                      />
                    </div>

                    {/* Model Name */}
                    <div>
                      <label className="text-[10px] font-semibold text-slate-500 block mb-1">
                        模型名称 (例如 gpt-5-codex, 留空将默认使用供应商默认大模型)
                      </label>
                      <input
                        type="text"
                        value={activeConfig.model}
                        onChange={(e) => handleFieldChange(activeConfig.id, 'model', e.target.value)}
                        className="w-full bg-white border border-slate-200 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-[11px] focus:outline-none font-mono"
                        placeholder={activeConfig.id === 'offline-default' ? "离线本地规则分析" : "例如 gemini-3.5-flash 或 gpt-4o"}
                        disabled={activeConfig.id === 'offline-default'}
                      />
                    </div>

                    {/* Context and Threshold */}
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[10px] font-semibold text-slate-500 block mb-1">
                          上下文容量限制 (保留最近几轮对话)
                        </label>
                        <input
                          type="number"
                          min="0"
                          max="50"
                          value={activeConfig.contextLimit}
                          onChange={(e) => handleFieldChange(activeConfig.id, 'contextLimit', Number(e.target.value))}
                          className="w-full bg-white border border-slate-200 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-[11px] focus:outline-none font-semibold text-slate-800"
                          disabled={activeConfig.id === 'offline-default'}
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-semibold text-slate-500 block mb-1">
                          文本压缩阈值 (字符数，超长将自动裁切)
                        </label>
                        <input
                          type="number"
                          min="500"
                          max="30000"
                          step="500"
                          value={activeConfig.compressThreshold}
                          onChange={(e) => handleFieldChange(activeConfig.id, 'compressThreshold', Number(e.target.value))}
                          className="w-full bg-white border border-slate-200 focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-[11px] focus:outline-none font-semibold text-slate-800"
                          disabled={activeConfig.id === 'offline-default'}
                        />
                      </div>
                    </div>

                    {/* Test Button & Diagnostics Panel */}
                    <div className="pt-2.5 border-t border-slate-200/60 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-slate-400">核验云端服务器 API 的通畅程度</span>
                        <button
                          type="button"
                          disabled={isTesting}
                          onClick={() => handleTestConfig(activeConfig)}
                          className="bg-slate-900 hover:bg-slate-800 active:bg-black text-white text-[10px] font-bold px-3 py-1.5 rounded-lg flex items-center gap-1 transition cursor-pointer disabled:opacity-50"
                        >
                          {isTesting ? (
                            <>
                              <Activity className="w-3 h-3 animate-pulse text-emerald-400" />
                              正在连接并测速...
                            </>
                          ) : (
                            <>
                              <Play className="w-3 h-3 text-emerald-400" />
                              进行模型连接与测速
                            </>
                          )}
                        </button>
                      </div>

                      {/* Test Result display */}
                      {testResult && (
                        <div className={`p-2.5 border rounded-xl text-[11px] leading-relaxed animate-fade-in ${
                          testResult.success 
                            ? 'bg-emerald-50/75 border-emerald-200 text-emerald-800' 
                            : 'bg-red-50/75 border-red-200 text-red-800'
                        }`}>
                          <div className="font-bold flex items-center justify-between">
                            <span>{testResult.success ? '✅ 连接测速成功' : '❌ 连接测试失败'}</span>
                            <span className="font-mono text-[10px] bg-slate-200/50 px-1 py-0.5 rounded text-slate-600">
                              耗时: {testResult.latency !== undefined ? `${testResult.latency}ms` : '未知'}
                            </span>
                          </div>
                          <p className="mt-1 font-sans text-[10px] text-slate-600 leading-normal">
                            {testResult.success ? testResult.message : (testResult.error || '连接请求失败。请核查 API Key 密钥、自定义请求地址、大模型名称或网络连接。')}
                          </p>
                        </div>
                      )}
                    </div>

                  </div>
                );
              })()}

              {/* Global Settings */}
              <div className="space-y-2">
                <label className="font-bold text-slate-800 block">2. 开发者与全局调试选项</label>
                <div className="space-y-2">
                  <label className="flex items-start gap-2.5 p-3 bg-slate-50 border border-slate-150 rounded-xl cursor-pointer hover:bg-slate-100/50 transition">
                    <input
                      type="checkbox"
                      checked={showRawPayload}
                      onChange={(e) => setShowRawPayload(e.target.checked)}
                      className="mt-0.5 accent-emerald-600 cursor-pointer"
                    />
                    <div>
                      <span className="font-semibold block text-slate-800 text-left">在会话中显示 AI 原始解析 JSON 结构体</span>
                      <span className="text-[10px] text-slate-400 mt-0.5 block leading-normal text-left">
                        勾选此项后，AI 助手的答复下方将提供卡片展示 14 个提取出的结构化 JSON 属性，方便校对与调试。
                      </span>
                    </div>
                  </label>

                  <button
                    type="button"
                    onClick={() => {
                      if (confirm('是否要将所有大模型配置恢复为系统出厂默认值？')) {
                        resetProviderConfigs();
                      }
                    }}
                    className="w-full text-slate-500 border border-slate-200 bg-white hover:bg-slate-50 hover:text-slate-700 py-1.5 rounded-lg text-[10px] transition font-medium cursor-pointer"
                  >
                    恢复出厂大模型预设
                  </button>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="bg-slate-50 px-6 py-4 border-t border-slate-100 flex items-center justify-between shrink-0">
              <span className="text-[10px] text-slate-400 flex items-center gap-1 font-mono">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                配置实时保存并本地持久化
              </span>
              <button
                type="button"
                onClick={() => setIsSettingsOpen(false)}
                className="bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-semibold px-4 py-2 rounded-lg text-xs transition cursor-pointer shadow-sm animate-pulse-once"
              >
                保存并关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Voice Repair Fallback / Simulation Modal */}
      {showVoiceMockModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4 transition-all animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-100 max-w-xl w-full overflow-hidden flex flex-col max-h-[90vh]">
            {/* Header */}
            <div className="bg-slate-900 text-white px-6 py-4 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <Mic className="w-5 h-5 text-emerald-400 animate-pulse" />
                <div className="text-left">
                  <h3 className="font-bold text-sm md:text-base">智能语音报修诊断中心</h3>
                  <p className="text-[10px] text-slate-400">支持手机口述、真机麦克风硬件识别及智能仿真演示环境</p>
                </div>
              </div>
              <button 
                onClick={() => {
                  setShowVoiceMockModal(false);
                  stopVoiceSimulation();
                }}
                className="text-slate-400 hover:text-white transition p-1.5 rounded-lg hover:bg-slate-800 cursor-pointer text-sm"
              >
                ✕
              </button>
            </div>

            {/* Content */}
            <div className="p-6 overflow-y-auto space-y-4 text-xs text-slate-700 text-left">
              
              {/* Device Support Status Header Badge */}
              <div className="flex items-center justify-between p-3 bg-slate-50 border border-slate-200/60 rounded-xl">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-slate-800">1. 手机与物理麦克风支持状态</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={`w-2.5 h-2.5 rounded-full ${speechSupported ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'}`} />
                  <span className={`font-semibold ${speechSupported ? 'text-emerald-700' : 'text-amber-700'}`}>
                    {speechSupported ? '已检测到 Web Speech API 运行库' : '麦克风被 iframe 隔离 / 不支持'}
                  </span>
                </div>
              </div>

              {!speechSupported && (
                <div className="p-3 bg-amber-50 border border-amber-100 rounded-xl text-[11px] text-amber-800 leading-relaxed">
                  <strong>ℹ️ 温馨提示：</strong>由于部分手机内置浏览器或 AI Studio 的沙箱 iframe 机制会锁定硬件麦克风权限，您在此可以使用我们为您定制的<strong>“100%全保真智能语音仿真引擎”</strong>，它完美模拟了临床一线医护人员的声音波形和实时分词效果！
                </div>
              )}

              {/* Real Mic Test Button if Speech is Supported */}
              {speechSupported && (
                <div className="p-3.5 bg-emerald-50/40 border border-emerald-100 rounded-xl flex items-center justify-between gap-3">
                  <div>
                    <h4 className="font-bold text-slate-900 text-xs">🎙️ 触发真实麦克风录音</h4>
                    <p className="text-[10px] text-slate-500 mt-0.5">如果您在手机端或已开启麦克风，点击右侧即可直接说话录音。</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setShowVoiceMockModal(false);
                      stopVoiceSimulation();
                      toggleListening();
                    }}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-3 py-1.5 rounded-lg text-[11px] transition shrink-0 cursor-pointer"
                  >
                    立即说话
                  </button>
                </div>
              )}

              {/* Mock Script Selection section */}
              <div className="space-y-2">
                <label className="font-bold text-slate-800 block">2. 选择科室一线故障口述剧本 (模拟临床真实发声)</label>
                <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                  {MOCK_VOICE_TEMPLATES.map((tpl, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => {
                        setSelectedMockScript(i);
                        stopVoiceSimulation();
                        setSimulationText('');
                      }}
                      className={`w-full text-left p-2.5 rounded-xl border text-[11px] transition cursor-pointer flex flex-col gap-1 ${
                        selectedMockScript === i 
                          ? 'bg-emerald-50/60 border-emerald-600 text-slate-900 font-medium' 
                          : 'bg-white hover:bg-slate-50 border-slate-200 text-slate-600'
                      }`}
                    >
                      <div className="font-bold text-slate-800 flex items-center justify-between">
                        <span>{tpl.title}</span>
                        {selectedMockScript === i && <span className="text-[9px] bg-emerald-100 text-emerald-800 px-1 py-0.2 rounded font-bold">已选</span>}
                      </div>
                      <p className="line-clamp-1 text-slate-500 text-[10px] italic">{tpl.text}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Dictation Monitor Area */}
              <div className="bg-slate-950 text-white rounded-2xl p-4 space-y-3.5 relative overflow-hidden">
                <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                  <div className="flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full ${isSimulating ? 'bg-red-500 animate-ping' : 'bg-slate-600'}`} />
                    <span className="text-[10px] font-mono tracking-wider text-slate-400">SPEECH TO TEXT LIVE MONITOR</span>
                  </div>
                  {isSimulating && (
                    <div className="flex items-end gap-0.5 h-3">
                      <span className="w-0.5 h-1.5 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-0.5 h-3.5 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-0.5 h-2.5 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                      <span className="w-0.5 h-1 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '450ms' }} />
                    </div>
                  )}
                </div>

                <div className="min-h-20 max-h-32 overflow-y-auto text-sm font-sans leading-relaxed text-slate-100 select-text text-left py-1 whitespace-pre-wrap">
                  {simulationText || (
                    <span className="text-slate-500 italic text-xs">
                      {isSimulating ? '语音录入初始化中...' : '点击左下方“开始仿真语音录制”进行听写演示，或在此直接手动输入/编辑。'}
                    </span>
                  )}
                </div>

                {/* Simulated text modification */}
                {!isSimulating && (
                  <textarea
                    value={simulationText}
                    onChange={(e) => setSimulationText(e.target.value)}
                    placeholder="或在此处直接进行语音听写修正..."
                    className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-xs text-slate-200 focus:outline-none resize-none font-sans"
                    rows={2}
                  />
                )}
              </div>

            </div>

            {/* Modal Footer */}
            <div className="bg-slate-50 px-6 py-4 border-t border-slate-100 flex items-center justify-between shrink-0">
              <button
                type="button"
                onClick={() => {
                  startSimulation(MOCK_VOICE_TEMPLATES[selectedMockScript].text);
                }}
                disabled={isSimulating}
                className="bg-slate-900 hover:bg-slate-800 disabled:bg-slate-200 text-white disabled:text-slate-400 px-4 py-2 rounded-xl text-xs transition font-semibold cursor-pointer flex items-center gap-1.5"
              >
                <Play className="w-3.5 h-3.5 text-emerald-400" />
                {isSimulating ? '正在进行仿真录音...' : '开始仿真语音录制'}
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowVoiceMockModal(false);
                    stopVoiceSimulation();
                  }}
                  className="bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 px-4 py-2 rounded-xl text-xs transition font-semibold cursor-pointer"
                >
                  关闭
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const finalInput = simulationText || MOCK_VOICE_TEMPLATES[selectedMockScript].text;
                    setInputMessage(finalInput);
                    setShowVoiceMockModal(false);
                    stopVoiceSimulation();
                    // trigger send message instantly for the full automated flow requested by user
                    handleSendMessage(finalInput);
                  }}
                  className="bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-bold px-4 py-2 rounded-xl text-xs transition cursor-pointer shadow-md shadow-emerald-700/15"
                >
                  确认填入并由 AI 分析
                </button>
              </div>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}