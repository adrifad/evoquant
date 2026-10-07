import { z } from "zod";

const EvolutionSchema = z.object({
  review_every_closed_trade: z.boolean().default(true),
  enabled: z.boolean().default(true),
  signal_learning_enabled: z.boolean().default(true),
  strategy_evolution_enabled: z.boolean().default(true),
  automatic_promotion_enabled: z.boolean().default(true),
  signal_evolution_interval_trades: z.number().int().min(1).max(10_000),
  strategy_evolution_interval_trades: z.number().int().min(1).max(10_000),
  minimum_validation_sample: z.number().int().min(1).max(100_000),
  constraints: z.object({
    max_weight_change_per_cycle_pct: z.number().min(0).max(10),
    max_param_changes_per_challenger: z.number().int().min(1).max(1),
    max_param_delta_pct_per_challenger: z.number().min(0.1).max(25),
    champion_vs_challenger: z.object({
      requires_out_of_sample: z.boolean(), requires_walk_forward: z.boolean(),
      min_sample_each_side: z.number().int().min(1), min_positive_symbols: z.number().int().min(1),
      min_positive_walk_forward_folds: z.number().int().min(1),
    }),
  }),
  promotion: z.object({
    historical_min_trades: z.number().int().min(1), out_of_sample_min_trades: z.number().int().min(1),
    shadow_forward_min_trades: z.number().int().min(1),
    champion_shadow_min_trades: z.number().int().min(1).default(15),
    champion_forward_min_trades: z.number().int().min(1).optional(),
    require_out_of_sample: z.boolean(), require_walk_forward: z.boolean(), require_multi_symbol: z.boolean(),
    min_positive_symbol_fraction: z.number().min(0).max(1), min_positive_walk_forward_fraction: z.number().min(0).max(1),
    minimum_walk_forward_folds: z.number().int().min(1), minimum_symbols: z.number().int().min(1),
    max_drawdown_degradation_pct: z.number().min(0).max(10), out_of_sample_fraction: z.number().min(0.1).max(0.8),
  }),
});

export type EvolutionConfig = z.infer<typeof EvolutionSchema>;
export function parseEvolutionConfig(input: unknown): EvolutionConfig { return EvolutionSchema.parse(input); }
