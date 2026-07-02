import React, { useState, useMemo } from 'react';
import { MaintenanceLog } from '../types';
import { TrendingUp, BarChart3, HelpCircle, DollarSign, PieChart, Info, ShieldAlert } from 'lucide-react';

interface BudgetStackedChartProps {
  maintenanceLogs: MaintenanceLog[];
  deviceName?: string;
}

export default function BudgetStackedChart({ maintenanceLogs, deviceName = '设备' }: BudgetStackedChartProps) {
  // Extract all available years from the logs, default to "2026"
  const availableYears = useMemo(() => {
    const yearsSet = new Set<string>();
    maintenanceLogs.forEach(log => {
      if (log.date && log.date.length >= 4) {
        const year = log.date.substring(0, 4);
        if (/^\d{4}$/.test(year)) {
          yearsSet.add(year);
        }
      }
    });
    // Add 2026 if empty to ensure we have something
    if (yearsSet.size === 0) {
      yearsSet.add('2026');
    }
    return Array.from(yearsSet).sort((a, b) => b.localeCompare(a)); // Descending order
  }, [maintenanceLogs]);

  // Current selected year
  const [selectedYear, setSelectedYear] = useState<string>(() => {
    return availableYears.includes('2026') ? '2026' : (availableYears[0] || '2026');
  });

  // Track hovered quarter index for detailed tooltip
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // Group and aggregate data by quarter for the selected year
  const aggregatedData = useMemo(() => {
    // 4 Quarters initialization
    const quarters = [
      { name: 'Q1', fullName: '第一季度', months: '1月-3月', pm: 0, repair: 0, total: 0 },
      { name: 'Q2', fullName: '第二季度', months: '4月-6月', pm: 0, repair: 0, total: 0 },
      { name: 'Q3', fullName: '第三季度', months: '7月-9月', pm: 0, repair: 0, total: 0 },
      { name: 'Q4', fullName: '第四季度', months: '10月-12月', pm: 0, repair: 0, total: 0 },
    ];

    maintenanceLogs.forEach(log => {
      if (!log.date || log.date.length < 7) return;
      const logYear = log.date.substring(0, 4);
      if (logYear !== selectedYear) return;

      const monthStr = log.date.substring(5, 7);
      const month = parseInt(monthStr, 10);
      if (isNaN(month)) return;

      let qIdx = 0;
      if (month >= 1 && month <= 3) qIdx = 0;
      else if (month >= 4 && month <= 6) qIdx = 1;
      else if (month >= 7 && month <= 9) qIdx = 2;
      else if (month >= 10 && month <= 12) qIdx = 3;
      else return;

      const logCost = log.cost || 0;
      if (log.type === '维修') {
        quarters[qIdx].repair += logCost;
      } else {
        // "保养"
        quarters[qIdx].pm += logCost;
      }
      quarters[qIdx].total += logCost;
    });

    return quarters;
  }, [maintenanceLogs, selectedYear]);

  // Year statistics
  const stats = useMemo(() => {
    let totalPm = 0;
    let totalRepair = 0;
    aggregatedData.forEach(q => {
      totalPm += q.pm;
      totalRepair += q.repair;
    });
    const totalCost = totalPm + totalRepair;
    const pmRatio = totalCost > 0 ? (totalPm / totalCost) * 100 : 0;
    const repairRatio = totalCost > 0 ? (totalRepair / totalCost) * 100 : 0;

    // Budget advice generator based on data
    let advice = '设备暂无年度支出，无需特殊预算核算。';
    let adviceColor = 'text-slate-500 bg-slate-50 border-slate-100';
    if (totalCost > 0) {
      if (repairRatio > 60) {
        advice = '警告：本年度【故障维修】支出占比超60%，突发性维修消耗了过多预算。强烈建议医学装备科在下季度增加预防性保养(PM)频次，变动“被动抢修”为“主动预防”，以降低总运行成本。';
        adviceColor = 'text-rose-700 bg-rose-50/70 border-rose-100';
      } else if (pmRatio > 60) {
        advice = '优良：本年度【预防性保养】支出占比超60%，说明该设备处于高效的主动维护状态。这有效延长了设备使用寿命并减少了停机时间，当前预算分配方案非常健康，建议继续保持。';
        adviceColor = 'text-emerald-700 bg-emerald-50/70 border-emerald-100';
      } else {
        advice = '提示：本年度维保与保养支出结构相对均衡。维修与保养各项支出均在预算可控范围内，建议下年度继续执行常态化设备精细化核算策略，稳定当前的预算水平。';
        adviceColor = 'text-blue-700 bg-blue-50/70 border-blue-100';
      }
    }

    return {
      totalPm,
      totalRepair,
      totalCost,
      pmRatio,
      repairRatio,
      advice,
      adviceColor
    };
  }, [aggregatedData]);

  // SVG Chart layout measurements
  const chartHeight = 150;
  const padding = { top: 15, right: 15, bottom: 25, left: 55 };

  // Find max quarter total to scale Y axis
  const maxQuarterTotal = useMemo(() => {
    const maxVal = Math.max(...aggregatedData.map(q => q.total));
    if (maxVal === 0) return 1000; // default baseline scale
    // Round to a nice looking ceiling value
    const digits = Math.floor(Math.log10(maxVal));
    const step = Math.max(100, Math.pow(10, digits - 1) * 5); // step size
    return Math.ceil((maxVal * 1.15) / step) * step; // leave 15% head room
  }, [aggregatedData]);

  // Help generate Y axis ticks
  const yTicks = useMemo(() => {
    const ticks = [];
    const step = maxQuarterTotal / 4;
    for (let i = 0; i <= 4; i++) {
      ticks.push(Math.round(step * i));
    }
    return ticks;
  }, [maxQuarterTotal]);

  const formatCostLabel = (value: number) => {
    if (value >= 10000) {
      return `¥${(value / 10000).toFixed(1)}w`;
    } else if (value >= 1000) {
      return `¥${(value / 1000).toFixed(0)}k`;
    }
    return `¥${value}`;
  };

  return (
    <div className="bg-slate-50/60 p-4 rounded-xl border border-slate-200/80 my-4">
      {/* Top Title & Selector Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-3 border-b border-slate-200/60 mb-4">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-blue-600 rounded-lg text-white">
            <BarChart3 className="w-4 h-4" />
          </div>
          <div>
            <h5 className="text-xs font-bold text-slate-800">
              季度维保与保养支出精细核算 
              <span className="text-[10px] text-slate-400 font-normal ml-1">({selectedYear}年度)</span>
            </h5>
            <p className="text-[9px] text-slate-400">维修与保养双重堆叠，科学掌控医学装备全生命周期预算</p>
          </div>
        </div>

        {/* Year Dropdown select */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-slate-500 font-medium">切换核算年度:</span>
          <select
            value={selectedYear}
            onChange={(e) => {
              setSelectedYear(e.target.value);
              setHoveredIdx(null);
            }}
            className="text-[11px] font-bold text-slate-700 bg-white border border-slate-200 rounded-lg px-2 py-1 shadow-2xs focus:outline-hidden focus:ring-1 focus:ring-blue-500 cursor-pointer"
          >
            {availableYears.map(yr => (
              <option key={yr} value={yr}>{yr} 年</option>
            ))}
          </select>
        </div>
      </div>

      {/* Stats Summary Panel */}
      <div className="grid grid-cols-3 gap-2 mb-4">
        <div className="bg-white p-2.5 rounded-lg border border-slate-200/60 shadow-2xs">
          <div className="text-[9px] text-slate-400 font-medium font-sans flex items-center gap-1">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
            <span>预防保养总额</span>
          </div>
          <p className="text-xs font-mono font-bold text-slate-700 mt-1">
            ¥{stats.totalPm.toLocaleString()}
          </p>
          <p className="text-[8px] text-slate-400 mt-0.5">
            占比: {stats.pmRatio.toFixed(1)}%
          </p>
        </div>

        <div className="bg-white p-2.5 rounded-lg border border-slate-200/60 shadow-2xs">
          <div className="text-[9px] text-slate-400 font-medium font-sans flex items-center gap-1">
            <div className="w-1.5 h-1.5 rounded-full bg-rose-500" />
            <span>故障检修总额</span>
          </div>
          <p className="text-xs font-mono font-bold text-slate-700 mt-1">
            ¥{stats.totalRepair.toLocaleString()}
          </p>
          <p className="text-[8px] text-slate-400 mt-0.5">
            占比: {stats.repairRatio.toFixed(1)}%
          </p>
        </div>

        <div className="bg-blue-50/20 p-2.5 rounded-lg border border-blue-100/60 shadow-2xs">
          <div className="text-[9px] text-blue-600 font-bold font-sans flex items-center gap-1">
            <DollarSign className="w-3 h-3" />
            <span>年度维保总支出</span>
          </div>
          <p className="text-xs font-mono font-bold text-blue-700 mt-1">
            ¥{stats.totalCost.toLocaleString()}
          </p>
          <p className="text-[8px] text-blue-500/80 mt-0.5">
            100.0% 核算入账
          </p>
        </div>
      </div>

      {/* Stacked Bar Chart Graphics Section */}
      <div className="relative bg-white border border-slate-200/70 rounded-xl p-3 shadow-2xs">
        {/* Legends on Top Right */}
        <div className="flex justify-end gap-3 text-[10px] text-slate-400 font-medium mb-1">
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-xs bg-blue-500" />
            <span>日常保养 (PM)</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-xs bg-rose-500" />
            <span>故障维修 (Repair)</span>
          </span>
        </div>

        {/* The responsive Chart Canvas */}
        <div className="relative w-full overflow-hidden" style={{ height: `${chartHeight}px` }}>
          <svg width="100%" height="100%" viewBox={`0 0 400 ${chartHeight}`} preserveAspectRatio="none" className="overflow-visible">
            {/* Horizontal Grid lines */}
            {yTicks.map((tickVal, tIdx) => {
              const yPos = padding.top + chartHeight - padding.top - padding.bottom - ((tickVal / maxQuarterTotal) * (chartHeight - padding.top - padding.bottom));
              return (
                <g key={tIdx} className="opacity-40">
                  <line 
                    x1={padding.left} 
                    y1={yPos} 
                    x2={400 - padding.right} 
                    y2={yPos} 
                    stroke="#e2e8f0" 
                    strokeWidth="1" 
                    strokeDasharray="3,3"
                  />
                  {/* Left Y Axis label */}
                  <text 
                    x={padding.left - 8} 
                    y={yPos + 3.5} 
                    textAnchor="end" 
                    fill="#94a3b8" 
                    className="text-[9px] font-mono font-semibold"
                  >
                    {formatCostLabel(tickVal)}
                  </text>
                </g>
              );
            })}

            {/* Main Axis Lines */}
            <line 
              x1={padding.left} 
              y1={chartHeight - padding.bottom} 
              x2={400 - padding.right} 
              y2={chartHeight - padding.bottom} 
              stroke="#cbd5e1" 
              strokeWidth="1"
            />
            <line 
              x1={padding.left} 
              y1={padding.top} 
              x2={padding.left} 
              y2={chartHeight - padding.bottom} 
              stroke="#cbd5e1" 
              strokeWidth="1"
            />

            {/* Four Quarter Stacked Columns */}
            {aggregatedData.map((q, qIdx) => {
              const usableWidth = 400 - padding.left - padding.right;
              const quarterStep = usableWidth / 4;
              const xCenter = padding.left + quarterStep * (qIdx + 0.5);
              const barWidth = 32;
              const xLeft = xCenter - barWidth / 2;

              const totalDrawableHeight = chartHeight - padding.top - padding.bottom;
              const pmHeight = (q.pm / maxQuarterTotal) * totalDrawableHeight;
              const repairHeight = (q.repair / maxQuarterTotal) * totalDrawableHeight;

              const yBottom = chartHeight - padding.bottom;
              const pmY = yBottom - pmHeight;
              const repairY = pmY - repairHeight;

              const isHovered = hoveredIdx === qIdx;

              return (
                <g 
                  key={qIdx} 
                  className="cursor-pointer"
                  onMouseEnter={() => setHoveredIdx(qIdx)}
                  onMouseLeave={() => setHoveredIdx(null)}
                >
                  {/* Hover Backdrop Highlighter */}
                  {isHovered && (
                    <rect
                      x={xCenter - quarterStep / 2 + 2}
                      y={padding.top}
                      width={quarterStep - 4}
                      height={totalDrawableHeight}
                      fill="#3b82f6"
                      fillOpacity="0.04"
                      rx="4"
                    />
                  )}

                  {/* PM Bar (Bottom portion of stack) */}
                  {q.pm > 0 && (
                    <rect
                      x={xLeft}
                      y={pmY}
                      width={barWidth}
                      height={pmHeight}
                      fill="#3b82f6"
                      rx={q.repair === 0 ? 3 : 0} // round top if it has no repair stack
                      className="transition-all duration-300 hover:brightness-105"
                    />
                  )}

                  {/* Repair Bar (Top portion of stack) */}
                  {q.repair > 0 && (
                    <rect
                      x={xLeft}
                      y={repairY}
                      width={barWidth}
                      height={repairHeight}
                      fill="#f43f5e"
                      rx={3} // round the top corners for a sleek aesthetic
                      className="transition-all duration-300 hover:brightness-105"
                    />
                  )}

                  {/* If both are zero, draw a subtle tiny indicator dotted line */}
                  {q.total === 0 && (
                    <rect
                      x={xLeft}
                      y={yBottom - 2}
                      width={barWidth}
                      height={2}
                      fill="#e2e8f0"
                      rx={1}
                    />
                  )}

                  {/* X Axis label */}
                  <text
                    x={xCenter}
                    y={chartHeight - padding.bottom + 14}
                    textAnchor="middle"
                    fill={isHovered ? "#3b82f6" : "#64748b"}
                    className={`text-[9px] font-bold ${isHovered ? 'font-black' : 'font-semibold'}`}
                  >
                    {q.name}
                  </text>
                  <text
                    x={xCenter}
                    y={chartHeight - padding.bottom + 23}
                    textAnchor="middle"
                    fill="#94a3b8"
                    className="text-[8px] font-mono scale-90"
                  >
                    {q.months}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        {/* Absolute Hover Tooltip */}
        {hoveredIdx !== null && (
          <div 
            className="absolute z-30 bg-slate-900/95 text-white text-[10px] p-2.5 rounded-lg shadow-md border border-slate-700/50 pointer-events-none flex flex-col gap-1 w-40"
            style={{
              top: '25px',
              left: `${Math.min(230, Math.max(55, padding.left + ((400 - padding.left - padding.right) / 4) * (hoveredIdx + 0.5) - 80))}px`
            }}
          >
            <p className="font-bold border-b border-slate-700/50 pb-1 text-blue-400 flex items-center justify-between">
              <span>{aggregatedData[hoveredIdx].fullName}</span>
              <span className="text-[8px] text-slate-400 font-mono">({aggregatedData[hoveredIdx].months})</span>
            </p>
            <div className="space-y-0.5 font-mono pt-1">
              <p className="flex justify-between">
                <span className="text-slate-400">日常保养:</span>
                <span className="font-bold text-blue-300">¥{aggregatedData[hoveredIdx].pm.toLocaleString()}</span>
              </p>
              <p className="flex justify-between">
                <span className="text-slate-400">故障维修:</span>
                <span className="font-bold text-rose-300">¥{aggregatedData[hoveredIdx].repair.toLocaleString()}</span>
              </p>
              <div className="border-t border-slate-800/80 my-1 pt-1 flex justify-between text-white font-bold">
                <span>单季合计:</span>
                <span>¥{aggregatedData[hoveredIdx].total.toLocaleString()}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Refined Asset Budget Accounting Smart Advice Card */}
      <div className={`mt-3.5 p-3 rounded-xl border flex gap-2.5 items-start ${stats.adviceColor} transition-colors duration-300`}>
        <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <div className="space-y-1">
          <span className="text-[10px] font-extrabold uppercase tracking-wide">医学装备科 · 精细化资产预算核算意见</span>
          <p className="text-[10px] leading-relaxed font-medium">
            {stats.advice}
          </p>
        </div>
      </div>
    </div>
  );
}
