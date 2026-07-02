export const MS_PER_DAY = 1000 * 3600 * 24;

export const getLocalDateString = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export const getLocalDateTimeString = (date = new Date()) => {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${getLocalDateString(date)} ${hours}:${minutes}`;
};

export const getStartOfLocalDayTime = (date = new Date()) => {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

const getLocalDateOnlyTime = (dateStr: string) => {
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day)).getTime();
};

export const getDateDiffDaysFromToday = (dateStr?: string) => {
  if (!dateStr) return null;
  const targetTime = getLocalDateOnlyTime(dateStr) ?? new Date(dateStr).getTime();
  if (Number.isNaN(targetTime)) return null;
  return (targetTime - getStartOfLocalDayTime()) / MS_PER_DAY;
};
