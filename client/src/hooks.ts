import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiError } from './api';

interface AsyncResult<T> {
  loading: boolean;
  data: T | null;
  error: string | null;
  reload: () => void;
}

/**
 * Run an async loader whenever deps change or reload() fires.
 * The loader is expected to return an ApiResult (from api.ts).
 */
export function useAsync<T>(
  loader: () => Promise<{ ok: true; data: T } | { ok: false; error: ApiError }>,
  deps: React.DependencyList
): AsyncResult<T> {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<{ loading: boolean; data: T | null; error: string | null }>({
    loading: true,
    data: null,
    error: null
  });
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.resolve()
      .then(() => loaderRef.current())
      .then((res) => {
        if (!alive) return;
        if (res.ok) setState({ loading: false, data: res.data, error: null });
        else setState({ loading: false, data: null, error: res.error.message });
      })
      .catch((err: Error) => {
        if (alive) setState({ loading: false, data: null, error: err.message });
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}
