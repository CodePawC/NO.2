const DEPARTMENT_ALIASES: Record<string, string> = {
  ICU: '重症医学科 (ICU)',
  重症: '重症医学科 (ICU)',
  重症科: '重症医学科 (ICU)',
  重症医学科: '重症医学科 (ICU)',
  急诊: '急诊科',
  急诊科: '急诊科',
  急诊ICU: '急诊科',
  '急诊 ICU': '急诊科',
  放射: '放射科',
  放射科: '放射科',
  妇产: '妇产科',
  妇产科: '妇产科',
  胃镜: '胃镜室',
  胃镜室: '胃镜室',
  手术: '手术室',
  手术室: '手术室',
  呼吸: '呼吸内科',
  呼吸内科: '呼吸内科',
  儿科: '儿科',
  检验: '检验科',
  检验科: '检验科',
  超声: '超声科',
  超声科: '超声科'
};

export const normalizeDepartmentName = (department?: string) => {
  const cleaned = department?.trim();
  if (!cleaned) return '';

  return DEPARTMENT_ALIASES[cleaned.toUpperCase()] || DEPARTMENT_ALIASES[cleaned] || cleaned;
};

export const isSameDepartment = (left?: string, right?: string) => {
  const normalizedLeft = normalizeDepartmentName(left);
  const normalizedRight = normalizeDepartmentName(right);

  return !!normalizedLeft && !!normalizedRight && normalizedLeft === normalizedRight;
};
