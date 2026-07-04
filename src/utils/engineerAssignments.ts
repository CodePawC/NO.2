import { SIMULATED_USERS } from '../data/appPresets';

export const FALLBACK_ENGINEER_NAMES = ['张明华', '李建国', '赵安平'];

export const SIMULATED_ENGINEER_NAMES = SIMULATED_USERS
  .filter(user => user.role === 'engineer')
  .map(user => user.name);

const LEGACY_ENGINEER_NAME_ALIASES: Record<string, string> = {
  王强: '张明华',
  张华: '李建国',
  李明: '赵安平',
  赵四: '赵安平'
};

export const normalizeEngineerName = (name?: string) => {
  if (!name) return name;
  return LEGACY_ENGINEER_NAME_ALIASES[name] || name;
};

export const getDefaultEngineerName = () => SIMULATED_ENGINEER_NAMES[0] || FALLBACK_ENGINEER_NAMES[0];

export const getEngineerNameByIndex = (index: number) => {
  const source = SIMULATED_ENGINEER_NAMES.length > 0 ? SIMULATED_ENGINEER_NAMES : FALLBACK_ENGINEER_NAMES;
  return source[index % source.length] || FALLBACK_ENGINEER_NAMES[0];
};