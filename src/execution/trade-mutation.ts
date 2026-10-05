const queues = new Map<string, Promise<void>>();

export async function serializeTradeMutation<T>(tradeId: string, action: () => Promise<T>): Promise<T> {
  const prior = queues.get(tradeId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = prior.catch(() => undefined).then(() => gate);
  queues.set(tradeId, tail);
  await prior.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (queues.get(tradeId) === tail) queues.delete(tradeId);
  }
}
