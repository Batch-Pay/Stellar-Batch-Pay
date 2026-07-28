import { StrKey } from "stellar-sdk";
import type { Network } from "./types";

function pickEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

const PLACEHOLDER_VESTING_CONTRACT_IDS = new Set([
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
]);

function isPlaceholderVestingContractId(value: string): boolean {
  return PLACEHOLDER_VESTING_CONTRACT_IDS.has(value);
}

export function resolveVestingContractId(network: Network): string {
  const configuredValue = pickEnv(
    `NEXT_PUBLIC_CONTRACT_ID_${network.toUpperCase()}`,
    `CONTRACT_ID_${network.toUpperCase()}`,
    "NEXT_PUBLIC_CONTRACT_ID",
    "CONTRACT_ID",
  );

  if (!configuredValue) {
    throw new Error(
      `Vesting contract is not configured for ${network}. Set NEXT_PUBLIC_CONTRACT_ID_${network.toUpperCase()}, CONTRACT_ID_${network.toUpperCase()}, NEXT_PUBLIC_CONTRACT_ID, or CONTRACT_ID.`,
    );
  }

  if (isPlaceholderVestingContractId(configuredValue)) {
    throw new Error(
      `Configured vesting contract ID for ${network} is a placeholder value. Set NEXT_PUBLIC_CONTRACT_ID_${network.toUpperCase()}, CONTRACT_ID_${network.toUpperCase()}, NEXT_PUBLIC_CONTRACT_ID, or CONTRACT_ID to your deployed contract address.`,
    );
  }

  if (!StrKey.isValidContract(configuredValue)) {
    throw new Error(`Invalid vesting contract ID for ${network}: ${configuredValue}`);
  }

  return configuredValue;
}
