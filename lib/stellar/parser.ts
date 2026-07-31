/**
 * Parser for converting JSON and CSV inputs to payment instructions
 */

import Papa from 'papaparse';
import { ParsedPaymentFile, PaymentInstruction, MemoType, UploadedPaymentInstruction } from './types';
import { validatePaymentInstruction } from './validator';

export const MAX_UPLOAD_ROWS = 1000;

/**
 * Sanitizes a string value to prevent CSV injection (Formula Injection)
 * and strips HTML tags to prevent XSS.
 */
function sanitizeValue(value: string): string {
  if (!value) return '';

  // Strip HTML tags
  let sanitized = value.replace(/<[^>]*>?/gm, '');

  // Neutralize CSV formula injection characters: =, +, -, @
  // If the string starts with these, we prepend a single quote to escape it
  if (/^[=+\-@]/.test(sanitized)) {
    sanitized = `'${sanitized}`;
  }

  return sanitized.trim();
}

export function parseJSON(content: string): PaymentInstruction[] {
  try {
    const data = JSON.parse(content);

    // Handle both array and object with payments property
    const rawInstructions = Array.isArray(data) ? data : data.payments;

    if (!Array.isArray(rawInstructions)) {
      throw new Error('Expected an array of payment instructions or object with "payments" array');
    }

    return rawInstructions.map((item: Record<string, unknown>, index: number) => {
      // #714: Reject numeric JSON amounts — JSON.parse applies IEEE-754 rounding
      // before validation, silently altering values like 99999999999.9999999 → 1e11
      if (typeof item.amount === 'number') {
        throw new Error(
          `Row ${index + 1}: amount must be a quoted string, not a number (received ${item.amount})`
        );
      }

      const instruction: PaymentInstruction = {
        address: sanitizeValue(String(item.address ?? '')),
        amount: sanitizeValue(String(item.amount ?? '')),
        asset: sanitizeValue(String(item.asset ?? '')),
        rowIndex: index, // #397: preserve original row index for retry matching
      };

      if (item.memo != null && String(item.memo).trim() !== '') {
        instruction.memo = sanitizeValue(String(item.memo).trim());
        if (item.memoType != null) {
          const mt = sanitizeValue(String(item.memoType)).toLowerCase();
          if (mt === 'text' || mt === 'id' || mt === 'none') {
            instruction.memoType = mt as MemoType;
          }
        }
      }

      return instruction;
    });
  } catch (error) {
    throw new Error(`Failed to parse JSON: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export function parseCSV(content: string): PaymentInstruction[] {
  if (!content.trim()) {
    throw new Error('CSV must have at least a header row and one data row');
  }

  const parsed = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header: string) => header.trim().toLowerCase(),
  });

  const headers = parsed.meta.fields?.map(header => header.trim().toLowerCase()) ?? [];
  if (headers.length === 0 || parsed.data.length === 0) {
    throw new Error('CSV must have at least a header row and one data row');
  }

  const addressIndex = headers.indexOf('address');
  const amountIndex = headers.indexOf('amount');
  const assetIndex = headers.indexOf('asset');

  if (addressIndex === -1 || amountIndex === -1 || assetIndex === -1) {
    throw new Error('CSV must have "address", "amount", and "asset" columns');
  }

  const hasMemo = headers.indexOf('memo') !== -1;
  const hasMemoType = headers.indexOf('memotype') !== -1;

  // Build a lookup of PapaParse row-level errors so we can annotate rows.
  const rowErrors = new Map<number, string>();
  for (const err of parsed.errors) {
    if (typeof err.row === 'number') {
      rowErrors.set(err.row, err.message);
    }
  }

  const instructions = parsed.data.map((row, index) => {
    const instruction: PaymentInstruction = {
      address: sanitizeValue(String(row.address || '')),
      amount: sanitizeValue(String(row.amount || '')),
      asset: sanitizeValue(String(row.asset || '')),
      rowIndex: index, // #397: preserve original row index for retry matching
    };

    if (hasMemo) {
      const memo = sanitizeValue(String(row.memo || ''));
      if (memo) {
        instruction.memo = memo;
        if (hasMemoType) {
          const mt = sanitizeValue(String(row.memotype || '')).toLowerCase();
          if (mt === 'text' || mt === 'id' || mt === 'none') {
            instruction.memoType = mt as MemoType;
          }
        }
      }
    }

    return instruction;
  });

  if (instructions.length === 0) {
    throw new Error('No valid payment instructions found in CSV');
  }

  return instructions;
}

export function parseInput(content: string, format: 'json' | 'csv'): PaymentInstruction[] {
  if (format === 'json') {
    return parseJSON(content);
  } else if (format === 'csv') {
    return parseCSV(content);
  } else {
    throw new Error(`Unknown format: ${format}`);
  }
}

export function analyzeParsedPayments(
  instructions: PaymentInstruction[],
  rowOffset = 1,
): ParsedPaymentFile {
  const addressIndices = new Map<string, number[]>();
  instructions.forEach((inst, idx) => {
    if (inst.address) {
      const indices = addressIndices.get(inst.address) || [];
      indices.push(idx);
      addressIndices.set(inst.address, indices);
    }
  });

  const rows = instructions.map((instruction, index) => {
    // #397: ensure every parsed instruction has a stable rowIndex
    const instructionWithIndex: UploadedPaymentInstruction = {
      ...instruction,
      rowIndex: instruction.rowIndex !== undefined ? instruction.rowIndex : index,
    };
    const validation = validatePaymentInstruction(instructionWithIndex);
    const isDuplicate = (addressIndices.get(instructionWithIndex.address)?.length || 0) > 1;

    return {
      rowNumber: rowOffset + index,
      instruction: instructionWithIndex,
      valid: validation.valid && !isDuplicate,
      isDuplicate,
      error: validation.error || (isDuplicate ? 'Duplicate recipient address' : undefined),
    };
  });

  return {
    rows,
    validPayments: rows.filter(row => row.valid).map(row => row.instruction),
    invalidCount: rows.filter(row => !row.valid).length,
  };
}

export function parsePaymentFile(content: string, format: 'json' | 'csv'): ParsedPaymentFile {
  const instructions = parseInput(content, format);
  if (instructions.length > MAX_UPLOAD_ROWS) {
    throw new Error(`Upload exceeds the maximum of ${MAX_UPLOAD_ROWS} rows. Your file has ${instructions.length} rows. Please split it into smaller files.`);
  }
  return analyzeParsedPayments(instructions, format === 'csv' ? 2 : 1);
}

export interface StreamValidationError {
  row: number;
  column?: string;
  message: string;
}

export interface StreamValidationResult {
  payments: UploadedPaymentInstruction[];
  errors: StreamValidationError[];
}

export function parseFileStream(
  file: File,
  callbacks: {
    onProgress?: (count: number) => void;
    onComplete: (result: StreamValidationResult) => void;
    onError: (error: Error) => void;
  }
) {
  const instructions: UploadedPaymentInstruction[] = [];
  const validationErrors: StreamValidationError[] = [];
  let rowCount = 0;
  let aborted = false;

  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header: string) => header.trim().toLowerCase(),
    chunk: (results, parser) => {
      if (aborted) return;
      const data = results.data as Record<string, unknown>[];

      for (let i = 0; i < data.length; i++) {
        // Validation error row field is 1-based, accounting for header row (starts at 2)
        const absoluteRow = rowCount + i + 2; 

        if (rowCount + i >= MAX_UPLOAD_ROWS) {
          aborted = true;
          parser.abort();
          callbacks.onError(new Error(`Upload exceeds the maximum of ${MAX_UPLOAD_ROWS} rows. Please split your file into smaller files.`));
          return;
        }

        const row = data[i];

        if (!row.address || !row.amount || !row.asset) {
          validationErrors.push({
            row: absoluteRow,
            message: `Row ${absoluteRow} is missing required columns: address, amount, asset`,
          });
          continue;
        }

        // rowIndex is 0-based data row index consistent with parseCSV, parseJSON, and API
        const instruction: UploadedPaymentInstruction = {
          address: sanitizeValue(String(row.address || '')),
          amount: sanitizeValue(String(row.amount || '')),
          asset: sanitizeValue(String(row.asset || '')),
          rowIndex: rowCount + i,
        };

        const memo = sanitizeValue(String(row.memo || ''));
        if (memo) {
          instruction.memo = memo;
          const mt = sanitizeValue(String(row.memotype || row.memoType || '')).toLowerCase();
          if (mt === 'text' || mt === 'id' || mt === 'none') {
            instruction.memoType = mt as MemoType;
          }
        }

        const validation = validatePaymentInstruction(instruction);
        if (!validation.valid) {
          validationErrors.push({
            row: absoluteRow,
            column: extractColumnFromError(validation.error),
            message: `Row ${absoluteRow}: ${validation.error}`,
          });
          continue;
        }

        instructions.push(instruction);
      }

      rowCount += data.length;
      if (callbacks.onProgress) {
        callbacks.onProgress(rowCount);
      }
    },
    error: (error: Error) => {
      if (aborted) return;
      aborted = true;
      callbacks.onError(new Error(`CSV Parse Error: ${error.message}`));
    },
    complete: () => {
      if (aborted) return;

      if (instructions.length === 0 && validationErrors.length === 0) {
        callbacks.onError(new Error('No valid payment instructions found in CSV'));
        return;
      }

      callbacks.onComplete({ payments: instructions, errors: validationErrors });
    }
  });
}

function extractColumnFromError(error?: string): string | undefined {
  if (!error) return undefined;
  const lower = error.toLowerCase();
  if (lower.includes('address')) return 'address';
  if (lower.includes('amount')) return 'amount';
  if (lower.includes('asset')) return 'asset';
  if (lower.includes('memo')) return 'memo';
  return undefined;
}
