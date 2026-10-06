import { useCallback, useEffect, useState } from "react";
import type { ApiState } from "../lib/types";

export function useApi<T = unknown>(path: string, fallbackInterval = 15_000): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const reload = useCallback(async () => {
    try {
      const response = await fetch(path, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      setData(await response.json() as T);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Connection unavailable");
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), fallbackInterval);
    const onRefresh = () => void reload();
    window.addEventListener("evoquant:refresh", onRefresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("evoquant:refresh", onRefresh);
    };
  }, [fallbackInterval, reload]);

  return { data, error, loading, updatedAt, reload };
}

export function useRefreshSocket(): boolean {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retryTimer = 0;
    let closed = false;
    let lastRefresh = 0;

    const connect = () => {
      if (closed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socket.addEventListener("open", () => setConnected(true));
      socket.addEventListener("message", () => {
        const now = Date.now();
        if (now - lastRefresh < 2_500) return;
        lastRefresh = now;
        window.dispatchEvent(new Event("evoquant:refresh"));
      });
      socket.addEventListener("close", () => {
        setConnected(false);
        if (!closed) retryTimer = window.setTimeout(connect, 3_000);
      });
      socket.addEventListener("error", () => socket?.close());
    };

    connect();
    return () => {
      closed = true;
      window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, []);

  return connected;
}
