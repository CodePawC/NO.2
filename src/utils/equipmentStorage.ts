import type { Attachment, CalibrationLog, ExtractedSnapshot, MaintenanceLog, MedicalEquipment } from '../types';
import { DEFAULT_EQUIPMENT } from '../data/defaultEquipment';
import { normalizeEngineerName } from './engineerAssignments';

export const EQUIPMENT_STORAGE_KEY = 'medical_equipment_data';
const EQUIPMENT_PRESET_MIGRATION_KEY = 'medical_equipment_seeded_preset_ids';
const EQUIPMENT_PRESET_MIGRATION_IDS = ['eq-006', 'eq-007', 'eq-008'];

const EQUIPMENT_CATEGORIES: MedicalEquipment['category'][] = ['急救生命支持', '影像诊断', '检验分析', '手术治疗', '其他'];
const EQUIPMENT_STATUSES: MedicalEquipment['status'][] = ['正常运行', '故障维修', '计量中', '已停用'];
const RISK_LEVELS: MedicalEquipment['riskLevel'][] = ['高', '中', '低'];
const DEVICE_CLASSES: NonNullable<MedicalEquipment['deviceClass']>[] = ['I类', 'II类', 'III类', '未分类'];

const getBrowserStorage = () => {
  return typeof localStorage === 'undefined' ? null : localStorage;
};

