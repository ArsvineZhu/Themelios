import type { ModelParameters } from "@themelios/models";
import type { PreparationPolicy } from "./input-contracts.js";

export interface TaskRoute {
  readonly model: string;
  readonly parameters?: ModelParameters;
  readonly preparation?: PreparationPolicy;
}
