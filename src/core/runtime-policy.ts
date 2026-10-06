export interface RuntimePolicyInput {
  strategyCoreVersion: 1 | 2;
  baselineMode: boolean;
  evolutionConfiguredEnabled: boolean;
  scalpConfiguredEnabled: boolean;
  configuredMaxPositions: number;
}

export interface RuntimePolicy {
  strategyCoreVersion: 1 | 2;
  evolutionEnabled: boolean;
  scalpEnabled: boolean;
  maxConcurrentPositions: number;
}

/** Baseline is a safety/experiment overlay; it never chooses the strategy version. */
export function resolveRuntimePolicy(input: RuntimePolicyInput): RuntimePolicy {
  return {
    strategyCoreVersion: input.strategyCoreVersion,
    evolutionEnabled: !input.baselineMode && input.evolutionConfiguredEnabled,
    scalpEnabled: !input.baselineMode && input.scalpConfiguredEnabled,
    maxConcurrentPositions: input.baselineMode ? 1 : input.configuredMaxPositions,
  };
}
