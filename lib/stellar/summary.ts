import Big from 'big.js';

import { PaymentInstruction } from './types';
import { validatePaymentInstruction } from './validator';

export function getBatchSummary(instructions: PaymentInstruction[]) {
  let totalAmount = new Big('0');
  let validCount = 0;
  let invalidCount = 0;
  const assetCount = new Map<string, number>();

  for (const instruction of instructions) {
    const validation = validatePaymentInstruction(instruction);
    if (validation.valid) {
      validCount++;
      totalAmount = totalAmount.plus(instruction.amount);
      assetCount.set(instruction.asset, (assetCount.get(instruction.asset) || 0) + 1);
    } else {
      invalidCount++;
    }
  }

  return {
    recipientCount: instructions.length,
    validCount,
    invalidCount,
    totalAmount: totalAmount.toString(),
    assetBreakdown: Object.fromEntries(assetCount),
  };
}