const EMPTY_EQUIPMENT: MedicalEquipment = {
  id: '',
  deviceName: '',
  model: '未登记型号',
  sn: '未登记SN',
  manufacturer: '未登记厂商',
  category: '其他',
  dept: '未分配科室',
  status: '正常运行',
  riskLevel: '低',
  purchaseDate: '',
  purchaseCost: 0,
  maintenanceCycleDays: 180,
  lastMaintenanceDate: '',
  nextMaintenanceDate: '',
  calibrationRequired: false,
  attachments: [],
  maintenanceLogs: [],
  calibrationLogs: []
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const cloneArray = <T>(value: T[] | undefined): T[] => {
  return Array.isArray(value) ? [...value] : [];
};

export const cloneEquipmentList = (equipments: MedicalEquipment[]): MedicalEquipment[] => {
  return equipments.map(equipment => ({
    ...equipment,
    attachments: cloneArray(equipment.attachments),
    maintenanceLogs: cloneArray(equipment.maintenanceLogs),
    calibrationLogs: cloneArray(equipment.calibrationLogs),
    extractedSnapshots: equipment.extractedSnapshots ? cloneArray(equipment.extractedSnapshots) : undefined
  }));
};

export const getDefaultEquipmentList = (): MedicalEquipment[] => {
  return cloneEquipmentList(DEFAULT_EQUIPMENT);
};

const getSeededPresetEquipmentIds = () => {
  const storage = getBrowserStorage();
  if (!storage) return new Set<string>();

  try {
    const parsed = JSON.parse(storage.getItem(EQUIPMENT_PRESET_MIGRATION_KEY) || '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch (error) {
    console.warn('Failed to load seeded preset equipment ids:', error);
    return new Set<string>();
  }
};

const markPresetEquipmentMigrationsSeeded = () => {
  const storage = getBrowserStorage();
  if (!storage) return;

  const seededPresetIds = getSeededPresetEquipmentIds();
  const nextSeededPresetIds = new Set([...seededPresetIds, ...EQUIPMENT_PRESET_MIGRATION_IDS]);
  storage.setItem(EQUIPMENT_PRESET_MIGRATION_KEY, JSON.stringify([...nextSeededPresetIds]));
};

const mergeMissingPresetEquipments = (equipments: MedicalEquipment[]) => {
  const storedIds = new Set(equipments.map(equipment => equipment.id));
  const seededPresetIds = getSeededPresetEquipmentIds();
  const missingPresetEquipments = DEFAULT_EQUIPMENT.filter(
    equipment => EQUIPMENT_PRESET_MIGRATION_IDS.includes(equipment.id) && !storedIds.has(equipment.id) && !seededPresetIds.has(equipment.id)
  );
  markPresetEquipmentMigrationsSeeded();

  return missingPresetEquipments.length > 0
    ? [...cloneEquipmentList(missingPresetEquipments), ...equipments]
    : equipments;
};

const getDefaultForRecord = (record: Record<string, unknown>) => {
  const id = typeof record.id === 'string' ? record.id : '';
  return DEFAULT_EQUIPMENT.find(equipment => equipment.id === id) || EMPTY_EQUIPMENT;
};

const getString = (value: unknown, fallback: string, markRepaired: () => void) => {
  if (typeof value === 'string') return value;
  markRepaired();
  return fallback;
};

const getOptionalString = (value: unknown, fallback: string | undefined, markRepaired: () => void) => {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return undefined;
  markRepaired();
  return fallback;
};

const getOptionalEngineerName = (value: unknown, fallback: string | undefined, markRepaired: () => void) => {
  const storedName = getOptionalString(value, fallback, markRepaired);
  const normalizedName = normalizeEngineerName(storedName);
  if (storedName !== normalizedName) {
    markRepaired();
  }
  return normalizedName;
};

const getNumber = (value: unknown, fallback: number, markRepaired: () => void) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  markRepaired();
  return fallback;
};

const getBoolean = (value: unknown, fallback: boolean, markRepaired: () => void) => {
  if (typeof value === 'boolean') return value;
  markRepaired();
  return fallback;
};

const getOption = <T extends string>(
  value: unknown,
  options: T[],
  fallback: T,
  markRepaired: () => void
) => {
  if (typeof value === 'string' && options.includes(value as T)) return value as T;
  markRepaired();
  return fallback;
};

const getStoredArray = <T>(value: unknown, fallback: T[] | undefined, markRepaired: () => void) => {
  if (Array.isArray(value)) return [...value] as T[];
  markRepaired();
  return cloneArray(fallback);
};

const normalizeEquipmentRecord = (value: unknown): { equipment: MedicalEquipment | null; repaired: boolean } => {
  if (!isRecord(value)) {
    return { equipment: null, repaired: true };
  }

  let repaired = false;
  const markRepaired = () => {
    repaired = true;
  };
  const fallback = getDefaultForRecord(value);
  const id = getString(value.id, fallback.id, markRepaired);
  const deviceName = getString(value.deviceName, fallback.deviceName, markRepaired);

  if (!id || !deviceName) {
    return { equipment: null, repaired: true };
  }

  const equipment: MedicalEquipment = {
    id,
    deviceName,
    model: getString(value.model, fallback.model, markRepaired),
    sn: getString(value.sn, fallback.sn, markRepaired),
    manufacturer: getString(value.manufacturer, fallback.manufacturer, markRepaired),
    category: getOption(value.category, EQUIPMENT_CATEGORIES, fallback.category, markRepaired),
    dept: getString(value.dept, fallback.dept, markRepaired),
    status: getOption(value.status, EQUIPMENT_STATUSES, fallback.status, markRepaired),
    riskLevel: getOption(value.riskLevel, RISK_LEVELS, fallback.riskLevel, markRepaired),
    purchaseDate: getString(value.purchaseDate, fallback.purchaseDate, markRepaired),
    purchaseCost: getNumber(value.purchaseCost, fallback.purchaseCost, markRepaired),
    maintenanceCycleDays: getNumber(value.maintenanceCycleDays, fallback.maintenanceCycleDays, markRepaired),
    lastMaintenanceDate: getString(value.lastMaintenanceDate, fallback.lastMaintenanceDate, markRepaired),
    nextMaintenanceDate: getString(value.nextMaintenanceDate, fallback.nextMaintenanceDate, markRepaired),
    assignedMaintenanceEngineer: getOptionalEngineerName(value.assignedMaintenanceEngineer, fallback.assignedMaintenanceEngineer, markRepaired),
    calibrationRequired: getBoolean(value.calibrationRequired, fallback.calibrationRequired, markRepaired),
    lastCalibrationDate: getOptionalString(value.lastCalibrationDate, fallback.lastCalibrationDate, markRepaired),
    nextCalibrationDate: getOptionalString(value.nextCalibrationDate, fallback.nextCalibrationDate, markRepaired),
    assignedCalibrationEngineer: getOptionalEngineerName(value.assignedCalibrationEngineer, fallback.assignedCalibrationEngineer, markRepaired),
    attachments: getStoredArray<Attachment>(value.attachments, fallback.attachments, markRepaired),
    maintenanceLogs: getStoredArray<MaintenanceLog>(value.maintenanceLogs, fallback.maintenanceLogs, markRepaired),
    calibrationLogs: getStoredArray<CalibrationLog>(value.calibrationLogs, fallback.calibrationLogs, markRepaired),
    registrationNo: getOptionalString(value.registrationNo, fallback.registrationNo, markRepaired),
    registrationValidUntil: getOptionalString(value.registrationValidUntil, fallback.registrationValidUntil, markRepaired),
    deviceClass: value.deviceClass === undefined || value.deviceClass === null
      ? undefined
      : getOption(value.deviceClass, DEVICE_CLASSES, fallback.deviceClass || '未分类', markRepaired),
    productionLicenseNo: getOptionalString(value.productionLicenseNo, fallback.productionLicenseNo, markRepaired),
    photoUrl: getOptionalString(value.photoUrl, fallback.photoUrl, markRepaired),
    extractedSnapshots: value.extractedSnapshots === undefined || value.extractedSnapshots === null
      ? undefined
      : getStoredArray<ExtractedSnapshot>(value.extractedSnapshots, fallback.extractedSnapshots, markRepaired)
  };

  return { equipment, repaired };
};

export const parseStoredEquipmentList = (saved: string | null): { equipments: MedicalEquipment[]; shouldPersist: boolean } => {
  if (!saved) {
    markPresetEquipmentMigrationsSeeded();
    return { equipments: getDefaultEquipmentList(), shouldPersist: true };
  }

  try {
    const parsed = JSON.parse(saved);

    if (!Array.isArray(parsed)) {
      return { equipments: getDefaultEquipmentList(), shouldPersist: true };
    }

    const normalized = parsed.map(normalizeEquipmentRecord);
    const equipments = normalized
      .map(item => item.equipment)
      .filter((equipment): equipment is MedicalEquipment => Boolean(equipment));

    if (equipments.length === 0) {
      return { equipments: getDefaultEquipmentList(), shouldPersist: true };
    }

    const mergedEquipments = mergeMissingPresetEquipments(equipments);

    return {
      equipments: mergedEquipments,
      shouldPersist: normalized.some(item => item.repaired) || equipments.length !== parsed.length || mergedEquipments.length !== equipments.length
    };
  } catch (error) {
    console.warn('Failed to load persisted equipment, falling back to defaults:', error);
    return { equipments: getDefaultEquipmentList(), shouldPersist: true };
  }
};