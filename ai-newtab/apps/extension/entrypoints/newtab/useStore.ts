import { useEffect, useState } from "react";
import { load, watch, type StoreShape } from "@/lib/storage";

/** Live view of one chrome.storage.local key. `undefined` until first load. */
export function useStore<K extends keyof StoreShape>(key: K): StoreShape[K] | undefined {
  const [value, setValue] = useState<StoreShape[K]>();
  useEffect(() => {
    let alive = true;
    void load(key).then((v) => alive && setValue(v));
    const off = watch(key, setValue);
    return () => {
      alive = false;
      off();
    };
  }, [key]);
  return value;
}
