export type RoleHealthRow = Record<string, unknown>;

function text(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function number(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface RoleHealthPresentation {
  currentStatus: string | null;
  currentTimestamp: string | null;
  currentReason: string | null;
  currentHttpStatus: number | null;
  previousFailureStatus: string | null;
  previousFailureReason: string | null;
  previousFailureHttpStatus: number | null;
  previousFailureTimestamp: string | null;
}

/** Keeps the current request separate from retained failure history. */
export function roleHealthPresentation(role: RoleHealthRow): RoleHealthPresentation {
  const currentStatus = text(role.lastStatus);
  const failureStatus = text(role.lastFailureStatus);
  const rawFailureReason = text(role.lastFailureReason) ?? text(role.errorClass);
  const failureReason = rawFailureReason === failureStatus ? null : rawFailureReason;
  const failureHttpStatus = number(role.lastFailureHttpStatus ?? role.lastHttpStatus);
  const isCurrentFailure = currentStatus !== null && currentStatus !== "SUCCESS";
  return {
    currentStatus,
    currentTimestamp: text(role.lastRequestAt) ?? (isCurrentFailure ? text(role.lastFailure) : text(role.lastSuccess)),
    currentReason: isCurrentFailure ? failureReason : null,
    currentHttpStatus: isCurrentFailure ? failureHttpStatus : null,
    previousFailureStatus: !isCurrentFailure && currentStatus === "SUCCESS" ? failureStatus : null,
    previousFailureReason: !isCurrentFailure && currentStatus === "SUCCESS" ? failureReason : null,
    previousFailureHttpStatus: !isCurrentFailure && currentStatus === "SUCCESS" ? failureHttpStatus : null,
    previousFailureTimestamp: !isCurrentFailure && currentStatus === "SUCCESS" ? text(role.lastFailure) : null,
  };
}
