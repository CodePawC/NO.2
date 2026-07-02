import { Dispatch, SetStateAction, useEffect, useState } from 'react';

export function useLocalStorageState<T>(
  key: string,
  initialValue: T,
  parseValue?: (rawValue: string) => T,
  serializeValue: (value: T) => string = JSON.stringify
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    const saved = localStorage.getItem(key);
    if (saved === null) {
      return initialValue;
    }

    try {
      return parseValue ? parseValue(saved) : JSON.parse(saved);
    } catch (e) {
      return initialValue;
    }
  });

  useEffect(() => {
    localStorage.setItem(key, serializeValue(value));
  }, [key, serializeValue, value]);

  return [value, setValue];
}
