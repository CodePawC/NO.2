/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { StructuredTicket, UserProfile } from '../types';
import { ShieldCheck, AlertTriangle, Play, CheckCircle2, Clock } from 'lucide-react';
import { isSameDepartment } from '../utils/departmentUtils';
import { needsClinicalAcceptance } from '../utils/taskWorkflow';

interface TaskStatsProps {
  tasks: StructuredTicket[];
  userRole?: 'clinical' | 'engineer' | 'medical_staff';
  simulatedUser?: UserProfile;
}

export default function TaskStats({ tasks, userRole = 'engineer', simulatedUser }: TaskStatsProps) {
  const isClinical = userRole === 'clinical' || userRole === 'medical_staff';
  const deptName = simulatedUser?.department || simulatedUser?.dept || '科室';
  
  // Filter tasks based on role: clinical users only see their own department's statistics
  const displayTasks = isClinical 
    ? tasks.filter(t => isSameDepartment(t.department, deptName))
    : tasks;

  const total = displayTasks.length;
  const pending = displayTasks.filter((t) => t.status === '待确认' || t.status === '待派工').length;
  const inProgress = displayTasks.filter((t) => t.status === '处理中' || t.status === '已派工' || t.status === '待科室验收').length;
  const completed = displayTasks.filter((t) => t.status === '已完成' || t.status === '已归档' || t.status === '已关闭').length;

  const urgentCount = displayTasks.filter(
    (t) => needsClinicalAcceptance(t) && (t.urgency === '特急' || t.urgency === '紧急' || t.urgency === '生命支持') && t.status !== '已关闭' && t.status !== '已完成' && t.status !== '已归档'
  ).length;

  // Closure Rate calculation
  const closureRate = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-2 md:gap-3 mb-1 md:mb-2">
      <div className="bg-white p-3 md:p-4 rounded-xl border border-gray-100 shadow-xs flex items-start justify-between">
        <div>
          <p className="text-[10px] md:text-xs font-medium text-gray-500 uppercase tracking-wider">
            {isClinical ? '科室报修总量' : '全院任务总量'}
          </p>
          <h3 className="text-lg md:text-2xl font-bold text-gray-900 mt-1">{total}</h3>
          <p className="text-[10px] text-gray-400 mt-0.5">
            {isClinical ? `【${deptName}】累计提报` : '系统全量数据记录'}
          </p>
        </div>
        <div className={`p-1.5 md:p-2 rounded-lg ${isClinical ? 'bg-emerald-50 text-emerald-600' : 'bg-blue-50 text-blue-600'}`}>
          <Clock className="w-4 h-4 md:w-5 md:h-5" />
        </div>
      </div>

      <div className="bg-white p-3 md:p-4 rounded-xl border border-gray-100 shadow-xs flex items-start justify-between">
        <div>
          <p className="text-[10px] md:text-xs font-medium text-gray-500 uppercase tracking-wider">
            {isClinical ? '科室特急/紧急' : '全院特急/紧急'}
          </p>
          <h3 className={`text-lg md:text-2xl font-bold mt-1 ${urgentCount > 0 ? 'text-red-600 animate-pulse' : 'text-gray-950'}`}>{urgentCount}</h3>
          <p className="text-[10px] text-red-500 mt-0.5 font-medium">
            {isClinical ? '科室高危保障中' : '医学装备高危任务'}
          </p>
        </div>
        <div className="p-1.5 md:p-2 bg-red-50 text-red-600 rounded-lg">
          <AlertTriangle className="w-4 h-4 md:w-5 md:h-5" />
        </div>
      </div>

      <div className="bg-white p-3 md:p-4 rounded-xl border border-gray-100 shadow-xs flex items-start justify-between">
        <div>
          <p className="text-[10px] md:text-xs font-medium text-gray-500 uppercase tracking-wider">
            {isClinical ? '科室待响应' : '全院待响应派单'}
          </p>
          <h3 className="text-lg md:text-2xl font-bold text-orange-600 mt-1">{pending}</h3>
          <p className="text-[10px] text-gray-400 mt-0.5">
            {isClinical ? '等待装备科接单' : '等待分配驻场工程师'}
          </p>
        </div>
        <div className="p-1.5 md:p-2 bg-orange-50 text-orange-600 rounded-lg">
          <Clock className="w-4 h-4 md:w-5 md:h-5 animate-pulse" />
        </div>
      </div>

      <div className="bg-white p-3 md:p-4 rounded-xl border border-gray-100 shadow-xs flex items-start justify-between">
        <div>
          <p className="text-[10px] md:text-xs font-medium text-gray-500 uppercase tracking-wider">
            {isClinical ? '工程师处置中' : '全院处理/协作中'}
          </p>
          <h3 className="text-lg md:text-2xl font-bold text-amber-600 mt-1">{inProgress}</h3>
          <p className="text-[10px] text-gray-400 mt-0.5">
            {isClinical ? '现场维修/厂家协同' : '驻场调配及厂家协同'}
          </p>
        </div>
        <div className="p-1.5 md:p-2 bg-amber-50 text-amber-600 rounded-lg">
          <Play className="w-4 h-4 md:w-5 md:h-5" />
        </div>
      </div>

      <div className="bg-white p-3 md:p-4 rounded-xl border border-gray-100 shadow-xs flex items-start justify-between col-span-2 md:col-span-1">
        <div>
          <p className="text-[10px] md:text-xs font-medium text-gray-500 uppercase tracking-wider">
            {isClinical ? '科室报修闭环率' : '全院服务闭环率'}
          </p>
          <h3 className="text-lg md:text-2xl font-bold text-green-600 mt-1">{closureRate}%</h3>
          <p className="text-[10px] text-green-500 mt-0.5">
            {isClinical ? `已闭环确认 ${completed} 单` : `已闭环结单 ${completed} 单`}
          </p>
        </div>
        <div className="p-1.5 md:p-2 bg-green-50 text-green-600 rounded-lg">
          <ShieldCheck className="w-4 h-4 md:w-5 md:h-5" />
        </div>
      </div>
    </div>
  );
}
